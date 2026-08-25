/* One-off script: reviews saved class schedules (Firestore "classSchedules")
   for room/time conflicts across sections.
   Run: node checkConflicts.mjs */

const PROJECT_ID = "slsulucena-scheduling-system";

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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/classSchedules?pageSize=100`;
  const res = await fetch(url);
  const data = await res.json();

  const schedules = (data.documents || []).map(doc => {
    const f = doc.fields || {};
    const str = name =>
      f[name]?.stringValue ?? "";
    let entries = [];
    if (f.entries?.arrayValue?.values) {
      entries = f.entries.arrayValue.values.map(v => {
        const e = v.mapValue?.fields || {};
        return {
          code: e.code?.stringValue || "",
          day: e.day?.stringValue || "",
          time: e.time?.stringValue || "",
          room: e.room?.stringValue || ""
        };
      });
    }
    return {
      id: doc.name.split("/").pop(),
      section: str("section"),
      academicYear: str("academicYear"),
      semester: str("semester"),
      status: str("status") || "active",
      entries
    };
  });

  console.log(`Found ${schedules.length} saved schedule(s).
`);

  // Flatten into bookings per active schedule
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
          time: times[i] || times[0] || "",
          room: rooms[i] || rooms[0] || ""
        });
      });
    }
  }

  console.log(`Total bookings (expanded per day): ${bookings.length}
`);

  // Group by academic year + semester
  const groups = {};
  for (const b of bookings) {
    const key = `${b.ay} | ${b.sem}`;
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
        if (a.room !== b.room) continue;
        if (a.section === b.section && a.code === b.code) continue;

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
          `CONFLICT: ${a.room} on ${a.day} ${a.time}
` +
          `  - ${a.section}: ${a.code}
` +
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
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});