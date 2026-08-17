import { db, auth } from "../firebase.js";
import { saveReportToFirestore, loadReportsFromFirestore } from "./reportStorage.js";

import {
    collection,
    getDocs,
    doc,
    setDoc,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

/*
 * The class page saves its schedules in localStorage.  This page deliberately
 * uses the same key, so no change is needed in class.js.
 */
const CLASS_SCHEDULES_KEY = "chairpersonSavedSchedules";
const EXAM_SCHEDULES_KEY = "chairpersonExamSchedules";

const savedScheduleBody = document.getElementById("savedScheduleTable");
const examModalBody = document.getElementById("examModalBody");
const generateExamBtn = document.getElementById("generateExamBtn");
const saveExamBtn = document.getElementById("saveExamBtn");
const examModal = document.getElementById("examModal");
const savedOverlay = document.getElementById("savedOverlay");
const examTypeSelect = document.getElementById("examType");
const examDateInput = document.getElementById("examDateInput");
const selectedDatesContainer = document.getElementById("selectedDatesContainer");
const academicYearFilter = document.getElementById("academicYearFilter");
const semesterFilter = document.getElementById("semesterFilter");
const searchInput = document.getElementById("searchInput");
const filterMessage = document.getElementById("filterMessage");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");

let displayedClassSchedules = [];
let generatedExamSchedules = [];
let facultyMembers = [];
let selectedDates = [];
let DAYS = [];
let firestoreExamSchedules = [];

let selectedAcademicYear = "";
let selectedSemester = "";
let groupedSections = [];
let filteredSections = [];

let cachedExamReports = [];
let archiveFilterYear = "";
let archiveFilterSemester = "";
let archiveFilterExamType = "";
let archiveFilterSearch = "";

const EXAM_TYPES = ["Preliminary", "Midterm", "Final"];

/* ------------------------------------------------------------------ */
/*  Custom centered notification system (replaces browser alert/confirm) */
/* ------------------------------------------------------------------ */

let toastTimeout = null;

function showToast(message) {
    const toast = document.getElementById("customToast");
    const msgEl = document.getElementById("customToastMessage");
    if (!toast || !msgEl) { alert(message); return; }
    msgEl.textContent = message;
    toast.style.display = "flex";

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        hideToast();
}, 3000);
}

function hideToast() {
    const toast = document.getElementById("customToast");
    if (toast) toast.style.display = "none";
    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }
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

/* ------------------------------------------------------------------ */
/*  Multi-date picker management                                       */
/* ------------------------------------------------------------------ */

function getDayName(dateStr) {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", { weekday: "long" });
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return "";
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    return date.toLocaleDateString("en-US", options);
}

function renderSelectedDates() {
    if (!selectedDatesContainer) return;
    if (!selectedDates.length) {
        selectedDatesContainer.innerHTML = '<span class="date-chips-empty">No dates selected yet. Add at least one exam date.</span>';
        return;
    }
    selectedDatesContainer.innerHTML = selectedDates.map((dateStr, index) => `
        <span class="date-chip">
            ${escapeHtml(formatDateDisplay(dateStr))}
            <button type="button" class="remove-date" data-index="${index}" title="Remove date">&times;</button>
        </span>
    `).join("");

    // Attach remove handlers
    selectedDatesContainer.querySelectorAll(".remove-date").forEach(btn => {
        btn.addEventListener("click", function () {
            const idx = parseInt(this.dataset.index, 10);
            removeDate(idx);
        });
    });
}

function addDate() {
    if (!examDateInput || !examDateInput.value) {
        showToast("Please select a date first.");
        return;
    }
    const dateStr = examDateInput.value;

    // Check for duplicates
    if (selectedDates.includes(dateStr)) {
        showToast("This date is already selected.");
        return;
    }

    selectedDates.push(dateStr);
    // Sort chronologically
    selectedDates.sort((a, b) => a.localeCompare(b));
    updateDAYS();
    renderSelectedDates();
    examDateInput.value = "";
}

function removeDate(index) {
    if (index < 0 || index >= selectedDates.length) return;
    selectedDates.splice(index, 1);
    updateDAYS();
    renderSelectedDates();
}

function updateDAYS() {
    DAYS = selectedDates.map(dateStr => getDayName(dateStr));
}

/* ------------------------------------------------------------------ */
/*  Modal close handlers                                               */
/* ------------------------------------------------------------------ */

document.querySelector("#examModal .close-modal").addEventListener("click", () => {
    examModal.style.display = "none";
    // Clear generated data when modal is closed so previous section data doesn't persist
    generatedExamSchedules = [];
    saveExamBtn.disabled = true;
    renderGeneratedExams();
});

window.addEventListener("click", event => {
    if (event.target === examModal) {
        examModal.style.display = "none";
        // Clear generated data when modal is closed so previous section data doesn't persist
        generatedExamSchedules = [];
        saveExamBtn.disabled = true;
        renderGeneratedExams();
    }
});

const DAY_START = 8 * 60;
const DAY_END = 17 * 60 + 30;
const LUNCH_START = 12 * 60;
const LUNCH_END = 13 * 60;
const BREAK_MINUTES = 60;
const MAX_SUBJECTS_PER_DAY = 4;
const PM_END = 14 * 60 + 30; // 2:30 PM — all PM exams must end by this time
const EXAM_ROOM_BUILDINGS = ["Building A", "Building B", "Admin Building"];

/**
 * Returns the preferred exam building for a given program.
 * - BIT / BINDTECH → Building B (first choice), Admin Building (overflow)
 * - BTVTED        → Building A (first choice), Admin Building (overflow)
 */
function getExamBuildingPriority(program) {
    const prog = normalise(program);
    if (prog === "bit" || prog === "bindtech") return "Building B";
    if (prog === "btvted") return "Building A";
    return null; // No specific preference
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function readStorage(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function writeStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function minutesToTime(minutes) {
    const hours24 = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const hours12 = hours24 % 12 || 12; // convert 0 → 12, 13 → 1, etc.
    const ampm = hours24 < 12 ? "AM" : "PM";
    return `${hours12}:${String(mins).padStart(2, "0")}${ampm}`;
}

function timeRange(start, duration) {
    return `${minutesToTime(start)}-${minutesToTime(start + duration)}`;
}

function parseTime(time) {
    const [hours, minutes] = String(time || "").split(":").map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes)
        ? hours * 60 + minutes
        : NaN;
}

function intervalsOverlap(first, second) {
    return first.start < second.end && second.start < first.end;
}

function splitRange(range) {
    const [startText, endText] = String(range || "").split("-");
    const start = parseTime(startText);
    const end = parseTime(endText);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function normalise(value) {
    return String(value ?? "").trim().toLowerCase();
}

function scheduleTitle(schedule) {
    return schedule.name || `${schedule.section || "Untitled"}`;
}

function subjectCount(schedule) {
    /* Use subjectCode as the unique identifier when possible.
       Fall back to code/name if subjectCode is not present. */
    return new Set((schedule.entries || []).map(entry =>
        entry.subjectCode || entry.code || entry.name
    )).size;
}

/**
 * Exam status is based on Academic Year + Semester + Section + Exam Type.
 * Exam status from another semester or academic year must NEVER affect
 * the selected semester.
 */
function examStatusForSchedule(schedule, examType) {
    const ay = schedule.academicYear || "";
    const sem = schedule.semester || "";
    const section = schedule.section || "";

    return firestoreExamSchedules.some(saved =>
        saved.examType === examType &&
        (saved.academicYear || "") === ay &&
        (saved.semester || "") === sem &&
        normalise(saved.section) === normalise(section)
    );
}

/* ------------------------------------------------------------------ */
/*  Academic Year + Semester filter helpers                            */
/* ------------------------------------------------------------------ */

function populateAcademicYearFilter() {
    if (!academicYearFilter) return;
    const currentValue = academicYearFilter.value;
    const years = [...new Set(displayedClassSchedules
        .map(schedule => schedule.academicYear || "")
        .filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));

    academicYearFilter.innerHTML = '<option value="">Select Academic Year</option>' +
        years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");

    /* Preserve the user's current selection */
    if (currentValue) academicYearFilter.value = currentValue;
}

function populateSemesterFilter() {
    if (!semesterFilter) return;
    const currentValue = semesterFilter.value;
    const semesters = [...new Set(displayedClassSchedules
        .map(schedule => schedule.semester || "")
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    semesterFilter.innerHTML = '<option value="">Select Semester</option>' +
        semesters.map(sem => `<option value="${escapeHtml(sem)}">${escapeHtml(sem)}</option>`).join("");

    /* Preserve the user's current selection */
    if (currentValue) semesterFilter.value = currentValue;
}

/**
 * Group class schedules by Academic Year + Semester + Section.
 * Sections with the same AY + Semester + Section are combined into one row.
 * Sections from different semesters or academic years are NEVER combined.
 */
function groupSectionsByAYSemesterSection(schedules) {
    const groups = new Map();

    for (const schedule of schedules) {
        const ay = schedule.academicYear || "";
        const sem = schedule.semester || "";
        const section = schedule.section || "";
        const key = `${ay}|${sem}|${section}`;

        if (!groups.has(key)) {
            groups.set(key, {
                id: schedule.id,
                section,
                academicYear: ay,
                semester: sem,
                program: schedule.program || "",
                major: schedule.major || "",
                yearLevel: schedule.yearLevel || "",
                entries: [],
                rawEntries: [],
                schedules: []
            });
        }

        const group = groups.get(key);
        group.schedules.push(schedule);

        /* Merge entries, deduplicating by subjectCode/code/name */
        const seen = new Set(group.entries.map(entry => entry.subjectCode || entry.code || entry.name));
        for (const entry of (schedule.entries || [])) {
            const entryKey = entry.subjectCode || entry.code || entry.name;
            if (!seen.has(entryKey)) {
                seen.add(entryKey);
                group.entries.push(entry);
            }
        }

        /* Merge rawEntries */
        const rawSeen = new Set(group.rawEntries.map(raw => raw.code || raw.name));
        for (const raw of (schedule.rawEntries || [])) {
            const rawKey = raw.code || raw.name;
            if (!rawSeen.has(rawKey)) {
                rawSeen.add(rawKey);
                group.rawEntries.push(raw);
            }
        }
    }

    return [...groups.values()];
}

/**
 * Processing order:
 * 1. Load class schedules.
 * 2. Filter by Academic Year.
 * 3. Filter by Semester.
 * 4. Include active/archived schedules.
 * 5. Group by Section.
 * 6. Remove duplicate subjects.
 * 7. Calculate subject count.
 * 8. Check Preliminary/Midterm/Final status.
 * 9. Render all matching sections in the scrollable table.
 */
function applyFiltersAndGroup() {
    const allSchedules = readStorage(CLASS_SCHEDULES_KEY);

    /* 1. Load class schedules (done above) */

    /* 2. Filter by Academic Year */
    let filtered = allSchedules;
    if (selectedAcademicYear) {
        filtered = filtered.filter(schedule => (schedule.academicYear || "") === selectedAcademicYear);
    }

    /* 3. Filter by Semester */
    if (selectedSemester) {
        filtered = filtered.filter(schedule => (schedule.semester || "") === selectedSemester);
    }

    /* 4. Include active/archived schedules — no status filter, both are included */

    /* 5. Group by Section (AY + Semester + Section) */
    groupedSections = groupSectionsByAYSemesterSection(filtered);

    /* 6. Remove duplicate subjects (done inside groupSectionsByAYSemesterSection) */

    /* 7. Calculate subject count (done in render via subjectCount) */

    /* 8. Check Preliminary/Midterm/Final status (done in render via examStatusForSchedule) */

    /* 11. Search within the currently selected AY + Semester */
    const searchTerm = normalise(searchInput?.value || "");
    if (searchTerm) {
        filteredSections = groupedSections.filter(group =>
            normalise(group.section).includes(searchTerm) ||
            normalise(group.program).includes(searchTerm) ||
            normalise(group.major).includes(searchTerm)
        );
    } else {
        filteredSections = [...groupedSections];
    }
}

function renderClassSchedules() {
    displayedClassSchedules = readStorage(CLASS_SCHEDULES_KEY);

    /* Populate filter dropdowns from all available schedules */
    populateAcademicYearFilter();
    populateSemesterFilter();

    /* If no AY + Semester selected, show the prompt message */
    if (!selectedAcademicYear || !selectedSemester) {
        if (filterMessage) filterMessage.style.display = "block";
        savedScheduleBody.innerHTML = `<tr><td colspan="6">Select an Academic Year and Semester to view class schedules.</td></tr>`;
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        return;
    }

    if (filterMessage) filterMessage.style.display = "none";

    if (!displayedClassSchedules.length) {
        savedScheduleBody.innerHTML = `<tr><td colspan="6">No saved class schedules found.</td></tr>`;
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        return;
    }

    /* Apply filters + grouping (recompute if needed) */
    if (!groupedSections.length) {
        applyFiltersAndGroup();
    }

    if (!filteredSections.length) {
        savedScheduleBody.innerHTML = `<tr><td colspan="6">No class schedules found for the selected Academic Year and Semester.</td></tr>`;
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        return;
    }

    /* Render all matching sections into the scrollable table */
    savedScheduleBody.innerHTML = filteredSections.map(group => {
        const statusCell = examType => examStatusForSchedule(group, examType)
            ? '<span class="exam-status generated">&#10003; Generated</span>'
            : '<span class="exam-status not-generated">&mdash;</span>';

        return `
        <tr>
            <td>
                <input type="checkbox" class="schedule-check" value="${escapeHtml(group.id)}" aria-label="Select ${escapeHtml(group.section)}">
            </td>
            <td>${escapeHtml(group.section)}</td>
            <td>${subjectCount(group)}</td>
            <td>${statusCell("Preliminary")}</td>
            <td>${statusCell("Midterm")}</td>
            <td>${statusCell("Final")}</td>
        </tr>
    `}).join("");

    /* Reset Select All state */
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
}

function facultyName(data) {
    return data.name || data.fullName || data.facultyName || data.displayName ||
        [data.firstName, data.lastName].filter(Boolean).join(" ") || "";
}

async function loadFaculty() {
    try {
        const userSnapshot = await getDocs(collection(db, "users"));
        const registeredFaculty = userSnapshot.docs
            .map(document => ({
                id: document.id,
                ...document.data()
            }))
            .filter(user => normalise(user.role) === "faculty")
            .map(user => ({
                id: user.id,
                name: facultyName(user),
                ...user
            }))
            .filter(member => member.name);

        const legacyFaculty = await getDocs(collection(db, "faculty"));
        const legacyFacultyMembers = legacyFaculty.docs
            .map(document => ({
                id: document.id,
                name: facultyName(document.data()),
                ...document.data()
            }))
            .filter(member => member.name);

        const combined = [...registeredFaculty, ...legacyFacultyMembers];
        const unique = new Map();
        for (const member of combined) {
            const key = normalise(member.name);
            if (!unique.has(key)) {
                unique.set(key, member);
            }
        }

        facultyMembers = [...unique.values()];
        return facultyMembers;
    } catch (error) {
        console.error(error);
        showToast(`Could not load faculty: ${error.message}`);
        return [];
    }
}

async function loadProspectusSubjects() {
    try {
        const snapshot = await getDocs(collection(db, "prospectus"));
        return snapshot.docs.map(document => document.data());
    } catch (error) {
        console.error(error);
        showToast(`Could not load subject types from the prospectus: ${error.message}`);
        return [];
    }
}

/**
 * Normalise a semester/year-level value to its numeric string form.
 * Handles:
 *   - "1st Semester" → "1"
 *   - "2nd Year"      → "2"
 *   - 1 (number)      → "1"
 *   - "1"             → "1"
 */
function numericSemesterYear(value) {
    const str = String(value ?? "").trim().toLowerCase();
    const match = str.match(/(\d+)/);
    return match ? match[1] : str;
}

function findProspectusSubject(entry, schedule, prospectus) {
    const semNormalized = numericSemesterYear(schedule.semester);
    const yrNormalized = numericSemesterYear(schedule.yearLevel);

    // Exact match using numeric semester/year comparison
    const exactMatch = prospectus.find(subject =>
        normalise(subject.subjectCode) === normalise(entry.code) &&
        normalise(subject.programCode) === normalise(schedule.program) &&
        normalise(subject.majorCode) === normalise(schedule.major) &&
        numericSemesterYear(subject.yearLevel) === yrNormalized &&
        numericSemesterYear(subject.semester) === semNormalized
    );
    if (exactMatch) return exactMatch;

    // Fallback: match by subjectCode + programCode + majorCode
    // This prevents picking up a subject from a different program (e.g. BINDTECH vs BIT)
    return prospectus.find(subject =>
        normalise(subject.subjectCode) === normalise(entry.code) &&
        normalise(subject.programCode) === normalise(schedule.program) &&
        normalise(subject.majorCode) === normalise(schedule.major)
    );
}

function getRoomForSubject(schedule, entry) {
    const matchingRawEntry = (schedule.rawEntries || []).find(raw =>
        normalise(raw.code) === normalise(entry.code) && (raw.room || raw.roomCode)
    );
    return matchingRawEntry?.room || matchingRawEntry?.roomCode ||
        String(entry.room || "").split(" / ")[0].trim() || "TBA";
}

function buildExamSubjects(schedule, prospectus) {
    const seen = new Set();
    const subjects = (schedule.entries || []).flatMap(entry => {
        const key = normalise(entry.code || entry.name);
        if (!key || seen.has(key)) return [];
        seen.add(key);

        const prospectusSubject = findProspectusSubject(entry, schedule, prospectus);
        const type = normalise(prospectusSubject?.subjectType || entry.subjectType);
        const isMajor = type === "major";
        return [{
            code: entry.code || "",
            name: entry.name || "",
            room: getRoomForSubject(schedule, entry),
            subjectType: isMajor ? "Major" : "Minor",
            duration: isMajor ? 90 : 60
        }];
    });

    // Separate minors (60 min) and majors (90 min)
    const minors = subjects.filter(s => s.duration === 60);
    const majors = subjects.filter(s => s.duration === 90);

    // Interleave starting with minor: minor1, major1, minor2, major2, ...
    // This ensures 8:00 AM starts with a minor, then a major at 9:00, etc.
    const interleaved = [];
    let m = 0, M = 0;
    let nextIsMinor = true;
    while (m < minors.length || M < majors.length) {
        if (nextIsMinor && m < minors.length) {
            interleaved.push(minors[m]);
            m++;
        } else if (!nextIsMinor && M < majors.length) {
            interleaved.push(majors[M]);
            M++;
        } else if (m < minors.length) {
            interleaved.push(minors[m]);
            m++;
        } else if (M < majors.length) {
            interleaved.push(majors[M]);
            M++;
        }
        nextIsMinor = !nextIsMinor;
    }
    return interleaved;
}

function shuffled(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const replacementIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[replacementIndex]] = [copy[replacementIndex], copy[index]];
    }
    return copy;
}

async function loadLectureRooms() {
    try {
        const snapshot = await getDocs(collection(db, "rooms"));
        const allRooms = snapshot.docs
            .map(document => document.data())
            .filter(room =>
                normalise(room.roomType) === "lecture room" &&
                EXAM_ROOM_BUILDINGS.some(building =>
                    normalise(room.building) === normalise(building)
                )
            );

        // Organise rooms by building for easier lookup
        const byBuilding = {};
        for (const room of allRooms) {
            const building = normalise(room.building);
            if (!byBuilding[building]) byBuilding[building] = [];
            byBuilding[building].push(room);
        }

        return {
            all: allRooms,
            byBuilding
        };
    } catch (error) {
        console.error(error);
        showToast(`Could not load lecture rooms: ${error.message}`);
        return { all: [], byBuilding: {} };
    }
}

function allExistingExamEntries(examType, academicYear, semester) {
    return readStorage(EXAM_SCHEDULES_KEY)
        .filter(schedule => schedule.examType === examType)
        /* ROOM AVAILABILITY SCOPING:
           Only saved exam schedules from the SAME Academic Year AND SAME
           Semester reserve exam rooms.  Exams from other terms must NOT
           block room availability for the current generation. */
        .filter(schedule => !academicYear || (schedule.academicYear || "") === academicYear)
        .filter(schedule => !semester || (schedule.semester || "") === semester)
        .flatMap(schedule =>
            (schedule.exams || []).map(exam => ({
                day: exam.day,
                range: splitRange(exam.time),
                room: exam.room,
                proctor: schedule.proctor
            })).filter(entry => entry.range)
        );
}

function hasConflict(day, range, room, proctor, bookings) {
    return bookings.some(booking => booking.day === day && intervalsOverlap(range, booking.range) && (
        normalise(booking.room) === normalise(room) || normalise(booking.proctor) === normalise(proctor)
    ));
}

function findDaySlotsForSection(subjects, proctor, roomsToTry, bookings) {
    // Build a map of day -> subjects count and time ranges
    const dayAssignments = {};
    for (const day of DAYS) {
        dayAssignments[day] = [];
    }

    // Track which room is used per subject assignment
    const usedRooms = {};

    const isLargeSection = subjects.length >= 10;
    const maxSubjectsLimit = isLargeSection ? 8 : MAX_SUBJECTS_PER_DAY;

    /**
     * Attempt to place a single subject on a given day within a restricted or extended time window.
     * Each subject starts 1 hour after the previous subject's END time.
     * - Minor 08:00-09:00 → next starts at 10:00 (09:00 + 1 hour)
     * - Major 10:00-11:30 → next starts at 13:00 (11:30 + 1 hour = 12:30, but lunch 12:00-13:00, so 13:00)
     *
     * @param {Object} subject         - The subject to place
     * @param {string} day             - The day name from selected dates
     * @param {boolean} restrictPM     - true → try PM slots, false → try AM slots
     * @param {boolean} allowExtendedPM - true → allow extended PM up to DAY_END (5:30 PM) for 10+ subjects
     * @returns {Object|null} { range, room } if placed, null otherwise
     */
    function tryPlace(subject, day, restrictPM, allowExtendedPM = false) {
        if (dayAssignments[day].length >= maxSubjectsLimit) return null;

        const boundStart = restrictPM ? LUNCH_END : DAY_START;
        const boundEnd = restrictPM ? (allowExtendedPM ? DAY_END : PM_END) : LUNCH_END;

        // Build candidate start times:
        // 1. The boundary start (8:00 AM or 1:00 PM)
        // 2. For each already-placed subject on this day: its end time + 60 minutes
        //    (this ensures a 1-hour gap between the end of one subject and the start of the next)
        const candidateStarts = [boundStart];
        for (const assignment of dayAssignments[day]) {
            const nextStart = assignment.range.end + 60;
            // If the next start falls in lunch (12:00-13:00), bump to 13:00
            const adjusted = (nextStart > LUNCH_START && nextStart < LUNCH_END) ? LUNCH_END : nextStart;
            candidateStarts.push(adjusted);
        }

        // Deduplicate and sort, then try each candidate
        const uniqueStarts = [...new Set(candidateStarts)].sort((a, b) => a - b);

        for (const start of uniqueStarts) {
            // Skip if start is before the boundary
            if (start < boundStart) continue;
            // Skip if subject doesn't fit before the boundary end
            if (start + subject.duration > boundEnd) continue;

            const end = start + subject.duration;
            const range = { start, end };

            // Conflict with another subject from the same section, placed earlier
            if (dayAssignments[day].some(a => intervalsOverlap(range, a.range))) continue;

            // === PASS 1: Try priority rooms (current behavior) ===
            for (const room of roomsToTry) {
                const roomName = room.roomName || room.roomCode;
                if (!hasConflict(day, range, roomName, proctor, bookings)) {
                    return { range, room: roomName };
                }
            }

            // === PASS 2: Fallback — try gaps in occupied rooms ===
            // When all lecture rooms in Building A, Building B, and Admin Building
            // are taken, this allows sharing a room with another section by placing
            // the exam into the 1-hour gaps between that section's exams.
            const roomsWithBookings = {};
            for (const booking of bookings) {
                if (booking.day === day && booking.range) {
                    if (!roomsWithBookings[booking.room]) roomsWithBookings[booking.room] = [];
                    roomsWithBookings[booking.room].push(booking);
                }
            }

            for (const [roomName, roomBkgs] of Object.entries(roomsWithBookings)) {
                // Sort bookings by start time
                roomBkgs.sort((a, b) => a.range.start - b.range.start);

                // Check gaps between consecutive bookings
                for (let i = 0; i < roomBkgs.length - 1; i++) {
                    const gapStart = roomBkgs[i].range.end;
                    const gapEnd = roomBkgs[i + 1].range.start;
                    const gapDuration = gapEnd - gapStart;

                    // Gap must be big enough and the candidate must fit within it
                    if (gapDuration >= subject.duration &&
                        start >= gapStart &&
                        start + subject.duration <= gapEnd) {
                        const gapRange = { start, end: start + subject.duration };
                        if (!hasConflict(day, gapRange, roomName, proctor, bookings)) {
                            return { range: gapRange, room: roomName };
                        }
                    }
                }

                // Also check gap before the first booking (from boundary start)
                if (roomBkgs.length > 0) {
                    const firstBkg = roomBkgs[0];
                    const beforeGapStart = boundStart;
                    const beforeGapEnd = firstBkg.range.start;

                    if (beforeGapEnd - beforeGapStart >= subject.duration &&
                        start >= beforeGapStart &&
                        start + subject.duration <= beforeGapEnd) {
                        const gapRange = { start, end: start + subject.duration };
                        if (!hasConflict(day, gapRange, roomName, proctor, bookings)) {
                            return { range: gapRange, room: roomName };
                        }
                    }
                }
            }
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 1: Standard ordered half-day slots:
    //  day1-AM(2) → day1-PM(2) → day2-AM(2) → day2-PM(2) → etc.
    //  Places up to 2 subjects per half-day using normal time window.
    // ─────────────────────────────────────────────────────────────────
    const halfDaySlots = DAYS.flatMap(day => [
        { day, restrictPM: false, label: "AM" }, // AM half-day
        { day, restrictPM: true, label: "PM" }   // PM half-day
    ]);

    let subjectIdx = 0;

    for (const { day, restrictPM } of halfDaySlots) {
        let placedInHalfDay = 0;

        // Try to place up to 2 subjects in this half-day slot
        while (subjectIdx < subjects.length && placedInHalfDay < 2) {
            const subject = subjects[subjectIdx];
            const result = tryPlace(subject, day, restrictPM, false);

            if (result) {
                dayAssignments[day].push({
                    subject,
                    range: result.range,
                    day,
                    room: result.room
                });
                usedRooms[subject.code || subject.name] = result.room;
                subjectIdx++;
                placedInHalfDay++;
            } else {
                // Cannot place this subject in this half-day → move to next half-day
                break;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 2 (EXCEPTION FOR 10+ SUBJECTS ONLY):
    //  If normal slots are insufficient and the section has >= 10 subjects,
    //  allow additional valid exam time slots on the SELECTED EXAM DATES
    //  (extended PM window up to DAY_END = 5:30 PM with 1-hour breaks).
    // ─────────────────────────────────────────────────────────────────
    if (isLargeSection && subjectIdx < subjects.length) {
        // Pass A: Try placing remaining subjects across the selected DAYS in PM extended slots
        for (const day of DAYS) {
            while (subjectIdx < subjects.length) {
                const subject = subjects[subjectIdx];
                const result = tryPlace(subject, day, true, true);

                if (result) {
                    dayAssignments[day].push({
                        subject,
                        range: result.range,
                        day,
                        room: result.room
                    });
                    usedRooms[subject.code || subject.name] = result.room;
                    subjectIdx++;
                } else {
                    // No more extended PM slots fit on this day → try next selected day
                    break;
                }
            }
            if (subjectIdx >= subjects.length) break;
        }

        // Pass B: If still not all placed, check any remaining open AM slots across DAYS
        if (subjectIdx < subjects.length) {
            for (const day of DAYS) {
                while (subjectIdx < subjects.length) {
                    const subject = subjects[subjectIdx];
                    const result = tryPlace(subject, day, false, false);

                    if (result) {
                        dayAssignments[day].push({
                            subject,
                            range: result.range,
                            day,
                            room: result.room
                        });
                        usedRooms[subject.code || subject.name] = result.room;
                        subjectIdx++;
                    } else {
                        break;
                    }
                }
                if (subjectIdx >= subjects.length) break;
            }
        }
    }

    // If not all subjects were placed, the schedule is too full
    if (subjectIdx < subjects.length) return null;

    return { dayAssignments, usedRooms };
}

function renderGeneratedExams() {
    if (!examModalBody) return;

    if (!generatedExamSchedules.length) {
        examModalBody.innerHTML = '<p class="empty-note" style="text-align:center; padding:20px; color:#777;">No exam schedule generated yet.</p>';
        return;
    }

    examModalBody.innerHTML = generatedExamSchedules.map(schedule => `
        <div class="generated-section-card">
            <div class="generated-section-header">
                <div class="generated-section-title">${escapeHtml(schedule.section || schedule.title || "Section")}</div>
                <div class="generated-section-proctor"><strong>Proctor:</strong> ${escapeHtml(schedule.proctor || "TBA")}</div>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Day</th>
                            <th>Time</th>
                            <th>Duration</th>
                            <th>Room</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(schedule.exams || []).map(exam => `
                            <tr>
                                <td>${escapeHtml(exam.code)} — ${escapeHtml(exam.name)}</td>
                                <td>${escapeHtml(exam.day)}</td>
                                <td>${escapeHtml(exam.time)}</td>
                                <td>${escapeHtml(exam.duration === 90 ? "1.5 hours" : "1 hour")}</td>
                                <td>${escapeHtml(exam.room)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </div>
    `).join("");
}

async function generateExamSchedules() {
    // Validate exam type selection
    const examType = examTypeSelect?.value;
    if (!examType) {
        showToast("Please select an exam type (Preliminary, Midterm, or Final).");
        return;
    }

    // Validate multi-date picker
    if (!selectedDates.length) {
        showToast("Please add at least one exam date.");
        return;
    }

    // Exclude disabled checkboxes (sections that already have a saved exam schedule)
    const selectedIds = [...document.querySelectorAll(".schedule-check:checked:not(:disabled)")].map(input => input.value);
    const selectedSchedules = filteredSections.filter(group => selectedIds.includes(group.id));

    if (!selectedSchedules.length) {
        showToast("Select at least one saved class schedule.");
        return;
    }

    generateExamBtn.disabled = true;
    generateExamBtn.textContent = "Generating...";
    const [faculty, prospectus] = await Promise.all([loadFaculty(), loadProspectusSubjects()]);
    generateExamBtn.disabled = false;
    generateExamBtn.textContent = "Generate Exam Schedule";

    if (!faculty.length) {
        showToast("No faculty with a name was found in the Firestore faculty collection.");
        return;
    }

/* Scope existing exam bookings to the SAME Academic Year + Semester as the
   class schedules being generated.  Saved exam schedules from a different
   term must not block rooms or proctors for the current generation. */
const examAcademicYear = selectedSchedules[0]?.academicYear || "";
const examSemester = selectedSchedules[0]?.semester || "";
const bookings = allExistingExamEntries(examType, examAcademicYear, examSemester);

    /* Track which faculty members are already assigned to an exam schedule of
       this exam type. Seed it with proctors from existing saved schedules so a
       faculty member already proctoring this exam type is not reused. */
    const usedProctors = new Set(bookings.map(booking => normalise(booking.proctor)));

    const proctors = shuffled(faculty);
    generatedExamSchedules = [];

    // Build the examDates map from selectedDates
    const examDates = {};
    for (const dateStr of selectedDates) {
        const dayName = getDayName(dateStr);
        examDates[dayName] = dateStr;
    }

    // Load all available lecture rooms once for all sections
    const rooms = await loadLectureRooms();
    if (!rooms.all.length) {
        showToast("No available lecture rooms found in Building A, Building B, or Admin Building.");
        return;
    }

for (let index = 0; index < selectedSchedules.length; index += 1) {
        const classSchedule = selectedSchedules[index];

        // Pick the first faculty member who is not already assigned to an exam
        // schedule of this exam type, so no faculty member proctors more than
        // one exam schedule.
        const availableProctor = proctors.find(proctor => !usedProctors.has(normalise(proctor.name)));

        if (!availableProctor) {
            showToast(`Not enough faculty. Each selected section needs a unique proctor for ${examType}, but all faculty members are already assigned to an exam schedule of this type.`);
            generatedExamSchedules = [];
            renderGeneratedExams();
            return;
        }

        const proctor = availableProctor.name;
        usedProctors.add(normalise(proctor));

        const subjects = buildExamSubjects(classSchedule, prospectus);

        if (!subjects.length) {
            showToast(`${scheduleTitle(classSchedule)} has no subjects to schedule.`);
            generatedExamSchedules = [];
            renderGeneratedExams();
            return;
        }

        // Build a priority-ordered list of rooms based on program building preference
        const preferredBuilding = getExamBuildingPriority(classSchedule.program);
        const roomsToTry = [];

        if (preferredBuilding) {
            const buildingKey = normalise(preferredBuilding);
            // Add preferred building rooms first
            if (rooms.byBuilding[buildingKey]) {
                roomsToTry.push(...rooms.byBuilding[buildingKey]);
            }
            // Add Admin Building rooms as overflow (second priority)
            const adminKey = normalise("Admin Building");
            if (adminKey !== buildingKey && rooms.byBuilding[adminKey]) {
                roomsToTry.push(...rooms.byBuilding[adminKey]);
            }
            // Add any remaining buildings as last resort
            for (const [building, buildingRooms] of Object.entries(rooms.byBuilding)) {
                if (building !== buildingKey && building !== adminKey) {
                    roomsToTry.push(...buildingRooms);
                }
            }
        } else {
            // No specific preference, use all rooms
            roomsToTry.push(...rooms.all);
        }

        // Try to scatter subjects across the selected days (2 AM + 2 PM per day)
        const result = findDaySlotsForSection(subjects, proctor, roomsToTry, bookings);

        if (!result) {
            const dayNames = DAYS.join(", ");
            showToast(`Could not schedule all exams for ${scheduleTitle(classSchedule)} within ${dayNames} (2 subjects AM + 2 subjects PM per day). Try clearing some saved exam schedules.`);
            generatedExamSchedules = [];
            renderGeneratedExams();
            return;
        }

        const { dayAssignments, usedRooms } = result;

        const exams = [];
        for (const day of DAYS) {
            for (const assignment of dayAssignments[day]) {
                const examRoom = assignment.room || usedRooms[assignment.subject.code || assignment.subject.name] || "TBA";
                const exam = {
                    ...assignment.subject,
                    day: assignment.day,
                    time: timeRange(assignment.range.start, assignment.subject.duration),
                    room: examRoom
                };
                exams.push(exam);
                bookings.push({ day: assignment.day, range: assignment.range, room: examRoom, proctor });
            }
        }

        // Determine the primary room for display (use the most used room)
        const roomCounts = {};
        for (const exam of exams) {
            roomCounts[exam.room] = (roomCounts[exam.room] || 0) + 1;
        }
        const primaryRoom = Object.entries(roomCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "TBA";

        generatedExamSchedules.push({
            id: crypto.randomUUID(),
            classScheduleId: classSchedule.id,
            title: `${scheduleTitle(classSchedule)}`,
            section: classSchedule.section,
            academicYear: classSchedule.academicYear || "",
            semester: classSchedule.semester,
            program: classSchedule.program,
            major: classSchedule.major,
            yearLevel: classSchedule.yearLevel,
            proctor,
            room: primaryRoom,
            examType,
            examDates,
            createdAt: new Date().toISOString(),
            exams
        });
    }

    if (saveExamBtn) saveExamBtn.textContent = "Save Exam Schedule";

    renderGeneratedExams();
    saveExamBtn.disabled = false;
    examModal.style.display = "block";
}

function examRows(exams) {
    return exams.map(exam => `<tr>
        <td>${escapeHtml(exam.code)}</td><td>${escapeHtml(exam.name)}</td>
        <td>${escapeHtml(exam.day)}</td>
        <td>${escapeHtml(exam.time)}</td><td>${escapeHtml(exam.room)}</td>
    </tr>`).join("");
}

function renderSavedExams() {
    const schedules = readStorage(EXAM_SCHEDULES_KEY);
    const empty = document.getElementById("emptyExamSchedules");
    const list = document.getElementById("savedExamSchedules");
    if (!list || !empty) return;
    empty.hidden = schedules.length > 0;
    list.innerHTML = schedules.map(schedule => `<article style="margin-top:16px">
        <div class="section-header"><div><h4 style="margin:0">${escapeHtml(schedule.title)}</h4>
        <small>${escapeHtml([schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "", schedule.semester, schedule.yearLevel, schedule.examType, `Proctor: ${schedule.proctor}`].filter(Boolean).join(" • "))}</small></div>
        <button type="button" data-delete-exam="${escapeHtml(schedule.id)}">Delete</button></div>
        <div class="table-container"><table><thead><tr><th>Code</th><th>Subject</th><th>Day</th><th>Time</th><th>Room</th></tr></thead>
        <tbody>${examRows(schedule.exams || [])}</tbody></table></div></article>`).join("");
}

async function saveExamSchedules() {
    if (!generatedExamSchedules.length) return;

    saveExamBtn.disabled = true;
    saveExamBtn.textContent = "Saving...";

    /* Query fresh exam schedules directly from Firestore */
    const freshFirestoreExamSchedules = await loadExamSchedulesFromFirestore();
    writeStorage(EXAM_SCHEDULES_KEY, freshFirestoreExamSchedules);

    const saved = [...freshFirestoreExamSchedules];
    const schedulesToSave = [];

    for (const generated of generatedExamSchedules) {
        /* Duplicate prevention: match on Academic Year + Semester + Section + Exam Type. */
        const existingIndex = saved.findIndex(schedule =>
            (schedule.academicYear || "").trim() === (generated.academicYear || "").trim() &&
            (schedule.semester || "").trim().toLowerCase() === (generated.semester || "").trim().toLowerCase() &&
            normalise(schedule.section) === normalise(generated.section) &&
            schedule.examType === generated.examType
        );
        if (existingIndex >= 0) {
            const confirmed = await showConfirm(`An exam schedule for ${generated.section} (${generated.examType}) in ${generated.academicYear} ${generated.semester} already exists. Replace it?`);
            if (!confirmed) continue;
        }
        // Use the stable Firestore document ID locally so that Save→Delete
        // flows remove the correct Firestore document.
        const docId = examScheduleDocId(generated);
        generated.id = docId;
        if (existingIndex >= 0) saved[existingIndex] = generated;
        else saved.unshift(generated);
        schedulesToSave.push(generated);
    }

    if (!schedulesToSave.length) {
        saveExamBtn.disabled = false;
        saveExamBtn.textContent = "Save Exam Schedule";
        return;
    }

    writeStorage(EXAM_SCHEDULES_KEY, saved);

    /* Persist to Firestore so the dashboard can see it */
    let firestoreError = null;
    for (const generated of schedulesToSave) {
        try {
            await saveExamScheduleToFirestore(generated);
            console.log("Exam schedule saved to Firestore:", generated.title);
        } catch (error) {
            console.error("Could not save exam schedule to Firestore:", error);
            firestoreError = error;
        }
    }

    if (firestoreError) {
        showToast(`The exam schedule was saved locally but could not be saved to the database: ${firestoreError.message}`);
        saveExamBtn.disabled = false;
        saveExamBtn.textContent = "Save Exam Schedule";
        return;
    }

    /* Refresh from Firestore so the status columns reflect the actual saved state */
    firestoreExamSchedules = await loadExamSchedulesFromFirestore();

    generatedExamSchedules = [];
    saveExamBtn.disabled = true;
    saveExamBtn.textContent = "Save Exam Schedule";
    renderGeneratedExams();
    renderSavedExams();
    renderClassSchedules();
    examModal.style.display = "none";

    /* Show the saved success overlay with the animated checkmark,
       then fade it out and hide it after 1 second (matching class.js). */
    if (savedOverlay) {
        savedOverlay.classList.remove("fade-out");
        savedOverlay.style.display = "flex";

        setTimeout(() => {
            savedOverlay.classList.add("fade-out");
        }, 1000);

        setTimeout(() => {
            savedOverlay.style.display = "none";
            savedOverlay.classList.remove("fade-out");
        }, 1400);
    }
}

function deleteSavedExam(event) {
    const id = event.target.dataset.deleteExam;
    if (!id) return;
    showConfirm("Delete this saved exam schedule?").then(async confirmed => {
        if (!confirmed) return;
        writeStorage(EXAM_SCHEDULES_KEY, readStorage(EXAM_SCHEDULES_KEY).filter(schedule => schedule.id !== id));
        /* Also remove from Firestore */
        try {
            await deleteExamScheduleFromFirestore(id);
            console.log("Exam schedule deleted from Firestore:", id);
        } catch (error) {
            console.error("Could not delete exam schedule from Firestore:", error);
        }
        /* Refresh the Firestore status columns */
        firestoreExamSchedules = await loadExamSchedulesFromFirestore();
        renderSavedExams();
        renderClassSchedules();
    });
}

async function deleteAllSavedExams() {
    const schedules = readStorage(EXAM_SCHEDULES_KEY);

    if (!schedules.length) {
        showToast("There are no saved exam schedules to delete.");
        return;
    }

    const confirmed = await showConfirm(`Are you sure you want to delete all ${schedules.length} saved exam schedule(s)? This action cannot be undone.`);
    if (!confirmed) {
        return;
    }

    /* Delete each schedule from Firestore */
    for (const schedule of schedules) {
        try {
            await deleteExamScheduleFromFirestore(schedule.id);
            console.log("Exam schedule deleted from Firestore:", schedule.id);
        } catch (error) {
            console.error("Could not delete exam schedule from Firestore:", error);
        }
    }

    /* Clear localStorage */
    writeStorage(EXAM_SCHEDULES_KEY, []);
    /* Refresh the Firestore status columns */
    firestoreExamSchedules = await loadExamSchedulesFromFirestore();
    renderSavedExams();
    renderClassSchedules();
}

async function exportExamPdf() {
    const schedules = readStorage(EXAM_SCHEDULES_KEY);
    if (!schedules.length) {
        showToast("There are no saved exam schedules to export.");
        return;
    }

    // Build absolute URL for the logo image
    const logoUrl = new URL('logo (1).png', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    /**
     * Format a date from YYYY-MM-DD to a readable format like "March 10, 2025".
     */
    function formatDate(dateStr) {
        if (!dateStr) return "";
        const parts = dateStr.split("-");
        if (parts.length !== 3) return dateStr;
        const year = parts[0];
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];
        return `${monthNames[month]} ${day}, ${year}`;
    }

    // Shared printable CSS for each exam schedule PDF
    const printStyles = `
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .logo-left, .logo-right { flex-shrink: 0; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #1b5e20; letter-spacing: 0.5px; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; margin-top: 1px; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 10px 0; }
            .title-section { text-align: center; font-size: 14px; font-weight: bold; color: #1b5e20; margin-bottom: 10px; text-decoration: underline; }
            .section-row { background-color: #2e7d32; color: #ffffff; text-align: center; font-size: 14px; font-weight: bold; padding: 7px 10px; margin-bottom: 12px; }
            .day-section { margin-bottom: 14px; }
            .day-header { font-size: 12px; font-weight: bold; color: #1b5e20; text-align: center; padding: 5px; background: #e8f5e9; border-bottom: 2px solid #2e7d32; }
            .exam-table { width: 100%; border-collapse: collapse; font-size: 11px; }
            .exam-table th, .exam-table td { border: 1px solid #888; padding: 5px 7px; text-align: left; }
            .exam-table th { background: #a5d6a7; color: #1b5e20; font-weight: bold; text-align: center; }
            .exam-table td { vertical-align: top; }
            .exam-table tbody tr:nth-child(even) { background: #f1f8e9; }
            .exam-table th:nth-child(1), .exam-table td:nth-child(1) { width: 22%; }
            .exam-table th:nth-child(2), .exam-table td:nth-child(2) { width: 38%; }
            .exam-table th:nth-child(3), .exam-table td:nth-child(3) { width: 22%; }
            .exam-table th:nth-child(4), .exam-table td:nth-child(4) { width: 18%; }
            .page { break-after: page; page-break-after: always; }
            .page:last-child { break-after: auto; page-break-after: auto; }
        </style>
    `;

    function buildSectionPageHtml(schedule) {
        const examType = schedule.examType || "";
        const examTypeUpper = examType.toUpperCase();
        const sectionName = escapeHtml(schedule.title || schedule.section || "");
        const examDates = schedule.examDates || {};
        const DAYS_ORDER = Object.keys(examDates);

        function groupExamsByDay(exams) {
            const groups = {};
            for (const day of DAYS_ORDER) {
                groups[day] = exams.filter(exam => exam.day === day);
            }
            return groups;
        }

        const examsByDay = groupExamsByDay(schedule.exams || []);
        let dayTablesHtml = "";
        for (const day of DAYS_ORDER) {
            const dayExams = examsByDay[day];
            if (!dayExams || dayExams.length === 0) continue;

            const dateStr = examDates[day] || "";
            const formattedDate = formatDate(dateStr);
            const dayLabel = formattedDate ? `${formattedDate} (${day})` : day;

            let rowsHtml = "";
            for (const exam of dayExams) {
                rowsHtml += `<tr>
                    <td>${escapeHtml(exam.time)}</td>
                    <td>${escapeHtml(exam.code)} — ${escapeHtml(exam.name)}</td>
                    <td>${escapeHtml(schedule.proctor || "")}</td>
                    <td>${escapeHtml(exam.room)}</td>
                </tr>`;
            }

            dayTablesHtml += `
                <div class="day-section">
                    <div class="day-header">${escapeHtml(dayLabel)}</div>
                    <table class="exam-table">
                        <thead>
                            <tr>
                                <th>TIME</th>
                                <th>SUBJECT</th>
                                <th>PROCTOR</th>
                                <th>ROOM</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
            `;
        }

        return `
            <div class="page">
                <div class="header-section">
                    <div class="logo-left"><img src="${logoUrl1}" alt="SLSU Logo" class="logo-img"></div>
                    <div class="header-text">
                        <div class="uni-name">SOUTHERN LUZON STATE UNIVERSITY</div>
                        <div class="dtlc-name">Dual Training and Livelihood Center</div>
                        <div class="campus-name">LUCENA CAMPUS</div>
                        <div class="city-name">Lucena City</div>
                    </div>
                    <div class="logo-right"><img src="${logoUrl}" alt="SLSU Logo" class="logo-img"></div>
                </div>
                <div class="divider"></div>
                <div class="title-section">SCHEDULES OF ${escapeHtml(examTypeUpper)} EXAMINATIONS</div>
                <div class="section-row">${sectionName}</div>
                ${dayTablesHtml}
            </div>
        `;
    }

    // 1. Group schedules strictly by Academic Year + Semester + Exam Type
    const groupsMap = new Map();
    for (const schedule of schedules) {
        const ay = schedule.academicYear || "";
        const sem = schedule.semester || "";
        const type = schedule.examType || "Preliminary";
        const groupKey = `${ay}|${sem}|${type}`;

        if (!groupsMap.has(groupKey)) {
            groupsMap.set(groupKey, {
                academicYear: ay,
                semester: sem,
                examType: type,
                schedules: []
            });
        }
        groupsMap.get(groupKey).schedules.push(schedule);
    }

    let exportedGroupsCount = 0;
    const allSuccessfullyExportedIds = new Set();

    // 2. Export each group into its own separate PDF document
    for (const group of groupsMap.values()) {
        const { academicYear, semester, examType, schedules: groupSchedules } = group;

        const docTitle = [
            academicYear ? `A.Y. ${academicYear}` : "A.Y.",
            semester,
            examType,
            "Exam Schedule"
        ].filter(Boolean).join(" ");

        const pagesHtml = groupSchedules.map(s => buildSectionPageHtml(s)).join("");
        const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(docTitle)}</title>${printStyles}</head><body>${pagesHtml}</body></html>`;

        const reportData = {
            category: "Exam Schedule",
            academicYear,
            semester,
            yearLevel: groupSchedules[0]?.yearLevel || "",
            examType,
            title: [
                academicYear ? `A.Y. ${academicYear}` : "",
                semester,
                examType
            ].filter(Boolean).join(" "),
            filename: docTitle,
            html: fullHtml,
            createdAt: new Date().toISOString()
        };

        // Save to Firestore reports collection
        try {
            await saveReportToFirestore(reportData);
            console.log("Exam report saved to Firestore:", reportData.filename);
        } catch (error) {
            console.error("Could not save exam report to Firestore:", error);
            showToast(`Could not archive ${docTitle}: ${error.message}. Saved schedules were NOT deleted.`);
            continue; // Abort deletion for this group if archiving failed
        }

        // Open print window for this group
        const printWindow = window.open("", "_blank");
        if (printWindow) {
            printWindow.document.write(fullHtml);
            printWindow.document.close();
            printWindow.onload = () => {
                printWindow.focus();
                printWindow.print();
            };
        }

        // 3. ONLY THEN delete the exact Saved Exam Schedule documents included in that PDF
        for (const sched of groupSchedules) {
            try {
                await deleteExamScheduleFromFirestore(sched.id);
                allSuccessfullyExportedIds.add(sched.id);
            } catch (deleteError) {
                console.error("Could not delete saved schedule doc:", sched.id, deleteError);
            }
        }

        exportedGroupsCount++;
    }

    // 4. Remove exported schedules from localStorage
    if (allSuccessfullyExportedIds.size > 0) {
        const remainingSchedules = readStorage(EXAM_SCHEDULES_KEY).filter(s => !allSuccessfullyExportedIds.has(s.id));
        writeStorage(EXAM_SCHEDULES_KEY, remainingSchedules);
    }

    // 5. Refresh Firestore cache, Saved Exam Schedules, Class Schedules status, and Archive
    firestoreExamSchedules = await loadExamSchedulesFromFirestore();
    renderSavedExams();
    renderClassSchedules();
    await loadExamArchiveData();

    if (exportedGroupsCount > 0) {
        showToast(`Successfully exported and archived ${exportedGroupsCount} exam schedule PDF(s).`);
    }
}

/* ------------------------------------------------------------------ */
/*  Exam Schedule Archive                                              */
/* ------------------------------------------------------------------ */

function formatExportedDate(dateValue) {
    if (!dateValue) return "—";
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return String(dateValue);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric"
    });
}

/* ------------------------------------------------------------------ */
/*  Firestore helpers (same pattern as class.js uses for classSchedules) */
/* ------------------------------------------------------------------ */

const EXAM_SCHEDULES_COLLECTION = "examSchedules";

/**
 * Returns a stable document ID for an exam schedule so that saving the same
 * combination (section + semester + program + major + yearLevel + proctor)
 * always overwrites the same Firestore document.
 */
function examScheduleDocId(schedule) {
    const raw = [
        schedule.section || "",
        schedule.semester || "",
        schedule.program || "",
        schedule.major || "",
        schedule.yearLevel || "",
        schedule.academicYear || "",
        schedule.proctor || "",
        schedule.examType || ""
    ].join("_");

    return raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
}

async function saveExamScheduleToFirestore(schedule) {
    const docId = examScheduleDocId(schedule);

const data = {
        classScheduleId: schedule.classScheduleId,
        title: schedule.title,
        section: schedule.section,
        academicYear: schedule.academicYear || "",
        semester: schedule.semester,
        program: schedule.program,
        major: schedule.major,
        yearLevel: schedule.yearLevel,
        proctor: schedule.proctor,
        room: schedule.room,
        examType: schedule.examType || "",
        examDates: schedule.examDates || {},
        exams: schedule.exams,
        createdAt: schedule.createdAt
            ? new Date(schedule.createdAt)
            : new Date(),
        updatedAt: new Date()
    };

    await setDoc(doc(db, EXAM_SCHEDULES_COLLECTION, docId), data);
}

async function loadExamSchedulesFromFirestore() {
    try {
        const examSchedulesCollection = collection(db, EXAM_SCHEDULES_COLLECTION);
        const snapshot = await getDocs(examSchedulesCollection);
        return snapshot.docs.map(document => {
            const data = document.data();

return {
                id: document.id,
                classScheduleId: data.classScheduleId || "",
                title: data.title || "",
                section: data.section || "",
                semester: data.semester || "",
                academicYear: data.academicYear || "",
                program: data.program || "",
                major: data.major || "",
                yearLevel: data.yearLevel || "",
                proctor: data.proctor || "",
                room: data.room || "",
                examType: data.examType || "",
                exams: data.exams || [],
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString()
            };
        });
    } catch (error) {
        console.error("Could not load exam schedules from Firestore:", error);
        return [];
    }
}

/**
 * Load ALL class schedules from Firestore (active AND archived).
 * The Exam Schedule Generator must see archived class schedules too so
 * exam generation can still use previously exported master schedules.
 * This mirrors the document shape produced by class.js so the data is
 * interchangeable with the shared localStorage key.
 */
async function loadClassSchedulesFromFirestore() {
    try {
        const classSchedulesCollection = collection(db, "classSchedules");
        const snapshot = await getDocs(classSchedulesCollection);
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
                /* archived schedules remain valid master schedules for exams */
                status: data.status === "archived" ? "archived" : "active",
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString(),
                exportedAt: data.exportedAt?.toDate?.()?.toISOString?.() || data.exportedAt || null
            };
        });
    } catch (error) {
        console.error("Could not load class schedules from Firestore for exams:", error);
        return [];
    }
}

async function deleteExamScheduleFromFirestore(docId) {
    try {
        await deleteDoc(doc(db, EXAM_SCHEDULES_COLLECTION, docId));
    } catch (error) {
        console.error("Could not delete exam schedule from Firestore:", error);
        throw error;
    }
}

/* ------------------------------------------------------------------ */
/*  Event listeners                                                    */
/* ------------------------------------------------------------------ */

generateExamBtn?.addEventListener("click", generateExamSchedules);
saveExamBtn?.addEventListener("click", saveExamSchedules);

document.querySelector("#examModal .close-modal")?.addEventListener("click", () => {
    examModal.style.display = "none";
    if (saveExamBtn) saveExamBtn.textContent = "Save Exam Schedule";
});

window.addEventListener("click", event => {
    if (event.target === examModal) {
        examModal.style.display = "none";
        if (saveExamBtn) saveExamBtn.textContent = "Save Exam Schedule";
    }
});

document.getElementById("exportExamPdfBtn")?.addEventListener("click", exportExamPdf);
document.getElementById("deleteAllExamBtn")?.addEventListener("click", deleteAllSavedExams);
document.getElementById("savedExamSchedules")?.addEventListener("click", deleteSavedExam);
document.getElementById("deleteAllClassSchedulesBtn")?.addEventListener("click", deleteAllClassSchedules);

async function deleteAllClassSchedules() {
    try {
        /* Query all class schedule documents from Firestore */
        const firestoreSnapshot = await getDocs(collection(db, "classSchedules"));
        const firestoreClassSchedules = firestoreSnapshot.docs.map(docSnap => ({
            id: docSnap.id,
            ...docSnap.data()
        }));

        const localSchedules = readStorage(CLASS_SCHEDULES_KEY);

        /* Gather all saved class schedule records from Firestore, localStorage, and in-memory state */
        const allSavedClassSchedules = [...firestoreClassSchedules];

        for (const local of localSchedules) {
            const docId = local.id || local.firestoreDocId || "";
            if (docId) {
                if (!allSavedClassSchedules.some(item => item.id === docId)) {
                    allSavedClassSchedules.push(local);
                }
            } else if (!allSavedClassSchedules.some(item => item.section === local.section && item.academicYear === local.academicYear && item.semester === local.semester)) {
                allSavedClassSchedules.push(local);
            }
        }

        for (const disp of displayedClassSchedules) {
            const docId = disp.id || disp.firestoreDocId || "";
            if (docId) {
                if (!allSavedClassSchedules.some(item => item.id === docId)) {
                    allSavedClassSchedules.push(disp);
                }
            } else if (!allSavedClassSchedules.some(item => item.section === disp.section && item.academicYear === disp.academicYear && item.semester === disp.semester)) {
                allSavedClassSchedules.push(disp);
            }
        }

        if (allSavedClassSchedules.length === 0) {
            showToast("There are no saved class schedules to delete.");
            return;
        }

        const confirmed = await showConfirm("Are you sure you want to delete all saved class schedules?");
        if (!confirmed) return;

        /* Delete all documents in classSchedules collection using actual Firestore doc.id */
        const docIdsToDelete = new Set();
        firestoreSnapshot.docs.forEach(docSnap => docIdsToDelete.add(docSnap.id));
        allSavedClassSchedules.forEach(item => {
            if (item.id) docIdsToDelete.add(item.id);
            if (item.firestoreDocId) docIdsToDelete.add(item.firestoreDocId);
        });

        if (docIdsToDelete.size > 0) {
            const deletePromises = Array.from(docIdsToDelete).map(async docId => {
                try {
                    await deleteDoc(doc(db, "classSchedules", docId));
                } catch (err) {
                    console.warn(`Could not delete class schedule doc ${docId}:`, err);
                }
            });
            await Promise.all(deletePromises);
        }

        /* Clear local storage key for saved class schedules */
        writeStorage(CLASS_SCHEDULES_KEY, []);

        /* Update in-memory state */
        displayedClassSchedules = [];
        groupedSections = [];
        filteredSections = [];
        selectedAcademicYear = "";
        selectedSemester = "";
        if (academicYearFilter) academicYearFilter.value = "";
        if (semesterFilter) semesterFilter.value = "";

        /* Refresh UI */
        renderClassSchedules();

        showToast("All saved class schedules have been deleted successfully.");
    } catch (error) {
        console.error("Could not delete saved class schedules:", error);
        showToast("Failed to delete saved class schedules. Please try again.");
    }
}

// Automatically add the selected date as soon as a date is picked
examDateInput?.addEventListener("change", () => {
    addDate();
});

if (saveExamBtn) saveExamBtn.disabled = true;

/* ------------------------------------------------------------------ */
/*  Academic Year + Semester filter event listeners                    */
/* ------------------------------------------------------------------ */

academicYearFilter?.addEventListener("change", () => {
    selectedAcademicYear = academicYearFilter.value;
    /* Reset grouping so the table recomputes for the new filter */
    groupedSections = [];
    filteredSections = [];
    renderClassSchedules();
});

semesterFilter?.addEventListener("change", () => {
    selectedSemester = semesterFilter.value;
    /* Reset grouping so the table recomputes for the new filter */
    groupedSections = [];
    filteredSections = [];
    renderClassSchedules();
});

/* Search only within the currently selected Academic Year + Semester */
searchInput?.addEventListener("input", () => {
    if (!selectedAcademicYear || !selectedSemester) return;
    /* Re-apply search within the already-grouped sections */
    const searchTerm = normalise(searchInput.value);
    if (searchTerm) {
        filteredSections = groupedSections.filter(group =>
            normalise(group.section).includes(searchTerm) ||
            normalise(group.program).includes(searchTerm) ||
            normalise(group.major).includes(searchTerm)
        );
    } else {
        filteredSections = [...groupedSections];
    }
    renderClassSchedules();
});

/* Select All selects ALL sections loaded in the table */
selectAllCheckbox?.addEventListener("change", () => {
    const checkboxes = document.querySelectorAll(".schedule-check");
    checkboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
    });
});

/* Individual checkbox changes update Select All state (checked, unchecked, or indeterminate) */
savedScheduleBody?.addEventListener("change", event => {
    if (event.target && event.target.classList.contains("schedule-check")) {
        const checkboxes = [...document.querySelectorAll(".schedule-check")];
        if (!checkboxes.length) {
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = false;
            }
            return;
        }
        const allChecked = checkboxes.every(cb => cb.checked);
        const someChecked = checkboxes.some(cb => cb.checked);
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = !allChecked && someChecked;
        }
    }
});

/* ------------------------------------------------------------------ */
/*  Initialise: wait for Firebase Auth to be ready, then load saved   */
/*  exam schedules from Firestore into localStorage for conflict      */
/*  checking, and render.                                             */
/* ------------------------------------------------------------------ */
onAuthStateChanged(auth, async () => {
    /* ── Load exam schedules ── */
    const firestoreSchedules = await loadExamSchedulesFromFirestore();
    firestoreExamSchedules = firestoreSchedules;

    /* Merge any existing localStorage exam schedules so nothing is lost */
    const localSchedules = readStorage(EXAM_SCHEDULES_KEY);
    const mergedExamSchedules = [...firestoreSchedules];

    for (const local of localSchedules) {
        const docId = examScheduleDocId(local);
        const exists = mergedExamSchedules.some(item => item.id === docId);
        if (!exists) {
            mergedExamSchedules.push({ ...local, id: docId });
        }
    }

    /* Sync back to localStorage so the conflict checker works */
    writeStorage(EXAM_SCHEDULES_KEY, mergedExamSchedules);

    /* ── Load class schedules (active + archived) from Firestore ── */
    const firestoreClassSchedules = await loadClassSchedulesFromFirestore();
    const localClassSchedules = readStorage(CLASS_SCHEDULES_KEY);
    const mergedClass = [...firestoreClassSchedules];

    for (const local of localClassSchedules) {
        const docId = local.id || "";
        const exists = mergedClass.some(item => item.id === docId);
        if (!exists) {
            mergedClass.push(local);
        }
    }

    /* Sync class schedules back to localStorage (both active & archived) */
    writeStorage(CLASS_SCHEDULES_KEY, mergedClass);

    renderClassSchedules();
    renderSavedExams();
    renderGeneratedExams();
});

