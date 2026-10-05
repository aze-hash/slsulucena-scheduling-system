/* ==========================================================================
   ROOM ASSIGNMENT DASHBOARD
   Read-only monitoring page. Reads existing Firestore data:
     - `rooms` collection -> lecture rooms, laboratories, and facilities
     - `classSchedules` collection & localStorage -> class schedule entries
     - `examSchedules` collection -> examination entries
   Supports switching between Class Schedule and Exam Schedule room allocations.
   Never writes, duplicates, or modifies schedules.
   ========================================================================== */

import { db, auth } from "../firebase.js";
import { parseTimeToMinutes } from "./js/schedule-calendar.js";

import {
    collection,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

/* ---------------- Constants ---------------- */

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const CAL_START_MINUTES = 7 * 60;       // 7:00 AM
const CAL_END_MINUTES = 19 * 60;        // 7:00 PM (covers 4:00-6:30 PM & 5:00-6:30 PM slots)
const CAL_TOTAL_MINUTES = CAL_END_MINUTES - CAL_START_MINUTES;
const HOUR_PX = 64;                     // pixel height per hour
const TOTAL_CALENDAR_COLORS = 16;
const EXPANDED_CARD_MIN_HEIGHT = 170;

/* ---------------- State ---------------- */

let currentScheduleType = "class"; // "class" or "exam"

let allRooms = [];
let allClassSchedules = [];
let allClassEntries = [];
let allExamSchedules = [];
let allExamEntries = [];

let selectedRoom = "";

const filters = {
    scheduleType: "class",
    academicYear: "",
    semester: "",
    examType: "",
    classStatus: "",
    program: "",
    section: "",
    roomType: "",
    room: ""
};

/* ---------------- DOM Helpers ---------------- */

const $ = id => document.getElementById(id);
const tabsEl = () => $("raRoomTabs");
const counterEl = () => $("raRoomCounter");
const calendarEl = () => $("raCalendar");
const emptyEl = () => $("raEmpty");
const summaryEl = () => $("raRoomSummary");
const conflictBannerEl = () => $("raConflictBanner");
const calendarTitleEl = () => $("raCalendarTitle");
const calendarSubtitleEl = () => $("raCalendarSubtitle");

const typeBtnClass = () => $("raTypeBtnClass");
const typeBtnExam = () => $("raTypeBtnExam");

const aySelect = () => $("raAcademicYear");
const semSelect = () => $("raSemester");
const examTypeSelect = () => $("raExamType");
const examTypeControl = () => $("raExamTypeControl");
const classStatusSelect = () => $("raClassStatus");
const classStatusControl = () => $("raClassStatusControl");
const programSelect = () => $("raProgram");
const sectionSelect = () => $("raSection");
const roomTypeSelect = () => $("raRoomType");
const roomSelect = () => $("raRoom");
const legendEl = () => $("raLegend");

/* ---------------- Text & Format Helpers ---------------- */

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
}

function normalise(value) {
    return String(value ?? "").trim().toLowerCase();
}

function normaliseRoom(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normaliseSemester(value) {
    const s = String(value || "").trim().toLowerCase();
    if (!s) return "";
    if (s === "1" || s.includes("1st") || s.includes("first")) return "1st Semester";
    if (s === "2" || s.includes("2nd") || s.includes("second")) return "2nd Semester";
    return String(value).trim();
}

function formatExamType(examType) {
    const t = String(examType || "").trim();
    if (!t) return "—";
    if (/prelim/i.test(t)) return "Preliminary Examination";
    if (/midterm|mid-term/i.test(t)) return "Midterm Examination";
    if (/final/i.test(t)) return "Final Examination";
    return t;
}

function parseTime(val) {
    if (val === null || val === undefined) return NaN;
    const parts = String(val).trim().split(":").map(Number);
    if (!parts.length || Number.isNaN(parts[0])) return NaN;
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;
    if (hour >= 1 && hour <= 6) hour += 12; // 1-6 are PM
    return hour * 60 + minute;
}

function minutesToDisplay(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) return "";
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatTimeDisplay(slot) {
    if (!slot) return "—";
    const raw = String(slot).trim();
    if (raw.toUpperCase() === "TBA" || !raw.includes("-")) return escapeHtml(raw);
    const parts = raw.split("-").map(p => p.trim());
    const sMin = parseTime(parts[0]);
    const eMin = parseTime(parts[1]);
    if (Number.isNaN(sMin) || Number.isNaN(eMin)) return escapeHtml(raw);
    return `${minutesToDisplay(sMin)} – ${minutesToDisplay(eMin)}`;
}

function getDayName(dateStr) {
    if (!dateStr) return "";
    const d = new Date(`${dateStr}T00:00:00`);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { weekday: "long" });
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return "—";
    if (String(dateStr).toUpperCase() === "TBA") return "TBA";
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function showToast(message) {
    const toast = $("customToast");
    const msgEl = $("customToastMessage");
    if (!toast || !msgEl) { alert(message); return; }
    msgEl.textContent = message;
    toast.style.display = "flex";
}

function naturalRoomSort(a, b) {
    return String(a.roomName || "").localeCompare(String(b.roomName || ""), "en", { numeric: true, sensitivity: "base" });
}

function getRoomCategory(roomType) {
    const t = normalise(roomType);
    if (!t) return "Other";
    if (t.includes("lecture")) return "Lecture Room";
    if (t.includes("lab")) return "Laboratory";
    if (t.includes("gym") || t.includes("court")) return "Gymnasium";
    return "Other";
}

function entryMatchesRoom(entryRoom, targetRoom) {
    if (!entryRoom || !targetRoom) return false;
    const normEntry = normaliseRoom(entryRoom);
    const normTargetName = normaliseRoom(targetRoom.roomName);
    const normTargetCode = normaliseRoom(targetRoom.roomCode);

    return normEntry === normTargetName || (normTargetCode && normEntry === normTargetCode);
}

function timesOverlap(time1, time2) {
    const r1 = parseTimeToMinutes(time1);
    const r2 = parseTimeToMinutes(time2);
    if (!r1 || !r2) return false;
    return r1.start < r2.end && r2.start < r1.end;
}

function isActivityGymOrCourtRoom(roomVal) {
    if (!roomVal) return false;
    const norm = String(roomVal).toLowerCase().trim();
    if (/covered\s*court|court|gym|gymnasium|activity/i.test(norm)) return true;
    if (typeof allRooms !== "undefined" && Array.isArray(allRooms)) {
        const match = allRooms.find(r =>
            normaliseRoom(r.roomName) === norm ||
            normaliseRoom(r.roomCode) === norm
        );
        if (match) {
            const cat = (match.category || "").toLowerCase();
            const type = (match.roomType || "").toLowerCase();
            if (cat === "gymnasium" || /gym|court|activity/i.test(type) || /gym|court|activity/i.test(match.roomName)) {
                return true;
            }
        }
    }
    return false;
}

function sameFaculty(f1, f2, uid1, uid2) {
    if (uid1 && uid2 && uid1 === uid2) return true;
    if (!f1 || !f2) return false;
    const n1 = String(f1).trim().replace(/\s+/g, " ").toLowerCase();
    const n2 = String(f2).trim().replace(/\s+/g, " ").toLowerCase();
    if (!n1 || !n2 || n1 === "unassigned" || n2 === "unassigned" || n1 === "tba" || n2 === "tba") return false;
    if (n1 === n2) return true;
    const stripInitial = s => s.replace(/\s+[a-z]\.?$/i, "").replace(/,\s*/g, " ").trim();
    return stripInitial(n1) === stripInitial(n2);
}

/* ---------------- Data Loading ---------------- */

async function loadRooms() {
    try {
        const snap = await getDocs(collection(db, "rooms"));
        const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        const processed = raw
            .filter(r => String(r.roomName || r.roomCode || "").trim() !== "")
            .map(r => {
                const name = String(r.roomName || r.roomCode).trim();
                const code = String(r.roomCode || "").trim();
                const type = String(r.roomType || "Lecture Room").trim();
                return {
                    id: r.id,
                    roomName: name,
                    roomCode: code,
                    roomType: type,
                    category: getRoomCategory(type),
                    building: r.building || "",
                    capacity: r.capacity || 40
                };
            })
            .sort(naturalRoomSort);

        const seen = new Set();
        allRooms = processed.filter(r => {
            const key = normaliseRoom(r.roomName);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (!allRooms.length) {
            allRooms = [
                { id: "A101", roomName: "Room A101", roomCode: "A101", roomType: "Lecture Room", category: "Lecture Room" },
                { id: "A102", roomName: "Room A102", roomCode: "A102", roomType: "Lecture Room", category: "Lecture Room" },
                { id: "B101", roomName: "Room B101", roomCode: "B101", roomType: "Lecture Room", category: "Lecture Room" },
                { id: "FSML01", roomName: "FSM Laboratory", roomCode: "FSML01", roomType: "FSM Laboratory", category: "Laboratory" },
                { id: "ATL01", roomName: "AT Laboratory", roomCode: "ATL01", roomType: "AT Laboratory", category: "Laboratory" }
            ];
        }
    } catch (err) {
        console.warn("Could not load rooms from Firestore:", err);
    }
}

function getLocalClassSchedules() {
    try {
        return JSON.parse(localStorage.getItem("chairpersonSavedSchedules")) || [];
    } catch {
        return [];
    }
}

/**
 * Expands a class schedule into discrete, single-day and single-time meeting units.
 */
function expandClassSchedule(schedule) {
    const discrete = [];
    if (!schedule) return discrete;
    if (String(schedule.status || "").toLowerCase() === "archived") return discrete;

    const sourceEntries = Array.isArray(schedule.rawEntries) && schedule.rawEntries.length > 0
        ? schedule.rawEntries
        : (schedule.entries || []);

    const scheduleSection = schedule.section || schedule.name || "";
    const scheduleStatus = (schedule.status || "draft").toLowerCase();

    sourceEntries.forEach((entry, entryIdx) => {
        if (!entry) return;
        if (entry.code === "SIP01" || entry.code === "SIP02" || entry.code === "OJT01" || entry.code === "OJT02" ||
            entry.room === "TBA" || String(entry.day || "").toUpperCase() === "TBA" || String(entry.time || "").toUpperCase() === "TBA") {
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
                    scheduleId: schedule.id || null,
                    academicYear: String(schedule.academicYear || "").trim(),
                    semester: String(schedule.semester || "").trim(),
                    semesterNorm: normaliseSemester(schedule.semester),
                    program: String(schedule.program || "").trim(),
                    major: String(schedule.major || "").trim(),
                    section: String(entry.section || scheduleSection).trim(),
                    status: scheduleStatus,
                    code: String(entry.code || "").trim(),
                    name: String(entry.name || "").trim(),
                    units: entry.units || 0,
                    day: day.trim(),
                    time: time.trim(),
                    room: room.trim(),
                    faculty: String(entry.faculty || "Unassigned").trim(),
                    facultyUid: entry.facultyUid || "",
                    facultyId: entry.facultyId || "",
                    _idx: entryIdx
                });
            }
        }
    });

    return discrete;
}

async function loadClassSchedules() {
    let firestoreSchedules = [];
    try {
        const snap = await getDocs(collection(db, "classSchedules"));
        firestoreSchedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn("Could not load classSchedules from Firestore:", err);
    }

    const localSchedules = getLocalClassSchedules();
    const scheduleMap = new Map();

    firestoreSchedules.forEach(s => {
        const key = s.id || `${s.section}_${s.academicYear}_${s.semester}`;
        scheduleMap.set(key, s);
    });

    localSchedules.forEach(s => {
        const key = s.id || `${s.section}_${s.academicYear}_${s.semester}`;
        if (!scheduleMap.has(key)) {
            scheduleMap.set(key, s);
        }
    });

    allClassSchedules = Array.from(scheduleMap.values()).filter(s =>
        String(s.status || "").toLowerCase() !== "archived"
    );

    allClassEntries = [];
    allClassSchedules.forEach(sched => {
        const entries = expandClassSchedule(sched);
        allClassEntries.push(...entries);
    });
}

async function loadExamSchedules() {
    try {
        const snap = await getDocs(collection(db, "examSchedules"));
        allExamSchedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        allExamEntries = [];

        allExamSchedules.forEach(sched => {
            const exams = Array.isArray(sched.exams) ? sched.exams : [];
            exams.forEach((exam, idx) => {
                const date = String(exam.date || "").trim();
                let day = String(exam.day || "").trim();
                if (!day && date && date.toUpperCase() !== "TBA") day = getDayName(date);

                allExamEntries.push({
                    scheduleId: sched.id,
                    academicYear: String(sched.academicYear || "").trim(),
                    semester: String(sched.semester || "").trim(),
                    semesterNorm: normaliseSemester(sched.semester),
                    program: String(sched.program || "").trim(),
                    section: String(sched.section || "").trim(),
                    examType: String(exam.examType || sched.examType || "Preliminary").trim(),
                    code: String(exam.code || exam.subjectCode || "").trim(),
                    name: String(exam.name || exam.subjectName || "").trim(),
                    date,
                    day,
                    time: String(exam.time || "").trim(),
                    room: String(exam.room || "").trim(),
                    proctor: String(exam.proctor || sched.proctor || "TBA").trim(),
                    _idx: idx
                });
            });
        });
    } catch (err) {
        console.warn("Could not load examSchedules from Firestore:", err);
    }
}

/* ---------------- Filter & Tab Logic ---------------- */

function getVisibleRooms() {
    if (!filters.roomType) return allRooms;
    return allRooms.filter(r => r.category === filters.roomType);
}

function populateFilterOptions() {
    const isClass = currentScheduleType === "class";
    const sourceSchedules = isClass ? allClassSchedules : allExamSchedules;

    // Academic Years
    const years = [...new Set(sourceSchedules.map(s => String(s.academicYear || "").trim()).filter(Boolean))]
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    const ay = aySelect();
    if (ay) {
        const cur = ay.value;
        ay.innerHTML = `<option value="">All Academic Years</option>` +
            years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
        if (cur && years.includes(cur)) ay.value = cur;
        else if (!cur && years.length) ay.value = years[0];
    }

    // Programs
    const programs = [...new Set(sourceSchedules.map(s => String(s.program || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const pr = programSelect();
    if (pr) {
        const cur = pr.value;
        pr.innerHTML = `<option value="">All Programs</option>` +
            programs.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
        if (cur && programs.includes(cur)) pr.value = cur;
    }

    // Sections
    const sections = [...new Set(sourceSchedules.map(s => String(s.section || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const sc = sectionSelect();
    if (sc) {
        const cur = sc.value;
        sc.innerHTML = `<option value="">All Sections</option>` +
            sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
        if (cur && sections.includes(cur)) sc.value = cur;
    }

    // Room select
    populateRoomDropdown();
}

function populateRoomDropdown() {
    const rm = roomSelect();
    if (!rm) return;
    const visibleRooms = getVisibleRooms();
    const cur = rm.value || selectedRoom;

    rm.innerHTML = `<option value="">Select Room</option>` +
        visibleRooms.map(r => `<option value="${escapeHtml(r.roomName)}">${escapeHtml(r.roomName)}${r.category !== 'Lecture Room' ? ` (${r.category})` : ''}</option>`).join("");

    if (cur && visibleRooms.some(r => r.roomName === cur)) {
        rm.value = cur;
        selectedRoom = cur;
    } else if (visibleRooms.length) {
        rm.value = visibleRooms[0].roomName;
        selectedRoom = visibleRooms[0].roomName;
    } else {
        selectedRoom = "";
    }
}

function readFiltersFromUI() {
    filters.scheduleType = currentScheduleType;
    filters.academicYear = aySelect() ? aySelect().value : "";
    filters.semester = semSelect() ? semSelect().value : "";
    filters.examType = examTypeSelect() ? examTypeSelect().value : "";
    filters.classStatus = classStatusSelect() ? classStatusSelect().value : "";
    filters.program = programSelect() ? programSelect().value : "";
    filters.section = sectionSelect() ? sectionSelect().value : "";
    filters.roomType = roomTypeSelect() ? roomTypeSelect().value : "";
    filters.room = roomSelect() ? roomSelect().value : "";
    if (filters.room) selectedRoom = filters.room;
}

function entryMatchesFilters(entry) {
    if (filters.academicYear && entry.academicYear !== filters.academicYear) return false;
    if (filters.semester && entry.semesterNorm !== filters.semester) return false;
    if (filters.program && entry.program !== filters.program) return false;
    if (filters.section && entry.section !== filters.section) return false;

    if (currentScheduleType === "class") {
        if (filters.classStatus && entry.status !== filters.classStatus) return false;
    } else {
        if (filters.examType && !normalise(entry.examType).includes(normalise(filters.examType))) return false;
    }

    return true;
}

/* ---------------- Room Counts & Tabs ---------------- */

function countEntriesForRoom(roomName) {
    const targetRoom = allRooms.find(r => r.roomName === roomName) || { roomName };

    if (currentScheduleType === "class") {
        return allClassEntries.filter(e =>
            entryMatchesRoom(e.room, targetRoom) &&
            String(e.time || "").toUpperCase() !== "TBA" &&
            entryMatchesFilters(e)
        ).length;
    } else {
        return allExamEntries.filter(e =>
            entryMatchesRoom(e.room, targetRoom) &&
            String(e.time || "").toUpperCase() !== "TBA" &&
            entryMatchesFilters(e)
        ).length;
    }
}

function renderRoomTabs() {
    const tabs = tabsEl();
    if (!tabs) return;
    tabs.innerHTML = "";
    const counter = counterEl();
    const visibleRooms = getVisibleRooms();

    if (!visibleRooms.length) {
        tabs.innerHTML = `<p class="ra-muted">No rooms match the selected room type filter.</p>`;
        if (counter) counter.textContent = "0 rooms";
        return;
    }

    if (counter) counter.textContent = `${visibleRooms.length} rooms`;

    if (!visibleRooms.some(r => r.roomName === selectedRoom)) {
        selectedRoom = visibleRooms[0].roomName;
        const rm = roomSelect();
        if (rm) rm.value = selectedRoom;
        filters.room = selectedRoom;
    }

    visibleRooms.forEach(room => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ra-room-tab" + (room.roomName === selectedRoom ? " active" : "");
        btn.dataset.room = room.roomName;

        const label = document.createElement("span");
        label.textContent = room.roomName;

        const badge = document.createElement("span");
        badge.className = "ra-tab-count";
        badge.textContent = countEntriesForRoom(room.roomName);

        btn.appendChild(label);
        btn.appendChild(badge);

        btn.addEventListener("click", () => {
            selectedRoom = room.roomName;
            filters.room = room.roomName;
            const rm = roomSelect();
            if (rm) rm.value = room.roomName;
            renderRoomTabs();
            renderCalendar();
        });

        tabs.appendChild(btn);
    });
}

/* ---------------- Conflict Detection ---------------- */

function entriesForSelectedRoom() {
    const targetRoom = allRooms.find(r => r.roomName === selectedRoom) || { roomName: selectedRoom };

    if (currentScheduleType === "class") {
        return allClassEntries.filter(e =>
            entryMatchesRoom(e.room, targetRoom) &&
            String(e.time || "").toUpperCase() !== "TBA" &&
            entryMatchesFilters(e)
        );
    } else {
        return allExamEntries.filter(e =>
            entryMatchesRoom(e.room, targetRoom) &&
            String(e.time || "").toUpperCase() !== "TBA" &&
            String(e.date || "").toUpperCase() !== "TBA" &&
            entryMatchesFilters(e)
        );
    }
}

function detectClassConflicts(classes) {
    const conflictKeys = new Set();
    const conflictTypes = new Map();
    const conflictList = [];

    const byDay = new Map();
    classes.forEach(c => {
        const d = String(c.day || "").trim();
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(c);
    });

    byDay.forEach((dayEntries, day) => {
        const isSharedRoom = isActivityGymOrCourtRoom(selectedRoom);

        // 1. Capacity check for Activity / Gymnasium / Covered Court (max 2 sections)
        if (isSharedRoom) {
            for (let i = 0; i < dayEntries.length; i++) {
                const a = dayEntries[i];
                const keyA = `${a.scheduleId}::${a.code}::${a.day}::${a.time}::${a.section}`;
                const overlapping = dayEntries.filter((b, j) => {
                    if (i === j) return false;
                    if (a.scheduleId === b.scheduleId && a.code === b.code && a.section === b.section && a.time === b.time) return false;
                    return timesOverlap(a.time, b.time);
                });
                const distinctSections = new Set([a.section, ...overlapping.map(o => o.section)].filter(Boolean));
                if (distinctSections.size > 2) {
                    conflictKeys.add(keyA);
                    conflictTypes.set(keyA, "CAPACITY_CONFLICT");
                    const secArray = Array.from(distinctSections);
                    const conflictId = `CAP_${day}_${a.time}_${secArray.sort().join("_")}`;
                    if (!conflictList.some(c => c.id === conflictId)) {
                        conflictList.push({
                            id: conflictId,
                            day,
                            time: a.time,
                            type: "CAPACITY_CONFLICT",
                            sections: secArray,
                            classA: a,
                            classB: overlapping[0]
                        });
                    }
                }
            }
        }

        // 2. Pairwise checks (Faculty conflict for shared rooms; Room conflict for regular rooms)
        for (let i = 0; i < dayEntries.length; i++) {
            for (let j = i + 1; j < dayEntries.length; j++) {
                const a = dayEntries[i];
                const b = dayEntries[j];

                if (a.scheduleId === b.scheduleId && a.code === b.code && a.section === b.section && a.time === b.time) {
                    continue;
                }

                if (timesOverlap(a.time, b.time)) {
                    const keyA = `${a.scheduleId}::${a.code}::${a.day}::${a.time}::${a.section}`;
                    const keyB = `${b.scheduleId}::${b.code}::${b.day}::${b.time}::${b.section}`;
                    const isShared = isActivityGymOrCourtRoom(a.room || selectedRoom) && isActivityGymOrCourtRoom(b.room || selectedRoom);

                    if (isShared) {
                        // In Activity / Gymnasium / Covered Court:
                        // ONLY marked as conflict if same faculty member is assigned on both sections
                        if (a.faculty && b.faculty && sameFaculty(a.faculty, b.faculty, a.facultyUid, b.facultyUid)) {
                            conflictKeys.add(keyA);
                            conflictKeys.add(keyB);
                            conflictTypes.set(keyA, "FACULTY_CONFLICT");
                            conflictTypes.set(keyB, "FACULTY_CONFLICT");

                            conflictList.push({
                                id: `FAC_${day}_${[a.section, b.section].sort().join("_")}_${a.time}`,
                                day,
                                time: a.time,
                                type: "FACULTY_CONFLICT",
                                faculty: a.faculty,
                                classA: a,
                                classB: b
                            });
                        }
                    } else {
                        // Regular single-section rooms (Lecture Room, Laboratory, etc.)
                        conflictKeys.add(keyA);
                        conflictKeys.add(keyB);
                        conflictTypes.set(keyA, "ROOM_CONFLICT");
                        conflictTypes.set(keyB, "ROOM_CONFLICT");

                        conflictList.push({
                            id: `ROOM_${day}_${[keyA, keyB].sort().join("___")}`,
                            day,
                            time: a.time,
                            type: "ROOM_CONFLICT",
                            classA: a,
                            classB: b
                        });
                    }
                }
            }
        }
    });

    return { conflictKeys, conflictTypes, conflictList };
}

function examConflictGroupKey(exam) {
    return `${String(exam.date || "").trim()}___${normalise(exam.time).replace(/\s+/g, "")}`;
}

function detectExamConflicts(exams) {
    const groups = new Map();
    exams.forEach(exam => {
        const gkey = examConflictGroupKey(exam);
        if (!groups.has(gkey)) groups.set(gkey, []);
        groups.get(gkey).push(exam);
    });
    const conflictKeys = new Set();
    const conflictList = [];
    groups.forEach((group, gkey) => {
        const unique = new Set(group.map(e => `${e.scheduleId}::${e.code}::${e.section}::${e._idx}`));
        if (group.length > 1 && unique.size > 1) {
            conflictKeys.add(gkey);
            conflictList.push({ key: gkey, date: group[0].date, time: group[0].time, exams: group });
        }
    });
    return { conflictKeys, conflictList };
}

/* ---------------- Calendar Layout Helpers ---------------- */

function buildSubjectColorMap(entries) {
    const map = new Map();
    let colorIndex = 1;
    for (const entry of entries) {
        const key = String(entry.code || entry.name || "").trim().toUpperCase();
        if (!key) continue;
        if (!map.has(key)) {
            map.set(key, `cal-block-color-${colorIndex}`);
            colorIndex = (colorIndex % TOTAL_CALENDAR_COLORS) + 1;
        }
    }
    return map;
}

function groupOverlaps(blocks) {
    const sorted = [...blocks].sort((a, b) => a.start - b.start);
    const clusters = [];
    let current = [];
    for (const block of sorted) {
        if (!current.length) {
            current.push(block);
        } else {
            const maxEnd = Math.max(...current.map(b => b.end));
            if (block.start < maxEnd) {
                current.push(block);
            } else {
                clusters.push(current);
                current = [block];
            }
        }
    }
    if (current.length) clusters.push(current);
    return clusters;
}

function buildHourLines() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-hour-line" style="top:${top}px"></div>`;
    }
    return html;
}

function buildTimeLabels() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-time-label" style="top:${top}px">${escapeHtml(minutesToDisplay(mins))}</div>`;
    }
    return html;
}

/**
 * Builds positioned blocks for Class Schedule in a day column.
 */
function buildClassDayBlocks(classes, day, colorMap, conflictKeys, conflictTypes) {
    const dayBlocks = [];
    classes.forEach(c => {
        if (String(c.day || "").trim().toLowerCase() !== day.toLowerCase()) return;
        const parsed = parseTimeToMinutes(c.time);
        if (!parsed) return;
        dayBlocks.push({ ...c, start: parsed.start, end: parsed.end });
    });

    if (!dayBlocks.length) return { html: "", count: 0 };

    dayBlocks.sort((a, b) =>
        a.start - b.start ||
        String(a.section).localeCompare(String(b.section))
    );

    const clusters = groupOverlaps(dayBlocks);
    let html = "";
    let count = 0;

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd = Math.min(block.end, CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;
            count++;

            const top = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 32);
            const widthPct = 100 / colCount;
            const leftPct = widthPct * colIndex;

            const blockKey = `${block.scheduleId}::${block.code}::${block.day}::${block.time}::${block.section}`;
            const isConflict = conflictKeys.has(blockKey);
            const conflictType = conflictTypes ? conflictTypes.get(blockKey) : (isConflict ? "ROOM_CONFLICT" : null);
            let conflictChipText = "Room conflict";
            if (conflictType === "FACULTY_CONFLICT") {
                conflictChipText = "Faculty conflict";
            } else if (conflictType === "CAPACITY_CONFLICT") {
                conflictChipText = "Capacity conflict";
            }
            const subjectKey = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass = colorMap.get(subjectKey) || `cal-block-color-${(colIndex % TOTAL_CALENDAR_COLORS) + 1}`;

            const facultyLabel = escapeHtml(block.faculty || "Unassigned");
            const statusLabel = block.status === "published" ? "✓ Published" : "Draft";

            const calendarHeightPx = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
            const growDelta = Math.max(EXPANDED_CARD_MIN_HEIGHT - height, 0);
            const expandUp = growDelta > 0 && (top + EXPANDED_CARD_MIN_HEIGHT > calendarHeightPx) && top >= growDelta;

            html += `
<div class="cal-block${isConflict ? " ra-conflict-card" : ""}${expandUp ? " ra-expand-up" : ""} ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);--ra-grow:${growDelta.toFixed(1)}px;" title="${escapeHtml(block.code)} — ${escapeHtml(block.name)}&#10;Section: ${escapeHtml(block.section)} | ${escapeHtml(block.day)} | ${formatTimeDisplay(block.time)} | Room: ${escapeHtml(block.room)} | Faculty: ${facultyLabel}">
  ${isConflict ? `<span class="ra-conflict-chip">${conflictChipText}</span>` : ""}
  <div class="ra-card-section">${escapeHtml(block.section || "—")}</div>
  <div class="ra-card-subject">${escapeHtml(block.name || block.code || "—")}${block.code ? ` <span class="ra-card-code">(${escapeHtml(block.code)})</span>` : ""}</div>
  <span class="ra-examtype-badge" style="${block.status === 'published' ? 'background:#e8f5e9;color:#1b5e20;' : 'background:#eceff1;color:#455a64;'}">${escapeHtml(statusLabel)}</span>
  <div class="ra-card-meta">
    <div><span class="ra-meta-label">Day:</span><span>${escapeHtml(block.day)}</span></div>
    <div><span class="ra-meta-label">Time:</span><span>${formatTimeDisplay(block.time)}</span></div>
    <div><span class="ra-meta-label">Room:</span><span>${escapeHtml(block.room)}</span></div>
    <div><span class="ra-meta-label">Faculty:</span><span>${facultyLabel}</span></div>
  </div>
</div>`;
        });
    }

    return { html, count };
}

/**
 * Builds positioned blocks for Exam Schedule in a day column.
 */
function buildExamDayBlocks(exams, day, colorMap, conflictKeys) {
    const dayBlocks = [];
    exams.forEach(exam => {
        if (String(exam.day || "").trim().toLowerCase() !== day.toLowerCase()) return;
        const parsed = parseTimeToMinutes(exam.time);
        if (!parsed) return;
        dayBlocks.push({ ...exam, start: parsed.start, end: parsed.end });
    });

    if (!dayBlocks.length) return { html: "", count: 0 };

    dayBlocks.sort((a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        a.start - b.start ||
        String(a.section).localeCompare(String(b.section))
    );

    const clusters = groupOverlaps(dayBlocks);
    let html = "";
    let count = 0;

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd = Math.min(block.end, CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;
            count++;

            const top = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct = 100 / colCount;
            const leftPct = widthPct * colIndex;

            const isConflict = conflictKeys.has(examConflictGroupKey(block));
            const subjectKey = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass = colorMap.get(subjectKey) || `cal-block-color-${(colIndex % TOTAL_CALENDAR_COLORS) + 1}`;

            const dateLabel = escapeHtml(formatDateDisplay(block.date));
            const dayLabel = block.day ? ` - ${escapeHtml(block.day)}` : "";
            const proctorLabel = escapeHtml(block.proctor || "TBA");

            const calendarHeightPx = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
            const growDelta = Math.max(EXPANDED_CARD_MIN_HEIGHT - height, 0);
            const expandUp = growDelta > 0 && (top + EXPANDED_CARD_MIN_HEIGHT > calendarHeightPx) && top >= growDelta;

            html += `
<div class="cal-block${isConflict ? " ra-conflict-card" : ""}${expandUp ? " ra-expand-up" : ""} ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);--ra-grow:${growDelta.toFixed(1)}px;" title="${escapeHtml(block.code)} — ${escapeHtml(block.name)}&#10;${escapeHtml(formatExamType(block.examType))} | ${escapeHtml(block.section)} | ${escapeHtml(formatDateDisplay(block.date))} | ${formatTimeDisplay(block.time)} | Room: ${escapeHtml(block.room)} | Proctor: ${proctorLabel}">
  ${isConflict ? `<span class="ra-conflict-chip">Room conflict</span>` : ""}
  <div class="ra-card-section">${escapeHtml(block.section || "—")}</div>
  <div class="ra-card-subject">${escapeHtml(block.name || block.code || "—")}${block.code ? ` <span class="ra-card-code">(${escapeHtml(block.code)})</span>` : ""}</div>
  <span class="ra-examtype-badge">${escapeHtml(formatExamType(block.examType))}</span>
  <div class="ra-card-meta">
    <div><span class="ra-meta-label">Date:</span><span>${dateLabel}${dayLabel}</span></div>
    <div><span class="ra-meta-label">Time:</span><span>${formatTimeDisplay(block.time)}</span></div>
    <div><span class="ra-meta-label">Room:</span><span>${escapeHtml(block.room)}</span></div>
    <div><span class="ra-meta-label">Proctor:</span><span>${proctorLabel}</span></div>
  </div>
</div>`;
        });
    }

    return { html, count };
}

/* ---------------- Render Calendar ---------------- */

function renderCalendar() {
    const cal = calendarEl();
    if (!cal) return;
    readFiltersFromUI();

    const summary = summaryEl();
    const banner = conflictBannerEl();
    const title = calendarTitleEl();
    const subtitle = calendarSubtitleEl();
    const legend = legendEl();
    const visibleRooms = getVisibleRooms();

    if (!visibleRooms.length || !selectedRoom) {
        cal.innerHTML = `<p class="ra-empty">No rooms available for the selected filters.</p>`;
        if (summary) summary.innerHTML = "";
        if (banner) banner.style.display = "none";
        if (title) title.textContent = "Weekly Room Usage";
        return;
    }

    const isClass = currentScheduleType === "class";
    const entries = entriesForSelectedRoom();

    if (title) {
        title.textContent = isClass
            ? `Weekly Class Schedule Room Usage — ${selectedRoom}`
            : `Weekly Examination Room Usage — ${selectedRoom}`;
    }

    if (subtitle) {
        const parts = [];
        if (filters.academicYear) parts.push(`A.Y. ${filters.academicYear}`);
        if (filters.semester) parts.push(filters.semester);
        if (isClass) {
            if (filters.classStatus) parts.push(filters.classStatus === "published" ? "Published" : "Draft");
        } else {
            if (filters.examType) parts.push(formatExamType(filters.examType));
        }
        if (filters.program) parts.push(filters.program);
        if (filters.section) parts.push(filters.section);
        subtitle.textContent = parts.length
            ? `Monitoring ${isClass ? 'class' : 'exam'} room assignment — ${parts.join(" • ")}`
            : `Monitoring room assignment for ${selectedRoom}.`;
    }

    if (legend) {
        legend.innerHTML = `
            <span class="ra-legend-item"><span class="ra-legend-swatch occupied"></span> Occupied — ${isClass ? 'class scheduled' : 'examination assigned'}</span>
            <span class="ra-legend-item"><span class="ra-legend-swatch conflict"></span> Room conflict — two or more ${isClass ? 'classes' : 'exams'} in the same room &amp; time</span>
        `;
    }

    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
    const colorMap = buildSubjectColorMap(entries);
    let placedCount = 0;

    let foundConflicts = { conflictKeys: new Set(), conflictList: [] };
    if (isClass) {
        foundConflicts = detectClassConflicts(entries);
    } else {
        foundConflicts = detectExamConflicts(entries);
    }

    const dayColumnsHtml = WEEKDAYS.map(day => {
        const blocks = isClass
            ? buildClassDayBlocks(entries, day, colorMap, foundConflicts.conflictKeys, foundConflicts.conflictTypes)
            : buildExamDayBlocks(entries, day, colorMap, foundConflicts.conflictKeys);

        placedCount += blocks.count;

        return `
<div class="cal-day-col">
  <div class="cal-day-header"><span class="cal-day-name">${escapeHtml(day)}</span></div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks.html}
  </div>
</div>`;
    }).join("");

    cal.innerHTML = `
<div class="cal-timetable-wrapper">
  <div class="cal-timetable">
    <div class="cal-time-col">
      <div class="cal-time-header"></div>
      <div class="cal-time-body" style="height:${calendarHeight}px">
        ${buildTimeLabels()}
      </div>
    </div>
    ${dayColumnsHtml}
  </div>
</div>`;

    const empty = emptyEl();
    if (empty) empty.style.display = "none";

    const outOfGrid = entries.filter(e => !WEEKDAYS.includes(String(e.day || "").trim())).length;
    if (summary) {
        const itemLabel = isClass ? "classes" : "exams";
        summary.innerHTML =
            `<span class="ra-summary-chip ra-chip-total"><b>${entries.length}</b>&nbsp;${itemLabel}</span>` +
            `<span class="ra-summary-chip ra-chip-occupied"><b>${placedCount}</b>&nbsp;occupied</span>` +
            `<span class="ra-summary-chip ra-chip-conflict"><b>${foundConflicts.conflictList.length}</b>&nbsp;conflicts</span>` +
            (outOfGrid ? `<span class="ra-summary-chip"><b>${outOfGrid}</b>&nbsp;outside Mon-Fri</span>` : "");
    }

    if (banner) {
        if (foundConflicts.conflictList.length) {
            let items = "";
            if (isClass) {
                foundConflicts.conflictList.slice(0, 8).forEach(c => {
                    if (c.type === "FACULTY_CONFLICT") {
                        items += `<li><strong>${escapeHtml(c.day)}</strong> at <strong>${formatTimeDisplay(c.time)}</strong> — Faculty conflict: <strong>${escapeHtml(c.faculty || "Faculty")}</strong> is double-booked between ${escapeHtml(c.classA.section)} (${escapeHtml(c.classA.code)}) and ${escapeHtml(c.classB.section)} (${escapeHtml(c.classB.code)})</li>`;
                    } else if (c.type === "CAPACITY_CONFLICT") {
                        const secList = (c.sections || []).map(escapeHtml).join(", ");
                        items += `<li><strong>${escapeHtml(c.day)}</strong> at <strong>${formatTimeDisplay(c.time)}</strong> — Room capacity exceeded: ${c.sections ? c.sections.length : 3} sections (${secList}) scheduled simultaneously (maximum allowed: 2)</li>`;
                    } else {
                        items += `<li><strong>${escapeHtml(c.day)}</strong> at <strong>${formatTimeDisplay(c.time)}</strong> — ${escapeHtml(c.classA.section)} (${escapeHtml(c.classA.code)}) clashes with ${escapeHtml(c.classB.section)} (${escapeHtml(c.classB.code)})</li>`;
                    }
                });
                if (foundConflicts.conflictList.length > 8) items += `<li>...and ${foundConflicts.conflictList.length - 8} more.</li>`;
                banner.innerHTML = `<span class="ra-cb-icon">!</span><div><div class="ra-cb-title">Schedule conflict in ${escapeHtml(selectedRoom)} — resolve on <a href="class.html" style="color:#b71c1c; text-decoration:underline; font-weight:bold;">Class Scheduling</a> page.</div><ul class="ra-cb-list">${items}</ul></div>`;
            } else {
                foundConflicts.conflictList.slice(0, 8).forEach(c => {
                    const sections = [...new Set(c.exams.map(e => e.section))].map(escapeHtml).join(", ");
                    const codes = [...new Set(c.exams.map(e => e.code))].map(escapeHtml).join(", ");
                    items += `<li><strong>${escapeHtml(formatDateDisplay(c.date))}</strong> at <strong>${formatTimeDisplay(c.time)}</strong> — ${sections} (${codes})</li>`;
                });
                if (foundConflicts.conflictList.length > 8) items += `<li>...and ${foundConflicts.conflictList.length - 8} more.</li>`;
                banner.innerHTML = `<span class="ra-cb-icon">!</span><div><div class="ra-cb-title">Room conflict in ${escapeHtml(selectedRoom)} — resolve on <a href="exam.html" style="color:#b71c1c; text-decoration:underline; font-weight:bold;">Exam Schedule</a> page.</div><ul class="ra-cb-list">${items}</ul></div>`;
            }
            banner.style.display = "flex";
        } else {
            banner.style.display = "none";
            banner.innerHTML = "";
        }
    }

    const tabs = tabsEl();
    if (tabs) {
        tabs.querySelectorAll(".ra-room-tab").forEach(btn => {
            const badge = btn.querySelector(".ra-tab-count");
            if (badge) badge.textContent = countEntriesForRoom(btn.dataset.room);
        });
    }
}

/* ---------------- Schedule Type Switching ---------------- */

function setScheduleType(type) {
    if (currentScheduleType === type) return;
    currentScheduleType = type;

    if (type === "class") {
        typeBtnClass()?.classList.add("active");
        typeBtnExam()?.classList.remove("active");
        if (examTypeControl()) examTypeControl().style.display = "none";
        if (classStatusControl()) classStatusControl().style.display = "flex";
    } else {
        typeBtnExam()?.classList.add("active");
        typeBtnClass()?.classList.remove("active");
        if (examTypeControl()) examTypeControl().style.display = "flex";
        if (classStatusControl()) classStatusControl().style.display = "none";
    }

    populateFilterOptions();
    renderRoomTabs();
    renderCalendar();
}

/* ---------------- Event Listeners & Init ---------------- */

function bindFilterEvents() {
    typeBtnClass()?.addEventListener("click", () => setScheduleType("class"));
    typeBtnExam()?.addEventListener("click", () => setScheduleType("exam"));

    [aySelect(), semSelect(), examTypeSelect(), classStatusSelect(), programSelect(), sectionSelect()].forEach(sel => {
        sel?.addEventListener("change", () => {
            renderRoomTabs();
            renderCalendar();
        });
    });

    roomTypeSelect()?.addEventListener("change", () => {
        filters.roomType = roomTypeSelect()?.value || "";
        populateRoomDropdown();
        renderRoomTabs();
        renderCalendar();
    });

    roomSelect()?.addEventListener("change", () => {
        const rm = roomSelect();
        if (rm && rm.value) {
            selectedRoom = rm.value;
            filters.room = rm.value;
            renderRoomTabs();
            renderCalendar();
        }
    });
}

document.addEventListener("click", event => {
    if (event.target.id === "customToastClose" || event.target.id === "customToast") {
        const toast = $("customToast");
        if (toast) toast.style.display = "none";
    }
});

$("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try { await signOut(auth); } catch (e) { console.error("Sign out error:", e); }
    window.location.replace("login.html");
});

async function init() {
    try {
        await Promise.all([
            loadRooms(),
            loadClassSchedules(),
            loadExamSchedules()
        ]);

        populateFilterOptions();

        if (allRooms.length) {
            selectedRoom = allRooms[0].roomName;
            filters.room = selectedRoom;
            const rm = roomSelect();
            if (rm) rm.value = selectedRoom;
        }

        bindFilterEvents();
        renderRoomTabs();
        renderCalendar();
    } catch (err) {
        console.error("Room Allocation init error:", err);
        const cal = calendarEl();
        if (cal) cal.innerHTML = `<p class="ra-empty">Could not load room allocation data.</p>`;
        showToast("Could not load room allocation data. Please check your connection and refresh.");
    }
}

onAuthStateChanged(auth, user => {
    if (!user) {
        window.location.replace("login.html");
    } else {
        init();
    }
});
