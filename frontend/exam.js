import { db, auth } from "../firebase.js";
import { saveReportToFirestore, loadReportsFromFirestore } from "./reportStorage.js";

import {
    collection,
    getDocs,
    doc,
    setDoc,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

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
const publishExamBtn = document.getElementById("publishExamBtn");
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

function showConfirm(message, options = {}) {
    return new Promise(resolve => {
        const modal = document.getElementById("customConfirmModal");
        const msgEl = document.getElementById("customConfirmMessage");
        const cancelBtn = document.getElementById("customConfirmCancel");
        const okBtn = document.getElementById("customConfirmOk");
        const headerTitle = modal ? modal.querySelector(".custom-confirm-header h3") : null;

        if (!modal || !msgEl || !cancelBtn || !okBtn) {
            resolve(confirm(message));
            return;
        }

        const prevTitle = headerTitle ? headerTitle.textContent : "Confirm Action";
        const prevOkText = okBtn.textContent;
        const prevCancelText = cancelBtn.textContent;

        if (headerTitle && options.title) headerTitle.textContent = options.title;
        if (options.confirmText) okBtn.textContent = options.confirmText;
        if (options.cancelText) cancelBtn.textContent = options.cancelText;

        msgEl.textContent = message;
        modal.style.display = "flex";

        function cleanup() {
            modal.style.display = "none";
            if (headerTitle) headerTitle.textContent = prevTitle;
            okBtn.textContent = prevOkText;
            cancelBtn.textContent = prevCancelText;
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
const BREAK_MINUTES = 30;
const MAX_SUBJECTS_PER_DAY = 4;
const PM_END = 17 * 60 + 30; // 5:30 PM — full afternoon window for overflow subjects
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
    const ay = (schedule.academicYear || "").trim();
    const sem = (schedule.semester || "").trim().toLowerCase();
    const section = normalise(schedule.section || "");
    const targetType = (examType || "").trim().toLowerCase();

    const localSchedules = readStorage(EXAM_SCHEDULES_KEY);
    const combinedSchedules = [...firestoreExamSchedules, ...localSchedules];

    // 1. Check active saved exam schedules
    const isSaved = combinedSchedules.some(saved =>
        (saved.examType || "").trim().toLowerCase() === targetType &&
        (saved.academicYear || "").trim() === ay &&
        (saved.semester || "").trim().toLowerCase() === sem &&
        normalise(saved.section) === section
    );
    if (isSaved) return true;

    // 2. Check archived exam reports (for schedules already exported to PDF)
    return cachedExamReports.some(report =>
        report.category === "Exam Schedule" &&
        (report.examType || "").trim().toLowerCase() === targetType &&
        (report.academicYear || "").trim() === ay &&
        (report.semester || "").trim().toLowerCase() === sem &&
        (
            (Array.isArray(report.sections) && report.sections.some(s => normalise(s) === section)) ||
            normalise(report.html || "").includes(section)
        )
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

    /* If no AY + Semester selected, automatically default to the Academic Year and Semester of the latest created class schedule */
    if ((!selectedAcademicYear || !selectedSemester) && displayedClassSchedules.length > 0) {
        const sortedByLatest = [...displayedClassSchedules].sort((a, b) => {
            const timeA = new Date(a.createdAt || a.exportedAt || 0).getTime();
            const timeB = new Date(b.createdAt || b.exportedAt || 0).getTime();
            return timeB - timeA;
        });

        const latest = sortedByLatest[0];
        if (latest) {
            if (!selectedAcademicYear && latest.academicYear) {
                selectedAcademicYear = latest.academicYear;
                if (academicYearFilter) academicYearFilter.value = selectedAcademicYear;
            }
            if (!selectedSemester && latest.semester) {
                selectedSemester = latest.semester;
                if (semesterFilter) semesterFilter.value = selectedSemester;
            }
        }
    }

    /* If still no AY + Semester selected (e.g. no class schedules exist), show the prompt message */
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

function extractSubjectCodes(entry) {
    if (!entry) return [];
    if (typeof entry === "object") {
        const code = entry.subjectCode || entry.code || entry.id || "";
        return code ? [normalise(code)] : [];
    }
    const str = String(entry).trim();
    if (!str) return [];
    const results = [normalise(str)];
    if (str.includes("_")) {
        const parts = str.split("_");
        const lastPart = parts[parts.length - 1].trim();
        if (lastPart) {
            results.push(normalise(lastPart));
        }
    }
    return results;
}

async function loadFacultySubjectAssignments() {
    const map = new Map();
    try {
        const snapshot = await getDocs(collection(db, "facultySubjectAssignments"));
        snapshot.docs.forEach(d => {
            const data = d.data();
            const handled = Array.isArray(data.handledSubjects)
                ? [...new Set(data.handledSubjects.flatMap(s => extractSubjectCodes(s)))]
                : [];
            map.set(d.id, handled);
            if (data.facultyId) {
                map.set(data.facultyId, handled);
            }
        });
    } catch (err) {
        console.warn("Could not load faculty subject assignments in exam generator:", err);
    }
    return map;
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
                proctor: exam.proctor || schedule.proctor
            })).filter(entry => entry.range)
        );
}

/**
 * Returns proctor time-slot entries across ALL exam types for the given
 * Academic Year and Semester.  Used exclusively for time-conflict checking
 * so that a faculty member cannot be assigned to two different exam types
 * (e.g. Prelim + Midterm) at the same day and time.
 *
 * This does NOT affect room availability or per-day workload — those remain
 * scoped to the current exam type so that limits correctly reset between
 * Preliminary, Midterm, and Final examinations.
 */
function allExamTypeEntries(academicYear, semester) {
    return readStorage(EXAM_SCHEDULES_KEY)
        .filter(schedule => !academicYear || (schedule.academicYear || "") === academicYear)
        .filter(schedule => !semester || (schedule.semester || "") === semester)
        .flatMap(schedule =>
            (schedule.exams || []).map(exam => ({
                day: exam.day,
                range: splitRange(exam.time),
                room: exam.room,
                proctor: exam.proctor || schedule.proctor
            })).filter(entry => entry.range)
        );
}


function hasConflict(day, range, room, proctor, bookings) {
    return bookings.some(booking => {
        if (booking.day !== day || !intervalsOverlap(range, booking.range)) return false;
        const matchRoom = room && normalise(booking.room) === normalise(room);
        const matchProctor = proctor && normalise(booking.proctor) === normalise(proctor);
        return matchRoom || matchProctor;
    });
}

/**
 * Returns the number of proctor assignments a faculty member has on a given day.
 * Uses the dailyProctorWorkload map which is keyed by normalised faculty name → day → count.
 */
function getDailyProctorCount(dailyProctorWorkload, proctorName, day) {
    const normName = normalise(proctorName);
    if (!dailyProctorWorkload.has(normName)) return 0;
    return dailyProctorWorkload.get(normName).get(day) || 0;
}

/**
 * Records that a proctor has been assigned to one more subject on the given day.
 */
function incrementDailyProctorCount(dailyProctorWorkload, proctorName, day) {
    const normName = normalise(proctorName);
    if (!dailyProctorWorkload.has(normName)) {
        dailyProctorWorkload.set(normName, new Map());
    }
    const dayMap = dailyProctorWorkload.get(normName);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
}

/**
 * Builds the initial dailyProctorWorkload from existing saved bookings so that
 * already-saved assignments are accounted for in per-day limits.
 * bookings is an array of { day, range, room, proctor }.
 */
function buildDailyProctorWorkload(bookings) {
    const workload = new Map(); // normalisedProctorName → Map<day, count>
    for (const booking of bookings) {
        if (!booking.proctor) continue;
        incrementDailyProctorCount(workload, booking.proctor, booking.day);
    }
    return workload;
}

/**
 * Evaluates whether a faculty member is eligible to proctor a specific exam subject at a given day/time slot.
 *
 * Rules:
 * 1. Faculty must NOT handle the exam subject.
 * 2. Faculty must NOT have a conflicting proctor assignment at the same time.
 * 3. Faculty must have fewer than 2 proctor assignments on that specific day.
 * 4. Faculty with "No subjects assigned" (assignedSubjects = []) are ELIGIBLE for any subject.
 */
function evaluateFacultyProctorEligibility(
    faculty,
    subjectCode,
    day,
    range,
    dailyProctorWorkload,
    conflictBookings,
    facultyAssignments,
    pendingDayIncrements = new Map(),
    pendingBookings = []
) {
    const facultyId = faculty.id || faculty.uid;
    const facultyNameStr = faculty.name || faculty.fullName || "Unknown";
    const normFacultyName = normalise(facultyNameStr);
    const normSubjectCode = normalise(subjectCode);

    // 1. Handled subjects check
    const assignedSubjects = (facultyAssignments?.get(facultyId)) ||
                             (facultyAssignments?.get(faculty.uid)) ||
                             (facultyAssignments?.get(faculty.id)) || [];
    const handlesExamSubject = normSubjectCode ? assignedSubjects.includes(normSubjectCode) : false;

    // 2. Daily workload check (saved from dailyProctorWorkload + pending from this placement)
    const savedDailyCount = getDailyProctorCount(dailyProctorWorkload, facultyNameStr, day);
    const pendingCount = pendingDayIncrements.get(normFacultyName)?.get(day) || 0;
    const totalDailyAssignments = savedDailyCount + pendingCount;
    const reachesDailyLimit = totalDailyAssignments >= 2;

    // 3. Time conflict check (across saved bookings and pending bookings in this generation run)
    const allBookingsToCheck = [...(conflictBookings || []), ...(pendingBookings || [])];
    const hasTimeConflict = allBookingsToCheck.some(booking =>
        booking.day === day &&
        intervalsOverlap(range, booking.range) &&
        normalise(booking.proctor) === normFacultyName
    );

    let isEligible = true;
    let reason = "No handled-subject conflict";

    if (handlesExamSubject) {
        isEligible = false;
        reason = `Handles ${subjectCode}`;
    } else if (reachesDailyLimit) {
        isEligible = false;
        reason = `Already has 2 assignments on ${day}`;
    } else if (hasTimeConflict) {
        isEligible = false;
        reason = `Time conflict on ${day}`;
    }

    return {
        faculty,
        facultyName: facultyNameStr,
        assignedSubjects,
        isEligible,
        reason,
        dailyAssignments: totalDailyAssignments,
        hasTimeConflict
    };
}

/**
 * Logs the proctor eligibility calculation to the browser console.
 * Formats output matching the requirement:
 * Faculty 1
 * Assigned subjects: []
 * Eligible: YES
 * Reason: No handled-subject conflict
 * Daily assignments: 0
 * Time conflict: NO
 */
function logProctorEligibilityEvaluation(evaluations, subjectCode, day, timeStr, context = "") {
    console.group(`[Proctor Eligibility Evaluation] ${context ? `${context} — ` : ""}Subject: ${subjectCode} (${day} ${timeStr || ""})`);
    for (const ev of evaluations) {
        console.log(
            `${ev.facultyName}\n` +
            `Assigned subjects: [${ev.assignedSubjects.join(", ")}]\n` +
            `Eligible for ${subjectCode}: ${ev.isEligible ? "YES" : "NO"}\n` +
            `Reason: ${ev.reason}\n` +
            `Daily assignments: ${ev.dailyAssignments}\n` +
            `Time conflict: ${ev.hasTimeConflict ? "YES" : "NO"}`
        );
    }
    console.groupEnd();
}

function findDaySlotsForSection(
    subjects,
    roomsToTry,
    bookings,
    dailyProctorWorkload,
    conflictBookings,
    facultyPool,
    facultyAssignments,
    sectionTitle
) {
    const dayAssignments = {};
    for (const day of DAYS) {
        dayAssignments[day] = [];
    }

    const usedRooms = {};
    const assignedExams = [];
    // pendingDayIncrements: Map<normFacultyName, Map<day, count>>
    const pendingDayIncrements = new Map();
    const pendingBookings = [];

    const isLargeSection = subjects.length >= 10;
    const maxSubjectsLimit = isLargeSection ? 8 : MAX_SUBJECTS_PER_DAY;

    function addPendingIncrement(facultyName, day) {
        const norm = normalise(facultyName);
        if (!pendingDayIncrements.has(norm)) {
            pendingDayIncrements.set(norm, new Map());
        }
        const dayMap = pendingDayIncrements.get(norm);
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }

    /**
     * Attempts to place a single subject on a given day, finding both a valid room
     * and the best eligible proctor.
     */
    function tryPlace(subject, day, restrictPM, allowExtendedPM = false) {
        if (dayAssignments[day].length >= maxSubjectsLimit) return null;

        const boundStart = restrictPM ? LUNCH_END : DAY_START;
        const boundEnd = restrictPM ? (allowExtendedPM ? DAY_END : PM_END) : LUNCH_END;

        // Build candidate start times with 1-hour gaps
        const candidateStarts = [boundStart];
        for (const assignment of dayAssignments[day]) {
            const nextStart = assignment.range.end + 60;
            const adjusted = (nextStart > LUNCH_START && nextStart < LUNCH_END) ? LUNCH_END : nextStart;
            candidateStarts.push(adjusted);
        }

        const uniqueStarts = [...new Set(candidateStarts)].sort((a, b) => a - b);

        for (const start of uniqueStarts) {
            if (start < boundStart) continue;
            if (start + subject.duration > boundEnd) continue;

            const end = start + subject.duration;
            const range = { start, end };

            // Conflict with another subject in the same section
            if (dayAssignments[day].some(a => intervalsOverlap(range, a.range))) continue;

            const chkBookings = [...(conflictBookings || bookings), ...pendingBookings];

            // Evaluate room candidates (Pass 1: Priority rooms, Pass 2: Gaps in occupied rooms)
            const availableRooms = [];

            // Pass 1: Priority rooms
            for (const room of roomsToTry) {
                const roomName = room.roomName || room.roomCode;
                const hasRoomConflict = chkBookings.some(b =>
                    b.day === day && intervalsOverlap(range, b.range) && normalise(b.room) === normalise(roomName)
                );
                if (!hasRoomConflict) {
                    availableRooms.push(roomName);
                }
            }

            // Pass 2: Gaps in occupied rooms
            if (availableRooms.length === 0) {
                const roomsWithBookings = {};
                for (const b of chkBookings) {
                    if (b.day === day && b.range) {
                        if (!roomsWithBookings[b.room]) roomsWithBookings[b.room] = [];
                        roomsWithBookings[b.room].push(b);
                    }
                }
                for (const [roomName, roomBkgs] of Object.entries(roomsWithBookings)) {
                    roomBkgs.sort((a, b) => a.range.start - b.range.start);
                    for (let i = 0; i < roomBkgs.length - 1; i++) {
                        const gapStart = roomBkgs[i].range.end;
                        const gapEnd = roomBkgs[i + 1].range.start;
                        if (gapEnd - gapStart >= subject.duration && start >= gapStart && start + subject.duration <= gapEnd) {
                            const hasRoomConflict = chkBookings.some(b =>
                                b.day === day && intervalsOverlap(range, b.range) && normalise(b.room) === normalise(roomName)
                            );
                            if (!hasRoomConflict && !availableRooms.includes(roomName)) {
                                availableRooms.push(roomName);
                            }
                        }
                    }
                    if (roomBkgs.length > 0) {
                        const firstBkg = roomBkgs[0];
                        if (firstBkg.range.start - boundStart >= subject.duration && start >= boundStart && start + subject.duration <= firstBkg.range.start) {
                            const hasRoomConflict = chkBookings.some(b =>
                                b.day === day && intervalsOverlap(range, b.range) && normalise(b.room) === normalise(roomName)
                            );
                            if (!hasRoomConflict && !availableRooms.includes(roomName)) {
                                availableRooms.push(roomName);
                            }
                        }
                    }
                }
            }

            if (availableRooms.length === 0) continue;

            const selectedRoom = availableRooms[0];

            // Evaluate all faculty candidates for this slot
            const evaluations = facultyPool.map(candidate =>
                evaluateFacultyProctorEligibility(
                    candidate,
                    subject.code,
                    day,
                    range,
                    dailyProctorWorkload,
                    conflictBookings,
                    facultyAssignments,
                    pendingDayIncrements,
                    pendingBookings
                )
            );

            const eligibleCandidates = evaluations.filter(e => e.isEligible);

            if (eligibleCandidates.length === 0) {
                const timeStr = timeRange(start, subject.duration);
                logProctorEligibilityEvaluation(evaluations, subject.code, day, timeStr, `${sectionTitle || "Section"} (No eligible proctor at ${timeStr})`);
                continue;
            }

            // Rank eligible candidates:
            // 1. Re-use faculty already assigned to this section on THIS day if they have < 2 assignments today
            // 2. Re-use faculty already assigned to this section on other days
            // 3. Lowest cumulative workload across all days
            eligibleCandidates.sort((a, b) => {
                const aName = a.facultyName;
                const bName = b.facultyName;

                const aInThisSectionToday = dayAssignments[day].some(asg => normalise(asg.proctor) === normalise(aName)) ? 1 : 0;
                const bInThisSectionToday = dayAssignments[day].some(asg => normalise(asg.proctor) === normalise(bName)) ? 1 : 0;
                if (aInThisSectionToday !== bInThisSectionToday) {
                    return bInThisSectionToday - aInThisSectionToday;
                }

                const aInThisSectionAnyDay = assignedExams.some(asg => normalise(asg.proctor) === normalise(aName)) ? 1 : 0;
                const bInThisSectionAnyDay = assignedExams.some(asg => normalise(asg.proctor) === normalise(bName)) ? 1 : 0;
                if (aInThisSectionAnyDay !== bInThisSectionAnyDay) {
                    return bInThisSectionAnyDay - aInThisSectionAnyDay;
                }

                const totalWorkloadA = [...(dailyProctorWorkload.get(normalise(aName))?.values() || [])].reduce((s, v) => s + v, 0) +
                    [...(pendingDayIncrements.get(normalise(aName))?.values() || [])].reduce((s, v) => s + v, 0);
                const totalWorkloadB = [...(dailyProctorWorkload.get(normalise(bName))?.values() || [])].reduce((s, v) => s + v, 0) +
                    [...(pendingDayIncrements.get(normalise(bName))?.values() || [])].reduce((s, v) => s + v, 0);

                return totalWorkloadA - totalWorkloadB;
            });

            const chosen = eligibleCandidates[0];
            const chosenFaculty = chosen.faculty;
            const chosenProctorName = chosen.facultyName;
            const chosenProctorUid = chosenFaculty.id || chosenFaculty.uid || "";

            return {
                range,
                room: selectedRoom,
                proctor: chosenProctorName,
                proctorUid: chosenProctorUid
            };
        }

        return null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 1: Standard ordered half-day slots:
    //  day1-AM(2) → day1-PM(2) → day2-AM(2) → day2-PM(2) → etc.
    // ─────────────────────────────────────────────────────────────────
    const halfDaySlots = DAYS.flatMap(day => [
        { day, restrictPM: false, label: "AM" },
        { day, restrictPM: true, label: "PM" }
    ]);

    let subjectIdx = 0;

    for (const { day, restrictPM } of halfDaySlots) {
        let placedInHalfDay = 0;
        while (subjectIdx < subjects.length && placedInHalfDay < 2) {
            const subject = subjects[subjectIdx];
            const result = tryPlace(subject, day, restrictPM, false);

            if (result) {
                const examEntry = {
                    subject,
                    range: result.range,
                    day,
                    room: result.room,
                    proctor: result.proctor,
                    proctorUid: result.proctorUid
                };
                dayAssignments[day].push(examEntry);
                assignedExams.push(examEntry);
                usedRooms[subject.code || subject.name] = result.room;

                addPendingIncrement(result.proctor, day);
                pendingBookings.push({
                    day,
                    range: result.range,
                    room: result.room,
                    proctor: result.proctor
                });

                subjectIdx++;
                placedInHalfDay++;
            } else {
                break;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 2 (EXCEPTION FOR 10+ SUBJECTS ONLY):
    // ─────────────────────────────────────────────────────────────────
    if (isLargeSection && subjectIdx < subjects.length) {
        for (const day of DAYS) {
            while (subjectIdx < subjects.length) {
                const subject = subjects[subjectIdx];
                const result = tryPlace(subject, day, true, true);
                if (result) {
                    const examEntry = {
                        subject,
                        range: result.range,
                        day,
                        room: result.room,
                        proctor: result.proctor,
                        proctorUid: result.proctorUid
                    };
                    dayAssignments[day].push(examEntry);
                    assignedExams.push(examEntry);
                    usedRooms[subject.code || subject.name] = result.room;

                    addPendingIncrement(result.proctor, day);
                    pendingBookings.push({
                        day,
                        range: result.range,
                        room: result.room,
                        proctor: result.proctor
                    });

                    subjectIdx++;
                } else {
                    break;
                }
            }
            if (subjectIdx >= subjects.length) break;
        }

        if (subjectIdx < subjects.length) {
            for (const day of DAYS) {
                while (subjectIdx < subjects.length) {
                    const subject = subjects[subjectIdx];
                    const result = tryPlace(subject, day, false, false);
                    if (result) {
                        const examEntry = {
                            subject,
                            range: result.range,
                            day,
                            room: result.room,
                            proctor: result.proctor,
                            proctorUid: result.proctorUid
                        };
                        dayAssignments[day].push(examEntry);
                        assignedExams.push(examEntry);
                        usedRooms[subject.code || subject.name] = result.room;

                        addPendingIncrement(result.proctor, day);
                        pendingBookings.push({
                            day,
                            range: result.range,
                            room: result.room,
                            proctor: result.proctor
                        });

                        subjectIdx++;
                    } else {
                        break;
                    }
                }
                if (subjectIdx >= subjects.length) break;
            }
        }
    }

    if (subjectIdx < subjects.length) {
        const failedSubject = subjects[subjectIdx];
        console.warn(`[Proctor Generation Warning] Could not place subject ${failedSubject.code} for ${sectionTitle || "Section"}.`);
        const evaluations = facultyPool.map(candidate =>
            evaluateFacultyProctorEligibility(
                candidate,
                failedSubject.code,
                DAYS[0],
                { start: DAY_START, end: DAY_START + failedSubject.duration },
                dailyProctorWorkload,
                conflictBookings,
                facultyAssignments,
                pendingDayIncrements,
                pendingBookings
            )
        );
        logProctorEligibilityEvaluation(evaluations, failedSubject.code, DAYS[0], "", `Final Failure Log for ${sectionTitle || "Section"}`);
        return null;
    }

    return { dayAssignments, usedRooms, assignedExams, pendingDayIncrements, pendingBookings };
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
                            <th>Proctor</th>
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
                                <td>${escapeHtml(exam.proctor || schedule.proctor || "TBA")}</td>
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
    const [faculty, prospectus, facultyAssignments] = await Promise.all([
        loadFaculty(),
        loadProspectusSubjects(),
        loadFacultySubjectAssignments()
    ]);
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

    /* bookings — same exam type only.
       Used for: room availability, per-day workload seeding, and room-gap
       fallback detection.  Scoped to the current exam type so Prelim room
       slots don't block Midterm/Finals slots. */
    const bookings = allExistingExamEntries(examType, examAcademicYear, examSemester);

    /* allTypeBookings — all exam types, same AY + semester.
       Used ONLY for time-conflict checking so a faculty already proctoring
       a different exam type (e.g. Prelim) at the same time slot cannot be
       double-booked for the current generation (e.g. Midterm).
       Faculty are otherwise free to proctor across exam types — their daily
       workload counter resets independently per exam type. */
    const allTypeBookings = allExamTypeEntries(examAcademicYear, examSemester);

    /* ----------------------------------------------------------------
       Track proctor assignments PER DAY instead of globally.
       dailyProctorWorkload: Map<normalisedFacultyName, Map<day, count>>
       Seeded from same-exam-type bookings only so the per-day limit
       resets between Preliminary, Midterm, and Final examinations.
       Faculty can work on any number of exam days — the 2-subject
       limit resets each day AND resets for each exam type.
    ---------------------------------------------------------------- */
    const dailyProctorWorkload = buildDailyProctorWorkload(bookings);

    const proctors = shuffled(faculty);
    generatedExamSchedules = [];

    // Build the examDates map from selectedDates and sync DAYS
    const examDates = {};
    for (const dateStr of selectedDates) {
        const dayName = getDayName(dateStr);
        examDates[dayName] = dateStr;
    }
    DAYS = [...new Set(selectedDates.map(dateStr => getDayName(dateStr)))];

    // Load all available lecture rooms once for all sections
    const rooms = await loadLectureRooms();
    if (!rooms.all.length) {
        showToast("No available lecture rooms found in Building A, Building B, or Admin Building.");
        return;
    }

    /* ================================================================
       SUBJECT-FIRST SYNCHRONIZATION ALGORITHM
       ================================================================
       Rule: All sections taking the SAME subject (same AY + Semester +
       Exam Type) must sit the exam on the EXACT SAME day and time.
       Each section gets a DIFFERENT room at that shared slot.
       ================================================================ */

    /* --- Step 1: Seed subjectExamSlots from already-saved schedules ---
       If CPT01 was already saved as Monday 8:00-9:30 in a prior generation
       for this same AY + Semester + examType, any newly generated sections
       taking CPT01 MUST reuse Monday 8:00-9:30. */
    const subjectExamSlots = new Map(); // normCode => { day, range, time, duration }

    {
        const localSchedules = readStorage(EXAM_SCHEDULES_KEY);
        const combined = [...firestoreExamSchedules, ...localSchedules];
        const seenIds = new Set();
        for (const s of combined) {
            const id = s.id || `${s.academicYear}_${s.semester}_${s.examType}_${s.section}`;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            if (s.examType !== examType) continue;
            if (examAcademicYear && (s.academicYear || "").trim() !== examAcademicYear.trim()) continue;
            if (examSemester && (s.semester || "").trim().toLowerCase() !== examSemester.trim().toLowerCase()) continue;
            for (const exam of (s.exams || [])) {
                const normCode = normalise(exam.code);
                if (!normCode || subjectExamSlots.has(normCode)) continue;
                const range = splitRange(exam.time);
                if (exam.day && range) {
                    subjectExamSlots.set(normCode, {
                        day: exam.day,
                        range,
                        time: exam.time,
                        duration: exam.duration || (range.end - range.start)
                    });
                }
            }
        }
    }

    /* --- Step 2: Build per-section subject lists and a global subject map ---
       subjectInfoMap: normCode => { code, name, subjectType, duration }
       subjectSections: normCode => [ { classSchedule, sectionTitle } ]  */
    const subjectInfoMap = new Map();
    const subjectSections = new Map(); // normCode => array of { classSchedule, sectionTitle }

    for (const classSchedule of selectedSchedules) {
        const sectionTitleStr = scheduleTitle(classSchedule);
        const subjects = buildExamSubjects(classSchedule, prospectus);

        if (!subjects.length) {
            showToast(`${sectionTitleStr} has no subjects to schedule.`);
            generatedExamSchedules = [];
            renderGeneratedExams();
            return;
        }

        for (const subj of subjects) {
            const normCode = normalise(subj.code || subj.name);
            if (!normCode) continue;
            if (!subjectInfoMap.has(normCode)) {
                subjectInfoMap.set(normCode, subj);
            }
            if (!subjectSections.has(normCode)) {
                subjectSections.set(normCode, []);
            }
            subjectSections.get(normCode).push({ classSchedule, sectionTitle: sectionTitleStr });
        }
    }

    /* --- Step 3: Determine processing order for unique subjects ---
       Priority: subjects with the most simultaneous sections first (most
       constrained), then major (90 min) before minor (60 min). */
    const subjectOrder = [...subjectInfoMap.keys()].sort((a, b) => {
        const secCountDiff = (subjectSections.get(b)?.length || 0) - (subjectSections.get(a)?.length || 0);
        if (secCountDiff !== 0) return secCountDiff;
        const durA = subjectInfoMap.get(a)?.duration || 60;
        const durB = subjectInfoMap.get(b)?.duration || 60;
        return durB - durA; // majors (90) before minors (60)
    });

    /* --- Per-section day-assignment tracker (used for gap/overlap checks) ---
       sectionDayMap: normSectionId => Map<day, [ { range, room, proctor } ]> */
    const sectionDayMap = new Map();
    const sectionSubjectCount = new Map(); // normSectionId => Map<day, count> (for MAX_SUBJECTS_PER_DAY)
    const sectionProctors = new Map(); // normSectionId => Set<normalisedFacultyName> (ensures 2-3 proctors per section)
    for (const cs of selectedSchedules) {
        const id = cs.id || normalise(scheduleTitle(cs));
        sectionDayMap.set(id, new Map());
        sectionSubjectCount.set(id, new Map());
        sectionProctors.set(id, new Set());
    }

    /* Pending proctor bookings and workload increments accumulated during
       this generation run (shared across all subjects / all sections). */
    const pendingBookings = [];
    const pendingDayIncrements = new Map(); // normFacultyName => Map<day, count>

    function addPendingIncrement(facultyName, day) {
        const norm = normalise(facultyName);
        if (!pendingDayIncrements.has(norm)) pendingDayIncrements.set(norm, new Map());
        const dm = pendingDayIncrements.get(norm);
        dm.set(day, (dm.get(day) || 0) + 1);
    }

    /* Commit a placed subject assignment immediately into shared tracking state */
    function commitSubjectAssignment(normCode, asgn) {
        const sectionsInvolved = subjectSections.get(normCode) || [];

        sectionsInvolved.forEach(({ classSchedule }, idx) => {
            const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
            const room       = asgn.rooms[idx];
            const proctorInfo = asgn.proctors[idx];

            if (!sectionDayMap.get(secId).has(asgn.day)) {
                sectionDayMap.get(secId).set(asgn.day, []);
            }
            sectionDayMap.get(secId).get(asgn.day).push({
                range: asgn.range, room, proctor: proctorInfo.proctor, code: normCode
            });

            const subjCountMap = sectionSubjectCount.get(secId);
            subjCountMap.set(asgn.day, (subjCountMap.get(asgn.day) || 0) + 1);

            if (proctorInfo?.proctor) {
                sectionProctors.get(secId)?.add(normalise(proctorInfo.proctor));
            }

            bookings.push({ day: asgn.day, range: asgn.range, room, proctor: proctorInfo.proctor });
            allTypeBookings.push({ day: asgn.day, range: asgn.range, room, proctor: proctorInfo.proctor });
            pendingBookings.push({ day: asgn.day, range: asgn.range, room, proctor: proctorInfo.proctor });
            // NOTE: Only increment dailyProctorWorkload here (the authoritative counter).
            // addPendingIncrement is NOT called here to avoid double-counting with dailyProctorWorkload
            // in evaluateFacultyProctorEligibility (savedDailyCount + pendingCount would double the tally).
            incrementDailyProctorCount(dailyProctorWorkload, proctorInfo.proctor, asgn.day);
        });

        subjectExamSlots.set(normCode, {
            day: asgn.day,
            range: asgn.range,
            time: asgn.time,
            duration: asgn.duration
        });
    }

    /* Determine candidate start times on a given day for a set of sections.
       A start time is a candidate if it is boundStart OR (someSection.end + BREAK_MINUTES)
       OR a time when an occupied room becomes free on that day,
       OR any 30-minute increment from boundStart to boundEnd - duration (full sweep). */
    function getCandidateStarts(sectionsInvolved, day, boundStart, boundEnd, duration) {
        const starts = new Set([boundStart]);
        for (const { classSchedule } of sectionsInvolved) {
            const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
            const dayAssigs = sectionDayMap.get(secId)?.get(day) || [];
            for (const asg of dayAssigs) {
                const next = asg.range.end + BREAK_MINUTES;
                const adjusted = (next > LUNCH_START && next < LUNCH_END) ? LUNCH_END : next;
                starts.add(adjusted);
            }
        }
        const chkBookings = [...bookings, ...pendingBookings];
        for (const b of chkBookings) {
            if (b.day === day && b.range) {
                const end = b.range.end;
                const adjusted = (end > LUNCH_START && end < LUNCH_END) ? LUNCH_END : end;
                starts.add(adjusted);
                const next = adjusted + BREAK_MINUTES;
                const adjustedNext = (next > LUNCH_START && next < LUNCH_END) ? LUNCH_END : next;
                starts.add(adjustedNext);
            }
        }
        // Full 30-minute sweep across the entire bound window so no valid gap is missed
        if (boundEnd !== undefined && duration !== undefined) {
            for (let t = boundStart; t + duration <= boundEnd; t += 30) {
                const adjusted = (t > LUNCH_START && t < LUNCH_END) ? LUNCH_END : t;
                starts.add(adjusted);
            }
        }
        return [...starts].sort((a, b) => a - b);
    }

    /* Check whether a given (day, range) is valid for ALL sections involved.
       Rules:
        1. Range fits within [boundStart, boundEnd].
        2. No existing assignment for any section overlaps range on day.
        3. At least a 60-minute gap with every existing assignment (lunch counts as break).
        4. Section has not hit maxSubjectsLimit on day.
        5. Section has not hit 2 subjects in this half-day. */
    function isSlotValidForAllSections(sectionsInvolved, day, range, boundStart, boundEnd, isLargeSection) {
        const maxSubjectsLimit = isLargeSection ? 8 : MAX_SUBJECTS_PER_DAY;
        if (range.start < boundStart || range.end > boundEnd) return false;
        for (const { classSchedule } of sectionsInvolved) {
            const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
            const dayAssigs = sectionDayMap.get(secId)?.get(day) || [];
            const dayCount = sectionSubjectCount.get(secId)?.get(day) || 0;

            if (dayCount >= maxSubjectsLimit) return false;

            // Half-day count limit (max 2 per AM or PM half-day)
            const isAM = boundStart < LUNCH_START;
            const halfDayAssigs = dayAssigs.filter(a =>
                isAM ? a.range.end <= LUNCH_START : a.range.start >= LUNCH_END
            );
            if (halfDayAssigs.length >= 2) return false;

            // Overlap and gap check
            for (const asg of dayAssigs) {
                if (intervalsOverlap(range, asg.range)) return false;
                // 60-minute gap (lunch break counts as the gap)
                const lunchBridges = asg.range.end <= LUNCH_START && range.start >= LUNCH_END;
                const lunchBridgesReverse = range.end <= LUNCH_START && asg.range.start >= LUNCH_END;
                if (!lunchBridges && !lunchBridgesReverse) {
                    if (asg.range.end <= range.start && range.start < asg.range.end + BREAK_MINUTES) return false;
                    if (range.end <= asg.range.start && asg.range.start < range.end + BREAK_MINUTES) return false;
                }
            }
        }
        return true;
    }

    /* For a given (day, range), collect rooms available for each section in
       sectionsInvolved, respecting building preference, while ensuring each
       section receives a DISTINCT room.
       Returns an array parallel to sectionsInvolved: [ roomName ],
       or null if there are not enough distinct rooms. */
    function assignRoomsForSlot(sectionsInvolved, day, range) {
        const chkBookings = [...bookings, ...pendingBookings];
        // Rooms already booked at this exact slot (from saved + pending)
        const roomsTakenAtSlot = new Set(
            chkBookings
                .filter(b => b.day === day && b.range && intervalsOverlap(range, b.range) && b.room)
                .map(b => normalise(b.room))
        );

        const assigned = [];
        const usedInThisGroup = new Set(); // rooms claimed within THIS subject's sections

        for (const { classSchedule } of sectionsInvolved) {
            const preferredBuilding = getExamBuildingPriority(classSchedule.program);
            // Build priority-ordered room list for this section
            const roomsToTry = [];
            if (preferredBuilding) {
                const bk = normalise(preferredBuilding);
                if (rooms.byBuilding[bk]) roomsToTry.push(...rooms.byBuilding[bk]);
                const ak = normalise("Admin Building");
                if (ak !== bk && rooms.byBuilding[ak]) roomsToTry.push(...rooms.byBuilding[ak]);
                for (const [bldg, bldgRooms] of Object.entries(rooms.byBuilding)) {
                    if (bldg !== bk && bldg !== normalise("Admin Building")) {
                        roomsToTry.push(...bldgRooms);
                    }
                }
            } else {
                roomsToTry.push(...rooms.all);
            }

            let picked = null;
            for (const room of roomsToTry) {
                const rn = room.roomName || room.roomCode;
                const normRn = normalise(rn);
                if (!roomsTakenAtSlot.has(normRn) && !usedInThisGroup.has(normRn)) {
                    picked = rn;
                    break;
                }
            }
            if (!picked) return null; // Not enough distinct rooms
            usedInThisGroup.add(normalise(picked));
            assigned.push(picked);
        }
        return assigned;
    }

    /* For a given (day, range, subjectCode), find an eligible proctor for each
       section in sectionsInvolved.
       Returns an array parallel to sectionsInvolved, or null if any section
       cannot be assigned an eligible proctor. */
    function assignProctorsForSlot(sectionsInvolved, day, range, subjectCode) {
        const assigned = [];
        // Snapshot so we can track within-slot proctor assignment without
        // permanently mutating the shared pendingBookings / pendingDayIncrements yet.
        const localPendingBookings = [...pendingBookings];
        const localPendingIncrements = new Map(
            [...pendingDayIncrements].map(([k, v]) => [k, new Map(v)])
        );

        function localAddIncrement(name, d) {
            const norm = normalise(name);
            if (!localPendingIncrements.has(norm)) localPendingIncrements.set(norm, new Map());
            const dm = localPendingIncrements.get(norm);
            dm.set(d, (dm.get(d) || 0) + 1);
        }

        for (const { classSchedule } of sectionsInvolved) {
            const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
            const secProctorSet = sectionProctors.get(secId) || new Set();

            const evaluations = proctors.map(candidate =>
                evaluateFacultyProctorEligibility(
                    candidate,
                    subjectCode,
                    day,
                    range,
                    dailyProctorWorkload,
                    allTypeBookings,
                    facultyAssignments,
                    localPendingIncrements,
                    localPendingBookings
                )
            );

            const eligibleCandidates = evaluations.filter(e => e.isEligible);
            if (eligibleCandidates.length === 0) return null;

            // Target 2-3 proctors per section:
            // 1. Re-use faculty already assigned to this section on THIS day (if < 2 assignments today)
            // 2. Re-use faculty already assigned to this section on any day
            // 3. Lowest cumulative workload across all days
            eligibleCandidates.sort((a, b) => {
                const aName = normalise(a.facultyName);
                const bName = normalise(b.facultyName);

                const aInThisSectionToday = (sectionDayMap.get(secId)?.get(day) || []).some(asg => normalise(asg.proctor) === aName) ? 1 : 0;
                const bInThisSectionToday = (sectionDayMap.get(secId)?.get(day) || []).some(asg => normalise(asg.proctor) === bName) ? 1 : 0;
                if (aInThisSectionToday !== bInThisSectionToday) {
                    return bInThisSectionToday - aInThisSectionToday;
                }

                const aInThisSection = secProctorSet.has(aName) ? 1 : 0;
                const bInThisSection = secProctorSet.has(bName) ? 1 : 0;
                if (aInThisSection !== bInThisSection) {
                    return bInThisSection - aInThisSection;
                }

                const wA = [...(dailyProctorWorkload.get(aName)?.values() || [])].reduce((s, v) => s + v, 0)
                    + [...(localPendingIncrements.get(aName)?.values() || [])].reduce((s, v) => s + v, 0);
                const wB = [...(dailyProctorWorkload.get(bName)?.values() || [])].reduce((s, v) => s + v, 0)
                    + [...(localPendingIncrements.get(bName)?.values() || [])].reduce((s, v) => s + v, 0);
                return wA - wB;
            });

            const chosen = eligibleCandidates[0];
            const chosenName = chosen.facultyName;
            const chosenUid = chosen.faculty.id || chosen.faculty.uid || "";

            assigned.push({ proctor: chosenName, proctorUid: chosenUid });

            // Register this proctor locally so the next section in this loop
            // will not double-book the same proctor at the same time slot.
            localPendingBookings.push({ day, range, room: "__proctor_slot_check__", proctor: chosenName });
            localAddIncrement(chosenName, day);
        }

        return assigned;
    }

    /* --- Step 4: Find one (day, range) per subject, shared across all sections ---
       Distribute exams across ALL selected exam dates by ordering days with the
       lowest subject count for the involved sections first.
       Extended PM used as a fallback for large sections or overflow. */
    const subjectAssignments = new Map();

    for (const normCode of subjectOrder) {

        /* If this subject already has a fixed slot from a previously saved
           schedule in the same AY + Semester + examType, honour it. */
        if (subjectExamSlots.has(normCode)) {
            const slot = subjectExamSlots.get(normCode);
            const sectionsInvolved = subjectSections.get(normCode) || [];
            if (!sectionsInvolved.length) continue;

            const roomAssignments = assignRoomsForSlot(sectionsInvolved, slot.day, slot.range);
            if (!roomAssignments) {
                const subj = subjectInfoMap.get(normCode);
                showToast(
                    `Insufficient room capacity for subject ${subj?.code || normCode}. ` +
                    `Not enough available rooms to schedule all ${sectionsInvolved.length} section(s) ` +
                    `simultaneously at ${slot.time} on ${slot.day}.`
                );
                generatedExamSchedules = [];
                renderGeneratedExams();
                return;
            }

            const proctorAssignments = assignProctorsForSlot(
                sectionsInvolved, slot.day, slot.range, subjectInfoMap.get(normCode)?.code || normCode
            );
            if (!proctorAssignments) {
                const subj = subjectInfoMap.get(normCode);
                showToast(
                    `Not enough eligible faculty to proctor subject ${subj?.code || normCode} ` +
                    `for all sections at ${slot.time} on ${slot.day}.`
                );
                generatedExamSchedules = [];
                renderGeneratedExams();
                return;
            }

            const asgn = {
                day: slot.day,
                range: slot.range,
                time: slot.time,
                duration: slot.duration,
                rooms: roomAssignments,
                proctors: proctorAssignments
            };
            subjectAssignments.set(normCode, asgn);
            commitSubjectAssignment(normCode, asgn);
            continue;
        }

        const subj = subjectInfoMap.get(normCode);
        if (!subj) continue;
        const sectionsInvolved = subjectSections.get(normCode) || [];
        if (!sectionsInvolved.length) continue;

        const isLargeSection = sectionsInvolved.some(({ classSchedule }) =>
            buildExamSubjects(classSchedule, prospectus).length >= 10
        );

        // Sort available DAYS to balance load across all selected exam dates.
        // Days where the sections involved have the fewest exams are tried first.
        const sortedDays = [...DAYS].sort((dayA, dayB) => {
            const loadA = Math.max(...sectionsInvolved.map(({ classSchedule }) => {
                const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
                return sectionSubjectCount.get(secId)?.get(dayA) || 0;
            }));
            const loadB = Math.max(...sectionsInvolved.map(({ classSchedule }) => {
                const secId = classSchedule.id || normalise(scheduleTitle(classSchedule));
                return sectionSubjectCount.get(secId)?.get(dayB) || 0;
            }));
            if (loadA !== loadB) return loadA - loadB;
            return DAYS.indexOf(dayA) - DAYS.indexOf(dayB);
        });

        const candidateBlocks = sortedDays.flatMap(day => [
            { day, restrictPM: false },
            { day, restrictPM: true }
        ]);

        let placed = false;

        // Pass 1 — standard half-day blocks (AM then PM, max 2 subjects per half-day)
        for (const { day, restrictPM } of candidateBlocks) {
            if (placed) break;
            const boundStart = restrictPM ? LUNCH_END : DAY_START;
            const boundEnd   = restrictPM ? PM_END    : LUNCH_START;

            const candidates = getCandidateStarts(sectionsInvolved, day, boundStart, boundEnd, subj.duration);
            for (const start of candidates) {
                const range = { start, end: start + subj.duration };
                if (!isSlotValidForAllSections(sectionsInvolved, day, range, boundStart, boundEnd, isLargeSection)) continue;

                const roomAssignments = assignRoomsForSlot(sectionsInvolved, day, range);
                if (!roomAssignments) continue;

                const proctorAssignments = assignProctorsForSlot(sectionsInvolved, day, range, subj.code || normCode);
                if (!proctorAssignments) continue;

                const asgn = {
                    day,
                    range,
                    time: timeRange(start, subj.duration),
                    duration: subj.duration,
                    rooms: roomAssignments,
                    proctors: proctorAssignments
                };
                subjectAssignments.set(normCode, asgn);
                commitSubjectAssignment(normCode, asgn);
                placed = true;
                break;
            }
        }

        // Pass 2 — extended PM fallback (up to DAY_END, for overflow / large sections)
        if (!placed) {
            for (const day of sortedDays) {
                if (placed) break;
                const boundStart = LUNCH_END;
                const boundEnd   = DAY_END;

                const candidates = getCandidateStarts(sectionsInvolved, day, boundStart, boundEnd, subj.duration);
                for (const start of candidates) {
                    const range = { start, end: start + subj.duration };
                    if (!isSlotValidForAllSections(sectionsInvolved, day, range, boundStart, boundEnd, isLargeSection)) continue;

                    const roomAssignments = assignRoomsForSlot(sectionsInvolved, day, range);
                    if (!roomAssignments) continue;

                    const proctorAssignments = assignProctorsForSlot(sectionsInvolved, day, range, subj.code || normCode);
                    if (!proctorAssignments) continue;

                    const asgn = {
                        day,
                        range,
                        time: timeRange(start, subj.duration),
                        duration: subj.duration,
                        rooms: roomAssignments,
                        proctors: proctorAssignments
                    };
                    subjectAssignments.set(normCode, asgn);
                    commitSubjectAssignment(normCode, asgn);
                    placed = true;
                    break;
                }
            }
        }

        if (!placed) {
            const roomNeeded = sectionsInvolved.length;
            showToast(
                `Could not schedule subject ${subj.code || normCode} for ${roomNeeded} section(s). ` +
                `There may not be enough available rooms, exam days, or eligible proctors ` +
                `to schedule all sections simultaneously. ` +
                `Add more exam dates or ensure at least ${roomNeeded} lecture rooms are available.`
            );
            generatedExamSchedules = [];
            renderGeneratedExams();
            return;
        }
    }

    /* --- Step 6: Build generatedExamSchedules from the committed assignments --- */
    for (const classSchedule of selectedSchedules) {
        const sectionTitleStr = scheduleTitle(classSchedule);
        const secId = classSchedule.id || normalise(sectionTitleStr);
        const subjects = buildExamSubjects(classSchedule, prospectus);

        const exams = [];
        for (const subj of subjects) {
            const normCode = normalise(subj.code || subj.name);
            const asgn = subjectAssignments.get(normCode);
            if (!asgn) continue;

            const sectionsInvolved = subjectSections.get(normCode) || [];
            const idx = sectionsInvolved.findIndex(s =>
                (s.classSchedule.id || normalise(scheduleTitle(s.classSchedule))) === secId
            );
            if (idx < 0) continue;

            exams.push({
                ...subj,
                day:        asgn.day,
                time:       asgn.time,
                room:       asgn.rooms[idx],
                proctor:    asgn.proctors[idx]?.proctor    || "TBA",
                proctorUid: asgn.proctors[idx]?.proctorUid || ""
            });
        }

        // Sort by day index then start time for readable display
        exams.sort((a, b) => {
            const dA = DAYS.indexOf(a.day);
            const dB = DAYS.indexOf(b.day);
            if (dA !== dB) return dA - dB;
            const rA = splitRange(a.time);
            const rB = splitRange(b.time);
            return (rA?.start || 0) - (rB?.start || 0);
        });

        const uniqueProctors    = [...new Set(exams.map(e => e.proctor).filter(Boolean))];
        const uniqueProctorUids = [...new Set(exams.map(e => e.proctorUid).filter(Boolean))];
        const primaryProctor    = uniqueProctors.join(", ") || "TBA";
        const primaryProctorUid = uniqueProctorUids.join(",") || "";

        const roomCounts = {};
        for (const exam of exams) {
            roomCounts[exam.room] = (roomCounts[exam.room] || 0) + 1;
        }
        const primaryRoom = Object.entries(roomCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "TBA";

        generatedExamSchedules.push({
            id:                  crypto.randomUUID(),
            classScheduleId:     classSchedule.id,
            title:               `${sectionTitleStr}`,
            section:             classSchedule.section,
            academicYear:        classSchedule.academicYear || "",
            semester:            classSchedule.semester,
            program:             classSchedule.program,
            major:               classSchedule.major,
            yearLevel:           classSchedule.yearLevel,
            proctor:             primaryProctor,
            proctorUid:          primaryProctorUid,
            facultyUid:          primaryProctorUid,
            assignedFacultyUid:  primaryProctorUid,
            room:                primaryRoom,
            examType,
            examDates,
            createdAt:           new Date().toISOString(),
            exams
        });
    }

    if (saveExamBtn) saveExamBtn.textContent = "Save Exam Schedule";

    renderGeneratedExams();
    saveExamBtn.disabled = false;
    examModal.style.display = "block";
}

function examRows(exams, schedule) {
    return exams.map(exam => `<tr>
        <td>${escapeHtml(exam.code)}</td><td>${escapeHtml(exam.name)}</td>
        <td>${escapeHtml(exam.day)}</td>
        <td>${escapeHtml(exam.time)}</td><td>${escapeHtml(exam.room)}</td>
        <td>${escapeHtml(exam.proctor || schedule?.proctor || "—")}</td>
    </tr>`).join("");
}

function renderSavedExams() {
    const rawSchedules = readStorage(EXAM_SCHEDULES_KEY);
    const empty = document.getElementById("emptyExamSchedules");
    const list = document.getElementById("savedExamSchedules");
    if (!list || !empty) return;

    /* Sort latest saved or generated exam schedule to the top */
    const schedules = [...rawSchedules].sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
    });

    empty.hidden = schedules.length > 0;
    list.innerHTML = schedules.map(schedule => {
        const isPublished = schedule.status === "published";
        const statusBadge = isPublished
            ? `<span style="display:inline-block;margin-left:8px;background:#2e7d32;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;vertical-align:middle;">✓ Published</span>`
            : `<span style="display:inline-block;margin-left:8px;background:#546e7a;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;vertical-align:middle;">Draft</span>`;
        const publishBtn = !isPublished
            ? `<button type="button" data-publish-exam="${escapeHtml(schedule.id)}" style="background:#2e7d32;color:white;border:none;border-radius:8px;padding:7px 16px;font-weight:bold;font-size:13px;cursor:pointer;">Publish</button>`
            : "";

        return `<article style="margin-top:16px">
        <div class="section-header"><div><h4 style="margin:0">${escapeHtml(schedule.title)}${statusBadge}</h4>
        <small>${escapeHtml([schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "", schedule.semester, schedule.yearLevel, schedule.examType, `Proctor: ${schedule.proctor}`].filter(Boolean).join(" • "))}</small></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${publishBtn}<button type="button" data-delete-exam="${escapeHtml(schedule.id)}">Delete</button></div></div>
        <div class="table-container"><table><thead><tr><th>Code</th><th>Subject</th><th>Day</th><th>Time</th><th>Room</th><th>Proctor</th></tr></thead>
        <tbody>${examRows(schedule.exams || [], schedule)}</tbody></table></div></article>`;
    }).join("");
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
    writeStorage(EXAM_SCHEDULES_KEY, firestoreExamSchedules);

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

async function publishAllSavedExams() {
    const publishBtn = document.getElementById("publishAllExamBtn");
    const freshFirestoreSchedules = await loadExamSchedulesFromFirestore();
    const localSchedules = readStorage(EXAM_SCHEDULES_KEY) || [];
    const schedules = freshFirestoreSchedules.length ? freshFirestoreSchedules : localSchedules;

    if (!schedules.length) {
        showToast("There are no saved exam schedules to publish.");
        return;
    }

    const unpublishedCount = schedules.filter(s => s.status !== "published").length;
    const confirmPrompt = unpublishedCount > 0
        ? `Are you sure you want to publish all ${schedules.length} saved exam schedule(s)? (${unpublishedCount} currently draft/unpublished). This will make them visible to faculty and students on their dashboards.`
        : `Are you sure you want to re-publish all ${schedules.length} saved exam schedule(s)? This will re-verify their published status and notify faculty.`;

    const confirmed = await showConfirm(confirmPrompt, {
        title: "Publish All Exam Schedules",
        confirmText: "Yes, Publish All",
        cancelText: "Cancel"
    });

    if (!confirmed) return;

    const origText = publishBtn ? publishBtn.innerHTML : "";
    if (publishBtn) {
        publishBtn.disabled = true;
        publishBtn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;"></span> Publishing...';
    }

    try {
        let successCount = 0;
        let totalSent = 0;

        for (const schedule of schedules) {
            schedule.status = "published";
            schedule.publishedAt = new Date().toISOString();
            schedule.publishedBy = auth.currentUser?.uid || null;

            try {
                await saveExamScheduleToFirestore(schedule);
                successCount++;
                const result = await publishExamScheduleApi(schedule);
                if (result && result.sentCount) totalSent += result.sentCount;
            } catch (err) {
                console.error("Could not publish exam schedule:", schedule.title || schedule.id, err);
            }
        }

        /* Refresh local storage and UI from Firestore */
        firestoreExamSchedules = await loadExamSchedulesFromFirestore();
        writeStorage(EXAM_SCHEDULES_KEY, firestoreExamSchedules);
        renderSavedExams();
        renderClassSchedules();

        const emailInfo = totalSent > 0 ? ` (${totalSent} email notifications sent)` : "";
        if (savedOverlay) {
            savedOverlay.classList.remove("fade-out");
            savedOverlay.style.display = "flex";
            const overlaySpan = savedOverlay.querySelector("span");
            if (overlaySpan) overlaySpan.textContent = `Published ${successCount} exam schedule(s)!${emailInfo}`;
            setTimeout(() => { savedOverlay.classList.add("fade-out"); }, 1400);
            setTimeout(() => { savedOverlay.style.display = "none"; savedOverlay.classList.remove("fade-out"); }, 2000);
        } else {
            showToast(`Successfully published ${successCount} exam schedule(s)!${emailInfo}`);
        }
    } catch (error) {
        console.error("Error publishing all exam schedules:", error);
        showToast(`Failed to publish all exam schedules: ${error.message}`);
    } finally {
        if (publishBtn) {
            publishBtn.disabled = false;
            publishBtn.innerHTML = origText || "Publish All";
        }
    }
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
    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
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
        const DAYS_ORDER = Object.keys(examDates).sort((a, b) => {
            const dateA = examDates[a] || "";
            const dateB = examDates[b] || "";
            return dateA.localeCompare(dateB);
        });

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
                    <td>${escapeHtml(exam.proctor || schedule.proctor || "")}</td>
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
            sections: groupSchedules.map(s => s.section || ""),
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

        // Record successfully exported schedule IDs for clearing from saved card
        for (const sched of groupSchedules) {
            allSuccessfullyExportedIds.add(sched.id);
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

        exportedGroupsCount++;
    }

    // Refresh Firestore schedules & cached reports without deleting examSchedules from Firestore

    // Refresh Firestore schedules & cached reports
    firestoreExamSchedules = await loadExamSchedulesFromFirestore();
    try {
        cachedExamReports = await loadReportsFromFirestore();
    } catch (err) {
        console.warn("Could not reload reports after export:", err);
    }

    renderSavedExams();
    renderClassSchedules();

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
    const docId = schedule.id || examScheduleDocId(schedule);

    const status = schedule.status === "published" ? "published" : (schedule.status || "draft");

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
        proctorUid: schedule.proctorUid || schedule.facultyUid || schedule.assignedFacultyUid || "",
        facultyUid: schedule.facultyUid || schedule.proctorUid || schedule.assignedFacultyUid || "",
        assignedFacultyUid: schedule.assignedFacultyUid || schedule.proctorUid || schedule.facultyUid || "",
        room: schedule.room,
        examType: schedule.examType || "",
        examDates: schedule.examDates || {},
        exams: schedule.exams,
        status,
        createdAt: schedule.createdAt
            ? new Date(schedule.createdAt)
            : new Date(),
        updatedAt: new Date()
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

    await setDoc(doc(db, EXAM_SCHEDULES_COLLECTION, docId), data);
}

async function publishExamScheduleApi(schedule) {
    const payload = {
        scheduleId: schedule.id || examScheduleDocId(schedule),
        scheduleData: schedule,
        examType: schedule.examType || "",
        publishedBy: auth.currentUser?.uid || null
    };

    let response = null;
    try {
        response = await fetch("/api/publish/exam-schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        try {
            response = await fetch("http://localhost:3000/api/publish/exam-schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } catch (fallbackErr) {
            console.warn("Backend exam publish API unreachable:", fallbackErr.message);
        }
    }

    if (response && response.ok) {
        try {
            return await response.json();
        } catch (_) {}
        return { success: true };
    }
    return { success: false, message: response ? `HTTP ${response.status}` : "Backend unreachable" };
}

async function loadExamSchedulesFromFirestore() {
    try {
        const examSchedulesCollection = collection(db, EXAM_SCHEDULES_COLLECTION);
        const snapshot = await getDocs(examSchedulesCollection);
        const loaded = snapshot.docs.map(document => {
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
                examDates: data.examDates || {},
                exams: data.exams || [],
                status: data.status || "draft",
                publishedAt: data.publishedAt?.toDate?.()?.toISOString?.() || data.publishedAt || null,
                publishedBy: data.publishedBy || null,
                releaseId: data.releaseId || null,
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || null
            };
        });

        /* Sort latest saved exam schedules to the top */
        return loaded.sort((a, b) => {
            const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
            return bTime - aTime;
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

// ======================================
// 📢 PUBLISH EXAM SCHEDULE (Preview Modal)
// ======================================
publishExamBtn?.addEventListener("click", async () => {
    if (!generatedExamSchedules.length || publishExamBtn.disabled) return;

    const setLoading = () => {
        publishExamBtn.disabled = true;
        if (saveExamBtn) saveExamBtn.disabled = true;
        publishExamBtn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;"></span> Publishing...';
    };
    const resetState = () => {
        publishExamBtn.disabled = false;
        if (saveExamBtn) saveExamBtn.disabled = false;
        publishExamBtn.innerHTML = 'Publish Exam Schedule';
    };

    setLoading();

    try {
        /* Query fresh schedules from Firestore for conflict check */
        const freshFirestoreExamSchedules = await loadExamSchedulesFromFirestore();
        writeStorage(EXAM_SCHEDULES_KEY, freshFirestoreExamSchedules);

        const saved = [...freshFirestoreExamSchedules];
        const schedulesToPublish = [];

        for (const generated of generatedExamSchedules) {
            const existingIndex = saved.findIndex(schedule =>
                (schedule.academicYear || "").trim() === (generated.academicYear || "").trim() &&
                (schedule.semester || "").trim().toLowerCase() === (generated.semester || "").trim().toLowerCase() &&
                normalise(schedule.section) === normalise(generated.section) &&
                schedule.examType === generated.examType
            );
            if (existingIndex >= 0) {
                const confirmed = await showConfirm(`An exam schedule for ${generated.section} (${generated.examType}) already exists. Replace and publish it?`);
                if (!confirmed) continue;
            }
            const docId = examScheduleDocId(generated);
            generated.id = docId;
            generated.status = "published";
            if (existingIndex >= 0) saved[existingIndex] = generated;
            else saved.unshift(generated);
            schedulesToPublish.push(generated);
        }

        if (!schedulesToPublish.length) {
            resetState();
            return;
        }

        /* Save all to Firestore as published */
        for (const schedule of schedulesToPublish) {
            await saveExamScheduleToFirestore(schedule);
        }

        /* Dispatch email notifications via backend */
        let totalSent = 0;
        for (const schedule of schedulesToPublish) {
            const result = await publishExamScheduleApi(schedule);
            if (result.sentCount) totalSent += result.sentCount;
        }

        /* Refresh UI */
        firestoreExamSchedules = await loadExamSchedulesFromFirestore();
        writeStorage(EXAM_SCHEDULES_KEY, firestoreExamSchedules);
        generatedExamSchedules = [];
        resetState();
        renderGeneratedExams();
        renderSavedExams();
        renderClassSchedules();
        examModal.style.display = "none";

        /* Success overlay */
        if (savedOverlay) {
            savedOverlay.classList.remove("fade-out");
            savedOverlay.style.display = "flex";
            const overlaySpan = savedOverlay.querySelector("span");
            if (overlaySpan) overlaySpan.textContent = `Exam schedule published! ${totalSent} email(s) sent.`;
            setTimeout(() => { savedOverlay.classList.add("fade-out"); }, 1200);
            setTimeout(() => { savedOverlay.style.display = "none"; savedOverlay.classList.remove("fade-out"); }, 1800);
        }

    } catch (error) {
        console.error("Could not publish exam schedule:", error);
        resetState();
        showToast("Failed to publish exam schedule. Please try again.");
    }
});

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

document.getElementById("publishAllExamBtn")?.addEventListener("click", publishAllSavedExams);
document.getElementById("exportExamPdfBtn")?.addEventListener("click", exportExamPdf);
document.getElementById("deleteAllExamBtn")?.addEventListener("click", deleteAllSavedExams);
document.getElementById("savedExamSchedules")?.addEventListener("click", async event => {
    // Publish card button
    const publishExamId = event.target.dataset.publishExam;
    if (publishExamId) {
        const btn = event.target;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Publishing...";

        const schedules = readStorage(EXAM_SCHEDULES_KEY);
        const schedule = schedules.find(s => s.id === publishExamId);
        if (!schedule) {
            btn.disabled = false;
            btn.textContent = origText;
            showToast("Exam schedule not found.");
            return;
        }

        try {
            schedule.status = "published";
            await saveExamScheduleToFirestore(schedule);
            const result = await publishExamScheduleApi(schedule);

            /* Reload from Firestore */
            firestoreExamSchedules = await loadExamSchedulesFromFirestore();
            writeStorage(EXAM_SCHEDULES_KEY, firestoreExamSchedules);
            renderSavedExams();
            renderClassSchedules();

            const sentMsg = result && result.sentCount != null ? ` ${result.sentCount} email(s) sent.` : "";
            if (savedOverlay) {
                savedOverlay.classList.remove("fade-out");
                savedOverlay.style.display = "flex";
                const overlaySpan = savedOverlay.querySelector("span");
                if (overlaySpan) overlaySpan.textContent = `Exam schedule published!${sentMsg}`;
                setTimeout(() => { savedOverlay.classList.add("fade-out"); }, 1200);
                setTimeout(() => { savedOverlay.style.display = "none"; savedOverlay.classList.remove("fade-out"); }, 1800);
            }
        } catch (err) {
            console.error("Could not publish exam schedule:", err);
            btn.disabled = false;
            btn.textContent = origText;
            showToast("Failed to publish exam schedule. Please try again.");
        }
        return;
    }

    // Delete card button (original behavior)
    deleteSavedExam(event);
});
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

    /* Load archived reports so status cells reflect exported schedules */
    try {
        cachedExamReports = await loadReportsFromFirestore();
    } catch (err) {
        console.warn("Could not load reports in auth check:", err);
    }

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
    const GUIDE_DISMISSED_KEY = "examGuide_dismissed";
    const guideModal = document.getElementById("examGuideModal");
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


