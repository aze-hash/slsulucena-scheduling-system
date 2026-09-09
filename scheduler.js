import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";

import { db } from "./firebase.js";

const DEFAULT_EXAM_DAYS = ["Monday", "Tuesday", "Wednesday"];

// Subjects that don't require an exam room/day/time (e.g. OJT, Field Study, etc.)
const TBA_SUBJECT_CODES = new Set([
  "SIP01", "SIP02", "OJT01", "OJT02",
  "AMC01", "FS001", "FS002", "PED11", "TCC01"
]);

// Major-subject examinations use 90-minute blocks.
const majorExamSlots = [
  "8:00-9:30", "9:30-11:00", "11:00-12:30",
  "1:00-2:30", "2:30-4:00", "4:00-5:30"
];

// Minor and activity examinations use 60-minute blocks.
const shortExamSlots = [
  "8:00-9:00", "9:00-10:00", "10:00-11:00", "11:00-12:00",
  "1:00-2:00", "2:00-3:00", "3:00-4:00", "4:00-5:00"
];

const SECTION_EXAM_GAP_MINUTES = 60;

function getExamDurationMinutes(subject) {
  return String(subject?.subjectType || "").trim().toLowerCase() === "major" ? 90 : 60;
}

function getExamSlots(subject) {
  return getExamDurationMinutes(subject) === 90 ? majorExamSlots : shortExamSlots;
}

function parseTime(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(":").map(Number);
  let hour = parts[0] || 0;
  const minute = parts[1] || 0;
  // Hours 1 to 6 are PM (13:00 to 18:00)
  if (hour >= 1 && hour <= 6) {
    hour += 12;
  }
  return hour * 60 + minute;
}

function parseTimeRange(slotStr) {
  if (!slotStr || !slotStr.includes("-")) return null;
  const [start, end] = slotStr.split("-").map(parseTime);
  return { start, end };
}

function timesOverlap(firstTime, secondTime) {
  if (!firstTime || !secondTime) return false;
  const [firstStart, firstEnd] = firstTime.split("-").map(parseTime);
  const [secondStart, secondEnd] = secondTime.split("-").map(parseTime);
  return firstStart < secondEnd && secondStart < firstEnd;
}

function hasRequiredSectionGap(bookedTimes, candidateTime) {
  if (!candidateTime || candidateTime === "TBA") return true;
  const [candidateStart, candidateEnd] = candidateTime.split("-").map(parseTime);

  return bookedTimes.every(bookedTime => {
    if (!bookedTime || bookedTime === "TBA") return true;
    const [bookedStart, bookedEnd] = bookedTime.split("-").map(parseTime);
    return candidateStart >= bookedEnd + SECTION_EXAM_GAP_MINUTES ||
      bookedStart >= candidateEnd + SECTION_EXAM_GAP_MINUTES;
  });
}

export async function generateExamSchedule(sectionId, options = {}) {
  const {
    examType = "Midterm",
    examDates = DEFAULT_EXAM_DAYS
  } = options;

  try {
    // =========================
    // GET SECTION
    // =========================
    const sectionRef = doc(db, "sections", sectionId);
    const sectionSnap = await getDoc(sectionRef);

    if (!sectionSnap.exists()) {
      console.log("Section not found:", sectionId);
      return null;
    }

    const section = sectionSnap.data();

    // =========================
    // GET SUBJECTS
    // =========================
    const subjectQuery = query(
      collection(db, "prospectus"),
      where("programCode", "==", section.programCode),
      where("majorCode", "==", section.majorCode),
      where("yearLevel", "==", section.yearLevel),
      where("semester", "==", section.semester)
    );

    const subjectsSnapshot = await getDocs(subjectQuery);
    const subjects = [];
    const tbaSubjects = [];

    subjectsSnapshot.forEach((docSnap) => {
      const subject = docSnap.data();

      // Ignore NSTP safely
      if (subject.subjectCode && subject.subjectCode.includes("NSTP")) {
        return;
      }

      // TBA subjects: no room, day, or time needed
      if (subject.subjectCode && TBA_SUBJECT_CODES.has(subject.subjectCode)) {
        tbaSubjects.push(subject);
        return;
      }

      subjects.push(subject);
    });

    // =========================
    // GET ROOMS
    // =========================
    const roomsSnapshot = await getDocs(collection(db, "rooms"));
    let rooms = roomsSnapshot.docs.map(docSnap => docSnap.data());

    if (!rooms.length) {
      rooms = [
        { roomCode: "Room 101", roomName: "Room 101", roomType: "Lecture Room" },
        { roomCode: "Room 102", roomName: "Room 102", roomType: "Lecture Room" },
        { roomCode: "Room 103", roomName: "Room 103", roomType: "Lecture Room" },
        { roomCode: "Lab 1", roomName: "Lab 1", roomType: "Laboratory" },
        { roomCode: "Lab 2", roomName: "Lab 2", roomType: "Laboratory" }
      ];
    }

    function normalizeRoomType(roomType) {
      const type = String(roomType || "").trim();
      if (type.toLowerCase().includes("gym")) return "Gymnasium";
      if (type && type !== "Lecture Room") return type;
      return "Lecture Room";
    }

    // Sort subjects: lab/major subjects first
    subjects.sort((first, second) => {
      const firstIsLab = /lab/i.test(first.requiredRoomType || "");
      const secondIsLab = /lab/i.test(second.requiredRoomType || "");
      if (firstIsLab !== secondIsLab) return firstIsLab ? -1 : 1;
      return (second.units || 0) - (first.units || 0);
    });

    // =========================
    // GET FACULTY PROCTORS
    // =========================
    let facultyMembers = [];
    try {
      const usersSnap = await getDocs(collection(db, "users"));
      facultyMembers = usersSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => String(u.role || "").toLowerCase() === "faculty")
        .filter(u => u.excluded !== true);
    } catch {
      // ignore
    }

    const availableDays = Array.isArray(examDates) && examDates.length > 0 ? examDates : DEFAULT_EXAM_DAYS;
    const MAX_ATTEMPTS = 20;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // timetable[day] = list of booked slots for this section
      const timetable = {};
      const roomBookings = {};
      const proctorBookings = {};

      availableDays.forEach(day => {
        timetable[day] = [];
        roomBookings[day] = [];
        proctorBookings[day] = [];
      });

      const examSchedule = [];
      let failed = false;

      for (const subject of subjects) {
        const reqRoomType = normalizeRoomType(subject.requiredRoomType);
        const durationMinutes = getExamDurationMinutes(subject);
        const subjectType = subject.subjectType || "Minor / Activity";
        let placed = false;

        // Try days in round-robin order
        for (const day of availableDays) {
          // Limit 3 exams per section per day
          if (timetable[day].length >= 3) continue;

          for (const time of getExamSlots(subject)) {
            // Keep a one-hour break for the section; rooms remain usable by
            // other sections during that break.
            if (!hasRequiredSectionGap(timetable[day].map(item => item.time), time)) {
              continue;
            }

            // 2. Room availability check
            const availableRooms = rooms.filter(room => {
              if (normalizeRoomType(room.roomType) !== reqRoomType) return false;
              return !roomBookings[day].some(booking =>
                booking.roomCode === room.roomCode && timesOverlap(booking.time, time)
              );
            });

            if (!availableRooms.length) continue;
            const chosenRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];

            // 3. Proctor assignment check
            let assignedProctor = "TBA";
            if (facultyMembers.length) {
              const freeFaculty = facultyMembers.filter(f =>
                !proctorBookings[day].some(b => b.proctorId === f.id && timesOverlap(b.time, time))
              );
              if (freeFaculty.length) {
                const picked = freeFaculty[Math.floor(Math.random() * freeFaculty.length)];
                assignedProctor = picked.fullName || picked.name || "Faculty Proctor";
                proctorBookings[day].push({ proctorId: picked.id, time });
              }
            }

            // Commit
            timetable[day].push({ time, roomCode: chosenRoom.roomCode });
            roomBookings[day].push({ time, roomCode: chosenRoom.roomCode });

            examSchedule.push({
              subjectCode: subject.subjectCode,
              subjectName: subject.subjectName,
              units: subject.units || 3,
              subjectType,
              durationMinutes,
              examType,
              day,
              date: day,
              time,
              room: chosenRoom.roomName || chosenRoom.roomCode,
              proctor: assignedProctor
            });

            placed = true;
            break;
          }

          if (placed) break;
        }

        if (!placed) {
          failed = true;
          break;
        }
      }

      if (!failed) {
        for (const subject of tbaSubjects) {
          examSchedule.push({
            subjectCode: subject.subjectCode,
            subjectName: subject.subjectName,
            units: subject.units || 0,
            examType,
            day: "TBA",
            date: "TBA",
            time: "TBA",
            room: "TBA",
            proctor: "TBA"
          });
        }

        return examSchedule;
      }
    }

    console.error(`Could not generate a conflict-free examination schedule after ${MAX_ATTEMPTS} attempts.`);
    return null;

  } catch (error) {
    console.error("Exam scheduler error:", error);
    return null;
  }
}

// Backwards compatibility alias
export const generateSchedule = generateExamSchedule;
