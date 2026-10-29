import { db, auth } from "../firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
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
    getDoc,
    writeBatch
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
const subjectPagination = document.getElementById("subjectPagination");
const subjectsPrevBtn = document.getElementById("subjectsPrevBtn");
const subjectsNextBtn = document.getElementById("subjectsNextBtn");
const subjectsPageLabel = document.getElementById("subjectsPageLabel");
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
let currentGeneratedSchedules = [];
let currentGeneratedSectionIndex = 0;
let allSections = [];

let PROGRAM_MAJORS = {
    "BIT": ["CPT"],
    "BINDTECH": ["CPT"],
    "BTVTED": ["MT", "AT", "CP", "FSM", "CT", "ELT", "ELX"]
};

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

function selectedValues(selectOrKey) {
    const key = typeof selectOrKey === "string" ? selectOrKey : selectOrKey?.id;
    return msdState[key] ? [...msdState[key]] : [];
}

function getMajorsForPrograms(programs) {
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

function formatYearLevelText(yl) {
    const n = Number(yl);
    if (n === 1) return "1st Year";
    if (n === 2) return "2nd Year";
    if (n === 3) return "3rd Year";
    if (n === 4) return "4th Year";
    return String(yl || "");
}

function getAvailableOptions(key) {
    if (key === "program") {
        return Object.keys(PROGRAM_MAJORS);
    }
    if (key === "major") {
        const programs = [...msdState.program];
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
        const codes = new Set();
        allSections
            .filter(sec => {
                if (programs.length && !programs.includes(sec.programCode)) return false;
                if (majors.length && !majors.includes(sec.majorCode)) return false;
                if (yearLevels.length && !yearLevels.includes(Number(sec.yearLevel))) return false;
                return true;
            })
            .forEach(s => codes.add(s.sectionCode));
        return [...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    return [];
}

function msdDisplayText(key, value) {
    return key === "yearLevel" ? formatYearLevelText(value) : value;
}

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

    const prevList = menu.querySelector(".msd-options-list");
    const prevScrollTop = prevList ? prevList.scrollTop : 0;
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

    const newList = menu.querySelector(".msd-options-list");
    if (newList) newList.scrollTop = prevScrollTop;
    if (window.scrollY !== pageScrollY || window.scrollX !== pageScrollX) {
        window.scrollTo(pageScrollX, pageScrollY);
    }
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
        const menu = el.querySelector(".msd-menu");
        if (menu) menu.style.display = "none";
        const card = el.closest(".card");
        if (card && !card.querySelector(".msd.open")) card.classList.remove("msd-elevated");
    });
}

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

function onFilterChanged(key) {
    pruneStaleSelections(key);
    renderAllDropdowns();
}

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

async function loadSectionsFromFirestore() {
    try {
        const [snap, progSnap, majorSnap] = await Promise.all([
            getDocs(collection(db, "sections")),
            getDocs(collection(db, "programs")).catch(() => ({ docs: [] })),
            getDocs(collection(db, "majors")).catch(() => ({ docs: [] }))
        ]);

        progSnap.docs.forEach(d => {
            const data = d.data();
            const code = String(data.programCode || data.courseCode || d.id).trim().toUpperCase();
            if (code && !PROGRAM_MAJORS[code]) {
                PROGRAM_MAJORS[code] = [];
            }
        });

        majorSnap.docs.forEach(d => {
            const data = d.data();
            const prog = String(data.program || data.programCode || "").trim().toUpperCase();
            const major = String(data.majorCode || "").trim().toUpperCase();
            if (prog && major) {
                if (!PROGRAM_MAJORS[prog]) PROGRAM_MAJORS[prog] = [];
                if (!PROGRAM_MAJORS[prog].includes(major)) {
                    PROGRAM_MAJORS[prog].push(major);
                }
            }
        });

        allSections = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderAllDropdowns();
    } catch (err) {
        console.warn("Could not load sections from Firestore:", err.message);
    }
}

initMultiSelectDropdowns();
loadSectionsFromFirestore();

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
    "1:00-2:30", "1:30-3:00", "2:30-4:00", "4:00-5:30",
    "5:00-6:30"
];

const majorSlots = [
    "7:30-10:00", "10:00-12:30", "1:00-3:30", "1:30-4:00", "3:30-6:00",
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

/**
 * Checks whether a subject is a Research subject based on code, name, or subjectType.
 * (e.g. RES01, RES02, RES01a, Methods of Research, Technology Research, Project Study)
 */
function isResearchSubject(code, name, subjectType) {
    const rawType = String(subjectType || "").trim().toLowerCase();
    if (rawType === "research" || rawType.includes("research")) return true;
    const cleanCode = String(code || "").trim();
    if (/^RES\d|^RES/i.test(cleanCode)) return true;
    const cleanName = String(name || "").trim().toLowerCase();
    if (/methods of research|technology research|project study|undergraduate thesis|thesis|capstone/i.test(cleanName)) return true;
    return false;
}

/**
 * Detects minor/general education subjects by their subject code prefix.
 * These subjects (Math, English, Filipino, Science, etc.) are always lecture-only
 * even if they have multiple meeting slots — they do NOT use a laboratory.
 */
function isLikelyMinorSubjectByCode(code, name) {
    const c = String(code || "").trim().toUpperCase();
    // Common minor/general education subject code prefixes
    if (/^(MAT|MATH|ENG|FIL|SCI|NSTP|PE\d|PED|GEN|SOC|HIS|LIT|COM|NAT|HUMN|HIST|POLI|ECON|PHILO|SOCSCI|MMW|GEC|PATH|PATHFIT|CWTS|ROTC|RIZAL|ELEC|ENTREP|RA\d|TIC|ICT)/i.test(c)) return true;
    const n = String(name || "").trim().toLowerCase();
    if (/mathematics|algebra|calculus|trigonometry|english|filipino|science|physics|chemistry|biology|history|social|philosophy|economics|political|literature|pathfit|fitness|wellness|pe |physical education|national service|rotc|cwts|rizal|general education|entrep|exploratory|ict|information.{0,20}communication/i.test(n)) return true;
    return false;
}

/**
 * Checks whether a subject type is shared when splitting sections
 * (Minor, Activity, and Research are combined / shared between Set A and Set B).
 */
function isSharedSubjectType(type, code = "", name = "") {
    const t = String(type || "").trim().toLowerCase();
    if (t === "minor" || t === "activity" || t === "research" || t === "general") return true;
    if (t.includes("minor") || t.includes("activity") || t.includes("research")) return true;
    if (isResearchSubject(code, name, type)) return true;
    if (isLikelyMinorSubjectByCode(code, name)) return true;
    return false;
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

let allFacultyMembers = [];
let allRooms = [];
let facultyAssignmentsMap = new Map();
let facultyRoomPrefsMap = new Map(); // facultyUid / employeeId -> roomPreferences object
let subjectGroups = [];
let allLoadedSubjects = [];
let currentSubjectGroupIndex = 0;
const subjectFacultySelections = new Map();
let currentSplitContext = null;

async function loadRooms() {
    try {
        const roomSnapshot = await getDocs(collection(db, "rooms"));
        allRooms = roomSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.warn("Could not load rooms:", error);
    }
}

function normalizeAyStr(ay) {
    return String(ay || "")
        .replace(/a\.y\.?\s*/i, "")
        .replace(/[\u2013\u2014–—]/g, "-")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();
}

function normalizeSemStr(sem) {
    const s = String(sem || "").toLowerCase().trim();
    if (s.includes("1") || s.includes("first")) return "1st semester";
    if (s.includes("2") || s.includes("second")) return "2nd semester";
    if (s.includes("mid") || s.includes("summer")) return "midyear";
    return s;
}

function isPlaceholderRoomName(roomStr) {
    const n = String(roomStr || "").trim().replace(/\s+/g, " ").toLowerCase();
    return !n || n === "unassigned" || n === "tba";
}

/**
 * Detects "no schedule" placeholder values used for Day / Time / Room fields.
 * Subjects whose faculty is unassigned are stored with placeholders instead of a
 * real schedule: blank, "-", "--", "- / -", "TBA", "N/A", etc. These must never
 * participate in conflict detection.
 */
function isUnscheduledValue(value) {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return true;
    if (v === "tba" || v === "unassigned" || v === "n/a" || v === "na" || v === "none") return true;
    // Strings composed only of dashes, slashes, dots and whitespace (e.g. "-", "- / -", "-- / --")
    return /^[\/\-\s._]*$/.test(v);
}


function sameFaculty(f1, f2) {
    if (!f1 || !f2) return false;
    const n1 = String(f1).trim().replace(/\s+/g, " ").toLowerCase();
    const n2 = String(f2).trim().replace(/\s+/g, " ").toLowerCase();
    if (!n1 || !n2 || n1 === "unassigned" || n2 === "unassigned" || n1 === "tba" || n2 === "tba") return false;
    if (n1 === n2) return true;

    const normalizeFacTokens = s => {
        const clean = s.replace(/\b(dr|prof|engr|instructor|ms|mr|mrs)\.?\b/gi, "")
                       .replace(/,\s*/g, " ")
                       .replace(/\s+/g, " ")
                       .trim();
        return clean.split(" ").filter(t => t.length > 1);
    };

    const tokens1 = normalizeFacTokens(n1);
    const tokens2 = normalizeFacTokens(n2);

    if (tokens1.length && tokens2.length) {
        if (tokens1.length === tokens2.length && tokens1.every(t => tokens2.includes(t))) return true;
        const intersection = tokens1.filter(t => tokens2.includes(t));
        if (intersection.length >= 2 && (intersection.length === tokens1.length || intersection.length === tokens2.length)) {
            return true;
        }
    }

    const stripInitial = s => s.replace(/\s+[a-z]\.?$/i, "").replace(/,\s*/g, " ").trim();
    return stripInitial(n1) === stripInitial(n2);
}

function normalizeRoomIdentifier(r) {
    if (!r) return "";
    return String(r).trim().toLowerCase()
        .replace(/^room\s+/i, "")
        .replace(/[^a-z0-9]/gi, "");
}

function sameRoom(r1, r2) {
    if (!r1 || !r2) return false;
    const s1 = String(r1).trim().toLowerCase();
    const s2 = String(r2).trim().toLowerCase();
    if (s1 === s2) return true;
    if (s1 === "tba" || s2 === "tba") return false;
    return normalizeRoomIdentifier(r1) === normalizeRoomIdentifier(r2);
}

/**
 * Returns true when two section names are the Set A / Set B split of the same base section.
 * e.g. "BTVTED-CP 1A-Set A" and "BTVTED-CP 1A-Set B" → true
 */
function arePairedSets(sec1, sec2) {
    if (!sec1 || !sec2 || sec1 === sec2) return false;
    const strip = s => String(s).replace(/[-\s]*(Set\s*[AB]|Set[AB])$/i, "").trim().toLowerCase();
    const b1 = strip(sec1);
    const b2 = strip(sec2);
    return b1 && b2 && b1 === b2;
}

/**
 * Returns true when a schedule entry represents a subject that is SHARED
 * between Set A and Set B (minor, general, activity, research).
 * These subjects are attended by all students together — same room, same time.
 */
function isSharedSubjectEntry(entry) {
    if (!entry) return false;
    const subType = String(entry.subjectType || "").toLowerCase();
    const code    = entry.code || entry.subjectCode || "";
    const name    = entry.name || entry.subjectName || "";
    return isSharedSubjectType(subType, code, name) ||
           isLikelyMinorSubjectByCode(code, name) ||
           isActivityEntry(entry);
}

async function loadFacultyMembers() {
    try {
        const usersSnap = await getDocs(collection(db, "users"));
        const list = [];
        usersSnap.docs.forEach(docSnap => {
            const u = docSnap.data();
            const role = String(u.role || "").trim().toLowerCase();
            if (role === "faculty") {
                list.push({
                    uid: docSnap.id,
                    id: docSnap.id,
                    employeeId: u.employeeId || u.facultyId || "",
                    name: u.fullName || u.name || "Unknown Faculty",
                    email: u.email || "",
                    department: u.department || u.program || ""
                });
            }
        });

        try {
            const legacySnap = await getDocs(collection(db, "faculty"));
            legacySnap.docs.forEach(docSnap => {
                const f = docSnap.data();
                const name = f.fullName || f.name || f.facultyName || "";
                if (name && !list.some(x => x.name.toLowerCase() === name.toLowerCase())) {
                    list.push({
                        uid: docSnap.id,
                        id: docSnap.id,
                        employeeId: f.employeeId || f.facultyId || "",
                        name: name,
                        email: f.email || "",
                        department: f.department || ""
                    });
                }
            });
        } catch (_) {}

        list.sort((a, b) => a.name.localeCompare(b.name));
        allFacultyMembers = list;
    } catch (err) {
        console.warn("Could not load faculty members in class.js:", err);
    }
}

async function loadFacultySubjectAssignments() {
    try {
        const snap = await getDocs(collection(db, "facultySubjectAssignments"));
        facultyAssignmentsMap.clear();
        snap.docs.forEach(docSnap => {
            const data = docSnap.data();
            const handled = Array.isArray(data.handledSubjects) ? data.handledSubjects : [];
            facultyAssignmentsMap.set(docSnap.id, handled);
            if (data.facultyId) facultyAssignmentsMap.set(data.facultyId, handled);
        });
    } catch (err) {
        console.warn("Could not load faculty subject assignments in class.js:", err);
    }
}

/**
 * Loads faculty room preferences from Firestore (users collection) into facultyRoomPrefsMap.
 * Called once during page init alongside other data loaders.
 */
async function loadFacultyRoomPreferences() {
    try {
        facultyRoomPrefsMap.clear();
        const snap = await getDocs(collection(db, "users"));
        snap.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (data.roomPreferences && (data.role === "faculty" || data.role === "Faculty")) {
                facultyRoomPrefsMap.set(docSnap.id, data.roomPreferences);
                if (data.employeeId) facultyRoomPrefsMap.set(data.employeeId, data.roomPreferences);
                if (data.facultyId)  facultyRoomPrefsMap.set(data.facultyId,  data.roomPreferences);
            }
        });
    } catch (err) {
        console.warn("Could not load faculty room preferences in class.js:", err);
    }
}

/**
 * Returns the preferred room codes list for a faculty, or [] if none.
 * @param {string} facUid  - Faculty UID
 * @param {string} facName - Faculty display name (used for name-based lookup fallback)
 */
function getFacultyRoomPrefs(facUid, facName) {
    const pref = (facUid ? facultyRoomPrefsMap.get(facUid) : null)
        || (facName
            ? (() => {
                const f = allFacultyMembers.find(m => sameFaculty(m.name, facName));
                return f ? facultyRoomPrefsMap.get(f.uid) || facultyRoomPrefsMap.get(f.employeeId) : null;
              })()
            : null)
        || null;
    if (!pref) return { preferredRooms: [], preferredBuilding: "", restrictedRoomList: false };
    return {
        preferredRooms: Array.isArray(pref.preferredRooms) ? pref.preferredRooms : [],
        preferredBuilding: pref.preferredBuilding || "",
        restrictedRoomList: Boolean(pref.restrictedRoomList)
    };
}

function parseHandledSubject(raw) {
    if (!raw) return null;
    if (typeof raw === "object") {
        return {
            programCode: String(raw.programCode || raw.program || "").trim().toUpperCase(),
            majorCode: String(raw.majorCode || raw.major || "").trim().toUpperCase(),
            yearLevel: raw.yearLevel ? String(raw.yearLevel).trim() : "",
            semester: raw.semester ? String(raw.semester).trim() : "",
            subjectCode: String(raw.subjectCode || raw.code || raw.id || "").trim().toUpperCase()
        };
    }
    const str = String(raw).trim();
    if (!str) return null;
    if (str.includes("_")) {
        const parts = str.split("_");
        if (parts.length >= 5) {
            return {
                programCode: parts[0].trim().toUpperCase(),
                majorCode: parts[1].trim().toUpperCase(),
                yearLevel: parts[2].trim(),
                semester: parts[3].trim(),
                subjectCode: parts[4].trim().toUpperCase()
            };
        }
        if (parts.length === 2) {
            const left = parts[0].trim().toUpperCase();
            const right = parts[1].trim().toUpperCase();
            if (left.includes("-")) {
                const subParts = left.split("-");
                return {
                    programCode: subParts[0].trim(),
                    majorCode: subParts[1].trim(),
                    yearLevel: "",
                    semester: "",
                    subjectCode: right
                };
            }
            return {
                programCode: left,
                majorCode: "",
                yearLevel: "",
                semester: "",
                subjectCode: right
            };
        }
    }
    return {
        programCode: "",
        majorCode: "",
        yearLevel: "",
        semester: "",
        subjectCode: str.toUpperCase()
    };
}

function getSubjectCompositeKey(subject) {
    if (!subject) return "";
    if (typeof subject === "string") return subject.trim().toUpperCase();
    return [
        String(subject.programCode || subject.program || "").trim().toUpperCase(),
        String(subject.majorCode || subject.major || "").trim().toUpperCase(),
        String(subject.yearLevel || "").trim(),
        String(subject.semester || "").trim(),
        String(subject.subjectCode || subject.code || "").trim().toUpperCase()
    ].filter(Boolean).join("_");
}

function isFacultyEligibleForSubject(facultyHandledList, criteria) {
    if (!Array.isArray(facultyHandledList) || !facultyHandledList.length || !criteria) return false;
    const cleanSubjectCode = String(criteria.subjectCode || criteria.code || "").trim().toUpperCase();
    if (!cleanSubjectCode) return false;

    let cleanProg = String(criteria.programCode || criteria.program || "").trim().toUpperCase();
    let cleanMaj = String(criteria.majorCode || criteria.major || "").trim().toUpperCase();

    if ((!cleanProg || !cleanMaj) && criteria.section) {
        const match = String(criteria.section).trim().match(/^([A-Za-z]+)-([A-Za-z]+)/i);
        if (match) {
            if (!cleanProg) cleanProg = match[1].toUpperCase();
            if (!cleanMaj) cleanMaj = match[2].toUpperCase();
        }
    }

    for (const raw of facultyHandledList) {
        const parsed = parseHandledSubject(raw);
        if (!parsed || !parsed.subjectCode) continue;

        // Subject code must match exactly (never substring or partial match)
        if (parsed.subjectCode !== cleanSubjectCode) continue;

        // If handled subject specifies program, and class specifies program, they must match
        if (parsed.programCode && cleanProg && parsed.programCode !== cleanProg) continue;

        // If handled subject specifies major, and class specifies major, they must match
        if (parsed.majorCode && cleanMaj && parsed.majorCode !== cleanMaj) continue;

        return true;
    }

    return false;
}

function buildFacultySelectHtml(subject, selectedFaculty = "") {
    let options = `<option value="">-- Unassigned --</option>`;

    const criteria = typeof subject === "object" ? subject : { subjectCode: subject };
    const cleanSubjectCode = String(criteria.subjectCode || criteria.code || "").trim().toUpperCase();

    const eligibleFaculty = allFacultyMembers.filter(f => {
        const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
        return isFacultyEligibleForSubject(handled, criteria);
    });

    const optionsFaculty = [...eligibleFaculty];
    if (selectedFaculty) {
        const alreadyIn = optionsFaculty.some(f => sameFaculty(f.name, selectedFaculty) || f.uid === selectedFaculty);
        if (!alreadyIn) {
            const currentFac = allFacultyMembers.find(f => sameFaculty(f.name, selectedFaculty) || f.uid === selectedFaculty);
            if (currentFac) {
                optionsFaculty.unshift(currentFac);
            }
        }
    }

    optionsFaculty.forEach(f => {
        const isSelected = selectedFaculty
            ? (sameFaculty(f.name, selectedFaculty) || f.uid === selectedFaculty)
            : false;
        options += `<option value="${escapeHtml(f.name)}" data-uid="${escapeHtml(f.uid)}" data-employee-id="${escapeHtml(f.employeeId || '')}" ${isSelected ? 'selected' : ''}>${escapeHtml(f.name)}${f.employeeId ? ' (' + escapeHtml(f.employeeId) + ')' : ''}</option>`;
    });

    const subjectKey = getSubjectCompositeKey(criteria);
    return `<select class="faculty-select" data-subject-key="${escapeHtml(subjectKey)}" data-subject-code="${escapeHtml(cleanSubjectCode)}" style="padding:6px 10px; border:1px solid #c9c1b0; border-radius:6px; font-size:13px; max-width:220px; background:#fff;">${options}</select>`;
}

function getFacultyForSubject(subjectOrCode, curriculumMeta = {}) {
    if (!subjectOrCode) {
        return { faculty: "Unassigned", facultyUid: "", facultyId: "" };
    }

    let code = "";
    let criteria = {};
    if (typeof subjectOrCode === "object") {
        criteria = { ...subjectOrCode, ...curriculumMeta };
        code = (criteria.subjectCode || criteria.code || "").trim();
    } else {
        code = String(subjectOrCode).trim();
        criteria = { subjectCode: code, ...curriculumMeta };
    }

    const key = getSubjectCompositeKey(criteria);

    // 1. Explicitly selected by user in UI dropdown
    const manualVal = (key && subjectFacultySelections.get(key)) || subjectFacultySelections.get(code);
    if (manualVal) {
        const fac = allFacultyMembers.find(f => sameFaculty(f.name, manualVal) || f.uid === manualVal);
        if (fac) {
            return {
                faculty: fac.name,
                facultyUid: fac.uid || "",
                facultyId: fac.employeeId || ""
            };
        }
        return {
            faculty: manualVal,
            facultyUid: "",
            facultyId: ""
        };
    }

    // Handled Subjects means eligibility only — actual assignment is Unassigned unless explicitly selected
    return {
        faculty: "Unassigned",
        facultyUid: "",
        facultyId: ""
    };
}

function getSectionMeta(secCode) {
    const clean = (secCode || "").trim();
    let secMeta = allSections.find(s => (s.sectionCode || "").trim().toUpperCase() === clean.toUpperCase());
    if (secMeta && secMeta.programCode && secMeta.majorCode && secMeta.yearLevel) {
        return {
            sectionCode: clean,
            programCode: secMeta.programCode,
            majorCode: secMeta.majorCode,
            yearLevel: Number(secMeta.yearLevel)
        };
    }
    // Parse regex fallback: e.g. "BINDTECH-CPT 2A", "BIT-CPT 3A", "BTVTED-AT 1A"
    const match = clean.match(/^([A-Za-z]+)-([A-Za-z]+)\s*(\d+)/i);
    if (match) {
        return {
            sectionCode: clean,
            programCode: secMeta?.programCode || match[1].toUpperCase(),
            majorCode: secMeta?.majorCode || match[2].toUpperCase(),
            yearLevel: Number(secMeta?.yearLevel || match[3])
        };
    }
    return {
        sectionCode: clean,
        programCode: secMeta?.programCode || selectedValues(programSelect)[0] || "",
        majorCode: secMeta?.majorCode || selectedValues(majorSelect)[0] || "",
        yearLevel: Number(secMeta?.yearLevel || selectedValues(yearLevelSelect)[0] || 1)
    };
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
        originalSection: schedule.originalSection || null,
        setName: schedule.setName || null,
        scheduleGroupId: schedule.scheduleGroupId || null,
        sharedScheduleId: schedule.sharedScheduleId || null,
        isSplit: Boolean(schedule.isSplit),
        subjectClassifications: schedule.subjectClassifications || null,
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

async function publishClassScheduleApi(schedule) {
    const payload = {
        scheduleId: schedule.id || scheduleDocId(schedule),
        scheduleData: schedule,
        publishedBy: auth.currentUser?.uid || null
    };

    let response = null;
    try {
        response = await fetch("/api/publish/class-schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        try {
            response = await fetch("http://localhost:3000/api/publish/class-schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } catch (fallbackErr) {
            console.warn("Backend publish API unreachable:", fallbackErr.message);
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

async function loadSchedulesFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, SCHEDULES_COLLECTION));
        return snapshot.docs.map(document => {
            const data = document.data();

            return {
                id: document.id,
                name: data.name || "",
                section: data.section || "",
                originalSection: data.originalSection || null,
                setName: data.setName || null,
                scheduleGroupId: data.scheduleGroupId || null,
                sharedScheduleId: data.sharedScheduleId || null,
                isSplit: Boolean(data.isSplit),
                subjectClassifications: data.subjectClassifications || null,
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
    if (!roomType) return "";
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

function specialistMajorForRoomType(roomType) {
    const type = normalizeRoomType(roomType);
    const match = type.match(/^(MT|AT|CP|CT|ELT|ELX|FSM|CPT) Laboratory$/);
    return match ? match[1] : "";
}

/* Major classes may use a free lecture/AVR room. Specialist laboratories are
   reserved for their matching major, preventing BIT/BINDTECH from being put
   in a BTVTED-major laboratory. */
function isRoomUsableForRequirement(room, requiredRoomType) {
    const type = normalizeRoomType(room?.roomType);
    const expected = normalizeRoomType(requiredRoomType);
    const roomName = room?.roomName || room?.roomCode || "";

    if (expected === "Gymnasium") return type === "Gymnasium" || isActivityGymOrCourtRoom(roomName);
    if (expected === "Lecture Room") {
        return !isLabRoomType(type) && type !== "Gymnasium" && !isActivityGymOrCourtRoom(roomName);
    }
    if (!isLabRoomType(expected)) return false;
    if (!isLabRoomType(type)) return type !== "Gymnasium" && !isActivityGymOrCourtRoom(roomName);
    const specialist = specialistMajorForRoomType(type);
    return !specialist || specialist === specialistMajorForRoomType(expected);
}

function isRoomAvailableForScheduling(room) {
    const status = String(room?.status || "AVAILABLE").trim().toUpperCase();
    return status !== "MAINTENANCE" && status !== "UNAVAILABLE" && status !== "INACTIVE";
}

/**
 * Determines the required room type for a subject meeting slot.
 * slotIdx: 0 for Meeting 1 (Lecture Room for 2-meeting major subjects),
 *          1 for Meeting 2 (Laboratory for 2-meeting major subjects).
 */
function getSubjectRequiredRoomTypeForSlot(subject, slotIdx = 0) {
    if (!subject) return "Lecture Room";

    const isAct = isActivityEntry(subject) ||
        String(subject.meetingType || "").toLowerCase() === "activity" ||
        String(subject.requiredRoomType || "").toLowerCase().includes("gym") ||
        isActivityGymOrCourtRoom(subject.room);
    if (isAct) return "Gymnasium";

    let reqRoom = subject.requiredRoomType || "";
    let meetType = subject.meetingType || "";
    let subType = subject.subjectType || "";

    // If missing from subject object, lookup in allLoadedSubjects / currentSplitContext
    if (!reqRoom || !meetType || !subType) {
        const subCode = String(subject.code || subject.subjectCode || "").trim().toUpperCase();
        const matches = (allLoadedSubjects || []).filter(s =>
            String(s.subjectCode || s.code || "").trim().toUpperCase() === subCode
        );
        /* Course codes are reused by different programs (for example, CPT12).
           Prefer the matching subject title and curriculum identifiers before
           falling back to a code-only match, otherwise an old BINDTECH entry
           can inherit BIT's Minor/Lecture classification. */
        const subjectName = String(subject.name || subject.subjectName || "").trim().toLowerCase();
        const subjectProgram = String(subject.programCode || subject.program || "").trim().toUpperCase();
        const subjectMajor = String(subject.majorCode || subject.major || "").trim().toUpperCase();
        const found = matches.find(s =>
            subjectName && String(s.subjectName || s.name || "").trim().toLowerCase() === subjectName &&
            (!subjectProgram || String(s.programCode || s.program || "").trim().toUpperCase() === subjectProgram) &&
            (!subjectMajor || String(s.majorCode || s.major || "").trim().toUpperCase() === subjectMajor)
        ) || matches.find(s =>
            subjectProgram && subjectMajor &&
            String(s.programCode || s.program || "").trim().toUpperCase() === subjectProgram &&
            String(s.majorCode || s.major || "").trim().toUpperCase() === subjectMajor
        ) || matches.find(s =>
            subjectName && String(s.subjectName || s.name || "").trim().toLowerCase() === subjectName
        ) || matches[0];
        if (found) {
            reqRoom = reqRoom || found.requiredRoomType || "";
            meetType = meetType || found.meetingType || "";
            subType = subType || found.subjectType || "";
        }
    }

    if (!reqRoom && typeof currentSplitContext !== "undefined" && currentSplitContext?.classifications) {
        const classInfo = currentSplitContext.classifications.get(String(subject.code || subject.subjectCode || "").trim());
        if (classInfo) {
            reqRoom = classInfo.requiredRoomType || "";
            meetType = meetType || classInfo.meetingType || "";
            subType = subType || classInfo.type || "";
        }
    }

    const normReq = normalizeRoomType(reqRoom);

    // === TRUST EXPLICIT DATA FIRST ===
    // If the prospectus/entry explicitly says "Lecture Room", honour that for ALL slots.
    // Minor subjects (subjectType="Minor") with requiredRoomType="Lecture Room" must NEVER
    // be treated as lec-lab even if their day/time/room strings contain "/".
    const subTypeLower = String(subType).toLowerCase();
    const isExplicitlyMinorOrLecture =
        subTypeLower === "minor" ||
        subTypeLower === "general" ||
        (!subTypeLower && isLikelyMinorSubjectByCode(subject.code || subject.subjectCode, subject.name)) ||
        normReq === "Lecture Room";

    /* A minor/general subject never acquires a laboratory requirement merely
       because it has a second meeting.  Its curriculum data may be incomplete
       in old schedules, so the subject classification is authoritative here. */
    if (isExplicitlyMinorOrLecture) {
        return "Lecture Room";
    }

    // Multi-meeting indicator: In university curriculum, major subjects are split into:
    // Meeting 1 (Lecture) in a Lecture Room, and Meeting 2 (Laboratory) in a Laboratory facility.
    const hasMultipleMeetings = slotIdx > 0 ||
        (subject.totalSlots && subject.totalSlots >= 2) ||
        String(subject.day || "").includes("/") ||
        String(subject.time || "").includes("/") ||
        String(subject.room || "").includes("/");

    const isMajorSubject = String(subType).toLowerCase() === "major";

    const isLecLab = /lecture.*lab|lab.*lecture/i.test(String(meetType).toLowerCase()) ||
        (hasMultipleMeetings && isMajorSubject) ||
        isLabRoomType(normReq);

    if (isLecLab) {
        // Meeting 1 (slotIdx 0) is Lecture, Meeting 2 (slotIdx 1) is Laboratory
        if (slotIdx === 0) return "Lecture Room";
        return isLabRoomType(normReq) ? normReq : "Laboratory";
    }

    if (isLabRoomType(normReq)) {
        return normReq;
    }

    return "Lecture Room";
}

/**
 * Validates if a given room is compatible with the subject and meeting slot.
 */
function isRoomCompatibleForSubject(roomObjOrName, subject, slotIdx = 0) {
    if (!roomObjOrName) return false;
    const roomName = typeof roomObjOrName === "string" ? roomObjOrName.trim() : (roomObjOrName.roomName || roomObjOrName.roomCode || "").trim();
    if (!roomName || roomName.toUpperCase() === "TBA") return true;

    const rObj = typeof roomObjOrName === "object" && roomObjOrName.roomType
        ? roomObjOrName
        : (allRooms || []).find(r =>
            (r.roomName || "").trim().toLowerCase() === roomName.toLowerCase() ||
            (r.roomCode || "").trim().toLowerCase() === roomName.toLowerCase() ||
            sameRoom(r.roomName || r.roomCode, roomName)
        );

    // If no room record found and name has no keyword hint, skip the check (no reliable type data)
    const rTypeRaw = rObj ? normalizeRoomType(rObj.roomType) : (
        isActivityGymOrCourtRoom(roomName) ? "Gymnasium" :
        /lab|shop|center/i.test(roomName) ? "Laboratory" : null
    );
    // null means "unknown" — only skip compatibility check for unknown rooms on lab/lecture checks
    // (Gym check still applies if expected is Gymnasium)
    const rType = rTypeRaw !== null ? rTypeRaw : "Lecture Room";

    const expectedType = getSubjectRequiredRoomTypeForSlot(subject, slotIdx);

    if (expectedType === "Gymnasium") {
        return rType === "Gymnasium" || isActivityGymOrCourtRoom(roomName);
    }

    // If room type is unknown (not found in DB and no keyword hint), skip compatibility check
    if (rTypeRaw === null) return true;

    if (expectedType === "Lecture Room") {
        // Lecture room cannot be a laboratory or gymnasium
        if (isLabRoomType(rType) || rType === "Gymnasium" || isActivityGymOrCourtRoom(roomName) || /lab|shop|court|gym/i.test(roomName)) {
            return false;
        }
        return rType === "Lecture Room" || rType === "Avr" || (!isLabRoomType(rType) && rType !== "Gymnasium");
    }

    // Expected is Laboratory or a specific lab type (e.g. MT Laboratory, AT Laboratory, CP Laboratory, etc.)
    // A lecture/AVR room is a valid placement for a major laboratory meeting.
    // It must not be reported as an incompatibility.
    if (!isLabRoomType(rType) && rType !== "Gymnasium" && !isActivityGymOrCourtRoom(roomName)) {
        return true;
    }
    if (rType === "Laboratory" || isLabRoomType(rType) || /lab|shop|center/i.test(roomName)) {
        if (expectedType && expectedType !== "Laboratory") {
            // Exact match with specialized lab
            if (rType === expectedType) return true;
            // General multi-purpose laboratories (such as CET Shop, CET Center, Room B204) are valid technology labs
            if (rType === "Laboratory" || /lab|shop|center/i.test(roomName)) return true;
            return false;
        }
        return true;
    }

    return false;
}
/**
 * Determines whether a Lecture Room may be accepted for a subject meeting that
 * normally requires a Laboratory.
 *
 * Rule: a major subject's Laboratory meeting may be held in a Lecture Room as a
 * fallback ONLY when every laboratory compatible with the subject is already
 * fully booked by other subjects (or under maintenance/unavailable) at that
 * day and time — i.e. there is no available laboratory to move the class to.
 * If at least one compatible laboratory is still free, the strict rule applies
 * and the Lecture Room assignment remains a blocking conflict.
 *
 * @param {string} roomName - the assigned room (a Lecture Room in the fallback case)
 * @param {string} expectedType - required room type from getSubjectRequiredRoomTypeForSlot()
 * @param {string} day - slot day
 * @param {string} time - slot time range (e.g. "1:30-3:00")
 * @param {Array<{room:string, day:string, time:string}>} bookedSlots - room bookings
 *        from other saved schedules (and the schedule's own other slots)
 * @returns {boolean} true when the lecture-room fallback is allowed
 */
function canUseLectureRoomForLabSubject(roomName, expectedType, day, time, bookedSlots) {
    if (!roomName || String(roomName).trim().toUpperCase() === "TBA") return false;
    if (!day || !time) return false;

    // Only applies when the subject requires a Laboratory (general or specialized)
    if (!expectedType || !isLabRoomType(expectedType)) return false;

    const cleanRoomName = String(roomName).trim();

    // The assigned room must be a Lecture-type room (not a lab, not a gym/court venue)
    const roomObj = (allRooms || []).find(r =>
        (r.roomName || "").trim().toLowerCase() === cleanRoomName.toLowerCase() ||
        (r.roomCode || "").trim().toLowerCase() === cleanRoomName.toLowerCase() ||
        sameRoom(r.roomName || r.roomCode, cleanRoomName)
    );
    const rType = roomObj ? normalizeRoomType(roomObj.roomType) : (
        isActivityGymOrCourtRoom(cleanRoomName) ? "Gymnasium" :
        /lab|shop|center/i.test(cleanRoomName) ? "Laboratory" : "Lecture Room"
    );
    if (isLabRoomType(rType) || rType === "Gymnasium" || isActivityGymOrCourtRoom(cleanRoomName)) return false;

    const range = parseTimeRange(time);
    if (!range) return false;
    const dNorm = normalizeDayName(day).toLowerCase();

    // Collect every laboratory compatible with the expected type, mirroring
    // isRoomCompatibleForSubject(): specialized labs, general "Laboratory" rooms,
    // and rooms whose name suggests a lab/shop/center all qualify.
    const labs = (allRooms || []).filter(r => {
        const nm = (r.roomName || r.roomCode || "").trim();
        if (!nm) return false;
        // Rooms under maintenance or explicitly unavailable are NOT usable options
        if (r.status === "MAINTENANCE" || r.status === "UNAVAILABLE") return false;
        const rt = normalizeRoomType(r.roomType);
        const isLab = isLabRoomType(rt) || /lab|shop|center/i.test(nm);
        if (!isLab) return false;
        // Specialized requirement (e.g. "CPT Laboratory") is still satisfied by
        // general-purpose laboratories / lab-keyword rooms (same as compatibility check)
        if (expectedType !== "Laboratory" && rt !== expectedType && rt !== "Laboratory" && !/lab|shop|center/i.test(nm)) return false;
        return true;
    });

    // No usable laboratory exists in the system at all — allow the fallback
    if (!labs.length) return true;

    // A lab is "available" if it is not booked by any booking at this day/time
    const isLabFree = (lab) => {
        const labName = lab.roomName || lab.roomCode || "";
        return !(bookedSlots || []).some(b =>
            b.room && sameRoom(b.room, labName) &&
            normalizeDayName(b.day).toLowerCase() === dNorm &&
            timesOverlap(b.time, time)
        );
    };

    // Allow the Lecture Room fallback only when NO compatible laboratory is free
    return !labs.some(isLabFree);
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
            <td>${escapeHtml(item.faculty || "Unassigned")}</td>
        </tr>
    `).join("");
}

function getSavedBookings(academicYear, semester) {
    const targetAy = academicYear ? normalizeAyStr(academicYear) : "";
    const targetSem = semester ? normalizeSemStr(semester) : "";

    return getSavedSchedules().flatMap(schedule => {
        /* ROOM & FACULTY AVAILABILITY SCOPING:
           Only ACTIVE schedules in the SAME Academic Year AND SAME Semester
           reserve rooms & faculty. Archived schedules and schedules from other
           academic years or other semesters must NOT block availability. */
        if ((schedule.status || "active") === "archived") return [];
        if (targetAy && normalizeAyStr(schedule.academicYear) !== targetAy) return [];
        if (targetSem && normalizeSemStr(schedule.semester) !== targetSem) return [];

        if (schedule.rawEntries?.length) {
            /* Tag each booking with its source section and split group so the conflict
               validator can recognize shared class sessions and ignore false conflicts. */
            return schedule.rawEntries.map(entry => ({
                ...entry,
                faculty: entry.faculty || "",
                facultyId: entry.facultyId || "",
                facultyUid: entry.facultyUid || "",
                section: schedule.section || "",
                scheduleId: schedule.id || scheduleDocId(schedule),
                scheduleGroupId: schedule.scheduleGroupId || null,
                originalSection: schedule.originalSection || null,
                setName: schedule.setName || null,
                isSplit: Boolean(schedule.isSplit),
                sharedScheduleId: schedule.sharedScheduleId || null
            }));
        }

        return (schedule.entries || []).flatMap(entry => {
            const entryDays = String(entry.day || "").split(" / ");
            const entryTimes = String(entry.time || "").split(" / ");
            const entryRooms = String(entry.room || "").split(" / ");

            return entryDays.map((day, index) => ({
                code: entry.code || "",
                name: entry.name || "",
                day: day.trim(),
                time: (entryTimes[index] || entryTimes[0] || "").trim(),
                room: (entryRooms[index] || entryRooms[0] || "").trim(),
                faculty: entry.faculty || "",
                facultyId: entry.facultyId || "",
                facultyUid: entry.facultyUid || "",
                roomCode: "",
                section: schedule.section || "",
                scheduleId: schedule.id || scheduleDocId(schedule),
                scheduleGroupId: schedule.scheduleGroupId || null,
                originalSection: schedule.originalSection || null,
                setName: schedule.setName || null,
                isSplit: Boolean(schedule.isSplit),
                sharedScheduleId: schedule.sharedScheduleId || null
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

function isActivityGymOrCourtRoom(roomVal) {
    if (!roomVal) return false;
    const norm = String(roomVal).toLowerCase().trim();
    return /covered\s*court|court|gym|gymnasium|activity/i.test(norm);
}

/**
 * Maximum number of PATHFit/Activity sections that may simultaneously occupy
 * the Covered Court (or any Gymnasium-type room). ≤ 2 → allowed; ≥ 3 → conflict.
 */
const COVERED_COURT_MAX_SECTIONS = 2;

/**
 * After the pairwise room-conflict scan, sweep all entries to find groups of
 * PATHFit/Activity subjects sharing the same room on the same day where more
 * than COVERED_COURT_MAX_SECTIONS have overlapping time windows.
 *
 * @param {Array}  allEntries    - All discrete expanded entries to inspect.
 * @param {Array}  roomConflicts - Conflict array to push capacity violations into.
 * @param {Set}    seenKeys      - Deduplication set shared with the main scan.
 * @param {string} statusLabel   - "Generated (Internal)" | "Saved" | "Draft"
 * @returns {Array} List of allowed shared Covered Court usages (2 sections)
 */
function checkCoveredCourtCapacity(allEntries, roomConflicts, seenKeys, statusLabel) {
    const coveredCourtUsage = [];
    const seenUsageKeys = new Set();

    // Group PATHFit/Activity entries by (roomName, day)
    const groups = new Map();
    for (const entry of allEntries) {
        if (!isActivityEntry(entry) && !isActivityGymOrCourtRoom(entry.room)) continue;
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

            if (day && time && !isUnscheduledValue(day) && !isUnscheduledValue(time)) {
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
                    faculty: entry.faculty || "Unassigned",
                    facultyUid: entry.facultyUid || "",
                    facultyId: entry.facultyId || "",
                    academicYear: schedule.academicYear || "",
                    semester: schedule.semester || "",
                    scheduleGroupId: schedule.scheduleGroupId || null,
                    originalSection: schedule.originalSection || null,
                    setName: schedule.setName || null,
                    isSplit: Boolean(schedule.isSplit)
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
    const facultyConflicts = [];
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

            const isGymCourtA = isActivityGymOrCourtRoom(aRoom) || isActivityEntry(a);
            const isGymCourtB = isActivityGymOrCourtRoom(bRoom) || isActivityEntry(b);
            const bothGymCourt = isGymCourtA && isGymCourtB;

            // Paired Set A / Set B sharing the same room for a shared subject is intentional — not a conflict
            const isPairedSetSharedRoom =
                arePairedSets(a.section, b.section) &&
                a.code === b.code &&
                isSharedSubjectEntry(a);

            if (!bothGymCourt && !isPairedSetSharedRoom && aRoom && bRoom && aRoom === bRoom &&
                !isPlaceholderRoomName(aRoom) && !isPlaceholderRoomName(bRoom)) {
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

            // Check Faculty Conflict: Same faculty double-booked on same day
            if (a.faculty && b.faculty && sameFaculty(a.faculty, b.faculty)) {
                const key = `SELF_FAC_${a.day}_${a.faculty}_${a.code}_${b.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    facultyConflicts.push({
                        type: "FACULTY CONFLICT",
                        faculty: a.faculty,
                        day: a.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${a.code} (${a.time})`,
                        existingSchedule: `${b.code} (${b.time})`,
                        status: "Generated (Internal)",
                        description: `Faculty conflict: ${a.faculty} is assigned to two overlapping classes (${a.code} and ${b.code}) on ${a.day} from ${overlapTime}.`
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

            // If both belong to the same split group and have the same subject code -> shared class session
            const isSameSplitGroup = (cur.scheduleGroupId && ext.scheduleGroupId && cur.scheduleGroupId === ext.scheduleGroupId) ||
                                    (cur.originalSection && ext.originalSection && cur.originalSection === ext.originalSection);
            if (isSameSplitGroup && cur.code === ext.code) {
                continue; // Shared minor/activity session across sets is treated as one session
            }

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
            const curRoom = cur.room.trim().toLowerCase();
            const extRoom = ext.room.trim().toLowerCase();
            const isGymCourtCur = isActivityGymOrCourtRoom(curRoom) || isActivityEntry(cur);
            const isGymCourtExt = isActivityGymOrCourtRoom(extRoom) || isActivityEntry(ext);
            const bothGymCourtExt = isGymCourtCur && isGymCourtExt;

            // Paired Set A / Set B sharing the same room for a shared subject is intentional — not a conflict
            const isPairedSetSharedRoomExt =
                arePairedSets(cur.section, ext.section) &&
                cur.code === ext.code &&
                isSharedSubjectEntry(cur);

            if (!bothGymCourtExt && !isPairedSetSharedRoomExt && curRoom && extRoom && curRoom === extRoom &&
                !isPlaceholderRoomName(curRoom) && !isPlaceholderRoomName(extRoom)) {
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

            // C. Faculty Conflict with an existing schedule
            if (cur.faculty && ext.faculty && sameFaculty(cur.faculty, ext.faculty)) {
                const key = `EXT_FAC_${cur.day}_${cur.faculty}_${cur.code}_${ext.code}_${overlapTime}`;
                if (!seenConflictKeys.has(key)) {
                    seenConflictKeys.add(key);
                    facultyConflicts.push({
                        type: "FACULTY CONFLICT",
                        faculty: cur.faculty,
                        day: cur.day,
                        overlappingTime: overlapTime,
                        newSchedule: `${cur.code} — ${cur.section}`,
                        existingSchedule: `${ext.code} — ${ext.section}`,
                        status: ext.status || "Draft",
                        description: `Faculty conflict: ${cur.faculty} is already assigned to another class (${ext.section} ${ext.code}) on ${cur.day} from ${overlapTime}.`
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

    const totalConflicts = sectionConflicts.length + roomConflicts.length + facultyConflicts.length;

    return {
        totalConflicts,
        sectionConflicts,
        roomConflicts,
        facultyConflicts,
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
                            <span>Faculty conflicts</span>
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
        const facultyConflicts = analysisResult.facultyConflicts || [];
        const allConflictCards = [
            ...sectionConflicts.map(c => ({ ...c, kind: "section" })),
            ...roomConflicts.map(c => ({ ...c, kind: "room" })),
            ...facultyConflicts.map(c => ({ ...c, kind: "faculty" }))
        ];

        const cardsHtml = allConflictCards.map(c => {
            const isSec = c.kind === "section";
            const isFac = c.kind === "faculty";
            const isCap = c.type === "ROOM CAPACITY CONFLICT";
            const typeLabel = isSec
                ? "⚠ SECTION CONFLICT"
                : (isFac ? "⚠ FACULTY CONFLICT" : (isCap ? "⚠ ROOM CAPACITY CONFLICT" : "⚠ ROOM CONFLICT"));
            const typeClass = isSec ? "section-type" : (isFac ? "faculty-type" : "room-type");
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
                        ${isFac ? `
                        <div>
                            <span class="label">Faculty:</span>
                            <span class="value" style="font-weight:700; color:#1b5e20;">${escapeHtml(c.faculty || "—")}</span>
                        </div>` : `
                        <div>
                            <span class="label">Room:</span>
                            <span class="value">${escapeHtml(c.room || (isSec ? (c.section || "—") : "Covered Court"))}</span>
                        </div>`}
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
            const isGymCourtCur = isActivityGymOrCourtRoom(curRoom) || isActivityEntry(cur);
            const isGymCourtExt = isActivityGymOrCourtRoom(extRoom) || isActivityEntry(ext);
            const bothGymCourtExt = isGymCourtCur && isGymCourtExt;

            if (!bothGymCourtExt && curRoom && extRoom && curRoom === extRoom) {
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
            const isGymCourtCurD = isActivityGymOrCourtRoom(curRoomD) || isActivityEntry(cur);
            const isGymCourtExtD = isActivityGymOrCourtRoom(extRoomD) || isActivityEntry(ext);
            const bothActivityDraft = isGymCourtCurD && isGymCourtExtD;

            if (!bothActivityDraft && curRoomD && extRoomD && curRoomD === extRoomD) {
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

// Section add UI handlers (box-style modal version)
const addSectionBtn = document.getElementById("addSectionBtn");
const addSectionModal = document.getElementById("addSectionModal");
const newSectionInput = document.getElementById("newSectionInput");
const saveNewSectionBtn = document.getElementById("saveNewSectionBtn");
const cancelNewSectionBtn = document.getElementById("cancelNewSectionBtn");
const closeAddSectionModalBtn = document.getElementById("closeAddSectionModalBtn");

function openAddSectionModal() {
    const programs = selectedValues(programSelect);
    const majors = selectedValues(majorSelect);
    const yearLevels = selectedValues(yearLevelSelect);

    if (!programs.length || !majors.length || !yearLevels.length) {
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
        const newCode = newSectionInput.value.trim().toUpperCase();
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

        const programs = selectedValues(programSelect);
        const majors = selectedValues(majorSelect);
        const yearLevels = selectedValues(yearLevelSelect);
        if (!programs.length || !majors.length || !yearLevels.length) {
            showToast("Select Program, Major, and Year Level before adding a section.");
            return;
        }

        const programCode = programs[0];
        const majorCode = majors[0];
        const yearLevel = Number(yearLevels[0]);

        // Check for duplicate section code (case-insensitive)
        const exists = allSections.some(
            s => (s.sectionCode || "").trim().toLowerCase() === newCode.toLowerCase()
        );
        if (exists) {
            showToast("Section already exists.");
            return;
        }

        try {
            saveNewSectionBtn.disabled = true;
            saveNewSectionBtn.textContent = "Saving...";

            const newSecData = {
                sectionCode: newCode,
                programCode,
                majorCode,
                yearLevel,
                createdAt: serverTimestamp()
            };
            const docRef = doc(collection(db, "sections"), newCode);
            await setDoc(docRef, newSecData);

            allSections.push(newSecData);
            msdState.section.add(newCode);
            renderAllDropdowns();

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
    const semVal = semesterSelect.value;
    const semester = semVal ? Number(semVal) : null;
    const programs = selectedValues(programSelect);
    const majors = selectedValues(majorSelect);
    const yearLevels = selectedValues(yearLevelSelect).map(Number);

    subjectBody.innerHTML = "";
    subjectGroups = [];
    allLoadedSubjects = [];
    currentSubjectGroupIndex = 0;
    if (subjectsPageLabel) subjectsPageLabel.textContent = "";
    if (subjectPagination) subjectPagination.style.display = "none";
    const subjectTableHeader = document.getElementById("subjectTableHeader");
    subjectTableHeader.style.display = "";

    if (!semester || !programs.length || !majors.length || !yearLevels.length) {
        showToast("Please select Semester, Program, Major, and Year Level to load subjects.");
        return;
    }

    try {
        const subjectQuery = query(
            collection(db, "prospectus"),
            where("semester", "==", semester)
        );

        const snapshot = await getDocs(subjectQuery);

        const matchingSubjects = [];
        snapshot.forEach(docSnap => {
            const subject = docSnap.data();
            if (subject.status === "Inactive") return;
            if (subject.subjectCode && subject.subjectCode.includes("NSTP")) return;
            if (!programs.includes(subject.programCode)) return;
            if (!majors.includes(subject.majorCode)) return;
            if (!yearLevels.includes(Number(subject.yearLevel))) return;
            matchingSubjects.push({ id: docSnap.id, ...subject });
        });

        allLoadedSubjects = matchingSubjects;

        if (matchingSubjects.length === 0) {
            return;
        }

        // The permanent table header is replaced by a group-specific header
        // immediately below each PROGRAM-MAJOR-YEAR LEVEL title.
        subjectTableHeader.style.display = "none";

        // Natural sort: by programCode, majorCode, yearLevel, subjectCode
        matchingSubjects.sort((a, b) => {
            if (a.programCode !== b.programCode) return (a.programCode || "").localeCompare(b.programCode || "");
            if (a.majorCode !== b.majorCode) return (a.majorCode || "").localeCompare(b.majorCode || "");
            if (Number(a.yearLevel) !== Number(b.yearLevel)) return Number(a.yearLevel) - Number(b.yearLevel);
            return (a.subjectCode || "").localeCompare(b.subjectCode || "");
        });

        const grouped = new Map();
        matchingSubjects.forEach(subject => {
            const groupKey = `${subject.programCode || ""}-${subject.majorCode || ""}-${subject.yearLevel || ""}`;
            if (!grouped.has(groupKey)) grouped.set(groupKey, []);
            grouped.get(groupKey).push(subject);
        });
        subjectGroups = [...grouped.values()];
        currentSubjectGroupIndex = 0;
        subjectFacultySelections.clear();
        renderSubjectGroup();
    } catch (error) {
        console.error(error);
        showToast(`Could not load subjects: ${error.message}`);
    }
}

function captureSubjectFacultySelections() {
    subjectBody.querySelectorAll(".faculty-select").forEach(select => {
        const key = select.dataset.subjectKey || select.dataset.subjectCode;
        if (key && select.value) {
            subjectFacultySelections.set(key, select.value);
            if (select.dataset.subjectCode) {
                subjectFacultySelections.set(select.dataset.subjectCode, select.value);
            }
        }
    });
}

function renderSubjectGroup() {
    captureSubjectFacultySelections();
    const group = subjectGroups[currentSubjectGroupIndex] || [];
    if (!group.length) {
        subjectBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px; color:#777;">No subjects found for the selected filters.</td></tr>`;
    } else {
        const groupKey = `${group[0].programCode || ""}-${group[0].majorCode || ""}-${group[0].yearLevel || ""}`;
        subjectBody.innerHTML = `<tr class="subject-group-title-row"><th class="subject-group-title" colspan="7" style="text-align:left;">${escapeHtml(groupKey)}</th></tr>
            <tr class="subject-column-header-row"><th>Subject Code</th><th>Subject Name</th><th>Units</th><th>Lec</th><th>Lab</th><th>Hrs/Wk</th><th>Assigned Faculty</th></tr>` + group.map(subject => {
                const lecHours = Number(subject.lecHours) || 0;
                const labHours = Number(subject.labHours) || 0;
                const currentVal = subjectFacultySelections.get(getSubjectCompositeKey(subject)) || subjectFacultySelections.get(subject.subjectCode) || "";
                return `<tr data-subject-type="${escapeHtml(subject.subjectType || "")}" data-meeting-type="${escapeHtml(subject.meetingType || "")}" data-required-room-type="${escapeHtml(subject.requiredRoomType || "")}" data-program-code="${escapeHtml(subject.programCode || "")}" data-major-code="${escapeHtml(subject.majorCode || "")}" data-year-level="${escapeHtml(subject.yearLevel || "")}"><td>${escapeHtml(subject.subjectCode)}</td><td>${escapeHtml(subject.subjectName)}</td><td>${subject.units ?? 3}</td><td>${lecHours}</td><td>${labHours}</td><td>${lecHours + labHours}</td><td>${buildFacultySelectHtml(subject, currentVal)}</td></tr>`;
            }).join("");
    }
    const total = subjectGroups.length;
    if (subjectsPageLabel) subjectsPageLabel.textContent = total > 1 ? `${currentSubjectGroupIndex + 1} / ${total}` : "";
    if (subjectsPrevBtn) subjectsPrevBtn.disabled = currentSubjectGroupIndex === 0;
    if (subjectsNextBtn) subjectsNextBtn.disabled = currentSubjectGroupIndex >= total - 1;
    if (subjectPagination) subjectPagination.style.display = total > 1 ? "flex" : "none";
}

subjectsPrevBtn?.addEventListener("click", () => {
    if (currentSubjectGroupIndex > 0) { currentSubjectGroupIndex--; renderSubjectGroup(); }
});
subjectsNextBtn?.addEventListener("click", () => {
    if (currentSubjectGroupIndex < subjectGroups.length - 1) { currentSubjectGroupIndex++; renderSubjectGroup(); }
});

subjectBody?.addEventListener("change", event => {
    if (event.target && event.target.classList.contains("faculty-select")) {
        const key = event.target.dataset.subjectKey || event.target.dataset.subjectCode;
        if (key) {
            subjectFacultySelections.set(key, event.target.value);
            if (event.target.dataset.subjectCode) {
                subjectFacultySelections.set(event.target.dataset.subjectCode, event.target.value);
            }
        }
    }
});


document.querySelector(".close-modal").addEventListener("click", () => {
    modal.style.display = "none";
});

window.addEventListener("click", event => {
    if (event.target === modal) {
        modal.style.display = "none";
    }
});

document.getElementById("generateBtn").addEventListener("click", generateSchedule);

function generateForSection(section, secMeta, allSubjectRows, rooms, savedBookings, currentAcademicYear, currentSemester, suppressToast = false) {
    const timetable = {
        Monday: [],
        Tuesday: [],
        Wednesday: [],
        Thursday: [],
        Friday: []
    };

    const prog = secMeta.programCode || selectedValues(programSelect)[0] || "";
    const major = secMeta.majorCode || selectedValues(majorSelect)[0] || "";
    const yl = secMeta.yearLevel || Number(selectedValues(yearLevelSelect)[0]) || 1;

    let secSubjectRows = allSubjectRows.filter(row => {
        const rowProg = row.programCode || row.dataset?.programCode || "";
        const rowMaj = row.majorCode || row.dataset?.majorCode || "";
        const rowYl = row.yearLevel || row.dataset?.yearLevel || "";
        if (rowProg && prog && rowProg.trim().toUpperCase() !== prog.trim().toUpperCase()) return false;
        if (rowMaj && major && rowMaj.trim().toUpperCase() !== major.trim().toUpperCase()) return false;
        if (rowYl && yl && Number(rowYl) !== Number(yl)) return false;
        return true;
    });
    if (!secSubjectRows.length) {
        if (!suppressToast) {
            showToast(`No subjects found for ${section} (${prog} - ${major} Year ${yl}).`);
        }
        return null;
    }

    const subjects = secSubjectRows.map(row => {
        if (row instanceof HTMLElement || (row.querySelectorAll && typeof row.querySelectorAll === "function")) {
            const cells = row.querySelectorAll("td");
            const facultySelect = row.querySelector(".faculty-select");
            const facultyName = facultySelect ? facultySelect.value : "";
            const facultyUid = facultySelect ? facultySelect.selectedOptions[0]?.dataset?.uid || "" : "";
            const facultyId = facultySelect ? facultySelect.selectedOptions[0]?.dataset?.employeeId || "" : "";
            // needsAutoAssign = true when admin left the dropdown blank (no explicit choice)
            const needsAutoAssign = !facultyName || facultyName === "" || facultyName === "Unassigned";

            return {
                code: cells[0].textContent.trim(),
                name: cells[1].textContent.trim(),
                units: Number(cells[2].textContent),
                faculty: facultyName || "Unassigned",
                facultyUid: facultyUid || "",
                facultyId: facultyId || "",
                needsAutoAssign,
                subjectType: row.dataset.subjectType || "",
                meetingType: (row.dataset.meetingType || "").toLowerCase(),
                requiredRoomType: normalizeRoomType(
                    row.dataset.requiredRoomType || ""
                )
            };
        }

        const code = (row.subjectCode || row.code || "").trim();
        const facInfo = getFacultyForSubject(row, {
            programCode: prog,
            majorCode: major,
            yearLevel: secMeta?.yearLevel || "",
            semester: currentSemester,
            section: section
        });
        // needsAutoAssign = true when no explicit manual selection was stored
        const needsAutoAssign = !facInfo.faculty || facInfo.faculty === "Unassigned";
        return {
            code,
            name: (row.subjectName || row.name || "").trim(),
            units: Number(row.units ?? 3),
            faculty: facInfo.faculty || "Unassigned",
            facultyUid: facInfo.facultyUid || "",
            facultyId: facInfo.facultyId || "",
            needsAutoAssign,
            subjectType: row.subjectType || "",
            meetingType: (row.meetingType || "").toLowerCase(),
            requiredRoomType: normalizeRoomType(row.requiredRoomType || "")
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

    /**
     * Lunch break rule: if a class on this day ends at exactly 12:30 PM,
     * the next class must start at 1:30 PM or later.
     *
     * 12:30 PM (end) = 750 min    →  next start blocked until 1:30 PM = 810 min
     * Classes ending at any OTHER time (10:30, 11:00, 11:30, 12:00 etc.)
     * do NOT trigger this restriction — normal scheduling applies.
     */
    function violatesLunchBreak(daySchedule, proposedTime) {
        const HALF_NOON = 750; // 12:30 PM  (12 × 60 + 30)
        const LUNCH_END = 810; // 1:30 PM   (13 × 60 + 30)

        const range = parseTimeRange(proposedTime);
        if (!range) return false;

        // Only block slots that would start in the 12:30–1:29 PM window
        if (range.start < HALF_NOON || range.start >= LUNCH_END) return false;

        // Restriction only fires when a class on this day ends at exactly 12:30 PM
        return daySchedule.some(item => {
            const r = parseTimeRange(item.time);
            return r && r.end === HALF_NOON;
        });
    }

    function roomIsTaken(room, day, time, allowGymSharing = false, currentSubject = null) {
        const matchingBookings = savedBookings.filter(booking =>
            booking.day === day &&
            booking.section !== section &&
            booking.time &&
            timesOverlap(booking.time, time) &&
            (
                booking.roomCode === room.roomCode ||
                booking.room === room.roomCode ||
                booking.room === room.roomName
            ) &&
            // Paired Set A/Set B sharing the same room for a shared subject is intentional
            !(
                arePairedSets(booking.section, section) &&
                currentSubject &&
                booking.code === (currentSubject.code || "") &&
                isSharedSubjectEntry(currentSubject)
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

    /**
     * Selects the best room from available options.
     * Priority: 1) Faculty-preferred rooms first, 2) Building priority, 3) Random.
     * @param {Array}    availableRooms   - Rooms already filtered to be free & type-compatible
     * @param {string}   requiredRoomType - "Lecture Room", "Laboratory", "Gymnasium", etc.
     * @param {string}   prog             - Program code for building priority
     * @param {string[]} facPreferredRooms - Room codes/names the faculty prefers (may be empty)
     */
    function selectBestRoom(availableRooms, requiredRoomType, prog, facPreferredRooms = []) {
        if (!availableRooms || availableRooms.length === 0) return null;

        // Check if any available room is in the faculty's preferred list
        const normalizeR = r => String(r || "").trim().toLowerCase().replace(/^room\s+/i, "").replace(/[^a-z0-9]/gi, "");
        const prefSet = new Set((facPreferredRooms || []).map(normalizeR).filter(Boolean));

        const preferred = prefSet.size > 0
            ? availableRooms.filter(r =>
                prefSet.has(normalizeR(r.roomCode)) ||
                prefSet.has(normalizeR(r.roomName)) ||
                prefSet.has(normalizeR(r.id))
              )
            : [];

        if (preferred.length > 0) {
            // Faculty preference wins — pick randomly from preferred rooms (no building priority override)
            return preferred[Math.floor(Math.random() * preferred.length)];
        }

        // No preferred room available — fall back to building priority for lecture rooms
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

    function facultyIsBooked(facultyName, facultyUid, day, time, timetableInstance) {
        if (!facultyName || facultyName === "Unassigned" || facultyName === "TBA") return false;

        // 1. Check against classes scheduled in current timetableInstance
        if (timetableInstance && timetableInstance[day]) {
            const currentClash = timetableInstance[day].some(item =>
                timesOverlap(item.time, time) &&
                (
                    (item.facultyUid && facultyUid && item.facultyUid === facultyUid) ||
                    sameFaculty(item.faculty, facultyName)
                )
            );
            if (currentClash) return true;
        }

        // 2. Check against saved bookings from other sections in the same AY & Semester
        return savedBookings.some(booking =>
            booking.day === day &&
            booking.section !== section &&
            booking.time &&
            timesOverlap(booking.time, time) &&
            (
                (booking.facultyUid && facultyUid && booking.facultyUid === facultyUid) ||
                sameFaculty(booking.faculty, facultyName)
            )
        );
    }

    /**
     * Finds the best available time slot and room for a single meeting on a given day.
     */
    function findBestMeetingSlotAndRoom(
        day,
        reqRoomType,
        slots,
        timetableInstance,
        prog,
        facName = "",
        facUid = "",
        mustAvoidFac = false,
        facPreferredRooms = [],
        currentSubject = null,
        allowLabFallback = false
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

            // 2. Lunch break enforcement (non-gym slots only)
            if (reqRoomType !== "Gymnasium" && violatesLunchBreak(timetableInstance[day], time)) continue;

            // 3. Vacant gap check
            if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

            // 4. Faculty clash check (prioritise slots where faculty is free)
            const facClash = facName && facultyIsBooked(facName, facUid, day, time, timetableInstance);
            if (mustAvoidFac && facClash) continue;

            // 4. Room availability check
            // Lecture rooms are valid for major laboratory meetings.  The
            // helper still excludes a specialist lab of the wrong major.
            const availableRooms = rooms.filter(room => {
                if (!isRoomAvailableForScheduling(room)) return false;
                const typeMatches = isRoomUsableForRequirement(room, reqRoomType);
                if (!typeMatches) return false;
                return (
                    !timetableInstance[day].some(item =>
                        item.roomCode === room.roomCode && timesOverlap(item.time, time)
                    ) &&
                    !roomIsTaken(room, day, time, false, currentSubject)
                );
            });

            if (availableRooms.length === 0 && allowLabFallback && isLabRoomType(reqRoomType)) {
                /* Major meeting #2 remains a laboratory class by default.
                   A lecture room is considered only after every compatible
                   laboratory is occupied at this exact day/time, including
                   rooms reserved earlier in the schedule currently being built. */
                const inProgressBookings = (timetableInstance[day] || []).map(item => ({
                    room: item.roomCode,
                    day,
                    time: item.time
                }));
                const allLabsBooked = canUseLectureRoomForLabSubject(
                    "Lecture Room",
                    reqRoomType,
                    day,
                    time,
                    [...savedBookings, ...inProgressBookings]
                );

                if (allLabsBooked) {
                    availableRooms.push(...rooms.filter(room =>
                        isRoomAvailableForScheduling(room) &&
                        normalizeRoomType(room.roomType) === "Lecture Room" &&
                        !timetableInstance[day].some(item =>
                            item.roomCode === room.roomCode && timesOverlap(item.time, time)
                        ) &&
                        !roomIsTaken(room, day, time, false, currentSubject)
                    ));
                }
            }
            if (availableRooms.length === 0) continue;

            const room = selectBestRoom(availableRooms, reqRoomType, prog, facPreferredRooms);
            if (room) {
                return { time, room, facultyConflict: Boolean(facClash) };
            }
        }

        /* First exhaust every usable laboratory slot. Only then retry with
           the lecture-room contingency for a major's laboratory meeting. */
        if (isLabRoomType(reqRoomType) && !allowLabFallback) {
            return findBestMeetingSlotAndRoom(
                day, reqRoomType, slots, timetableInstance, prog, facName, facUid,
                mustAvoidFac, facPreferredRooms, currentSubject, true
            );
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
        const facName = subject.faculty || "";
        const facUid = subject.facultyUid || "";

        // Look up faculty room preferences for room prioritization
        const facRoomPrefs = getFacultyRoomPrefs(facUid, facName);
        const facPrefRooms = facRoomPrefs.preferredRooms;

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

        // Pass 1: try to schedule where faculty has NO conflict
        for (const [day1, day2] of candidateDayPairs) {
            const m1 = findBestMeetingSlotAndRoom(day1, reqRoomType1, slots, timetableInstance, prog, facName, facUid, true, facPrefRooms, subject);
            if (!m1) continue;

            const m2 = findBestMeetingSlotAndRoom(day2, reqRoomType2, slots, timetableInstance, prog, facName, facUid, true, facPrefRooms, subject);
            if (!m2) continue;

            if (subject.needsAutoAssign) {
                const auto = autoSelectFacultyForSubject(subject.code, [day1, day2], [m1.time, m2.time], timetableInstance);
                if (!auto) continue;
            }

            return {
                day1,
                time1: m1.time,
                room1: m1.room,
                facultyConflict: false,
                day2,
                time2: m2.time,
                room2: m2.room
            };
        }

        // Pass 2: try reversing day assignment if room types differ, still avoiding faculty conflict
        if (reqRoomType1 !== reqRoomType2) {
            for (const [day1, day2] of candidateDayPairs) {
                const m1 = findBestMeetingSlotAndRoom(day2, reqRoomType1, slots, timetableInstance, prog, facName, facUid, true, facPrefRooms, subject);
                if (!m1) continue;
                const m2 = findBestMeetingSlotAndRoom(day1, reqRoomType2, slots, timetableInstance, prog, facName, facUid, true, facPrefRooms, subject);
                if (!m2) continue;

                if (subject.needsAutoAssign) {
                    const auto = autoSelectFacultyForSubject(subject.code, [day2, day1], [m1.time, m2.time], timetableInstance);
                    if (!auto) continue;
                }

                return {
                    day1: day2,
                    time1: m1.time,
                    room1: m1.room,
                    facultyConflict: false,
                    day2: day1,
                    time2: m2.time,
                    room2: m2.room
                };
            }
        }

        // Pass 3 (Fallback): only used if faculty is unassigned and needs room assignment without clash
        if (!facName || facName === "Unassigned" || facName === "TBA") {
            for (const [day1, day2] of candidateDayPairs) {
                const m1 = findBestMeetingSlotAndRoom(day1, reqRoomType1, slots, timetableInstance, prog, "", "", true, [], subject);
                if (!m1) continue;

                const m2 = findBestMeetingSlotAndRoom(day2, reqRoomType2, slots, timetableInstance, prog, "", "", true, [], subject);
                if (!m2) continue;

                return {
                    day1,
                    time1: m1.time,
                    room1: m1.room,
                    facultyConflict: false,
                    day2,
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
        const facName = subject.faculty || "";
        const facUid = subject.facultyUid || "";

        // Look up faculty room preferences for room prioritization
        const facRoomPrefs = getFacultyRoomPrefs(facUid, facName);
        const facPrefRooms = isActivity ? [] : facRoomPrefs.preferredRooms; // Don't apply prefs for gym/activity

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

        // Pass 1: Try avoiding faculty conflict first. Pass 2: Allow slot only if faculty is unassigned
        const passes = (facName && facName !== "Unassigned" && facName !== "TBA") ? [true] : [true, false];
        for (const mustAvoidFac of passes) {
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

                    // Lunch break enforcement (skip for activity/gym subjects)
                    if (!isActivity && violatesLunchBreak(timetableInstance[day], time)) continue;

                    if (!isActivity && !isVacantGapAcceptable(timetableInstance[day], time)) continue;

                    const facClash = facName && facultyIsBooked(facName, facUid, day, time, timetableInstance);
                    if (mustAvoidFac && facClash) continue;

                    /* Gymnasium sharing: allow a SECOND section to book the same
                       gym day/time (never more than two sections per slot).
                       Sharing is enabled by default for activities on ALL days,
                       Monday-Friday. */
                    const availableRooms = rooms.filter(room => {
                        if (!isRoomAvailableForScheduling(room)) return false;
                        const typeMatches = isRoomUsableForRequirement(room, requiredRoomType);
                        if (!typeMatches) return false;
                        return (
                            !timetableInstance[day].some(item =>
                                item.roomCode === room.roomCode && timesOverlap(item.time, time)
                            ) &&
                            !roomIsTaken(room, day, time, isActivity)
                        );
                    });

                    if (availableRooms.length > 0) {
                        const room = selectBestRoom(availableRooms, requiredRoomType, prog, facPrefRooms);
                        if (room) {
                            if (subject.needsAutoAssign && mustAvoidFac) {
                                const auto = autoSelectFacultyForSubject(subject.code, [day], [time], timetableInstance);
                                if (!auto) continue;
                            }
                            return { day, time, room, facultyConflict: Boolean(facClash) };
                        }
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

                    const gym = rooms.find(r => r.roomType === "Gymnasium" && isRoomAvailableForScheduling(r));
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
            const gym = rooms.find(r => r.roomType === "Gymnasium" && isRoomAvailableForScheduling(r));
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

    /**
     * Automatically selects the best eligible faculty for a subject at the given slots.
     *
     * Selection criteria (in priority order):
     *   1. Must be eligible for this subject + curriculum/major (isFacultyEligibleForSubject)
     *   2. Must have NO schedule conflict at ANY of the required day/time pairs (facultyIsBooked)
     *   3. Among valid candidates, prefer the one with the LOWEST current teaching load
     *      (fewest saved-booking entries so far, including previously generated sections)
     *   4. Random tiebreak to avoid always assigning the same faculty first alphabetically
     *
     * @param {string}   subjectCode       - Subject code to check eligibility against
     * @param {string[]} days              - Array of days the subject will meet (e.g. ["Monday", "Wednesday"])
     * @param {string[]} times             - Parallel array of time slots for each day
     * @param {Object}   timetableInstance - Current timetable being built (inner-loop conflicts)
     * @returns {Object|null} Faculty object { uid, name, employeeId } or null if none available
     */
    function autoSelectFacultyForSubject(subjectCode, days, times, timetableInstance) {
        const criteria = {
            subjectCode,
            programCode: prog,
            majorCode:   major,
            yearLevel:   String(yl),
            semester:    currentSemester,
            section
        };

        // 1. Find all faculty who have this subject listed as a handled subject for this curriculum
        const eligible = allFacultyMembers.filter(f => {
            const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
            // Faculty with no handled subjects recorded are skipped (not eligible by default)
            return handled.length > 0 && isFacultyEligibleForSubject(handled, criteria);
        });
        if (!eligible.length) return null;

        // 2. Filter to those who are free at ALL required day/time slots
        const available = eligible.filter(f =>
            days.every((day, i) => {
                const time = times[i] !== undefined ? times[i] : (times[0] || "");
                // Skip conflict check if no real time slot (e.g. TBA subjects)
                if (!day || !time) return true;
                return !facultyIsBooked(f.name, f.uid, day, time, timetableInstance);
            })
        );
        if (!available.length) return null;

        // 3. Count current load from savedBookings (cumulative across already-generated sections)
        const getLoad = f => savedBookings.filter(b =>
            (b.facultyUid && b.facultyUid === f.uid) ||
            (b.facultyId && f.employeeId && b.facultyId === f.employeeId) ||
            sameFaculty(b.faculty, f.name)
        ).length;

        // 4. Sort: fewest load first, random tiebreak for fair distribution
        available.sort((a, b) => {
            const diff = getLoad(a) - getLoad(b);
            return diff !== 0 ? diff : (Math.random() - 0.5);
        });

        return available[0];
    }

    const nonTbaSubjects = subjects.filter(s => !TBA_SUBJECT_CODES.has(s.code));

    if (nonTbaSubjects.length === 0) {
        // All subjects are non-classroom / internship / practicum courses (e.g. 4th year OJT/SIP/PED11/TCC01).
        // No room or time slots need to be scheduled by the physical solver.
        scheduleSuccess = true;
        finalOutput = [];
    } else {
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
            const isResearch = isResearchSubject(subject.code, subject.name, subject.subjectType);
            // Minor/general subjects always use Lecture Room regardless of stored requiredRoomType
            const isMinor = !isMajor && !isActivity && !isResearch &&
                (subject.subjectType.toLowerCase() === "minor" ||
                 subject.subjectType.toLowerCase() === "general" ||
                 isLikelyMinorSubjectByCode(subject.code, subject.name));

            const slots = isResearch
                ? majorSlots
                : isActivity
                    ? activitySlots
                    : (isLectureLab || isMajor ? majorSlots : minorSlots);

            const meetings = isResearch
                ? [subject.requiredRoomType]
                : isActivity
                    ? ["Gymnasium"]
                    : isMinor
                        ? ["Lecture Room", "Lecture Room"]
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

                let finalFaculty, finalFacultyUid, finalFacultyId;

                if (subject.needsAutoAssign) {
                    // No manual selection — auto-pick an eligible, conflict-free, least-loaded faculty
                    const auto = autoSelectFacultyForSubject(
                        subject.code,
                        [result.day1, result.day2],
                        [result.time1, result.time2],
                        timetableInstance
                    );
                    finalFaculty    = auto ? auto.name              : "Unassigned";
                    finalFacultyUid = auto ? (auto.uid || "")       : "";
                    finalFacultyId  = auto ? (auto.employeeId || "") : "";
                } else {
                    // Admin manually chose a faculty — honour that choice; only clear on real conflict
                    const clash = Boolean(result.facultyConflict) ||
                        facultyIsBooked(subject.faculty, subject.facultyUid, result.day1, result.time1, timetableInstance) ||
                        facultyIsBooked(subject.faculty, subject.facultyUid, result.day2, result.time2, timetableInstance);
                    finalFaculty    = clash ? "Unassigned" : (subject.faculty || "Unassigned");
                    finalFacultyUid = clash ? "" : (subject.facultyUid || "");
                    finalFacultyId  = clash ? "" : (subject.facultyId  || "");
                }

                timetableInstance[result.day1].push({
                    time: result.time1,
                    roomCode: result.room1.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid
                });
                timetableInstance[result.day2].push({
                    time: result.time2,
                    roomCode: result.room2.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day1,
                    time: result.time1,
                    room: result.room1.roomName || result.room1.roomCode,
                    roomCode: result.room1.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid,
                    facultyId: finalFacultyId,
                    subjectType: subject.subjectType || "",
                    meetingType: subject.meetingType || "",
                    requiredRoomType: subject.requiredRoomType || ""
                });
                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day2,
                    time: result.time2,
                    room: result.room2.roomName || result.room2.roomCode,
                    roomCode: result.room2.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid,
                    facultyId: finalFacultyId,
                    subjectType: subject.subjectType || "",
                    meetingType: subject.meetingType || "",
                    requiredRoomType: subject.requiredRoomType || ""
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

                let finalFaculty, finalFacultyUid, finalFacultyId;

                if (subject.needsAutoAssign) {
                    // No manual selection — auto-pick an eligible, conflict-free, least-loaded faculty
                    const auto = autoSelectFacultyForSubject(
                        subject.code,
                        [result.day],
                        [result.time],
                        timetableInstance
                    );
                    finalFaculty    = auto ? auto.name              : "Unassigned";
                    finalFacultyUid = auto ? (auto.uid || "")       : "";
                    finalFacultyId  = auto ? (auto.employeeId || "") : "";
                } else {
                    // Admin manually chose a faculty — honour that choice; only clear on real conflict
                    const clash = Boolean(result.facultyConflict) ||
                        facultyIsBooked(subject.faculty, subject.facultyUid, result.day, result.time, timetableInstance);
                    finalFaculty    = clash ? "Unassigned" : (subject.faculty || "Unassigned");
                    finalFacultyUid = clash ? "" : (subject.facultyUid || "");
                    finalFacultyId  = clash ? "" : (subject.facultyId  || "");
                }

                timetableInstance[result.day].push({
                    time: result.time,
                    roomCode: result.room.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day,
                    time: result.time,
                    room: result.room.roomName || result.room.roomCode,
                    roomCode: result.room.roomCode,
                    faculty: finalFaculty,
                    facultyUid: finalFacultyUid,
                    facultyId: finalFacultyId,
                    subjectType: subject.subjectType || "",
                    meetingType: subject.meetingType || "",
                    requiredRoomType: subject.requiredRoomType || ""
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
                    rooms.filter(r => isActivityGymOrCourtRoom(r.roomName || r.roomCode || r.roomType)).map(r => r.roomCode)
                );
                for (const entry of dayEntries) {
                    /* Gym / Covered Court capacity check instead of a hard single-booking rule */
                    if (gymRoomCodes.has(entry.roomCode) || isActivityGymOrCourtRoom(entry.room || entry.roomCode)) {
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

            // 4. Faculty may not be confirmed for overlapping classes.  This
            // is deliberately checked after faculty selection and room choice,
            // and covers both this generated section and already-saved sections.
            if (!attemptFailed) {
                for (let i = 0; i < currentOutput.length; i++) {
                    const entry = currentOutput[i];
                    if (!entry.faculty || entry.faculty === "Unassigned" || entry.faculty === "TBA") continue;

                    const internalClash = currentOutput.some((other, j) =>
                        j !== i && other.day === entry.day && timesOverlap(other.time, entry.time) &&
                        ((entry.facultyUid && other.facultyUid && entry.facultyUid === other.facultyUid) ||
                            sameFaculty(entry.faculty, other.faculty))
                    );
                    const savedClash = savedBookings.some(booking =>
                        booking.section !== section && booking.day === entry.day && booking.time &&
                        timesOverlap(booking.time, entry.time) &&
                        ((entry.facultyUid && booking.facultyUid && entry.facultyUid === booking.facultyUid) ||
                            sameFaculty(entry.faculty, booking.faculty))
                    );
                    if (internalClash || savedClash) {
                        attemptFailed = true;
                        lastFailureReason = `Faculty conflict: ${entry.faculty} is unavailable on ${entry.day} at ${entry.time}.`;
                        break;
                    }
                }
            }
        }

        if (!attemptFailed && currentOutput.length > 0) {
            scheduleSuccess = true;
            finalOutput = currentOutput;
            break;
        }
    }
    }

    if (!scheduleSuccess) {
        if (!suppressToast) {
            showToast(lastFailureReason || "Could not generate a complete schedule without conflicts.");
        }
        return null;
    }

    /* Append TBA subjects with no room/day/time assignment.
       If admin left the faculty blank, auto-select by eligibility + load only
       (no time-slot conflict check is possible for TBA). */
    for (const subject of subjects) {
        if (!TBA_SUBJECT_CODES.has(subject.code)) continue;

        let tbaFaculty    = subject.faculty    || "Unassigned";
        let tbaFacultyUid = subject.facultyUid || "";
        let tbaFacultyId  = subject.facultyId  || "";

        if (subject.needsAutoAssign) {
            // Pass empty arrays — autoSelectFacultyForSubject skips conflict check when no day/time given
            const auto = autoSelectFacultyForSubject(subject.code, [], [], {
                Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: []
            });
            if (auto) {
                tbaFaculty    = auto.name;
                tbaFacultyUid = auto.uid || "";
                tbaFacultyId  = auto.employeeId || "";
            }
        }

        finalOutput.push({
            code: subject.code,
            name: subject.name,
            units: subject.units,
            day: "MTWThF",
            time: "7:30am-6:30pm",
            room: "TBA",
            roomCode: "",
            faculty: tbaFaculty,
            facultyUid: tbaFacultyUid,
            facultyId: tbaFacultyId
        });
    }

    const aggregatedSchedule = [
        ...finalOutput.reduce((map, item) => {
            if (!map.has(item.code)) {
                map.set(item.code, {
                    code: item.code,
                    name: item.name,
                    units: item.units,
                    programCode: prog,
                    majorCode: major,
                    subjectType: item.subjectType || "",
                    meetingType: item.meetingType || "",
                    requiredRoomType: item.requiredRoomType || "",
                    days: [],
                    times: [],
                    rooms: [],
                    faculty: item.faculty || "Unassigned",
                    facultyUid: item.facultyUid || "",
                    facultyId: item.facultyId || ""
                });
            }

            const entry = map.get(item.code);

            entry.days.push(item.day);
            entry.times.push(item.time);
            entry.rooms.push(item.room);
            entry.faculty = item.faculty || entry.faculty || "Unassigned";
            entry.facultyUid = item.facultyUid || entry.facultyUid || "";
            entry.facultyId = item.facultyId || entry.facultyId || "";
            // Keep curriculum metadata on the display/saved row.  Without it,
            // later validation can mistake a minor's second lecture session for
            // the laboratory half of a major subject with the same code.
            entry.subjectType = item.subjectType || entry.subjectType || "";
            entry.meetingType = item.meetingType || entry.meetingType || "";
            entry.requiredRoomType = item.requiredRoomType || entry.requiredRoomType || "";

            return map;
        }, new Map()).values()
    ].map(item => ({
        code: item.code,
        name: item.name,
        units: item.units,
        programCode: item.programCode || prog,
        majorCode: item.majorCode || major,
        subjectType: item.subjectType || "",
        meetingType: item.meetingType || "",
        requiredRoomType: item.requiredRoomType || "",
        day: item.days.join(" / "),
        time: item.times.join(" / "),
        room: item.rooms.join(" / "),
        faculty: item.faculty || "Unassigned",
        facultyUid: item.facultyUid || "",
        facultyId: item.facultyId || ""
    }));

    finalOutput.forEach(item => {
        // Exclude TBA / placeholder rows ("-", "- / -", blank...) — subjects without an
        // assigned schedule (e.g. unassigned faculty) must not reserve rooms or blocks.
        if (!isUnscheduledValue(item.day) && !isUnscheduledValue(item.time) && !isUnscheduledValue(item.room) && item.day !== "MTWThF" && !TBA_SUBJECT_CODES.has(item.code)) {
            savedBookings.push({
                section,
                academicYear: currentAcademicYear,
                semester: currentSemester,
                day: item.day,
                time: item.time,
                room: item.room,
                roomCode: item.roomCode || item.room,
                faculty: item.faculty,
                facultyUid: item.facultyUid,
                facultyId: item.facultyId
            });
        }
    });

    return {
        id: crypto.randomUUID(),
        name: `${section}`,
        section,
        academicYear: currentAcademicYear,
        semester: currentSemester,
        program: prog,
        major: major,
        yearLevel: formatYearLevelText(yl),
        createdAt: new Date().toISOString(),
        entries: aggregatedSchedule,
        rawEntries: finalOutput
    };
}

async function renderCurrentGeneratedSection() {
    if (!currentGeneratedSchedules.length) return;
    const count = currentGeneratedSchedules.length;
    const idx = currentGeneratedSectionIndex;
    const schedule = currentGeneratedSchedules[idx];
    generatedSchedule = schedule;

    scheduleBody.innerHTML = scheduleRows(schedule.entries);

    const mainTitle = document.getElementById("generatedModalMainTitle");
    const subtitle = document.getElementById("generatedModalSubtitle");
    const sectionNav = document.getElementById("generatedSectionNav");
    const sectionCounter = document.getElementById("generatedSectionCounter");
    const prevBtn = document.getElementById("prevGeneratedSectionBtn");
    const nextBtn = document.getElementById("nextGeneratedSectionBtn");

    if (mainTitle) {
        mainTitle.textContent = count > 1 ? `Generated Schedule: ${schedule.section}` : "Generated Schedule";
    }
    if (subtitle) {
        subtitle.style.display = "block";
        subtitle.textContent = `A.Y. ${schedule.academicYear} • ${schedule.semester} • ${schedule.yearLevel || ""}`;
    }

    if (sectionNav) {
        if (count > 1) {
            sectionNav.style.display = "flex";
            if (sectionCounter) sectionCounter.textContent = `Section ${idx + 1} of ${count}: ${schedule.section}`;
            if (prevBtn) prevBtn.disabled = (idx === 0);
            if (nextBtn) nextBtn.disabled = (idx === count - 1);
        } else {
            sectionNav.style.display = "none";
        }
    }

    if (saveScheduleBtn) {
        saveScheduleBtn.textContent = count > 1 ? "Save All Drafts" : "Save as Draft";
        saveScheduleBtn.disabled = false;
    }
    if (publishScheduleBtn) {
        publishScheduleBtn.textContent = count > 1 ? "Publish All Generated" : "Publish Schedule";
    }

    let existingSchedules = [];
    try {
        existingSchedules = await loadSchedulesFromFirestore();
    } catch (e) {
        existingSchedules = getSavedSchedules();
    }
    const otherBatch = currentGeneratedSchedules.filter((_, i) => i !== idx);
    const combinedForScanning = [...existingSchedules, ...otherBatch];
    await runConflictScanningProcess(schedule, combinedForScanning);
}

document.getElementById("prevGeneratedSectionBtn")?.addEventListener("click", () => {
    if (currentGeneratedSectionIndex > 0) {
        currentGeneratedSectionIndex--;
        renderCurrentGeneratedSection();
    }
});

document.getElementById("nextGeneratedSectionBtn")?.addEventListener("click", () => {
    if (currentGeneratedSectionIndex < currentGeneratedSchedules.length - 1) {
        currentGeneratedSectionIndex++;
        renderCurrentGeneratedSection();
    }
});

async function generateSchedule() {
    captureSubjectFacultySelections();

    const sectionCodes = selectedValues(sectionSelect);

    if (!sectionCodes.length) {
        showToast("Please select at least one Section.");
        return;
    }

    const academicYearInput = document.getElementById("academicYear");
    const currentAcademicYear = academicYearInput ? academicYearInput.value.trim() : "";
    if (!currentAcademicYear) {
        showToast("Please enter an Academic Year (e.g. 2026-2027).");
        return;
    }

    const semVal = semesterSelect.value;
    if (!semVal) {
        showToast("Please select a Semester.");
        return;
    }
    const currentSemester = semesterSelect.options[semesterSelect.selectedIndex]?.text || (semVal === "2" ? "2nd Semester" : "1st Semester");

    generatingOverlay.style.display = "flex";
    generateBtn.disabled = true;

    try {
        const sectionsToGenerate = sectionCodes.map(code => getSectionMeta(code));

        // Auto-fetch prospectus subjects if any section's subjects are missing
        const neededKeys = new Set(
            sectionsToGenerate.map(s => `${s.programCode}-${s.majorCode}-${s.yearLevel}`)
        );
        const existingKeys = new Set(
            (allLoadedSubjects || []).map(s => `${s.programCode}-${s.majorCode}-${s.yearLevel}`)
        );
        const hasMissing = [...neededKeys].some(k => !existingKeys.has(k));

        if (hasMissing || !allLoadedSubjects || !allLoadedSubjects.length) {
            try {
                const subjectQuery = query(
                    collection(db, "prospectus"),
                    where("semester", "==", Number(semVal))
                );
                const snapshot = await getDocs(subjectQuery);
                const fetched = [];
                snapshot.forEach(docSnap => {
                    const subject = docSnap.data();
                    if (subject.status === "Inactive") return;
                    if (subject.subjectCode && subject.subjectCode.includes("NSTP")) return;
                    const key = `${subject.programCode}-${subject.majorCode}-${subject.yearLevel}`;
                    if (neededKeys.has(key)) {
                        fetched.push({ id: docSnap.id, ...subject });
                    }
                });

                if (fetched.length > 0) {
                    const getSubjectKey = s => s.id ? s.id : `${s.programCode || ""}-${s.majorCode || ""}-${s.yearLevel || ""}-${s.subjectCode || s.code || ""}`;
                    const existingKeys = new Set((allLoadedSubjects || []).map(getSubjectKey));
                    const newSubjects = fetched.filter(s => !existingKeys.has(getSubjectKey(s)));
                    allLoadedSubjects = [...(allLoadedSubjects || []), ...newSubjects];

                    const grouped = new Map();
                    allLoadedSubjects.forEach(subject => {
                        const groupKey = `${subject.programCode || ""}-${subject.majorCode || ""}-${subject.yearLevel || ""}`;
                        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
                        grouped.get(groupKey).push(subject);
                    });
                    subjectGroups = [...grouped.values()];
                    if (!subjectBody.querySelectorAll("tr").length) {
                        currentSubjectGroupIndex = 0;
                        renderSubjectGroup();
                    }
                }
            } catch (err) {
                console.warn("Could not auto-fetch prospectus subjects:", err);
            }
        }

        let subjectsToUse = allLoadedSubjects;
        if (!subjectsToUse || !subjectsToUse.length) {
            subjectsToUse = (subjectGroups || []).flat();
        }
        if (!subjectsToUse || !subjectsToUse.length) {
            const domRows = [...subjectBody.querySelectorAll("tr")]
                .filter(row => !row.classList.contains("subject-group-title-row") &&
                    !row.classList.contains("subject-column-header-row") &&
                    row.querySelectorAll("td").length >= 6);
            if (domRows.length) subjectsToUse = domRows;
        }

        if (!subjectsToUse || !subjectsToUse.length) {
            showToast("Please load subjects first.");
            return;
        }

        let rooms;
        try {
            const roomSnapshot = await getDocs(collection(db, "rooms"));
            rooms = roomSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            showToast(`Could not load rooms: ${error.message}`);
            return;
        }

        const runningBookings = getSavedBookings(currentAcademicYear, currentSemester);
        const generatedSchedules = [];
        const failedSections = [];
        const isBatch = sectionsToGenerate.length > 1;

        for (const secMeta of sectionsToGenerate) {
            const sched = generateForSection(
                secMeta.sectionCode,
                secMeta,
                subjectsToUse,
                rooms,
                runningBookings,
                currentAcademicYear,
                currentSemester,
                isBatch
            );

            if (sched) {
                generatedSchedules.push(sched);
            } else {
                failedSections.push(secMeta.sectionCode);
            }
        }

        if (!generatedSchedules.length) {
            showToast("Could not generate schedule. Please check the loaded subjects and rooms.");
            return;
        }

        currentGeneratedSchedules = generatedSchedules;
        currentGeneratedSectionIndex = 0;
        generatedSchedule = currentGeneratedSchedules[0];

        modal.style.display = "block";
        await renderCurrentGeneratedSection();

        if (failedSections.length > 0) {
            showToast(`Generated ${generatedSchedules.length} schedule(s). Unable to generate: ${failedSections.join(", ")}.`);
        }

    } catch (err) {
        console.error("Generation error:", err);
        showToast(`Generation error: ${err.message}`);
    } finally {
        generatingOverlay.style.display = "none";
        generateBtn.disabled = false;
    }
}

saveScheduleBtn.addEventListener("click", async () => {
    if (!generatedSchedule || saveScheduleBtn.disabled) return;

    const schedulesToSave = currentGeneratedSchedules.length > 0 ? currentGeneratedSchedules : [generatedSchedule];
    const isBatch = schedulesToSave.length > 1;

    const setButtonLoading = () => {
        saveScheduleBtn.disabled = true;
        saveScheduleBtn.classList.add("loading");
        saveScheduleBtn.innerHTML = `<span class="btn-spinner"></span> ${isBatch ? 'Saving All...' : 'Saving...'}`;
    };

    const resetButtonState = () => {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.classList.remove("loading");
        saveScheduleBtn.innerHTML = isBatch ? 'Save All Drafts' : 'Save as Draft';
    };

    const triggerButtonShake = () => {
        saveScheduleBtn.classList.add("btn-shake");
        setTimeout(() => saveScheduleBtn.classList.remove("btn-shake"), 450);
    };

    setButtonLoading();

    try {
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        let schedules = [...firestoreSchedules];

        const existingSections = [];
        for (const gen of schedulesToSave) {
            const exists = schedules.some(schedule =>
                (schedule.section || "").trim().toLowerCase() === (gen.section || "").trim().toLowerCase() &&
                (schedule.academicYear || "").trim() === (gen.academicYear || "").trim() &&
                (schedule.semester || "").trim().toLowerCase() === (gen.semester || "").trim().toLowerCase()
            );
            if (exists) existingSections.push(gen.section);
        }

        if (existingSections.length > 0) {
            resetButtonState();
            const confirmed = await showConfirm(
                existingSections.length === 1
                    ? `A schedule for ${existingSections[0]} already exists for A.Y. ${schedulesToSave[0].academicYear}, ${schedulesToSave[0].semester}. Replace it?`
                    : `Schedules for ${existingSections.join(", ")} already exist for A.Y. ${schedulesToSave[0].academicYear}, ${schedulesToSave[0].semester}. Replace them?`
            );
            if (!confirmed) {
                return;
            }
            setButtonLoading();
        }

        for (const gen of schedulesToSave) {
            const docId = scheduleDocId(gen);
            gen.id = docId;
            gen.status = "draft";

            schedules = schedules.filter(s =>
                s.id !== docId && !(
                    (s.section || "").trim().toLowerCase() === (gen.section || "").trim().toLowerCase() &&
                    (s.academicYear || "").trim() === (gen.academicYear || "").trim() &&
                    (s.semester || "").trim().toLowerCase() === (gen.semester || "").trim().toLowerCase()
                )
            );
            schedules.unshift(gen);
            await saveScheduleToFirestore(gen);
            console.log("Schedule saved to Firestore:", gen.name);
        }

        setSavedSchedules(schedules);
        renderSavedSchedules();
        if (typeof renderArchive === "function") renderArchive();

        const modalContent = modal.querySelector(".modal-content");
        if (modalContent) modalContent.classList.add("scale-down");
        modal.classList.add("fade-out");

        setTimeout(() => {
            modal.style.display = "none";
            modal.classList.remove("fade-out");
            if (modalContent) modalContent.classList.remove("scale-down");
            resetButtonState();
        }, 300);

        showSuccessOverlay(isBatch ? `${schedulesToSave.length} schedules saved as draft!` : "Schedule saved as draft!");

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

    const schedulesToPublish = currentGeneratedSchedules.length > 0 ? currentGeneratedSchedules : [generatedSchedule];
    const isBatch = schedulesToPublish.length > 1;

    const setLoading = () => {
        publishScheduleBtn.disabled = true;
        saveScheduleBtn.disabled = true;
        publishScheduleBtn.innerHTML = `<span class="btn-spinner"></span> ${isBatch ? 'Publishing All...' : 'Publishing...'}`;
    };
    const resetState = () => {
        publishScheduleBtn.disabled = false;
        saveScheduleBtn.disabled = false;
        publishScheduleBtn.innerHTML = isBatch ? 'Publish All Generated' : 'Publish Schedule';
    };

    setLoading();

    try {
        let totalSent = 0;
        for (const gen of schedulesToPublish) {
            const docId = scheduleDocId(gen);
            gen.id = docId;
            gen.status = "published";
            await saveScheduleToFirestore(gen);

            try {
                const result = await publishClassScheduleApi(gen);
                if (result?.sentCount) totalSent += result.sentCount;
                if (!result?.success) {
                    console.warn("Publish backend returned non-success for", gen.section, result?.message);
                }
            } catch (err) {
                console.warn("Publish failed for", gen.section, err);
            }
        }

        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        const modalContent = modal.querySelector(".modal-content");
        if (modalContent) modalContent.classList.add("scale-down");
        modal.classList.add("fade-out");
        setTimeout(() => {
            modal.style.display = "none";
            modal.classList.remove("fade-out");
            if (modalContent) modalContent.classList.remove("scale-down");
            resetState();
        }, 300);

        const sentMsg = totalSent > 0 ? ` ${totalSent} email notification(s) sent.` : "";
        showSuccessOverlay(isBatch ? `${schedulesToPublish.length} schedules published!${sentMsg}` : `Schedule published!${sentMsg}`);

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

function isScheduleSplit(schedule) {
    if (!schedule) return false;
    if (schedule.isSplit === true) return true;
    if (schedule.setName) return true;
    if (schedule.scheduleGroupId) return true;
    const secStr = String(schedule.section || "").trim();
    if (/\bset\s+[ab]\b/i.test(secStr)) return true;
    const nameStr = String(schedule.name || "").trim();
    if (/\bset\s+[ab]\b/i.test(nameStr)) return true;

    try {
        const all = getSavedSchedules();
        const hasLinkedSets = all.some(s => s.originalSection && s.originalSection.trim().toLowerCase() === secStr.toLowerCase());
        if (hasLinkedSets) return true;
    } catch (_) {}

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
                        ? `<button type="button" class="publish-schedule-card-btn" data-publish-schedule="${escapeHtml(schedule.id)}" style="background:#2e7d32;color:white;border:none;border-radius:8px;padding:10px 16px;font-weight:bold;font-size:13px;cursor:pointer;">Publish</button>`
                        : ""
                    }
                    <button type="button" class="view-calendar-btn" data-view-calendar="${escapeHtml(schedule.id)}">
                        View in Calendar
                    </button>
                    <button type="button" class="edit-schedule-btn" data-edit-schedule="${escapeHtml(schedule.id)}">
                        Edit
                    </button>
                    ${isScheduleSplit(schedule)
                        ? `<button type="button" class="manage-sets-btn" data-manage-sets="${escapeHtml(schedule.id)}">
                            Manage Sets
                        </button>`
                        : `<button type="button" class="split-sets-btn" data-split-schedule="${escapeHtml(schedule.id)}">
                            Split into Sets
                        </button>`
                    }
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
                            <th>Faculty</th>
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
        if (!entry) return;
        const entryDay = String(entry.day || "").trim();
        const entryTime = String(entry.time || "").trim();
        const entryRoom = String(entry.room || "").trim();

        // Ignore TBA subjects that have no physical room/time (e.g. OJT, Practicum, SIP, Internship)
        if (TBA_SUBJECT_CODES.has(entry.code) || entryRoom.toUpperCase() === "TBA" || entryDay.toUpperCase() === "TBA" || entryDay.toUpperCase() === "MTWTHF") {
            return;
        }

        // Ignore fully unscheduled entries — placeholder Day/Time/Room such as
        // blank, "-", "- / -", or "TBA". These are subjects whose faculty is
        // unassigned, so they were never given a class schedule. Without a real
        // day/time/room there is nothing to conflict-check, and flagging them
        // (e.g. "Invalid Time Format: '- / -'") is a false positive.
        if (isUnscheduledValue(entryDay) && isUnscheduledValue(entryTime) && isUnscheduledValue(entryRoom)) {
            return;
        }

        const days = String(entry.day || "").split(/\s*\/\s*/).filter(Boolean);
        const times = String(entry.time || "").split(/\s*\/\s*/).filter(Boolean);
        const rooms = String(entry.room || "").split(/\s*\/\s*/).filter(Boolean);

        const maxLen = Math.max(days.length, times.length, rooms.length, 1);
        for (let i = 0; i < maxLen; i++) {
            const day = days[i] || days[0] || entry.day;
            const time = times[i] || times[0] || entry.time;
            const room = rooms[i] || rooms[0] || entry.room;

            slots.push({
                rowIdx,
                slotIdx: i,
                totalSlots: maxLen,
                code: entry.code,
                name: entry.name,
                day,
                time,
                room,
                faculty: entry.faculty || "",
                facultyUid: entry.facultyUid || "",
                section: schedule.section || schedule.name || "",
                entry: {
                    ...entry,
                    totalSlots: maxLen
                }
            });
        }
    });

    const detailedConflicts = [];

    // 1. Validate time format & range
    slots.forEach(slot => {
        const range = parseTimeRange(slot.time);
        if (!range) {
            conflicts.push(`Invalid Time Format for <strong>${escapeHtml(slot.code)}</strong>: "<em>${escapeHtml(slot.time)}</em>". Please use a valid time format like <strong>7:30-9:00</strong> or <strong>7:30 AM - 9:00 AM</strong> with start time before end time.`);
            conflictRowIndices.add(slot.rowIdx);
            detailedConflicts.push({
                type: "INVALID_TIME",
                rowIdx: slot.rowIdx,
                slotIdx: slot.slotIdx,
                slot
            });
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
                detailedConflicts.push({
                    type: "SECTION_CONFLICT",
                    rowIdx: a.rowIdx,
                    slotIdx: a.slotIdx,
                    slot: a,
                    otherSlot: b
                });
                detailedConflicts.push({
                    type: "SECTION_CONFLICT",
                    rowIdx: b.rowIdx,
                    slotIdx: b.slotIdx,
                    slot: b,
                    otherSlot: a
                });
            }
        }
    }

    // 3. Check for internal room double-bookings within this section
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i];
            const b = slots[j];

            const aRoom = (a.room || "").trim();
            const bRoom = (b.room || "").trim();
            const isGym = isActivityGymOrCourtRoom(aRoom);

            if (!isGym && aRoom && bRoom && sameRoom(aRoom, bRoom) && a.day.toLowerCase() === b.day.toLowerCase() && timesOverlap(a.time, b.time)) {
                conflicts.push(`Room Double-Booking on <strong>${escapeHtml(a.day)}</strong>: Both <strong>${escapeHtml(a.code)}</strong> and <strong>${escapeHtml(b.code)}</strong> are assigned to <strong>${escapeHtml(a.room)}</strong> at overlapping times.`);
                conflictRowIndices.add(a.rowIdx);
                conflictRowIndices.add(b.rowIdx);
                detailedConflicts.push({
                    type: "ROOM_CONFLICT",
                    rowIdx: a.rowIdx,
                    slotIdx: a.slotIdx,
                    slot: a,
                    otherSlot: b,
                    room: a.room
                });
                detailedConflicts.push({
                    type: "ROOM_CONFLICT",
                    rowIdx: b.rowIdx,
                    slotIdx: b.slotIdx,
                    slot: b,
                    otherSlot: a,
                    room: b.room
                });
            }
        }
    }

    // 4. Check against other saved active schedules in the same Academic Year & Semester
    const targetSection = (schedule.section || "").trim().toLowerCase();
    const origSection = (schedule.originalSection || "").trim().toLowerCase();
    const cleanTarget = targetSection.replace(/\s+set\s+[ab]$/i, "").trim();
    const schedId = schedule.id || "";
    const schedGroupId = schedule.scheduleGroupId || "";

    const otherBookings = getSavedBookings(schedule.academicYear, schedule.semester).filter(b => {
        const bSec = (b.section || "").trim().toLowerCase();
        const bOrig = (b.originalSection || "").trim().toLowerCase();
        const cleanB = bSec.replace(/\s+set\s+[ab]$/i, "").trim();

        // 1. Exclude the exact same section
        if (bSec === targetSection) return false;

        // 2. Exclude the original section being split / edited so Set A does not conflict with itself
        if (origSection && (bSec === origSection || bOrig === origSection || cleanB === origSection)) return false;
        if (cleanTarget && (cleanB === cleanTarget || bSec === cleanTarget)) return false;

        // 3. Exclude by document ID or schedule ID
        if (schedId && (b.scheduleId === schedId || b.id === schedId)) return false;

        // 4. Exclude sibling sets in the same schedule group (cross-checks handled separately)
        if (schedGroupId && b.scheduleGroupId && schedGroupId === b.scheduleGroupId) return false;

        return true;
    });

    slots.forEach(slot => {
        const roomName = (slot.room || "").trim();
        if (!roomName) return;
        const isGym = isActivityGymOrCourtRoom(roomName);

        const matching = otherBookings.filter(b => {
            // Sibling sets sharing a minor subject session are NOT a conflict (one class session)
            const isSharedSession = (slot.scheduleGroupId && b.scheduleGroupId && slot.scheduleGroupId === b.scheduleGroupId && slot.code === b.code) ||
                                    (schedule.scheduleGroupId && b.scheduleGroupId && schedule.scheduleGroupId === b.scheduleGroupId && slot.code === b.code) ||
                                    (schedule.originalSection && b.originalSection && schedule.originalSection === b.originalSection && slot.code === b.code) ||
                                    (cleanTarget && (b.section || "").toLowerCase().includes(cleanTarget) && slot.code === b.code);
            if (isSharedSession) return false;

            return sameRoom(b.room, slot.room) &&
                (b.day || "").trim().toLowerCase() === slot.day.trim().toLowerCase() &&
                timesOverlap(b.time, slot.time);
        });

        if (isGym) {
            // Activity / Gymnasium / Covered Court allows up to 2 simultaneous sections
            if (matching.length >= 2) {
                const bookedSections = [...new Set(matching.map(b => b.section || "Another section"))].join(", ");
                conflicts.push(`Capacity Exceeded in ${escapeHtml(slot.room)} on <strong>${escapeHtml(slot.day)}</strong> (${escapeHtml(slot.time)}): Already booked by 2 sections (<strong>${escapeHtml(bookedSections)}</strong>).`);
                conflictRowIndices.add(slot.rowIdx);
                detailedConflicts.push({
                    type: "ROOM_CONFLICT",
                    rowIdx: slot.rowIdx,
                    slotIdx: slot.slotIdx,
                    slot,
                    room: slot.room,
                    bookedBy: bookedSections
                });
            }
        } else if (matching.length > 0) {
            const bookedSections = [...new Set(matching.map(b => b.section || "Another section"))].join(", ");
            conflicts.push(`Room Conflict on <strong>${escapeHtml(slot.day)}</strong>: <strong>${escapeHtml(slot.room)}</strong> is already booked by <strong>${escapeHtml(bookedSections)}</strong> during <strong>${escapeHtml(slot.time)}</strong> (for ${escapeHtml(slot.code)}).`);
            conflictRowIndices.add(slot.rowIdx);
            detailedConflicts.push({
                type: "ROOM_CONFLICT",
                rowIdx: slot.rowIdx,
                slotIdx: slot.slotIdx,
                slot,
                room: slot.room,
                bookedBy: bookedSections
            });
        }
    });

    // 5. Check for internal faculty double-bookings within this section
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i];
            const b = slots[j];
            if (a.faculty && b.faculty && sameFaculty(a.faculty, b.faculty) && a.day.toLowerCase() === b.day.toLowerCase() && timesOverlap(a.time, b.time)) {
                conflicts.push(`Faculty Conflict on <strong>${escapeHtml(a.day)}</strong>: <strong>${escapeHtml(a.faculty)}</strong> is assigned to two overlapping classes (<strong>${escapeHtml(a.code)}</strong> and <strong>${escapeHtml(b.code)}</strong>).`);
                conflictRowIndices.add(a.rowIdx);
                conflictRowIndices.add(b.rowIdx);
                detailedConflicts.push({
                    type: "FACULTY_CONFLICT",
                    rowIdx: a.rowIdx,
                    slotIdx: a.slotIdx,
                    slot: a,
                    otherSlot: b,
                    faculty: a.faculty
                });
                detailedConflicts.push({
                    type: "FACULTY_CONFLICT",
                    rowIdx: b.rowIdx,
                    slotIdx: b.slotIdx,
                    slot: b,
                    otherSlot: a,
                    faculty: b.faculty
                });
            }
        }
    }

    // 6. Check against other saved active schedules for faculty overlaps
    slots.forEach(slot => {
        if (!slot.faculty || slot.faculty === "Unassigned" || slot.faculty === "TBA") return;
        const matchingFac = otherBookings.filter(b => {
            const isSharedSession = (slot.scheduleGroupId && b.scheduleGroupId && slot.scheduleGroupId === b.scheduleGroupId && slot.code === b.code) ||
                                    (schedule.scheduleGroupId && b.scheduleGroupId && schedule.scheduleGroupId === b.scheduleGroupId && slot.code === b.code) ||
                                    (schedule.originalSection && b.originalSection && schedule.originalSection === b.originalSection && slot.code === b.code) ||
                                    (cleanTarget && (b.section || "").toLowerCase().includes(cleanTarget) && slot.code === b.code);
            if (isSharedSession) return false;

            return sameFaculty(b.faculty, slot.faculty) &&
                (b.day || "").trim().toLowerCase() === slot.day.trim().toLowerCase() &&
                timesOverlap(b.time, slot.time);
        });
        if (matchingFac.length > 0) {
            const bookedSecs = [...new Set(matchingFac.map(b => `${b.section || "Another section"} (${b.code || ""})`))].join(", ");
            conflicts.push(`Faculty Conflict on <strong>${escapeHtml(slot.day)}</strong>: <strong>${escapeHtml(slot.faculty)}</strong> is already assigned to <strong>${escapeHtml(bookedSecs)}</strong> during <strong>${escapeHtml(slot.time)}</strong>.`);
            conflictRowIndices.add(slot.rowIdx);
            detailedConflicts.push({
                type: "FACULTY_CONFLICT",
                rowIdx: slot.rowIdx,
                slotIdx: slot.slotIdx,
                slot,
                faculty: slot.faculty,
                bookedBy: bookedSecs
            });
        }
    });

    // 7. Check against any explicitly provided extra bookings (e.g. Set A major schedule baseline)
    if (Array.isArray(schedule.extraBookings) && schedule.extraBookings.length > 0) {
        slots.forEach(slot => {
            const roomName = (slot.room || "").trim();
            const isGym = isActivityGymOrCourtRoom(roomName);

            schedule.extraBookings.forEach(b => {
                if (!b.day || normalizeDayName(b.day).toLowerCase() !== normalizeDayName(slot.day).toLowerCase()) return;
                if (!b.time || !timesOverlap(b.time, slot.time)) return;

                // Room collision with Set A major
                if (roomName && sameRoom(b.room, slot.room)) {
                    if (!isGym) {
                        conflicts.push(`Cross-Set Room Collision on <strong>${escapeHtml(slot.day)}</strong>: Set B <strong>${escapeHtml(slot.code)}</strong> conflicts with Set A <strong>${escapeHtml(b.code)}</strong> in room <strong>${escapeHtml(slot.room)}</strong> at ${escapeHtml(slot.time)}.`);
                        conflictRowIndices.add(slot.rowIdx);
                        detailedConflicts.push({
                            type: "ROOM_CONFLICT",
                            rowIdx: slot.rowIdx,
                            slotIdx: slot.slotIdx,
                            slot,
                            otherSlot: b,
                            room: slot.room,
                            day: slot.day,
                            time: slot.time
                        });
                    }
                }

                // Faculty collision with Set A major
                if (slot.faculty && b.faculty && sameFaculty(slot.faculty, b.faculty) && slot.faculty !== "Unassigned" && slot.faculty !== "TBA") {
                    conflicts.push(`Cross-Set Faculty Clash on <strong>${escapeHtml(slot.day)}</strong>: <strong>${escapeHtml(slot.faculty)}</strong> is assigned simultaneously to Set B <strong>${escapeHtml(slot.code)}</strong> and Set A <strong>${escapeHtml(b.code)}</strong> at overlapping times.`);
                    conflictRowIndices.add(slot.rowIdx);
                    detailedConflicts.push({
                        type: "FACULTY_CONFLICT",
                        rowIdx: slot.rowIdx,
                        slotIdx: slot.slotIdx,
                        slot,
                        otherSlot: b,
                        faculty: slot.faculty,
                        day: slot.day,
                        time: slot.time
                    });
                }
            });
        });
    }

    // 8. Validate room compatibility for each subject meeting slot
    slots.forEach(slot => {
        if (slot.room && String(slot.room).trim().toUpperCase() !== "TBA") {
            const reqExpected = getSubjectRequiredRoomTypeForSlot(slot.entry || slot, slot.slotIdx);
            if (!isRoomCompatibleForSubject(slot.room, slot.entry || slot, slot.slotIdx)) {
                /* FALLBACK ALLOWANCE:
                   A major subject's Laboratory meeting may be held in a Lecture Room
                   when every compatible laboratory is already fully booked by other
                   subjects at this day/time (no available laboratory to move to).
                   In that case the room mismatch is NOT a blocking conflict. */
                const internalBookings = slots
                    .filter(s2 => !(s2.rowIdx === slot.rowIdx && s2.slotIdx === slot.slotIdx))
                    .map(s2 => ({ room: s2.room, day: s2.day, time: s2.time }));
                if (canUseLectureRoomForLabSubject(slot.room, reqExpected, slot.day, slot.time, [...otherBookings, ...internalBookings])) {
                    return; // Lecture-room fallback accepted — no blocking conflict
                }
                conflicts.push(`Room Incompatibility on <strong>${escapeHtml(slot.day)}</strong>: Room <strong>${escapeHtml(slot.room)}</strong> is incompatible with <strong>${escapeHtml(slot.code)}</strong> (requires <strong>${escapeHtml(reqExpected)}</strong>).`);
                conflictRowIndices.add(slot.rowIdx);
                detailedConflicts.push({
                    type: "ROOM_INCOMPATIBLE",
                    rowIdx: slot.rowIdx,
                    slotIdx: slot.slotIdx,
                    slot,
                    room: slot.room,
                    expectedType: reqExpected
                });
            }
        }
    });

    return {
        isValid: conflicts.length === 0,
        conflicts: [...new Set(conflicts)],
        conflictRowIndices,
        detailedConflicts,
        slots,
        updatedEntries
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

/**
 * Normalizes day string into clean standard capitalization
 */
function normalizeDayName(d) {
    if (!d) return "";
    const clean = String(d).trim().toLowerCase();
    const map = {
        mon: "Monday", monday: "Monday",
        tue: "Tuesday", tues: "Tuesday", tuesday: "Tuesday",
        wed: "Wednesday", wednesday: "Wednesday",
        thu: "Thursday", thur: "Thursday", thurs: "Thursday", thursday: "Thursday",
        fri: "Friday", friday: "Friday"
    };
    return map[clean] || (clean.charAt(0).toUpperCase() + clean.slice(1));
}

/**
 * Checks whether a proposed single slot for rowIdx creates any conflict against:
 * 1. other rows within this edited schedule
 * 2. other saved active schedules for the same Academic Year & Semester
 */
function testProposedSlotValidity(proposedDay, proposedTime, proposedRoom, proposedFaculty, rowIdx, slotIdx, schedule, currentRows, options = {}) {
    const pDay = normalizeDayName(proposedDay);
    const pTime = proposedTime ? proposedTime.trim() : "";
    const pRoom = proposedRoom ? proposedRoom.trim() : "";
    const pFaculty = proposedFaculty ? proposedFaculty.trim() : "";

    const checkRoom = options.checkRoom !== false;
    const checkFaculty = options.checkFaculty !== false;
    const checkSection = options.checkSection !== false;

    const timeRange = parseTimeRange(pTime);
    if (!timeRange) return false;

    // Bookings from other active schedules in the same AY & Semester
    // (computed up-front so the room-compatibility fallback can consult them)
    const targetSection = (schedule.section || "").trim().toLowerCase();
    const origSection = (schedule.originalSection || "").trim().toLowerCase();
    const cleanTarget = targetSection.replace(/\s+set\s+[ab]$/i, "").trim();
    const schedId = schedule.id || "";
    const schedGroupId = schedule.scheduleGroupId || "";

    const otherBookings = getSavedBookings(schedule.academicYear, schedule.semester).filter(b => {
        const bSec = (b.section || "").trim().toLowerCase();
        const bOrig = (b.originalSection || "").trim().toLowerCase();
        const cleanB = bSec.replace(/\s+set\s+[ab]$/i, "").trim();

        if (bSec === targetSection) return false;
        if (origSection && (bSec === origSection || bOrig === origSection || cleanB === origSection)) return false;
        if (cleanTarget && (cleanB === cleanTarget || bSec === cleanTarget)) return false;
        if (schedId && (b.scheduleId === schedId || b.id === schedId)) return false;
        if (schedGroupId && b.scheduleGroupId && schedGroupId === b.scheduleGroupId) return false;
        return true;
    });

    // Check room compatibility with subject
    if (checkRoom && pRoom && pRoom !== "TBA" && currentRows && currentRows[rowIdx]) {
        if (!isRoomCompatibleForSubject(pRoom, currentRows[rowIdx], slotIdx)) {
            /* FALLBACK ALLOWANCE:
               A major subject's Laboratory meeting may be held in a Lecture Room
               when every compatible laboratory is already fully booked by other
               subjects at this day/time (no available laboratory to move to). */
            const reqExpected = getSubjectRequiredRoomTypeForSlot(currentRows[rowIdx], slotIdx);
            const internalBookings = [];
            for (let r = 0; r < currentRows.length; r++) {
                const row = currentRows[r];
                const rDays = String(row.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
                const rTimes = String(row.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
                const rRooms = String(row.room || "").split(" / ").map(rm => rm.trim()).filter(Boolean);
                const maxLen = Math.max(rDays.length, rTimes.length, rRooms.length, 1);
                for (let s = 0; s < maxLen; s++) {
                    if (r === rowIdx && s === slotIdx) continue; // Skip itself
                    internalBookings.push({
                        room: rRooms[s] || rRooms[0] || row.room,
                        day: rDays[s] || rDays[0] || row.day,
                        time: rTimes[s] || rTimes[0] || row.time
                    });
                }
            }
            if (!canUseLectureRoomForLabSubject(pRoom, reqExpected, pDay, pTime, [...otherBookings, ...internalBookings])) {
                return false;
            }
            // Lecture-room fallback accepted — continue with the remaining checks
            // (the lecture room itself must still be free, validated below)
        }
    }

    // Check against other entries in the edited schedule
    for (let r = 0; r < currentRows.length; r++) {
        const row = currentRows[r];
        const rDays = String(row.day || "").split(" / ").map(d => normalizeDayName(d)).filter(Boolean);
        const rTimes = String(row.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
        const rRooms = String(row.room || "").split(" / ").map(rm => rm.trim()).filter(Boolean);
        const maxLen = Math.max(rDays.length, rTimes.length, rRooms.length, 1);

        for (let s = 0; s < maxLen; s++) {
            if (r === rowIdx && s === slotIdx) continue; // Skip itself

            const day = rDays[s] || rDays[0] || normalizeDayName(row.day);
            const time = rTimes[s] || rTimes[0] || row.time;
            const room = rRooms[s] || rRooms[0] || row.room;
            const faculty = row.faculty || "";

            if (day.toLowerCase() === pDay.toLowerCase() && timesOverlap(time, pTime)) {
                // Section time overlap (same section has 2 classes at once)
                if (checkSection && r !== rowIdx) return false;

                // Room double-booking within this section
                const isGym = isActivityGymOrCourtRoom(pRoom);
                if (checkRoom && !isGym && pRoom && room && sameRoom(pRoom, room)) {
                    return false;
                }

                // Faculty double-booking within this section
                if (checkFaculty && pFaculty && faculty && sameFaculty(pFaculty, faculty)) {
                    return false;
                }
            }
        }
    }

    // Check against other active schedules in the same AY & Semester
    // (otherBookings was computed up-front above for the room-compatibility fallback)

    for (const b of otherBookings) {
        if (!b.day || normalizeDayName(b.day).toLowerCase() !== pDay.toLowerCase()) continue;
        if (!b.time || !timesOverlap(b.time, pTime)) continue;

        // Room conflict
        if (checkRoom) {
            const isGym = isActivityGymOrCourtRoom(pRoom);
            if (pRoom && b.room && sameRoom(pRoom, b.room)) {
                if (isGym) {
                    const count = otherBookings.filter(ob =>
                        normalizeDayName(ob.day).toLowerCase() === pDay.toLowerCase() &&
                        sameRoom(ob.room, pRoom) &&
                        timesOverlap(ob.time, pTime)
                    ).length;
                    if (count >= 2) return false;
                } else {
                    return false;
                }
            }
        }

        // Faculty conflict
        if (checkFaculty && pFaculty && b.faculty && sameFaculty(pFaculty, b.faculty)) {
            return false;
        }
    }

    // Check against any explicitly provided extra bookings (e.g. Set A major schedule baseline)
    if (Array.isArray(schedule.extraBookings)) {
        for (const b of schedule.extraBookings) {
            if (!b.day || normalizeDayName(b.day).toLowerCase() !== pDay.toLowerCase()) continue;
            if (!b.time || !timesOverlap(b.time, pTime)) continue;

            if (checkRoom) {
                const isGym = isActivityGymOrCourtRoom(pRoom);
                if (pRoom && b.room && sameRoom(pRoom, b.room)) {
                    if (!isGym) return false;
                }
            }

            if (checkFaculty && pFaculty && b.faculty && sameFaculty(pFaculty, b.faculty) && pFaculty !== "Unassigned" && pFaculty !== "TBA") {
                return false;
            }
        }
    }

    return true;
}

/**
 * Generates Conflict Resolution suggestions across four categories:
 * 1. Faculty Suggestions
 * 2. Time Slot Suggestions
 * 3. Room Suggestions
 * 4. Combined Solutions
 */
function generateConflictResolutions(validation, schedule, currentRows) {
    const { detailedConflicts, slots } = validation;
    const recommendations = {
        faculty: [],
        time: [],
        room: [],
        combined: []
    };

    if (!detailedConflicts || !detailedConflicts.length) return recommendations;

    const handledFacultyPairs = new Set();
    const handledTimeSlots = new Set();
    const handledRoomSlots = new Set();

    // 1. FACULTY SUGGESTIONS
    const facultyConflicts = detailedConflicts.filter(c => c.type === "FACULTY_CONFLICT");
    for (const fc of facultyConflicts) {
        const slot = fc.slot;
        const pairKey = `${slot.rowIdx}_${slot.slotIdx}_${slot.code}`;
        if (handledFacultyPairs.has(pairKey)) continue;
        handledFacultyPairs.add(pairKey);

        const entryCriteria = {
            subjectCode: slot.code || "",
            programCode: schedule.program || "",
            majorCode: schedule.major || "",
            yearLevel: schedule.yearLevel || "",
            semester: schedule.semester || "",
            section: schedule.section || schedule.name || ""
        };

        const eligibleFaculty = allFacultyMembers.filter(f => {
            const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
            return handled.length > 0 && isFacultyEligibleForSubject(handled, entryCriteria);
        });

        for (const candidate of eligibleFaculty) {
            if (sameFaculty(candidate.name, slot.faculty)) continue;

            const isFree = testProposedSlotValidity(
                slot.day,
                slot.time,
                slot.room,
                candidate.name,
                slot.rowIdx,
                slot.slotIdx,
                schedule,
                currentRows
            );

            if (isFree) {
                const handledList = facultyAssignmentsMap.get(candidate.uid) || facultyAssignmentsMap.get(candidate.id) || [];
                const parsedSubjects = handledList.map(h => {
                    const p = parseHandledSubject(h);
                    return p ? p.subjectCode : "";
                }).filter(Boolean);
                const qualText = parsedSubjects.length > 0
                    ? `Qualified for ${parsedSubjects.slice(0, 3).join(", ")}${parsedSubjects.length > 3 ? "..." : ""}`
                    : `Assigned handled subject`;

                recommendations.faculty.push({
                    rowIdx: slot.rowIdx,
                    slotIdx: slot.slotIdx,
                    subjectCode: slot.code,
                    subjectName: slot.name,
                    facultyName: candidate.name,
                    facultyUid: candidate.uid || "",
                    facultyEmployeeId: candidate.employeeId || "",
                    day: slot.day,
                    time: slot.time,
                    room: slot.room,
                    statusText: "Available & Eligible",
                    explanation: `${candidate.name} is qualified to teach ${slot.code} (${qualText}) and has no conflicting classes on ${slot.day} (${slot.time}).`
                });

                if (recommendations.faculty.length >= 4) break;
            }
        }
    }

    // 2. TIME SLOT SUGGESTIONS
    const timeConflicts = detailedConflicts.filter(c =>
        c.type === "SECTION_CONFLICT" || c.type === "INVALID_TIME" || c.type === "FACULTY_CONFLICT" || c.type === "ROOM_CONFLICT"
    );

    for (const tc of timeConflicts) {
        const slot = tc.slot;
        const key = `${slot.rowIdx}_${slot.slotIdx}`;
        if (handledTimeSlots.has(key)) continue;
        handledTimeSlots.add(key);

        const isActivity = isActivityEntry(slot) || isActivityGymOrCourtRoom(slot.room);
        const slotList = isActivity ? activitySlots : getCandidateTimeSlotsForDuration(slot.time);

        for (const candDay of days) {
            for (const candTime of slotList) {
                if (candDay.toLowerCase() === slot.day.toLowerCase() && candTime === slot.time) continue;

                const isAvailable = testProposedSlotValidity(
                    candDay,
                    candTime,
                    slot.room,
                    slot.faculty,
                    slot.rowIdx,
                    slot.slotIdx,
                    schedule,
                    currentRows
                );

                if (isAvailable) {
                    recommendations.time.push({
                        rowIdx: slot.rowIdx,
                        slotIdx: slot.slotIdx,
                        subjectCode: slot.code,
                        subjectName: slot.name,
                        proposedDay: candDay,
                        proposedTime: candTime,
                        room: slot.room,
                        faculty: slot.faculty,
                        statusText: "No Conflict Detected",
                        explanation: `Slot on ${candDay} at ${candTime} is free for section ${schedule.section || ""}, assigned faculty ${slot.faculty || "Faculty"}, and room ${slot.room}.`
                    });
                    if (recommendations.time.length >= 4) break;
                }
            }
            if (recommendations.time.length >= 4) break;
        }
    }

    // 3. ROOM SUGGESTIONS
    const roomConflicts = detailedConflicts.filter(c => c.type === "ROOM_CONFLICT" || c.type === "ROOM_INCOMPATIBLE");
    for (const rc of roomConflicts) {
        const slot = rc.slot;
        const key = `${slot.rowIdx}_${slot.slotIdx}`;
        if (handledRoomSlots.has(key)) continue;
        handledRoomSlots.add(key);

        const expectedType = getSubjectRequiredRoomTypeForSlot(slot.entry || slot, slot.slotIdx);
        const candidateRooms = allRooms.filter(r => {
            const rName = (r.roomName || r.roomCode || "").trim();
            if (sameRoom(rName, slot.room)) return false;
            return isRoomCompatibleForSubject(r, slot.entry || slot, slot.slotIdx);
        });

        for (const cr of candidateRooms) {
            const candRoomName = cr.roomName || cr.roomCode;
            // Test if the candidate room itself is unoccupied on this day and time
            const isRoomFree = testProposedSlotValidity(
                slot.day,
                slot.time,
                candRoomName,
                slot.faculty,
                slot.rowIdx,
                slot.slotIdx,
                schedule,
                currentRows,
                { checkFaculty: false }
            );

            if (isRoomFree) {
                const isFacFree = testProposedSlotValidity(
                    slot.day,
                    slot.time,
                    candRoomName,
                    slot.faculty,
                    slot.rowIdx,
                    slot.slotIdx,
                    schedule,
                    currentRows,
                    { checkRoom: false }
                );

                const capText = cr.capacity ? `Capacity: ${cr.capacity} seats` : "Standard capacity";
                const statusText = isFacFree ? "Unoccupied & Suitable" : "Room Unoccupied (Faculty Clash)";
                const explanation = isFacFree
                    ? `${candRoomName} (${cr.roomType || "Room"}, ${capText}) is unoccupied on ${slot.day} (${slot.time}) and accommodates section requirements.`
                    : `${candRoomName} (${cr.roomType || "Room"}) is unoccupied on ${slot.day} (${slot.time}). (Note: ${slot.faculty || "Faculty"} also has a schedule clash at this hour; consider using a Combined Solution).`;

                recommendations.room.push({
                    rowIdx: slot.rowIdx,
                    slotIdx: slot.slotIdx,
                    subjectCode: slot.code,
                    subjectName: slot.name,
                    proposedRoom: candRoomName,
                    roomType: cr.roomType || "Classroom",
                    capacity: cr.capacity || null,
                    day: slot.day,
                    time: slot.time,
                    faculty: slot.faculty,
                    statusText,
                    explanation
                });
                if (recommendations.room.length >= 4) break;
            }
        }
    }

    // 4. COMBINED SOLUTIONS
    // Find comprehensive solutions across all conflicted subjects to resolve all conflicts cleanly
    const uniqueConflictedRowIndices = [...new Set(detailedConflicts.map(c => c.rowIdx))];
    for (const targetRowIdx of uniqueConflictedRowIndices.slice(0, 3)) {
        const targetRow = currentRows[targetRowIdx];
        if (!targetRow) continue;

        const targetDays = String(targetRow.day || "").split(" / ").map(d => normalizeDayName(d)).filter(Boolean);
        const targetTimes = String(targetRow.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
        const targetRooms = String(targetRow.room || "").split(" / ").map(r => r.trim()).filter(Boolean);

        // Find which slotIdx in this row actually has the conflict
        const rowConflicts = detailedConflicts.filter(c => c.rowIdx === targetRowIdx);
        const slotIndicesToFix = [...new Set(rowConflicts.map(c => c.slotIdx !== undefined ? c.slotIdx : 0))];
        if (slotIndicesToFix.length === 0) slotIndicesToFix.push(0);

        for (const slotIdx of slotIndicesToFix) {
            const curDay = targetDays[slotIdx] || targetDays[0] || normalizeDayName(targetRow.day);
            const curTime = targetTimes[slotIdx] || targetTimes[0] || targetRow.time;
            const curRoom = targetRooms[slotIdx] || targetRooms[0] || targetRow.room;
            const curFaculty = targetRow.faculty || "Unassigned";

            const entryCriteria = {
                subjectCode: targetRow.code || "",
                programCode: schedule.program || "",
                majorCode: schedule.major || "",
                yearLevel: schedule.yearLevel || "",
                semester: schedule.semester || "",
                section: schedule.section || schedule.name || ""
            };

            const eligibleFaculty = allFacultyMembers.filter(f => {
                const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
                return handled.length > 0 && isFacultyEligibleForSubject(handled, entryCriteria);
            });

            const facultyOptions = [
                ...(curFaculty && curFaculty !== "Unassigned" ? [{ name: curFaculty, uid: targetRow.facultyUid || "" }] : []),
                ...eligibleFaculty
            ];

            const suitableRooms = allRooms.filter(r => isRoomCompatibleForSubject(r, targetRow, slotIdx));
            const roomOptions = [
                ...(curRoom && isRoomCompatibleForSubject(curRoom, targetRow, slotIdx) ? [{ roomName: curRoom }] : []),
                ...suitableRooms
            ];

            const isActivity = isActivityEntry(targetRow) || isActivityGymOrCourtRoom(curRoom);
            const slotList = isActivity ? activitySlots : getCandidateTimeSlotsForDuration(curTime);

            const rowSolutions = [];

            outerLoop:
            for (const candFac of facultyOptions) {
                for (const candDay of [curDay, ...days.filter(d => d !== curDay)]) {
                    for (const candTime of [curTime, ...slotList.filter(t => t !== curTime)]) {
                        for (const candRm of roomOptions) {
                            const rName = candRm.roomName || candRm.roomCode || "";
                            if (!rName) continue;

                            const isValid = testProposedSlotValidity(
                                candDay,
                                candTime,
                                rName,
                                candFac.name,
                                targetRowIdx,
                                slotIdx,
                                schedule,
                                currentRows
                            );

                            if (isValid) {
                                let changeCount = 0;
                                const changes = [];
                                if (candDay !== curDay || candTime !== curTime) {
                                    changeCount += (candDay !== curDay ? 1 : 0) + (candTime !== curTime ? 1 : 0);
                                    changes.push(`Schedule: ${candDay} (${candTime})`);
                                }
                                if (rName.toLowerCase() !== curRoom.toLowerCase()) {
                                    changeCount += 1;
                                    changes.push(`Room: ${rName}`);
                                }
                                if (!sameFaculty(candFac.name, curFaculty)) {
                                    changeCount += 1;
                                    changes.push(`Faculty: ${candFac.name}`);
                                }

                                if (changeCount > 0) {
                                    rowSolutions.push({
                                        rowIdx: targetRowIdx,
                                        slotIdx,
                                        subjectCode: targetRow.code,
                                        subjectName: targetRow.name,
                                        proposedDay: candDay,
                                        proposedTime: candTime,
                                        proposedRoom: rName,
                                        proposedFaculty: candFac.name,
                                        facultyUid: candFac.uid || "",
                                        changeCount,
                                        changesSummary: changes.join(" • "),
                                        statusText: "Fully Resolved (0 Conflicts)",
                                        explanation: `Adjusts ${changes.join(", ")} to eliminate all blocking conflicts while maintaining curriculum and room rules.`
                                    });

                                    if (rowSolutions.length >= 2) break outerLoop;
                                }
                            }
                        }
                    }
                }
            }

            rowSolutions.sort((a, b) => a.changeCount - b.changeCount);
            rowSolutions.forEach(sol => recommendations.combined.push(sol));
        }
    }

    return recommendations;
}

/**
 * Builds the interactive Suggested Conflict Resolutions container HTML
 */
function renderConflictResolutionsUI(recommendations) {
    const { faculty, time, room, combined } = recommendations;
    const hasAny = faculty.length > 0 || time.length > 0 || room.length > 0 || combined.length > 0;

    let html = `
        <div class="suggested-resolutions-container">
            <div class="suggested-resolutions-header">
                <h4><span>💡</span> Suggested Conflict Resolutions</h4>
                <p>Select a recommended alternative below to automatically resolve blocking scheduling conflicts.</p>
            </div>
    `;

    if (!hasAny) {
        html += `
            <div class="suggestion-empty-state">
                No automatic alternatives could resolve the current conflict. Please manually adjust the subject's day, time, room, or assigned faculty.
            </div>
        </div>`;
        return html;
    }

    // 1. Faculty Suggestions
    html += `
        <div class="suggestion-category-block">
            <div class="suggestion-category-title">
                <span>👤</span> Faculty Suggestions
            </div>
            ${faculty.length > 0 ? `
                <div class="suggestion-cards-grid">
                    ${faculty.map((f, idx) => `
                        <div class="suggestion-card">
                            <div class="suggestion-card-header">
                                <div>
                                    <span class="suggestion-card-subject-tag">${escapeHtml(f.subjectCode)}</span>
                                    <div class="suggestion-card-title">${escapeHtml(f.facultyName)}</div>
                                </div>
                                <span class="suggestion-badge-available">✓ ${escapeHtml(f.statusText)}</span>
                            </div>
                            <div class="suggestion-card-desc">${escapeHtml(f.explanation)}</div>
                            <div class="suggestion-card-meta">
                                <strong>For:</strong> ${escapeHtml(f.day)} • ${escapeHtml(f.time)} • ${escapeHtml(f.room)}
                            </div>
                            <button type="button" class="suggestion-apply-btn apply-faculty-btn"
                                data-row-idx="${f.rowIdx}"
                                data-slot-idx="${f.slotIdx}"
                                data-code="${escapeHtml(f.subjectCode)}"
                                data-faculty-name="${escapeHtml(f.facultyName)}"
                                data-faculty-uid="${escapeHtml(f.facultyUid || '')}">
                                <span>✓</span> Use This Faculty
                            </button>
                        </div>
                    `).join("")}
                </div>
            ` : `
                <div class="suggestion-empty-state">No alternative qualified faculty are currently free at this time slot.</div>
            `}
        </div>
    `;

    // 2. Time Slot Suggestions
    html += `
        <div class="suggestion-category-block">
            <div class="suggestion-category-title">
                <span>🕒</span> Time Slot Suggestions
            </div>
            ${time.length > 0 ? `
                <div class="suggestion-cards-grid">
                    ${time.map((t, idx) => `
                        <div class="suggestion-card">
                            <div class="suggestion-card-header">
                                <div>
                                    <span class="suggestion-card-subject-tag">${escapeHtml(t.subjectCode)}</span>
                                    <div class="suggestion-card-title">${escapeHtml(t.proposedDay)} • ${escapeHtml(t.proposedTime)}</div>
                                </div>
                                <span class="suggestion-badge-available">✓ ${escapeHtml(t.statusText)}</span>
                            </div>
                            <div class="suggestion-card-desc">${escapeHtml(t.explanation)}</div>
                            <div class="suggestion-card-meta">
                                <strong>Room & Faculty:</strong> ${escapeHtml(t.room)} • ${escapeHtml(t.faculty || "Unassigned")}
                            </div>
                            <button type="button" class="suggestion-apply-btn apply-time-btn"
                                data-row-idx="${t.rowIdx}"
                                data-slot-idx="${t.slotIdx}"
                                data-code="${escapeHtml(t.subjectCode)}"
                                data-day="${escapeHtml(t.proposedDay)}"
                                data-time="${escapeHtml(t.proposedTime)}">
                                <span>📅</span> Apply This Time
                            </button>
                        </div>
                    `).join("")}
                </div>
            ` : `
                <div class="suggestion-empty-state">No alternative vacant time slots found for the current room and faculty.</div>
            `}
        </div>
    `;

    // 3. Room Suggestions
    html += `
        <div class="suggestion-category-block">
            <div class="suggestion-category-title">
                <span>🏫</span> Room Suggestions
            </div>
            ${room.length > 0 ? `
                <div class="suggestion-cards-grid">
                    ${room.map((r, idx) => `
                        <div class="suggestion-card">
                            <div class="suggestion-card-header">
                                <div>
                                    <span class="suggestion-card-subject-tag">${escapeHtml(r.subjectCode)}</span>
                                    <div class="suggestion-card-title">${escapeHtml(r.proposedRoom)}</div>
                                </div>
                                <span class="suggestion-badge-available">✓ ${escapeHtml(r.statusText)}</span>
                            </div>
                            <div class="suggestion-card-desc">${escapeHtml(r.explanation)}</div>
                            <div class="suggestion-card-meta">
                                <strong>Time:</strong> ${escapeHtml(r.day)} • ${escapeHtml(r.time)}
                            </div>
                            <button type="button" class="suggestion-apply-btn apply-room-btn"
                                data-row-idx="${r.rowIdx}"
                                data-slot-idx="${r.slotIdx}"
                                data-code="${escapeHtml(r.subjectCode)}"
                                data-room="${escapeHtml(r.proposedRoom)}">
                                <span>🏫</span> Apply This Room
                            </button>
                        </div>
                    `).join("")}
                </div>
            ` : `
                <div class="suggestion-empty-state">No other suitable rooms type are vacant on this day and time.</div>
            `}
        </div>
    `;

    // 4. Combined Solution
    html += `
        <div class="suggestion-category-block">
            <div class="suggestion-category-title">
                <span>⚡</span> Combined Solution
            </div>
            ${combined.length > 0 ? `
                <div class="suggestion-cards-grid">
                    ${combined.map((c, idx) => `
                        <div class="suggestion-card" style="border-color:#2e7d32; background:#f4f9f4;">
                            <div class="suggestion-card-header">
                                <div>
                                    <span class="suggestion-card-subject-tag">${escapeHtml(c.subjectCode)}</span>
                                    <div class="suggestion-card-title">${escapeHtml(c.proposedDay)} ${escapeHtml(c.proposedTime)} — ${escapeHtml(c.proposedRoom)}</div>
                                </div>
                                <span class="suggestion-badge-available">★ ${escapeHtml(c.statusText)}</span>
                            </div>
                            <div class="suggestion-card-desc">${escapeHtml(c.explanation)}</div>
                            <div class="suggestion-card-meta" style="background:#e8f5e9;">
                                <strong>Will Update:</strong> ${escapeHtml(c.changesSummary)}<br>
                                <strong>Assigned Faculty:</strong> ${escapeHtml(c.proposedFaculty || "Unassigned")}
                            </div>
                            <button type="button" class="suggestion-apply-btn combined-btn apply-combined-btn"
                                data-row-idx="${c.rowIdx}"
                                data-slot-idx="${c.slotIdx}"
                                data-code="${escapeHtml(c.subjectCode)}"
                                data-day="${escapeHtml(c.proposedDay)}"
                                data-time="${escapeHtml(c.proposedTime)}"
                                data-room="${escapeHtml(c.proposedRoom)}"
                                data-faculty-name="${escapeHtml(c.proposedFaculty)}"
                                data-faculty-uid="${escapeHtml(c.facultyUid || '')}">
                                <span>⚡</span> Apply This Combination
                            </button>
                        </div>
                    `).join("")}
                </div>
            ` : `
                <div class="suggestion-empty-state">No multi-attribute combined recommendation found. Try applying an individual suggestion above.</div>
            `}
        </div>
    `;

    html += `</div>`;
    return html;
}

/**
 * Re-reads values from the Edit Class Schedule modal table rows
 */
function readCurrentEditScheduleRows() {
    if (!editScheduleTableBody) return [];
    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === currentEditingScheduleId || scheduleDocId(item) === currentEditingScheduleId);
    const originalEntries = schedule?.entries || [];

    const rows = editScheduleTableBody.querySelectorAll("tr");
    const currentRows = [];

    rows.forEach((row, idx) => {
        const orig = originalEntries[idx] || {};
        const code = (row.querySelector(".edit-code-input")?.value || orig.code || "").trim();
        const name = (row.querySelector(".edit-name-input")?.value || orig.name || "").trim();
        const units = (row.querySelector(".edit-units-input")?.value || orig.units || "").trim();
        const day = (row.querySelector(".edit-day-input")?.value || "").trim();
        const time = (row.querySelector(".edit-time-input")?.value || "").trim();
        const room = (row.querySelector(".edit-room-input")?.value || "").trim();
        const facultySelect = row.querySelector(".edit-faculty-select");
        const faculty = (facultySelect?.value || "").trim();
        const facultyUid = (facultySelect?.selectedOptions[0]?.dataset?.uid || orig.facultyUid || "").trim();
        const facultyId = (facultySelect?.selectedOptions[0]?.dataset?.employeeId || orig.facultyId || "").trim();

        const row_entry = {
            ...orig,
            rowIdx: idx,
            code,
            name,
            units: Number(units) || units,
            day,
            time,
            room,
            faculty: faculty || "Unassigned",
            facultyUid,
            facultyId
        };

        // If the saved entry is missing subject metadata (older schedules generated before the fix),
        // look up the prospectus data from allLoadedSubjects to fill in subjectType, meetingType,
        // and requiredRoomType. This prevents validation from wrongly treating subjects like TIC02
        // (a minor subject not caught by code-prefix heuristics) as major lec-lab subjects.
        if (!row_entry.subjectType || !row_entry.requiredRoomType) {
            const codeUpper = code.trim().toUpperCase();
            const found = (allLoadedSubjects || []).find(s =>
                String(s.subjectCode || s.code || "").trim().toUpperCase() === codeUpper
            );
            if (found) {
                if (!row_entry.subjectType)    row_entry.subjectType    = found.subjectType    || "";
                if (!row_entry.meetingType)    row_entry.meetingType    = found.meetingType    || "";
                if (!row_entry.requiredRoomType) row_entry.requiredRoomType = found.requiredRoomType || "";
            }
        }

        currentRows.push(row_entry);
    });

    return currentRows;
}

/**
 * Reruns conflict detection on the current modal inputs and updates warnings + suggestions
 */
function runLiveEditConflictCheck() {
    if (!currentEditingScheduleId) return;

    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === currentEditingScheduleId || scheduleDocId(item) === currentEditingScheduleId);
    if (!schedule) return;

    const currentRows = readCurrentEditScheduleRows();
    const rows = editScheduleTableBody ? editScheduleTableBody.querySelectorAll("tr") : [];

    const validation = validateScheduleEdits(currentRows, schedule);

    if (validation.isValid) {
        clearEditScheduleConflicts();
        return;
    }

    // Highlight conflicting rows
    rows.forEach((row, idx) => {
        if (validation.conflictRowIndices.has(idx)) {
            row.classList.add("has-conflict");
        } else {
            row.classList.remove("has-conflict");
        }
    });

    // Generate recommendations
    const recommendations = generateConflictResolutions(validation, schedule, currentRows);
    const resolutionsHtml = renderConflictResolutionsUI(recommendations);

    if (editScheduleConflicts) {
        editScheduleConflicts.innerHTML = `
            <div class="edit-conflict-banner">
                <h4>⚠️ Scheduling Conflicts Detected (${validation.conflicts.length})</h4>
                <ul class="edit-conflict-list">
                    ${validation.conflicts.map(c => `<li>${c}</li>`).join("")}
                </ul>
                <p style="margin:8px 0 0 0; font-size:12px; opacity:0.9;">Please resolve the conflicts above before saving changes.</p>
            </div>
            ${resolutionsHtml}
        `;
        editScheduleConflicts.style.display = "block";
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

    // Ensure allLoadedSubjects contains subjects for this schedule's curriculum so
    // validation can look up subjectType / requiredRoomType for any subject code.
    // We merge rather than replace so the currently loaded section's data is preserved.
    (async () => {
        try {
            const prog = schedule.program || schedule.programCode || "";
            const major = schedule.major || schedule.majorCode || "";
            const yl = schedule.yearLevel || "";
            const sem = schedule.semester || "";
            if (prog) {
                const snap = await getDocs(collection(db, "prospectus"));
                const matchingSubjects = [];
                snap.docs.forEach(docSnap => {
                    const d = docSnap.data();
                    if (
                        String(d.programCode || "").trim().toUpperCase() === prog.trim().toUpperCase() &&
                        (!major || String(d.majorCode || "").trim().toUpperCase() === major.trim().toUpperCase()) &&
                        (!yl || String(d.yearLevel || "").trim() === String(yl).trim()) &&
                        (!sem || normalizeSemStr(d.semester) === normalizeSemStr(sem))
                    ) {
                        matchingSubjects.push(d);
                    }
                });
                if (matchingSubjects.length > 0) {
                    // Merge: add any subject codes not already in allLoadedSubjects
                    const existingCodes = new Set((allLoadedSubjects || []).map(s =>
                        String(s.subjectCode || s.code || "").trim().toUpperCase()
                    ));
                    const newSubjects = matchingSubjects.filter(s =>
                        !existingCodes.has(String(s.subjectCode || s.code || "").trim().toUpperCase())
                    );
                    allLoadedSubjects = [...(allLoadedSubjects || []), ...newSubjects];
                }
            }
        } catch (e) {
            // Non-critical — validation will fall back to heuristics
        }
        // Re-run conflict check now that allLoadedSubjects is fully populated —
        // this clears any false conflicts (e.g. minor subjects wrongly requiring Laboratory)
        if (currentEditingScheduleId) runLiveEditConflictCheck();
    })();

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
                <td>
                    <select class="edit-faculty-select" style="width:100%; padding:8px; border:1px solid #c9c1b0; border-radius:6px; font-size:13px; background:#fff;">
                        <option value="">-- Unassigned --</option>
                        ${(() => {
                            const entryCriteria = {
                                subjectCode: entry.code || "",
                                programCode: schedule.program || "",
                                majorCode: schedule.major || "",
                                yearLevel: schedule.yearLevel || "",
                                semester: schedule.semester || "",
                                section: schedule.section || schedule.name || ""
                            };
                            const eligible = allFacultyMembers.filter(f => {
                                const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
                                return isFacultyEligibleForSubject(handled, entryCriteria);
                            });
                            const list = [...eligible];
                            if (entry.faculty && !list.some(f => sameFaculty(entry.faculty, f.name) || (entry.facultyUid && entry.facultyUid === f.uid))) {
                                const currentFac = allFacultyMembers.find(f => sameFaculty(entry.faculty, f.name) || (entry.facultyUid && entry.facultyUid === f.uid));
                                if (currentFac) list.unshift(currentFac);
                            }
                            return list.map(f => `
                                <option value="${escapeHtml(f.name)}" data-uid="${escapeHtml(f.uid)}" data-employee-id="${escapeHtml(f.employeeId || '')}" ${(entry.faculty && (sameFaculty(entry.faculty, f.name) || entry.facultyUid === f.uid)) ? 'selected' : ''}>
                                    ${escapeHtml(f.name)}${f.employeeId ? ' (' + escapeHtml(f.employeeId) + ')' : ''}
                                </option>
                            `).join("");
                        })()}
                    </select>
                </td>
            </tr>
        `).join("");
    }

    if (editScheduleModal) {
        editScheduleModal.style.display = "flex";
        runLiveEditConflictCheck();
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
    // Refresh conflict check and suggestions on input/change
    let editConflictDebounceTimer = null;
    const triggerLiveCheck = () => {
        if (editConflictDebounceTimer) clearTimeout(editConflictDebounceTimer);
        editConflictDebounceTimer = setTimeout(() => {
            runLiveEditConflictCheck();
        }, 250);
    };

    editScheduleTableBody.addEventListener("input", (e) => {
        const row = e.target.closest("tr");
        if (row) {
            row.classList.remove("has-conflict");
        }
        triggerLiveCheck();
    });

    editScheduleTableBody.addEventListener("change", (e) => {
        triggerLiveCheck();
    });
}

// Click handlers for Suggested Conflict Resolutions action buttons
if (editScheduleConflicts) {
    editScheduleConflicts.addEventListener("click", (e) => {
        // 1. Apply Faculty
        const facBtn = e.target.closest(".apply-faculty-btn");
        if (facBtn) {
            const rowIdx = parseInt(facBtn.dataset.rowIdx, 10);
            const code = facBtn.dataset.code || "";
            const facultyName = facBtn.dataset.facultyName || "";
            const row = editScheduleTableBody ? (
                editScheduleTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? editScheduleTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const facSelect = row.querySelector(".edit-faculty-select");
                if (facSelect) {
                    let matchedOpt = [...facSelect.options].find(opt => sameFaculty(opt.value, facultyName));
                    if (!matchedOpt) {
                        const opt = document.createElement("option");
                        opt.value = facultyName;
                        opt.textContent = facultyName;
                        if (facBtn.dataset.facultyUid) opt.dataset.uid = facBtn.dataset.facultyUid;
                        facSelect.appendChild(opt);
                        matchedOpt = opt;
                    }
                    if (matchedOpt) {
                        facSelect.value = matchedOpt.value;
                        matchedOpt.selected = true;
                    }
                    facSelect.dispatchEvent(new Event("change", { bubbles: true }));
                    facSelect.dispatchEvent(new Event("input", { bubbles: true }));
                    runLiveEditConflictCheck();
                    showToast(`Applied faculty: ${facultyName}`);
                }
            }
            return;
        }

        // 2. Apply Time
        const timeBtn = e.target.closest(".apply-time-btn");
        if (timeBtn) {
            const rowIdx = parseInt(timeBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(timeBtn.dataset.slotIdx, 10) || 0;
            const code = timeBtn.dataset.code || "";
            const newDay = timeBtn.dataset.day || "";
            const newTime = timeBtn.dataset.time || "";
            const row = editScheduleTableBody ? (
                editScheduleTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? editScheduleTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const dayInput = row.querySelector(".edit-day-input");
                const timeInput = row.querySelector(".edit-time-input");
                if (dayInput && timeInput) {
                    const daysArr = dayInput.value.split(" / ").map(d => d.trim()).filter(Boolean);
                    const timesArr = timeInput.value.split(" / ").map(t => t.trim()).filter(Boolean);

                    if (daysArr.length > 1 && slotIdx < daysArr.length) {
                        daysArr[slotIdx] = newDay;
                        dayInput.value = daysArr.join(" / ");
                    } else {
                        dayInput.value = newDay;
                    }

                    if (timesArr.length > 1 && slotIdx < timesArr.length) {
                        timesArr[slotIdx] = newTime;
                        timeInput.value = timesArr.join(" / ");
                    } else {
                        timeInput.value = newTime;
                    }

                    dayInput.dispatchEvent(new Event("input", { bubbles: true }));
                    dayInput.dispatchEvent(new Event("change", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("input", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("change", { bubbles: true }));
                    runLiveEditConflictCheck();
                    showToast(`Applied schedule: ${newDay} (${newTime})`);
                }
            }
            return;
        }

        // 3. Apply Room
        const roomBtn = e.target.closest(".apply-room-btn");
        if (roomBtn) {
            const rowIdx = parseInt(roomBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(roomBtn.dataset.slotIdx, 10) || 0;
            const code = roomBtn.dataset.code || "";
            const newRoom = roomBtn.dataset.room || "";
            const row = editScheduleTableBody ? (
                editScheduleTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? editScheduleTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const roomInput = row.querySelector(".edit-room-input");
                if (roomInput) {
                    const roomsArr = roomInput.value.split(" / ").map(r => r.trim()).filter(Boolean);
                    if (roomsArr.length > 1 && slotIdx < roomsArr.length) {
                        roomsArr[slotIdx] = newRoom;
                        roomInput.value = roomsArr.join(" / ");
                    } else {
                        roomInput.value = newRoom;
                    }
                    roomInput.dispatchEvent(new Event("input", { bubbles: true }));
                    roomInput.dispatchEvent(new Event("change", { bubbles: true }));
                    runLiveEditConflictCheck();
                    showToast(`Applied room: ${newRoom}`);
                }
            }
            return;
        }

        // 4. Apply Combined
        const combinedBtn = e.target.closest(".apply-combined-btn");
        if (combinedBtn) {
            const rowIdx = parseInt(combinedBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(combinedBtn.dataset.slotIdx, 10) || 0;
            const code = combinedBtn.dataset.code || "";
            const newDay = combinedBtn.dataset.day || "";
            const newTime = combinedBtn.dataset.time || "";
            const newRoom = combinedBtn.dataset.room || "";
            const newFaculty = combinedBtn.dataset.facultyName || "";
            const row = editScheduleTableBody ? (
                editScheduleTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? editScheduleTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const dayInput = row.querySelector(".edit-day-input");
                const timeInput = row.querySelector(".edit-time-input");
                const roomInput = row.querySelector(".edit-room-input");
                const facSelect = row.querySelector(".edit-faculty-select");

                if (dayInput && newDay) {
                    const daysArr = dayInput.value.split(" / ").map(d => d.trim()).filter(Boolean);
                    if (daysArr.length > 1 && slotIdx < daysArr.length) {
                        daysArr[slotIdx] = newDay;
                        dayInput.value = daysArr.join(" / ");
                    } else {
                        dayInput.value = newDay;
                    }
                    dayInput.dispatchEvent(new Event("input", { bubbles: true }));
                    dayInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (timeInput && newTime) {
                    const timesArr = timeInput.value.split(" / ").map(t => t.trim()).filter(Boolean);
                    if (timesArr.length > 1 && slotIdx < timesArr.length) {
                        timesArr[slotIdx] = newTime;
                        timeInput.value = timesArr.join(" / ");
                    } else {
                        timeInput.value = newTime;
                    }
                    timeInput.dispatchEvent(new Event("input", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (roomInput && newRoom) {
                    const roomsArr = roomInput.value.split(" / ").map(r => r.trim()).filter(Boolean);
                    if (roomsArr.length > 1 && slotIdx < roomsArr.length) {
                        roomsArr[slotIdx] = newRoom;
                        roomInput.value = roomsArr.join(" / ");
                    } else {
                        roomInput.value = newRoom;
                    }
                    roomInput.dispatchEvent(new Event("input", { bubbles: true }));
                    roomInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (facSelect && newFaculty) {
                    let matchedOpt = [...facSelect.options].find(opt => sameFaculty(opt.value, newFaculty));
                    if (!matchedOpt) {
                        const opt = document.createElement("option");
                        opt.value = newFaculty;
                        opt.textContent = newFaculty;
                        if (combinedBtn.dataset.facultyUid) opt.dataset.uid = combinedBtn.dataset.facultyUid;
                        facSelect.appendChild(opt);
                        matchedOpt = opt;
                    }
                    if (matchedOpt) {
                        facSelect.value = matchedOpt.value;
                        matchedOpt.selected = true;
                    }
                    facSelect.dispatchEvent(new Event("change", { bubbles: true }));
                    facSelect.dispatchEvent(new Event("input", { bubbles: true }));
                }

                runLiveEditConflictCheck();
            }
            return;
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

        for (let idx = 0; idx < rows.length; idx++) {
            const row = rows[idx];
            const orig = (schedule.entries || [])[idx] || {};
            const code = (row.querySelector(".edit-code-input")?.value || orig.code || "").trim();
            const name = (row.querySelector(".edit-name-input")?.value || orig.name || "").trim();
            const units = (row.querySelector(".edit-units-input")?.value || orig.units || "").trim();
            const day = (row.querySelector(".edit-day-input")?.value || "").trim();
            const time = (row.querySelector(".edit-time-input")?.value || "").trim();
            const room = (row.querySelector(".edit-room-input")?.value || "").trim();
            const facultySelect = row.querySelector(".edit-faculty-select");
            const faculty = (facultySelect?.value || "").trim();
            const facultyUid = (facultySelect?.selectedOptions[0]?.dataset?.uid || orig.facultyUid || "").trim();
            const facultyId = (facultySelect?.selectedOptions[0]?.dataset?.employeeId || orig.facultyId || "").trim();

            const dayIsUnscheduled = isUnscheduledValue(day);
            const timeIsUnscheduled = isUnscheduledValue(time);
            const roomIsUnscheduled = isUnscheduledValue(room);
            const isFullyUnscheduled = dayIsUnscheduled && timeIsUnscheduled && roomIsUnscheduled;
            const hasFullSchedule = !dayIsUnscheduled && !timeIsUnscheduled && !roomIsUnscheduled;

            // Fully unscheduled rows are allowed — the subject has no faculty assigned
            // yet, so it has no Day/Time/Room schedule (stored as "-", "- / -", "TBA"...).
            // Only partially filled rows are blocked.
            if (!hasFullSchedule && !isFullyUnscheduled) {
                showToast(`Please complete Day, Time, and Room for ${code || "all subjects"}.`);
                return;
            }

            // Normalize "no schedule" placeholders to TBA so conflict checks, saved
            // bookings, and display filters treat them consistently everywhere.
            const normDay = isFullyUnscheduled ? "TBA" : day;
            const normTime = isFullyUnscheduled ? "TBA" : time;
            const normRoom = isFullyUnscheduled ? "TBA" : room;

            updatedEntries.push({
                ...orig,
                code,
                name,
                units: Number(units) || units,
                day: normDay,
                time: normTime,
                room: normRoom,
                faculty: faculty || "Unassigned",
                facultyUid,
                facultyId
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

            // Display conflict banner & Suggested Conflict Resolutions
            if (editScheduleConflicts) {
                const recommendations = generateConflictResolutions(validation, schedule, updatedEntries);
                const resolutionsHtml = renderConflictResolutionsUI(recommendations);

                editScheduleConflicts.innerHTML = `
                    <div class="edit-conflict-banner">
                        <h4>⚠️ Scheduling Conflicts Detected (${validation.conflicts.length})</h4>
                        <ul class="edit-conflict-list">
                            ${validation.conflicts.map(c => `<li>${c}</li>`).join("")}
                        </ul>
                        <p style="margin:8px 0 0 0; font-size:12px; opacity:0.9;">Please resolve the conflicts above before saving changes.</p>
                    </div>
                    ${resolutionsHtml}
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
                    faculty: entry.faculty || "Unassigned",
                    facultyUid: entry.facultyUid || "",
                    facultyId: entry.facultyId || "",
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

            /* Synchronize shared minor subjects and activities across sibling sets if split */
            if (schedule.isSplit || schedule.scheduleGroupId) {
                const grpId = schedule.scheduleGroupId;
                const origSec = (schedule.originalSection || schedule.section.replace(/\s+set\s+[ab]$/i, "")).trim().toLowerCase();
                const siblingSchedules = allSchedules.filter(s =>
                    s.id !== schedule.id &&
                    scheduleDocId(s) !== scheduleDocId(schedule) &&
                    ((grpId && s.scheduleGroupId === grpId) || ((s.originalSection || s.section.replace(/\s+set\s+[ab]$/i, "")).trim().toLowerCase() === origSec))
                );

                for (const sibling of siblingSchedules) {
                    let sibChanged = false;
                    const classifications = schedule.subjectClassifications || sibling.subjectClassifications || {};

                    updatedEntries.forEach(upEntry => {
                        const type = classifications[upEntry.code] || (isActivityEntry(upEntry) ? "Activity" : "");
                        const isShared = isSharedSubjectType(type, upEntry.code, upEntry.name);

                        if (isShared && Array.isArray(sibling.entries)) {
                            const sibEntry = sibling.entries.find(e => e.code === upEntry.code);
                            if (sibEntry) {
                                if (sibEntry.day !== upEntry.day || sibEntry.time !== upEntry.time || sibEntry.room !== upEntry.room || sibEntry.faculty !== upEntry.faculty) {
                                    sibEntry.day = upEntry.day;
                                    sibEntry.time = upEntry.time;
                                    sibEntry.room = upEntry.room;
                                    sibEntry.faculty = upEntry.faculty;
                                    sibEntry.facultyUid = upEntry.facultyUid;
                                    sibEntry.facultyId = upEntry.facultyId;
                                    sibChanged = true;
                                }
                            }
                        }
                    });

                    if (sibChanged) {
                        const sibRaw = [];
                        sibling.entries.forEach(entry => {
                            const days = String(entry.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
                            const times = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
                            const rooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
                            const maxLen = Math.max(days.length, times.length, rooms.length, 1);
                            for (let i = 0; i < maxLen; i++) {
                                sibRaw.push({
                                    code: entry.code,
                                    name: entry.name,
                                    units: entry.units,
                                    day: days[i] || days[0] || entry.day,
                                    time: times[i] || times[0] || entry.time,
                                    room: rooms[i] || rooms[0] || entry.room,
                                    roomCode: "",
                                    faculty: entry.faculty || "Unassigned",
                                    facultyUid: entry.facultyUid || "",
                                    facultyId: entry.facultyId || "",
                                    section: sibling.section || ""
                                });
                            }
                        });
                        sibling.rawEntries = sibRaw;
                        sibling.updatedAt = new Date().toISOString();
                        try {
                            await saveScheduleToFirestore(sibling);
                            console.log("Synchronized shared subjects to sibling set in Firestore:", sibling.id);
                        } catch (sibErr) {
                            console.warn("Could not synchronize sibling schedule in Firestore:", sibErr);
                        }
                    }
                }
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

/* ------------------------------------------------------------------ */
/*  Split Section into Set A & Set B Subsystem                        */
/* ------------------------------------------------------------------ */

const splitScheduleModal = document.getElementById("splitScheduleModal");
const splitModalTitle = document.getElementById("splitModalTitle");
const splitModalSubtitle = document.getElementById("splitModalSubtitle");
const closeSplitScheduleModalBtn = document.getElementById("closeSplitScheduleModalBtn");
const cancelSplitScheduleBtn = document.getElementById("cancelSplitScheduleBtn");
const confirmSplitScheduleBtn = document.getElementById("confirmSplitScheduleBtn");
const splitTabClassificationBtn = document.getElementById("splitTabClassificationBtn");
const splitTabSetsPreviewBtn = document.getElementById("splitTabSetsPreviewBtn");
const splitTabClassificationContent = document.getElementById("splitTabClassificationContent");
const splitTabSetsPreviewContent = document.getElementById("splitTabSetsPreviewContent");
const splitClassificationTableBody = document.getElementById("splitClassificationTableBody");
const unconfirmedAlert = document.getElementById("unconfirmedAlert");
const proceedToSetsPreviewBtn = document.getElementById("proceedToSetsPreviewBtn");
const setACardTitle = document.getElementById("setACardTitle");
const setBCardTitle = document.getElementById("setBCardTitle");
const splitSetATableBody = document.getElementById("splitSetATableBody");
const splitSetBTableBody = document.getElementById("splitSetBTableBody");
const splitConflictsBanner = document.getElementById("splitConflictsBanner");
const splitAmbiguousAlert = document.getElementById("splitAmbiguousAlert");
const splitResolutionsContainer = document.getElementById("splitResolutionsContainer");

// currentSplitContext declared above at line 496

async function fetchProspectusClassifications(schedule) {
    const map = new Map();
    try {
        let q;
        const semNum = parseInt(String(schedule.semester || "").replace(/\D/g, ""), 10);
        if (!isNaN(semNum) && semNum > 0) {
            q = query(collection(db, "prospectus"), where("semester", "==", semNum));
        } else {
            q = collection(db, "prospectus");
        }
        const snap = await getDocs(q);
        snap.forEach(d => {
            const data = d.data();
            if (data.subjectCode) {
                const codeKey = String(data.subjectCode).trim().toUpperCase();
                map.set(codeKey, {
                    subjectCode: data.subjectCode,
                    subjectName: data.subjectName || "",
                    programCode: data.programCode || "",
                    majorCode: data.majorCode || "",
                    yearLevel: data.yearLevel,
                    semester: data.semester,
                    subjectType: data.subjectType || "",
                    meetingType: data.meetingType || "",
                    requiredRoomType: data.requiredRoomType || ""
                });
            }
        });
    } catch (err) {
        console.warn("Could not fetch prospectus for classifications:", err);
    }
    return map;
}

function resolveSubjectClassification(entry, prospectusMap, savedClassifications = {}) {
    const code = String(entry.code || "").trim();
    const codeKey = code.toUpperCase();
    const name = String(entry.name || "").trim();

    if (savedClassifications && savedClassifications[code]) {
        const saved = savedClassifications[code];
        const isRes = saved === "Research" || isResearchSubject(code, name, saved);
        const isActivity = saved === "Activity" || isActivityEntry(entry);
        return {
            type: saved === "Major" ? "Major" : (isRes ? "Research" : (isActivity ? "Activity" : "Minor")),
            foundInProspectus: true,
            sourceLabel: "Saved Classification",
            needsConfirmation: false
        };
    }

    const p = prospectusMap.get(codeKey);
    if (p) {
        const rawType = String(p.subjectType || "").trim().toLowerCase();
        const rawMeeting = String(p.meetingType || "").trim().toLowerCase();
        const rawRoom = String(p.requiredRoomType || "").trim().toLowerCase();

        if (rawType === "research" || isResearchSubject(code, name, rawType)) {
            return {
                type: "Research",
                foundInProspectus: true,
                sourceLabel: "Curriculum (Prospectus: Research)",
                needsConfirmation: false
            };
        } else if (rawType === "major") {
            return {
                type: "Major",
                foundInProspectus: true,
                sourceLabel: "Curriculum (Prospectus: Major)",
                needsConfirmation: false
            };
        } else if (rawType === "minor" || rawType === "general") {
            if (rawMeeting.includes("activity") || rawRoom.includes("gym") || isActivityEntry(entry)) {
                return {
                    type: "Activity",
                    foundInProspectus: true,
                    sourceLabel: "Curriculum (Prospectus: Activity)",
                    needsConfirmation: false
                };
            }
            return {
                type: "Minor",
                foundInProspectus: true,
                sourceLabel: `Curriculum (Prospectus: ${p.subjectType || 'Minor'})`,
                needsConfirmation: false
            };
        } else if (rawMeeting.includes("activity") || isActivityEntry(entry)) {
            return {
                type: "Activity",
                foundInProspectus: true,
                sourceLabel: "Curriculum (Activity Rule)",
                needsConfirmation: false
            };
        }
    }

    if (isResearchSubject(code, name, entry.subjectType)) {
        return {
            type: "Research",
            foundInProspectus: Boolean(p),
            sourceLabel: "Research Subject",
            needsConfirmation: false
        };
    }

    if (isActivityEntry(entry) || isActivityGymOrCourtRoom(entry.room)) {
        return {
            type: "Activity",
            foundInProspectus: true,
            sourceLabel: "Physical Activity / PE",
            needsConfirmation: false
        };
    }

    // Unclassified or missing from prospectus: infer sensible default and flag as ambiguous
    const isGE = /^(GE|GEC|NSTP|FIL|ENG|MATH|SOC|HIST|CWTS|ROTC)/i.test(codeKey) || /general education|nstp|filipino|contemporary|purposive|ethics|understanding the self|readings in/i.test(name);
    const isAct = isActivityEntry(entry) || /^(PE|PATHFIT|PATH FIT)/i.test(codeKey);
    const isRes = isResearchSubject(codeKey, name, "");
    const inferredType = isRes ? "Research" : (isAct ? "Activity" : (isGE ? "Minor" : "Major"));

    return {
        type: inferredType,
        foundInProspectus: false,
        isAmbiguous: true,
        sourceLabel: "Inferred (Missing from Curriculum)",
        needsConfirmation: false
    };
}

function buildSplitFacultyOptions(selectedFaculty, facultyUid, subjectCode, scheduleMeta) {
    const entryCriteria = {
        subjectCode: subjectCode || "",
        programCode: scheduleMeta.program || "",
        majorCode: scheduleMeta.major || "",
        yearLevel: scheduleMeta.yearLevel || "",
        semester: scheduleMeta.semester || "",
        section: scheduleMeta.section || ""
    };
    const eligible = (allFacultyMembers || []).filter(f => {
        const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
        return isFacultyEligibleForSubject(handled, entryCriteria);
    });
    const list = [...eligible];
    if (selectedFaculty && !list.some(f => sameFaculty(selectedFaculty, f.name) || (facultyUid && facultyUid === f.uid))) {
        const currentFac = (allFacultyMembers || []).find(f => sameFaculty(selectedFaculty, f.name) || (facultyUid && facultyUid === f.uid));
        if (currentFac) list.unshift(currentFac);
    }
    return `
        <option value="">-- Unassigned --</option>
        ${list.map(f => `
            <option value="${escapeHtml(f.name)}" data-uid="${escapeHtml(f.uid || '')}" data-employee-id="${escapeHtml(f.employeeId || '')}" ${(selectedFaculty && (sameFaculty(selectedFaculty, f.name) || facultyUid === f.uid)) ? 'selected' : ''}>
                ${escapeHtml(f.name)}${f.employeeId ? ' (' + escapeHtml(f.employeeId) + ')' : ''}
            </option>
        `).join("")}
    `;
}

function getCandidateTimeSlotsForDuration(origTimeStr) {
    const parsed = parseTimeRange(origTimeStr);
    const duration = parsed ? (parsed.end - parsed.start) : 150;

    if (Math.abs(duration - 90) <= 15) {
        return [...minorSlots];
    }
    if (Math.abs(duration - 120) <= 15) {
        return ["8:00-10:00", "10:00-12:00", "1:00-3:00", "3:00-5:00", "7:30-9:30", "1:30-3:30"];
    }
    if (Math.abs(duration - 180) <= 15) {
        return ["7:30-10:30", "10:00-1:00", "1:00-4:00", "2:00-5:00", "3:30-6:30"];
    }
    return [...majorSlots, ...minorSlots];
}

function getCandidateRoomsForSubject(entry, slotIdx = 0) {
    const origRooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
    const curRoom = origRooms[slotIdx] || origRooms[0] || "";

    const suitable = (allRooms || []).filter(r => {
        return isRoomCompatibleForSubject(r, entry, slotIdx);
    }).map(r => r.roomName || r.roomCode);

    const list = [];
    suitable.forEach(r => {
        if (!sameRoom(r, curRoom)) list.push(r);
    });
    // Add current room if compatible
    if (curRoom && isRoomCompatibleForSubject(curRoom, entry, slotIdx) && !list.some(r => sameRoom(r, curRoom))) {
        list.push(curRoom);
    }

    if (list.length) return list;

    const expectedType = getSubjectRequiredRoomTypeForSlot(entry, slotIdx);
    if (expectedType === "Gymnasium") return ["Covered Court"];
    if (expectedType === "Lecture Room") return [curRoom || "Room 101"];
    return [curRoom || expectedType];
}

function isSlotConflictFree(cand, setBSlots, setASlots, otherBookings, scheduleMeta) {
    if (!cand.day || !cand.time) return false;
    const cDay = normalizeDayName(cand.day).toLowerCase();
    const cTime = cand.time;
    const cRoom = cand.room || "";
    const cFac = cand.faculty || "";
    const isGym = isActivityGymOrCourtRoom(cRoom);

    // 0. Room compatibility check
    if (cand.room && String(cand.room).trim().toUpperCase() !== "TBA") {
        if (!isRoomCompatibleForSubject(cand.room, cand.entry || cand, cand.slotIdx || 0)) {
            return false;
        }
    }

    // 1. Check against current Set B slots
    for (const s of setBSlots) {
        if (normalizeDayName(s.day).toLowerCase() === cDay && timesOverlap(s.time, cTime)) {
            return false; // Section time overlap
        }
        if (!isGym && cRoom && s.room && normalizeDayName(s.day).toLowerCase() === cDay && timesOverlap(s.time, cTime) && sameRoom(s.room, cRoom)) {
            return false; // Internal room double-booking
        }
        if (cFac && cFac !== "Unassigned" && s.faculty && normalizeDayName(s.day).toLowerCase() === cDay && timesOverlap(s.time, cTime) && sameFaculty(s.faculty, cFac)) {
            return false; // Internal faculty double-booking
        }
    }

    // 2. Check against Set A slots
    for (const s of setASlots) {
        if (s.isShared && s.code === cand.code) continue;

        if (normalizeDayName(s.day).toLowerCase() === cDay && timesOverlap(s.time, cTime)) {
            if (!isGym && cRoom && s.room && sameRoom(s.room, cRoom)) {
                return false; // Room conflict with Set A
            }
            if (cFac && cFac !== "Unassigned" && s.faculty && sameFaculty(s.faculty, cFac)) {
                return false; // Faculty conflict with Set A
            }
        }
    }

    // 3. Check against other active sections in database
    const cleanOrig = (scheduleMeta.originalSection || scheduleMeta.section || "").replace(/\s+set\s+[ab]$/i, "").trim().toLowerCase();
    for (const b of (otherBookings || [])) {
        const cleanB = (b.section || "").replace(/\s+set\s+[ab]$/i, "").trim().toLowerCase();
        if (cleanB && cleanOrig && cleanB === cleanOrig) continue;
        if ((b.section || "").trim().toLowerCase() === (scheduleMeta.section || "").trim().toLowerCase()) continue;
        if (scheduleMeta.originalSection && (b.originalSection || "").trim().toLowerCase() === scheduleMeta.originalSection.trim().toLowerCase()) continue;
        if (scheduleMeta.scheduleGroupId && b.scheduleGroupId === scheduleMeta.scheduleGroupId) continue;

        if (b.day && normalizeDayName(b.day).toLowerCase() === cDay && b.time && timesOverlap(b.time, cTime)) {
            if (cRoom && b.room && sameRoom(b.room, cRoom)) {
                if (isGym) {
                    const gymCount = otherBookings.filter(ob =>
                        ob.day && normalizeDayName(ob.day).toLowerCase() === cDay &&
                        ob.room && sameRoom(ob.room, cRoom) &&
                        timesOverlap(ob.time, cTime)
                    ).length;
                    if (gymCount >= 2) return false;
                } else {
                    return false;
                }
            }
            if (cFac && cFac !== "Unassigned" && b.faculty && sameFaculty(b.faculty, cFac)) {
                return false;
            }
        }
    }

    return true;
}

function findAlternativeMajorSlots(entry, slotCount, origDays, origTimes, origRooms, setBSlots, setASlots, otherBookings, scheduleMeta) {
    const candFaculty = entry.faculty || "Unassigned";
    const candFacultyUid = entry.facultyUid || "";
    const candFacultyId = entry.facultyId || "";

    // Candidate faculty: prioritize current instructor, then eligible department faculty
    const eligibleFaculty = [
        ...(candFaculty && candFaculty !== "Unassigned" ? [{ name: candFaculty, uid: candFacultyUid, employeeId: candFacultyId }] : [])
    ];
    const handledList = (allFacultyMembers || []).filter(f => {
        const handled = facultyAssignmentsMap.get(f.uid) || facultyAssignmentsMap.get(f.id) || [];
        return isFacultyEligibleForSubject(handled, {
            subjectCode: entry.code,
            programCode: scheduleMeta.program,
            majorCode: scheduleMeta.major,
            yearLevel: scheduleMeta.yearLevel,
            semester: scheduleMeta.semester,
            section: scheduleMeta.section
        });
    });
    handledList.forEach(f => {
        if (!eligibleFaculty.some(ef => sameFaculty(ef.name, f.name))) {
            eligibleFaculty.push({ name: f.name, uid: f.uid || "", employeeId: f.employeeId || "" });
        }
    });
    if (!eligibleFaculty.length) {
        eligibleFaculty.push({ name: "Unassigned", uid: "", employeeId: "" });
    }

    if (slotCount === 1) {
        const origDay = origDays[0] || "Monday";
        const origTime = origTimes[0] || "7:30-10:00";
        const candidateDays = days.filter(d => d.toLowerCase() !== origDay.toLowerCase()).concat([origDay]);
        const candidateTimes = getCandidateTimeSlotsForDuration(origTime);
        const candidateRooms = getCandidateRoomsForSubject(entry, 0);

        for (const fac of eligibleFaculty) {
            for (const day of candidateDays) {
                for (const time of candidateTimes) {
                    if (day.toLowerCase() === origDay.toLowerCase() && time === origTime && sameFaculty(fac.name, candFaculty)) continue;
                    for (const room of candidateRooms) {
                        const cand = {
                            code: entry.code,
                            name: entry.name,
                            day,
                            time,
                            room,
                            faculty: fac.name,
                            facultyUid: fac.uid,
                            facultyId: fac.employeeId,
                            slotIdx: 0,
                            entry
                        };
                        if (isSlotConflictFree(cand, setBSlots, setASlots, otherBookings, scheduleMeta)) {
                            return [cand];
                        }
                    }
                }
            }
        }

        // If no valid schedule is available, identify conflict and allow manual adjustment without inventing assignments
        return [{
            day: "",
            time: "",
            room: "",
            faculty: candFaculty,
            facultyUid: candFacultyUid,
            facultyId: candFacultyId,
            unresolved: true
        }];
    }

    if (slotCount === 2) {
        const standardPairs = [
            ["Tuesday", "Thursday"],
            ["Monday", "Wednesday"],
            ["Wednesday", "Friday"],
            ["Monday", "Thursday"],
            ["Tuesday", "Friday"],
            ["Monday", "Friday"]
        ];

        const origNorm = origDays.map(d => normalizeDayName(d).toLowerCase());
        const sortedPairs = [...standardPairs].sort((a, b) => {
            const overlapA = a.filter(d => origNorm.includes(d.toLowerCase())).length;
            const overlapB = b.filter(d => origNorm.includes(d.toLowerCase())).length;
            return overlapA - overlapB;
        });

        // Add reverse pairs so day 1 and day 2 can swap if needed
        const allPairs = [];
        sortedPairs.forEach(([d1, d2]) => {
            allPairs.push([d1, d2]);
            allPairs.push([d2, d1]);
        });

        const candidateTimes1 = getCandidateTimeSlotsForDuration(origTimes[0] || "7:30-10:00");
        const candidateTimes2 = getCandidateTimeSlotsForDuration(origTimes[1] || origTimes[0] || "7:30-10:00");
        const candidateRooms1 = getCandidateRoomsForSubject(entry, 0);
        const candidateRooms2 = getCandidateRoomsForSubject(entry, 1);

        for (const fac of eligibleFaculty) {
            for (const [pDay1, pDay2] of allPairs) {
                for (const time1 of candidateTimes1) {
                    for (const r1 of candidateRooms1) {
                        const cand1 = {
                            code: entry.code,
                            name: entry.name,
                            day: pDay1,
                            time: time1,
                            room: r1,
                            faculty: fac.name,
                            facultyUid: fac.uid,
                            facultyId: fac.employeeId,
                            slotIdx: 0,
                            entry
                        };

                        if (!isSlotConflictFree(cand1, setBSlots, setASlots, otherBookings, scheduleMeta)) continue;

                        for (const time2 of candidateTimes2) {
                            for (const r2 of candidateRooms2) {
                                const cand2 = {
                                    code: entry.code,
                                    name: entry.name,
                                    day: pDay2,
                                    time: time2,
                                    room: r2,
                                    faculty: fac.name,
                                    facultyUid: fac.uid,
                                    facultyId: fac.employeeId,
                                    slotIdx: 1,
                                    entry
                                };

                                if (isSlotConflictFree(cand2, [...setBSlots, cand1], setASlots, otherBookings, scheduleMeta)) {
                                    return [cand1, cand2];
                                }
                            }
                        }
                    }
                }
            }
        }

        // If no valid schedule is available, identify conflict and allow manual adjustment without inventing assignments
        return [
            { day: "", time: "", room: "", faculty: candFaculty, facultyUid: candFacultyUid, facultyId: candFacultyId, unresolved: true },
            { day: "", time: "", room: "", faculty: candFaculty, facultyUid: candFacultyUid, facultyId: candFacultyId, unresolved: true }
        ];
    }

    // slotCount > 2
    const res = [];
    const tempSetBSlots = [...setBSlots];
    for (let i = 0; i < slotCount; i++) {
        const oDay = origDays[i] || days[i % days.length];
        const oTime = origTimes[i] || origTimes[0] || "7:30-10:00";
        const candidateDays = days.filter(d => d.toLowerCase() !== oDay.toLowerCase()).concat([oDay]);
        const candidateTimes = getCandidateTimeSlotsForDuration(oTime);
        const candidateRooms = getCandidateRoomsForSubject(entry, i);

        let placed = null;
        for (const fac of eligibleFaculty) {
            for (const day of candidateDays) {
                for (const time of candidateTimes) {
                    if (day.toLowerCase() === oDay.toLowerCase() && time === oTime && sameFaculty(fac.name, candFaculty)) continue;
                    for (const room of candidateRooms) {
                        const cand = {
                            code: entry.code,
                            name: entry.name,
                            day,
                            time,
                            room,
                            faculty: fac.name,
                            facultyUid: fac.uid,
                            facultyId: fac.employeeId,
                            slotIdx: i,
                            entry
                        };
                        if (isSlotConflictFree(cand, tempSetBSlots, setASlots, otherBookings, scheduleMeta)) {
                            placed = cand;
                            break;
                        }
                    }
                    if (placed) break;
                }
                if (placed) break;
            }
            if (placed) break;
        }

        if (!placed) {
            placed = {
                day: "",
                time: "",
                room: "",
                faculty: candFaculty,
                facultyUid: candFacultyUid,
                facultyId: candFacultyId,
                unresolved: true
            };
        }
        tempSetBSlots.push(placed);
        res.push(placed);
    }
    return res;
}

function generateAlternativeScheduleForSetB(entriesBaseline, classifications, scheduleMeta, existingSetBEntries = null) {
    if (!entriesBaseline || !entriesBaseline.length) return [];

    const otherBookings = getSavedBookings(scheduleMeta.academicYear, scheduleMeta.semester);

    // Expand Set A into individual slot objects for cross-set conflict checking
    const setASlots = [];
    entriesBaseline.forEach(entry => {
        const info = classifications.get(entry.code) || { type: "Major" };
        const isShared = isSharedSubjectType(info.type, entry.code, entry.name);
        const entryDays = String(entry.day || "").split(" / ").map(d => normalizeDayName(d.trim())).filter(Boolean);
        const entryTimes = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
        const entryRooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
        const maxSlots = Math.max(entryDays.length, entryTimes.length, entryRooms.length, 1);

        for (let i = 0; i < maxSlots; i++) {
            setASlots.push({
                code: entry.code,
                name: entry.name,
                day: entryDays[i] || entryDays[0] || normalizeDayName(entry.day),
                time: entryTimes[i] || entryTimes[0] || entry.time,
                room: entryRooms[i] || entryRooms[0] || entry.room,
                faculty: entry.faculty || "Unassigned",
                facultyUid: entry.facultyUid || "",
                isShared
            });
        }
    });

    const setBSlots = [];
    const resultEntries = [];

    // Step 1: Place all shared subjects (Minor, Activity, and Research) first, as they mirror Set A exactly
    entriesBaseline.forEach(entry => {
        const info = classifications.get(entry.code) || { type: "Major" };
        if (isSharedSubjectType(info.type, entry.code, entry.name)) {
            const entryDays = String(entry.day || "").split(" / ").map(d => normalizeDayName(d.trim())).filter(Boolean);
            const entryTimes = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
            const entryRooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
            const maxSlots = Math.max(entryDays.length, entryTimes.length, entryRooms.length, 1);

            for (let i = 0; i < maxSlots; i++) {
                setBSlots.push({
                    code: entry.code,
                    name: entry.name,
                    day: entryDays[i] || entryDays[0] || normalizeDayName(entry.day),
                    time: entryTimes[i] || entryTimes[0] || entry.time,
                    room: entryRooms[i] || entryRooms[0] || entry.room,
                    faculty: entry.faculty || "Unassigned",
                    facultyUid: entry.facultyUid || "",
                    isShared: true
                });
            }
        }
    });

    // Step 2: For each entry in baseline, if shared (Minor/Activity/Research), keep identical. If Major, generate alternative!
    entriesBaseline.forEach(entry => {
        const info = classifications.get(entry.code) || { type: "Major" };
        if (isSharedSubjectType(info.type, entry.code, entry.name)) {
            resultEntries.push({
                ...entry,
                subjectType: info.type
            });
            return;
        }

        // Check if existingSetBEntries already had a customized/different schedule for this major subject
        const prevB = (existingSetBEntries || []).find(e => e.code === entry.code);
        const isPrevDifferent = prevB && (
            prevB.day !== entry.day ||
            prevB.time !== entry.time ||
            (prevB.room && prevB.room !== entry.room)
        );

        if (isPrevDifferent) {
            resultEntries.push({
                ...prevB,
                subjectType: "Major"
            });
            const pDays = String(prevB.day || "").split(" / ").map(d => normalizeDayName(d.trim())).filter(Boolean);
            const pTimes = String(prevB.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
            const pRooms = String(prevB.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
            const maxS = Math.max(pDays.length, pTimes.length, pRooms.length, 1);
            for (let i = 0; i < maxS; i++) {
                setBSlots.push({
                    code: prevB.code,
                    name: prevB.name,
                    day: pDays[i] || pDays[0] || normalizeDayName(prevB.day),
                    time: pTimes[i] || pTimes[0] || prevB.time,
                    room: pRooms[i] || pRooms[0] || prevB.room,
                    faculty: prevB.faculty || "Unassigned",
                    facultyUid: prevB.facultyUid || "",
                    isShared: false
                });
            }
            return;
        }

        // Generate alternative schedule for this Major subject
        const origDays = String(entry.day || "").split(" / ").map(d => normalizeDayName(d.trim())).filter(Boolean);
        const origTimes = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
        const origRooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
        const slotCount = Math.max(origDays.length, origTimes.length, 1);

        const newSlots = findAlternativeMajorSlots(
            entry,
            slotCount,
            origDays,
            origTimes,
            origRooms,
            setBSlots,
            setASlots,
            otherBookings,
            scheduleMeta
        );

        newSlots.forEach(s => {
            setBSlots.push({
                code: entry.code,
                name: entry.name,
                day: s.day,
                time: s.time,
                room: s.room,
                faculty: s.faculty,
                facultyUid: s.facultyUid,
                isShared: false
            });
        });

        const resDay = newSlots.map(s => s.day).join(" / ");
        const resTime = newSlots.map(s => s.time).join(" / ");
        const resRoom = newSlots.every(s => s.room === newSlots[0].room)
            ? (newSlots[0].room || entry.room || "")
            : newSlots.map(s => s.room).join(" / ");
        const resFac = newSlots[0]?.faculty || entry.faculty || "Unassigned";
        const resFacUid = newSlots[0]?.facultyUid || entry.facultyUid || "";
        const resFacId = newSlots[0]?.facultyId || entry.facultyId || "";

        resultEntries.push({
            code: entry.code,
            name: entry.name,
            units: Number(entry.units) || entry.units,
            day: resDay,
            time: resTime,
            room: resRoom,
            faculty: resFac,
            facultyUid: resFacUid,
            facultyId: resFacId,
            subjectType: "Major"
        });
    });

    return resultEntries;
}

function ensureSetBAlternativeScheduleGenerated() {
    if (!currentSplitContext) return;
    if (currentSplitContext.isManage && currentSplitContext.setBEntries && currentSplitContext.setBEntries.length > 0) {
        return;
    }
    currentSplitContext.setBEntries = generateAlternativeScheduleForSetB(
        currentSplitContext.entriesBaseline,
        currentSplitContext.classifications,
        currentSplitContext.originalSchedule,
        currentSplitContext.setBEntries
    );
}

function switchSplitTab(tab) {
    if (splitTabSetsPreviewContent) splitTabSetsPreviewContent.style.display = "block";
    ensureSetBAlternativeScheduleGenerated();
    renderSplitSetsPreview();
}

function renderSplitSetsPreview() {
    if (!currentSplitContext || !splitSetATableBody || !splitSetBTableBody) return;

    const baseline = currentSplitContext.entriesBaseline || [];
    const scheduleMeta = currentSplitContext.originalSchedule;

    // Render Set A Table
    splitSetATableBody.innerHTML = baseline.map((entry, idx) => {
        const info = currentSplitContext.classifications.get(entry.code) || { type: "Major" };
        const isMajor = !isSharedSubjectType(info.type, entry.code, entry.name);

        return `
            <tr data-code="${escapeHtml(entry.code)}" data-idx="${idx}" data-entry-idx="${idx}" class="${isMajor ? 'row-major' : 'row-shared'}">
                <td>
                    <strong style="color:#1b5e20;">${escapeHtml(entry.code)}</strong>
                    <div style="font-size:11px; color:#555;">${escapeHtml(entry.name)}</div>
                </td>
                <td>
                    <input type="text" class="set-a-day-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(entry.day || '')}" readonly style="background:#f4fbf4; border:1px solid #c8e6c9; color:#1b5e20; font-weight:600;">
                </td>
                <td>
                    <input type="text" class="set-a-time-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(entry.time || '')}" readonly style="background:#f4fbf4; border:1px solid #c8e6c9; color:#1b5e20; font-weight:600;">
                </td>
                <td>
                    <input type="text" class="set-a-room-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(entry.room || '')}" readonly style="background:#f4fbf4; border:1px solid #c8e6c9; color:#1b5e20; font-weight:600;">
                </td>
                <td>
                    <input type="text" class="set-a-fac-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(entry.faculty || 'Unassigned')}" readonly style="background:#f4fbf4; border:1px solid #c8e6c9; color:#1b5e20; font-weight:600;">
                </td>
            </tr>
        `;
    }).join("");

    // Render Set B Table
    // Set B has identical list of major subjects with independent editable inputs.
    // Shared minor, activity, and research subjects mirror Set A with locked display.
    splitSetBTableBody.innerHTML = baseline.map((entry, idx) => {
        const info = currentSplitContext.classifications.get(entry.code) || { type: "Major" };
        const isMajor = !isSharedSubjectType(info.type, entry.code, entry.name);

        const existingB = (currentSplitContext.setBEntries || []).find(e => e.code === entry.code);

        const dayVal = isMajor ? (existingB?.day || "") : (entry.day || "");
        const timeVal = isMajor ? (existingB?.time || "") : (entry.time || "");
        const roomVal = isMajor ? (existingB?.room || "") : (entry.room || "");
        const facVal = isMajor ? (existingB?.faculty || entry.faculty || "") : (entry.faculty || "");
        const facUid = isMajor ? (existingB?.facultyUid || entry.facultyUid || "") : (entry.facultyUid || "");

        if (isMajor) {
            const hasMissingField = !dayVal || !timeVal || !roomVal;
            return `
                <tr data-code="${escapeHtml(entry.code)}" data-idx="${idx}" data-entry-idx="${idx}" class="row-major" style="${hasMissingField ? 'background:#fff8f8;' : ''}">
                    <td>
                        <strong style="color:#00796b;">${escapeHtml(entry.code)}</strong>
                        <div style="font-size:11px; color:#555;">${escapeHtml(entry.name)}</div>
                    </td>
                    <td>
                        <input type="text" class="set-b-day-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(dayVal)}" placeholder="e.g. Wednesday" style="${!dayVal ? 'border:1px solid #e53935; background:#fff5f5;' : ''}">
                    </td>
                    <td>
                        <input type="text" class="set-b-time-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(timeVal)}" placeholder="e.g. 1:00-3:30" style="${!timeVal ? 'border:1px solid #e53935; background:#fff5f5;' : ''}">
                    </td>
                    <td>
                        <input type="text" class="set-b-room-input" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(roomVal)}" placeholder="e.g. Room 102" style="${!roomVal ? 'border:1px solid #e53935; background:#fff5f5;' : ''}">
                    </td>
                    <td>
                        <select class="set-b-fac-select" data-code="${escapeHtml(entry.code)}">
                            ${buildSplitFacultyOptions(facVal, facUid, entry.code, scheduleMeta)}
                        </select>
                    </td>
                </tr>
            `;
        } else {
            // Shared Minor / Activity / Research
            const typeLabel = info.type === "Research" ? "Research" : (info.type === "Activity" ? "Activity" : "Minor");
            return `
                <tr data-code="${escapeHtml(entry.code)}" data-idx="${idx}" data-entry-idx="${idx}" class="row-shared">
                    <td>
                        <strong style="color:#2e7d32;">${escapeHtml(entry.code)}</strong>
                        <div style="font-size:11px; color:#555;">${escapeHtml(entry.name)}</div>
                        <div style="margin-top:3px;"><span class="shared-lock-indicator">🔒 Shared from Set A (${escapeHtml(typeLabel)})</span></div>
                    </td>
                    <td>
                        <input type="text" class="set-b-day-input shared-mirror" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(dayVal)}" disabled style="background:#f9f9f9; color:#666;">
                    </td>
                    <td>
                        <input type="text" class="set-b-time-input shared-mirror" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(timeVal)}" disabled style="background:#f9f9f9; color:#666;">
                    </td>
                    <td>
                        <input type="text" class="set-b-room-input shared-mirror" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(roomVal)}" disabled style="background:#f9f9f9; color:#666;">
                    </td>
                    <td>
                        <input type="text" class="set-b-fac-mirror shared-mirror" data-code="${escapeHtml(entry.code)}" value="${escapeHtml(facVal || 'Unassigned')}" disabled style="background:#f9f9f9; color:#666;">
                    </td>
                </tr>
            `;
        }
    }).join("");

    splitSetBTableBody.querySelectorAll("input, select").forEach(input => {
        input.addEventListener("input", runSplitConflictCheck);
    });

    runSplitConflictCheck();
}

function readSplitSetEntries(setName) {
    const isSetA = setName === "Set A";
    if (!currentSplitContext) return [];

    const baseline = currentSplitContext.entriesBaseline || [];
    if (isSetA) {
        // Set A retains the original section's existing subject schedules exactly
        return baseline.map((base, idx) => {
            const info = currentSplitContext.classifications.get(base.code) || { type: "Major" };
            return {
                rowIdx: idx,
                code: base.code,
                name: base.name,
                units: Number(base.units) || base.units,
                day: base.day || "",
                time: base.time || "",
                room: base.room || "",
                faculty: base.faculty || "Unassigned",
                facultyUid: base.facultyUid || "",
                facultyId: base.facultyId || "",
                subjectType: info.type
            };
        });
    }

    const container = splitSetBTableBody;
    const entries = [];

    baseline.forEach((base, idx) => {
        const row = container?.querySelector(`tr[data-code="${base.code}"]`);
        const info = currentSplitContext.classifications.get(base.code) || { type: "Major" };
        const isMajor = !isSharedSubjectType(info.type, base.code, base.name);

        if (isMajor) {
            const day = (row?.querySelector(".set-b-day-input")?.value || "").trim();
            const time = (row?.querySelector(".set-b-time-input")?.value || "").trim();
            const room = (row?.querySelector(".set-b-room-input")?.value || "").trim();
            const facSelect = row?.querySelector(".set-b-fac-select");
            const faculty = (facSelect?.value || "").trim();
            const facultyUid = (facSelect?.selectedOptions[0]?.dataset?.uid || "").trim();
            const facultyId = (facSelect?.selectedOptions[0]?.dataset?.employeeId || "").trim();

            entries.push({
                rowIdx: idx,
                code: base.code,
                name: base.name,
                units: Number(base.units) || base.units,
                day,
                time,
                room,
                faculty: faculty || "Unassigned",
                facultyUid,
                facultyId,
                subjectType: "Major"
            });
        } else {
            // Shared minor/activity subject mirrors Set A baseline exactly
            entries.push({
                rowIdx: idx,
                code: base.code,
                name: base.name,
                units: Number(base.units) || base.units,
                day: base.day || "",
                time: base.time || "",
                room: base.room || "",
                faculty: base.faculty || "Unassigned",
                facultyUid: base.facultyUid || "",
                facultyId: base.facultyId || "",
                subjectType: info.type
            });
        }
    });

    if (currentSplitContext) {
        currentSplitContext.setBEntries = entries;
    }

    return entries;
}

function runSplitConflictCheck() {
    if (!splitConflictsBanner || !currentSplitContext) return;

    const setAEntries = readSplitSetEntries("Set A");
    const setBEntries = readSplitSetEntries("Set B");
    const scheduleMeta = currentSplitContext.originalSchedule;

    const conflicts = [];

    // 1. Validate Set A internally and against other active sections
    // Note: Set A's original schedule will not conflict with itself because validateScheduleEdits excludes the original section
    const valA = validateScheduleEdits(setAEntries, {
        ...scheduleMeta,
        section: `${currentSplitContext.originalSection} Set A`,
        originalSection: currentSplitContext.originalSection,
        scheduleGroupId: currentSplitContext.scheduleGroupId
    });
    valA.conflicts.forEach(c => conflicts.push(`<strong>Set A:</strong> ${c}`));

    // 2. Prepare Set A major slots as extraBookings for Set B validation & recommendations
    const setAExtraBookings = [];
    setAEntries.forEach(a => {
        const info = currentSplitContext.classifications.get(a.code);
        if (info && !isSharedSubjectType(info.type, a.code, a.name)) {
            const days = String(a.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
            const times = String(a.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
            const rooms = String(a.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
            const maxLen = Math.max(days.length, times.length, rooms.length, 1);
            for (let i = 0; i < maxLen; i++) {
                setAExtraBookings.push({
                    section: `${currentSplitContext.originalSection} Set A`,
                    originalSection: currentSplitContext.originalSection,
                    scheduleGroupId: currentSplitContext.scheduleGroupId,
                    code: a.code,
                    name: a.name,
                    day: days[i] || days[0] || a.day,
                    time: times[i] || times[0] || a.time,
                    room: rooms[i] || rooms[0] || a.room,
                    faculty: a.faculty || "Unassigned"
                });
            }
        }
    });

    // 3. Validate Set B internally, against other active sections, and against Set A's major bookings
    const setBSchedMeta = {
        ...scheduleMeta,
        section: `${currentSplitContext.originalSection} Set B`,
        originalSection: currentSplitContext.originalSection,
        scheduleGroupId: currentSplitContext.scheduleGroupId,
        extraBookings: setAExtraBookings
    };
    const valB = validateScheduleEdits(setBEntries, setBSchedMeta);
    valB.conflicts.forEach(c => conflicts.push(`<strong>Set B:</strong> ${c}`));

    // Highlight conflicting rows in Set B table
    if (splitSetBTableBody) {
        const bRows = splitSetBTableBody.querySelectorAll("tr");
        bRows.forEach((row, idx) => {
            if (valB.conflictRowIndices.has(idx)) {
                row.classList.add("has-conflict");
            } else {
                row.classList.remove("has-conflict");
            }
        });
    }

    // 4. Identify any unassigned/incomplete major subjects in Set B
    for (const b of setBEntries) {
        const info = currentSplitContext.classifications.get(b.code);
        if (info && !isSharedSubjectType(info.type, b.code, b.name)) {
            // Fully unscheduled entries (placeholder/TBA Day, Time AND Room — e.g. an
            // unassigned-faculty subject) are intentionally left without a schedule
            // and must not be reported as a conflict here.
            const bFullyUnscheduled = isUnscheduledValue(b.day) && isUnscheduledValue(b.time) && isUnscheduledValue(b.room);
            if (!bFullyUnscheduled && (!b.day || !b.time || !b.room || b.day === "TBA" || b.time === "TBA" || b.room === "TBA")) {
                if (!TBA_SUBJECT_CODES.has(b.code)) {
                    conflicts.push(`<strong>Set B:</strong> Major subject <strong>${escapeHtml(b.code)}</strong> has no valid schedule assigned. Please manually assign Day, Time, and Room.`);
                }
            }
        }
    }

    if (conflicts.length > 0) {
        splitConflictsBanner.style.display = "block";
        splitConflictsBanner.innerHTML = `
            <h5>⚠️ Scheduling Conflicts Detected (${conflicts.length})</h5>
            <ul style="margin:4px 0 0 16px; padding:0;">
                ${conflicts.map(c => `<li style="margin-bottom:4px;">${c}</li>`).join("")}
            </ul>
        `;

        // Render conflict resolution recommendations for Set B
        if (splitResolutionsContainer) {
            const recommendations = generateConflictResolutions(valB, setBSchedMeta, setBEntries);
            const resolutionsHtml = renderConflictResolutionsUI(recommendations);
            splitResolutionsContainer.innerHTML = resolutionsHtml;
            splitResolutionsContainer.style.display = "block";
        }
    } else {
        splitConflictsBanner.style.display = "none";
        splitConflictsBanner.innerHTML = "";
        if (splitResolutionsContainer) {
            splitResolutionsContainer.style.display = "none";
            splitResolutionsContainer.innerHTML = "";
        }
    }

    return conflicts.length === 0;
}

if (splitResolutionsContainer) {
    splitResolutionsContainer.addEventListener("click", e => {
        // 1. Apply Faculty Suggestion
        const facultyBtn = e.target.closest(".apply-faculty-btn");
        if (facultyBtn) {
            const rowIdx = parseInt(facultyBtn.dataset.rowIdx, 10);
            const code = facultyBtn.dataset.code || "";
            const newFaculty = facultyBtn.dataset.facultyName || "";
            const row = splitSetBTableBody ? (
                splitSetBTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? splitSetBTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const facSelect = row.querySelector(".set-b-fac-select");
                if (facSelect) {
                    let matchedOpt = [...facSelect.options].find(opt => sameFaculty(opt.value, newFaculty));
                    if (!matchedOpt) {
                        const opt = document.createElement("option");
                        opt.value = newFaculty;
                        opt.textContent = newFaculty;
                        if (facultyBtn.dataset.facultyUid) opt.dataset.uid = facultyBtn.dataset.facultyUid;
                        facSelect.appendChild(opt);
                        matchedOpt = opt;
                    }
                    if (matchedOpt) {
                        facSelect.value = matchedOpt.value;
                        matchedOpt.selected = true;
                    }
                    facSelect.dispatchEvent(new Event("change", { bubbles: true }));
                    facSelect.dispatchEvent(new Event("input", { bubbles: true }));
                    runSplitConflictCheck();
                    showToast(`Applied faculty: ${newFaculty}`);
                }
            }
            return;
        }

        // 2. Apply Time Suggestion
        const timeBtn = e.target.closest(".apply-time-btn");
        if (timeBtn) {
            const rowIdx = parseInt(timeBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(timeBtn.dataset.slotIdx, 10) || 0;
            const code = timeBtn.dataset.code || "";
            const newDay = timeBtn.dataset.day || "";
            const newTime = timeBtn.dataset.time || "";
            const row = splitSetBTableBody ? (
                splitSetBTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? splitSetBTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const dayInput = row.querySelector(".set-b-day-input");
                const timeInput = row.querySelector(".set-b-time-input");
                if (dayInput && timeInput) {
                    const daysArr = dayInput.value.split(" / ").map(d => d.trim()).filter(Boolean);
                    const timesArr = timeInput.value.split(" / ").map(t => t.trim()).filter(Boolean);

                    if (daysArr.length > 1 && slotIdx < daysArr.length) {
                        daysArr[slotIdx] = newDay;
                        dayInput.value = daysArr.join(" / ");
                    } else {
                        dayInput.value = newDay;
                    }

                    if (timesArr.length > 1 && slotIdx < timesArr.length) {
                        timesArr[slotIdx] = newTime;
                        timeInput.value = timesArr.join(" / ");
                    } else {
                        timeInput.value = newTime;
                    }

                    dayInput.dispatchEvent(new Event("input", { bubbles: true }));
                    dayInput.dispatchEvent(new Event("change", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("input", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("change", { bubbles: true }));
                    runSplitConflictCheck();
                    showToast(`Applied schedule: ${newDay} (${newTime})`);
                }
            }
            return;
        }

        // 3. Apply Room Suggestion
        const roomBtn = e.target.closest(".apply-room-btn");
        if (roomBtn) {
            const rowIdx = parseInt(roomBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(roomBtn.dataset.slotIdx, 10) || 0;
            const code = roomBtn.dataset.code || "";
            const newRoom = roomBtn.dataset.room || "";
            const row = splitSetBTableBody ? (
                splitSetBTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? splitSetBTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const roomInput = row.querySelector(".set-b-room-input");
                if (roomInput) {
                    const roomsArr = roomInput.value.split(" / ").map(r => r.trim()).filter(Boolean);
                    if (roomsArr.length > 1 && slotIdx < roomsArr.length) {
                        roomsArr[slotIdx] = newRoom;
                        roomInput.value = roomsArr.join(" / ");
                    } else {
                        roomInput.value = newRoom;
                    }
                    roomInput.dispatchEvent(new Event("input", { bubbles: true }));
                    roomInput.dispatchEvent(new Event("change", { bubbles: true }));
                    runSplitConflictCheck();
                    showToast(`Applied room: ${newRoom}`);
                }
            }
            return;
        }

        // 4. Apply Combined Solution
        const combinedBtn = e.target.closest(".apply-combined-btn");
        if (combinedBtn) {
            const rowIdx = parseInt(combinedBtn.dataset.rowIdx, 10);
            const slotIdx = parseInt(combinedBtn.dataset.slotIdx, 10) || 0;
            const code = combinedBtn.dataset.code || "";
            const newDay = combinedBtn.dataset.day || "";
            const newTime = combinedBtn.dataset.time || "";
            const newRoom = combinedBtn.dataset.room || "";
            const newFaculty = combinedBtn.dataset.facultyName || "";
            const row = splitSetBTableBody ? (
                splitSetBTableBody.querySelector(`tr[data-entry-idx="${rowIdx}"]`) ||
                (code ? splitSetBTableBody.querySelector(`tr[data-code="${code}"]`) : null)
            ) : null;

            if (row) {
                const dayInput = row.querySelector(".set-b-day-input");
                const timeInput = row.querySelector(".set-b-time-input");
                const roomInput = row.querySelector(".set-b-room-input");
                const facSelect = row.querySelector(".set-b-fac-select");

                if (dayInput && newDay) {
                    const daysArr = dayInput.value.split(" / ").map(d => d.trim()).filter(Boolean);
                    if (daysArr.length > 1 && slotIdx < daysArr.length) {
                        daysArr[slotIdx] = newDay;
                        dayInput.value = daysArr.join(" / ");
                    } else {
                        dayInput.value = newDay;
                    }
                    dayInput.dispatchEvent(new Event("input", { bubbles: true }));
                    dayInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (timeInput && newTime) {
                    const timesArr = timeInput.value.split(" / ").map(t => t.trim()).filter(Boolean);
                    if (timesArr.length > 1 && slotIdx < timesArr.length) {
                        timesArr[slotIdx] = newTime;
                        timeInput.value = timesArr.join(" / ");
                    } else {
                        timeInput.value = newTime;
                    }
                    timeInput.dispatchEvent(new Event("input", { bubbles: true }));
                    timeInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (roomInput && newRoom) {
                    const roomsArr = roomInput.value.split(" / ").map(r => r.trim()).filter(Boolean);
                    if (roomsArr.length > 1 && slotIdx < roomsArr.length) {
                        roomsArr[slotIdx] = newRoom;
                        roomInput.value = roomsArr.join(" / ");
                    } else {
                        roomInput.value = newRoom;
                    }
                    roomInput.dispatchEvent(new Event("input", { bubbles: true }));
                    roomInput.dispatchEvent(new Event("change", { bubbles: true }));
                }

                if (facSelect && newFaculty) {
                    let matchedOpt = [...facSelect.options].find(opt => sameFaculty(opt.value, newFaculty));
                    if (!matchedOpt) {
                        const opt = document.createElement("option");
                        opt.value = newFaculty;
                        opt.textContent = newFaculty;
                        if (combinedBtn.dataset.facultyUid) opt.dataset.uid = combinedBtn.dataset.facultyUid;
                        facSelect.appendChild(opt);
                        matchedOpt = opt;
                    }
                    if (matchedOpt) {
                        facSelect.value = matchedOpt.value;
                        matchedOpt.selected = true;
                    }
                    facSelect.dispatchEvent(new Event("change", { bubbles: true }));
                    facSelect.dispatchEvent(new Event("input", { bubbles: true }));
                }

                runSplitConflictCheck();
                showToast(`Applied combined solution: ${newDay} ${newTime} in ${newRoom}`);
            }
            return;
        }
    });
}

async function openSplitScheduleModal(scheduleId, isManage = false) {
    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === scheduleId || scheduleDocId(item) === scheduleId);
    if (!schedule) {
        showToast("Schedule not found.");
        return;
    }

    let originalSection = schedule.originalSection || "";
    if (!originalSection) {
        const secStr = String(schedule.section || schedule.name || "").trim();
        originalSection = secStr.replace(/\s+set\s+[ab]$/i, "").trim();
    }

    const scheduleGroupId = schedule.scheduleGroupId || ("grp_" + scheduleDocId({
        section: originalSection,
        semester: schedule.semester,
        program: schedule.program,
        major: schedule.major,
        yearLevel: schedule.yearLevel,
        academicYear: schedule.academicYear
    }));

    const sharedScheduleId = schedule.sharedScheduleId || ("shared_" + scheduleDocId({
        section: originalSection,
        semester: schedule.semester,
        program: schedule.program,
        major: schedule.major,
        yearLevel: schedule.yearLevel,
        academicYear: schedule.academicYear
    }));

    // Find sibling sets if they exist
    let existingSetA = schedules.find(s =>
        (s.scheduleGroupId === scheduleGroupId && s.setName === "Set A") ||
        (s.originalSection && s.originalSection.toLowerCase() === originalSection.toLowerCase() && s.setName === "Set A") ||
        s.section.toLowerCase() === `${originalSection} set a`.toLowerCase()
    );
    let existingSetB = schedules.find(s =>
        (s.scheduleGroupId === scheduleGroupId && s.setName === "Set B") ||
        (s.originalSection && s.originalSection.toLowerCase() === originalSection.toLowerCase() && s.setName === "Set B") ||
        s.section.toLowerCase() === `${originalSection} set b`.toLowerCase()
    );

    const baselineEntries = schedule.entries || existingSetA?.entries || [];

    // Ensure rooms are available for room assignment
    if (!allRooms || !allRooms.length) {
        try { await loadRooms(); } catch (e) { console.warn("Could not preload rooms for split modal:", e); }
    }

    // Query prospectus for classification definitions
    const prospectusMap = await fetchProspectusClassifications(schedule);

    // Build classifications map
    const classifications = new Map();
    const savedClassifications = schedule.subjectClassifications || existingSetA?.subjectClassifications || existingSetB?.subjectClassifications || {};

    baselineEntries.forEach(entry => {
        const res = resolveSubjectClassification(entry, prospectusMap, savedClassifications);
        classifications.set(entry.code, res);
    });

    currentSplitContext = {
        isManage,
        scheduleId,
        originalSchedule: schedule,
        originalDocId: scheduleDocId(schedule),
        originalSection,
        scheduleGroupId,
        sharedScheduleId,
        entriesBaseline: JSON.parse(JSON.stringify(baselineEntries)),
        setBEntries: existingSetB ? JSON.parse(JSON.stringify(existingSetB.entries || [])) : null,
        classifications
    };

    // If fresh split, automatically reschedule Set B's major subjects to alternative, non-conflicting slots
    if (!isManage || !currentSplitContext.setBEntries || !currentSplitContext.setBEntries.length) {
        currentSplitContext.setBEntries = generateAlternativeScheduleForSetB(
            currentSplitContext.entriesBaseline,
            classifications,
            schedule,
            null
        );
    }

    if (splitModalTitle) {
        splitModalTitle.textContent = isManage
            ? `Manage Sets — ${originalSection}`
            : `Split Section into Sets — ${originalSection}`;
    }

    if (splitModalSubtitle) {
        splitModalSubtitle.textContent = [
            schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
            schedule.semester,
            schedule.yearLevel,
            `Original Section: ${originalSection}`
        ].filter(Boolean).join(" • ");
    }

    if (setACardTitle) setACardTitle.textContent = `${originalSection} Set A`;
    if (setBCardTitle) setBCardTitle.textContent = `${originalSection} Set B`;

    // Check if any subjects have ambiguous/missing classification from curriculum
    const ambiguousSubjects = [...classifications.entries()].filter(([code, info]) => info.isAmbiguous);
    if (ambiguousSubjects.length > 0 && splitAmbiguousAlert) {
        splitAmbiguousAlert.style.display = "block";
        const subjectList = ambiguousSubjects.map(([code, info]) => `<strong>${escapeHtml(code)}</strong> (${info.type})`).join(", ");
        splitAmbiguousAlert.innerHTML = `
            <strong>⚠️ Missing Curriculum Classification Notice:</strong>
            The following subjects could not be found in the prospectus and were assigned default classifications: ${subjectList}.
            Major subjects have independent schedules in Set B, while Minor, Activity, and Research subjects are shared.
        `;
    } else if (splitAmbiguousAlert) {
        splitAmbiguousAlert.style.display = "none";
        splitAmbiguousAlert.innerHTML = "";
    }

    renderSplitSetsPreview();

    if (splitScheduleModal) splitScheduleModal.style.display = "flex";
}

function closeSplitScheduleModal() {
    if (splitScheduleModal) splitScheduleModal.style.display = "none";
    currentSplitContext = null;
    if (splitConflictsBanner) {
        splitConflictsBanner.style.display = "none";
        splitConflictsBanner.innerHTML = "";
    }
    if (splitResolutionsContainer) {
        splitResolutionsContainer.style.display = "none";
        splitResolutionsContainer.innerHTML = "";
    }
    if (splitAmbiguousAlert) {
        splitAmbiguousAlert.style.display = "none";
        splitAmbiguousAlert.innerHTML = "";
    }
}

closeSplitScheduleModalBtn?.addEventListener("click", closeSplitScheduleModal);
cancelSplitScheduleBtn?.addEventListener("click", closeSplitScheduleModal);
splitScheduleModal?.addEventListener("click", e => {
    if (e.target === splitScheduleModal) closeSplitScheduleModal();
});
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && splitScheduleModal?.style.display === "flex") closeSplitScheduleModal();
});

confirmSplitScheduleBtn?.addEventListener("click", async () => {
    if (!currentSplitContext) return;

    // Validate entries
    const setAEntries = readSplitSetEntries("Set A");
    const setBEntries = readSplitSetEntries("Set B");

    for (const entry of setAEntries) {
        if (!entry.day || !entry.time || !entry.room) {
            showToast(`Please complete Day, Time, and Room for Set A: ${entry.code}`);
            return;
        }
    }

    for (const entry of setBEntries) {
        if (!entry.day || !entry.time || !entry.room) {
            showToast(`Please complete Day, Time, and Room for Set B: ${entry.code}`);
            return;
        }
    }

    const isValid = runSplitConflictCheck();
    if (!isValid) {
        showToast("Please resolve all scheduling conflicts before confirming the split.");
        return;
    }

    confirmSplitScheduleBtn.disabled = true;
    confirmSplitScheduleBtn.innerHTML = `<span class="btn-spinner"></span> Saving Sets...`;

    try {
        const scheduleMeta = currentSplitContext.originalSchedule;
        const originalSection = currentSplitContext.originalSection;
        const scheduleGroupId = currentSplitContext.scheduleGroupId;
        const sharedScheduleId = currentSplitContext.sharedScheduleId;

        // Plain object for classifications
        const subjectClassifications = {};
        for (const [code, info] of currentSplitContext.classifications.entries()) {
            subjectClassifications[code] = info.type;
        }

        // Helper to rebuild discrete raw entries
        const buildRaw = (entries, secName) => {
            const raw = [];
            entries.forEach(entry => {
                const days = String(entry.day || "").split(" / ").map(d => d.trim()).filter(Boolean);
                const times = String(entry.time || "").split(" / ").map(t => t.trim()).filter(Boolean);
                const rooms = String(entry.room || "").split(" / ").map(r => r.trim()).filter(Boolean);
                const maxLen = Math.max(days.length, times.length, rooms.length, 1);
                for (let i = 0; i < maxLen; i++) {
                    raw.push({
                        code: entry.code,
                        name: entry.name,
                        units: entry.units,
                        day: days[i] || days[0] || entry.day,
                        time: times[i] || times[0] || entry.time,
                        room: rooms[i] || rooms[0] || entry.room,
                        roomCode: "",
                        faculty: entry.faculty || "Unassigned",
                        facultyUid: entry.facultyUid || "",
                        facultyId: entry.facultyId || "",
                        section: secName,
                        scheduleGroupId,
                        originalSection,
                        isSplit: true,
                        sharedScheduleId
                    });
                }
            });
            return raw;
        };

        const setASection = `${originalSection} Set A`;
        const setBSection = `${originalSection} Set B`;

        const setAData = {
            name: setASection,
            section: setASection,
            originalSection: originalSection,
            setName: "Set A",
            scheduleGroupId: scheduleGroupId,
            sharedScheduleId: sharedScheduleId,
            isSplit: true,
            subjectClassifications,
            semester: scheduleMeta.semester,
            program: scheduleMeta.program,
            major: scheduleMeta.major,
            yearLevel: scheduleMeta.yearLevel,
            academicYear: scheduleMeta.academicYear || "",
            entries: setAEntries,
            rawEntries: buildRaw(setAEntries, setASection),
            status: scheduleMeta.status || "draft",
            createdAt: scheduleMeta.createdAt ? new Date(scheduleMeta.createdAt) : new Date(),
            updatedAt: new Date(),
            savedBy: auth.currentUser?.uid || null
        };

        const setBData = {
            name: setBSection,
            section: setBSection,
            originalSection: originalSection,
            setName: "Set B",
            scheduleGroupId: scheduleGroupId,
            sharedScheduleId: sharedScheduleId,
            isSplit: true,
            subjectClassifications,
            semester: scheduleMeta.semester,
            program: scheduleMeta.program,
            major: scheduleMeta.major,
            yearLevel: scheduleMeta.yearLevel,
            academicYear: scheduleMeta.academicYear || "",
            entries: setBEntries,
            rawEntries: buildRaw(setBEntries, setBSection),
            status: scheduleMeta.status || "draft",
            createdAt: scheduleMeta.createdAt ? new Date(scheduleMeta.createdAt) : new Date(),
            updatedAt: new Date(),
            savedBy: auth.currentUser?.uid || null
        };

        const setADocId = scheduleDocId(setAData);
        const setBDocId = scheduleDocId(setBData);

        // Atomic write in Firestore
        const batch = writeBatch(db);
        batch.set(doc(db, SCHEDULES_COLLECTION, setADocId), setAData);
        batch.set(doc(db, SCHEDULES_COLLECTION, setBDocId), setBData);

        // If the original schedule had an unsplit document (different from setADocId and setBDocId), delete it atomically
        const origDocId = currentSplitContext.originalDocId;
        if (origDocId && origDocId !== setADocId && origDocId !== setBDocId) {
            batch.delete(doc(db, SCHEDULES_COLLECTION, origDocId));
            console.log("Atomic batch: unsplit parent schedule removed:", origDocId);
        }

        await batch.commit();
        console.log(`Successfully split and saved ${setADocId} and ${setBDocId} in Firestore.`);

        // Sync local storage from Firestore
        const freshFirestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(freshFirestoreSchedules);
        renderSavedSchedules();
        if (typeof renderArchive === "function") renderArchive();

        closeSplitScheduleModal();
        showSuccessOverlay(`✓ Successfully split ${originalSection} into Set A and Set B!`);
    } catch (err) {
        console.error("Could not save split sets to Firestore:", err);
        showToast(`Failed to save sets: ${err.message}`);
    } finally {
        confirmSplitScheduleBtn.disabled = false;
        confirmSplitScheduleBtn.textContent = "Confirm & Save Sets";
    }
});

savedSchedulesList.addEventListener("click", async event => {
    // Split into Sets
    const splitBtn = event.target.closest("[data-split-schedule]");
    if (splitBtn) {
        openSplitScheduleModal(splitBtn.dataset.splitSchedule, false);
        return;
    }

    // Manage Sets
    const manageBtn = event.target.closest("[data-manage-sets]");
    if (manageBtn) {
        openSplitScheduleModal(manageBtn.dataset.manageSets, true);
        return;
    }

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
            const result = await publishClassScheduleApi(schedule);

            /* Reload from Firestore to get authoritative data */
            const firestoreSchedules = await loadSchedulesFromFirestore();
            setSavedSchedules(firestoreSchedules);
            renderSavedSchedules();

            const sentMsg = result && result.sentCount != null ? ` ${result.sentCount} email notification(s) sent.` : "";
            showSuccessOverlay(`Schedule published!${sentMsg}`);
        } catch (err) {
            console.error("Could not publish schedule:", err);
            btn.disabled = false;
            btn.textContent = origText;
            showToast("Failed to publish schedule. Please try again.");
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
    onAuthStateChanged(auth, async user => {
        if (!user) {
            window.location.replace("login.html");
            return;
        }
        try {
            const profile = await getDoc(doc(db, "users", user.uid));
            if (!profile.exists() || profile.data().role !== "Admin") {
                window.location.replace("login.html");
                return;
            }
        } catch (_) {}
    });

    document.getElementById("logoutLink")?.addEventListener("click", async e => {
        e.preventDefault();
        await signOut(auth);
        window.location.replace("login.html");
    });

    await Promise.all([
        loadFacultyMembers(),
        loadFacultySubjectAssignments(),
        loadFacultyRoomPreferences(),
        loadSectionsFromFirestore(),
        loadRooms()
    ]);

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
                successCount++;
                const result = await publishClassScheduleApi(schedule);
                if (result && result.sentCount) totalSent += result.sentCount;
            } catch (err) {
                console.error("Could not publish class schedule:", schedule.name || schedule.id, err);
            }
        }

        /* Reload from Firestore to get authoritative data */
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        const emailInfo = totalSent > 0 ? ` (${totalSent} notification(s) sent)` : "";
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

// ===================================================
// PDF GENERATION (SCHEDULE ARCHIVE FORMAT)
// ===================================================
function openPrintWindow(htmlContent) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
        showToast("The print window was blocked by the browser. Please allow popups.");
        return;
    }

    printWindow.document.write(htmlContent || "<p>No content available.</p>");
    printWindow.document.close();
    printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
    };
    setTimeout(() => {
        try {
            printWindow.focus();
            printWindow.print();
        } catch (_) {}
    }, 700);
}

function generateSingleClassScheduleBody(schedule, logoUrl, logoUrl1) {
    const sectionName = escapeHtml(schedule.name || schedule.section || "Class Schedule");
    const ay = schedule.academicYear ? `A.Y. ${escapeHtml(schedule.academicYear)}` : "";
    const sem = escapeHtml(schedule.semester || "");
    const yl = escapeHtml(schedule.yearLevel || "");
    const subTitle = [ay, sem, yl].filter(Boolean).join(" • ");

    const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

    const rowsHtml = entries.length ? entries.map(item => `
        <tr>
            <td style="font-weight:bold;">${escapeHtml(item.code || "—")}</td>
            <td>${escapeHtml(item.name || "—")}</td>
            <td style="text-align:center;">${escapeHtml(item.units || "—")}</td>
            <td>${escapeHtml(item.day || "—")}</td>
            <td>${escapeHtml(item.time || "—")}</td>
            <td>${escapeHtml(item.room || "—")}</td>
            <td>${escapeHtml(item.faculty || "Unassigned")}</td>
        </tr>
    `).join("") : `<tr><td colspan="7" style="text-align:center; padding:12px;">No subjects recorded.</td></tr>`;

    return `
        <div class="class-schedule-page">
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
            <div class="title-section">CLASS SCHEDULE</div>
            <div class="section-row">${sectionName}${subTitle ? ` &mdash; ${subTitle}` : ""}</div>
            <table class="schedule-table">
                <thead>
                    <tr>
                        <th style="width:14%;">SUBJECT CODE</th>
                        <th style="width:30%;">SUBJECT NAME</th>
                        <th style="width:8%; text-align:center;">UNITS</th>
                        <th style="width:14%;">DAY</th>
                        <th style="width:14%;">TIME</th>
                        <th style="width:10%;">ROOM</th>
                        <th style="width:10%;">FACULTY</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
}

function generateAllClassPdfHtml(schedules) {
    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    const pagesHtml = schedules.map(s => generateSingleClassScheduleBody(s, logoUrl, logoUrl1)).join("");

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Class Schedules - SLSU Lucena</title>
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 0; margin: 0; }
            .class-schedule-page {
                page-break-after: always;
                break-after: page;
                padding: 10px;
            }
            .class-schedule-page:last-child {
                page-break-after: auto;
                break-after: auto;
            }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .logo-left, .logo-right { flex-shrink: 0; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #000000; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 10px 0; }
            .title-section { text-align: center; font-size: 14px; font-weight: bold; color: #000000; margin-bottom: 10px; text-decoration: underline; }
            .section-row { text-align: center; font-size: 12px; font-weight: bold; color: #555; padding: 4px 10px 10px; }
            .schedule-table { width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 6px; }
            .schedule-table th, .schedule-table td { border: 1px solid #888888; padding: 5px 6px; text-align: left; }
            .schedule-table th { background: #a7c7a3; color: #1b5e20; font-weight: bold; text-align: center; }
            .schedule-table td { vertical-align: middle; }
            .schedule-table tbody tr:nth-child(even) { background: #f7f7f7; }
        </style>
    </head>
    <body>
        ${pagesHtml}
    </body>
    </html>`;
}

document.getElementById("exportAllClassPdfBtn")?.addEventListener("click", () => {
    const allActiveSchedules = getSavedSchedules().filter(
        schedule => (schedule.status || "draft") !== "archived"
    );
    if (!allActiveSchedules.length) {
        showToast("No active saved schedules to export.");
        return;
    }

    const query = (savedScheduleSearchInput?.value || "").trim().toLowerCase();
    const schedulesToExport = query
        ? allActiveSchedules.filter(s => scheduleMatchesSavedSearch(s, query))
        : allActiveSchedules;

    if (!schedulesToExport.length) {
        showToast("No saved schedules match your search to export.");
        return;
    }

    const html = generateAllClassPdfHtml(schedulesToExport);
    openPrintWindow(html);
});

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
