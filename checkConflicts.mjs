/* One-off script: reviews saved exam schedules (Firestore "examSchedules")
   for room/time conflicts across sections.
   Uses the Firebase Admin SDK (serviceAccountKey.json) so security rules
   don't block the read.
   Run: node checkConflicts.mjs */

import { db } from "./firebase-admin.js";

function parseTime(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(":").map(Number);
  let hour = parts[0] || 0;
  const minute = parts[1] || 0;
  if (hour >= 1 && hour <= 6) hour += 12; // 1-6 => PM
  return hour * 60 + minute;
}

function timesOverlap(a, b) {
  if (!a || !b) return false;
  const [as, ae] = a.split("-").map(parseTime);
  const [bs, be] = b.split("-").map(parseTime);
  return as < be && bs < ae;
}

async function main() {
  const snap = await db.collection("examSchedules").get();

  const schedules = snap.docs.map(doc => {
    const d = doc.data() || {};
    const entries = Array.isArray(d.exams)
      ? d.exams.map(e => ({
          code: e?.code || "",
          day: e?.day || "",
          date: e?.date || "",
          time: e?.time || "",
          room: e?.room || "",
          proctor: e?.proctor || ""
        }))
      : [];
    return {
      id: doc.id,
      section: d.section || "",
      academicYear: d.academicYear || "",
      semester: d.semester || "",
      status: d.status || "active",
      entries
    };
  });

  console.log(`Found ${schedules.length} saved schedule(s).\n`);

  // Flatten into bookings per schedule
  const bookings = [];
  for (const s of schedules) {
    for (const entry of s.entries) {
      const days = String(entry.day || "").split(" / ").map(d => d.trim());
      const times = String(entry.time || "").split(" / ").map(t => t.trim());
      const rooms = String(entry.room || "").split(" / ").map(r => r.trim());
      days.forEach((day, i) => {
        bookings.push({
          scheduleId: s.id,
          section: s.section,
          ay: s.academicYear,
          sem: s.semester,
          code: entry.code,
          day,
          date: entry.date,
          time: times[i] || times[0] || "",
          room: rooms[i] || rooms[0] || "",
          proctor: entry.proctor || ""
        });
      });
    }
  }

  console.log(`Total bookings (expanded per day): ${bookings.length}\n`);

  // Group by academic year + semester + exam date
  const groups = {};
  for (const b of bookings) {
    const key = `${b.ay} | ${b.sem} | ${b.date || b.day}`;
    (groups[key] ||= []).push(b);
  }

  let conflictCount = 0;

  for (const [key, list] of Object.entries(groups)) {
    console.log(`=== ${key} ===`);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.day !== b.day) continue;
        if (!timesOverlap(a.time, b.time)) continue;
        if (a.section === b.section && a.code === b.code) continue;

        // Proctor double-booked in different sections (ignore "TBA" placeholders)
        if (
          a.proctor && a.proctor !== "TBA" &&
          a.proctor === b.proctor && a.section !== b.section
        ) {
          conflictCount++;
          console.log(
            `PROCTOR CONFLICT: ${a.proctor} on ${a.date || a.day} ${a.time}\n` +
            `  - ${a.section}: ${a.code} (${a.room})\n` +
            `  - ${b.section}: ${b.code} (${b.room})`
          );
          continue;
        }

        if (a.room !== b.room) continue;

        const isGym = /gym/i.test(a.room);
        if (isGym && a.section !== b.section) {
          // count distinct sections sharing this gym slot
          const sharers = new Set(
            list.filter(x =>
              x.day === a.day &&
              x.room === a.room &&
              timesOverlap(x.time, a.time)
            ).map(x => x.section)
          );
          if (sharers.size <= 2) continue; // valid sharing
        }

        conflictCount++;
        console.log(
          `ROOM CONFLICT: ${a.room} on ${a.date || a.day} ${a.time}\n` +
          `  - ${a.section}: ${a.code}\n` +
          `  - ${b.section}: ${b.code}`
        );
      }
    }
    console.log("");
  }

  if (conflictCount === 0) {
    console.log("No room/time conflicts found in saved schedules.");
  } else {
    console.log(`Total conflicts found: ${conflictCount}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});