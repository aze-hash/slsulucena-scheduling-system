import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";

import { db } from "./firebase.js";

const timeSlots = [
  "7:30-9:00",
  "9:00-10:30",
  "10:30-12:00",
  "1:00-2:30",
  "2:30-4:00"
];

const rooms = {
  Lecture: ["Room 101", "Room 102", "Room 103"],
  Laboratory: ["Lab 1", "Lab 2"]
};

export async function generateSchedule(sectionId) {

  try {

    // =========================
    // GET SECTION
    // =========================
    const sectionRef = doc(db, "sections", sectionId);
    const sectionSnap = await getDoc(sectionRef);

    if (!sectionSnap.exists()) {
      console.log("Section not found");
      return;
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

    subjectsSnapshot.forEach((docSnap) => {
      const subject = docSnap.data();

      // Ignore NSTP safely
      if (subject.subjectCode && subject.subjectCode.includes("NSTP")) {
        return;
      }

      subjects.push(subject);
    });

    console.log("Subjects Found:");
    console.table(subjects);

    // =========================
    // GENERATE SCHEDULE
    // =========================
    const schedule = [];
    let slotIndex = 0;
    let roomIndex = 0;

    subjects.forEach((subject) => {

      const roomType =
        subject.requiredRoomType &&
        subject.requiredRoomType.includes("Lab")
          ? "Laboratory"
          : "Lecture";

      const time = timeSlots[slotIndex % timeSlots.length];
      const room = rooms[roomType][roomIndex % rooms[roomType].length];

      schedule.push({
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        day: "Monday",
        time,
        room
      });

      slotIndex++;
      roomIndex++;
    });

    // =========================
    // FINAL OUTPUT
    // =========================
    console.log("FINAL SCHEDULE:");
    console.table(schedule);

    return schedule;

  } catch (error) {
    console.error("ERROR:", error);
  }
}