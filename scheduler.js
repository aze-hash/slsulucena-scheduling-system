import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";

import { db } from "./firebase.js";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Subjects that don't require a room/day/time (e.g. OJT, Field Study, etc.)
const TBA_SUBJECT_CODES = new Set([
  "SIP01", "SIP02", "OJT01", "OJT02",
  "AMC01", "FS001", "FS002", "PED11", "TCC01"
]);

// Preferred day pairs: keeps a section's classes balanced across the week
const DAY_PAIRS = [
  ["Monday", "Thursday"],
  ["Tuesday", "Friday"],
  ["Monday", "Wednesday"],
  ["Wednesday", "Friday"],
  ["Tuesday", "Thursday"],
  ["Monday", "Tuesday"]
];

const minorSlots = [
  "7:30-9:00", "9:00-10:30", "10:30-12:00",
  "1:00-2:30", "2:30-4:00", "4:00-5:30"
];

const majorSlots = [
  "7:30-10:00", "10:00-12:30", "1:00-3:30", "3:30-6:00"
];

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

/**
 * Checks if adding candidateTime to existingDayEntries keeps vacant gaps
 * acceptable (back-to-back up to 90 minutes, plus lunch-break allowance).
 */
function isVacantGapAcceptable(existingDayEntries, candidateTime) {
  const candidateRange = parseTimeRange(candidateTime);
  if (!candidateRange) return false;

  const allRanges = existingDayEntries
    .map(entry => parseTimeRange(entry.time))
    .filter(Boolean);
  allRanges.push(candidateRange);
  allRanges.sort((a, b) => a.start - b.start);

  const lunchStart = 12 * 60; // 720
  const lunchEnd = 13 * 60;   // 780

  for (let i = 0; i < allRanges.length - 1; i++) {
    const rawGap = allRanges[i + 1].start - allRanges[i].end;
    if (rawGap <= 0) continue;

    let lunchAllowance = 0;
    if (allRanges[i].end <= lunchStart && allRanges[i + 1].start >= lunchEnd) {
      lunchAllowance = 60;
    } else if (allRanges[i].end <= 750 && allRanges[i + 1].start >= lunchEnd) {
      lunchAllowance = 30;
    }

    if (Math.max(0, rawGap - lunchAllowance) > 90) {
      return false;
    }
  }

  return true;
}

export async function generateSchedule(sectionId) {

  try {

    // =========================
    // GET SECTION
    // =========================
    const sectionRef = doc(db, "sections", sectionId);
    const sectionSnap = await getDoc(sectionRef);

    if (!sectionSnap.exists()) {
      console.log("Section not found");
      return null;
    }

    const section = sectionSnap.data();

    console.log("Section:");
    console.log(section);

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

    console.log("Subjects Found:");
    console.table(subjects);

    // =========================
    // GET ROOMS
    // =========================
    const roomsSnapshot = await getDocs(collection(db, "rooms"));
    const rooms = roomsSnapshot.docs.map(docSnap => docSnap.data());

    // Fallback to hardcoded rooms if Firestore has none
    if (!rooms.length) {
      rooms.push(
        ...["Room 101", "Room 102", "Room 103"].map(code => ({
          roomCode: code,
          roomName: code,
          roomType: "Lecture Room"
        })),
        ...["Lab 1", "Lab 2"].map(code => ({
          roomCode: code,
          roomName: code,
          roomType: "Laboratory"
        }))
      );
    }

    function normalizeRoomType(roomType) {
      const type = String(roomType || "").trim();
      if (type.toLowerCase().includes("gym")) return "Gymnasium";
      if (type && type !== "Lecture Room") return type;
      return "Lecture Room";
    }

    // Sort subjects: lab/major subjects first (harder to place), then by units
    subjects.sort((first, second) => {
      const firstIsLab = /lab/i.test(first.requiredRoomType || "");
      const secondIsLab = /lab/i.test(second.requiredRoomType || "");
      if (firstIsLab !== secondIsLab) return firstIsLab ? -1 : 1;
      return (second.units || 0) - (first.units || 0);
    });

    // =========================
    // GENERATE SCHEDULE (conflict-free)
    // =========================
    const MAX_ATTEMPTS = 20;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

      // timetable[day] = list of { time, roomCode } booked FOR THIS SECTION
      const timetable = {
        Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: []
      };

      // roomBookings[day] = list of { time, roomCode } booked ACROSS ALL ROOMS
      const roomBookings = {
        Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: []
      };

      const schedule = [];
      let failed = false;

      function findSlotAndRoom(day, reqRoomType, slots) {
        const candidateSlots = slots
          .filter(time => {
            const range = parseTimeRange(time);
            if (!range) return false;
            // Empty day must start at 7:30 AM
            if (timetable[day].length === 0 && range.start !== 450) return false;
            return true;
          })
          .sort((s1, s2) => {
            const start1 = parseTimeRange(s1)?.start || 0;
            const start2 = parseTimeRange(s2)?.start || 0;
            return start1 - start2;
          });

        for (const time of candidateSlots) {
          // 1. Section conflict check (this section can't be in two places)
          if (timetable[day].some(item => timesOverlap(item.time, time))) {
            continue;
          }

          // 2. Vacant gap check
          if (!isVacantGapAcceptable(timetable[day], time)) {
            continue;
          }

          // 3. Room availability check (no double-booking any room)
          const availableRooms = rooms.filter(room => {
            if (normalizeRoomType(room.roomType) !== reqRoomType) return false;
            return !roomBookings[day].some(booking =>
              booking.roomCode === room.roomCode &&
              timesOverlap(booking.time, time)
            );
          });

          if (availableRooms.length > 0) {
            const room = availableRooms[
              Math.floor(Math.random() * availableRooms.length)
            ];
            return { time, room };
          }
        }

        return null;
      }

      for (const subject of subjects) {
        const reqRoomType = normalizeRoomType(subject.requiredRoomType);
        const units = Number(subject.units) || 3;
        const isMajor = String(subject.subjectType || "").toLowerCase() === "major";

        // Major/lab-heavy subjects get longer blocks
        const slots = isMajor || /lab/i.test(subject.requiredRoomType || "")
          ? majorSlots
          : minorSlots;

        // Two meetings per week on distinct days (e.g. Mon/Thu)
        let placed = false;

        // Try preferred pairs first, then all remaining distinct day pairs
        const candidatePairs = [...DAY_PAIRS];
        for (let i = 0; i < days.length && candidatePairs.length < 10; i++) {
          for (let j = i + 1; j < days.length; j++) {
            const pair = [days[i], days[j]];
            if (!candidatePairs.some(p =>
              p[0] === pair[0] && p[1] === pair[1]
            )) {
              candidatePairs.push(pair);
            }
          }
        }

        for (const [day1, day2] of candidatePairs) {
          const m1 = findSlotAndRoom(day1, reqRoomType, slots);
          if (!m1) continue;

          const m2 = findSlotAndRoom(day2, reqRoomType, slots);
          if (!m2) continue;

          // Commit bookings
          timetable[day1].push({ time: m1.time, roomCode: m1.room.roomCode });
          timetable[day2].push({ time: m2.time, roomCode: m2.room.roomCode });
          roomBookings[day1].push({ time: m1.time, roomCode: m1.room.roomCode });
          roomBookings[day2].push({ time: m2.time, roomCode: m2.room.roomCode });

          schedule.push({
            subjectCode: subject.subjectCode,
            subjectName: subject.subjectName,
            day: `${day1} / ${day2}`,
            time: `${m1.time} / ${m2.time}`,
            room: `${m1.room.roomName || m1.room.roomCode} / ${m2.room.roomName || m2.room.roomCode}`
          });

          placed = true;
          break;
        }

        if (!placed) {
          console.warn(
            `Could not place ${subject.subjectCode} without conflicts ` +
            `(attempt ${attempt}). Retrying...`
          );
          failed = true;
          break;
        }
      }

      if (!failed) {
        // =========================
        // APPEND TBA SUBJECTS
        // =========================
        for (const subject of tbaSubjects) {
          schedule.push({
            subjectCode: subject.subjectCode,
            subjectName: subject.subjectName,
            day: "MTWThF",
            time: "7:30am-6:30pm",
            room: "TBA"
          });
        }

        // =========================
        // FINAL OUTPUT
        // =========================
        console.log("FINAL SCHEDULE:");
        console.table(schedule);

        return schedule;
      }
    }

    console.error(
      "Could not generate a complete conflict-free schedule after " +
      `${MAX_ATTEMPTS} attempts. Consider adding more rooms or time slots.`
    );
    return null;

  } catch (error) {
    console.error("ERROR:", error);
    return null;
  }
}