import { db } from "./firebase-admin.js";
import fs from "fs";

function buildRaw(entries, secName, sched) {
    const raw = [];
    (entries || []).forEach(entry => {
        const days = String(entry.day || "").split("/").map(d => d.trim()).filter(Boolean);
        const times = String(entry.time || "").split("/").map(t => t.trim()).filter(Boolean);
        const rooms = String(entry.room || "").split("/").map(r => r.trim()).filter(Boolean);
        const maxLen = Math.max(days.length, times.length, rooms.length, 1);
        for (let i = 0; i < maxLen; i++) {
            raw.push({
                code: entry.code || "",
                name: entry.name || "",
                units: entry.units || 0,
                day: days[i] || days[0] || entry.day || "",
                time: times[i] || times[0] || entry.time || "",
                room: rooms[i] || rooms[0] || entry.room || "",
                roomCode: "",
                faculty: entry.faculty || "Unassigned",
                facultyUid: entry.facultyUid || "",
                facultyId: entry.facultyId || "",
                section: secName,
                scheduleGroupId: sched.scheduleGroupId || null,
                originalSection: sched.originalSection || null,
                isSplit: Boolean(sched.isSplit),
                sharedScheduleId: sched.sharedScheduleId || null
            });
        }
    });
    return raw;
}

function parseTime(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let h = Number(m[1]), min = Number(m[2]), mer = (m[3] || "").toUpperCase();
    if (mer === "PM" && h !== 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    if (!mer && h >= 1 && h <= 6) h += 12;
    return h * 60 + min;
}

function parseRange(r) {
    const parts = String(r).split("-").map(s => s.trim());
    const start = parseTime(parts[0]);
    let end = parseTime(parts[1]);
    if (start === null || end === null) return null;
    if (end <= start) end += 12 * 60;
    return { start, end };
}

async function run() {
    const snap = await db.collection("classSchedules").get();
    const allDocs = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

    // Backup
    fs.writeFileSync("backup_before_room_allocation_fix.json", JSON.stringify(allDocs, null, 2), "utf8");
    console.log(`Backed up ${allDocs.length} schedules to backup_before_room_allocation_fix.json`);

    const batch = db.batch();
    let updateCount = 0;

    for (const s of allDocs) {
        if (s.status === "archived") continue;
        let modified = false;

        // 1. Fix BINDTECH-CPT 1B Set B
        if (s.section === "BINDTECH-CPT 1B Set B") {
            const e = s.entries.find(x => x.code === "CPT05");
            if (e && e.day !== "Friday / Monday") {
                e.day = "Friday / Monday";
                e.time = "1:00-3:30 / 7:30-10:00";
                e.room = "Room B101 / CET Shop";
                modified = true;
            }
        }

        // 2. Fix BIT-CPT 3C Set B
        if (s.section === "BIT-CPT 3C Set B") {
            const e14 = s.entries.find(x => x.code === "CPT14");
            if (e14 && (e14.day !== "Friday / Friday" || e14.time !== "10:30-12:00 / 1:00-3:30")) {
                e14.day = "Friday / Friday";
                e14.time = "10:30-12:00 / 1:00-3:30";
                e14.room = "Room B201 / Room A304";
                modified = true;
            }

            const e16 = s.entries.find(x => x.code === "CPT16");
            if (e16 && (e16.day !== "Thursday / Wednesday" || e16.time !== "1:00-3:30 / 10:00-12:30")) {
                e16.day = "Thursday / Wednesday";
                e16.time = "1:00-3:30 / 10:00-12:30";
                e16.room = "Room B201 / AT Shop";
                modified = true;
            }

            const e15 = s.entries.find(x => x.code === "CPT15");
            if (e15 && (e15.day !== "Tuesday / Thursday" || e15.time !== "4:00-6:30 / 3:30-6:00" || e15.room !== "Room B301 / Room B203")) {
                e15.day = "Tuesday / Thursday";
                e15.time = "4:00-6:30 / 3:30-6:00";
                e15.room = "Room B301 / Room B203";
                e15.faculty = "Ceribo, Carla May C.";
                e15.facultyUid = "jrDjd2q2Z0gzaAXAmsvWrxANjTR2";
                e15.facultyId = "SLSU-FAC-007";
                modified = true;
            }
        }

        // 3. Check if rawEntries has slashes, duplicates, or is out of sync
        const currentRaws = s.rawEntries || [];
        const hasSlashes = currentRaws.some(r => String(r.day || "").includes("/") || String(r.time || "").includes("/"));
        const expectedCount = (s.entries || []).reduce((acc, entry) => {
            const days = String(entry.day || "").split("/").map(x => x.trim()).filter(Boolean);
            return acc + Math.max(days.length, 1);
        }, 0);

        if (modified || hasSlashes || currentRaws.length !== expectedCount) {
            const cleanRaws = buildRaw(s.entries, s.section, s);
            s.rawEntries = cleanRaws;
            batch.update(s.ref, {
                entries: s.entries,
                rawEntries: cleanRaws,
                updatedAt: new Date()
            });
            updateCount++;
            console.log(`Prepared update for: ${s.id} (entries: ${s.entries.length}, clean rawEntries: ${cleanRaws.length})`);
        }
    }

    // Verify all bookings after simulation
    const allBookings = [];
    allDocs.forEach(s => {
        if (s.status === "archived") return;
        (s.entries || []).forEach(e => {
            const days = String(e.day || "").split("/").map(x => x.trim()).filter(Boolean);
            const times = String(e.time || "").split("/").map(x => x.trim()).filter(Boolean);
            const rms = String(e.room || "").split("/").map(x => x.trim()).filter(Boolean);
            const count = Math.max(days.length, 1);
            for (let i = 0; i < count; i++) {
                const day = days[i] || days[0];
                const time = times[i] || times[0];
                const room = rms[i] || rms[0];
                if (!day || !time || time === "TBA" || room === "TBA") continue;
                const rng = parseRange(time);
                if (!rng) continue;
                allBookings.push({
                    schedId: s.id,
                    sec: s.section,
                    code: e.code,
                    name: e.name,
                    day, time, room,
                    start: rng.start,
                    end: rng.end,
                    fac: e.faculty || "",
                    facUid: e.facultyUid || ""
                });
            }
        });
    });

    let conflicts = 0;
    for (let i = 0; i < allBookings.length; i++) {
        for (let j = i + 1; j < allBookings.length; j++) {
            const a = allBookings[i], b = allBookings[j];
            if (a.day !== b.day) continue;
            if (a.start >= b.end || b.start >= a.end) continue;
            if (a.room === "Covered Court" && b.room === "Covered Court" && a.fac !== b.fac) continue;
            const baseA = a.sec.replace(/\s+Set\s+[AB]$/i, "");
            const baseB = b.sec.replace(/\s+Set\s+[AB]$/i, "");
            if (baseA === baseB && a.code === b.code && a.time === b.time) continue;

            if (a.room && b.room && a.room.toLowerCase() === b.room.toLowerCase()) {
                console.error("UNRESOLVED ROOM CONFLICT:", a.day, a.time, a.room, a.sec, a.code, "vs", b.sec, b.code);
                conflicts++;
            }
            if (a.fac && b.fac && a.fac !== "Unassigned" && a.fac.toLowerCase() === b.fac.toLowerCase()) {
                console.error("UNRESOLVED FACULTY CONFLICT:", a.day, a.time, a.fac, a.sec, a.code, "vs", b.sec, b.code);
                conflicts++;
            }
            if (a.schedId === b.schedId && a.sec === b.sec) {
                console.error("UNRESOLVED SECTION CONFLICT:", a.day, a.time, a.sec, a.code, "vs", b.code);
                conflicts++;
            }
        }
    }

    if (conflicts > 0) {
        console.error(`Abort! ${conflicts} conflict(s) remaining.`);
        process.exit(1);
    }

    console.log(`\nVerification successful: 0 conflicts found across ${allBookings.length} bookings.`);
    console.log(`Committing batch update for ${updateCount} documents...`);
    await batch.commit();
    console.log(`Successfully committed updates for ${updateCount} schedule documents to Firestore!`);
}

run().catch(err => {
    console.error("Error executing fix:", err);
    process.exit(1);
});
