import { db } from "./firebase-admin.js";

async function main() {
  // --- Faculty users ---
  const usersSnap = await db.collection("users").get();
  const faculty = usersSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(u => String(u.role || "").toLowerCase().includes("faculty"));
  console.log("\n=== FACULTY USERS (role~faculty) ===");
  console.log("count:", faculty.length);
  faculty.forEach(f => console.log(JSON.stringify({ id: f.id, role: f.role, fullName: f.fullName, name: f.name, email: f.email, department: f.department })));

  const facultySnap = await db.collection("faculty").get();
  console.log("\n=== LEGACY faculty collection ===");
  console.log("count:", facultySnap.size);
  facultySnap.docs.forEach(d => console.log(JSON.stringify({ id: d.id, ...d.data() })));

  // --- Exam schedules ---
  const snap = await db.collection("examSchedules").get();
  console.log("\n=== EXAM SCHEDULES ===");
  console.log("count:", snap.size);
  snap.docs.forEach(doc => {
    const d = doc.data();
    console.log("\n--- doc id:", doc.id, "| status:", d.status, "| AY:", d.academicYear, "| sem:", d.semester, "| examType:", d.examType, "| section:", d.section, "| program:", d.program, "| major:", d.major);
    console.log("top-level keys:", Object.keys(d));
    const exams = Array.isArray(d.exams) ? d.exams : [];
    console.log("exams count:", exams.length);
    exams.forEach((e, i) => {
      console.log(`  [${i}] ${JSON.stringify({ code: e.code, name: e.name, subjectType: e.subjectType, durationMinutes: e.durationMinutes, date: e.date, day: e.day, time: e.time, room: e.room, proctor: e.proctor, proctorUid: e.proctorUid })}`);
    });
  });
  process.exit(0);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
