import { db, auth } from "../firebase.js";
import { saveReportToFirestore } from "./reportStorage.js";
import { renderExamCalendar } from "./js/schedule-calendar.js";
import { API_BASE_URL } from "./apiConfig.js";

import {
    collection,
    getDocs,
    getDoc,
    setDoc,
    addDoc,
    doc,
    deleteDoc,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

// ===================================================
// CONSTANTS & STATE
// ===================================================
const EXAM_SCHEDULES_KEY = "chairpersonExamSchedules";

const PROGRAM_MAJORS = {
    "BIT": ["CPT"],
    "BINDTECH": ["CPT"],
    "BTVTED": ["MT", "AT", "CP", "FSM", "CT", "ELT", "ELX"]
};

const MAJOR_EXAM_SLOTS = [
    "8:00-9:30",
    "10:00-11:30",
    "1:00-2:30",
    "2:00-3:30",
    "4:00-5:30"
];

const SHORT_EXAM_SLOTS = [
    "8:00-9:00",
    "9:00-10:00",
    "10:00-11:00",
    "11:00-12:00",
    "1:00-2:00",
    "2:00-3:00",
    "3:00-4:00",
    "4:00-5:00"
];

// A section must have at least one hour between the end of one exam and the
// start of its next exam. Rooms and proctors are not reserved during this gap.
const SECTION_EXAM_GAP_MINUTES = 60;

function getExamDurationMinutes(subject) {
    return String(subject?.subjectType || "").trim().toLowerCase() === "major" ? 90 : 60;
}

function getExamSlots(subject) {
    return getExamDurationMinutes(subject) === 90 ? MAJOR_EXAM_SLOTS : SHORT_EXAM_SLOTS;
}

// Building assignment rules for exam venues:
// - BIT and BINDTECH sections hold exams in Building B.
// - BTVTED sections hold exams in Building A.
// - When a section's home building has no free room for a slot, the exam
//   overflows to the Admin Building.
const OVERFLOW_BUILDING = "Admin Building";

function getPreferredBuildings(programCode) {
    const p = String(programCode || "").trim().toUpperCase();
    if (p === "BIT" || p === "BINDTECH") return ["Building B"];
    if (p === "BTVTED") return ["Building A"];
    return [];
}

function isEligibleExamRoom(room) {
    const type = String(room?.roomType || "").trim().toLowerCase();
    return type === "avr" || type === "lecture room";
}

// Subjects that do not require physical rooms/proctors
const TBA_SUBJECT_CODES = new Set([
    "SIP01", "SIP02", "OJT01", "OJT02",
    "AMC01", "FS001", "FS002", "PED11", "TCC01"
]);

// State variables
let allSections = [];
let loadedSubjects = [];
// Curriculum groups: one entry per unique Program+Major+Year Level+Semester.
// Each entry holds the subject list for that single curriculum, which is
// rendered as its own Curriculum Subjects card.
let curriculumGroups = [];
// Index of the currently displayed curriculum card (Prev/Next navigation).
let currentCurriculumIndex = 0;
let selectedDates = [];
let savedExamSchedules = [];
let currentGeneratedSchedule = null;
let currentGeneratedSchedules = [];
let currentGeneratedSectionIndex = 0;
let currentGeneratedTab = "schedule";
const sectionAnalysisCache = new Map();

// Conflict analyzer controller state
// All generated sections are analyzed instantly (no sequential loading animation).
// state: 'idle' | 'done'
let autoAnalyzer = { state: 'idle', timer: null };
let editingSchedule = null;
let lectureRooms = [];
let allFacultyMembers = [];

// ===================================================
// DOM ELEMENTS
// ===================================================
const academicYearInput = document.getElementById("academicYear");
const semesterSelect = document.getElementById("semester");
const programSelect = document.getElementById("program");
const majorSelect = document.getElementById("major");
const yearLevelSelect = document.getElementById("yearLevel");
const sectionSelect = document.getElementById("section");
const addSectionBtn = document.getElementById("addSectionBtn");
const examTypeSelect = document.getElementById("examType");
const examDateInput = document.getElementById("examDateInput");
const selectedDatesContainer = document.getElementById("selectedDatesContainer");

const loadSubjectsBtn = document.getElementById("loadSubjectsBtn");
const subjectTableBody = document.getElementById("subjectTableBody");
const curriculumCardsContainer = document.getElementById("curriculumCardsContainer");

const generateExamBtn = document.getElementById("generateExamBtn");
const generatingOverlay = document.getElementById("generatingOverlay");
const savedOverlay = document.getElementById("savedOverlay");
const savedOverlayText = document.getElementById("savedOverlayText");

const savedExamCard = document.getElementById("savedExamCard");
const savedExamSchedulesContainer = document.getElementById("savedExamSchedules");
const emptyExamSchedules = document.getElementById("emptyExamSchedules");
const savedScheduleSearchInput = document.getElementById("savedScheduleSearchInput");
const publishAllExamBtn = document.getElementById("publishAllExamBtn");
const moveExamArchiveBtn = document.getElementById("moveExamArchiveBtn");
const deleteAllExamBtn = document.getElementById("deleteAllExamBtn");

// Preview Modal
const examModal = document.getElementById("examModal");
const examModalBody = document.getElementById("examModalBody");
const closeExamModalBtn = document.getElementById("closeExamModalBtn");
const saveExamBtn = document.getElementById("saveExamBtn");
const publishExamBtn = document.getElementById("publishExamBtn");

// Add Section Modal
const addSectionModal = document.getElementById("addSectionModal");
const newSectionInput = document.getElementById("newSectionInput");
const closeAddSectionModalBtn = document.getElementById("closeAddSectionModalBtn");
const cancelNewSectionBtn = document.getElementById("cancelNewSectionBtn");
const saveNewSectionBtn = document.getElementById("saveNewSectionBtn");

// Edit Schedule Modal
const editScheduleModal = document.getElementById("editScheduleModal");
const editScheduleTitle = document.getElementById("editScheduleTitle");
const editScheduleSubtitle = document.getElementById("editScheduleSubtitle");
const editScheduleTableBody = document.getElementById("editScheduleTableBody");
const editScheduleConflicts = document.getElementById("editScheduleConflicts");
const closeEditScheduleModalBtn = document.getElementById("closeEditScheduleModalBtn");
const cancelEditScheduleBtn = document.getElementById("cancelEditScheduleBtn");
const saveEditScheduleBtn = document.getElementById("saveEditScheduleBtn");

// Calendar Modal
const examCalendarModal = document.getElementById("examCalendarModal");
const clsCalModalTitle = document.getElementById("clsCalModalTitle");
const clsCalModalSubtitle = document.getElementById("clsCalModalSubtitle");
const clsCalModalClose = document.getElementById("clsCalModalClose");
const clsCalModalBody = document.getElementById("clsCalModalBody");

// Guide Modal
const examGuideModal = document.getElementById("examGuideModal");
const guideInfoBtn = document.getElementById("guideInfoBtn");
const guideModalClose = document.getElementById("guideModalClose");
const guideGotItBtn = document.getElementById("guideGotItBtn");
const guideDontShowAgain = document.getElementById("guideDontShowAgain");

// Custom Toast & Confirm
const customToast = document.getElementById("customToast");
const customToastMessage = document.getElementById("customToastMessage");
const customToastClose = document.getElementById("customToastClose");
const customConfirmModal = document.getElementById("customConfirmModal");
const customConfirmMessage = document.getElementById("customConfirmMessage");
const customConfirmCancel = document.getElementById("customConfirmCancel");
const customConfirmOk = document.getElementById("customConfirmOk");
const logoutLink = document.getElementById("logoutLink");

// ===================================================
// UTILITY FUNCTIONS
// ===================================================
function escapeHtml(val) {
    return String(val ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
}

let toastTimeout = null;
function showToast(msg) {
    if (!customToast || !customToastMessage) { alert(msg); return; }
    customToastMessage.textContent = msg;
    customToast.style.display = "flex";
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => hideToast(), 3200);
}

function hideToast() {
    if (customToast) customToast.style.display = "none";
    if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null; }
}

customToastClose?.addEventListener("click", hideToast);

function showConfirm(msg) {
    return new Promise(resolve => {
        if (!customConfirmModal || !customConfirmMessage) {
            resolve(confirm(msg));
            return;
        }
        customConfirmMessage.textContent = msg;
        customConfirmModal.style.display = "flex";

        function cleanup() {
            customConfirmModal.style.display = "none";
            customConfirmCancel.removeEventListener("click", onCancel);
            customConfirmOk.removeEventListener("click", onOk);
        }
        function onCancel() { cleanup(); resolve(false); }
        function onOk() { cleanup(); resolve(true); }

        customConfirmCancel.addEventListener("click", onCancel);
        customConfirmOk.addEventListener("click", onOk);
    });
}

function showSuccessOverlay(text = "Examination schedule saved successfully.") {
    if (!savedOverlay) return;
    if (savedOverlayText) savedOverlayText.textContent = text;
    savedOverlay.classList.remove("fade-out");
    savedOverlay.style.display = "flex";
    setTimeout(() => {
        savedOverlay.classList.add("fade-out");
        setTimeout(() => { savedOverlay.style.display = "none"; }, 350);
    }, 1200);
}

function parseTime(val) {
    if (!val) return 0;
    const parts = String(val).trim().split(":").map(Number);
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;
    if (hour >= 1 && hour <= 6) hour += 12; // 1-6 are PM
    return hour * 60 + minute;
}

function timesOverlap(t1, t2) {
    if (!t1 || !t2 || !t1.includes("-") || !t2.includes("-")) return false;
    const [s1, e1] = t1.split("-").map(parseTime);
    const [s2, e2] = t2.split("-").map(parseTime);
    return s1 < e2 && s2 < e1;
}

function hasRequiredSectionGap(bookedTimes, candidateTime) {
    if (!candidateTime || candidateTime === "TBA") return true;
    const [candidateStart, candidateEnd] = candidateTime.split("-").map(parseTime);

    return bookedTimes.every(bookedTime => {
        if (!bookedTime || bookedTime === "TBA") return true;
        const [bookedStart, bookedEnd] = bookedTime.split("-").map(parseTime);
        return candidateStart >= bookedEnd + SECTION_EXAM_GAP_MINUTES ||
            bookedStart >= candidateEnd + SECTION_EXAM_GAP_MINUTES;
    });
}

function formatYearLevelText(yl) {
    const n = Number(yl);
    if (n === 1) return "1st Year";
    if (n === 2) return "2nd Year";
    if (n === 3) return "3rd Year";
    if (n === 4) return "4th Year";
    return String(yl || "");
}

function getDayName(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString("en-US", { weekday: "long" });
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", weekday: "long" });
}

function getFacultyName(faculty) {
    return String(
        faculty?.fullName ||
        faculty?.name ||
        faculty?.facultyName ||
        faculty?.displayName ||
        ""
    ).trim();
}

function normalizeFacultyName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameFaculty(first, second) {
    return normalizeFacultyName(first) !== "" &&
        normalizeFacultyName(first) === normalizeFacultyName(second);
}

// ===================================================
// DATE CHIPS LOGIC
// ===================================================
function renderSelectedDates() {
    if (!selectedDatesContainer) return;
    selectedDatesContainer.innerHTML = "";

    if (selectedDates.length === 0) {
        selectedDatesContainer.innerHTML = '<span class="date-chips-empty">No dates selected yet. Pick at least one examination date above.</span>';
        return;
    }

    selectedDates.forEach((dateStr, idx) => {
        const chip = document.createElement("span");
        chip.className = "date-chip";
        chip.innerHTML = `
            <span class="date-text">${formatDateDisplay(dateStr)}</span>
            <button type="button" class="date-chip-remove" data-index="${idx}" title="Remove date">&times;</button>
        `;
        selectedDatesContainer.appendChild(chip);
    });

    selectedDatesContainer.querySelectorAll(".date-chip-remove").forEach(btn => {
        btn.addEventListener("click", () => {
            const i = Number(btn.dataset.index);
            selectedDates.splice(i, 1);
            renderSelectedDates();
        });
    });
}

examDateInput?.addEventListener("change", () => {
    const val = examDateInput.value;
    if (!val) return;
    if (!selectedDates.includes(val)) {
        selectedDates.push(val);
        selectedDates.sort();
        renderSelectedDates();
    } else {
        showToast("Date is already selected.");
    }
    examDateInput.value = "";
});

// ===================================================
// CUSTOM MULTI-SELECT DROPDOWNS
// (Program → Major → Year Level → Section cascade)
// ===================================================
// Selection state per filter (keeps existing Firestore / scheduling flow intact)
const msdState = {
    program: new Set(),
    major: new Set(),
    yearLevel: new Set(),
    section: new Set()
};

const msdDefs = {
    program: { el: programSelect, noun: "Program" },
    major: { el: majorSelect, noun: "Major" },
    yearLevel: { el: yearLevelSelect, noun: "Year Level" },
    section: { el: sectionSelect, noun: "Section" }
};

const MSD_ORDER = ["program", "major", "yearLevel", "section"];

// Reads the currently selected values of a filter. Accepts either the filter
// key ("program") or the DOM element (whose id is the key), so every existing
// call site (load subjects, generate schedule, etc.) keeps working unchanged.
function selectedValues(selectOrKey) {
    const key = typeof selectOrKey === "string" ? selectOrKey : selectOrKey?.id;
    return msdState[key] ? [...msdState[key]] : [];
}

// ---- Available options per filter (dependent on parent selections) ----
// Majors that actually exist in the loaded sections data for the given
// programs. Falls back to PROGRAM_MAJORS when section data is unavailable,
// so the dropdown is never empty due to a data-loading failure.
function getMajorsForPrograms(programs) {
    // Whitelist of valid majors per program — used to guard against stale or
    // incorrect majorCode values in the sections data (e.g. a BINDTECH
    // section tagged with "AT", a major that only exists under BTVTED).
    const allowed = new Set(
        programs.length
            ? programs.flatMap(p => PROGRAM_MAJORS[p] || [])
            : Object.values(PROGRAM_MAJORS).flat()
    );
    if (programs.length && allSections.length) {
        const fromData = allSections
            .filter(s => programs.includes(s.programCode))
            .map(s => s.majorCode)
            .filter(Boolean)
            .filter(m => allowed.has(m));
        if (fromData.length) return [...new Set(fromData)];
    }
    return [...allowed];
}

function getAvailableOptions(key) {
    if (key === "program") {
        return Object.keys(PROGRAM_MAJORS);
    }
    if (key === "major") {
        const programs = [...msdState.program];
        // No Program selected yet -> nothing to choose from ("Select Program First")
        if (!programs.length) return [];
        return getMajorsForPrograms(programs).sort();
    }
    if (key === "yearLevel") {
        const programs = [...msdState.program];
        const majors = [...msdState.major];
        let secs = allSections;
        if (programs.length) secs = secs.filter(s => programs.includes(s.programCode));
        if (majors.length) secs = secs.filter(s => majors.includes(s.majorCode));
        const yls = [...new Set(secs.map(s => Number(s.yearLevel)).filter(Boolean))].sort((a, b) => a - b);
        return yls.length ? yls.map(String) : ["1", "2", "3", "4"];
    }
    if (key === "section") {
        const programs = [...msdState.program];
        const majors = [...msdState.major];
        const yearLevels = [...msdState.yearLevel].map(Number);
        const codes = new Set(); // remove duplicate section codes
        allSections
            .filter(sec => {
                if (programs.length && !programs.includes(sec.programCode)) return false;
                if (majors.length && !majors.includes(sec.majorCode)) return false;
                if (yearLevels.length && !yearLevels.includes(Number(sec.yearLevel))) return false;
                return true;
            })
            .forEach(s => codes.add(s.sectionCode));
        // Natural sort: BIT-CPT 1A, 1B, 2A ... instead of plain string order
        return [...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    return [];
}

function msdDisplayText(key, value) {
    return key === "yearLevel" ? formatYearLevelText(value) : value;
}

// Context-aware empty message shown when a dropdown has no available options
function msdEmptyMessage(key) {
    if (key === "major" && msdState.program.size === 0) return "Select Program First";
    if (key === "section" && msdState.program.size === 0) return "Select Program First";
    if (key === "section" && msdState.major.size === 0) return "Select Major First";
    if (key === "section" && msdState.yearLevel.size === 0) return "Select Year Level First";
    return "No options match the selected filters";
}

function msdButtonLabel(key) {
    const def = msdDefs[key];
    const sel = [...msdState[key]];
    if (sel.length === 0) return def.el?.dataset.placeholder || `Select ${def.noun}`;
    if (sel.length === 1) return msdDisplayText(key, sel[0]);
    return `${sel.length} ${def.noun}${def.noun.toLowerCase().endsWith("s") ? "es" : "s"} Selected`;
}

// ---- Rendering ----
function renderDropdown(key) {
    const def = msdDefs[key];
    if (!def.el) return;
    const options = getAvailableOptions(key);
    const selected = msdState[key];

    const menu = def.el.querySelector(".msd-menu");
    const label = def.el.querySelector(".msd-label");
    if (label) {
        label.textContent = msdButtonLabel(key);
        label.classList.toggle("is-placeholder", selected.size === 0);
    }
    if (!menu) return;

    // Preserve the dropdown's internal scroll position across re-renders
    // (selecting an option rebuilds the list, which would otherwise reset it).
    const prevList = menu.querySelector(".msd-options-list");
    const prevScrollTop = prevList ? prevList.scrollTop : 0;
    // Remember the page scroll position too — removing the focused checkbox
    // from the DOM can make the browser jump to the top of the page.
    const pageScrollY = window.scrollY;
    const pageScrollX = window.scrollX;
    const hadFocusInside = menu.contains(document.activeElement);

    const listHtml = options.map(value => {
        const checked = selected.has(String(value)) ? "checked" : "";
        return `
            <label class="msd-option" data-value="${escapeHtml(String(value))}">
                <input type="checkbox" ${checked}>
                <span class="msd-option-text">${escapeHtml(msdDisplayText(key, value))}</span>
            </label>
        `;
    }).join("");

    const emptyHtml = options.length === 0
        ? `<div class="msd-empty">${escapeHtml(msdEmptyMessage(key))}</div>`
        : "";

    menu.innerHTML = `
        <div class="msd-actions">
            <button type="button" class="msd-action-select-all">Select All</button>
            <button type="button" class="msd-action-clear">Clear</button>
        </div>
        <div class="msd-options-list">
            ${listHtml}
            ${emptyHtml}
        </div>
    `;

    // Restore the dropdown's internal scroll position after the rebuild.
    const newList = menu.querySelector(".msd-options-list");
    if (newList) newList.scrollTop = prevScrollTop;
    // Keep the browser's page scroll exactly where the user left it.
    if (window.scrollY !== pageScrollY || window.scrollX !== pageScrollX) {
        window.scrollTo(pageScrollX, pageScrollY);
    }
    // If focus was inside the old menu (e.g. a clicked checkbox that was
    // replaced), move it to the toggle button so it isn't lost to <body>,
    // which can also trigger a scroll reset.
    if (hadFocusInside && !menu.contains(document.activeElement)) {
        const toggle = def.el.querySelector(".msd-toggle");
        if (toggle && document.activeElement === document.body) {
            try { toggle.focus({ preventScroll: true }); } catch { /* noop */ }
        }
    }
}

function renderAllDropdowns() {
    MSD_ORDER.forEach(renderDropdown);
}

function closeAllDropdowns(exceptKey = null) {
    MSD_ORDER.forEach(key => {
        if (key === exceptKey) return;
        const el = msdDefs[key].el;
        if (!el) return;
        el.classList.remove("open");
        // Drop the card elevation when no dropdown inside it is open anymore
        const card = el.closest(".card");
        if (card && !card.querySelector(".msd.open")) card.classList.remove("msd-elevated");
    });
}

// ---- Dependency cascade: prune stale child selections & refresh curriculum ----
function pruneStaleSelections(fromKey) {
    const idx = MSD_ORDER.indexOf(fromKey);
    for (let i = idx + 1; i < MSD_ORDER.length; i++) {
        const key = MSD_ORDER[i];
        const available = new Set(getAvailableOptions(key).map(String));
        [...msdState[key]].forEach(v => {
            if (!available.has(String(v))) msdState[key].delete(v);
        });
    }
}

function pruneLoadedSubjects() {
    if (!loadedSubjects.length) return;
    const programs = msdState.program;
    const majors = msdState.major;
    const yearLevels = new Set([...msdState.yearLevel].map(Number));
    const before = loadedSubjects.length;
    loadedSubjects = loadedSubjects.filter(s =>
        (!programs.size || programs.has(s.programCode)) &&
        (!majors.size || majors.has(s.majorCode)) &&
        (!yearLevels.size || yearLevels.has(Number(s.yearLevel)))
    );
    if (loadedSubjects.length !== before) {
        curriculumGroups = buildCurriculumGroups(loadedSubjects);
        currentCurriculumIndex = 0;
        renderLoadedSubjects();
    }
}

function onFilterChanged(key) {
    pruneStaleSelections(key);
    pruneLoadedSubjects();
    renderAllDropdowns();
}

// ---- Event wiring (delegated, so all four dropdowns behave identically) ----
function initMultiSelectDropdowns() {
    MSD_ORDER.forEach(key => {
        const el = msdDefs[key].el;
        if (!el || el.dataset.msdInit === "true") return;
        el.dataset.msdInit = "true";

        el.innerHTML = `
            <button type="button" class="msd-toggle">
                <span class="msd-label is-placeholder"></span>
                <span class="msd-arrow">▾</span>
            </button>
            <div class="msd-menu" style="display:none;"></div>
        `;

        el.querySelector(".msd-toggle").addEventListener("click", (e) => {
            e.stopPropagation();
            const menu = el.querySelector(".msd-menu");
            const willOpen = !el.classList.contains("open");
            closeAllDropdowns(key);
            el.classList.toggle("open", willOpen);
            // Elevate the containing card above sibling cards (backdrop-filter
            // on .card creates a stacking context that would clip the menu).
            const card = el.closest(".card");
            if (card) card.classList.toggle("msd-elevated", willOpen);
            if (willOpen) renderDropdown(key);
            menu.style.display = willOpen ? "block" : "none";
        });

        el.addEventListener("click", (e) => e.stopPropagation());
        el.querySelector(".msd-menu").addEventListener("click", (e) => {
            const target = e.target;

            if (target.closest(".msd-action-select-all")) {
                getAvailableOptions(key).forEach(v => msdState[key].add(String(v)));
                onFilterChanged(key);
                return;
            }
            if (target.closest(".msd-action-clear")) {
                msdState[key].clear();
                onFilterChanged(key);
                return;
            }
            const option = target.closest(".msd-option");
            if (option) {
                e.preventDefault();
                const value = option.dataset.value;
                if (msdState[key].has(value)) msdState[key].delete(value);
                else msdState[key].add(value);
                onFilterChanged(key);
                return;
            }
        });
    });

    // Clicking anywhere outside closes every dropdown
    if (!document.body.dataset.msdOutsideInit) {
        document.body.dataset.msdOutsideInit = "true";
        document.addEventListener("click", () => {
            MSD_ORDER.forEach(key => {
                msdDefs[key].el?.classList.remove("open");
                const menu = msdDefs[key].el?.querySelector(".msd-menu");
                if (menu) menu.style.display = "none";
            });
            document.querySelectorAll(".card.msd-elevated").forEach(c => c.classList.remove("msd-elevated"));
        });
    }

    renderAllDropdowns();
}

// ===================================================
// SECTIONS MANAGEMENT (FIRESTORE)
// ===================================================
async function loadSectionsFromFirestore() {
    try {
        const snap = await getDocs(collection(db, "sections"));
        allSections = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderAllDropdowns();
    } catch (err) {
        console.warn("Could not load sections from Firestore:", err.message);
    }
}

addSectionBtn?.addEventListener("click", () => {
    if (!addSectionModal) return;
    newSectionInput.value = "";
    addSectionModal.style.display = "flex";
    newSectionInput.focus();
});

closeAddSectionModalBtn?.addEventListener("click", () => { addSectionModal.style.display = "none"; });
cancelNewSectionBtn?.addEventListener("click", () => { addSectionModal.style.display = "none"; });

saveNewSectionBtn?.addEventListener("click", async () => {
    const code = newSectionInput.value.trim().toUpperCase();
    if (!code) {
        showToast("Please enter a section code.");
        return;
    }
    if (!/^[A-Z0-9 -]+$/.test(code)) {
        showToast("Only letters, numbers, spaces, and hyphens (-) are allowed.");
        return;
    }

    const prog = msdState.program.size ? [...msdState.program][0] : "BIT";
    const maj = msdState.major.size ? [...msdState.major][0] : "CPT";
    const yl = msdState.yearLevel.size ? Number([...msdState.yearLevel][0]) : 1;

    try {
        const newSecData = {
            sectionCode: code,
            programCode: prog,
            majorCode: maj,
            yearLevel: yl,
            studentCount: 30,
            active: true
        };
        await setDoc(doc(db, "sections", code), newSecData);
        allSections.push(newSecData);
        msdState.section.add(code);
        renderAllDropdowns();
        addSectionModal.style.display = "none";
        showToast(`Section "${code}" added successfully.`);
    } catch (err) {
        showToast(`Failed to save section: ${err.message}`);
    }
});

// ===================================================
// LOAD CURRICULUM SUBJECTS (FIRESTORE PROSPECTUS)
// ===================================================
loadSubjectsBtn?.addEventListener("click", async () => {
    const programs = selectedValues(programSelect);
    const majors = selectedValues(majorSelect);
    const yearLevels = selectedValues(yearLevelSelect).map(Number);
    const sem = semesterSelect?.value ? Number(semesterSelect.value) : null;

    if (!programs.length || !majors.length || !yearLevels.length || !sem) {
        showToast("Please select Program, Major, Year Level, and Semester to load subjects.");
        return;
    }

    loadSubjectsBtn.disabled = true;
    loadSubjectsBtn.textContent = "Loading...";

    try {
        const q = query(collection(db, "prospectus"), where("semester", "==", sem));
        const snap = await getDocs(q);
        loadedSubjects = [];

        snap.forEach(d => {
            const data = d.data();
            if (data.subjectCode && data.subjectCode.includes("NSTP")) return;
            if (!programs.includes(data.programCode) || !majors.includes(data.majorCode) || !yearLevels.includes(Number(data.yearLevel))) return;
            loadedSubjects.push({ id: d.id, ...data });
        });

        // Curriculum identity = Program + Major + Year Level + Semester.
        // Sections sharing this identity use the SAME curriculum subject list,
        // so deduplicate to avoid loading identical subjects repeatedly.
        const seenCurriculum = new Set();
        loadedSubjects = loadedSubjects.filter(s => {
            const key = `${s.programCode}|${s.majorCode}|${Number(s.yearLevel)}|${Number(s.semester)}|${s.subjectCode}`;
            if (seenCurriculum.has(key)) return false;
            seenCurriculum.add(key);
            return true;
        });

        // Group subjects into curriculum cards. Identity = Program + Major +
        // Year Level + Semester, taken from the actual prospectus fields.
        // Sections sharing an identity reuse the same card's subject list.
        curriculumGroups = buildCurriculumGroups(loadedSubjects, sem);
        currentCurriculumIndex = 0;
        renderLoadedSubjects();

        if (loadedSubjects.length === 0) {
            showToast("No subjects found for the selected curriculum criteria.");
        }
    } catch (err) {
        showToast(`Error loading subjects: ${err.message}`);
    } finally {
        loadSubjectsBtn.disabled = false;
        loadSubjectsBtn.textContent = "Load Subjects";
    }
});

// Groups a flat subject list by Program + Major + Year Level + Semester
// (all taken from the prospectus data itself — nothing is hardcoded).
function buildCurriculumGroups(subjects, sem) {
    const groupMap = new Map();
    subjects.forEach(s => {
        const prog = s.programCode || "";
        const maj = s.majorCode || "";
        const yl = Number(s.yearLevel);
        const semester = Number(s.semester ?? sem);
        const key = `${prog}|${maj}|${yl}|${semester}`;
        if (!groupMap.has(key)) {
            groupMap.set(key, { programCode: prog, majorCode: maj, yearLevel: yl, semester, subjects: [] });
        }
        groupMap.get(key).subjects.push(s);
    });
    return [...groupMap.values()].sort((a, b) =>
        a.programCode.localeCompare(b.programCode) ||
        a.majorCode.localeCompare(b.majorCode) ||
        a.yearLevel - b.yearLevel
    );
}

// Renders only ONE curriculum card at a time (the one at currentCurriculumIndex),
// with Previous/Next navigation beneath it. Groups still cover every unique
// Program+Major+Year Level+Semester combination — navigation just paginates
// between them without reloading Firestore or the page.
function renderCurriculumCard(group) {
    const heading = `${group.programCode} • ${group.majorCode} • ${formatYearLevelText(group.yearLevel)} • ${group.semester === 2 ? "2nd Semester" : "1st Semester"}`;
    const rows = group.subjects.map(s => {
        const lecHours = Number(s.lecHours) || 0;
        const labHours = Number(s.labHours) || 0;
        return `
            <tr>
                <td><strong>${escapeHtml(s.subjectCode)}</strong></td>
                <td>${escapeHtml(s.subjectName)}</td>
                <td>${s.units ?? 3}</td>
                <td>${lecHours}</td>
                <td>${labHours}</td>
                <td><strong>${lecHours + labHours}</strong></td>
            </tr>
        `;
    }).join("");
    return `
        <div class="card curriculum-subject-card">
            <div class="section-header" style="display:flex; flex-direction:column; align-items:flex-start; gap:2px;">
                <span style="font-size:13px; color:#666; font-weight:600;">${escapeHtml(heading)}</span>
            </div>
            <div class="table-container" style="margin-top:12px;">
                <table>
                    <thead>
                        <tr>
                            <th>Subject Code</th>
                            <th>Subject Name</th>
                            <th>Units</th>
                            <th>Lec</th>
                            <th>Lab</th>
                            <th>Hrs/wk</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function renderCurriculumNav() {
    const total = curriculumGroups.length;
    if (total <= 1) return ""; // single (or no) card: hide navigation
    const disabledPrev = currentCurriculumIndex <= 0 ? "disabled" : "";
    const disabledNext = currentCurriculumIndex >= total - 1 ? "disabled" : "";
    return `
        <div class="curriculum-nav">
            <button type="button" class="curriculum-nav-btn" id="curriculumPrevBtn" ${disabledPrev}>&#8249; Previous</button>
            <span class="curriculum-nav-counter">${currentCurriculumIndex + 1} of ${total}</span>
            <button type="button" class="curriculum-nav-btn" id="curriculumNextBtn" ${disabledNext}>Next &#8250;</button>
        </div>
    `;
}

function renderLoadedSubjects() {
    if (!curriculumCardsContainer) return;

    if (curriculumGroups.length === 0) {
        curriculumCardsContainer.innerHTML = `
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Subject Code</th>
                            <th>Subject Name</th>
                            <th>Units</th>
                            <th>Lec</th>
                            <th>Lab</th>
                            <th>Hrs/wk</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="6" style="text-align:center; color:#777; padding:20px;">No subjects found for this selection.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;
        return;
    }

    // Clamp index in case the group list shrank (e.g. filter pruning)
    if (currentCurriculumIndex >= curriculumGroups.length) currentCurriculumIndex = 0;

    const group = curriculumGroups[currentCurriculumIndex];
    curriculumCardsContainer.innerHTML = renderCurriculumCard(group) + renderCurriculumNav();

    document.getElementById("curriculumPrevBtn")?.addEventListener("click", () => {
        if (currentCurriculumIndex > 0) {
            currentCurriculumIndex--;
            renderLoadedSubjects();
        }
    });
    document.getElementById("curriculumNextBtn")?.addEventListener("click", () => {
        if (currentCurriculumIndex < curriculumGroups.length - 1) {
            currentCurriculumIndex++;
            renderLoadedSubjects();
        }
    });
}

// ===================================================
// ROOMS & FACULTY DATA LOADERS
// ===================================================
async function loadLectureRooms() {
    try {
        const snap = await getDocs(collection(db, "rooms"));
        let rms = snap.docs.map(d => d.data());
        if (!rms.length) {
            rms = [
                { roomCode: "Room 101", roomName: "Room 101", roomType: "Lecture Room" },
                { roomCode: "Room 102", roomName: "Room 102", roomType: "Lecture Room" },
                { roomCode: "Room 103", roomName: "Room 103", roomType: "Lecture Room" },
                { roomCode: "Lab 1", roomName: "Lab 1", roomType: "Laboratory" },
                { roomCode: "Lab 2", roomName: "Lab 2", roomType: "Laboratory" }
            ];
        }
        lectureRooms = rms;
        return rms;
    } catch {
        return [
            { roomCode: "Room 101", roomName: "Room 101", roomType: "Lecture Room" },
            { roomCode: "Room 102", roomName: "Room 102", roomType: "Lecture Room" },
            { roomCode: "Lab 1", roomName: "Lab 1", roomType: "Laboratory" }
        ];
    }
}

// Loads EVERY registered faculty member as an eligible exam proctor.
// Sources:
//   1. "users" collection — accounts registered via the register page
//      (any role value containing "faculty", trimmed & case-insensitive).
//   2. "faculty" collection — legacy faculty profiles managed by the
//      chairperson, so no registered faculty is ever excluded.
// Results are de-duplicated by name so a person is never offered twice.
async function loadFacultyMembers() {
    const seen = new Set();
    const merged = [];

    const pushFaculty = (u) => {
        const name = getFacultyName(u);
        if (!name) return;
        const key = normalizeFacultyName(name);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ ...u, fullName: name });
    };

    try {
        const snap = await getDocs(collection(db, "users"));
        snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(u => String(u.role || "").trim().toLowerCase().includes("faculty"))
            .filter(u => u.excluded !== true)
            .forEach(pushFaculty);
    } catch (err) {
        console.warn("Could not load registered faculty users:", err.message);
    }

    try {
        const legacySnap = await getDocs(collection(db, "faculty"));
        legacySnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(u => u.excluded !== true)
            .forEach(pushFaculty);
    } catch (err) {
        console.warn("Could not load legacy faculty profiles:", err.message);
    }

    allFacultyMembers = merged;
    return merged;
}

// ===================================================
// AUTOMATED CONFLICT-FREE EXAM SCHEDULE GENERATOR
// ===================================================
generateExamBtn?.addEventListener("click", async () => {
    const ay = academicYearInput?.value?.trim();
    const sem = semesterSelect?.value;
    const programs = selectedValues(programSelect);
    const majors = selectedValues(majorSelect);
    const yearLevels = selectedValues(yearLevelSelect).map(Number);
    const sectionCodes = selectedValues(sectionSelect);
    const examType = examTypeSelect?.value;

    if (!ay) { showToast("Please enter an Academic Year (e.g. 2026-2027)."); return; }
    if (!sem) { showToast("Please select a Semester."); return; }
    if (!programs.length) { showToast("Please select at least one Program."); return; }
    if (!majors.length) { showToast("Please select at least one Major."); return; }
    if (!yearLevels.length) { showToast("Please select at least one Year Level."); return; }
    if (!sectionCodes.length) { showToast("Please select at least one Section."); return; }
    if (!examType) { showToast("Please select an Exam Type (Preliminary, Midterm, Final)."); return; }
    if (selectedDates.length === 0) { showToast("Please select at least one Examination Date."); return; }
    if (loadedSubjects.length === 0) { showToast("Please load curriculum subjects first."); return; }

    generatingOverlay.style.display = "flex";
    generateExamBtn.disabled = true;

    try {
        const [rooms, faculty] = await Promise.all([
            loadLectureRooms(),
            loadFacultyMembers()
        ]);

        // Load existing saved exam schedules to prevent room & proctor clashes across sections
        const freshFirestoreExams = await loadExamSchedulesFromFirestore();

        // Filter bookings for the same AY, semester, and examType
        const existingBookings = [];
        freshFirestoreExams.forEach(s => {
            if (s.academicYear === ay && String(s.semester) === String(sem) && s.examType === examType) {
                (s.exams || []).forEach(e => {
                    existingBookings.push({
                        section: s.section,
                        code: e.code,
                        date: e.date,
                        day: e.day,
                        time: e.time,
                        room: e.room,
                        proctor: e.proctor
                    });
                });
            }
        });

        // Subject synchronization map (same subject takes exam at the exact same slot across sections)
        const syncMap = new Map();
        existingBookings.forEach(b => {
            const normCode = (b.code || "").toUpperCase().trim();
            if (normCode && !syncMap.has(normCode)) {
                syncMap.set(normCode, { date: b.date, day: b.day, time: b.time });
            }
        });

        const selectedSections = allSections.filter(section => sectionCodes.includes(section.sectionCode));
        const generatedSchedules = [];
        const failedSections = [];
        // Fair workload is shared across every section in this batch.
        const proctorDayLoad = new Map();

        // Auto-fetch helper: if a section's curriculum combo isn't in
        // loadedSubjects (e.g. user only loaded one year level but selected
        // sections across multiple year levels), fetch it from Firestore
        // on demand instead of failing the section.
        const fetchMissingSubjects = async (prog, maj, yl) => {
            try {
                const q = query(
                    collection(db, "prospectus"),
                    where("programCode", "==", prog),
                    where("majorCode", "==", maj),
                    where("yearLevel", "==", yl),
                    where("semester", "==", Number(sem))
                );
                const snap = await getDocs(q);
                const fetched = [];
                snap.forEach(d => {
                    const data = d.data();
                    if (data.subjectCode && data.subjectCode.includes("NSTP")) return;
                    fetched.push({ id: d.id, ...data });
                });
                loadedSubjects.push(...fetched);
                return fetched;
            } catch (err) {
                console.error("Failed to fetch missing curriculum subjects:", err);
                return [];
            }
        };

        const orderedSelectedDates = [...selectedDates].sort();

        for (let sectionIndex = 0; sectionIndex < selectedSections.length; sectionIndex++) {
            const selectedSection = selectedSections[sectionIndex];
            const sec = selectedSection.sectionCode;
            const prog = selectedSection.programCode;
            const maj = selectedSection.majorCode;
            const yl = Number(selectedSection.yearLevel);
            let sectionSubjects = loadedSubjects.filter(subject =>
                subject.programCode === prog &&
                subject.majorCode === maj &&
                Number(subject.yearLevel) === yl
            );

            if (!sectionSubjects.length) {
                sectionSubjects = await fetchMissingSubjects(prog, maj, yl);
            }

            if (!sectionSubjects.length) {
                failedSections.push(`${sec} (no curriculum subjects loaded)`);
                continue;
            }

            // Research subjects (RES01, RES01a, RES02, RES02a, etc.) do not
            // require exams — keep them in the loaded subject list but
            // exclude them from the generated exam schedule.
            sectionSubjects = sectionSubjects.filter(subject =>
                !/^RES\s?\d+[a-z]?$/i.test(String(subject.subjectCode || "").trim())
            );

        // Each section prefers ONE eligible room (AVR / Lecture Room) in its
        // home building (BIT/BINDTECH -> Building B, BTVTED -> Building A)
        // for its entire exam schedule. The Admin Building is used as
        // overflow when the home building has no free room.
        const preferredBuildings = getPreferredBuildings(prog);
        const eligibleRooms = rooms.filter(isEligibleExamRoom);
        const homeBuildingRooms = eligibleRooms.filter(rm =>
            preferredBuildings.includes(String(rm.building || "").trim())
        );
        const sectionRoomPool = homeBuildingRooms.length ? homeBuildingRooms : eligibleRooms;
        const sectionRoom = sectionRoomPool.length
            ? sectionRoomPool[Math.floor(Math.random() * sectionRoomPool.length)]
            : null;
        const sectionRoomName = sectionRoom
            ? (sectionRoom.roomName || sectionRoom.roomCode)
            : null;

        // Track local bookings for this section
        const sectionExamEntries = [];
        const localTimetable = new Map(); // date -> array of booked times
        selectedDates.forEach(d => localTimetable.set(d, []));

        // Order subjects so that the FIRST exam of every day is always a
        // minor subject. Up to 3 exams fit per day, so positions 0, 3, 6...
        // are day-opening slots; remaining subjects keep the original
        // preference (labs first, then highest units).
        const sortedByPreference = [...sectionSubjects].sort((a, b) => {
            const aLab = /lab/i.test(a.requiredRoomType || "");
            const bLab = /lab/i.test(b.requiredRoomType || "");
            if (aLab !== bLab) return aLab ? -1 : 1;
            return (b.units || 0) - (a.units || 0);
        });
        const subjectsToSchedule = [];
        const usedSubjectIds = new Set();
        const isMajorSubject = s => String(s.subjectType || "").trim().toLowerCase() === "major";
        for (let i = 0; i < sortedByPreference.length; i++) {
            if (i % 3 === 0) {
                const minor = sortedByPreference.find(s => !usedSubjectIds.has(s.subjectCode) && !isMajorSubject(s));
                if (minor) {
                    subjectsToSchedule.push(minor);
                    usedSubjectIds.add(minor.subjectCode);
                    continue;
                }
            }
            const next = sortedByPreference.find(s => !usedSubjectIds.has(s.subjectCode));
            if (next) {
                subjectsToSchedule.push(next);
                usedSubjectIds.add(next.subjectCode);
            }
        }

        let success = true;

        for (const subj of subjectsToSchedule) {
            const code = subj.subjectCode;
            const name = subj.subjectName;
            const units = subj.units || 3;
            const isLab = /lab/i.test(subj.requiredRoomType || "");
            const durationMinutes = getExamDurationMinutes(subj);
            const subjectType = subj.subjectType || "Minor / Activity";

            // TBA Subjects (OJT, Field Study, etc.)
            if (TBA_SUBJECT_CODES.has(code)) {
                sectionExamEntries.push({
                    code,
                    name,
                    units,
                    subjectType,
                    durationMinutes,
                    examType,
                    date: "TBA",
                    day: "TBA",
                    time: "TBA",
                    room: "TBA",
                    proctor: "Unassigned"
                });
                continue;
            }

            let assignedDate = null;
            let assignedDay = null;
            let assignedTime = null;
            let assignedRoom = null;
            let assignedProctor = null;
            let assignedProctorReason = "";

            // Check if synchronized with an earlier section
            const syncedEntry = syncMap.get(code.toUpperCase().trim());
            // Do not inherit an old synchronized slot that violates this
            // subject's duration rule or the 8:00 AM opening time.
            const synced = syncedEntry && getExamSlots(subj).includes(syncedEntry.time)
                ? syncedEntry
                : null;
            // Prefer the synchronized date/slot, but ALWAYS keep the remaining
            // dates/slots as fallbacks. Without fallbacks, a second section
            // whose synced room/proctor is busy would fail entirely instead of
            // being rescheduled conflict-free.
            const candidateDates = synced && selectedDates.includes(synced.date)
                ? [synced.date, ...selectedDates.filter(d => d !== synced.date)].sort()
                : [...selectedDates].sort(); // chronological: days fill in order,
                // so every 3rd subject (i % 3 === 0) opens a new exam day

            const candidateSlots = synced
                ? [synced.time, ...getExamSlots(subj).filter(t => t !== synced.time)]
                : getExamSlots(subj);

            dateLoop:
            for (const dateStr of candidateDates) {
                const dayName = getDayName(dateStr);
                const bookedSlotsForDay = localTimetable.get(dateStr) || [];

                // Limit: max 3 exams per section per day
                if (bookedSlotsForDay.length >= 3) continue;

                for (const slot of candidateSlots) {
                    // 1. Keep a one-hour break between this section's exams.
                    // The room remains free during that break for other sections.
                    if (!hasRequiredSectionGap(bookedSlotsForDay, slot)) continue;

                    // 2. Room availability check
                    const availableRooms = rooms.filter(rm => {
                        // Only AVR and Lecture Room types are eligible for exams.
                        if (!isEligibleExamRoom(rm)) return false;

                        const roomName = rm.roomName || rm.roomCode;

                        // Check against existing bookings across all sections
                        const roomTaken = existingBookings.some(b =>
                            b.date === dateStr && b.room === roomName && timesOverlap(b.time, slot)
                        );
                        if (roomTaken) return false;

                        // Check against local section bookings
                        const localTaken = sectionExamEntries.some(e =>
                            e.date === dateStr && e.room === roomName && timesOverlap(e.time, slot)
                        );
                        return !localTaken;
                    });

                    if (availableRooms.length === 0) continue;
                    // Preference order: the section's assigned room first, then
                    // any free room in the section's home building, then the
                    // Admin Building (overflow), then any other building.
                    const buildingRank = rm => {
                        const bld = String(rm.building || "").trim();
                        if (preferredBuildings.includes(bld)) return 0;
                        if (bld === OVERFLOW_BUILDING) return 1;
                        return 2;
                    };
                    availableRooms.sort((a, b) => {
                        const aRoom = a.roomName || a.roomCode;
                        const bRoom = b.roomName || b.roomCode;
                        const aSection = aRoom === sectionRoomName ? 1 : 0;
                        const bSection = bRoom === sectionRoomName ? 1 : 0;
                        if (aSection !== bSection) return bSection - aSection;
                        return buildingRank(a) - buildingRank(b);
                    });
                    const chosenRoom = availableRooms[0];

                    // 3. Proctor assignment check. A faculty member may
                    // proctor any number of non-overlapping exams per day.
                    let chosenProctor = "Unassigned";
                    let proctorAssignmentReason = "";
                    if (faculty.length > 0) {
                        const eligibleFaculty = faculty.filter(f => {
                            const pName = getFacultyName(f);
                            if (!pName) return false;

                            const isProctorBusy = existingBookings.some(b =>
                                b.date === dateStr && sameFaculty(b.proctor, pName) && timesOverlap(b.time, slot)
                            ) || sectionExamEntries.some(e =>
                                e.date === dateStr && sameFaculty(e.proctor, pName) && timesOverlap(e.time, slot)
                            );
                            return !isProctorBusy;
                        });

                        if (eligibleFaculty.length > 0) {
                            // Rotate proctors by exam day and section so a faculty
                            // member does not follow one section through its entire
                            // exam journey. For example, with two faculty and two
                            // sections, assignments alternate A/B across the days.
                            const dateIndex = orderedSelectedDates.indexOf(dateStr);
                            const targetFacultyIndex = (Math.max(dateIndex, 0) + sectionIndex) % faculty.length;
                            eligibleFaculty.sort((a, b) => {
                                const aIndex = faculty.indexOf(a);
                                const bIndex = faculty.indexOf(b);
                                const aDistance = (aIndex - targetFacultyIndex + faculty.length) % faculty.length;
                                const bDistance = (bIndex - targetFacultyIndex + faculty.length) % faculty.length;
                                if (aDistance !== bDistance) return aDistance - bDistance;

                                const cA = proctorDayLoad.get(`${normalizeFacultyName(getFacultyName(a))}_${dateStr}`) || 0;
                                const cB = proctorDayLoad.get(`${normalizeFacultyName(getFacultyName(b))}_${dateStr}`) || 0;
                                return cA - cB;
                            });
                            const picked = eligibleFaculty[0];
                            chosenProctor = getFacultyName(picked);
                        } else {
                            proctorAssignmentReason = "⚠ No Available Proctor\nAll eligible faculty are already assigned during this examination time.";
                        }
                    } else {
                        proctorAssignmentReason = "⚠ No Available Proctor\nNo eligible faculty records are currently loaded.";
                    }

                    // Successfully assigned
                    assignedDate = dateStr;
                    assignedDay = dayName;
                    assignedTime = slot;
                    assignedRoom = chosenRoom.roomName || chosenRoom.roomCode;
                    assignedProctor = chosenProctor;
                    assignedProctorReason = proctorAssignmentReason;

                    bookedSlotsForDay.push(slot);
                    localTimetable.set(dateStr, bookedSlotsForDay);

                    if (assignedProctor !== "Unassigned") {
                        const pKey = `${normalizeFacultyName(assignedProctor)}_${dateStr}`;
                        proctorDayLoad.set(pKey, (proctorDayLoad.get(pKey) || 0) + 1);
                    }

                    if (!syncMap.has(code.toUpperCase().trim())) {
                        syncMap.set(code.toUpperCase().trim(), { date: dateStr, day: dayName, time: slot });
                    }

                    break dateLoop;
                }
            }

            if (!assignedDate) {
                success = false;
                break;
            }

            sectionExamEntries.push({
                code,
                name,
                units,
                subjectType,
                durationMinutes,
                examType,
                date: assignedDate,
                day: assignedDay,
                time: assignedTime,
                room: assignedRoom,
                proctor: assignedProctor,
                ...(assignedProctor === "Unassigned" ? { proctorAssignmentReason: assignedProctorReason } : {})
            });
        }

        if (!success) {
            failedSections.push(sec);
            continue;
        }

        // Sort entries by date and time
        sectionExamEntries.sort((a, b) => {
            if (a.date === "TBA") return 1;
            if (b.date === "TBA") return -1;
            const diff = new Date(a.date) - new Date(b.date);
            if (diff !== 0) return diff;
            return parseTime(a.time.split("-")[0]) - parseTime(b.time.split("-")[0]);
        });

        const generatedSchedule = {
            id: `${ay}_${sem}_${examType}_${sec}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            section: sec,
            academicYear: ay,
            semester: sem === "1" ? "1st Semester" : (sem === "2" ? "2nd Semester" : sem),
            program: prog,
            major: maj,
            yearLevel: formatYearLevelText(yl),
            examType,
            status: "draft",
            exams: sectionExamEntries,
            createdAt: new Date().toISOString()
        };

        generatedSchedules.push(generatedSchedule);
        sectionExamEntries.forEach(exam => {
            existingBookings.push({ section: sec, ...exam });
        });
        }

        if (!generatedSchedules.length) {
            showToast("Could not assign conflict-free dates, rooms, or proctors. Try adding more examination dates or rooms.");
            return;
        }

        currentGeneratedSchedules = generatedSchedules;
        currentGeneratedSchedule = generatedSchedules[0];
        openPreviewModal(generatedSchedules);

        if (failedSections.length) {
            showToast(`Generated ${generatedSchedules.length} schedule(s). Unable to generate: ${failedSections.join(", ")}.`);
        }

    } catch (err) {
        console.error("Generation error:", err);
        showToast(`Generation error: ${err.message}`);
    } finally {
        generatingOverlay.style.display = "none";
        generateExamBtn.disabled = false;
    }
});

// ===================================================
// PREVIEW MODAL
// ===================================================
function scheduleFingerprint(schedule) {
   return JSON.stringify({ section: schedule.section, exams: schedule.exams || [] });
}

function formatExamLocation(exam) {
   return `${formatDateDisplay(exam.date)} • ${exam.time} • ${exam.room}`;
}

function analyzeGeneratedSection(schedule, schedules, index) {
   const previous = schedules.slice(0, index);
   const sourceFingerprint = JSON.stringify({
       current: scheduleFingerprint(schedule),
       previous: previous.map(scheduleFingerprint)
   });
   const cached = sectionAnalysisCache.get(schedule.section);
   if (cached?.sourceFingerprint === sourceFingerprint) return cached.result;

   const conflicts = [];
   const exams = schedule.exams || [];
   const addConflict = (type, exam, conflictingExam, conflictingSection, description) => {
       conflicts.push({ type, exam, conflictingExam, conflictingSection, description });
   };

   for (let i = 0; i < exams.length; i++) {
       if (exams[i].date !== "TBA" && exams[i].proctor === "Unassigned") {
           addConflict(
               "No Available Proctor",
               exams[i],
               null,
               schedule.section,
               exams[i].proctorAssignmentReason ||
                   "All eligible faculty have been checked and none is available during this examination time."
           );
       }
       for (let j = i + 1; j < exams.length; j++) {
           const a = exams[i], b = exams[j];
           if (a.date === "TBA" || a.date !== b.date || !timesOverlap(a.time, b.time)) continue;
           addConflict(
               a.room !== "TBA" && a.room === b.room ? "Room Conflict" : "Time Overlap",
               a, b, schedule.section,
               `${a.code} and ${b.code} overlap on the same section.`
           );
       }
   }

   previous.forEach(other => (other.exams || []).forEach(otherExam => exams.forEach(exam => {
       if (exam.date === "TBA" || exam.date !== otherExam.date || !timesOverlap(exam.time, otherExam.time)) return;
       if (exam.room !== "TBA" && exam.room === otherExam.room) {
           addConflict("Room Conflict", exam, otherExam, other.section,
               `${exam.room} is already assigned to ${otherExam.code} in ${other.section}.`);
       }
       if (exam.proctor !== "Unassigned" && sameFaculty(exam.proctor, otherExam.proctor)) {
           addConflict("Proctor Conflict", exam, otherExam, other.section,
               `${exam.proctor} is assigned to overlapping examinations.`);
       }
   })));

   const result = { conflicts, analyzedAgainst: previous.map(s => s.section) };
   const existing = sectionAnalysisCache.get(schedule.section) || {};
   sectionAnalysisCache.set(schedule.section, { ...existing, analyzed: true, sourceFingerprint, result });
   return result;
}

function findSuggestions(conflict, schedule, schedules, index) {
   const allReferenceExams = schedules.slice(0, index).flatMap(s => s.exams || []);
   const isFree = (exam, date, time, room) => {
       if (!date || date === "TBA" || !time || time === "TBA") return false;
       const sameSectionExams = (schedule.exams || []).filter(other => other !== exam && other.date === date);
       if (sameSectionExams.some(other => timesOverlap(other.time, time)) ||
           !hasRequiredSectionGap(sameSectionExams.map(other => other.time), time)) return false;
       if (allReferenceExams.some(other => other.date === date && timesOverlap(other.time, time) &&
           (other.room === room || other.proctor === exam.proctor))) return false;
       return true;
   };

   const suggestions = [];
   const rooms = lectureRooms.filter(isEligibleExamRoom).map(r => r.roomName || r.roomCode);
   if (conflict.type === "Room Conflict") {
       rooms.forEach(room => {
           if (room !== conflict.exam.room && isFree(conflict.exam, conflict.exam.date, conflict.exam.time, room)) {
               suggestions.push(`Reassign ${schedule.section} to ${room} at ${formatExamLocation(conflict.exam).replace(conflict.exam.room, room)}.`);
           }
       });
   }
   const slots = getExamSlots({ subjectType: conflict.exam.subjectType });
   const dates = selectedDates.length ? selectedDates : schedules.flatMap(s => (s.exams || []).map(e => e.date)).filter(Boolean);
   dates.forEach(date => slots.forEach(time => {
       if (suggestions.length < 3 && time !== conflict.exam.time && isFree(conflict.exam, date, time, conflict.exam.room)) {
           suggestions.push(`Move ${conflict.exam.code} to ${formatDateDisplay(date)} at ${time} in ${conflict.exam.room}.`);
       }
   }));
   return suggestions;
}

function getAvailableProctors(exam, schedule) {
   const generatedExams = currentGeneratedSchedules
       .filter(other => other !== schedule)
       .flatMap(other => other.exams || []);
   const savedExams = savedExamSchedules
       .filter(other => other.academicYear === schedule.academicYear &&
           String(other.semester) === String(schedule.semester) &&
           other.examType === schedule.examType)
       .flatMap(other => other.exams || []);
   const bookedExams = [
       ...(schedule.exams || []).filter(other => other !== exam),
       ...generatedExams,
       ...savedExams
   ];
   return allFacultyMembers.filter(faculty => {
       const name = getFacultyName(faculty);
       return name && !bookedExams.some(other =>
           sameFaculty(other.proctor, name) &&
           other.date === exam.date &&
           timesOverlap(other.time, exam.time)
       );
   });
}

function renderGeneratedSection() {
   if (!examModalBody || !currentGeneratedSchedules.length) return;
   const schedules = currentGeneratedSchedules;
   const index = currentGeneratedSectionIndex;
   const schedule = schedules[index];
   currentGeneratedSchedule = schedule;
   const analysis = analyzeGeneratedSection(schedule, schedules, index);
   const unassignedExams = (schedule.exams || []).filter(exam => exam.proctor === "Unassigned");
   const rows = (schedule.exams || []).map(e => `
       <tr><td><strong>${escapeHtml(e.code)}</strong></td><td>${escapeHtml(e.name)}</td>
       <td>${e.units || 3}</td><td>${e.date !== "TBA" ? formatDateDisplay(e.date) : "TBA"}</td>
       <td>${escapeHtml(e.time)}</td><td>${escapeHtml(e.room)}</td><td>${escapeHtml(e.proctor)}</td></tr>
   `).join("");
   const conflictHtml = analysis.conflicts.length
       ? analysis.conflicts.map(conflict => {
           const suggestions = findSuggestions(conflict, schedule, schedules, index);
           return `<div class="conflict-detail"><strong>${escapeHtml(conflict.type)}</strong>
               <p><b>Section:</b> ${escapeHtml(schedule.section)}${conflict.conflictingSection !== schedule.section ? ` • <b>Conflicting Section:</b> ${escapeHtml(conflict.conflictingSection)}` : ""}
               <br><b>Subject:</b> ${escapeHtml(conflict.exam.code)} • <b>Date:</b> ${escapeHtml(formatDateDisplay(conflict.exam.date))}
               <br><b>Time:</b> ${escapeHtml(conflict.exam.time)} • <b>Room:</b> ${escapeHtml(conflict.exam.room)}
               ${conflict.conflictingExam ? `<br><b>Conflicting Subject:</b> ${escapeHtml(conflict.conflictingExam.code)} • <b>Time:</b> ${escapeHtml(conflict.conflictingExam.time)} • <b>Room:</b> ${escapeHtml(conflict.conflictingExam.room)}` : ""}
               <br>${escapeHtml(conflict.description)}</p>
               <b>💡 Suggested Solution</b>
               <p>${escapeHtml(suggestions[0] || "No validated room or time alternative is available within the selected examination period.")}</p>
               ${suggestions.slice(1).map((s, i) => `<p><b>Alternative ${i + 1}:</b> ${escapeHtml(s)}</p>`).join("")}
           </div>`;
       }).join("")
       : `<p class="conflict-analyzer-ok-msg">✓ No conflicts detected</p>`;

   const unassignedHtml = unassignedExams.length ? `
       <div class="unassigned-subjects-panel">
           <h4>Assign Available Proctors</h4>
           <p>Select a proctor who is free during each subject's scheduled date and time.</p>
           ${unassignedExams.map(exam => {
               const options = getAvailableProctors(exam, schedule);
               return `<div class="unassigned-subject-row">
                   <div><strong>${escapeHtml(exam.code)}</strong><span>${escapeHtml(exam.name)}</span>
                   <small>${escapeHtml(formatExamLocation(exam))}</small></div>
                   <select class="unassigned-proctor-select" data-exam-code="${escapeHtml(exam.code)}">
                       <option value="Unassigned">Select available proctor</option>
                       ${options.map(faculty => {
                           const name = getFacultyName(faculty);
                           return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
                       }).join("")}
                   </select>
                   ${options.length
                       ? ""
                       : `<small class="no-proctor-message">${escapeHtml(exam.proctorAssignmentReason || "⚠ No Available Proctor\nAll eligible faculty have already been checked for this examination time.")}</small>`}
               </div>`;
           }).join("")}
       </div>` : `<p class="unassigned-empty">There are no unassigned subjects for this section.</p>`;

   const cached = sectionAnalysisCache.get(schedule.section);
   const sectionStatus = cached?.status || 'pending';
   let bannerHtml = '';
   if (sectionStatus === 'conflict') {
       bannerHtml = `<div class="analyzer-status-banner conflict">⚠ Conflicts Found — Review the Conflict Analyzer section below.</div>`;
   } else if (sectionStatus === 'ok') {
       bannerHtml = `<div class="analyzer-status-banner ok">✓ Analyzed — No Conflicts</div>`;
   } else {
       bannerHtml = `<div class="analyzer-status-banner done">✓ All Sections Analyzed — Analysis complete for all ${schedules.length} section${schedules.length === 1 ? '' : 's'}.</div>`;
   }

   examModalBody.innerHTML = `
       <div class="exam-preview-info"><div class="exam-preview-info-text">
           <h3 class="generated-section-title">${escapeHtml(schedule.section)}</h3>
           <p class="exam-preview-subtitle">A.Y. ${escapeHtml(schedule.academicYear)} • ${escapeHtml(schedule.semester)} • ${escapeHtml(schedule.examType)} Examination</p>
       </div><span class="badge-draft exam-preview-draft-badge">Draft</span></div>
       ${bannerHtml}
       ${unassignedExams.length ? `<div class="generated-schedule-tabs">
           <button type="button" class="${currentGeneratedTab === "schedule" ? "active" : ""}" data-generated-tab="schedule">Exam Schedule</button>
           <button type="button" class="${currentGeneratedTab === "unassigned" ? "active" : ""}" data-generated-tab="unassigned">Unassigned Subjects (${unassignedExams.length})</button>
       </div>` : ""}
       <div class="${currentGeneratedTab === "unassigned" && unassignedExams.length ? "generated-tab-panel is-hidden" : ""}">
       <div class="table-container exam-preview-table-wrap"><table class="exam-preview-table">
           <thead><tr><th>Subject Code</th><th>Subject Name</th><th>Units</th><th>Exam Date</th><th>Exam Time</th><th>Room</th><th>Proctor</th></tr></thead>
           <tbody>${rows}</tbody>
       </table></div></div>
       <div class="${currentGeneratedTab === "unassigned" && unassignedExams.length ? "" : "generated-tab-panel is-hidden"}">${unassignedHtml}</div>
       <div class="conflict-analyzer ${analysis.conflicts.length ? "has-conflicts" : ""}">
           <div class="conflict-analyzer-header"><h4 class="conflict-analyzer-title"><span class="conflict-analyzer-check">${analysis.conflicts.length ? "⚠" : "✓"}</span> Conflict Analyzer</h4>
           <span class="conflict-analyzer-badge ${analysis.conflicts.length ? "bad" : "ok"}">${analysis.conflicts.length} Conflict${analysis.conflicts.length === 1 ? "" : "s"}</span></div>
           <ul class="conflict-analyzer-list"><li>✓ Section conflicts</li><li>✓ Room conflicts</li><li>✓ Time overlaps</li></ul>
           ${conflictHtml}
       </div>
       <div class="exam-section-navigation">
           <button type="button" id="previousGeneratedSection" ${index === 0 ? "disabled" : ""}>← Previous Section</button>
           <strong>Section ${index + 1} of ${schedules.length}</strong>
           <button type="button" id="nextGeneratedSection" ${index === schedules.length - 1 ? "disabled" : ""}>Next Section →</button>
       </div>`;
   document.getElementById("previousGeneratedSection")?.addEventListener("click", () => {
       if (autoAnalyzer.timer) { clearTimeout(autoAnalyzer.timer); autoAnalyzer.timer = null; }
       currentGeneratedSectionIndex--;
       renderGeneratedSection();
   });
   document.getElementById("nextGeneratedSection")?.addEventListener("click", () => {
       if (autoAnalyzer.timer) { clearTimeout(autoAnalyzer.timer); autoAnalyzer.timer = null; }
       currentGeneratedSectionIndex++;
       currentGeneratedTab = "schedule";
       renderGeneratedSection();
   });
   examModalBody.querySelectorAll("[data-generated-tab]").forEach(tab => {
       tab.addEventListener("click", () => {
           currentGeneratedTab = tab.dataset.generatedTab;
           renderGeneratedSection();
       });
   });
   examModalBody.querySelectorAll(".unassigned-proctor-select").forEach(select => {
       select.addEventListener("change", event => {
           const exam = (schedule.exams || []).find(item => item.code === event.target.dataset.examCode);
           if (!exam || event.target.value === "Unassigned") return;
           exam.proctor = event.target.value;
           sectionAnalysisCache.delete(schedule.section);
           refreshSectionAnalysis(currentGeneratedSectionIndex);
           renderGeneratedSection();
       });
   });
}

function refreshSectionAnalysis(index) {
   const schedules = currentGeneratedSchedules;
   if (!schedules.length || index < 0 || index >= schedules.length) return;
   const schedule = schedules[index];
   const analysis = analyzeGeneratedSection(schedule, schedules, index);
   const hasUnassigned = (schedule.exams || []).some(e => e.date !== "TBA" && e.proctor === "Unassigned");
   sectionAnalysisCache.set(schedule.section, {
       ...(sectionAnalysisCache.get(schedule.section) || {}),
       status: (analysis.conflicts.length || hasUnassigned) ? 'conflict' : 'ok'
   });
   return analysis;
}

function startAutoAnalyzer() {
   if (autoAnalyzer.timer) { clearTimeout(autoAnalyzer.timer); autoAnalyzer.timer = null; }
   // Analyze all generated sections instantly (no sequential "Section 1 of N -> N of N"
   // loading animation), so the preview shows the final conflict analysis immediately.
   currentGeneratedSchedules.forEach((schedule, index) => refreshSectionAnalysis(index));
   autoAnalyzer.state = 'done';
   renderGeneratedSection();
}

function openPreviewModal(scheduleOrSchedules) {
   if (!examModal || !examModalBody) return;
   currentGeneratedSchedules = Array.isArray(scheduleOrSchedules) ? scheduleOrSchedules : [scheduleOrSchedules];
   currentGeneratedSectionIndex = 0;
   currentGeneratedTab = "schedule";
   sectionAnalysisCache.clear();
   if (autoAnalyzer.timer) { clearTimeout(autoAnalyzer.timer); autoAnalyzer.timer = null; }
   autoAnalyzer.state = 'idle';
   if (saveExamBtn) saveExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Save All Drafts" : "Save as Draft";
   if (publishExamBtn) publishExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Publish All Generated" : "Publish Exam Schedule";
   examModal.style.display = "block";
   startAutoAnalyzer();
}

closeExamModalBtn?.addEventListener("click", () => {
    // Cancel any pending auto-advance timer when the modal is closed
    if (autoAnalyzer.timer) { clearTimeout(autoAnalyzer.timer); autoAnalyzer.timer = null; }
    autoAnalyzer.state = 'idle';
    examModal.style.display = "none";
});

async function persistGeneratedSchedules({ publish = false } = {}) {
    if (!currentGeneratedSchedules.length) return;

    const count = currentGeneratedSchedules.length;
    const targetLabel = count === 1 ? "Examination schedule" : `${count} examination schedules`;

    let totalStudents = 0;
    let totalFaculty = 0;
    let totalFailedNotifications = 0;
    let anyPublishFailed = false;
    let lastError = "";

    for (const schedule of currentGeneratedSchedules) {
        if (publish) {
            const result = await publishExamScheduleApi(schedule);
            if (result?.published || result?.success) {
                schedule.status = "published";
                schedule.publishedAt = result.publishedAt || new Date().toISOString();
                const notifs = result.notifications || {};
                totalStudents += result.studentSentCount ?? notifs.studentsSent ?? 0;
                totalFaculty += result.facultySentCount ?? notifs.facultySent ?? 0;
                totalFailedNotifications += result.failedCount ?? notifs.failed ?? 0;
            } else {
                anyPublishFailed = true;
                lastError = result?.message || "The server endpoint could not be reached.";
            }
        } else {
            schedule.status = "draft";
            await saveExamScheduleToFirestore(schedule);
        }
    }

    let successMsg;
    if (publish) {
        if (anyPublishFailed) {
            showToast(`Unable to publish ${targetLabel.toLowerCase()}: ${lastError}`);
            return;
        } else if (totalFailedNotifications > 0) {
            successMsg = `${targetLabel} published successfully, but ${totalFailedNotifications} notification email(s) could not be sent.`;
        } else {
            successMsg = `${targetLabel} published successfully. Student notifications sent: ${totalStudents}. Faculty notifications sent: ${totalFaculty}.`;
        }
    } else {
        successMsg = `${targetLabel} saved as draft.`;
    }

    showSuccessOverlay(successMsg);
    examModal.style.display = "none";
    await refreshSavedExamSchedules();
}


// Save as Draft
saveExamBtn?.addEventListener("click", async () => {
    if (!currentGeneratedSchedules.length) return;
    saveExamBtn.disabled = true;
    saveExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Saving All..." : "Saving...";

    try {
        await persistGeneratedSchedules({ publish: false });
    } catch (err) {
        showToast(`Save error: ${err.message}`);
    } finally {
        saveExamBtn.disabled = false;
        saveExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Save All Drafts" : "Save as Draft";
    }
});

// Publish Exam Schedule
publishExamBtn?.addEventListener("click", async () => {
    if (!currentGeneratedSchedules.length) return;
    publishExamBtn.disabled = true;
    publishExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Publishing All..." : "Publishing...";

    try {
        await persistGeneratedSchedules({ publish: true });
    } catch (err) {
        showToast(`Publish error: ${err.message}`);
    } finally {
        publishExamBtn.disabled = false;
        publishExamBtn.textContent = currentGeneratedSchedules.length > 1 ? "Publish All Generated" : "Publish Exam Schedule";
    }
});

// ===================================================
// FIRESTORE SYNC & API CALLS
// ===================================================
async function loadExamSchedulesFromFirestore() {
    try {
        const snap = await getDocs(collection(db, "examSchedules"));
        const schedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        localStorage.setItem(EXAM_SCHEDULES_KEY, JSON.stringify(schedules));
        savedExamSchedules = schedules;
        return schedules;
    } catch (err) {
        console.warn("Could not fetch examSchedules from Firestore:", err.message);
        try {
            savedExamSchedules = JSON.parse(localStorage.getItem(EXAM_SCHEDULES_KEY)) || [];
        } catch {
            savedExamSchedules = [];
        }
        return savedExamSchedules;
    }
}

async function saveExamScheduleToFirestore(schedule) {
    const docId = schedule.id || `${schedule.academicYear}_${schedule.semester}_${schedule.examType}_${schedule.section}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    schedule.id = docId;
    schedule.updatedAt = new Date().toISOString();
    await setDoc(doc(db, "examSchedules", docId), schedule, { merge: true });
}

async function deleteExamScheduleFromFirestore(docId) {
    await deleteDoc(doc(db, "examSchedules", docId));
}

async function publishExamScheduleApi(schedule) {
    const endpoint = `${API_BASE_URL}/api/publish/exam-schedule`;
    try {
        const docId = schedule.id || `${schedule.academicYear}_${schedule.semester}_${schedule.examType}_${schedule.section}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        schedule.id = docId;

        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                scheduleId: schedule.id,
                scheduleData: schedule,
                examType: schedule.examType,
                publishedBy: auth.currentUser?.email || "Admin"
            })
        });

        // Safe response parsing: inspect content-type before attempting json()
        const contentType = res.headers.get("content-type") || "";
        let data = null;

        if (contentType.includes("application/json")) {
            try {
                data = await res.json();
            } catch (parseErr) {
                console.warn("[Publish API] JSON parsing failed:", parseErr.message);
                data = null;
            }
        } else {
            try {
                const text = await res.text();
                console.warn(`[Publish API] Non-JSON response (status ${res.status}):`, text.slice(0, 150));
            } catch {
                // Ignore text read error
            }
        }

        if (!res.ok) {
            let errorMsg = data?.message || data?.error;
            if (!errorMsg) {
                if (res.status === 405) {
                    errorMsg = "Unable to publish examination schedule. HTTP 405 Method Not Allowed.";
                } else if (res.status === 404) {
                    errorMsg = "Unable to publish examination schedule. The server endpoint could not be found (404).";
                } else if (res.status >= 500) {
                    errorMsg = `Unable to publish examination schedule. Server error (${res.status}).`;
                } else {
                    errorMsg = `Unable to publish examination schedule (HTTP ${res.status}).`;
                }
            }
            console.error("[Publish API Error]", res.status, errorMsg);
            return {
                success: false,
                status: res.status,
                message: errorMsg
            };
        }

        if (!data) {
            return {
                success: false,
                status: res.status,
                message: "Unable to publish examination schedule. The server endpoint returned an empty or invalid response."
            };
        }

        return data;
    } catch (err) {
        console.error("[Publish API Network Error]", err);
        return {
            success: false,
            networkError: true,
            message: "Unable to publish examination schedule. The server endpoint could not be reached."
        };
    }
}

// ===================================================
// SAVED EXAM SCHEDULES RENDERING
// ===================================================
async function refreshSavedExamSchedules() {
    await loadExamSchedulesFromFirestore();
    renderSavedExamSchedules();
}

function renderSavedExamSchedules() {
    if (!savedExamSchedulesContainer) return;
    savedExamSchedulesContainer.innerHTML = "";

    const searchTerm = (savedScheduleSearchInput?.value || "").trim().toLowerCase();
    const filtered = savedExamSchedules.filter(s => {
        if (!searchTerm) return true;
        const text = `${s.section} ${s.academicYear} ${s.semester} ${s.examType} ${s.program} ${s.major}`.toLowerCase();
        return text.includes(searchTerm);
    });

    if (filtered.length === 0) {
        if (emptyExamSchedules) emptyExamSchedules.style.display = "block";
        return;
    }

    if (emptyExamSchedules) emptyExamSchedules.style.display = "none";

    filtered.forEach(schedule => {
        const card = document.createElement("div");
        card.className = "schedule-card";

        const isPublished = schedule.status === "published";
        const badgeClass = isPublished ? "badge-published" : "badge-draft";
        const badgeText = isPublished ? "Published" : "Draft";

        let examsHtml = "";
        (schedule.exams || []).forEach(e => {
            examsHtml += `
                <tr>
                    <td><strong>${escapeHtml(e.code)}</strong></td>
                    <td>${escapeHtml(e.name)}</td>
                    <td>${e.units || 3}</td>
                    <td>${e.date !== "TBA" ? formatDateDisplay(e.date) : "TBA"}</td>
                    <td>${escapeHtml(e.time)}</td>
                    <td>${escapeHtml(e.room)}</td>
                    <td>${escapeHtml(e.proctor)}</td>
                </tr>
            `;
        });

        card.innerHTML = `
            <div class="schedule-card-header">
                <div>
                    <div class="schedule-card-title">
                        ${escapeHtml(schedule.section)}
                        <span class="${badgeClass}">${badgeText}</span>
                    </div>
                    <div class="schedule-card-subtitle">
                        A.Y. ${escapeHtml(schedule.academicYear)} • ${escapeHtml(schedule.semester)} • ${escapeHtml(schedule.examType)} Examination
                    </div>
                </div>
                <div class="schedule-card-actions">
                    <button type="button" class="btn-view-cal" data-id="${schedule.id}">View Calendar</button>
                    <button type="button" class="edit-schedule-btn" data-id="${schedule.id}">Edit</button>
                    ${!isPublished ? `<button type="button" class="btn-publish-card" data-id="${schedule.id}">Publish</button>` : ''}
                    <button type="button" class="delete-schedule-btn" data-id="${schedule.id}">Delete</button>
                </div>
            </div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Subject Code</th>
                            <th>Subject Name</th>
                            <th>Units</th>
                            <th>Exam Date</th>
                            <th>Exam Time</th>
                            <th>Room</th>
                            <th>Faculty Proctor</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${examsHtml}
                    </tbody>
                </table>
            </div>
        `;

        // Card button event listeners
        card.querySelector(".btn-view-cal")?.addEventListener("click", () => openCalendarModal(schedule));
        card.querySelector(".edit-schedule-btn")?.addEventListener("click", () => openEditScheduleModal(schedule));
        card.querySelector(".btn-publish-card")?.addEventListener("click", () => publishSingleSchedule(schedule));
        card.querySelector(".delete-schedule-btn")?.addEventListener("click", () => deleteSingleSchedule(schedule.id));

        savedExamSchedulesContainer.appendChild(card);
    });
}

savedScheduleSearchInput?.addEventListener("input", renderSavedExamSchedules);

// Publish single schedule
async function publishSingleSchedule(schedule) {
    const ok = await showConfirm(`Publish ${schedule.examType} Examination Schedule for ${schedule.section}? This will notify students and faculty.`);
    if (!ok) return;

    try {
        const result = await publishExamScheduleApi(schedule);
        if (result?.published || result?.success) {
            schedule.status = "published";
            schedule.publishedAt = result.publishedAt || new Date().toISOString();

            const notifs = result.notifications || {};
            const students = result.studentSentCount ?? notifs.studentsSent ?? 0;
            const faculty = result.facultySentCount ?? notifs.facultySent ?? 0;
            const failed = result.failedCount ?? notifs.failed ?? 0;

            if (failed > 0) {
                showToast(`Examination schedule published successfully, but ${failed} notification email(s) could not be sent.`);
            } else {
                showToast(`Published ${schedule.examType} schedule for ${schedule.section}. Students notified: ${students}. Faculty notified: ${faculty}.`);
            }
        } else {
            const detail = result?.message || "Unable to publish examination schedule. The server endpoint could not be reached.";
            showToast(`Publish error: ${detail}`);
        }
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Publish error: ${err.message}`);
    }
}


// Delete single schedule
async function deleteSingleSchedule(docId) {
    const ok = await showConfirm("Are you sure you want to delete this examination schedule?");
    if (!ok) return;

    try {
        await deleteExamScheduleFromFirestore(docId);
        showToast("Examination schedule deleted.");
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Delete error: ${err.message}`);
    }
}

// Bulk Actions
publishAllExamBtn?.addEventListener("click", async () => {
    if (savedExamSchedules.length === 0) {
        showToast("No saved exam schedules to publish.");
        return;
    }
    const ok = await showConfirm(`Publish all ${savedExamSchedules.length} examination schedules and dispatch notifications?`);
    if (!ok) return;

    publishAllExamBtn.disabled = true;
    publishAllExamBtn.textContent = "Publishing...";

    try {
        let totalStudents = 0;
        let totalFaculty = 0;
        let totalFailed = 0;
        let anyFailed = false;
        let lastError = "";
        for (const s of savedExamSchedules) {
            const result = await publishExamScheduleApi(s);
            if (result?.published || result?.success) {
                s.status = "published";
                s.publishedAt = result.publishedAt || new Date().toISOString();
                const notifs = result.notifications || {};
                totalStudents += result.studentSentCount ?? notifs.studentsSent ?? 0;
                totalFaculty += result.facultySentCount ?? notifs.facultySent ?? 0;
                totalFailed += result.failedCount ?? notifs.failed ?? 0;
            } else {
                anyFailed = true;
                lastError = result?.message || "";
            }
        }
        if (anyFailed) {
            showToast(`Some examination schedules could not be published: ${lastError || "Check server connection."}`);
        } else if (totalFailed > 0) {
            showToast(`All examination schedules published successfully, but ${totalFailed} notification email(s) could not be sent.`);
        } else {
            showToast(`All examination schedules published successfully. Student notifications sent: ${totalStudents}. Faculty notifications sent: ${totalFaculty}.`);
        }
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Error publishing all: ${err.message}`);
    } finally {
        publishAllExamBtn.disabled = false;
        publishAllExamBtn.textContent = "Publish All";
    }
});


deleteAllExamBtn?.addEventListener("click", async () => {
    if (savedExamSchedules.length === 0) {
        showToast("No saved exam schedules to delete.");
        return;
    }
    const ok = await showConfirm(`Are you sure you want to delete all ${savedExamSchedules.length} examination schedules? This action cannot be undone.`);
    if (!ok) return;

    try {
        for (const s of savedExamSchedules) {
            await deleteExamScheduleFromFirestore(s.id);
        }
        showToast("All examination schedules deleted.");
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Error deleting all: ${err.message}`);
    }
});

moveExamArchiveBtn?.addEventListener("click", async () => {
    if (savedExamSchedules.length === 0) {
        showToast("No saved exam schedules to move.");
        return;
    }
    const ok = await showConfirm(
        `Move all ${savedExamSchedules.length} saved examination schedule(s) to the Schedule Archive? ` +
        "They will disappear from Saved Exam Schedules and remain available in the archive."
    );
    if (!ok) return;

    moveExamArchiveBtn.disabled = true;
    moveExamArchiveBtn.textContent = "Moving...";

    try {
        for (const s of savedExamSchedules) {
            await saveReportToFirestore({
                category: "Exam Schedule",
                title: `${s.section} - ${s.examType} Exam`,
                academicYear: s.academicYear,
                semester: s.semester,
                examType: s.examType,
                section: s.section,
                filename: `${s.section}_${s.examType}_Exam_Schedule.pdf`,
                entries: s.exams || [],
                html: "",
                archivedAt: new Date().toISOString()
            });
            await deleteExamScheduleFromFirestore(s.id);
        }
        showSuccessOverlay("All examination schedules moved to the Schedule Archive.");
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Archive error: ${err.message}`);
    } finally {
        moveExamArchiveBtn.disabled = false;
        moveExamArchiveBtn.textContent = "Move to Archive";
    }
});

// ===================================================
// EDIT EXAM SCHEDULE MODAL WITH LIVE CONFLICT CHECK
// ===================================================
function openEditScheduleModal(schedule) {
    if (!editScheduleModal) return;
    editingSchedule = JSON.parse(JSON.stringify(schedule));

    editScheduleTitle.textContent = `Edit Exam Schedule - ${schedule.section}`;
    editScheduleSubtitle.textContent = `A.Y. ${schedule.academicYear} • ${schedule.semester} • ${schedule.examType}`;

    renderEditTable();
    editScheduleModal.style.display = "flex";
}

closeEditScheduleModalBtn?.addEventListener("click", () => { editScheduleModal.style.display = "none"; });
cancelEditScheduleBtn?.addEventListener("click", () => { editScheduleModal.style.display = "none"; });

function renderEditTable() {
    if (!editScheduleTableBody || !editingSchedule) return;
    editScheduleTableBody.innerHTML = "";

    const roomsList = lectureRooms.length ? lectureRooms : [{ roomCode: "Room 101" }, { roomCode: "Room 102" }];
    const facultyList = allFacultyMembers;

    editingSchedule.exams.forEach((exam, idx) => {
        const tr = document.createElement("tr");

        let roomOpts = `<option value="TBA" ${exam.room === "TBA" ? "selected" : ""}>TBA</option>`;
        roomsList.forEach(rm => {
            const rName = rm.roomName || rm.roomCode;
            roomOpts += `<option value="${escapeHtml(rName)}" ${exam.room === rName ? "selected" : ""}>${escapeHtml(rName)}</option>`;
        });

        let proctorOpts = `<option value="Unassigned" ${exam.proctor === "Unassigned" ? "selected" : ""}>Unassigned</option>`;
        facultyList.forEach(f => {
            const fName = getFacultyName(f);
            if (!fName) return;
            proctorOpts += `<option value="${escapeHtml(fName)}" ${sameFaculty(exam.proctor, fName) ? "selected" : ""}>${escapeHtml(fName)}</option>`;
        });

        let timeOpts = `<option value="TBA" ${exam.time === "TBA" ? "selected" : ""}>TBA</option>`;
        const editSlots = Number(exam.durationMinutes) === 90 || String(exam.subjectType || "").toLowerCase() === "major"
            ? MAJOR_EXAM_SLOTS
            : SHORT_EXAM_SLOTS;
        editSlots.forEach(slot => {
            timeOpts += `<option value="${slot}" ${exam.time === slot ? "selected" : ""}>${slot}</option>`;
        });

        tr.innerHTML = `
            <td><strong>${escapeHtml(exam.code)}</strong></td>
            <td>${escapeHtml(exam.name)}</td>
            <td>${exam.units || 3}</td>
            <td><input type="date" class="edit-date" data-idx="${idx}" value="${exam.date !== 'TBA' ? exam.date : ''}"></td>
            <td><select class="edit-time" data-idx="${idx}">${timeOpts}</select></td>
            <td><select class="edit-room" data-idx="${idx}">${roomOpts}</select></td>
            <td><select class="edit-proctor" data-idx="${idx}">${proctorOpts}</select></td>
        `;

        editScheduleTableBody.appendChild(tr);
    });

    // Add change listeners
    editScheduleTableBody.querySelectorAll(".edit-date").forEach(input => {
        input.addEventListener("change", (e) => {
            const i = Number(e.target.dataset.idx);
            editingSchedule.exams[i].date = e.target.value || "TBA";
            editingSchedule.exams[i].day = e.target.value ? getDayName(e.target.value) : "TBA";
            validateEditConflicts();
        });
    });

    editScheduleTableBody.querySelectorAll(".edit-time").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const i = Number(e.target.dataset.idx);
            editingSchedule.exams[i].time = e.target.value;
            validateEditConflicts();
        });
    });

    editScheduleTableBody.querySelectorAll(".edit-room").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const i = Number(e.target.dataset.idx);
            editingSchedule.exams[i].room = e.target.value;
            validateEditConflicts();
        });
    });

    editScheduleTableBody.querySelectorAll(".edit-proctor").forEach(sel => {
        sel.addEventListener("change", (e) => {
            const i = Number(e.target.dataset.idx);
            editingSchedule.exams[i].proctor = e.target.value;
            validateEditConflicts();
        });
    });

    validateEditConflicts();
}

function validateEditConflicts() {
    if (!editingSchedule || !editScheduleConflicts) return true;
    const conflicts = [];
    const exams = editingSchedule.exams;

    // 1. Internal section conflicts
    for (let i = 0; i < exams.length; i++) {
        for (let j = i + 1; j < exams.length; j++) {
            const e1 = exams[i];
            const e2 = exams[j];
            if (e1.date !== "TBA" && e1.date === e2.date && !hasRequiredSectionGap([e1.time], e2.time)) {
                conflicts.push(`Required one-hour section break: ${e1.code} and ${e2.code} need at least one hour between examinations on ${e1.date}.`);
            }
            if (e1.date !== "TBA" && e1.date === e2.date && timesOverlap(e1.time, e2.time)) {
                conflicts.push(`Section overlap: ${e1.code} and ${e2.code} are scheduled on the same date (${e1.date}) and overlapping time.`);
            }
            if (e1.date !== "TBA" && e1.date === e2.date && timesOverlap(e1.time, e2.time) && e1.room !== "TBA" && e1.room === e2.room) {
                conflicts.push(`Room double-booking: Room ${e1.room} is assigned to both ${e1.code} and ${e2.code} on ${e1.date} at ${e1.time}.`);
            }
            if (e1.date !== "TBA" && e1.date === e2.date && timesOverlap(e1.time, e2.time) && e1.proctor !== "Unassigned" && sameFaculty(e1.proctor, e2.proctor)) {
                conflicts.push(`Proctor clash: Faculty ${e1.proctor} is assigned to both ${e1.code} and ${e2.code} on ${e1.date} at ${e1.time}.`);
            }
        }
    }

    // 2. External conflict check against other saved schedules
    savedExamSchedules.forEach(other => {
        if (other.id === editingSchedule.id) return;
        if (other.academicYear !== editingSchedule.academicYear || other.semester !== editingSchedule.semester || other.examType !== editingSchedule.examType) return;

        (other.exams || []).forEach(otherExam => {
            exams.forEach(curExam => {
                if (curExam.date !== "TBA" && curExam.date === otherExam.date && timesOverlap(curExam.time, otherExam.time)) {
                    if (curExam.room !== "TBA" && curExam.room === otherExam.room) {
                        conflicts.push(`Room clash with ${other.section}: ${curExam.room} is already booked on ${curExam.date} ${curExam.time}.`);
                    }
                    if (curExam.proctor !== "Unassigned" && sameFaculty(curExam.proctor, otherExam.proctor)) {
                        conflicts.push(`Proctor clash with ${other.section}: ${curExam.proctor} is already proctoring on ${curExam.date} ${curExam.time}.`);
                    }
                }
            });
        });
    });

    if (conflicts.length > 0) {
        editScheduleConflicts.style.display = "block";
        editScheduleConflicts.innerHTML = `
            <div class="edit-conflict-banner">
                <h4>⚠️ Scheduling Conflicts Detected</h4>
                <ul class="edit-conflict-list">
                    ${conflicts.map(c => `<li>${escapeHtml(c)}</li>`).join("")}
                </ul>
            </div>
        `;
        return false;
    } else {
        editScheduleConflicts.style.display = "none";
        editScheduleConflicts.innerHTML = "";
        return true;
    }
}

saveEditScheduleBtn?.addEventListener("click", async () => {
    if (!editingSchedule) return;
    const isValid = validateEditConflicts();
    if (!isValid) {
        const ok = await showConfirm("Conflicts were detected. Are you sure you want to save anyway?");
        if (!ok) return;
    }

    saveEditScheduleBtn.disabled = true;
    saveEditScheduleBtn.textContent = "Saving...";

    try {
        await saveExamScheduleToFirestore(editingSchedule);
        editScheduleModal.style.display = "none";
        showSuccessOverlay("Exam schedule changes saved.");
        await refreshSavedExamSchedules();
    } catch (err) {
        showToast(`Save error: ${err.message}`);
    } finally {
        saveEditScheduleBtn.disabled = false;
        saveEditScheduleBtn.textContent = "Save Changes";
    }
});

// ===================================================
// CALENDAR MODAL
// ===================================================
function openCalendarModal(schedule) {
    if (!examCalendarModal || !clsCalModalBody) return;
    clsCalModalTitle.textContent = `${schedule.section} - ${schedule.examType} Exam Timetable`;
    clsCalModalSubtitle.textContent = `A.Y. ${schedule.academicYear} • ${schedule.semester}`;

    clsCalModalBody.innerHTML = renderExamCalendar(schedule);

    examCalendarModal.style.display = "flex";
}

clsCalModalClose?.addEventListener("click", () => {
    examCalendarModal.style.display = "none";
});

// ===================================================
// GUIDE MODAL
// ===================================================
const EXAM_GUIDE_DONT_SHOW_KEY = "examGuideDontShowAgain";

guideInfoBtn?.addEventListener("click", () => {
    if (examGuideModal) examGuideModal.style.display = "flex";
});

function closeExamGuideModal() {
    if (!examGuideModal) return;
    // Persist the preference only when "Don't show this again" is checked
    if (guideDontShowAgain?.checked) {
        try {
            localStorage.setItem(EXAM_GUIDE_DONT_SHOW_KEY, "true");
        } catch (err) {
            console.warn("Could not save guide preference:", err);
        }
    }
    examGuideModal.style.display = "none";
}

guideModalClose?.addEventListener("click", closeExamGuideModal);

guideGotItBtn?.addEventListener("click", closeExamGuideModal);

// Auto-open the guide on first visit (unless the user opted out)
try {
    if (localStorage.getItem(EXAM_GUIDE_DONT_SHOW_KEY) !== "true") {
        if (examGuideModal) examGuideModal.style.display = "flex";
    }
} catch (err) {
    console.warn("Could not read guide preference:", err);
    if (examGuideModal) examGuideModal.style.display = "flex";
}

// ===================================================
// AUTH & LOGOUT
// ===================================================
logoutLink?.addEventListener("click", async (e) => {
    e.preventDefault();
    const ok = await showConfirm("Are you sure you want to log out?");
    if (ok) {
        try { await signOut(auth); } catch {}
        window.location.href = "login.html";
    }
});

// ===================================================
// INITIALIZATION
// ===================================================
async function init() {
    initMultiSelectDropdowns();
    await Promise.all([
        loadSectionsFromFirestore(),
        loadLectureRooms(),
        loadFacultyMembers(),
        loadExamSchedulesFromFirestore()
    ]);
    renderAllDropdowns();
    renderSavedExamSchedules();
}

onAuthStateChanged(auth, user => {
    if (!user) {
        window.location.href = "login.html";
    } else {
        init();
    }
});
