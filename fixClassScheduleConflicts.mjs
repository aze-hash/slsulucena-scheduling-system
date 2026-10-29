/* One-off repair script: fixes room/day/time conflicts in saved class
   schedules (Firestore "classSchedules").

   Rules enforced (matching the Split Section rules on the Class Scheduling page):
     - Minor / Activity / Research subjects are SHARED between Set A and Set B
       of the same section: same day + same time + same room is ALLOWED.
     - Major subjects of the same section but different sets must NEVER share
       the same day, time AND room.

   What it does:
     1. Loads every non-archived class schedule, plus the `rooms` collection.
     2. Detects conflicts (room double-bookings; sibling-set duplicate majors).
        Gym / Covered Court rooms may be shared by up to 2 sections.
     3. Resolves each conflict by moving the conflicting Set B component to a
        free slot (same room preferred, then rooms of the same room type),
        keeping the same duration and faculty, and never double-booking the
        room, the faculty member, or the section.
     4. Updates BOTH `entries` and `rawEntries` so the saved documents stay
        consistent, then re-verifies that zero conflicts remain.

   Run:            node fixClassScheduleConflicts.mjs            (dry run)
   Apply changes:  node fixClassScheduleConflicts.mjs --apply
*/
import { db } from "./firebase-admin.js";

const APPLY = process.argv.includes("--apply");
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/* ---------------- time helpers ---------------- */

function parseTime(value) {
    if (!value) return null;
    const m = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const mer = (m[3] || "").toUpperCase();
    if (mer === "PM" && h !== 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    // 12-hour convention used across the system: bare hours 1-6 mean PM
    // (e.g. "1:00-3:30" is an afternoon slot); 7-11 mean AM, 12 means noon.
    if (!mer && h >= 1 && h <= 6) h += 12;
    return h * 60 + min;
}

function parseRange(range) {
    const parts = String(range).split("-").map(s => s.trim());
    const start = parseTime(parts[0]);
    let end = parseTime(parts[1]);
    if (start === null || end === null) return null;
    if (end <= start) end += 12 * 60; // wrap past noon (e.g. 11:30-1:00)
    return { start, end };
}

function timesOverlap(a, b) {
    const ra = parseRange(a);
    const rb = parseRange(b);
    if (!ra || !rb) return false;
    return ra.start < rb.end && rb.start < ra.end;
}

function fmtMinutes(total) {
    let h = Math.floor(total / 60) % 24;
    const m = total % 60;
    const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${h12}:${String(m).padStart(2, "0")}`;
}

function fmtRange(start, end) {
    return `${fmtMinutes(start)}-${fmtMinutes(end)}`;
}

function normRoom(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normName(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stripSetSuffix(section) {
    return String(section || "").trim().replace(/\s+set\s+[ab]$/i, "").trim();
}

function isGymRoom(roomName) {
    return /gym|court|activity/i.test(String(roomName || ""));
}

// A specialist BTVTED laboratory must never be used as overflow space for
// BIT/BINDTECH (or another BTVTED major).  Lecture rooms and general-purpose
// laboratories remain valid alternatives for a major subject.
const SPECIALIST_LAB_MAJORS = ["FSM", "AT", "CT", "ELT", "ELX", "MT", "CP", "CPT"];

function specialistLabMajor(room) {
    const label = `${room?.roomType || ""} ${room?.roomName || room || ""}`.toUpperCase();
    return SPECIALIST_LAB_MAJORS.find(major =>
        new RegExp(`(^|\\s|-)${major}\\s*(LAB|LABORATORY|SHOP|CENTER)`, "i").test(label) ||
        new RegExp(`^${major}\\s+LABORATORY$`, "i").test(String(room?.roomType || ""))
    ) || "";
}

function bookingMajor(booking) {
    return String(booking.major || booking.requiredRoomType || "").toUpperCase()
        .replace(/\s+LABORATORY$/, "").trim();
}

function roomCanHostBooking(room, booking) {
    const name = String(room?.roomName || room || "").trim();
    if (!name || !isGymRoom(booking.room) && isGymRoom(name)) return false;
    if (isGymRoom(booking.room)) return isGymRoom(name);

    const specialist = specialistLabMajor(room);
    // Specialist rooms are reserved for their own major.  This is what keeps
    // BIT/BINDTECH subjects out of BTVTED major laboratories.
    if (specialist && specialist !== bookingMajor(booking)) return false;
    return true; // lecture, AVR, and general laboratories are all acceptable
}

function isSharedType(subjectType, code, name) {
    const t = String(subjectType || "").trim().toLowerCase();
    if (t === "minor" || t === "activity" || t === "research" || t === "general") return true;
    if (t.includes("research")) return true;
    const c = String(code || "").toUpperCase();
    if (/^(PE\d|PATHFit|NSTP|SIP\d|OJT\d)/i.test(c)) return true;
    if (/research/i.test(String(name || ""))) return true;
    return false;
}

/* ---------------- data loading ---------------- */

async function loadSchedules() {
    const snap = await db.collection("classSchedules").get();
    return snap.docs
        .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
        .filter(s => String(s.status || "").toLowerCase() !== "archived");
}

async function loadRooms() {
    try {
        const snap = await db.collection("rooms").get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn("Could not load rooms collection:", err.message);
        return [];
    }
}

/**
 * Flattens `entries` (which carry subjectType + rowIdx) into discrete
 * per-day bookings. Mirrors expandClassSchedule() in room-allocation.js.
 */
function buildBookings(schedules) {
    const bookings = [];
    schedules.forEach(s => {
        const source = Array.isArray(s.entries) && s.entries.length ? s.entries : (s.rawEntries || []);
        source.forEach((entry, entryIdx) => {
            if (!entry) return;
            const days = String(entry.day || "").split("/").map(x => x.trim()).filter(Boolean);
            const times = String(entry.time || "").split("/").map(x => x.trim()).filter(Boolean);
            const rooms = String(entry.room || "").split("/").map(x => x.trim()).filter(Boolean);
            const count = Math.max(days.length, 1);
            for (let i = 0; i < count; i++) {
                const day = (days[i] || days[0] || "").trim();
                const time = (times[i] || times[0] || "").trim();
                const room = (rooms[i] || rooms[0] || "").trim();
                if (!day || !time) continue;
                if (/tba/i.test(day) || /tba/i.test(time) || String(room).toUpperCase() === "TBA") continue;
                const range = parseRange(time);
                if (!range) continue;
                bookings.push({
                    scheduleId: s.id,
                    docRef: s.ref,
                    section: String(entry.section || s.section || "").trim(),
                    setName: s.setName || null,
                    originalSection: s.originalSection || null,
                    status: s.status || "draft",
                    code: String(entry.code || "").trim(),
                    name: String(entry.name || "").trim(),
                    subjectType: String(entry.subjectType || "").trim(),
                    day, time, room,
                    start: range.start,
                    end: range.end,
                    faculty: String(entry.faculty || "").trim(),
                    facultyUid: String(entry.facultyUid || "").trim(),
                    program: String(entry.program || s.program || "").trim(),
                    major: String(entry.major || s.major || "").trim(),
                    requiredRoomType: String(entry.requiredRoomType || "").trim(),
                    entryRef: entry,      // live reference into s.entries
                    compIdx: i,
                    entryIdx
                });
            }
        });
    });
    return bookings;
}

/* ---------------- conflict detection ---------------- */

function detectConflicts(bookings) {
    const conflicts = [];
    for (let i = 0; i < bookings.length; i++) {
        for (let j = i + 1; j < bookings.length; j++) {
            const a = bookings[i], b = bookings[j];
            if (a.day !== b.day) continue;
            if (!a.room || normRoom(a.room) !== normRoom(b.room)) continue;
            if (!(a.start < b.end && b.start < a.end)) continue;
            // identical duplicate booking within the same document -> not a conflict
            if (a.scheduleId === b.scheduleId && a.code === b.code &&
                a.time === b.time && a.section === b.section) continue;

            const baseA = stripSetSuffix(a.section);
            const baseB = stripSetSuffix(b.section);
            const siblingSets = baseA && baseA === baseB &&
                a.setName && b.setName && a.setName !== b.setName;

            // Shared minor/activity/research session duplicated in both set docs -> allowed
            if (siblingSets && a.code === b.code && a.time === b.time &&
                isSharedType(a.subjectType, a.code, a.name) &&
                isSharedType(b.subjectType, b.code, b.name)) continue;

            // Gym / Covered Court: sharing between up to 2 sections is allowed
            if (isGymRoom(a.room) && a.section !== b.section) {
                const sharers = new Set(
                    bookings.filter(x => x.day === a.day && normRoom(x.room) === normRoom(a.room) &&
                        x.start < a.end && a.start < x.end)
                        .map(x => x.section)
                );
                if (sharers.size <= 2 && a.faculty !== b.faculty) continue;
            }

            const sameSlotDup = a.code === b.code && a.time === b.time;
            conflicts.push({
                type: siblingSets ? (sameSlotDup ? "SIBLING_MAJOR_DUP" : "SIBLING_ROOM_CLASH") : "ROOM_CONFLICT",
                room: a.room,
                day: a.day,
                a, b
            });
        }
    }
    return conflicts;
}

/* ---------------- rawEntries mapping ---------------- */

function sameRange(t1, t2) {
    if (String(t1).trim() === String(t2).trim()) return true;
    const r1 = parseRange(t1), r2 = parseRange(t2);
    if (!r1 || !r2) return false;
    return r1.start === r2.start && r1.end === r2.end;
}

function sameRoomValue(rawRoom, componentRoom, fullRoom) {
    const a = String(rawRoom || "").replace(/\s+/g, "");
    const b = String(componentRoom || "").replace(/\s+/g, "");
    if (a === b) return true;
    // legacy docs store the unsplit room string in rawEntries (e.g. "Room 205/ Room 207")
    const f = String(fullRoom || "").replace(/\s+/g, "");
    return a === f;
}

/**
 * Maps each rawEntries index k -> { entryIdx, compIdx } by replicating the
 * flatten order used when the schedule was saved, and verifies the mapping
 * against the stored rawEntries values.
 */
function mapRawEntries(schedule) {
    const raws = Array.isArray(schedule.rawEntries) ? schedule.rawEntries : [];
    const source = Array.isArray(schedule.entries) && schedule.entries.length ? schedule.entries : [];
    const map = [];
    source.forEach((entry, entryIdx) => {
        if (!entry) return;
        const days = String(entry.day || "").split("/").map(x => x.trim()).filter(Boolean);
        const count = Math.max(days.length, 1);
        for (let i = 0; i < count; i++) {
            map.push({ entryIdx, compIdx: i });
        }
    });
    if (map.length !== raws.length) return null;
    for (let k = 0; k < map.length; k++) {
        const entry = source[map[k].entryIdx];
        const days = String(entry.day || "").split("/").map(x => x.trim()).filter(Boolean);
        const times = String(entry.time || "").split("/").map(x => x.trim()).filter(Boolean);
        const rooms = String(entry.room || "").split("/").map(x => x.trim()).filter(Boolean);
        const i = map[k].compIdx;
        const raw = raws[k];
        if (!raw) return null;
        if (String(raw.code || "").trim() !== String(entry.code || "").trim()) return null;
        if (String(raw.day || "").trim() !== (days[i] || days[0] || "").trim()) return null;
        if (!sameRange(raw.time, times[i] || times[0] || "")) return null;
        if (!sameRoomValue(raw.room, rooms[i] || rooms[0] || "", String(entry.room || ""))) return null;
    }
    return map;
}

/**
 * Rewrites component `compIdx` of an object's day/time/room slash-strings
 * (works for both `entries` rows and `rawEntries` rows).
 */
function setEntryComponent(obj, compIdx, day, time, room) {
    const split = (v) => String(v || "").split("/").map(x => x.trim());
    const join = (arr) => arr.join(" / ");
    const days = split(obj.day);
    const times = split(obj.time);
    const rooms = split(obj.room);
    const idx = Math.min(compIdx, Math.max(days.length - 1, 0));
    days[idx] = day;
    if (times.length && String(obj.time || "").trim()) times[Math.min(compIdx, times.length - 1)] = time; else times[0] = time;
    if (rooms.length && String(obj.room || "").trim()) rooms[Math.min(compIdx, rooms.length - 1)] = room; else rooms[0] = room;
    obj.day = join(days);
    obj.time = join(times);
    obj.room = join(rooms);
}

/* ---------------- slot resolution ---------------- */

function facultyKey(b) {
    return b.facultyUid || normName(b.faculty);
}

function sameFaculty(a, b) {
    if (a.facultyUid && b.facultyUid) return a.facultyUid === b.facultyUid;
    return !!a.faculty && normName(a.faculty) === normName(b.faculty);
}

function findNewSlot(mover, bookings, roomsByType, allRooms) {
    const duration = mover.end - mover.start;
    const origRoomType = roomsByType.get(normRoom(mover.room)) || "";
    const eligibleRooms = allRooms.filter(r => roomCanHostBooking(r, mover));
    const sameType = eligibleRooms
        .filter(r => r.roomName && normRoom(r.roomName) !== normRoom(mover.room) &&
            (!origRoomType || roomsByType.get(normRoom(r.roomName)) === origRoomType))
        .map(r => r.roomName);
    const otherEligible = eligibleRooms
        .filter(r => r.roomName && normRoom(r.roomName) !== normRoom(mover.room) && !sameType.includes(r.roomName))
        .map(r => r.roomName);

    // Keep the original room first, then try another suitable room at the
    // same day/time before altering the class meeting time.
    const roomOrder = roomCanHostBooking({ roomName: mover.room, roomType: origRoomType }, mover)
        ? [mover.room, ...sameType, ...otherEligible]
        : [...sameType, ...otherEligible];

    // Days already used by sibling components of the same entry (avoid same-day double meetings when possible)
    const siblingDays = bookings
        .filter(b => b.entryRef === mover.entryRef && b !== mover)
        .map(b => b.day);

    for (const pass of [0, 1]) { // pass 0: avoid sibling days; pass 1: allow them
        for (const room of roomOrder) {
            const days = [mover.day, ...WEEKDAYS.filter(d => d !== mover.day)];
            for (const day of days) {
                if (pass === 0 && siblingDays.includes(day)) continue;
                const starts = [];
                for (let s = 7 * 60; s + duration <= 19 * 60; s += 30) starts.push(s);
                starts.sort((x, y) =>
                    Math.abs(x - mover.start) - Math.abs(y - mover.start) || x - y);
                for (const start of starts) {
                    const end = start + duration;
                    const time = fmtRange(start, end);
                    // Candidate must differ from the current placement
                    if (day === mover.day && room === mover.room && time === mover.time) continue;
                    const clash = bookings.some(b => {
                        if (b === mover) return false;
                        if (b.day !== day) return false;
                        if (!(start < b.end && b.start < end)) return false;
                        if (normRoom(b.room) === normRoom(room)) return true;          // room occupied
                        if (sameFaculty(b, mover)) return true;                        // faculty busy
                        // A split section is stored in separate Set A / Set B
                        // documents but can retain the same display section name.
                        // Only bookings from the same schedule document block
                        // each other; sibling sets are allowed to run in
                        // separate rooms at the same time.
                        if (b.scheduleId === mover.scheduleId && b.section === mover.section) return true;
                        return false;
                    });
                    if (!clash) return { day, time, room, start, end };
                }
            }
        }
    }
    return null;
}

/* ---------------- main ---------------- */

function chooseMover(c) {
    const aShared = isSharedType(c.a.subjectType, c.a.code, c.a.name);
    const bShared = isSharedType(c.b.subjectType, c.b.code, c.b.name);
    if (!aShared && bShared) return c.a;
    if (!bShared && aShared) return c.b;
    if (c.a.setName === "Set B" && c.b.setName !== "Set B") return c.a;
    return c.b;
}

async function main() {
    console.log(`Mode: ${APPLY ? "APPLY (will write to Firestore)" : "DRY RUN (no writes)"}\n`);

    const schedules = await loadSchedules();
    const rooms = await loadRooms();
    const roomsByType = new Map(rooms.map(r => [normRoom(r.roomName), String(r.roomType || "").trim()]));
    console.log(`Loaded ${schedules.length} class schedule(s) and ${rooms.length} room(s).\n`);

    if (rooms.length) {
        const types = [...new Set(rooms.map(r => String(r.roomType || "").trim()))].filter(Boolean);
        console.log(`Room types: ${types.join(", ")}\n`);
    }

    let bookings = buildBookings(schedules);
    console.log(`Total bookings (expanded per day): ${bookings.length}\n`);

    // Verify rawEntries mapping for every schedule up front
    const rawIndex = new Map(); // scheduleId -> Map("entryIdx:compIdx" -> rawEntry object)
    for (const s of schedules) {
        const map = mapRawEntries(s);
        if (!map) {
            console.warn(`WARNING: rawEntries of "${s.id}" could not be mapped 1:1 to entries; rawEntries for it will be left untouched.`);
            rawIndex.set(s.id, null);
            continue;
        }
        const idx = new Map();
        map.forEach((m, k) => idx.set(`${m.entryIdx}:${m.compIdx}`, s.rawEntries[k]));
        rawIndex.set(s.id, idx);
    }

    const moveLog = [];
    const unresolved = [];
    const modifiedScheduleIds = new Set();

    for (let pass = 1; pass <= 10; pass++) {
        const conflicts = detectConflicts(bookings);
        if (!conflicts.length) break;
        console.log(`--- Pass ${pass}: ${conflicts.length} conflict(s) found ---`);

        const movedThisPass = new Set();
        for (const c of conflicts) {
            const mover = chooseMover(c);
            if (movedThisPass.has(mover)) continue; // its slot already changed; re-evaluate next pass
            movedThisPass.add(mover);

            const slot = findNewSlot(mover, bookings, roomsByType, rooms);
            if (!slot) {
                unresolved.push(`${mover.section} ${mover.code} (${mover.day} ${mover.time} @ ${mover.room}) — no free slot found`);
                continue;
            }

            moveLog.push(
                `${mover.section} | ${mover.code} ${mover.name} | ` +
                `${mover.day} ${mover.time} @ ${mover.room}  ->  ${slot.day} ${slot.time} @ ${slot.room}`
            );
            modifiedScheduleIds.add(mover.scheduleId);

            // 1) update the live booking (affects subsequent conflict checks)
            mover.day = slot.day;
            mover.time = slot.time;
            mover.room = slot.room;
            mover.start = slot.start;
            mover.end = slot.end;

            // 2) update entries[rowIdx] slash-strings
            setEntryComponent(mover.entryRef, mover.compIdx, slot.day, slot.time, slot.room);

            // 3) update the twin rawEntries record
            const idx = rawIndex.get(mover.scheduleId);
            if (idx) {
                const raw = idx.get(`${mover.entryIdx}:${mover.compIdx}`);
                if (raw) {
                    setEntryComponent(raw, mover.compIdx, slot.day, slot.time, slot.room);
                }
            }
        }
    }

    console.log(`\n=== RESOLUTION PLAN (${moveLog.length} move(s)) ===`);
    moveLog.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

    const remaining = detectConflicts(bookings);
    if (remaining.length) {
        console.log(`\nWARNING: ${remaining.length} conflict(s) could NOT be resolved:`);
        remaining.forEach(c => console.log(
            `  - ${c.room} ${c.day} ${c.time}: ${c.a.section} (${c.a.code}) vs ${c.b.section} (${c.b.code})`
        ));
    } else {
        console.log("\n✓ All conflicts resolved. Re-verification found 0 conflicts.");
    }
    if (unresolved.length) {
        console.log(`\nUnresolvable bookings: ${unresolved.length}`);
        unresolved.forEach(u => console.log(`  - ${u}`));
    }

    if (!APPLY) {
        console.log("\nDry run complete. Re-run with --apply to write changes to Firestore.");
        process.exit(remaining.length ? 2 : 0);
    }

    if (remaining.length) {
        console.log("\nAborting write: unresolved conflicts remain. Nothing was written.");
        process.exit(2);
    }

    // Write back only the schedules whose entries/rawEntries changed
    const batch = db.batch();
    let written = 0;
    schedules.forEach(s => {
        if (!modifiedScheduleIds.has(s.id)) return;
        const idx = rawIndex.get(s.id);
        if (!idx) {
            console.warn(`Skipping write for "${s.id}" (rawEntries mapping unavailable).`);
            return;
        }
        batch.update(s.ref, {
            entries: s.entries,
            rawEntries: s.rawEntries,
            updatedAt: new Date()
        });
        written++;
    });

    await batch.commit();
    console.log(`\n✅ Wrote updated entries/rawEntries for ${written} schedule document(s) to Firestore.`);
    process.exit(0);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });



