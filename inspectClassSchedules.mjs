/* One-off script: dumps saved class schedules (Firestore "classSchedules")
   and detects room/day/time conflicts, honouring the split-section rules:
     - Minor / Activity / Research subjects are SHARED between Set A and Set B
       of the same section (same day, same time, same room is allowed).
     - Major subjects of the same section but different sets must NEVER share
       the same day, time and room.
   Run: node inspectClassSchedules.mjs */
import { db } from "./firebase-admin.js";

function parseTime(value) {
    if (!value) return null;
    const m = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const mer = (m[3] || "").toUpperCase();
    if (mer === "PM" && h !== 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    // 12-hour convention: bare hours 1-6 mean PM (e.g. "1:00-3:30" afternoon)
    if (!mer && h >= 1 && h <= 6) h += 12;
    return h * 60 + min;
}

function parseRange(range) {
    const parts = String(range).split("-").map(s => s.trim());
    const start = parseTime(parts[0]);
    let end = parseTime(parts[1]);
    if (start === null || end === null) return null;
    if (end <= start) end += 12 * 60; // wrap past midnight (e.g. 11:30-1:00)
    return { start, end };
}

function timesOverlap(a, b) {
    const ra = parseRange(a);
    const rb = parseRange(b);
    if (!ra || !rb) return false;
    return ra.start < rb.end && rb.start < ra.end;
}

async function main() {
    const snap = await db.collection("classSchedules").get();
    console.log(`Found ${snap.size} class schedule document(s).\n`);

    const schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Flatten entries into discrete bookings (one per day)
    const bookings = [];
    schedules.forEach(s => {
        if (String(s.status || "").toLowerCase() === "archived") return;
        const source = Array.isArray(s.entries) && s.entries.length ? s.entries : (s.rawEntries || []);
        source.forEach((entry, entryIdx) => {
            if (!entry) return;
            const days = String(entry.day || "").split("/").map(x => x.trim()).filter(Boolean);
            const times = String(entry.time || "").split("/").map(x => x.trim()).filter(Boolean);
            const rooms = String(entry.room || "").split("/").map(x => x.trim()).filter(Boolean);
            const count = Math.max(days.length, 1);
            for (let i = 0; i < count; i++) {
                const day = days[i] || days[0] || "";
                const time = times[i] || times[0] || "";
                const room = rooms[i] || rooms[0] || "";
                if (!day || !time || /tba/i.test(time) || /tba/i.test(day) || String(room).toUpperCase() === "TBA") continue;
                bookings.push({
                    scheduleId: s.id,
                    section: String(entry.section || s.section || "").trim(),
                    setName: s.setName || null,
                    originalSection: s.originalSection || null,
                    program: s.program || "",
                    major: s.major || "",
                    status: s.status || "draft",
                    code: entry.code || "",
                    name: entry.name || "",
                    subjectType: entry.subjectType || "",
                    requiredRoomType: entry.requiredRoomType || "",
                    rowIdx: entry.rowIdx,
                    compIdx: i,
                    day, time, room,
                    faculty: entry.faculty || "",
                    facultyUid: entry.facultyUid || "",
                    _entryIdx: entryIdx
                });
            }
        });
    });

    console.log(`Total bookings (expanded per day): ${bookings.length}\n`);

    schedules.forEach(s => {
        console.log(`--- ${s.id} | section=${s.section} | set=${s.setName} | orig=${s.originalSection} | prog=${s.program} | major=${s.major} | status=${s.status} | ${s.academicYear} ${s.semester}`);
    });
    console.log("");

    let conflictCount = 0;
    for (let i = 0; i < bookings.length; i++) {
        for (let j = i + 1; j < bookings.length; j++) {
            const a = bookings[i], b = bookings[j];
            if (a.day !== b.day) continue;
            if (!String(a.room || "").trim() || String(a.room).trim().toLowerCase() !== String(b.room).trim().toLowerCase()) continue;
            if (!timesOverlap(a.time, b.time)) continue;

            if (a.scheduleId === b.scheduleId && a.code === b.code && a.day === b.day && a.time === b.time && a.section === b.section) continue;

            const baseA = stripSetSuffix(a.section);
            const baseB = stripSetSuffix(b.section);
            const siblingSets = baseA && baseA === baseB && a.setName && b.setName && a.setName !== b.setName;

            // Shared minor/activity/research between sibling sets -> allowed
            if (siblingSets && a.code === b.code && a.time === b.time && isSharedType(a) && isSharedType(b)) continue;

            // Gym / Covered Court: sharing between up to 2 sections is allowed
            if (/gym|court|activity/i.test(a.room) && a.section !== b.section) {
                const sharers = new Set(
                    bookings.filter(x => x.day === a.day &&
                        String(x.room).trim().toLowerCase() === String(a.room).trim().toLowerCase() &&
                        timesOverlap(x.time, a.time)).map(x => x.section)
                );
                if (sharers.size <= 2 && a.faculty !== b.faculty) continue;
            }

            // Sibling-set pair with the same code/time that is NOT shared type -> MAJOR conflict
            const isMajorPair = siblingSets && a.code === b.code && a.time === b.time;

            conflictCount++;
            console.log(
                `${isMajorPair ? "MAJOR SET CONFLICT" : "ROOM CONFLICT"}: ${a.room} on ${a.day} ${a.time}\n` +
                `  - ${a.section} (${a.setName || "no set"}): ${a.code} ${a.name} [type=${a.subjectType || "?"} row=${a.rowIdx} comp=${a.compIdx}] room=${a.room} faculty=${a.faculty || "Unassigned"} sched=${a.scheduleId}\n` +
                `  - ${b.section} (${b.setName || "no set"}): ${b.code} ${b.name} [type=${b.subjectType || "?"} row=${b.rowIdx} comp=${b.compIdx}] room=${b.room} faculty=${b.faculty || "Unassigned"} sched=${b.scheduleId}`
            );
        }
    }

    if (conflictCount === 0) {
        console.log("No conflicts found in saved class schedules.");
    } else {
        console.log(`\nTotal conflicts found: ${conflictCount}`);
    }
    process.exit(0);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });


function stripSetSuffix(section) {
    return String(section || "").trim().replace(/\s+set\s+[ab]$/i, "").trim();
}

function isSharedType(entry) {
    const t = String(entry.subjectType || "").trim().toLowerCase();
    if (t === "minor" || t === "activity" || t === "research" || t === "general") return true;
    const code = String(entry.code || "").toUpperCase();
    if (/^(PE|PATHFit|NSTP|SIP|OJT)/i.test(code)) return true;
    if (t.includes("research")) return true;
    if (/research/i.test(String(entry.name || ""))) return true;
    return false;
}
