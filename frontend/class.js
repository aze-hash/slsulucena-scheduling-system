import { db, auth } from "../firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { saveReportToFirestore } from "./reportStorage.js";
import { renderClassCalendar } from "./js/schedule-calendar.js";

import {
    collection,
    getDocs,
    query,
    where,
    doc,
    setDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ------------------------------------------------------------------ */
/*  Custom centered notification system (replaces browser alert/confirm) */
/* ------------------------------------------------------------------ */

function showToast(message) {
    const toast = document.getElementById("customToast");
    const msgEl = document.getElementById("customToastMessage");
    if (!toast || !msgEl) { alert(message); return; }
    msgEl.textContent = message;
    toast.style.display = "flex";
}

function hideToast() {
    const toast = document.getElementById("customToast");
    if (toast) toast.style.display = "none";
}

document.addEventListener("click", event => {
    if (event.target.id === "customToastClose" || event.target === document.getElementById("customToast")) {
        hideToast();
    }
});

function showConfirm(message) {
    return new Promise(resolve => {
        const modal = document.getElementById("customConfirmModal");
        const msgEl = document.getElementById("customConfirmMessage");
        const cancelBtn = document.getElementById("customConfirmCancel");
        const okBtn = document.getElementById("customConfirmOk");

        if (!modal || !msgEl || !cancelBtn || !okBtn) {
            resolve(confirm(message));
            return;
        }

        msgEl.textContent = message;
        modal.style.display = "flex";

        function cleanup() {
            modal.style.display = "none";
            cancelBtn.removeEventListener("click", onCancel);
            okBtn.removeEventListener("click", onOk);
            modal.removeEventListener("click", onBackdrop);
        }

        function onCancel() { cleanup(); resolve(false); }
        function onOk() { cleanup(); resolve(true); }
        function onBackdrop(event) {
            if (event.target === modal) { cleanup(); resolve(false); }
        }

        cancelBtn.addEventListener("click", onCancel);
        okBtn.addEventListener("click", onOk);
        modal.addEventListener("click", onBackdrop);
    });
}

const semesterSelect = document.getElementById("semester");
const programSelect = document.getElementById("program");
const majorSelect = document.getElementById("major");
const yearLevelSelect = document.getElementById("yearLevel");
const sectionSelect = document.getElementById("section");

const subjectBody = document.getElementById("subjectTableBody");
const scheduleBody = document.getElementById("scheduleTableBody");
const modal = document.getElementById("scheduleModal");
const saveScheduleBtn = document.getElementById("saveScheduleBtn");
const publishScheduleBtn = document.getElementById("publishScheduleBtn");
const savedSchedulesList = document.getElementById("savedSchedulesList");
const emptySavedSchedules = document.getElementById("emptySavedSchedules");
const savedScheduleSearchInput = document.getElementById("savedScheduleSearchInput");
const generatingOverlay = document.getElementById("generatingOverlay");
const generateBtn = document.getElementById("generateBtn");
const savedOverlay = document.getElementById("savedOverlay");

const SAVED_SCHEDULES_KEY = "chairpersonSavedSchedules";

const ARCHIVE_PAGE_SIZE = 10;

let generatedSchedule = null;
let archiveCurrentPage = 1;
let archiveFilterYear = "";
let archiveFilterSemester = "";
let archiveFilterSearch = "";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/* Subjects that don't require a room/day/time (e.g. OJT, Field Study, etc.) */
const TBA_SUBJECT_CODES = new Set([
    "SIP01", "SIP02", "OJT01", "OJT02",
    "AMC01", "FS001", "FS002", "PED11", "TCC01"
]);

const minorSlots = [
    "7:30-9:00", "9:00-10:30", "10:30-12:00",
    "1:00-2:30", "2:30-4:00", "4:00-5:30",
    "5:00-6:30"
];

const majorSlots = [
    "7:30-10:00", "10:00-12:30", "1:00-3:30", "3:30-6:00",
    "4:00-6:30"
];

const activitySlots = [
    "8:00-10:00", "10:00-12:00",
    "1:00-3:00", "3:00-5:00"
];

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function getSavedSchedules() {
    try {
        return JSON.parse(localStorage.getItem(SAVED_SCHEDULES_KEY)) || [];
    } catch {
        return [];
    }
}

function setSavedSchedules(schedules) {
    localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(schedules));
}

/* ------------------------------------------------------------------ */
/*  Firestore helpers                                                  */
/* ------------------------------------------------------------------ */

const SCHEDULES_COLLECTION = "classSchedules";

/**
 * Returns a stable document ID for a schedule so that saving the same
 * combination (section + semester + program + major + yearLevel) always
 * overwrites the same Firestore document.
 */
function scheduleDocId(schedule) {
    const raw = [
        schedule.section || "",
        schedule.semester || "",
        schedule.program || "",
        schedule.major || "",
        schedule.yearLevel || "",
        schedule.academicYear || ""
    ].join("_");

    return raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
}

async function saveScheduleToFirestore(schedule) {
    const docId = scheduleDocId(schedule);

    const status = schedule.status === "archived"
        ? "archived"
        : (schedule.status === "published" ? "published" : (schedule.status || "draft"));

    const data = {
        name: schedule.name,
        section: schedule.section,
        semester: schedule.semester,
        program: schedule.program,
        major: schedule.major,
        yearLevel: schedule.yearLevel,
        academicYear: schedule.academicYear || "",
        entries: schedule.entries,
        rawEntries: schedule.rawEntries,
        status: status,
        createdAt: schedule.createdAt
            ? new Date(schedule.createdAt)
            : new Date(),
        updatedAt: new Date(),
        savedBy: auth.currentUser?.uid || null
    };

    if (schedule.publishedAt) {
        data.publishedAt = schedule.publishedAt instanceof Date
            ? schedule.publishedAt
            : new Date(schedule.publishedAt);
    }
    if (schedule.publishedBy) {
        data.publishedBy = schedule.publishedBy;
    }
    if (schedule.releaseId) {
        data.releaseId = schedule.releaseId;
    }

    if (schedule.exportedAt) {
        data.exportedAt = schedule.exportedAt instanceof Date
            ? schedule.exportedAt
            : new Date(schedule.exportedAt);
    }

    await setDoc(doc(db, SCHEDULES_COLLECTION, docId), data);
}

const BACKEND_API_BASE_URL =
    "https://slsulucena-scheduling-system.onrender.com";

async function publishClassScheduleApi(schedule) {
    const scheduleId = schedule.id || scheduleDocId(schedule);
    console.log("🚀 [Publish] publishing started for class schedule:", scheduleId);

    const payload = {
        scheduleId: scheduleId,
        scheduleType: "class"
    };

    let response = null;
    let responseData = null;

    console.log("📡 [Publish] email notification API called:", `${BACKEND_API_BASE_URL}/api/publish-schedule`, payload);

    try {
        response = await fetch(`${BACKEND_API_BASE_URL}/api/publish-schedule`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        console.warn("[Publish] Primary backend fetch failed:", netErr.message);
        if (BACKEND_API_BASE_URL !== "https://slsulucena-scheduling-system.onrender.com") {
            try {
                console.log("[Publish] Retrying with production Render endpoint...");
                response = await fetch("https://slsulucena-scheduling-system.onrender.com/api/publish-schedule", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            } catch (fallbackErr) {
                console.error("❌ [Publish] email API error:", fallbackErr);
                return {
                    success: false,
                    error: fallbackErr.message || "Backend server unreachable"
                };
            }
        } else {
            console.error("❌ [Publish] email API error:", netErr);
            return {
                success: false,
                error: netErr.message || "Backend server unreachable"
            };
        }
    }

    if (response) {
        try {
            responseData = await response.json();
            console.log("📨 [Publish] email API response:", responseData);
        } catch (jsonErr) {
            console.error("❌ [Publish] Failed to parse email API JSON response:", jsonErr);
        }

        if (response.ok) {
            return responseData || { success: true };
        } else {
            const errMsg = responseData?.message || responseData?.error || `HTTP ${response.status}`;
            console.error("❌ [Publish] email API error:", errMsg);
            return {
                success: false,
                error: errMsg
            };
        }
    }

    return { success: false, error: "No response from email API" };
}

async function loadSchedulesFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, SCHEDULES_COLLECTION));
        return snapshot.docs.map(document => {
            const data = document.data();

            return {
                id: document.id,
                name: data.name || "",
                section: data.section || "",
                semester: data.semester || "",
                program: data.program || "",
                major: data.major || "",
                yearLevel: data.yearLevel || "",
                academicYear: data.academicYear || "",
                entries: data.entries || [],
                rawEntries: data.rawEntries || [],
                status: data.status === "archived" ? "archived" : (data.status === "published" ? "published" : (data.status || "draft")),
                publishedAt: data.publishedAt?.toDate?.()?.toISOString?.() || data.publishedAt || null,
                publishedBy: data.publishedBy || null,
                releaseId: data.releaseId || null,
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || new Date().toISOString(),
                exportedAt: data.exportedAt?.toDate?.()?.toISOString?.() || data.exportedAt || null
            };
        });
    } catch (error) {
        console.error("Could not load schedules from Firestore:", error);
        return [];
    }
}

async function archiveScheduleInFirestore(schedule) {
    const docId = scheduleDocId(schedule);
    await updateDoc(doc(db, SCHEDULES_COLLECTION, docId), {
        status: "archived",
        exportedAt: serverTimestamp(),
        updatedAt: new Date()
    });
}

async function deleteScheduleFromFirestore(docId) {
    try {
        await deleteDoc(doc(db, SCHEDULES_COLLECTION, docId));
        
    } catch (error) {
        console.error("Could not delete schedule from Firestore:", error);
        throw error;
    }
}

function parseTime(value) {
    if (!value) return 0;
    const str = String(value).trim().toUpperCase();
    const isPM = str.includes("PM");
    const isAM = str.includes("AM");
    const cleanStr = str.replace(/[^\d:]/g, "");
    const parts = cleanStr.split(":").map(Number);
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;

    if (isPM && hour < 12) {
        hour += 12;
    } else if (isAM && hour === 12) {
        hour = 0;
    } else if (!isAM && !isPM) {
        // School operating hours: 7:00 AM to 6:30 PM.
        // Hours 1 to 6 are PM (13:00 to 18:00).
        if (hour >= 1 && hour <= 6) {
            hour += 12;
        }
    }
    return hour * 60 + minute;
}

function parseTimeRange(slotStr) {
    if (!slotStr || !slotStr.includes("-")) return null;
    const parts = slotStr.split("-");
    if (parts.length !== 2) return null;
    const firstStart = parseTime(parts[0]);
    const firstEnd = parseTime(parts[1]);
    if (firstStart >= firstEnd) return null;
    return { start: firstStart, end: firstEnd };
}

function timesOverlap(firstTime, secondTime) {
    if (!firstTime || !secondTime) return false;
    const range1 = parseTimeRange(firstTime);
    const range2 = parseTimeRange(secondTime);
    if (!range1 || !range2) return false;

    return range1.start < range2.end && range2.start < range1.end;
}

/**
 * Vacant-gap restriction REMOVED.
 * Gaps between classes no longer disqualify a slot - only real conflicts
 * (section time overlaps and room double-bookings) block placement. This
 * prevents the solver from failing when many sections compete for slots.
 */
function isVacantGapAcceptable(existingDayEntries, candidateTime) {
    return true;
}

/**
 * Calculates a compactness penalty for ranking candidate slots.
 * Prefers back-to-back (0 penalty) and smaller vacant gaps over larger gaps.
 */
function calculateDayPlacementVacantPenalty(existingDayEntries, candidateTime) {
    if (!existingDayEntries || existingDayEntries.length === 0) return 0;
    const candidateRange = parseTimeRange(candidateTime);
    if (!candidateRange) return 0;

    let minGap = Infinity;
    for (const item of existingDayEntries) {
        const r = typeof item === "string" ? parseTimeRange(item) : parseTimeRange(item.time);
        if (!r) continue;

        if (candidateRange.start >= r.end) {
            let gap = candidateRange.start - r.end;
            if (r.end <= 720 && candidateRange.start >= 780) gap = Math.max(0, gap - 60);
            else if (r.end <= 750 && candidateRange.start >= 780) gap = Math.max(0, gap - 30);
            if (gap < minGap) minGap = gap;
        } else if (r.start >= candidateRange.end) {
            let gap = r.start - candidateRange.end;
            if (candidateRange.end <= 720 && r.start >= 780) gap = Math.max(0, gap - 60);
            else if (candidateRange.end <= 750 && r.start >= 780) gap = Math.max(0, gap - 30);
            if (gap < minGap) minGap = gap;
        }
    }

    return minGap === Infinity ? 0 : minGap;
}

/* Fisher-Yates shuffle - returns a new shuffled array */
function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

const DAY_PAIRS = [
    ["Monday", "Thursday"],
    ["Tuesday", "Friday"],
    ["Monday", "Wednesday"],
    ["Wednesday", "Friday"],
    ["Tuesday", "Thursday"],
    ["Monday", "Friday"]
];

function normalizeRoomType(roomType) {
    const type = String(roomType || "").trim();

    // Gym
    if (type.toLowerCase().includes("gym")) {
        return "Gymnasium";
    }

    // General laboratory
    if (type === "Laboratory") return "Laboratory";

    // Major laboratories
    if (type === "MT Laboratory") return "MT Laboratory";
    if (type === "AT Laboratory") return "AT Laboratory";
    if (type === "CP Laboratory") return "CP Laboratory";
    if (type === "CT Laboratory") return "CT Laboratory";
    if (type === "ELT Laboratory") return "ELT Laboratory";
    if (type === "ELX Laboratory") return "ELX Laboratory";
    if (type === "FSM Laboratory") return "FSM Laboratory";
    if (type === "CPT Laboratory") return "CPT Laboratory";

    return "Lecture Room";
}

function isLabRoomType(roomType) {
    const labTypes = [
        "Laboratory",
        "MT Laboratory", "AT Laboratory", "CP Laboratory",
        "CT Laboratory", "ELT Laboratory", "ELX Laboratory",
        "FSM Laboratory", "CPT Laboratory"
    ];
    return labTypes.includes(roomType);
}

function getBuildingPriority(building, prog) {
    if (prog === "BIT" || prog === "BINDTECH") {
        if (building === "Building B") return 0;
        if (building === "Admin Building") return 1;
        return 2;
    }
    if (prog === "BTVTED") {
        if (building === "Building A") return 0;
        if (building === "Admin Building") return 1;
        return 2;
    }
    return 0;
}

function scheduleRows(entries) {
    return entries.map(item => `
        <tr>
            <td>${escapeHtml(item.code)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.units)}</td>
            <td>${escapeHtml(item.day)}</td>
            <td>${escapeHtml(item.time)}</td>
            <td>${escapeHtml(item.room)}</td>
        </tr>
    `).join("");
}

function getSavedBookings(academicYear, semester) {
    return getSavedSchedules().flatMap(schedule => {
        /* ROOM AVAILABILITY SCOPING:
           Only ACTIVE schedules in the SAME Academic Year AND SAME Semester
           reserve rooms.  Archived schedules and schedules from other
           academic years or other semesters must NOT block room availability. */
        if ((schedule.status || "active") === "archived") return [];
        if (academicYear && schedule.academicYear !== academicYear) return [];
        if (semester && schedule.semester !== semester) return [];

        if (schedule.rawEntries?.length) {
            /* Tag each booking with its source section so the conflict
               validator can ignore a section's OWN previous schedule when
               that section is being regenerated. */
            return schedule.rawEntries.map(entry => ({
                ...entry,
                section: schedule.section || ""
            }));
        }

        return (schedule.entries || []).flatMap(entry => {
            const entryDays = String(entry.day || "").split(" / ");
            const entryTimes = String(entry.time || "").split(" / ");
            const entryRooms = String(entry.room || "").split(" / ");

            return entryDays.map((day, index) => ({
                day: day.trim(),
                time: (entryTimes[index] || entryTimes[0] || "").trim(),
                room: (entryRooms[index] || entryRooms[0] || "").trim(),
                roomCode: "",
                section: schedule.section || ""
            }));
        });
    });
}

/* ==================================================
   CLASS SCHEDULE CONFLICT ANALYZER MODULE
   - Section Conflicts
   - Room Conflicts
   - Time Overlaps
   - Strictly scoped to EXACT SAME Academic Year & Semester
   - Checks Saved/Published AND Saved Draft schedules
   - NO Faculty Conflicts checked
================================================== */

/**
 * Calculates the exact overlapping time range string between two time slots.
 * e.g., "7:30-10:00" and "9:00-11:00" -> "9:00-10:00"
 */
function getOverlapTimeRange(time1, time2) {
    const range1 = parseTimeRange(time1);
    const range2 = parseTimeRange(time2);
    if (!range1 || !range2) return null;

    const startOverlap = Math.max(range1.start, range2.start);
    const endOverlap = Math.min(range1.end, range2.end);

    if (startOverlap < endOverlap) {
        const formatMin = mins => {
            let h = Math.floor(mins / 60);
            const m = mins % 60;
            if (h > 12) h -= 12;
            return `${h}:${m < 10 ? '0' : ''}${m}`;
        };
        return `${formatMin(startOverlap)}-${formatMin(endOverlap)}`;
    }
    return null;
}

/**
 * Returns true if the expanded schedule entry is a PATHFit / Activity subject.
 * Detects by subject code pattern (PATHFit01–PATHFit99) since meetingType is
 * not carried through to the expanded entry objects.
 */
function isActivityEntry(entry) {
    if (!entry || !entry.code) return false;
    return /^pathfit/i.test(String(entry.code).trim());
}

/**
 * Maximum number of PATHFit/Activity sections that may simultaneously occupy
 * the Covered Court (or any Gymnasium-type room). ≤ 3 → allowed; ≥ 4 → conflict.
 */
const COVERED_COURT_MAX_SECTIONS = 3;

/**
 * After the pairwise room-conflict scan, sweep all entries to find groups of
 * PATHFit/Activity subjects sharing the same room on the same day where more
 * than COVERED_COURT_MAX_SECTIONS have overlapping time windows.
 *
 * @param {Array}  allEntries    - All discrete expanded entries to inspect.
 * @param {Array}  roomConflicts - Conflict array to push capacity violations into.
 * @param {Set}    seenKeys      - Deduplication set shared with the main scan.
 * @param {string} statusLabel   - "Generated (Internal)" | "Saved" | "Draft"
 * @returns {Array} List of allowed shared Covered Court usages (2 or 3 sections)
 */
function checkCoveredCourtCapacity(allEntries, roomConflicts, seenKeys, statusLabel) {
    const coveredCourtUsage = [];
    const seenUsageKeys = new Set();

    // Group PATHFit entries by (roomName, day)
    const groups = new Map();
    for (const entry of allEntries) {
        if (!isActivityEntry(entry)) continue;
        const roomKey = entry.room.trim();
        const dayKey  = entry.day.trim();
        const mapKey  = `${roomKey}|||${dayKey}`;
        if (!groups.has(mapKey)) groups.set(mapKey, []);
        groups.get(mapKey).push(entry);
    }

    for (const [mapKey, entries] of groups) {
        for (let i = 0; i < entries.length; i++) {
            // Count how many entries overlap with entries[i]'s time
            const overlapping = entries.filter(e =>
                e !== entries[i] && timesOverlap(e.time, entries[i].time)
            );
            const simultaneousCount = overlapping.length + 1; // include entries[i] itself

            if (simultaneousCount > COVERED_COURT_MAX_SECTIONS) {
                const conflictKey = `CC_CAP_${entries[i].day}_${entries[i].room}_${entries[i].time}_${simultaneousCount}`;
                if (!seenKeys.has(conflictKey)) {
                    seenKeys.add(conflictKey);
                    const sectionList = [entries[i], ...overlapping]
                        .map(e => `${e.code} — ${e.section}`)
                        .join("; ");
                    roomConflicts.push({
                        type: "ROOM CAPACITY CONFLICT",
                        room: entries[i].room,
                        day: entries[i].day,
                        overlappingTime: entries[i].time,
                        simultaneousCount,
                        maxAllowed: COVERED_COURT_MAX_SECTIONS,
                        newSchedule: `${entries[i].code} — ${entries[i].section}`,
                        existingSchedule: sectionList,
                        status: statusLabel,
                        description: `${simultaneousCount} sections scheduled simultaneously. Maximum allowed: ${COVERED_COURT_MAX_SECTIONS} sections.`
                    });
                }
            } else if (simultaneousCount >= 2) {
                const usageKey = `${entries[i].room}_${entries[i].day}_${simultaneousCount}`;
                if (!seenUsageKeys.has(usageKey)) {
                    seenUsageKeys.add(usageKey);
                    coveredCourtUsage.push({
                        room: entries[i].room,
                        day: entries[i].day,
                        count: simultaneousCount,
                        max: COVERED_COURT_MAX_SECTIONS
                    });
                }
            }
        }
    }

    return coveredCourtUsage;
}

/**
 * Expands multi-day schedule entries (e.g. "Wednesday / Thursday", "7:30-10:00 / 1:00-3:30")
 * into discrete single-day, single-time, single-room items.
 */
function expandScheduleEntries(schedule) {
    const discrete = [];
    if (!schedule) return discrete;

    const sourceEntries = Array.isArray(schedule.rawEntries) && schedule.rawEntries.length > 0
        ? schedule.rawEntries
        : (schedule.entries || []);

    const scheduleSection = schedule.section || schedule.name || "";
    const scheduleStatus = (schedule.status || "draft").toLowerCase();

    sourceEntries.forEach((entry, entryIdx) => {
        if (!entry) return;
        // Ignore TBA subjects that have no physical room/time
        if (TBA_SUBJECT_CODES.has(entry.code) || entry.room === "TBA") {
            return;
        }

        const days = String(entry.day || "").split("/").map(s => s.trim()).filter(Boolean);
        const times = String(entry.time || "").split("/").map(s => s.trim()).filter(Boolean);
        const rooms = String(entry.room || "").split("/").map(s => s.trim()).filter(Boolean);

        const count = Math.max(days.length, 1);
        for (let i = 0; i < count; i++) {
            const day = days[i] || days[0] || "";
            const time = times[i] || times[0] || "";
            const room = rooms[i] || rooms[0] || "";

            if (day && time) {
                discrete.push({
                    uniqueKey: `${schedule.id || 'curr'}_${entry.code || entryIdx}_${day}_${time}_${i}`,
                    scheduleId: schedule.id || null,
                    scheduleName: schedule.name || scheduleSection,
                    section: entry.section || scheduleSection,
                    status: scheduleStatus === "published" ? "Saved" : (scheduleStatus === "active" ? "Saved" : "Draft"),
                    code: entry.code || "N/A",
                    name: entry.name || "",
                    day,
                    time,
                    room: room || "Unassigned",
                    academicYear: schedule.academicYear || "",
                    semester: schedule.semester || ""
                });
            }
        }
    });

    return discrete;
}

/**
 * Filters schedules strictly by matching the exact same Academic Year and Semester.
 * Completely ignores schedules from different academic years or semesters.
 */
function filterSchedulesByAcademicPeriod(schedules, targetAcademicYear, targetSemester) {
    const targetAY = String(targetAcademicYear || "").trim();
    const targetSem = String(targetSemester || "").trim().toLowerCase();

    return (schedules || []).filter(s => {
        if (!s) return false;
        // Ignore archived schedules
        if (String(s.status || "").toLowerCase() === "archived") return false;

        const sAY = String(s.academicYear || "").trim();
        const sSem = String(s.semester || "").trim().toLowerCase();

        return sAY === targetAY && sSem === targetSem;
    });
}

/**
 * Analyzes the newly generated schedule against itself and against all existing
 * saved/published and draft schedules in the exact same Academic Year & Semester.
 */
function analyzeClassScheduleConflicts(generatedSchedule, existingSchedules) {
    const targetAY = String(generatedSchedule.academicYear || "").trim();
    const targetSem = String(generatedSchedule.semester || "").trim();

    // 1. Filter existing schedules strictly by exact same Academic Year & Semester
    const periodSchedules = filterSchedulesByAcademicPeriod(existingSchedules, targetAY, targetSem);

    // 2. Expand generated schedule into discrete single-day units
    const currentUnits = expandScheduleEntries(generatedSchedule);

    // 3. Expand existing period schedules into discrete single-day units
    // Exclude the current schedule document if it was previously saved to prevent false self-conflict
    const existingUnits = [];
    const currentDocId = generatedSchedule.id || scheduleDocId(generatedSchedule);

    periodSchedules.forEach(sched => {
        const sDocId = sched.id || scheduleDocId(sched);
        if (sDocId === currentDocId) return; // Skip self

        const units = expandScheduleEntries(sched);
        existingUnits.push(...units);
    });

    const sectionConflicts = [];
    const roomConflicts = [];
    let timeOverlapCount = 0;
    const seenConflictKeys = new Set();

    // ------------------------------------------------------------------
    // CHECK 1: Generated schedule against ITSELF
    // ------------------------------------------------------------------
    for (let i = 0; i < currentUnits.length; i++) {
        for (let j = i + 1; j < currentUnits.length; j++) {
            const a = currentUnits[i];
            const b = currentUnits[j];

            // Must be on the exact same day
            if (a.day.toLowerCase() !== b.day.toLowerCase()) continue;

            // Must have actual time overlap
            if (!timesOverlap(a.time, b.time)) continue;

            const overlapTime = getOverlapTimeRange(a.time, b.time) || `${a.time} / ${b.time}`;
            timeOverlapCount++;

            // Check Section Conflict: Same section having two different subjects at the same time
            if (a.section && b.section && a.section.trim().toLowerCase() === b.section.trim().toLowerCase() && a.code !== b.code) {
                const key = `SELF_SEC_${a.day}_${a.section}_${a.code}_${b.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    sectionConflicts.push({
                        type: "SECTION CONFLICT",
                        section: a.section,
                        day: a.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${a.code} (${a.time})`,
                        existingSchedule: `${b.code} (${b.time})`,
                        status: "Generated (Internal)",
                        description: `Section ${a.section} has two overlapping subjects (${a.code} and ${b.code}) on ${a.day}.`
                    });
                }
            }

            // Check Room Conflict: Same room double-booked on same day
            const aRoom = a.room.trim().toLowerCase();
            const bRoom = b.room.trim().toLowerCase();

            // PATHFit/Activity entries sharing the same room use the Covered Court
            // capacity rule (max 3 simultaneous sections) → handled by the post-scan
            // capacity sweep below. Skip pairwise conflict here for activity pairs.
            const aIsActivity = isActivityEntry(a);
            const bIsActivity = isActivityEntry(b);
            const bothActivity = aIsActivity && bIsActivity;

            // Legacy isGym skip (room name contains "gym") is kept as a fallback.
            const isGymByName = aRoom.includes("gym") && bRoom.includes("gym");

            if (!bothActivity && !isGymByName && aRoom && bRoom && aRoom === bRoom) {
                const key = `SELF_ROOM_${a.day}_${a.room}_${a.code}_${b.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    roomConflicts.push({
                        type: "ROOM CONFLICT",
                        room: a.room,
                        day: a.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${a.code} — ${a.section}`,
                        existingSchedule: `${b.code} — ${b.section}`,
                        status: "Generated (Internal)",
                        description: `Room ${a.room} is assigned to both ${a.code} and ${b.code} at overlapping times.`
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // CHECK 2: Generated schedule against EXISTING schedules (Saved & Draft)
    // ------------------------------------------------------------------
    for (const cur of currentUnits) {
        for (const ext of existingUnits) {
            // Must be on the exact same day
            if (cur.day.toLowerCase() !== ext.day.toLowerCase()) continue;

            // Must have actual time overlap
            if (!timesOverlap(cur.time, ext.time)) continue;

            const overlapTime = getOverlapTimeRange(cur.time, ext.time) || `${cur.time} / ${ext.time}`;
            timeOverlapCount++;

            // A. Section Conflict with an existing schedule
            if (cur.section && ext.section && cur.section.trim().toLowerCase() === ext.section.trim().toLowerCase()) {
                const key = `EXT_SEC_${cur.day}_${cur.section}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    sectionConflicts.push({
                        type: "SECTION CONFLICT",
                        section: cur.section,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: ext.status || "Draft",
                        description: `Section ${cur.section} already has ${ext.code} scheduled on ${cur.day} at ${ext.time}.`
                    });
                }
            }

            // B. Room Conflict with an existing schedule
            // PATHFit/Activity pairs → capacity sweep; normal rooms → immediate conflict.
            const curRoom = cur.room.trim().toLowerCase();
            const extRoom = ext.room.trim().toLowerCase();
            const curIsActivity = isActivityEntry(cur);
            const extIsActivity = isActivityEntry(ext);
            const bothActivityExt = curIsActivity && extIsActivity;
            const isGymByNameExt = curRoom.includes("gym") && extRoom.includes("gym");

            if (!bothActivityExt && !isGymByNameExt && curRoom && extRoom && curRoom === extRoom) {
                const key = `EXT_ROOM_${cur.day}_${cur.room}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    roomConflicts.push({
                        type: "ROOM CONFLICT",
                        room: cur.room,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: ext.status || "Draft",
                        description: `Room ${cur.room} is occupied by ${ext.section} (${ext.code}) on ${cur.day} at ${ext.time}.`
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // CHECK 3: Covered Court / PATHFit capacity sweep
    // Checks all activity entries (current + existing) together for
    // simultaneous overcapacity (> COVERED_COURT_MAX_SECTIONS sections).
    // ------------------------------------------------------------------
    const allActivityUnits = [...currentUnits, ...existingUnits];
    const coveredCourtUsage = checkCoveredCourtCapacity(allActivityUnits, roomConflicts, seenConflictKeys, "Saved");

    const totalConflicts = sectionConflicts.length + roomConflicts.length;

    return {
        totalConflicts,
        sectionConflicts,
        roomConflicts,
        timeOverlaps: timeOverlapCount,
        academicYear: targetAY,
        semester: targetSem,
        coveredCourtUsage
    };
}

/**
 * Renders the Conflict Analyzer card into the #scheduleConflicts container
 * and controls the enabled/disabled state of the Publish button.
 */
function renderConflictAnalyzerUI(analysisResult) {
    const container = document.getElementById("scheduleConflicts");
    if (!container) return;

    const {
        totalConflicts,
        sectionConflicts,
        roomConflicts,
        timeOverlaps,
        academicYear,
        semester,
        coveredCourtUsage
    } = analysisResult;

    const ayText = academicYear ? `A.Y. ${escapeHtml(academicYear)} • ` : "";
    const semText = escapeHtml(semester || "");
    const periodDisplay = `${ayText}${semText}`.trim() || "Selected Academic Period";

    const publishBtn = document.getElementById("publishScheduleBtn");

    if (totalConflicts === 0) {
        // CONFLICT-FREE STATE (Success / Green) - Compact layout matching design
        const courtUsageHtml = Array.isArray(coveredCourtUsage) && coveredCourtUsage.length > 0
            ? coveredCourtUsage.map(u => `
                <div class="scanner-check-item completed" style="margin-top: 2px;">
                    <div class="scanner-check-item-left">
                        <span class="scanner-icon completed">✓</span>
                        <span>${escapeHtml(u.room)} (${escapeHtml(u.day)}): ${u.count}/${u.max} sections</span>
                    </div>
                    <span style="font-size: 11px; font-weight: 700; color: #16a34a; background: #dcfce7; padding: 1px 6px; border-radius: 4px;">Allowed</span>
                </div>
            `).join("")
            : "";

        container.innerHTML = `
            <div class="conflict-scanner-panel success-mode">
                <div class="scanner-header">
                    <div class="scanner-header-title">
                        <span style="color:#16a34a;">✓</span>
                        <span>Conflict Analyzer</span>
                    </div>
                    <span class="scanner-badge success">0 Conflicts</span>
                </div>

                <div class="scanner-checklist" style="margin-top: 10px;">
                    <div class="scanner-check-item completed">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon completed">✓</span>
                            <span>Section conflicts</span>
                        </div>
                        <span class="scanner-count-val zero">0</span>
                    </div>
                    <div class="scanner-check-item completed">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon completed">✓</span>
                            <span>Room conflicts</span>
                        </div>
                        <span class="scanner-count-val zero">0</span>
                    </div>
                    <div class="scanner-check-item completed">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon completed">✓</span>
                            <span>Time overlaps</span>
                        </div>
                        <span class="scanner-count-val zero">0</span>
                    </div>
                </div>

                <div class="scanner-checklist" style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #bbf7d0;">
                    <div class="scanner-check-item completed">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon completed">✓</span>
                            <span>Saved schedules checked</span>
                        </div>
                    </div>
                    <div class="scanner-check-item completed">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon completed">✓</span>
                            <span>Draft schedules checked</span>
                        </div>
                    </div>
                    ${courtUsageHtml}
                </div>

                <div class="scanner-summary-box success">
                    ✓ No conflicts detected for<br>
                    <strong>${periodDisplay}</strong>
                </div>
            </div>
        `;

        // Enable Publish button
        if (publishBtn) {
            publishBtn.disabled = false;
            publishBtn.innerHTML = 'Publish Schedule';
            publishBtn.title = "Publish this schedule and notify students";
            publishBtn.style.opacity = "1";
            publishBtn.style.cursor = "pointer";
        }

        // Remove any previous disabled hint
        const existingHint = document.getElementById("publishDisabledHint");
        if (existingHint) existingHint.remove();

    } else {
        // CONFLICT DETECTED STATE (Warning / Red) - Compact layout matching design
        const allConflictCards = [
            ...sectionConflicts.map(c => ({ ...c, kind: "section" })),
            ...roomConflicts.map(c => ({ ...c, kind: "room" }))
        ];

        const cardsHtml = allConflictCards.map(c => {
            const isSec = c.kind === "section";
            const isCap = c.type === "ROOM CAPACITY CONFLICT";
            const typeLabel = isSec
                ? "⚠ SECTION CONFLICT"
                : (isCap ? "⚠ ROOM CAPACITY CONFLICT" : "⚠ ROOM CONFLICT");
            const typeClass = isSec ? "section-type" : "room-type";
            const statusClass = c.status === "Draft"
                ? "conflict-status-draft"
                : (c.status === "Saved" ? "conflict-status-saved" : "conflict-status-internal");

            return `
                <div class="conflict-item-card ${typeClass}">
                    <div class="conflict-item-type ${typeClass}">
                        <span>${typeLabel}</span>
                        <span class="conflict-status-pill ${statusClass}">Status: ${escapeHtml(c.status)}</span>
                    </div>
                    <div class="conflict-item-details">
                        <div>
                            <span class="label">Room:</span>
                            <span class="value">${escapeHtml(c.room || (isSec ? (c.section || "—") : "Covered Court"))}</span>
                        </div>
                        ${isSec ? `
                        <div>
                            <span class="label">Section:</span>
                            <span class="value">${escapeHtml(c.section || "—")}</span>
                        </div>` : ''}
                        <div>
                            <span class="label">Day:</span>
                            <span class="value">${escapeHtml(c.day || "—")}</span>
                        </div>
                        <div>
                            <span class="label">Overlapping Time:</span>
                            <span class="value" style="color:#d32f2f; font-weight:600;">${escapeHtml(c.overlappingTime || "—")}</span>
                        </div>
                        ${isCap ? `
                        <div style="grid-column: span 2;">
                            <span class="label">Capacity Exceeded:</span>
                            <span class="value" style="color:#d32f2f; font-weight:700;">${c.simultaneousCount} sections scheduled simultaneously (Max allowed: ${c.maxAllowed || 3})</span>
                        </div>
                        <div style="grid-column: span 2;">
                            <span class="label">Affected Schedules:</span>
                            <span class="value">${escapeHtml(c.existingSchedule || c.newSchedule || "—")}</span>
                        </div>
                        ` : `
                        <div>
                            <span class="label">New Schedule:</span>
                            <span class="value">${escapeHtml(c.newSchedule || "—")}</span>
                        </div>
                        <div>
                            <span class="label">Existing Schedule:</span>
                            <span class="value">${escapeHtml(c.existingSchedule || "—")}</span>
                        </div>
                        `}
                    </div>
                </div>
            `;
        }).join("");

        container.innerHTML = `
            <div class="conflict-scanner-panel warning-mode">
                <div class="scanner-header">
                    <div class="scanner-header-title">
                        <span style="color:#dc2626;">⚠</span>
                        <span>Conflict Analyzer</span>
                    </div>
                    <span class="scanner-badge warning">${totalConflicts} ${totalConflicts === 1 ? 'Conflict' : 'Conflicts'}</span>
                </div>

                <div class="scanner-checklist" style="margin-top: 10px;">
                    <div class="scanner-check-item ${sectionConflicts.length > 0 ? 'conflict' : 'completed'}">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon ${sectionConflicts.length > 0 ? 'conflict' : 'completed'}">${sectionConflicts.length > 0 ? '⚠' : '✓'}</span>
                            <span>Section Conflicts</span>
                        </div>
                        <span class="scanner-count-val ${sectionConflicts.length > 0 ? 'nonzero' : 'zero'}">${sectionConflicts.length}</span>
                    </div>
                    <div class="scanner-check-item ${roomConflicts.length > 0 ? 'conflict' : 'completed'}">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon ${roomConflicts.length > 0 ? 'conflict' : 'completed'}">${roomConflicts.length > 0 ? '⚠' : '✓'}</span>
                            <span>Room Conflicts</span>
                        </div>
                        <span class="scanner-count-val ${roomConflicts.length > 0 ? 'nonzero' : 'zero'}">${roomConflicts.length}</span>
                    </div>
                    <div class="scanner-check-item ${timeOverlaps > 0 ? 'conflict' : 'completed'}">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon ${timeOverlaps > 0 ? 'conflict' : 'completed'}">${timeOverlaps > 0 ? '⚠' : '✓'}</span>
                            <span>Time Overlaps</span>
                        </div>
                        <span class="scanner-count-val ${timeOverlaps > 0 ? 'nonzero' : 'zero'}">${timeOverlaps}</span>
                    </div>
                </div>

                <div class="scanner-summary-box warning">
                    ⚠ Conflicts detected for <strong>${periodDisplay}</strong>.<br>
                    Please review the conflicts before publishing.
                </div>

                <div class="scanner-conflicts-list">
                    ${cardsHtml}
                </div>
            </div>
            <div id="publishDisabledHint" class="publish-disabled-hint">
                <span>⚠ Cannot publish while schedule conflicts exist.</span>
            </div>
        `;

        // Disable Publish button
        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.innerHTML = 'Publish Schedule — Disabled';
            publishBtn.title = "Cannot publish while schedule conflicts exist.";
            publishBtn.style.opacity = "0.55";
            publishBtn.style.cursor = "not-allowed";
        }
    }
}

/**
 * Runs the live scanning animation with genuine progressive validation stages,
 * smoothly transitioning to the final Conflict Analyzer results.
 */
async function runConflictScanningProcess(generatedSchedule, existingSchedules) {
    const container = document.getElementById("scheduleConflicts");
    const publishBtn = document.getElementById("publishScheduleBtn");

    if (publishBtn) {
        publishBtn.disabled = true;
        publishBtn.innerHTML = '<span class="scanner-icon active">⟳</span> Publish Schedule — Checking...';
        publishBtn.style.opacity = "0.7";
        publishBtn.style.cursor = "wait";
    }

    const targetAY = String(generatedSchedule.academicYear || "").trim();
    const targetSem = String(generatedSchedule.semester || "").trim();
    const periodDisplay = `${targetAY ? `A.Y. ${escapeHtml(targetAY)} • ` : ""}${escapeHtml(targetSem)}`.trim() || "Selected Academic Period";

    // 1. Render initial compact scanning panel matching the exact ASCII mock
    if (container) {
        container.innerHTML = `
            <div class="conflict-scanner-panel scanning-mode">
                <div class="scanner-header">
                    <div class="scanner-header-title">
                        <span>🔍</span>
                        <span>Conflict Analyzer</span>
                    </div>
                    <span class="scanner-badge scanning">Scanning</span>
                </div>

                <div class="scanner-scanning-subtext">
                    Scanning Generated Schedule...
                </div>
                <div class="scanner-period-text">
                    ${periodDisplay}
                </div>

                <div class="scanner-checklist">
                    <div id="scanStep1" class="scanner-check-item active">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon active">⟳</span>
                            <span>Section conflicts</span>
                        </div>
                    </div>
                    <div id="scanStep2" class="scanner-check-item pending">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon pending">○</span>
                            <span>Room conflicts</span>
                        </div>
                    </div>
                    <div id="scanStep3" class="scanner-check-item pending">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon pending">○</span>
                            <span>Time overlaps</span>
                        </div>
                    </div>
                    <div id="scanStep4" class="scanner-check-item pending">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon pending">○</span>
                            <span>Saved schedules</span>
                        </div>
                    </div>
                    <div id="scanStep5" class="scanner-check-item pending">
                        <div class="scanner-check-item-left">
                            <span class="scanner-icon pending">○</span>
                            <span>Saved drafts</span>
                        </div>
                    </div>
                </div>

                <div class="scanner-progress-container">
                    <div id="scanProgressBar" class="scanner-progress-fill" style="width: 15%;"></div>
                </div>
            </div>
        `;
    }

    const updateStep = (stepNum, status) => {
        const el = document.getElementById(`scanStep${stepNum}`);
        if (!el) return;
        el.className = `scanner-check-item ${status}`;
        const iconEl = el.querySelector(".scanner-icon");
        if (iconEl) {
            iconEl.className = `scanner-icon ${status}`;
            if (status === "completed") {
                iconEl.innerHTML = "✓";
            } else if (status === "active") {
                iconEl.innerHTML = "⟳";
            } else {
                iconEl.innerHTML = "○";
            }
        }
    };

    const setProgress = percent => {
        const bar = document.getElementById("scanProgressBar");
        if (bar) bar.style.width = `${percent}%`;
    };

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    // STAGE 1: Checking Section conflicts in the generated schedule
    await delay(130);
    const currentUnits = expandScheduleEntries(generatedSchedule);
    const internalSectionConflicts = [];
    const internalRoomConflicts = [];
    let timeOverlapCount = 0;
    const seenConflictKeys = new Set();

    for (let i = 0; i < currentUnits.length; i++) {
        for (let j = i + 1; j < currentUnits.length; j++) {
            const a = currentUnits[i];
            const b = currentUnits[j];
            if (a.day.toLowerCase() !== b.day.toLowerCase()) continue;
            if (!timesOverlap(a.time, b.time)) continue;

            const overlapTime = getOverlapTimeRange(a.time, b.time) || `${a.time} / ${b.time}`;
            timeOverlapCount++;

            if (a.section && b.section && a.section.trim().toLowerCase() === b.section.trim().toLowerCase() && a.code !== b.code) {
                const key = `SELF_SEC_${a.day}_${a.section}_${a.code}_${b.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    internalSectionConflicts.push({
                        type: "SECTION CONFLICT",
                        section: a.section,
                        day: a.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${a.code} (${a.time})`,
                        existingSchedule: `${b.code} (${b.time})`,
                        status: "Generated (Internal)",
                        description: `Section ${a.section} has two overlapping subjects (${a.code} and ${b.code}) on ${a.day}.`
                    });
                }
            }
        }
    }
    updateStep(1, "completed");
    updateStep(2, "active");
    setProgress(35);

    // STAGE 2: Checking Room conflicts in the generated schedule
    await delay(140);
    for (let i = 0; i < currentUnits.length; i++) {
        for (let j = i + 1; j < currentUnits.length; j++) {
            const a = currentUnits[i];
            const b = currentUnits[j];
            if (a.day.toLowerCase() !== b.day.toLowerCase()) continue;
            if (!timesOverlap(a.time, b.time)) continue;

            const aRoom = a.room.trim().toLowerCase();
            const bRoom = b.room.trim().toLowerCase();

            // PATHFit/Activity pairs sharing the same room → capacity sweep (not pairwise conflict).
            const aIsActivity = isActivityEntry(a);
            const bIsActivity = isActivityEntry(b);
            const bothActivity = aIsActivity && bIsActivity;
            const isGymByName = aRoom.includes("gym") && bRoom.includes("gym");

            if (!bothActivity && !isGymByName && aRoom && bRoom && aRoom === bRoom) {
                const overlapTime = getOverlapTimeRange(a.time, b.time) || `${a.time} / ${b.time}`;
                const key = `SELF_ROOM_${a.day}_${a.room}_${a.code}_${b.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    internalRoomConflicts.push({
                        type: "ROOM CONFLICT",
                        room: a.room,
                        day: a.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${a.code} — ${a.section}`,
                        existingSchedule: `${b.code} — ${b.section}`,
                        status: "Generated (Internal)",
                        description: `Room ${a.room} is assigned to both ${a.code} and ${b.code} at overlapping times.`
                    });
                }
            }
        }
    }
    updateStep(2, "completed");
    updateStep(3, "active");
    setProgress(55);

    // STAGE 3: Checking Time overlaps
    await delay(130);
    updateStep(3, "completed");
    updateStep(4, "active");
    setProgress(75);

    // STAGE 4: Checking Saved / Published schedules in the exact same A.Y. + Semester
    await delay(150);
    const periodSchedules = filterSchedulesByAcademicPeriod(existingSchedules, targetAY, targetSem);
    const currentDocId = generatedSchedule.id || scheduleDocId(generatedSchedule);

    const externalSavedUnits = [];
    const externalDraftUnits = [];

    periodSchedules.forEach(sched => {
        const sDocId = sched.id || scheduleDocId(sched);
        if (sDocId === currentDocId) return;

        const units = expandScheduleEntries(sched);
        const schedStatus = (sched.status || "draft").toLowerCase();
        if (schedStatus === "published" || schedStatus === "active") {
            externalSavedUnits.push(...units);
        } else {
            externalDraftUnits.push(...units);
        }
    });

    const externalSectionConflicts = [];
    const externalRoomConflicts = [];

    for (const cur of currentUnits) {
        for (const ext of externalSavedUnits) {
            if (cur.day.toLowerCase() !== ext.day.toLowerCase()) continue;
            if (!timesOverlap(cur.time, ext.time)) continue;

            const overlapTime = getOverlapTimeRange(cur.time, ext.time) || `${cur.time} / ${ext.time}`;
            timeOverlapCount++;

            if (cur.section && ext.section && cur.section.trim().toLowerCase() === ext.section.trim().toLowerCase()) {
                const key = `EXT_SEC_${cur.day}_${cur.section}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    externalSectionConflicts.push({
                        type: "SECTION CONFLICT",
                        section: cur.section,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: "Saved",
                        description: `Section ${cur.section} already has ${ext.code} scheduled on ${cur.day} at ${ext.time}.`
                    });
                }
            }

            // PATHFit/Activity pairs → capacity sweep; normal rooms → immediate conflict.
            const curRoom = cur.room.trim().toLowerCase();
            const extRoom = ext.room.trim().toLowerCase();
            const curIsActivity = isActivityEntry(cur);
            const extIsActivity = isActivityEntry(ext);
            const bothActivityExt = curIsActivity && extIsActivity;
            const isGymByNameExt = curRoom.includes("gym") && extRoom.includes("gym");

            if (!bothActivityExt && !isGymByNameExt && curRoom && extRoom && curRoom === extRoom) {
                const key = `EXT_ROOM_${cur.day}_${cur.room}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    externalRoomConflicts.push({
                        type: "ROOM CONFLICT",
                        room: cur.room,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: "Saved",
                        description: `Room ${cur.room} is occupied by ${ext.section} (${ext.code}) on ${cur.day} at ${ext.time}.`
                    });
                }
            }
        }
    }
    updateStep(4, "completed");
    updateStep(5, "active");
    setProgress(90);

    // STAGE 5: Checking Saved Drafts in the exact same A.Y. + Semester
    await delay(140);
    for (const cur of currentUnits) {
        for (const ext of externalDraftUnits) {
            if (cur.day.toLowerCase() !== ext.day.toLowerCase()) continue;
            if (!timesOverlap(cur.time, ext.time)) continue;

            const overlapTime = getOverlapTimeRange(cur.time, ext.time) || `${cur.time} / ${ext.time}`;
            timeOverlapCount++;

            if (cur.section && ext.section && cur.section.trim().toLowerCase() === ext.section.trim().toLowerCase()) {
                const key = `EXT_SEC_${cur.day}_${cur.section}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    externalSectionConflicts.push({
                        type: "SECTION CONFLICT",
                        section: cur.section,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: "Draft",
                        description: `Section ${cur.section} already has ${ext.code} scheduled on ${cur.day} at ${ext.time}.`
                    });
                }
            }

            // PATHFit/Activity pairs → capacity sweep; normal rooms → immediate conflict.
            const curRoomD = cur.room.trim().toLowerCase();
            const extRoomD = ext.room.trim().toLowerCase();
            const curIsActivityD = isActivityEntry(cur);
            const extIsActivityD = isActivityEntry(ext);
            const bothActivityDraft = curIsActivityD && extIsActivityD;
            const isGymByNameDraft = curRoomD.includes("gym") && extRoomD.includes("gym");

            if (!bothActivityDraft && !isGymByNameDraft && curRoomD && extRoomD && curRoomD === extRoomD) {
                const key = `EXT_ROOM_${cur.day}_${cur.room}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    externalRoomConflicts.push({
                        type: "ROOM CONFLICT",
                        room: cur.room,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: "Draft",
                        description: `Room ${cur.room} is occupied by ${ext.section} (${ext.code}) on ${cur.day} at ${ext.time}.`
                    });
                }
            }
        }
    }
    updateStep(5, "completed");
    setProgress(100);
    await delay(160); // brief settling pause before transition

    // Covered Court / PATHFit capacity sweep across all units (current + external).
    const allActivityUnitsForScan = [...currentUnits, ...externalSavedUnits, ...externalDraftUnits];
    const coveredCourtUsage = checkCoveredCourtCapacity(allActivityUnitsForScan, externalRoomConflicts, seenConflictKeys, "Saved");

    const allSectionConflicts = [...internalSectionConflicts, ...externalSectionConflicts];
    const allRoomConflicts = [...internalRoomConflicts, ...externalRoomConflicts];
    const totalConflicts = allSectionConflicts.length + allRoomConflicts.length;

    const analysisResult = {
        totalConflicts,
        sectionConflicts: allSectionConflicts,
        roomConflicts: allRoomConflicts,
        timeOverlaps: timeOverlapCount,
        academicYear: targetAY,
        semester: targetSem,
        coveredCourtUsage,
        savedCheckedCount: externalSavedUnits.length,
        draftCheckedCount: externalDraftUnits.length
    };

    // Render final results smoothly into the compact panel
    renderConflictAnalyzerUI(analysisResult);
    return analysisResult;
}

programSelect.addEventListener("change", () => {
    majorSelect.innerHTML = `<option value="">Select Major</option>`;

    if (programSelect.value === "BIT" || programSelect.value === "BINDTECH") {
        majorSelect.innerHTML += `<option value="CPT">CPT</option>`;
    }

    if (programSelect.value === "BTVTED") {
        majorSelect.innerHTML += `
            <option value="AT">AT</option>
            <option value="MT">MT</option>
            <option value="CP">CP</option>
            <option value="FSM">FSM</option>
            <option value="CT">CT</option>
            <option value="ELT">ELT</option>
            <option value="ELX">ELX</option>
        `;
    }

    sectionSelect.innerHTML = `<option value="">Select Section</option>`;
});

majorSelect.addEventListener("change", loadSections);
yearLevelSelect.addEventListener("change", loadSections);

async function loadSections() {
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);

    if (!programCode || !majorCode || !yearLevel) {
        sectionSelect.innerHTML = `
            <option value="">Select Program, Major, and Year Level first</option>
        `;
        return;
    }

    sectionSelect.innerHTML = `<option value="">Loading sections...</option>`;

    try {
        const sectionQuery = query(
            collection(db, "sections"),
            where("programCode", "==", programCode),
            where("majorCode", "==", majorCode),
            where("yearLevel", "==", yearLevel)
        );

        const snapshot = await getDocs(sectionQuery);

        sectionSelect.innerHTML = `<option value="">Select Section</option>`;

        if (snapshot.empty) {
            sectionSelect.innerHTML += `
                <option value="" disabled>No sections found</option>
            `;
            return;
        }

        snapshot.forEach(doc => {
            const section = doc.data();

            sectionSelect.innerHTML += `
                <option value="${escapeHtml(section.sectionCode)}">
                    ${escapeHtml(section.sectionCode)}
                </option>
            `;
        });
    } catch (error) {
        console.error(error);
        showToast(`Could not load sections: ${error.message}`);
    }
} 

// Section add UI handlers (box-style modal version)
const addSectionBtn = document.getElementById("addSectionBtn");
const addSectionModal = document.getElementById("addSectionModal");
const newSectionInput = document.getElementById("newSectionInput");
const saveNewSectionBtn = document.getElementById("saveNewSectionBtn");
const cancelNewSectionBtn = document.getElementById("cancelNewSectionBtn");
const closeAddSectionModalBtn = document.getElementById("closeAddSectionModalBtn");

function openAddSectionModal() {
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);

    if (!programCode || !majorCode || !yearLevel) {
        showToast("Please select Program, Major, and Year Level first before adding a section.");
        return;
    }

    if (newSectionInput) {
        newSectionInput.value = "";
    }
    if (addSectionModal) {
        addSectionModal.style.display = "flex";
        setTimeout(() => {
            if (newSectionInput) newSectionInput.focus();
        }, 50);
    }
}

function closeAddSectionModal() {
    if (addSectionModal) {
        addSectionModal.style.display = "none";
    }
    if (newSectionInput) {
        newSectionInput.value = "";
    }
}

if (addSectionBtn) {
    addSectionBtn.addEventListener("click", openAddSectionModal);
}

if (cancelNewSectionBtn) {
    cancelNewSectionBtn.addEventListener("click", closeAddSectionModal);
}

if (closeAddSectionModalBtn) {
    closeAddSectionModalBtn.addEventListener("click", closeAddSectionModal);
}

if (addSectionModal) {
    addSectionModal.addEventListener("click", (e) => {
        if (e.target === addSectionModal) {
            closeAddSectionModal();
        }
    });
}

if (newSectionInput) {
    // Intercept or remove underscores in real-time, allowing hyphens (-)
    newSectionInput.addEventListener("input", () => {
        if (newSectionInput.value.includes("_")) {
            newSectionInput.value = newSectionInput.value.replace(/_/g, "");
            showToast("Underscores (_) are not allowed. Please use hyphens (-) instead.");
        }
    });

    newSectionInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (saveNewSectionBtn) saveNewSectionBtn.click();
        } else if (e.key === "Escape") {
            closeAddSectionModal();
        }
    });
}

if (saveNewSectionBtn) {
    saveNewSectionBtn.addEventListener("click", async () => {
        const newCode = newSectionInput.value.trim();
        if (!newCode) {
            showToast("Section code cannot be empty.");
            return;
        }

        if (newCode.includes("_")) {
            showToast("Underscores (_) are not allowed. Please use hyphens (-) instead.");
            return;
        }

        // Validate format: allow letters, numbers, spaces, and hyphens (-)
        if (!/^[A-Za-z0-9\s-]+$/.test(newCode)) {
            showToast("Section code must contain only letters, numbers, spaces, and hyphens (-).");
            return;
        }

        const programCode = programSelect.value;
        const majorCode = majorSelect.value;
        const yearLevel = Number(yearLevelSelect.value);
        if (!programCode || !majorCode || !yearLevel) {
            showToast("Select Program, Major, and Year Level before adding a section.");
            return;
        }

        // Check for duplicate section code (case-insensitive)
        const exists = Array.from(sectionSelect.options).some(
            opt => opt.value && opt.value.trim().toLowerCase() === newCode.toLowerCase()
        );
        if (exists) {
            showToast("Section already exists.");
            return;
        }

        try {
            saveNewSectionBtn.disabled = true;
            saveNewSectionBtn.textContent = "Saving...";

            const docRef = doc(collection(db, "sections"), newCode);
            await setDoc(docRef, {
                sectionCode: newCode,
                programCode,
                majorCode,
                yearLevel,
                createdAt: serverTimestamp()
            });

            // Remove empty/disabled placeholder options if present
            const disabledOpt = sectionSelect.querySelector('option[disabled]');
            if (disabledOpt) {
                disabledOpt.remove();
            }

            const option = document.createElement("option");
            option.value = newCode;
            option.textContent = newCode;
            sectionSelect.appendChild(option);
            sectionSelect.value = newCode;

            showToast("Section added successfully.");
            closeAddSectionModal();
        } catch (e) {
            console.error(e);
            showToast(`Failed to add section: ${e.message}`);
        } finally {
            saveNewSectionBtn.disabled = false;
            saveNewSectionBtn.textContent = "Save";
        }
    });
}



document.getElementById("loadSubjectsBtn").addEventListener("click", loadSubjects);

async function loadSubjects() {
    const semester = Number(semesterSelect.value);
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);

    subjectBody.innerHTML = "";

    if (!semester || !programCode || !majorCode || !yearLevel) {
        showToast("Please complete all filters.");
        return;
    }

    try {
        const subjectQuery = query(
            collection(db, "prospectus"),
            where("programCode", "==", programCode),
            where("majorCode", "==", majorCode),
            where("yearLevel", "==", yearLevel),
            where("semester", "==", semester)
        );

        const snapshot = await getDocs(subjectQuery);

        if (snapshot.empty) {
            subjectBody.innerHTML = `
                <tr>
                    <td colspan="5">No subjects found.</td>
                </tr>
            `;
            return;
        }

        snapshot.forEach(doc => {
            const subject = doc.data();

            subjectBody.innerHTML += `
                <tr
                    data-subject-type="${escapeHtml(subject.subjectType || "")}"
                    data-meeting-type="${escapeHtml(subject.meetingType || "")}"
                    data-required-room-type="${escapeHtml(subject.requiredRoomType || "")}"
                >
                    <td>${escapeHtml(subject.subjectCode)}</td>
                    <td>${escapeHtml(subject.subjectName)}</td>
                    <td>${subject.units}</td>
                    <td>${subject.lecHours}</td>
                    <td>${subject.labHours}</td>
                </tr>
            `;
        });
    } catch (error) {
        console.error(error);
        showToast(`Could not load subjects: ${error.message}`);
    }
}

document.querySelector(".close-modal").addEventListener("click", () => {
    modal.style.display = "none";
});

window.addEventListener("click", event => {
    if (event.target === modal) {
        modal.style.display = "none";
    }
});

document.getElementById("generateBtn").addEventListener("click", generateSchedule);

async function generateSchedule() {
    const section = sectionSelect.value;

    if (!section) {
        showToast("Please select a section.");
        return;
    }

    const subjectRows = [...subjectBody.querySelectorAll("tr")]
        .filter(row => row.querySelectorAll("td").length === 5);

    if (!subjectRows.length) {
        showToast("Please load subjects first.");
        return;
    }

    /* Show the generating overlay and disable the button while the
       scheduling algorithm is running. */
    generatingOverlay.style.display = "flex";
    generateBtn.disabled = true;

    try {
        let rooms;

        try {
            const roomSnapshot = await getDocs(collection(db, "rooms"));
            rooms = roomSnapshot.docs.map(doc => doc.data());
        } catch (error) {
            showToast(`Could not load rooms: ${error.message}`);
            return;
        }

    const timetable = {
        Monday: [],
        Tuesday: [],
        Wednesday: [],
        Thursday: [],
        Friday: []
    };

    const academicYearInput = document.getElementById("academicYear");
    const currentAcademicYear = academicYearInput.value.trim();
    const currentSemester = semesterSelect.options[semesterSelect.selectedIndex].text;
    const savedBookings = getSavedBookings(currentAcademicYear, currentSemester);

    const subjects = subjectRows.map(row => {
        const cells = row.querySelectorAll("td");

        return {
            code: cells[0].textContent.trim(),
            name: cells[1].textContent.trim(),
            units: Number(cells[2].textContent),
            subjectType: row.dataset.subjectType || "",
            meetingType: (row.dataset.meetingType || "").toLowerCase(),
            requiredRoomType: normalizeRoomType(
                row.dataset.requiredRoomType || ""
            )
        };
    }).sort((first, second) => {
        /* Schedule activity/gymnasium subjects FIRST so they secure a
           gymnasium slot before other classes fill the timetable. */
        const firstActivity =
            /activity|gym/.test(first.meetingType) ||
            first.requiredRoomType === "Gymnasium";
        const secondActivity =
            /activity|gym/.test(second.meetingType) ||
            second.requiredRoomType === "Gymnasium";

        if (firstActivity !== secondActivity) {
            return firstActivity ? -1 : 1;
        }

        return second.units - first.units;
    });

    /* RANDOMIZATION: shuffle subject order within each priority group so
       different sections don't all grab the same first room/slot combination.
       This spreads demand across rooms and times when many sections are
       scheduled, greatly reducing cross-section conflicts. */
    const activitySubjects = shuffle(subjects.filter(s =>
        /activity|gym/.test(s.meetingType) || s.requiredRoomType === "Gymnasium"
    ));
    const otherSubjects = shuffle(subjects.filter(s =>
        !(/activity|gym/.test(s.meetingType) || s.requiredRoomType === "Gymnasium")
    ));
    subjects.length = 0;
    subjects.push(...activitySubjects, ...otherSubjects);

    const output = [];

    function roomIsTaken(room, day, time, allowGymSharing = false) {
        const matchingBookings = savedBookings.filter(booking =>
            booking.day === day &&
            booking.section !== section &&
            booking.time &&
            timesOverlap(booking.time, time) &&
            (
                booking.roomCode === room.roomCode ||
                booking.room === room.roomCode ||
                booking.room === room.roomName
            )
        );

        /* The gymnasium is assigned one section per slot by default so each
           section fills a unique Monday-Friday slot first. When no unique
           slot is available, the fallback enables allowGymSharing, which lets
           a SECOND section join the same day/time (never more than two). */
        if (room.roomType === "Gymnasium") {
            return allowGymSharing
                ? matchingBookings.length >= 2
                : matchingBookings.length > 0;
        }

        /* Lecture rooms and laboratories can hold only one course. */
        return matchingBookings.length > 0;
    }

    function selectBestRoom(availableRooms, requiredRoomType, prog) {
        if (!availableRooms || availableRooms.length === 0) return null;
        if (requiredRoomType !== "Lecture Room") {
            return availableRooms[Math.floor(Math.random() * availableRooms.length)];
        }

        /* Group available lecture rooms by building priority */
        const priorityGroups = {};
        for (const r of availableRooms) {
            const p = getBuildingPriority(r.building, prog);
            if (!priorityGroups[p]) priorityGroups[p] = [];
            priorityGroups[p].push(r);
        }

        const bestPriority = Math.min(...Object.keys(priorityGroups).map(Number));
        const bestRooms = priorityGroups[bestPriority] || [];

        if (bestRooms.length > 0) {
            return bestRooms[Math.floor(Math.random() * bestRooms.length)];
        }
        return availableRooms[0];
    }

    /**
     * Finds the best available time slot and room for a single meeting on a given day.
     */
    function findBestMeetingSlotAndRoom(
        day,
        reqRoomType,
        slots,
        timetableInstance,
        prog
    ) {
        /* No forced 7:30 AM start - days may begin at whatever earliest slot
           is actually free, which avoids artificial deadlocks and conflicts
           when the 7:30 AM room is already taken by another section. */
        /* EARLIEST-FIRST + NO VACANT-GAP LOGIC: slots are tried strictly in
           start-time order so each day begins at 7:30 AM whenever a room of
           the required type is free. A later slot is used only when there is
           a room conflict at the earlier time. No vacant-gap penalty. */
        const candidateSlots = slots.filter(time => {
            const range = parseTimeRange(time);
            return Boolean(range);
        }).sort((s1, s2) => {
            const start1 = parseTimeRange(s1)?.start || 0;
            const start2 = parseTimeRange(s2)?.start || 0;
            return start1 - start2;
        });

        for (const time of candidateSlots) {
            // 1. Section conflict check on this day
            const conflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
            if (conflict) continue;

            // 2. Vacant gap check
            if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

            // 3. Room availability check
            /* FALLBACK: if no room of the exact required type is free,
               any non-laboratory, non-gym room in the Admin Building or
               Building B may host a lecture class instead. */
            const availableRooms = rooms.filter(room => {
                const typeMatches =
                    room.roomType === reqRoomType ||
                    (reqRoomType === "Lecture Room" &&
                        !isLabRoomType(room.roomType) &&
                        room.roomType !== "Gymnasium" &&
                        (room.building === "Admin Building" ||
                            room.building === "Building B"));
                if (!typeMatches) return false;
                return (
                    !timetableInstance[day].some(item =>
                        item.roomCode === room.roomCode && timesOverlap(item.time, time)
                    ) &&
                    !roomIsTaken(room, day, time)
                );
            });
            if (availableRooms.length === 0) continue;

            const room = selectBestRoom(availableRooms, reqRoomType, prog);
            if (room) {
                return { time, room };
            }
        }

        return null;
    }

    /**
     * Finds flexible multi-day assignment for two-meeting subjects:
     * - Schedules the two meetings on TWO DISTINCT DAYS across Mon-Fri
     * - Allows independent, non-synchronized time slots to prevent room deadlocks
     * - Balances section load across days and respects vacant gap limits
     */
    function findAvailableTwoMeetingAssignment(
        meetings,
        slots,
        subject,
        timetableInstance
    ) {
        const [reqRoomType1, reqRoomType2] = meetings;
        const prog = programSelect.value;

        /* DAY PAIRING REMOVED: the two meetings may fall on ANY two
           distinct days Monday-Friday. All combinations are generated,
           then shuffled and sorted by section load for balance. */
        const allDayPairs = [];
        for (let i = 0; i < days.length; i++) {
            for (let j = i + 1; j < days.length; j++) {
                allDayPairs.push([days[i], days[j]]);
            }
        }

        // Shuffle first so equal-load pairs are chosen randomly, then sort by load
        const candidateDayPairs = shuffle(allDayPairs).sort((a, b) => {
            const loadA = (timetableInstance[a[0]]?.length || 0) + (timetableInstance[a[1]]?.length || 0);
            const loadB = (timetableInstance[b[0]]?.length || 0) + (timetableInstance[b[1]]?.length || 0);
            if (loadA !== loadB) return loadA - loadB;

            const diffA = Math.abs((timetableInstance[a[0]]?.length || 0) - (timetableInstance[a[1]]?.length || 0));
            const diffB = Math.abs((timetableInstance[b[0]]?.length || 0) - (timetableInstance[b[1]]?.length || 0));
            if (diffA !== diffB) return diffA - diffB;

            return Math.random() - 0.5;
        });

        for (const [day1, day2] of candidateDayPairs) {
            // Meeting 1 on day1
            const m1 = findBestMeetingSlotAndRoom(day1, reqRoomType1, slots, timetableInstance, prog);
            if (!m1) continue;

            // Meeting 2 on day2
            const m2 = findBestMeetingSlotAndRoom(day2, reqRoomType2, slots, timetableInstance, prog);
            if (!m2) continue;

            return {
                day1,
                time1: m1.time,
                room1: m1.room,
                day2,
                time2: m2.time,
                room2: m2.room
            };
        }

        // Try reversing day assignment if room types differ (e.g. Lecture + Laboratory)
        if (reqRoomType1 !== reqRoomType2) {
            for (const [day1, day2] of candidateDayPairs) {
                const m1 = findBestMeetingSlotAndRoom(day2, reqRoomType1, slots, timetableInstance, prog);
                if (!m1) continue;
                const m2 = findBestMeetingSlotAndRoom(day1, reqRoomType2, slots, timetableInstance, prog);
                if (!m2) continue;

                return {
                    day1: day2,
                    time1: m1.time,
                    room1: m1.room,
                    day2: day1,
                    time2: m2.time,
                    room2: m2.room
                };
            }
        }

        return null;
    }

    /**
     * Finds an assignment for single-meeting subjects (Research, Activity/Gymnasium).
     * Respects vacant gap limit and gym constraints.
     * Starts empty days at 7:30 AM (450) or 8:00 AM (480 for activity).
     */
    function findAvailableSingleAssignment(
        requiredRoomType,
        slots,
        subject,
        timetableInstance,
        activityDays
    ) {
        const isActivity = /activity|gym/.test(subject.meetingType) || requiredRoomType === "Gymnasium";
        const prog = programSelect.value;

        /* ACTIVITY SPREAD: activities can go on ANY day Monday-Friday.
           Days are ranked by the section's current load (fewest classes
           first, random tie-break), so each activity lands on a different,
           least-busy day and spreads across the whole week. The activityDays
           set ensures one activity per day per section. */
        const candidateDays = shuffle([...days]).sort((a, b) => {
            const loadA = timetableInstance[a]?.length || 0;
            const loadB = timetableInstance[b]?.length || 0;
            return loadA - loadB;
        });

        for (const day of candidateDays) {
            if (isActivity && activityDays instanceof Set && activityDays.has(day)) continue;

            /* Activity subjects may start at ANY activity slot time
               (8:00 AM, 10:00 AM, 1:00 PM, 3:00 PM) - not forced to 8:00 AM -
               so multiple PATHFit sections can be distributed across the day. */
            const candidateSlots = slots.filter(time => {
                const range = parseTimeRange(time);
                return Boolean(range);
            }).sort((s1, s2) => {
                /* RANDOM TIE-BREAK: spread activity sections across the
                   available gym time slots instead of all taking 8:00 AM.
                   (No vacant-gap penalty for activities.) */
                return Math.random() - 0.5;
            });

            for (const time of candidateSlots) {
                const sectionConflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
                if (sectionConflict) continue;

                if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

                /* Gymnasium sharing: allow a SECOND section to book the same
                   gym day/time (never more than two sections per slot).
                   Sharing is enabled by default for activities on ALL days,
                   Monday-Friday. */
                const availableRooms = rooms.filter(room => {
                    const typeMatches =
                        room.roomType === requiredRoomType ||
                        (!isActivity &&
                            requiredRoomType === "Lecture Room" &&
                            !isLabRoomType(room.roomType) &&
                            room.roomType !== "Gymnasium" &&
                            (room.building === "Admin Building" ||
                                room.building === "Building B"));
                    if (!typeMatches) return false;
                    return (
                        !timetableInstance[day].some(item =>
                            item.roomCode === room.roomCode && timesOverlap(item.time, time)
                        ) &&
                        !roomIsTaken(room, day, time, isActivity)
                    );
                });

                if (availableRooms.length > 0) {
                    const room = selectBestRoom(availableRooms, requiredRoomType, prog);
                    if (room) {
                        return { day, time, room };
                    }
                }
            }
        }

        // Fallback for Gymnasium with sharing enabled if needed
        if (isActivity) {
            for (const day of candidateDays) {
                if (activityDays instanceof Set && activityDays.has(day)) continue;
                const candidateSlots = slots.filter(time => {
                    const range = parseTimeRange(time);
                    return Boolean(range);
                }).sort(() => Math.random() - 0.5);

                for (const time of candidateSlots) {
                    const sectionConflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
                    if (sectionConflict) continue;
                    if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

                    const gym = rooms.find(r => r.roomType === "Gymnasium");
                    if (gym && !roomIsTaken(gym, day, time, true)) {
                        return { day, time, room: gym };
                    }
                }
            }
        }

        /* FINAL GYM FALLBACK: activities may share a gym slot with a second
           section even when saved bookings from other semesters/years exist.
           Only blocks a slot once TWO other sections already occupy it. */
        if (isActivity) {
            const gym = rooms.find(r => r.roomType === "Gymnasium");
            if (gym) {
                for (const day of shuffle([...days])) {
                    if (activityDays instanceof Set && activityDays.has(day)) continue;
                    const candidateSlots = slots.filter(time => {
                        const range = parseTimeRange(time);
                        return Boolean(range);
                    }).sort((s1, s2) => Math.random() - 0.5);

                    for (const time of candidateSlots) {
                        const sectionConflict = timetableInstance[day].some(item =>
                            timesOverlap(item.time, time)
                        );
                        if (sectionConflict) continue;

                        const occupancy = savedBookings.filter(booking =>
                            booking.day === day &&
                            booking.section !== section &&
                            booking.time &&
                            timesOverlap(booking.time, time) &&
                            (
                                booking.roomCode === gym.roomCode ||
                                booking.room === gym.roomCode ||
                                booking.room === gym.roomName
                            )
                        ).length;

                        if (occupancy < 2) {
                            return { day, time, room: gym };
                        }
                    }
                }
            }
        }

        return null;
    }

    let scheduleSuccess = false;
    let finalOutput = [];
    let lastFailureReason = "";
    const MAX_SOLVER_ATTEMPTS = 20;

    for (let attempt = 1; attempt <= MAX_SOLVER_ATTEMPTS; attempt++) {
        const timetableInstance = {
            Monday: [],
            Tuesday: [],
            Wednesday: [],
            Thursday: [],
            Friday: []
        };

        const currentOutput = [];
        const activityDays = new Set();
        let attemptFailed = false;

        for (const subject of subjects) {
            /* TBA subjects are skipped by the solver; they are appended
               after generation with day/time/room set to "TBA". */
            if (TBA_SUBJECT_CODES.has(subject.code)) continue;

            const isActivity =
                /activity|gym/.test(subject.meetingType) ||
                subject.requiredRoomType === "Gymnasium";
            const isLectureLab = /lecture.*lab|lab.*lecture/.test(subject.meetingType);
            const isMajor = subject.subjectType.toLowerCase() === "major";
            const isResearch = /^RES\d/i.test(subject.code);

            const slots = isResearch
                ? majorSlots
                : isActivity
                    ? activitySlots
                    : (isLectureLab || isMajor ? majorSlots : minorSlots);

            const meetings = isResearch
                ? [subject.requiredRoomType]
                : isActivity
                    ? ["Gymnasium"]
                    : isMajor
                        ? ["Lecture Room", subject.requiredRoomType]
                        : isLectureLab
                            ? ["Lecture Room", subject.requiredRoomType]
                            : isLabRoomType(subject.requiredRoomType)
                                ? ["Lecture Room", subject.requiredRoomType]
                                : [subject.requiredRoomType, subject.requiredRoomType];

            if (meetings.length === 2) {
                const result = findAvailableTwoMeetingAssignment(
                    meetings,
                    slots,
                    subject,
                    timetableInstance
                );

                if (!result) {
                    lastFailureReason = `No available day/time slot found for ${subject.code} (${subject.name}).`;
                    attemptFailed = true;
                    break;
                }

                timetableInstance[result.day1].push({
                    time: result.time1,
                    roomCode: result.room1.roomCode
                });
                timetableInstance[result.day2].push({
                    time: result.time2,
                    roomCode: result.room2.roomCode
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day1,
                    time: result.time1,
                    room: result.room1.roomName || result.room1.roomCode,
                    roomCode: result.room1.roomCode
                });
                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day2,
                    time: result.time2,
                    room: result.room2.roomName || result.room2.roomCode,
                    roomCode: result.room2.roomCode
                });
            } else {
                const reqRoomType = meetings[0];
                const result = findAvailableSingleAssignment(
                    reqRoomType,
                    slots,
                    subject,
                    timetableInstance,
                    activityDays
                );

                if (!result) {
                    lastFailureReason = `No available day/time slot found for ${subject.code} (${subject.name}).`;
                    attemptFailed = true;
                    break;
                }

                if (isActivity) {
                    activityDays.add(result.day);
                }

                timetableInstance[result.day].push({
                    time: result.time,
                    roomCode: result.room.roomCode
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day,
                    time: result.time,
                    room: result.room.roomName || result.room.roomCode,
                    roomCode: result.room.roomCode
                });
            }
        }

        // Final validation: verify there are NO real conflicts in the schedule.
        // Checks section time overlaps and room double-bookings per day.
        if (!attemptFailed && currentOutput.length > 0) {
            for (const day of days) {
                const dayEntries = currentOutput.filter(o => o.day === day);

                // 1. Section conflict check: this section can't be in two classes at once
                for (let i = 0; i < dayEntries.length; i++) {
                    for (let j = i + 1; j < dayEntries.length; j++) {
                        if (timesOverlap(dayEntries[i].time, dayEntries[j].time)) {
                            attemptFailed = true;
                            lastFailureReason =
                                `Section conflict on ${day}: ${dayEntries[i].code} overlaps ${dayEntries[j].code}.`;
                            break;
                        }
                    }
                    if (attemptFailed) break;
                }
                if (attemptFailed) break;

                // 2. Room double-booking check: same room can't host two overlapping classes
                for (let i = 0; i < dayEntries.length; i++) {
                    for (let j = i + 1; j < dayEntries.length; j++) {
                        const sameRoom = dayEntries[i].roomCode === dayEntries[j].roomCode;
                        if (sameRoom && timesOverlap(dayEntries[i].time, dayEntries[j].time)) {
                            attemptFailed = true;
                            lastFailureReason =
                                `Room conflict on ${day}: ${dayEntries[i].roomCode} is double-booked ` +
                                `(${dayEntries[i].code} / ${dayEntries[j].code}).`;
                            break;
                        }
                    }
                    if (attemptFailed) break;
                }
                if (attemptFailed) break;

                // 3. Cross-section room check against OTHER sections' bookings
                //    (a section's own previous schedule is ignored so it can
                //    be regenerated without self-conflicts)
                //    GYM CAPACITY RULE: The Gymnasium holds up to TWO sections
                //    per time slot Monday-Friday. Valid 2-section sharing is
                //    NOT counted as a room conflict. A THIRD section on the
                //    same day/time IS flagged as a conflict.
                const gymRoomCodes = new Set(
                    rooms.filter(r => r.roomType === "Gymnasium").map(r => r.roomCode)
                );
                for (const entry of dayEntries) {
                    /* Gym capacity check instead of a hard single-booking rule */
                    if (gymRoomCodes.has(entry.roomCode)) {
                        const otherGymBookings = savedBookings.filter(booking =>
                            booking.day === day &&
                            booking.section !== section &&
                            (
                                booking.roomCode === entry.roomCode ||
                                booking.room === entry.roomCode ||
                                booking.room === entry.room
                            ) &&
                            timesOverlap(booking.time, entry.time)
                        );

                        /* Count distinct OTHER sections occupying this slot */
                        const distinctSections = new Set(
                            otherGymBookings.map(b => b.section || "")
                        );

                        if (distinctSections.size >= 2) {
                            attemptFailed = true;
                            lastFailureReason =
                                `Gymnasium capacity exceeded on ${day} at ${entry.time}: ` +
                                `already used by 2 sections (${entry.code}).`;
                            break;
                        }
                        continue;
                    }

                    const clash = savedBookings.some(booking =>
                        booking.day === day &&
                        booking.section !== section &&
                        (
                            booking.roomCode === entry.roomCode ||
                            booking.room === entry.roomCode ||
                            booking.room === entry.room
                        ) &&
                        timesOverlap(booking.time, entry.time)
                    );
                    if (clash) {
                        attemptFailed = true;
                        lastFailureReason =
                            `Room ${entry.room} on ${day} at ${entry.time} is already booked by another section.`;
                        break;
                    }
                }
                if (attemptFailed) break;
            }
        }

        if (!attemptFailed && currentOutput.length > 0) {
            scheduleSuccess = true;
            finalOutput = currentOutput;
            break;
        }
    }

    if (!scheduleSuccess) {
        showToast(lastFailureReason || "Could not generate a complete schedule without conflicts.");
        return;
    }

    /* Append TBA subjects with no room/day/time assignment */
    for (const subject of subjects) {
        if (!TBA_SUBJECT_CODES.has(subject.code)) continue;
        finalOutput.push({
            code: subject.code,
            name: subject.name,
            units: subject.units,
            day: "MTWThF",
            time: "7:30am-6:30pm",
            room: "TBA",
            roomCode: ""
        });
    }

    const aggregatedSchedule = [
        ...finalOutput.reduce((map, item) => {
            if (!map.has(item.code)) {
                map.set(item.code, {
                    code: item.code,
                    name: item.name,
                    units: item.units,
                    days: [],
                    times: [],
                    rooms: []
                });
            }

            const entry = map.get(item.code);

            entry.days.push(item.day);
            entry.times.push(item.time);
            entry.rooms.push(item.room);

            return map;
        }, new Map()).values()
    ].map(item => ({
        code: item.code,
        name: item.name,
        units: item.units,
        day: item.days.join(" / "),
        time: item.times.join(" / "),
        room: item.rooms.join(" / ")
    }));

    scheduleBody.innerHTML = scheduleRows(aggregatedSchedule);

    generatedSchedule = {
        id: crypto.randomUUID(),
        name: `${section}`,
        section,
        academicYear: currentAcademicYear,
        semester: currentSemester,
        program: programSelect.value,
        major: majorSelect.value,
        yearLevel: yearLevelSelect.options[yearLevelSelect.selectedIndex].text,
        createdAt: new Date().toISOString(),
        entries: aggregatedSchedule,
        rawEntries: finalOutput
    };

    saveScheduleBtn.disabled = false;

    // 1. Hide the full-page generating overlay so the modal is directly in focus
    generatingOverlay.style.display = "none";
    generateBtn.disabled = false;

    // 2. Open the Generated Schedule modal with the schedule table displayed
    modal.style.display = "block";

    // 3. Load existing schedules from Firestore (or local fallback)
    let existingSchedules = [];
    try {
        existingSchedules = await loadSchedulesFromFirestore();
    } catch (e) {
        console.warn("Could not fetch fresh Firestore schedules for conflict check, falling back to local:", e.message);
        existingSchedules = getSavedSchedules();
    }

    // 4. Run live progressive scanning and conflict analysis inside the modal
    await runConflictScanningProcess(generatedSchedule, existingSchedules);

    } finally {
        generatingOverlay.style.display = "none";
        generateBtn.disabled = false;
    }
}

saveScheduleBtn.addEventListener("click", async () => {
    if (!generatedSchedule || saveScheduleBtn.disabled) return;

    const setButtonLoading = () => {
        saveScheduleBtn.disabled = true;
        saveScheduleBtn.classList.add("loading");
        saveScheduleBtn.innerHTML = '<span class="btn-spinner"></span> Saving...';
    };

    const resetButtonState = () => {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.classList.remove("loading");
        saveScheduleBtn.innerHTML = 'Save as Draft';
    };

    const triggerButtonShake = () => {
        saveScheduleBtn.classList.add("btn-shake");
        setTimeout(() => saveScheduleBtn.classList.remove("btn-shake"), 450);
    };

    // 1. Immediately disable and set loading state
    setButtonLoading();

    try {
        /* Perform a fresh query against Firestore to check for existing saved schedules */
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        const schedules = firestoreSchedules;

        const existingIndex = schedules.findIndex(schedule =>
            (schedule.section || "").trim().toLowerCase() === (generatedSchedule.section || "").trim().toLowerCase() &&
            (schedule.academicYear || "").trim() === (generatedSchedule.academicYear || "").trim() &&
            (schedule.semester || "").trim().toLowerCase() === (generatedSchedule.semester || "").trim().toLowerCase()
        );

        if (existingIndex >= 0) {
            // Re-enable button while user reviews confirmation modal
            resetButtonState();

            const confirmed = await showConfirm(`A schedule for ${generatedSchedule.section} already exists for A.Y. ${generatedSchedule.academicYear}, ${generatedSchedule.semester}. Replace it?`);
            if (!confirmed) {
                return;
            }

            // Re-apply loading state for the save operation
            setButtonLoading();
        }

        /* Use the stable Firestore document ID as the schedule ID */
        const docId = scheduleDocId(generatedSchedule);
        generatedSchedule.id = docId;
        generatedSchedule.status = "draft";

        const updatedSchedules = schedules.filter(s =>
            s.id !== docId && !(
                (s.section || "").trim().toLowerCase() === (generatedSchedule.section || "").trim().toLowerCase() &&
                (s.academicYear || "").trim() === (generatedSchedule.academicYear || "").trim() &&
                (s.semester || "").trim().toLowerCase() === (generatedSchedule.semester || "").trim().toLowerCase()
            )
        );
        updatedSchedules.unshift(generatedSchedule);

        /* Persist to Firestore */
        await saveScheduleToFirestore(generatedSchedule);
        console.log("Schedule saved to Firestore:", generatedSchedule.name);

        /* Update local storage and UI */
        setSavedSchedules(updatedSchedules);
        renderSavedSchedules();
        if (typeof renderArchive === "function") renderArchive();

        /* Close modal using smooth fade-out and scale-down animation */
        const modalContent = modal.querySelector(".modal-content");
        if (modalContent) modalContent.classList.add("scale-down");
        modal.classList.add("fade-out");

        setTimeout(() => {
            modal.style.display = "none";
            modal.classList.remove("fade-out");
            if (modalContent) modalContent.classList.remove("scale-down");
            resetButtonState();
        }, 300);

        /* Show the saved success overlay with checkmark animation */
        showSuccessOverlay("Schedule saved as draft!");

    } catch (error) {
        console.error("Could not save schedule to Firestore:", error);
        resetButtonState();
        triggerButtonShake();
        showToast("Failed to save schedule. Please try again.");
    }
});

// ======================================
// 📢 PUBLISH SCHEDULE BUTTON (Preview Modal)
// ======================================
publishScheduleBtn.addEventListener("click", async () => {
    if (!generatedSchedule) return;
    if (publishScheduleBtn.disabled || publishScheduleBtn.getAttribute("disabled") !== null) {
        showToast("Cannot publish while schedule conflicts exist. Please resolve conflicts first or save as draft.");
        return;
    }

    const setLoading = () => {
        publishScheduleBtn.disabled = true;
        saveScheduleBtn.disabled = true;
        publishScheduleBtn.innerHTML = '<span class="btn-spinner"></span> Publishing...';
    };
    const resetState = () => {
        publishScheduleBtn.disabled = false;
        saveScheduleBtn.disabled = false;
        publishScheduleBtn.innerHTML = 'Publish Schedule';
    };

    setLoading();

    try {
        /* First save/update in Firestore with status="published" */
        const docId = scheduleDocId(generatedSchedule);
        generatedSchedule.id = docId;
        generatedSchedule.status = "published";
        await saveScheduleToFirestore(generatedSchedule);
        console.log("✅ [Publish] Firestore publish successful for class schedule:", docId);

        /* Dispatch notifications via backend */
        const result = await publishClassScheduleApi(generatedSchedule);

        /* Refresh UI */
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        /* Close modal */
        const modalContent = modal.querySelector(".modal-content");
        if (modalContent) modalContent.classList.add("scale-down");
        modal.classList.add("fade-out");
        setTimeout(() => {
            modal.style.display = "none";
            modal.classList.remove("fade-out");
            if (modalContent) modalContent.classList.remove("scale-down");
            resetState();
        }, 300);

        if (!result.success || (result.sentCount === 0 && result.failedCount > 0)) {
            const failMsg = `Schedule was published to Firestore, but student email notification failed: ${result.error || result.message || 'Check server logs'}`;
            showToast(failMsg);
            console.warn("[Publish] Email delivery notice:", failMsg);
        } else {
            const sentMsg = result.sentCount != null ? ` (${result.sentCount} student email notification(s) sent)` : "";
            showSuccessOverlay(`Schedule published!${sentMsg}`);
        }

    } catch (error) {
        console.error("Could not publish schedule:", error);
        resetState();
        showToast("Failed to publish schedule. Please try again.");
    }
});

function showSuccessOverlay(message = "Schedule saved successfully!") {
    const overlay = document.getElementById("savedOverlay");
    const textEl = document.getElementById("savedOverlayText") || overlay?.querySelector("span");
    if (!overlay) return;

    if (textEl) {
        textEl.textContent = message;
    }

    /* Reset SVG checkmark animation to trigger fresh stroke animation */
    const svg = overlay.querySelector(".saved-check");
    if (svg) {
        const circle = svg.querySelector(".saved-check-circle");
        const mark = svg.querySelector(".saved-check-mark");
        if (circle) {
            circle.style.animation = "none";
            circle.offsetHeight; /* trigger reflow */
            circle.style.animation = "";
        }
        if (mark) {
            mark.style.animation = "none";
            mark.offsetHeight; /* trigger reflow */
            mark.style.animation = "";
        }
    }

    overlay.classList.remove("fade-out");
    overlay.style.display = "flex";

    setTimeout(() => {
        overlay.classList.add("fade-out");
    }, 1200);

    setTimeout(() => {
        overlay.style.display = "none";
        overlay.classList.remove("fade-out");
    }, 1600);
}

function scheduleMatchesSavedSearch(schedule, query) {
    if (!query) return true;
    const q = query.toLowerCase();

    // Match section name / schedule name / program / major / AY / semester
    if ((schedule.name || "").toLowerCase().includes(q)) return true;
    if ((schedule.section || "").toLowerCase().includes(q)) return true;
    if ((schedule.academicYear || "").toLowerCase().includes(q)) return true;
    if ((schedule.semester || "").toLowerCase().includes(q)) return true;
    if ((schedule.program || "").toLowerCase().includes(q)) return true;
    if ((schedule.major || "").toLowerCase().includes(q)) return true;
    if ((schedule.yearLevel || "").toLowerCase().includes(q)) return true;

    // Match any subject code, subject name, day, time, or room in entries
    if (Array.isArray(schedule.entries)) {
        for (const entry of schedule.entries) {
            if ((entry.code || "").toLowerCase().includes(q)) return true;
            if ((entry.name || "").toLowerCase().includes(q)) return true;
            if ((entry.day || "").toLowerCase().includes(q)) return true;
            if ((entry.time || "").toLowerCase().includes(q)) return true;
            if ((entry.room || "").toLowerCase().includes(q)) return true;
        }
    }

    return false;
}

function renderSavedSchedules() {
    /* Only non-archived schedules are shown in Saved Schedules (active, draft, and published).
       Archived schedules are displayed in the Schedule Archive section below. */
    const allActiveSchedules = getSavedSchedules().filter(
        schedule => (schedule.status || "draft") !== "archived"
    );

    const query = (savedScheduleSearchInput?.value || "").trim().toLowerCase();
    const schedules = allActiveSchedules.filter(s => scheduleMatchesSavedSearch(s, query));

    if (allActiveSchedules.length === 0) {
        emptySavedSchedules.textContent = "No saved schedules yet.";
        emptySavedSchedules.hidden = false;
        savedSchedulesList.innerHTML = "";
        return;
    }

    if (schedules.length === 0) {
        emptySavedSchedules.textContent = "No saved schedules match your search.";
        emptySavedSchedules.hidden = false;
        savedSchedulesList.innerHTML = "";
        return;
    }

    emptySavedSchedules.hidden = true;

    savedSchedulesList.innerHTML = schedules.map(schedule => `
        <article style="margin-top:16px">
            <div class="section-header">
                <div>
                    <h4 style="margin:0">${escapeHtml(schedule.name)}</h4>
                    <small>
                        ${escapeHtml(
                            [
                                schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
                                schedule.semester,
                                schedule.yearLevel
                            ].filter(Boolean).join(" • ")
                        )}
                    </small>
                    ${schedule.status === "published"
                        ? `<span style="display:inline-block;margin-left:8px;background:#2e7d32;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;vertical-align:middle;">✓ Published</span>`
                        : `<span style="display:inline-block;margin-left:8px;background:#546e7a;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;vertical-align:middle;">Draft</span>`
                    }
                </div>

                <div class="schedule-card-actions">
                    ${schedule.status !== "published"
                        ? `<button type="button" class="publish-schedule-card-btn" data-publish-schedule="${escapeHtml(schedule.id)}" style="background:#2e7d32;color:white;border:none;border-radius:8px;padding:7px 16px;font-weight:bold;font-size:13px;cursor:pointer;">Publish</button>`
                        : ""
                    }
                    <button type="button" class="view-calendar-btn" data-view-calendar="${escapeHtml(schedule.id)}">
                        View in Calendar
                    </button>
                    <button type="button" class="edit-schedule-btn" data-edit-schedule="${escapeHtml(schedule.id)}">
                        Edit
                    </button>
                    <button type="button" class="delete-schedule-btn" data-delete-schedule="${escapeHtml(schedule.id)}">
                        Delete
                    </button>
                </div>
            </div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Subject Code</th>
                            <th>Subject Name</th>
                            <th>Units</th>
                            <th>Day</th>
                            <th>Time</th>
                            <th>Room</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${scheduleRows(schedule.entries)}
                    </tbody>
                </table>
            </div>
        </article>
    `).join("");
}

if (savedScheduleSearchInput) {
    savedScheduleSearchInput.addEventListener("input", renderSavedSchedules);
}
// Edit Schedule Modal Elements & Logic
const editScheduleModal = document.getElementById("editScheduleModal");
const editScheduleTitle = document.getElementById("editScheduleTitle");
const editScheduleSubtitle = document.getElementById("editScheduleSubtitle");
const editScheduleTableBody = document.getElementById("editScheduleTableBody");
const editScheduleConflicts = document.getElementById("editScheduleConflicts");
const saveEditScheduleBtn = document.getElementById("saveEditScheduleBtn");
const cancelEditScheduleBtn = document.getElementById("cancelEditScheduleBtn");
const closeEditScheduleModalBtn = document.getElementById("closeEditScheduleModalBtn");
let currentEditingScheduleId = null;

/**
 * Validates updated schedule entries against:
 * 1. Valid time formats (start < end).
 * 2. Internal section overlaps (two classes in this section at same day/time).
 * 3. Internal room double-bookings (two classes in this section assigned same room at same day/time).
 * 4. Cross-schedule room overlaps (another active section occupying the room on same day/time).
 */
function validateScheduleEdits(updatedEntries, schedule) {
    const conflicts = [];
    const conflictRowIndices = new Set();

    // Flatten updated entries into distinct meeting slots
    const slots = [];
    updatedEntries.forEach((entry, rowIdx) => {
        const days = String(entry.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
        const times = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
        const rooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);

        const maxLen = Math.max(days.length, times.length, rooms.length, 1);
        for (let i = 0; i < maxLen; i++) {
            const day = days[i] || days[0] || entry.day;
            const time = times[i] || times[0] || entry.time;
            const room = rooms[i] || rooms[0] || entry.room;

            slots.push({
                rowIdx,
                code: entry.code,
                name: entry.name,
                day,
                time,
                room,
                section: schedule.section || schedule.name || ""
            });
        }
    });

    // 1. Validate time format & range
    slots.forEach(slot => {
        const range = parseTimeRange(slot.time);
        if (!range) {
            conflicts.push(`Invalid Time Format for <strong>${escapeHtml(slot.code)}</strong>: "<em>${escapeHtml(slot.time)}</em>". Please use a valid time format like <strong>7:30-9:00</strong> or <strong>7:30 AM - 9:00 AM</strong> with start time before end time.`);
            conflictRowIndices.add(slot.rowIdx);
        }
    });

    // 2. Check for internal section overlaps (same day, overlapping time)
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i];
            const b = slots[j];

            if (a.day.toLowerCase() === b.day.toLowerCase() && timesOverlap(a.time, b.time)) {
                conflicts.push(`Section Conflict on <strong>${escapeHtml(a.day)}</strong>: <strong>${escapeHtml(a.code)}</strong> (${escapeHtml(a.time)}) overlaps with <strong>${escapeHtml(b.code)}</strong> (${escapeHtml(b.time)}).`);
                conflictRowIndices.add(a.rowIdx);
                conflictRowIndices.add(b.rowIdx);
            }
        }
    }

    // 3. Check for internal room double-bookings within this section
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i];
            const b = slots[j];

            const aRoom = (a.room || "").trim().toLowerCase();
            const bRoom = (b.room || "").trim().toLowerCase();
            const isGym = aRoom.includes("gym");

            if (!isGym && aRoom && bRoom && aRoom === bRoom && a.day.toLowerCase() === b.day.toLowerCase() && timesOverlap(a.time, b.time)) {
                conflicts.push(`Room Double-Booking on <strong>${escapeHtml(a.day)}</strong>: Both <strong>${escapeHtml(a.code)}</strong> and <strong>${escapeHtml(b.code)}</strong> are assigned to <strong>${escapeHtml(a.room)}</strong> at overlapping times.`);
                conflictRowIndices.add(a.rowIdx);
                conflictRowIndices.add(b.rowIdx);
            }
        }
    }

    // 4. Check against other saved active schedules in the same Academic Year & Semester
    const otherBookings = getSavedBookings(schedule.academicYear, schedule.semester).filter(
        b => (b.section || "").trim().toLowerCase() !== (schedule.section || "").trim().toLowerCase()
    );

    slots.forEach(slot => {
        const roomName = (slot.room || "").trim().toLowerCase();
        if (!roomName) return;

        const isGym = roomName.includes("gym");
        const matching = otherBookings.filter(b =>
            (b.room || "").trim().toLowerCase() === roomName &&
            (b.day || "").trim().toLowerCase() === slot.day.trim().toLowerCase() &&
            timesOverlap(b.time, slot.time)
        );

        if (isGym) {
            // Gym allows up to 2 simultaneous sections
            if (matching.length >= 2) {
                const bookedSections = [...new Set(matching.map(b => b.section || "Another section"))].join(", ");
                conflicts.push(`Gymnasium Capacity Exceeded on <strong>${escapeHtml(slot.day)}</strong> (${escapeHtml(slot.time)}): Already booked by 2 sections (<strong>${escapeHtml(bookedSections)}</strong>).`);
                conflictRowIndices.add(slot.rowIdx);
            }
        } else if (matching.length > 0) {
            const bookedSections = [...new Set(matching.map(b => b.section || "Another section"))].join(", ");
            conflicts.push(`Room Conflict on <strong>${escapeHtml(slot.day)}</strong>: <strong>${escapeHtml(slot.room)}</strong> is already booked by <strong>${escapeHtml(bookedSections)}</strong> during <strong>${escapeHtml(slot.time)}</strong> (for ${escapeHtml(slot.code)}).`);
            conflictRowIndices.add(slot.rowIdx);
        }
    });

    return {
        isValid: conflicts.length === 0,
        conflicts: [...new Set(conflicts)],
        conflictRowIndices
    };
}

function clearEditScheduleConflicts() {
    if (editScheduleConflicts) {
        editScheduleConflicts.style.display = "none";
        editScheduleConflicts.innerHTML = "";
    }
    if (editScheduleTableBody) {
        editScheduleTableBody.querySelectorAll("tr").forEach(row => {
            row.classList.remove("has-conflict");
        });
    }
}

function openEditScheduleModal(scheduleId) {
    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === scheduleId || scheduleDocId(item) === scheduleId);

    if (!schedule) {
        showToast("Schedule not found.");
        return;
    }

    currentEditingScheduleId = scheduleId;
    clearEditScheduleConflicts();

    if (editScheduleTitle) {
        editScheduleTitle.textContent = `Edit Class Schedule - ${schedule.section || schedule.name}`;
    }

    if (editScheduleSubtitle) {
        editScheduleSubtitle.textContent = [
            schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
            schedule.semester,
            schedule.yearLevel
        ].filter(Boolean).join(" • ");
    }

    if (editScheduleTableBody) {
        editScheduleTableBody.innerHTML = (schedule.entries || []).map((entry, idx) => `
            <tr data-entry-idx="${idx}">
                <td>
                    <strong style="color:var(--dark); font-size:13px;">${escapeHtml(entry.code || "")}</strong>
                    <input type="hidden" class="edit-code-input" value="${escapeHtml(entry.code || "")}">
                </td>
                <td>
                    <span style="font-size:13px;">${escapeHtml(entry.name || "")}</span>
                    <input type="hidden" class="edit-name-input" value="${escapeHtml(entry.name || "")}">
                </td>
                <td style="text-align:center;">
                    <span style="font-size:13px; font-weight:600;">${escapeHtml(String(entry.units ?? ""))}</span>
                    <input type="hidden" class="edit-units-input" value="${escapeHtml(String(entry.units ?? ""))} ">
                </td>
                <td>
                    <input type="text" class="edit-day-input" value="${escapeHtml(entry.day || "")}" placeholder="e.g. Monday or Mon / Wed">
                </td>
                <td>
                    <input type="text" class="edit-time-input" value="${escapeHtml(entry.time || "")}" placeholder="e.g. 7:00 AM - 10:00 AM">
                </td>
                <td>
                    <input type="text" class="edit-room-input" value="${escapeHtml(entry.room || "")}" placeholder="e.g. Room 101 or Lab 1 / Room 102">
                </td>
            </tr>
        `).join("");
    }

    if (editScheduleModal) {
        editScheduleModal.style.display = "flex";
    }
}

function closeEditScheduleModal() {
    if (editScheduleModal) {
        editScheduleModal.style.display = "none";
    }
    currentEditingScheduleId = null;
    clearEditScheduleConflicts();
    if (editScheduleTableBody) {
        editScheduleTableBody.innerHTML = "";
    }
}

if (editScheduleTableBody) {
    // Clear conflict highlight on input when user edits
    editScheduleTableBody.addEventListener("input", (e) => {
        const row = e.target.closest("tr");
        if (row) {
            row.classList.remove("has-conflict");
        }
        if (editScheduleConflicts && editScheduleTableBody.querySelectorAll(".has-conflict").length === 0) {
            editScheduleConflicts.style.display = "none";
        }
    });
}

if (cancelEditScheduleBtn) {
    cancelEditScheduleBtn.addEventListener("click", closeEditScheduleModal);
}

if (closeEditScheduleModalBtn) {
    closeEditScheduleModalBtn.addEventListener("click", closeEditScheduleModal);
}

if (editScheduleModal) {
    editScheduleModal.addEventListener("click", (e) => {
        if (e.target === editScheduleModal) {
            closeEditScheduleModal();
        }
    });
}

if (saveEditScheduleBtn) {
    saveEditScheduleBtn.addEventListener("click", async () => {
        if (!currentEditingScheduleId) return;

        const schedules = getSavedSchedules();
        const schedule = schedules.find(item => item.id === currentEditingScheduleId || scheduleDocId(item) === currentEditingScheduleId);

        if (!schedule) {
            showToast("Schedule record not found.");
            return;
        }

        const rows = editScheduleTableBody.querySelectorAll("tr");
        const updatedEntries = [];

        for (const row of rows) {
            const code = (row.querySelector(".edit-code-input")?.value || "").trim();
            const name = (row.querySelector(".edit-name-input")?.value || "").trim();
            const units = (row.querySelector(".edit-units-input")?.value || "").trim();
            const day = (row.querySelector(".edit-day-input")?.value || "").trim();
            const time = (row.querySelector(".edit-time-input")?.value || "").trim();
            const room = (row.querySelector(".edit-room-input")?.value || "").trim();

            if (!day || !time || !room) {
                showToast(`Please complete Day, Time, and Room for ${code || "all subjects"}.`);
                return;
            }

            updatedEntries.push({
                code,
                name,
                units: Number(units) || units,
                day,
                time,
                room
            });
        }

        // Run automated conflict validation
        const validation = validateScheduleEdits(updatedEntries, schedule);

        if (!validation.isValid) {
            // Highlight conflicting rows
            rows.forEach((row, idx) => {
                if (validation.conflictRowIndices.has(idx)) {
                    row.classList.add("has-conflict");
                } else {
                    row.classList.remove("has-conflict");
                }
            });

            // Display conflict banner
            if (editScheduleConflicts) {
                editScheduleConflicts.innerHTML = `
                    <div class="edit-conflict-banner">
                        <h4>⚠️ Scheduling Conflicts Detected (${validation.conflicts.length})</h4>
                        <ul class="edit-conflict-list">
                            ${validation.conflicts.map(c => `<li>${c}</li>`).join("")}
                        </ul>
                        <p style="margin:8px 0 0 0; font-size:12px; opacity:0.9;">Please resolve the conflicts above before saving changes.</p>
                    </div>
                `;
                editScheduleConflicts.style.display = "block";
                editScheduleConflicts.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
            return;
        }

        // Clear any previous conflict warnings
        clearEditScheduleConflicts();

        /* Rebuild rawEntries for conflict checking and scoping */
        const newRawEntries = [];
        updatedEntries.forEach(entry => {
            const days = String(entry.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
            const times = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
            const rooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);

            const maxLen = Math.max(days.length, times.length, rooms.length, 1);
            for (let i = 0; i < maxLen; i++) {
                newRawEntries.push({
                    code: entry.code,
                    name: entry.name,
                    units: entry.units,
                    day: days[i] || days[0] || entry.day,
                    time: times[i] || times[0] || entry.time,
                    room: rooms[i] || rooms[0] || entry.room,
                    roomCode: "",
                    section: schedule.section || ""
                });
            }
        });

        schedule.entries = updatedEntries;
        schedule.rawEntries = newRawEntries;
        schedule.updatedAt = new Date().toISOString();

        saveEditScheduleBtn.disabled = true;
        saveEditScheduleBtn.textContent = "Saving...";

        try {
            /* Persist to Firestore */
            await saveScheduleToFirestore(schedule);
            console.log("Schedule updated in Firestore:", schedule.id);

            /* Update localStorage */
            const allSchedules = getSavedSchedules();
            const idx = allSchedules.findIndex(s => s.id === schedule.id || scheduleDocId(s) === scheduleDocId(schedule));
            if (idx >= 0) {
                allSchedules[idx] = schedule;
            } else {
                allSchedules.push(schedule);
            }
            setSavedSchedules(allSchedules);

            renderSavedSchedules();
            if (typeof renderArchive === "function") renderArchive();

            closeEditScheduleModal();
            showSuccessOverlay("✓ Class schedule updated successfully!");
        } catch (error) {
            console.error("Could not update schedule in Firestore:", error);
            showToast(`Failed to update schedule: ${error.message}`);
        } finally {
            saveEditScheduleBtn.disabled = false;
            saveEditScheduleBtn.textContent = "Save Changes";
        }
    });
}

/* ------------------------------------------------------------------ */
/*  Class Calendar Modal                                               */
/* ------------------------------------------------------------------ */

const classCalendarModal = document.getElementById("classCalendarModal");
const clsCalModalClose  = document.getElementById("clsCalModalClose");
const clsCalModalTitle  = document.getElementById("clsCalModalTitle");
const clsCalModalSubtitle = document.getElementById("clsCalModalSubtitle");
const clsCalModalBody   = document.getElementById("clsCalModalBody");

function openClassCalendarModal(scheduleId) {
    const schedules = getSavedSchedules();
    const schedule  = schedules.find(item => item.id === scheduleId);
    if (!schedule) return;

    if (clsCalModalTitle)    clsCalModalTitle.textContent = schedule.name || schedule.section || "Class Schedule";
    if (clsCalModalSubtitle) {
        clsCalModalSubtitle.textContent = [
            schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
            schedule.semester,
            schedule.yearLevel
        ].filter(Boolean).join(" • ");
    }
    if (clsCalModalBody) {
        clsCalModalBody.innerHTML = renderClassCalendar(schedule);
    }
    if (classCalendarModal) classCalendarModal.style.display = "flex";
}

function closeClassCalendarModal() {
    if (classCalendarModal) classCalendarModal.style.display = "none";
    if (clsCalModalBody)    clsCalModalBody.innerHTML = "";
}

if (clsCalModalClose) {
    clsCalModalClose.addEventListener("click", closeClassCalendarModal);
}
if (classCalendarModal) {
    classCalendarModal.addEventListener("click", e => {
        if (e.target === classCalendarModal) closeClassCalendarModal();
    });
}
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && classCalendarModal?.style.display === "flex") closeClassCalendarModal();
});

savedSchedulesList.addEventListener("click", async event => {
    // View in Calendar
    const calendarId = event.target.closest("[data-view-calendar]")?.dataset.viewCalendar;
    if (calendarId) {
        openClassCalendarModal(calendarId);
        return;
    }

    const editId = event.target.dataset.editSchedule;
    if (editId) {
        openEditScheduleModal(editId);
        return;
    }

    // Publish button on saved schedule card
    const publishId = event.target.dataset.publishSchedule;
    if (publishId) {
        const btn = event.target;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Publishing...";

        const schedules = getSavedSchedules();
        const schedule = schedules.find(item => item.id === publishId);
        if (!schedule) {
            btn.disabled = false;
            btn.textContent = origText;
            showToast("Schedule not found.");
            return;
        }

        try {
            /* Check for conflicts before publishing */
            let allSchedules = [];
            try {
                allSchedules = await loadSchedulesFromFirestore();
            } catch (_) {
                allSchedules = schedules;
            }

            const analysis = analyzeClassScheduleConflicts(schedule, allSchedules);
            if (analysis.totalConflicts > 0) {
                btn.disabled = false;
                btn.textContent = origText;
                showToast(`Cannot publish schedule: ${analysis.totalConflicts} conflict(s) detected in A.Y. ${schedule.academicYear}, ${schedule.semester}. Please edit the schedule first.`);
                return;
            }

            schedule.status = "published";
            await saveScheduleToFirestore(schedule);
            console.log("✅ [Publish] Firestore publish successful for class schedule:", schedule.id);

            const result = await publishClassScheduleApi(schedule);

            /* Reload from Firestore to get authoritative data */
            const firestoreSchedules = await loadSchedulesFromFirestore();
            setSavedSchedules(firestoreSchedules);
            renderSavedSchedules();

            if (!result.success || (result.sentCount === 0 && result.failedCount > 0)) {
                const failMsg = `Schedule was published to Firestore, but student email notification failed: ${result.error || result.message || 'Check server logs'}`;
                showToast(failMsg);
                console.warn("[Publish] Email delivery notice:", failMsg);
            } else {
                const sentMsg = result && result.sentCount != null ? ` (${result.sentCount} student email notification(s) sent)` : "";
                showSuccessOverlay(`Schedule published!${sentMsg}`);
            }
        } catch (err) {
            console.error("Could not publish schedule:", err);
            btn.disabled = false;
            btn.textContent = origText;
            showToast(`Failed to publish schedule: ${err.message}`);
        }
        return;
    }

    const scheduleId = event.target.dataset.deleteSchedule;
    if (!scheduleId) return;

    if (!await showConfirm("Delete this saved schedule?")) return;

    /* Find the schedule so we can compute its stable Firestore document ID */
    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === scheduleId);

    /* Remove from localStorage */
    const remaining = schedules.filter(item => item.id !== scheduleId);
    setSavedSchedules(remaining);
    renderSavedSchedules();

    /* Also remove from Firestore using the stable document ID */
    const firestoreDocId = schedule ? scheduleDocId(schedule) : scheduleId;
    try {
        await deleteScheduleFromFirestore(firestoreDocId);
        console.log("Schedule deleted from Firestore:", firestoreDocId);
    } catch (error) {
        console.error("Could not delete schedule from Firestore:", error);
    }
});

/* Initialise: load saved schedules from Firestore into localStorage for
   the conflict checker, then render.  Firestore is the source of truth. */
(async function init() {
    const firestoreSchedules = await loadSchedulesFromFirestore();

    /* Merge any existing localStorage schedules so nothing is lost */
    const localSchedules = getSavedSchedules();
    const merged = [...firestoreSchedules];

    for (const local of localSchedules) {
        const docId = scheduleDocId(local);
        const exists = merged.some(item => item.id === docId);
        if (!exists) {
            merged.push({ ...local, id: docId });
        }
    }

    /* Sync back to localStorage so the conflict checker works */
    /* (Use the firestore doc id as the localStorage id for consistency) */
    setSavedSchedules(merged);
    renderSavedSchedules();
})();

document.getElementById("deleteAllBtn").addEventListener("click", async () => {
    /* Fetch fresh class schedule documents from Firestore */
    const firestoreSnapshot = await getDocs(collection(db, SCHEDULES_COLLECTION));
    const firestoreSchedules = firestoreSnapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
    }));

    const localSchedules = getSavedSchedules();

    /* Combine Firestore active schedules and local active schedules */
    const activeDocIds = new Set();
    firestoreSnapshot.docs.forEach(d => {
        if ((d.data().status || "active") !== "archived") {
            activeDocIds.add(d.id);
        }
    });

    localSchedules.forEach(s => {
        if ((s.status || "active") !== "archived") {
            if (s.id) activeDocIds.add(s.id);
            const docId = scheduleDocId(s);
            if (docId) activeDocIds.add(docId);
        }
    });

    if (activeDocIds.size === 0) {
        showToast("There are no active saved schedules to delete.");
        return;
    }

    const confirmed = await showConfirm(`Are you sure you want to delete all active saved schedule(s)? This action cannot be undone.`);
    if (!confirmed) {
        return;
    }

    /* Delete each active schedule document from Firestore using its document ID */
    const deletePromises = Array.from(activeDocIds).map(async docId => {
        try {
            await deleteScheduleFromFirestore(docId);
        } catch (error) {
            console.warn(`Could not delete schedule ${docId}:`, error);
        }
    });
    await Promise.all(deletePromises);

    /* Fetch updated list from Firestore after deletion and sync local storage */
    const remainingSchedules = await loadSchedulesFromFirestore();
    setSavedSchedules(remainingSchedules);
    renderSavedSchedules();
    if (typeof renderArchive === "function") renderArchive();

    showToast("All active saved schedules have been deleted successfully.");
});

async function publishAllSavedClasses() {
    const publishBtn = document.getElementById("publishAllClassBtn");
    const freshFirestoreSchedules = await loadSchedulesFromFirestore();
    const localSchedules = getSavedSchedules() || [];
    const schedules = freshFirestoreSchedules.length ? freshFirestoreSchedules : localSchedules;

    /* Only non-archived schedules are eligible for publishing */
    const activeSchedules = schedules.filter(s => (s.status || "draft") !== "archived");

    if (!activeSchedules.length) {
        showToast("There are no saved class schedules to publish.");
        return;
    }

    const unpublishedCount = activeSchedules.filter(s => s.status !== "published").length;
    const confirmPrompt = unpublishedCount > 0
        ? `Are you sure you want to publish all ${activeSchedules.length} saved class schedule(s)? (${unpublishedCount} currently draft/unpublished).`
        : `Are you sure you want to re-publish all ${activeSchedules.length} saved class schedule(s)?`;

    const confirmed = await showConfirm(confirmPrompt);
    if (!confirmed) return;

    const origText = publishBtn ? publishBtn.innerHTML : "";
    if (publishBtn) {
        publishBtn.disabled = true;
        publishBtn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;"></span> Publishing...';
    }

    try {
        let successCount = 0;
        let totalSent = 0;
        const conflictSchedules = [];

        for (const schedule of activeSchedules) {
            /* Check for conflicts */
            const analysis = analyzeClassScheduleConflicts(schedule, activeSchedules);
            if (analysis.totalConflicts > 0) {
                conflictSchedules.push(schedule.name || schedule.section || "Untitled Section");
                continue;
            }

            schedule.status = "published";
            schedule.publishedAt = new Date().toISOString();
            schedule.publishedBy = auth.currentUser?.uid || null;

            try {
                await saveScheduleToFirestore(schedule);
                console.log("✅ [Publish] Firestore publish successful for class schedule:", schedule.id);
                successCount++;
                const result = await publishClassScheduleApi(schedule);
                if (result && result.sentCount != null) totalSent += result.sentCount;
            } catch (err) {
                console.error("Could not publish class schedule:", schedule.name || schedule.id, err);
            }
        }

        /* Reload from Firestore to get authoritative data */
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        const emailInfo = totalSent > 0 ? ` (${totalSent} student notification(s) sent)` : "";
        if (savedOverlay) {
            savedOverlay.classList.remove("fade-out");
            savedOverlay.style.display = "flex";
            const overlaySpan = savedOverlay.querySelector("span");
            if (overlaySpan) overlaySpan.textContent = `Published ${successCount} class schedule(s)!${emailInfo}`;
            setTimeout(() => { savedOverlay.classList.add("fade-out"); }, 1400);
            setTimeout(() => { savedOverlay.style.display = "none"; savedOverlay.classList.remove("fade-out"); }, 2000);
        } else {
            showToast(`Successfully published ${successCount} class schedule(s)!${emailInfo}`);
        }

        if (conflictSchedules.length > 0) {
            showToast(`${successCount} schedule(s) published. ${conflictSchedules.length} schedule(s) were skipped due to conflicts: ${conflictSchedules.join(", ")}`);
        }
    } catch (error) {
        console.error("Error publishing all class schedules:", error);
        showToast(`Failed to publish all class schedules: ${error.message}`);
    } finally {
        if (publishBtn) {
            publishBtn.disabled = false;
            publishBtn.innerHTML = origText || "Publish All";
        }
    }
}

document.getElementById("publishAllClassBtn")?.addEventListener("click", publishAllSavedClasses);

document.getElementById("exportPdfBtn").addEventListener("click", async () => {
    const modal = document.getElementById("exportConfirmModal");
    modal.style.display = "flex";
    const confirmed = await new Promise(resolve => {
        const yesBtn = document.getElementById("exportConfirmYes");
        const noBtn = document.getElementById("exportConfirmNo");
        const cleanup = () => {
            yesBtn.removeEventListener("click", onYes);
            noBtn.removeEventListener("click", onNo);
        };
        const onYes = () => { cleanup(); modal.style.display = "none"; resolve(true); };
        const onNo = () => { cleanup(); modal.style.display = "none"; resolve(false); };
        yesBtn.addEventListener("click", onYes);
        noBtn.addEventListener("click", onNo);
    });
    if (!confirmed) return;

    /* Only ACTIVE schedules are eligible for archiving */
    const schedules = getSavedSchedules().filter(
        schedule => (schedule.status || "active") !== "archived"
    );

    if (!schedules.length) {
        showToast("There are no active saved schedules to archive.");
        return;
    }

    const archivedScheduleIds = new Set();
    const now = new Date().toISOString();

    for (const schedule of schedules) {
        const academicYear = schedule.academicYear || "";
        const semester = schedule.semester || "";
        const yearLevel = schedule.yearLevel || "";
        const filename = [
            academicYear ? `A.Y. ${academicYear}` : "A.Y.",
            semester
        ].filter(Boolean).join(" ");

        try {
            // Save report record to Firestore reports collection for archive history
            await saveReportToFirestore({
                category: "Class Schedule",
                academicYear,
                semester,
                yearLevel,
                title: schedule.name || schedule.section,
                section: schedule.section,
                filename,
                entries: schedule.entries || [],
                rawEntries: schedule.rawEntries || []
            });

            // Update status in classSchedules collection to archived
            await archiveScheduleInFirestore(schedule);
            archivedScheduleIds.add(schedule.id);
        } catch (error) {
            console.error("Could not archive schedule in Firestore:", schedule.name, error);
        }
    }

    const archivedSchedules = schedules.filter(schedule => archivedScheduleIds.has(schedule.id));
    const failedSchedules = schedules.filter(schedule => !archivedScheduleIds.has(schedule.id));

    if (archivedSchedules.length) {
        const allSchedules = getSavedSchedules();
        const updated = allSchedules.map(schedule =>
            archivedScheduleIds.has(schedule.id)
                ? { ...schedule, status: "archived", exportedAt: now }
                : schedule
        );
        setSavedSchedules(updated);
    }

    renderSavedSchedules();

    if (failedSchedules.length > 0) {
        showToast(
            `${archivedSchedules.length} schedule(s) moved to archive. ${failedSchedules.length} schedule(s) could not be archived.`
        );
    } else {
        showToast(
            `${archivedSchedules.length} schedule(s) moved to archive successfully.`
        );
    }
});

document.getElementById("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try {
        await signOut(auth);
    } catch (e) {
        console.error("Sign out error:", e);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("login.html");
});

/* =========================
   GUIDE / HELP MODAL
========================= */
(function initGuideModal() {
    const GUIDE_DISMISSED_KEY = "classGuide_dismissed";
    const guideModal = document.getElementById("classGuideModal");
    const guideInfoBtn = document.getElementById("guideInfoBtn");
    const guideCloseBtn = document.getElementById("guideModalClose");
    const guideDontShowCheckbox = document.getElementById("guideDontShowAgain");
    const guideGotItBtn = document.getElementById("guideGotItBtn");

    if (!guideModal || !guideInfoBtn) return;

    function openGuide() {
        guideModal.style.display = "flex";
        guideModal.classList.remove("fade-out");
        // Trigger reflow so the .show animation always fires
        void guideModal.offsetWidth;
        guideModal.classList.add("show");
        if (guideDontShowCheckbox) guideDontShowCheckbox.checked = false;
    }

    function closeGuide() {
        guideModal.classList.add("fade-out");
        guideModal.classList.remove("show");
        setTimeout(() => {
            guideModal.style.display = "none";
            guideModal.classList.remove("fade-out");
        }, 260);
    }

    // Open on ℹ button click
    guideInfoBtn.addEventListener("click", openGuide);

    // Close via × button
    if (guideCloseBtn) {
        guideCloseBtn.addEventListener("click", closeGuide);
    }

    // Close via "Got it" button + honour "Don't show again" checkbox
    if (guideGotItBtn) {
        guideGotItBtn.addEventListener("click", () => {
            if (guideDontShowCheckbox && guideDontShowCheckbox.checked) {
                localStorage.setItem(GUIDE_DISMISSED_KEY, "true");
            }
            closeGuide();
        });
    }

    // Close on backdrop click
    guideModal.addEventListener("click", event => {
        if (event.target === guideModal) {
            closeGuide();
        }
    });

    // Auto-show on first visit (if user has not dismissed)
    if (!localStorage.getItem(GUIDE_DISMISSED_KEY)) {
        // Small delay so the page paints first
        setTimeout(openGuide, 600);
    }
})();
