/* Comprehensive Exam Schedule Review Script
 *
 * Reads all saved exam schedules from Firestore ("examSchedules"), loads the
 * faculty roster, and then:
 *
 *   1. Identifies every exam that has a REAL room/date/time/day but whose
 *      proctor is unassigned (TBA / Unassigned / "Faculty Proctor" / empty).
 *      These are exams that SHOULD be proctored but weren't because the
 *      generator couldn't find a free faculty member at generation time.
 *
 *   2. Assigns a conflict-free faculty proctor to each such exam, respecting:
 *        - no proctor may be double-booked at overlapping times on the same date
 *        - max 2 exams per proctor per day (matches the generator's convention)
 *        - fair workload distribution (fewest-exams-first)
 *
 *   3. Detects and reports ALL conflicts across room / time / faculty proctor:
 *        - room conflicts  (same room + overlapping time + different sections)
 *        - proctor conflicts (same proctor + overlapping time)
 *        - section conflicts (same section + overlapping time)
 *
 *   4. Writes the fixed proctor assignments back to Firestore and prints a
 *      detailed report (also saved to review_report.txt).
 *
 * Gyms may be shared by up to 2 sections in the same slot (existing rule).
 *
 * Run: node reviewSchedules.mjs
 */

import { db } from "./firebase-admin.js";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Time helpers (hours 1-6 are PM, matching scheduler.js / exam.js)
// ---------------------------------------------------------------------------
function parseTime(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(":").map(Number);
  let hour = parts[0] || 0;
  const minute = parts[1] || 0;
  if (hour >= 1 && hour <= 6) hour += 12;
  return hour * 60 + minute;
}

function timesOverlap(a, b) {
  if (!a || !b) return false;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (!sa.includes("-") || !sb.includes("-")) return false;
  const [as, ae] = sa.split("-").map(parseTime);
  const [bs, be] = sb.split("-").map(parseTime);
  return as < be && bs < ae;
}

const MAX_EXAMS_PER_PROCTOR_PER_DAY = 2;

// Values that mean "this exam has no proctor assigned yet".
function isUnassignedProctor(p) {
  const n = String(p || "").trim().toLowerCase();
  return (
    !n ||
    n === "tba" ||
    n === "unassigned" ||
    n === "faculty proctor" ||
    n === "tba / unassigned" ||
    n === "none"
  );
}

// A genuinely-TBA subject (OJT, Field Study, etc.) keeps TBA everywhere:
// date/time/room/day are ALL "TBA". These are NOT real exams — they should
// never get a proctor and never participate in conflict checks.
function isTbaSubject(exam) {
  const isTba = (v) => String(v || "").trim().toLowerCase() === "tba";
  return (
    isTba(exam.date) &&
    isTba(exam.time) &&
    isTba(exam.room) &&
    isTba(exam.day)
  );
}

function normaliseName(name) {
  return String(name || "").trim().toLowerCase();
}

function isRealDate(v) {
  const s = String(v || "").trim();
  if (!s || s.toLowerCase() === "tba") return false;
    // Accept YYYY-MM-DD or any non-TBA token
  return true;
}

// ---------------------------------------------------------------------------
// Proctor-schedule tracking helpers (shared by assignment & conflict resolution)
// ---------------------------------------------------------------------------
function buildProctorDaily(bookings) {
  const proctorDaily = new Map();
  for (const b of bookings) {
    if (isUnassignedProctor(b.proctor)) continue;
    if (!isRealDate(b.date)) continue;
    const key = normaliseName(b.proctor);
    const perDate = proctorDaily.get(key) || new Map();
    const arr = perDate.get(b.date) || [];
    arr.push({ time: b.time, section: b.section, code: b.code });
    perDate.set(b.date, arr);
    proctorDaily.set(key, perDate);
  }
  return proctorDaily;
}

function proctorIsFree(proctorDaily, facultyName, date, time) {
  const key = normaliseName(facultyName);
  const perDate = proctorDaily.get(key);
  if (!perDate) return true;
  const arr = perDate.get(date);
  if (!arr) return true;
  for (const slot of arr) {
    if (timesOverlap(slot.time, time)) return false;
  }
  return true;
}

function proctorDayCount(proctorDaily, facultyName, date) {
  const key = normaliseName(facultyName);
  const perDate = proctorDaily.get(key);
  return perDate ? (perDate.get(date) || []).length : 0;
}

function proctorTotalCount(proctorDaily, facultyName) {
  const key = normaliseName(facultyName);
  const perDate = proctorDaily.get(key);
  if (!perDate) return 0;
  let n = 0;
  for (const arr of perDate.values()) n += arr.length;
  return n;
}

function removeSlot(proctorDaily, facultyName, date, time, section, code) {
  const key = normaliseName(facultyName);
  const perDate = proctorDaily.get(key);
  if (!perDate) return;
  const arr = perDate.get(date);
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].time === time && arr[i].section === section && arr[i].code === code) {
      arr.splice(i, 1);
      break;
    }
  }
}

function addSlot(proctorDaily, facultyName, date, time, section, code) {
  const key = normaliseName(facultyName);
  const perDate = proctorDaily.get(key) || new Map();
  const arr = perDate.get(date) || [];
  arr.push({ time, section, code });
  perDate.set(date, arr);
  proctorDaily.set(key, perDate);
}

function pickBestFaculty(proctorDaily, faculty, date, time, excludeNames = []) {
  const exclude = new Set(excludeNames.map(normaliseName));
  const candidates = faculty.filter((f) => !exclude.has(normaliseName(f.fullName)));

  // Prefer candidates under the per-day cap who are overlap-free.
  let pool = candidates.filter(
    (f) =>
      proctorIsFree(proctorDaily, f.fullName, date, time) &&
      proctorDayCount(proctorDaily, f.fullName, date) < MAX_EXAMS_PER_PROCTOR_PER_DAY
  );
  let relaxed = false;
  if (!pool.length) {
    // Relax the per-day cap but STILL require no time overlap (a true conflict
    // must never happen). Only triggers when every faculty is already at the cap.
    relaxed = true;
    pool = candidates.filter((f) => proctorIsFree(proctorDaily, f.fullName, date, time));
  }

  if (!pool.length) return null;
  pool.sort((a, b) => {
    const da = proctorDayCount(proctorDaily, a.fullName, date) - proctorDayCount(proctorDaily, b.fullName, date);
    if (da !== 0) return da;
    return proctorTotalCount(proctorDaily, a.fullName) - proctorTotalCount(proctorDaily, b.fullName);
  });
  return { ...pool[0], relaxed };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadFaculty() {
  const list = [];
  const seen = new Set();
  const push = (u) => {
    const name = (u.fullName || u.name || u.facultyName || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      id: u.id,
      fullName: name,
      uid: u.uid || u.id,
      email: u.email || "",
      department: u.department || "",
    });
  };

  const usersSnap = await db.collection("users").get();
  usersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => String(u.role || "").toLowerCase().includes("faculty"))
    .filter((u) => u.excluded !== true)
    .forEach(push);

  const facultySnap = await db.collection("faculty").get();
  facultySnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => u.excluded !== true)
    .forEach(push);

  return list;
}

async function loadSchedules() {
  const snap = await db.collection("examSchedules").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------------------
// Build a normalized booking list from raw schedules
// ---------------------------------------------------------------------------
function buildBookings(schedules) {
  // Booking = one (schedule, exam-index) pair that is a REAL exam (not TBA).
  const bookings = [];
  let tbaSubjectCount = 0;
  let examCount = 0;

  for (const sched of schedules) {
    const exams = Array.isArray(sched.exams) ? sched.exams : [];
    for (let i = 0; i < exams.length; i++) {
      const e = exams[i];
      examCount++;
      if (isTbaSubject(e)) {
        tbaSubjectCount++;
        continue; // legitimate TBA subject — skip entirely
      }
      bookings.push({
        scheduleId: sched.id,
        scheduleDoc: sched, // reference for writing back
        idx: i,
        section: sched.section || "",
        academicYear: sched.academicYear || "",
        semester: sched.semester || "",
        examType: sched.examType || "",
        program: sched.program || "",
        major: sched.major || "",
        code: e.code || "",
        name: e.name || e.subjectName || "",
        date: e.date || "",
        day: e.day || "",
        time: e.time || "",
        room: e.room || "",
        proctor: e.proctor || "",
        proctorUid: e.proctorUid || "",
      });
    }
  }

  return { bookings, tbaSubjectCount, examCount };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------
function detectConflicts(bookings) {
  const conflicts = [];

  // Index real exams by date -> list of bookings
  const byDate = new Map();
  for (const b of bookings) {
    const d = String(b.date || "").trim();
    if (!d || d.toLowerCase() === "tba") continue;
    const arr = byDate.get(d) || [];
    arr.push(b);
    byDate.set(d, arr);
  }

  for (const [date, list] of byDate) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];

        if (!timesOverlap(a.time, b.time)) continue;

        // --- Section conflict: same section, overlapping times ---
        if (a.section && a.section === b.section) {
          // Allow same section only if same subject+code (duplicate, not real
          // conflict). Otherwise it's a real overlap.
          if (!(a.code && a.code === b.code && a.scheduleId === b.scheduleId)) {
            conflicts.push({
              type: "SECTION_CONFLICT",
              date,
              detail: `Section ${a.section}: ${a.code} (${a.time}) overlaps ${b.code} (${b.time})`,
              a,
              b,
            });
          }
        }

        // --- Proctor conflict: same (real) proctor, overlapping times ---
        if (
          !isUnassignedProctor(a.proctor) &&
          normaliseName(a.proctor) === normaliseName(b.proctor)
        ) {
          conflicts.push({
            type: "PROCTOR_CONFLICT",
            date,
            detail: `Proctor ${a.proctor} is double-booked: ${a.section} (${a.code} ${a.time}) vs ${b.section} (${b.code} ${b.time})`,
            a,
            b,
          });
        }

        // --- Room conflict: same room, overlapping times, different sections ---
        if (a.room && b.room && a.room === b.room && a.section !== b.section) {
          const isGym = /gym/i.test(a.room);
          if (isGym) {
            // Gyms may be shared by up to 2 sections in the same slot.
            const sharers = list.filter(
              (x) =>
                timesOverlap(x.time, a.time) &&
                x.room === a.room &&
                x.section !== a.section
            ).length;
            if (sharers > 1) {
              conflicts.push({
                type: "ROOM_CONFLICT",
                date,
                detail: `Room ${a.room} (Gym): too many sections sharing the slot — ${a.section} (${a.code}) & ${b.section} (${b.code}) among others`,
                a,
                b,
              });
            }
            // valid gym sharing (<=2 sections) — no conflict
          } else {
            conflicts.push({
              type: "ROOM_CONFLICT",
              date,
              detail: `Room ${a.room}: ${a.section} (${a.code} ${a.time}) clashes with ${b.section} (${b.code} ${b.time})`,
              a,
              b,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Proctor assignment
// ---------------------------------------------------------------------------
function assignProctors(bookings, faculty) {
  if (!faculty.length) {
    return { results: [], assigned: 0, unassigned: 0, unassignedList: [] };
  }

  // Identify exams that need a proctor: real slot + unassigned proctor.
  const pending = bookings.filter((b) => isUnassignedProctor(b.proctor));

  // Track every proctor's existing + newly-assigned daily schedule.
  // Map: normalizedName -> { date -> [ {time, ...booking} ] }
  const proctorDaily = new Map();

  // Seed with already-assigned proctors (their real assignments become
  // constraints for the new assignments).
  for (const b of bookings) {
    if (isUnassignedProctor(b.proctor)) continue;
    if (!isRealDate(b.date)) continue;
    const key = normaliseName(b.proctor);
    const perDate = proctorDaily.get(key) || new Map();
    const arr = perDate.get(b.date) || [];
    arr.push({ time: b.time, section: b.section, code: b.code });
    perDate.set(b.date, arr);
    proctorDaily.set(key, perDate);
  }

  // Helper: is a faculty member free for this slot?
  function isFree(facultyName, date, time) {
    const key = normaliseName(facultyName);
    const perDate = proctorDaily.get(key);
    if (!perDate) return true;
    const arr = perDate.get(date);
    if (!arr) return true;
    for (const slot of arr) {
      if (timesOverlap(slot.time, time)) return false;
    }
    return true;
  }

  function dayCount(facultyName, date) {
    const key = normaliseName(facultyName);
    const perDate = proctorDaily.get(key);
    return perDate ? (perDate.get(date) || []).length : 0;
  }

  function totalCount(facultyName) {
    const key = normaliseName(facultyName);
    const perDate = proctorDaily.get(key);
    if (!perDate) return 0;
    let n = 0;
    for (const arr of perDate.values()) n += arr.length;
    return n;
  }

  // Sort pending slots deterministically: by date, then time start.
  const parseStart = (t) => parseTime(String(t || "").split("-")[0]);
  pending.sort((x, y) => {
    if (x.date !== y.date) return String(x.date).localeCompare(String(y.date));
    return parseStart(x.time) - parseStart(y.time);
  });

  const results = [];
  let assigned = 0;
  let unassigned = 0;
  const unassignedList = [];

  for (const b of pending) {
    if (!isRealDate(b.date) || !b.time || !b.room) {
      // Has a proctor slot but missing date/time/room — can't assign reliably.
      unassigned++;
      unassignedList.push(b);
      results.push({ ...b, assignedProctor: null, reason: "No real date/time to anchor assignment" });
      continue;
    }

    // Candidate faculty: not overlapping this slot AND under the per-day cap.
    const candidates = faculty.filter((f) => {
      if (!isFree(f.fullName, b.date, b.time)) return false;
      if (dayCount(f.fullName, b.date) >= MAX_EXAMS_PER_PROCTOR_PER_DAY) return false;
      return true;
    });

    let picked = null;
    if (candidates.length) {
      // Fair distribution: fewest exams that day first, then fewest overall.
      candidates.sort((a, b) => {
        const da = dayCount(a.fullName, b.date) - dayCount(b.fullName, b.date);
        if (da !== 0) return da;
        return totalCount(a.fullName) - totalCount(b.fullName);
      });
      picked = candidates[0];
    } else {
      // Fallback: relax the 2-per-day cap but STILL respect no-overlap (a true
      // conflict must never happen). This only triggers if every faculty is
      // already at 2 exams that day — rare with 40+ faculty.
      const overlapFree = faculty.filter((f) => isFree(f.fullName, b.date, b.time));
      if (overlapFree.length) {
        overlapFree.sort((a, b) => totalCount(a.fullName) - totalCount(b.fullName));
        picked = overlapFree[0];
      }
    }

    if (picked) {
      b.proctor = picked.fullName;
      b.proctorUid = picked.uid;
      assigned++;
      const key = normaliseName(picked.fullName);
      const perDate = proctorDaily.get(key) || new Map();
      const arr = perDate.get(b.date) || [];
      arr.push({ time: b.time, section: b.section, code: b.code });
      perDate.set(b.date, arr);
      proctorDaily.set(key, perDate);
      results.push({ ...b, assignedProctor: picked.fullName, reason: null });
    } else {
      unassigned++;
      unassignedList.push(b);
      results.push({ ...b, assignedProctor: null, reason: "No free faculty (all busy or capped) for this slot" });
    }
  }

    return { results, assigned, unassigned, unassignedList };
}

// ---------------------------------------------------------------------------
// Resolve existing faculty-proctor conflicts
// ---------------------------------------------------------------------------
function resolveProctorConflicts(bookings, faculty) {
  if (!faculty.length) return { results: [], resolved: 0, unresolved: 0 };

  const results = [];
  let pass = 0;
  const MAX_PASSES = 100;

  while (pass < MAX_PASSES) {
    const conflicts = detectConflicts(bookings).filter(
      (c) => c.type === "PROCTOR_CONFLICT"
    );
    if (conflicts.length === 0) break;

    for (const c of conflicts) {
      const a = c.a; // keep this assignment
      const b = c.b; // reassign this one

      // Build a fresh proctor schedule and remove b's current (conflicting)
      // proctor so we can find a replacement who is genuinely free.
      const proctorDaily = buildProctorDaily(bookings);
      removeSlot(proctorDaily, b.proctor, b.date, b.time, b.section, b.code);

      const picked = pickBestFaculty(proctorDaily, faculty, b.date, b.time, [a.proctor]);

      if (picked) {
        const oldProctor = b.proctor;
        b.proctor = picked.fullName;
        b.proctorUid = picked.uid;
        addSlot(proctorDaily, picked.fullName, b.date, b.time, b.section, b.code);
        results.push({
          scheduleId: b.scheduleId,
          idx: b.idx,
          scheduleDoc: b.scheduleDoc,
          section: b.section,
          date: b.date,
          time: b.time,
          room: b.room,
          code: b.code,
          oldProctor,
          newProctor: picked.fullName,
          proctorUid: picked.uid,
          resolved: true,
        });
      } else {
        results.push({
          scheduleId: b.scheduleId,
          idx: b.idx,
          scheduleDoc: b.scheduleDoc,
          section: b.section,
          date: b.date,
          time: b.time,
          room: b.room,
          code: b.code,
          oldProctor: b.proctor,
          newProctor: null,
          proctorUid: "",
          resolved: false,
        });
      }
    }
    pass++;
  }

  return {
    results,
    resolved: results.filter((r) => r.resolved).length,
    unresolved: results.filter((r) => !r.resolved).length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const report = [];
  const log = (s) => { console.log(s); report.push(s); };

  log("=".repeat(72));
  log("  EXAM SCHEDULE REVIEW — TBA PROCTOR ASSIGNMENT & CONFLICT CHECK");
  log("=".repeat(72));

  const faculty = await loadFaculty();
  log(`\nLoaded ${faculty.length} faculty members from the roster.`);

  const schedules = await loadSchedules();
  log(`Loaded ${schedules.length} saved exam schedule(s) from Firestore.`);

  const { bookings, tbaSubjectCount, examCount } = buildBookings(schedules);

  // Break down TBA subjects vs real exams
  const realExamBookings = bookings; // all are real (non-TBA-subject) exams
  log(`\nTotal exam entries across all schedules: ${examCount}`);
  log(`  Legitimate TBA subjects (no exam, left as-is): ${tbaSubjectCount}`);
  log(`  Real exams requiring a slot (room/date/time): ${realExamBookings.length}`);

  // --- Identify unassigned proctors among real exams ---
  const unassignedExams = realExamBookings.filter((b) => isUnassignedProctor(b.proctor));
  const alreadyAssigned = realExamBookings.filter((b) => !isUnassignedProctor(b.proctor));
  log(`\nExams already assigned a faculty proctor: ${alreadyAssigned.length}`);
  log(`Exams needing a faculty proctor (TBA/unassigned): ${unassignedExams.length}`);

  if (!unassignedExams.length) {
    log("\nAll real exams already have a faculty proctor. Nothing to assign.");
  }

  // --- Pre-assignment conflict scan (on current data) ---
  log("\n" + "-".repeat(72));
  log("PHASE 1: Pre-assignment conflict scan (before any fixes)");
  log("-".repeat(72));
  const preConflicts = detectConflicts(bookings);
  // Proctor conflicts among pre-existing assignments (TBA proctors excluded)
  const preProctorConflicts = preConflicts.filter((c) => c.type === "PROCTOR_CONFLICT");
  const preRoomConflicts = preConflicts.filter((c) => c.type === "ROOM_CONFLICT");
  const preSectionConflicts = preConflicts.filter((c) => c.type === "SECTION_CONFLICT");
  if (preConflicts.length === 0) {
    log("  ✓ No conflicts found among currently-saved schedules.");
  } else {
    log(`  ⚠ Found ${preConflicts.length} pre-existing conflict(s):`);
    log(`      - Room conflicts:     ${preRoomConflicts.length}`);
    log(`      - Proctor conflicts:  ${preProctorConflicts.length}`);
    log(`      - Section conflicts:  ${preSectionConflicts.length}`);
    for (const c of preConflicts) {
      log(`    [${c.type}] ${c.date} — ${c.detail}`);
    }
  }

  // --- Assign TBA proctors ---
  log("\n" + "-".repeat(72));
  log("PHASE 2: Assigning faculty proctors to TBA exams");
  log("-".repeat(72));
  const assignment = assignProctors(bookings, faculty);
  log(`  TBA exams assigned a proctor: ${assignment.assigned}`);
  log(`  TBA exams that could NOT be assigned: ${assignment.unassigned}`);

  if (assignment.results.length) {
    log("\n  Assignment log:");
    for (const r of assignment.results) {
      const tag = r.assignedProctor
        ? `→ ${r.assignedProctor}`
        : `→ UNRESOLVED (${r.reason})`;
      log(`    ${r.section} | ${r.date} ${r.time} | ${r.room} | ${r.code} | ${tag}`);
    }
  }

    if (assignment.unassignedList.length) {
    log("\n  ⚠ The following TBA exams could not be assigned a proctor:");
    for (const b of assignment.unassignedList) {
      log(`    ${b.section} | ${b.date} ${b.time} | ${b.room} | ${b.code}`);
    }
  }

  // --- Resolve existing proctor conflicts ---
  log("\n" + "-".repeat(72));
  log("PHASE 2b: Resolving existing faculty-proctor conflicts");
  log("-".repeat(72));
  const resolution = resolveProctorConflicts(bookings, faculty);
  log(`  Proctor conflicts resolved: ${resolution.resolved}`);
  log(`  Proctor conflicts unresolved: ${resolution.unresolved}`);
  if (resolution.results.length) {
    log("\n  Resolution log:");
    for (const r of resolution.results) {
      const tag = r.resolved
        ? `→ ${r.newProctor} (was: ${r.oldProctor})`
        : `→ UNRESOLVED`;
      log(`    ${r.section} | ${r.date} ${r.time} | ${r.room} | ${r.code} | ${tag}`);
    }
  }

  // --- Final conflict scan (after all fixes) ---
  log("\n" + "-".repeat(72));
  log("PHASE 3: Final conflict scan (after all fixes)");
  log("-".repeat(72));
  const postConflicts = detectConflicts(bookings);
  const postProctorConflicts = postConflicts.filter((c) => c.type === "PROCTOR_CONFLICT");
  const postRoomConflicts = postConflicts.filter((c) => c.type === "ROOM_CONFLICT");
  const postSectionConflicts = postConflicts.filter((c) => c.type === "SECTION_CONFLICT");
  if (postConflicts.length === 0) {
    log("  ✓ No conflicts remain (room, time, and faculty proctor).");
  } else {
    log(`  ⚠ Found ${postConflicts.length} conflict(s) after assignment:`);
    log(`      - Room conflicts:     ${postRoomConflicts.length}`);
    log(`      - Proctor conflicts:  ${postProctorConflicts.length}`);
    log(`      - Section conflicts:  ${postSectionConflicts.length}`);
    for (const c of postConflicts) {
      log(`    [${c.type}] ${c.date} — ${c.detail}`);
    }
  }

  // --- Summary of remaining TBA proctors ---
  const remainingTba = bookings.filter((b) => isUnassignedProctor(b.proctor));
  log("\n" + "-".repeat(72));
  log("SUMMARY");
  log("-".repeat(72));
  log(`  Schedules reviewed:        ${schedules.length}`);
  log(`  Faculty roster size:        ${faculty.length}`);
  log(`  Real exams:                 ${realExamBookings.length}`);
  log(`  Legitimate TBA subjects:    ${tbaSubjectCount} (correctly left as TBA)`);
  log(`  TBA proctors fixed:         ${assignment.assigned}`);
    log(`  TBA proctors unresolved:    ${assignment.unassigned}`);
  log(`  Proctor conflicts resolved: ${resolution.resolved}`);
  log(`  Proctor conflicts unresolved: ${resolution.unresolved}`);
  log(`  Remaining unassigned proctors: ${remainingTba.length}`);
  log(`  Conflicts after fix:        ${postConflicts.length} (room: ${postRoomConflicts.length}, proctor: ${postProctorConflicts.length}, section: ${postSectionConflicts.length})`);

    // --- Write back to Firestore ---
  // Collect ALL modifications: TBA assignments (Phase 2) + conflict resolutions (Phase 2b).
  const allMods = [];
  for (const r of assignment.results) {
    if (r.assignedProctor) allMods.push({ ...r, newProctor: r.assignedProctor });
  }
  for (const r of resolution.results) {
    if (r.resolved) allMods.push(r);
  }

  if (allMods.length > 0) {
    log("\n" + "-".repeat(72));
    log("PHASE 4: Persisting fixed proctor assignments to Firestore");
    log("-".repeat(72));

    // Group fixes by schedule document id, preserving original array structure.
    // We clone each touched doc's exams array ONCE, then apply every proctor fix
    // to that clone before writing it back.
    const touchedDocs = new Map(); // docId -> { sched, examsCopy }

    for (const r of allMods) {
      if (!touchedDocs.has(r.scheduleId)) {
        const sched = r.scheduleDoc;
        const examsCopy = Array.isArray(sched.exams)
          ? sched.exams.map((e) => ({ ...e }))
          : [];
        touchedDocs.set(r.scheduleId, { sched, examsCopy });
      }
      const { examsCopy } = touchedDocs.get(r.scheduleId);
      const entry = examsCopy[r.idx];
      if (entry) {
        const proctor = r.newProctor || r.assignedProctor;
        entry.proctor = proctor;
        entry.proctorUid = r.proctorUid || entry.proctorUid || "";
      }
    }

    let writtenDocs = 0;
    for (const [docId, { sched, examsCopy }] of touchedDocs) {
      const toWrite = {
        ...sched,
        exams: examsCopy,
        updatedAt: new Date().toISOString(),
      };
      await db.collection("examSchedules").doc(docId).set(toWrite, { merge: true });
      writtenDocs++;
      log(`  • Updated ${docId}: proctor assignments persisted.`);
    }
    log(`  Total schedule documents updated: ${writtenDocs}`);
  } else {
    log("\nNo proctor changes were made — Firestore left unchanged.");
  }

  log("\nReview complete.");

  // Save full report to disk
  try {
    const reportPath = path.resolve("review_report.txt");
    fs.writeFileSync(reportPath, report.join("\n"), "utf8");
    console.log(`\nFull report written to: ${reportPath}`);
  } catch (e) {
    console.warn("Could not write report file:", e.message);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
