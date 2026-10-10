import { auth, db } from "../firebase.js";
import { renderClassCalendar } from "./js/schedule-calendar.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    doc,
    getDoc,
    getDocs,
    collection,
    query,
    where,
    setDoc,
    updateDoc,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ==========================================================================
   STATE
========================================================================== */
let allFaculty = [];
let allClasses = []; // Flat list of all discrete class entries from classSchedules
let rawClassSchedules = []; // Full schedule documents
let allRooms = []; // Loaded rooms from Firestore/defaults
let facultySubjectAssignmentsMap = new Map(); // facultyId -> subjectKeys[]
let facultyRoomPreferencesMap = new Map(); // facultyUid / id -> roomPreferences object
let currentEditContext = null; // Currently editing schedule row
let currentRoomSwitchContext = null; // Currently reviewing room switch
let currentViewMode = "cards"; // "cards" | "table"

let currentAyFilter = "";
let currentSemFilter = "";
let currentDeptFilter = "";
let currentSearchQuery = "";

/* DOM Elements */
const adminNameEl = document.getElementById("adminName");
const loadingNotice = document.getElementById("loadingNotice");
const totalFacultyCountEl = document.getElementById("totalFacultyCount");
const assignedFacultyCountEl = document.getElementById("assignedFacultyCount");
const totalSectionsCountEl = document.getElementById("totalSectionsCount");
const totalTeachingHoursCountEl = document.getElementById("totalTeachingHoursCount");

const viewCardsBtn = document.getElementById("viewCardsBtn");
const viewTableBtn = document.getElementById("viewTableBtn");
const facultyCardsContainer = document.getElementById("facultyCardsContainer");
const facultyTableContainer = document.getElementById("facultyTableContainer");
const facultyLoadingTableBody = document.getElementById("facultyLoadingTableBody");
const emptyFacultyLoading = document.getElementById("emptyFacultyLoading");

const facultySearchInput = document.getElementById("facultySearchInput");
const facultyAyFilter = document.getElementById("facultyAyFilter");
const facultySemFilter = document.getElementById("facultySemFilter");
const facultyDeptFilter = document.getElementById("facultyDeptFilter");

const openAssignModalBtn = document.getElementById("openAssignModalBtn");
const assignFacultyModal = document.getElementById("assignFacultyModal");
const closeAssignModalBtn = document.getElementById("closeAssignModalBtn");
const cancelAssignModalBtn = document.getElementById("cancelAssignModalBtn");
const assignFacultyForm = document.getElementById("assignFacultyForm");
const assignFacultySelect = document.getElementById("assignFacultySelect");
const assignScheduleSelect = document.getElementById("assignScheduleSelect");
const assignSubjectSelect = document.getElementById("assignSubjectSelect");
const assignClassDetails = document.getElementById("assignClassDetails");
const assignDetailDay = document.getElementById("assignDetailDay");
const assignDetailTime = document.getElementById("assignDetailTime");
const assignDetailRoom = document.getElementById("assignDetailRoom");
const assignDetailHours = document.getElementById("assignDetailHours");
const assignConflictNotice = document.getElementById("assignConflictNotice");
const saveAssignmentBtn = document.getElementById("saveAssignmentBtn");

const facultyTimetableModal = document.getElementById("facultyTimetableModal");
const closeFtModalBtn = document.getElementById("closeFtModalBtn");
const closeFtBtn = document.getElementById("closeFtBtn");
const ftModalTitle = document.getElementById("ftModalTitle");
const ftModalSubtitle = document.getElementById("ftModalSubtitle");
const ftSummaryBox = document.getElementById("ftSummaryBox");
const ftCalendarBody = document.getElementById("ftCalendarBody");

/* Modal Elements: Edit Schedule Details & Room Resolutions */
const editScheduleDetailModal = document.getElementById("editScheduleDetailModal");
const editDetailSubtitle = document.getElementById("editDetailSubtitle");
const closeEditDetailModalBtn = document.getElementById("closeEditDetailModalBtn");
const cancelEditDetailBtn = document.getElementById("cancelEditDetailBtn");
const saveEditDetailBtn = document.getElementById("saveEditDetailBtn");

const editDetailSubjectDisplay = document.getElementById("editDetailSubjectDisplay");
const editDetailSectionDisplay = document.getElementById("editDetailSectionDisplay");
const editDetailFacultyDisplay = document.getElementById("editDetailFacultyDisplay");
const editDetailHoursDisplay = document.getElementById("editDetailHoursDisplay");
const editDetailPrefBanner = document.getElementById("editDetailPrefBanner");
const editDetailPrefTitle = document.getElementById("editDetailPrefTitle");
const editDetailPrefText = document.getElementById("editDetailPrefText");

const editDetailDaySelect = document.getElementById("editDetailDaySelect");
const editDetailRoomSelect = document.getElementById("editDetailRoomSelect");
const editDetailStartTimeSelect = document.getElementById("editDetailStartTimeSelect");
const editDetailEndTimeSelect = document.getElementById("editDetailEndTimeSelect");
const editDetailTimeSlotPreset = document.getElementById("editDetailTimeSlotPreset");
const editDetailActiveSlotDisplay = document.getElementById("editDetailActiveSlotDisplay");
const editDetailDurationDisplay = document.getElementById("editDetailDurationDisplay");

const editDetailOverrideBox = document.getElementById("editDetailOverrideBox");
const editDetailOverrideText = document.getElementById("editDetailOverrideText");
const editDetailConfirmOverrideBtn = document.getElementById("editDetailConfirmOverrideBtn");

const editDetailConflictPanel = document.getElementById("editDetailConflictPanel");
const editDetailConflictSummary = document.getElementById("editDetailConflictSummary");
const editDetailConflictList = document.getElementById("editDetailConflictList");

const editDetailResolutionsSection = document.getElementById("editDetailResolutionsSection");
const editDetailResolutionsList = document.getElementById("editDetailResolutionsList");

/* Modal Elements: Review Room Switch */
const roomSwitchReviewModal = document.getElementById("roomSwitchReviewModal");
const closeRoomSwitchModalBtn = document.getElementById("closeRoomSwitchModalBtn");
const cancelRoomSwitchBtn = document.getElementById("cancelRoomSwitchBtn");
const applyRoomSwitchBtn = document.getElementById("applyRoomSwitchBtn");
const switchValidationNotice = document.getElementById("switchValidationNotice");

const switchClass1Header = document.getElementById("switchClass1Header");
const switchClass1Section = document.getElementById("switchClass1Section");
const switchClass1Subject = document.getElementById("switchClass1Subject");
const switchClass1Faculty = document.getElementById("switchClass1Faculty");
const switchClass1Time = document.getElementById("switchClass1Time");
const switchClass1ProposedRoom = document.getElementById("switchClass1ProposedRoom");

const switchClass2Header = document.getElementById("switchClass2Header");
const switchClass2Section = document.getElementById("switchClass2Section");
const switchClass2Subject = document.getElementById("switchClass2Subject");
const switchClass2Faculty = document.getElementById("switchClass2Faculty");
const switchClass2Time = document.getElementById("switchClass2Time");
const switchClass2ProposedRoom = document.getElementById("switchClass2ProposedRoom");



const customToast = document.getElementById("customToast");
const customToastMessage = document.getElementById("customToastMessage");
const customToastClose = document.getElementById("customToastClose");

const customConfirmModal = document.getElementById("customConfirmModal");
const customConfirmMessage = document.getElementById("customConfirmMessage");
const customConfirmCancel = document.getElementById("customConfirmCancel");
const customConfirmOk = document.getElementById("customConfirmOk");

/* ==========================================================================
   UTILITY HELPERS
========================================================================== */
function escapeHtml(val) {
    return String(val ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
}

function showToast(msg) {
    if (!customToast || !customToastMessage) { alert(msg); return; }
    customToastMessage.textContent = msg;
    customToast.style.display = "flex";
    setTimeout(() => { if (customToast) customToast.style.display = "none"; }, 3200);
}

if (customToastClose) {
    customToastClose.addEventListener("click", () => {
        if (customToast) customToast.style.display = "none";
    });
}

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
            customConfirmCancel?.removeEventListener("click", onCancel);
            customConfirmOk?.removeEventListener("click", onOk);
        }
        function onCancel() { cleanup(); resolve(false); }
        function onOk() { cleanup(); resolve(true); }

        customConfirmCancel?.addEventListener("click", onCancel);
        customConfirmOk?.addEventListener("click", onOk);
    });
}

function parseTime(val) {
    if (!val) return 0;
    const str = String(val).trim().toUpperCase();
    const isPM = str.includes("PM");
    const isAM = str.includes("AM");
    const cleanStr = str.replace(/[^\d:]/g, "");
    const parts = cleanStr.split(":").map(Number);
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;

    if (isPM && hour < 12) hour += 12;
    else if (isAM && hour === 12) hour = 0;
    else if (!isAM && !isPM && hour >= 1 && hour <= 6) hour += 12;

    return hour * 60 + minute;
}

function parseTimeRange(slotStr) {
    if (!slotStr || !slotStr.includes("-")) return null;
    const parts = slotStr.split("-");
    if (parts.length !== 2) return null;
    const start = parseTime(parts[0]);
    const end = parseTime(parts[1]);
    if (start >= end) return null;
    return { start, end };
}

function timesOverlap(t1, t2) {
    if (!t1 || !t2 || !t1.includes("-") || !t2.includes("-")) return false;
    const r1 = parseTimeRange(t1);
    const r2 = parseTimeRange(t2);
    if (!r1 || !r2) return false;
    return r1.start < r2.end && r2.start < r1.end;
}

function calculateClassDurationHours(timeStr, unitsFallback = 3) {
    const range = parseTimeRange(timeStr);
    if (range) {
        const diffMinutes = range.end - range.start;
        if (diffMinutes > 0) {
            return Number((diffMinutes / 60).toFixed(1));
        }
    }
    return Number(unitsFallback) || 3;
}

function minutesToDisplay(totalMinutes) {
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
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

function isGymOrCourtRoom(r) {
    if (!r) return false;
    const str = String(r).toLowerCase();
    return str.includes("court") || str.includes("gym") || str.includes("covered");
}

function getDefaultRooms() {
    return [
        { id: "ADM204", roomCode: "ADM204", roomName: "Room 204", roomType: "Lecture Room", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "ADM205", roomCode: "ADM205", roomName: "Room 205", roomType: "Lecture Room", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "ADM206", roomCode: "ADM206", roomName: "Room 206", roomType: "Lecture Room", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "ADM207", roomCode: "ADM207", roomName: "Room 207", roomType: "Lecture Room", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "CET01", roomCode: "CET01", roomName: "CET Center", roomType: "Laboratory", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "CET02", roomCode: "CET02", roomName: "CET Shop", roomType: "Laboratory", building: "Admin Building", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "A101", roomCode: "A101", roomName: "Room A101", roomType: "Lecture Room", building: "Building A", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "A102", roomCode: "A102", roomName: "Room A102", roomType: "Lecture Room", building: "Building A", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "A103", roomCode: "A103", roomName: "Room A103", roomType: "Special Room", building: "Building A", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "A104", roomCode: "A104", roomName: "Room A104", roomType: "Special Room", building: "Building A", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "A201", roomCode: "A201", roomName: "Room A201", roomType: "Lecture Room", building: "Building A", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "A202", roomCode: "A202", roomName: "Room A202", roomType: "Lecture Room", building: "Building A", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "A203", roomCode: "A203", roomName: "Room A203", roomType: "Lecture Room", building: "Building A", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "A204", roomCode: "A204", roomName: "Room A204", roomType: "Lecture Room", building: "Building A", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "A301", roomCode: "A301", roomName: "Room A301", roomType: "Lecture Room", building: "Building A", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "A302", roomCode: "A302", roomName: "Room A302", roomType: "Lecture Room", building: "Building A", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "A303", roomCode: "A303", roomName: "Room A303", roomType: "Lecture Room", building: "Building A", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "A304", roomCode: "A304", roomName: "Room A304", roomType: "Lecture Room", building: "Building A", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "B101", roomCode: "B101", roomName: "Room B101", roomType: "Lecture Room", building: "Building B", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "B102", roomCode: "B102", roomName: "Room B102", roomType: "Lecture Room", building: "Building B", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "B103", roomCode: "B103", roomName: "Room B103", roomType: "Lecture Room", building: "Building B", floor: 1, capacity: 50, status: "AVAILABLE" },
        { id: "B201", roomCode: "B201", roomName: "Room B201", roomType: "Lecture Room", building: "Building B", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "B202", roomCode: "B202", roomName: "Room B202", roomType: "Lecture Room", building: "Building B", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "B203", roomCode: "B203", roomName: "Room B203", roomType: "Lecture Room", building: "Building B", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "B204", roomCode: "B204", roomName: "Room B204", roomType: "Laboratory", building: "Building B", floor: 2, capacity: 50, status: "AVAILABLE" },
        { id: "B301", roomCode: "B301", roomName: "Room B301", roomType: "Lecture Room", building: "Building B", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "B302", roomCode: "B302", roomName: "Room B302", roomType: "Avr", building: "Building B", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "B303", roomCode: "B303", roomName: "Room B303", roomType: "Avr", building: "Building B", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "B304", roomCode: "B304", roomName: "Room B304", roomType: "Lecture Room", building: "Building B", floor: 3, capacity: 50, status: "AVAILABLE" },
        { id: "FSML01", roomCode: "FSML01", roomName: "FSM Laboratory", roomType: "FSM Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "ATL01", roomCode: "ATL01", roomName: "AT Laboratory", roomType: "AT Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "MTL01", roomCode: "MTL01", roomName: "MT Laboratory", roomType: "MT Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "CTL01", roomCode: "CTL01", roomName: "CT Laboratory", roomType: "CT Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "ELTL01", roomCode: "ELTL01", roomName: "ELT Laboratory", roomType: "ELT Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "ELXL01", roomCode: "ELXL01", roomName: "ELX Laboratory", roomType: "ELX Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "CPL01", roomCode: "CPL01", roomName: "CP Laboratory", roomType: "CP Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" },
        { id: "CPTL01", roomCode: "CPTL01", roomName: "CPT Laboratory", roomType: "CPT Laboratory", building: "Building A", floor: 1, capacity: 40, status: "AVAILABLE" }
    ];
}

async function loadRooms() {
    try {
        const snap = await getDocs(collection(db, "rooms"));
        const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (raw.length > 0) {
            allRooms = raw.map(r => ({
                id: r.id,
                roomCode: String(r.roomCode || r.id || "").trim(),
                roomName: String(r.roomName || r.roomCode || r.id || "").trim(),
                roomType: String(r.roomType || "Lecture Room").trim(),
                building: String(r.building || "").trim(),
                floor: Number(r.floor) || 1,
                capacity: Number(r.capacity) || 50,
                status: String(r.status || "AVAILABLE").toUpperCase()
            })).sort((a, b) => a.roomCode.localeCompare(b.roomCode, undefined, { numeric: true, sensitivity: 'base' }));
        } else {
            allRooms = getDefaultRooms();
        }
    } catch (err) {
        console.warn("Could not load rooms from Firestore:", err);
        allRooms = getDefaultRooms();
    }
}

function initTimeSelectOptions() {
    if (!editDetailStartTimeSelect || !editDetailEndTimeSelect) return;
    editDetailStartTimeSelect.innerHTML = "";
    editDetailEndTimeSelect.innerHTML = "";

    for (let m = 7 * 60; m <= 18 * 60 + 30; m += 30) {
        const disp = minutesToDisplay(m);
        editDetailStartTimeSelect.innerHTML += `<option value="${disp}">${disp}</option>`;
    }

    for (let m = 7 * 60 + 30; m <= 19 * 60; m += 30) {
        const disp = minutesToDisplay(m);
        editDetailEndTimeSelect.innerHTML += `<option value="${disp}">${disp}</option>`;
    }
}

function updateActiveTimeDisplay() {
    if (!editDetailStartTimeSelect || !editDetailEndTimeSelect) return;
    const sStr = editDetailStartTimeSelect.value;
    const eStr = editDetailEndTimeSelect.value;
    const sMins = parseTime(sStr);
    const eMins = parseTime(eStr);
    const timeFormatted = `${sStr} - ${eStr}`;

    if (editDetailActiveSlotDisplay && editDetailDaySelect) {
        editDetailActiveSlotDisplay.textContent = `${editDetailDaySelect.value}, ${timeFormatted}`;
    }

    if (editDetailDurationDisplay) {
        const diff = eMins - sMins;
        if (diff > 0) {
            const hrs = (diff / 60).toFixed(1);
            editDetailDurationDisplay.textContent = `Duration: ${hrs} hrs (${diff} mins)`;
            editDetailDurationDisplay.style.color = "#1b5e20";
        } else {
            editDetailDurationDisplay.textContent = "Invalid duration (End must be after Start)";
            editDetailDurationDisplay.style.color = "#b71c1c";
        }
    }
}

function populateEditRoomSelect(selectedRoom = "", facultyUid = null) {
    if (!editDetailRoomSelect) return;
    editDetailRoomSelect.innerHTML = `<option value="">-- Select Room --</option>`;

    const faculty = allFaculty.find(f => f.uid === facultyUid || f.id === facultyUid);
    const pref = faculty?.roomPreferences || (facultyUid ? facultyRoomPreferencesMap.get(facultyUid) : null) || {};

    const prefBuilding = pref.preferredBuilding || "";
    const prefRooms = Array.isArray(pref.preferredRooms) ? pref.preferredRooms : [];

    const preferredGroup = [];
    const adminGroup = [];
    const bldgAGroup = [];
    const bldgBGroup = [];
    const otherGroup = [];

    allRooms.forEach(r => {
        const isPref = (prefBuilding && r.building === prefBuilding) || prefRooms.some(pr => sameRoom(pr, r.roomCode));
        if (isPref) {
            preferredGroup.push(r);
        } else if (r.building === "Admin Building") {
            adminGroup.push(r);
        } else if (r.building === "Building A") {
            bldgAGroup.push(r);
        } else if (r.building === "Building B") {
            bldgBGroup.push(r);
        } else {
            otherGroup.push(r);
        }
    });

    function renderOptions(roomList) {
        return roomList.map(r => {
            const isSel = selectedRoom && sameRoom(selectedRoom, r.roomCode);
            const extra = r.capacity ? ` (Cap: ${r.capacity})` : "";
            return `<option value="${escapeHtml(r.roomCode)}" ${isSel ? 'selected' : ''}>${escapeHtml(r.roomCode)} - ${escapeHtml(r.roomName)}${extra}</option>`;
        }).join("");
    }

    if (preferredGroup.length > 0) {
        editDetailRoomSelect.innerHTML += `
            <optgroup label="⭐ Preferred Rooms (${escapeHtml(prefBuilding || 'Configured')})">
                ${renderOptions(preferredGroup)}
            </optgroup>
        `;
    }

    if (adminGroup.length > 0) {
        editDetailRoomSelect.innerHTML += `
            <optgroup label="Admin Building">
                ${renderOptions(adminGroup)}
            </optgroup>
        `;
    }

    if (bldgAGroup.length > 0) {
        editDetailRoomSelect.innerHTML += `
            <optgroup label="Building A">
                ${renderOptions(bldgAGroup)}
            </optgroup>
        `;
    }

    if (bldgBGroup.length > 0) {
        editDetailRoomSelect.innerHTML += `
            <optgroup label="Building B">
                ${renderOptions(bldgBGroup)}
            </optgroup>
        `;
    }

    if (otherGroup.length > 0) {
        editDetailRoomSelect.innerHTML += `
            <optgroup label="Laboratories & Other Facilities">
                ${renderOptions(otherGroup)}
            </optgroup>
        `;
    }

    if (selectedRoom && ![...editDetailRoomSelect.options].some(o => sameRoom(o.value, selectedRoom))) {
        editDetailRoomSelect.innerHTML += `<option value="${escapeHtml(selectedRoom)}" selected>${escapeHtml(selectedRoom)}</option>`;
    }
}

function normalizeFacultyName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameFaculty(f1, f2) {
    if (!f1 || !f2) return false;
    const n1 = normalizeFacultyName(f1);
    const n2 = normalizeFacultyName(f2);
    if (!n1 || !n2 || n1 === "unassigned" || n2 === "unassigned" || n1 === "tba" || n2 === "tba") return false;
    return n1 === n2;
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

        // Exact subject code match
        if (parsed.subjectCode !== cleanSubjectCode) continue;

        // Program match
        if (parsed.programCode && cleanProg && parsed.programCode !== cleanProg) continue;

        // Major match
        if (parsed.majorCode && cleanMaj && parsed.majorCode !== cleanMaj) continue;

        return true;
    }

    return false;
}

function getLoadStatus(totalHours) {
    if (totalHours <= 0) {
        return { text: "No Load", className: "load-none" };
    } else if (totalHours > 21) {
        return { text: "Over Capacity", className: "load-exceeded" };
    } else if (totalHours >= 19) {
        return { text: "Overload", className: "load-overload" };
    } else {
        return { text: "Normal Load", className: "load-normal" };
    }
}

/* ==========================================================================
   AUTHENTICATION
========================================================================== */
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

        if (adminNameEl) {
            adminNameEl.textContent = profile.data().fullName || "SLSU Admin";
        }

        await loadData();
    } catch (err) {
        console.error("Auth error:", err);
        if (loadingNotice) loadingNotice.textContent = "Unable to verify administrative credentials.";
    }
});

document.getElementById("logoutLink")?.addEventListener("click", async e => {
    e.preventDefault();
    await signOut(auth);
    window.location.replace("login.html");
});

/* ==========================================================================
   DATA LOADING
========================================================================== */
async function loadData() {
    if (loadingNotice) loadingNotice.style.display = "block";

    try {
        initTimeSelectOptions();

        await Promise.all([
            loadRooms(),
            loadFaculty(),
            loadFacultySubjectAssignments(),
            loadClassSchedules()
        ]);

        // Sync room preferences onto allFaculty records
        allFaculty.forEach(f => {
            f.roomPreferences = f.roomPreferences ||
                facultyRoomPreferencesMap.get(f.uid) ||
                facultyRoomPreferencesMap.get(f.id) ||
                (f.employeeId ? facultyRoomPreferencesMap.get(f.employeeId) : null) || null;
        });

        populateAcademicYearFilter();
        render();

        if (loadingNotice) loadingNotice.style.display = "none";
    } catch (err) {
        console.error("Failed to load data:", err);
        if (loadingNotice) loadingNotice.textContent = `Error loading faculty loading data: ${err.message}`;
    }
}

async function loadFaculty() {
    const usersSnap = await getDocs(collection(db, "users"));
    const facultyList = [];

    usersSnap.docs.forEach(d => {
        const u = d.data();
        if (String(u.role || "").trim().toLowerCase() === "faculty") {
            const prefs = u.roomPreferences || facultyRoomPreferencesMap.get(d.id) || null;
            facultyList.push({
                uid: d.id,
                id: d.id,
                employeeId: u.employeeId || u.facultyId || "",
                name: u.fullName || u.name || "Unknown Faculty",
                email: u.email || "",
                department: u.department || u.program || "General",
                roomPreferences: prefs
            });
        }
    });

    // Check legacy collection
    try {
        const legacySnap = await getDocs(collection(db, "faculty"));
        legacySnap.docs.forEach(d => {
            const f = d.data();
            const name = f.fullName || f.name || f.facultyName || "";
            if (name && !facultyList.some(x => x.name.toLowerCase() === name.toLowerCase())) {
                const prefs = f.roomPreferences || facultyRoomPreferencesMap.get(d.id) || null;
                facultyList.push({
                    uid: d.id,
                    id: d.id,
                    employeeId: f.employeeId || f.facultyId || "",
                    name: name,
                    email: f.email || "",
                    department: f.department || "General",
                    roomPreferences: prefs
                });
            }
        });
    } catch (_) {}

    facultyList.sort((a, b) => a.name.localeCompare(b.name));
    allFaculty = facultyList;
}

async function loadFacultySubjectAssignments() {
    try {
        const snap = await getDocs(collection(db, "facultySubjectAssignments"));
        facultySubjectAssignmentsMap.clear();
        snap.docs.forEach(d => {
            const data = d.data();
            const handled = Array.isArray(data.handledSubjects) ? data.handledSubjects : [];
            facultySubjectAssignmentsMap.set(d.id, handled);
            if (data.facultyId) facultySubjectAssignmentsMap.set(data.facultyId, handled);

            if (data.roomPreferences) {
                facultyRoomPreferencesMap.set(d.id, data.roomPreferences);
                if (data.facultyId) facultyRoomPreferencesMap.set(data.facultyId, data.roomPreferences);
            }
        });
    } catch (err) {
        console.warn("Could not load facultySubjectAssignments:", err);
    }
}

async function loadClassSchedules() {
    const snap = await getDocs(collection(db, "classSchedules"));
    rawClassSchedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const classItems = [];

    rawClassSchedules.forEach(schedule => {
        if (schedule.status === "archived") return;

        const ay = schedule.academicYear || "";
        const sem = schedule.semester || "";
        const prog = schedule.program || "";
        const sec = schedule.section || schedule.name || "";
        const entries = schedule.entries || [];

        entries.forEach((entry, entryIdx) => {
            const days = String(entry.day || "").split("/").map(s => s.trim()).filter(Boolean);
            const times = String(entry.time || "").split("/").map(s => s.trim()).filter(Boolean);
            const rooms = String(entry.room || "").split("/").map(s => s.trim()).filter(Boolean);

            const count = Math.max(days.length, 1);

            for (let i = 0; i < count; i++) {
                const day = days[i] || days[0] || "TBA";
                const time = times[i] || times[0] || "TBA";
                const room = rooms[i] || rooms[0] || "TBA";
                const hours = calculateClassDurationHours(time, entry.units);

                classItems.push({
                    scheduleId: schedule.id,
                    entryIndex: entryIdx,
                    multiIndex: i,
                    section: sec,
                    program: prog,
                    major: schedule.major || "",
                    yearLevel: schedule.yearLevel || "",
                    academicYear: ay,
                    semester: sem,
                    subjectCode: entry.code || "",
                    subjectName: entry.name || "",
                    units: Number(entry.units) || 3,
                    day,
                    time,
                    room,
                    hours,
                    faculty: entry.faculty || "Unassigned",
                    facultyId: entry.facultyId || "",
                    facultyUid: entry.facultyUid || "",
                    status: schedule.status || "draft"
                });
            }
        });
    });

    allClasses = classItems;
}

function populateAcademicYearFilter() {
    if (!facultyAyFilter) return;
    const ays = [...new Set(allClasses.map(c => c.academicYear).filter(Boolean))].sort();
    
    // Save current selection if any
    const curr = facultyAyFilter.value;
    facultyAyFilter.innerHTML = `<option value="">All Academic Years</option>`;
    ays.forEach(ay => {
        facultyAyFilter.innerHTML += `<option value="${escapeHtml(ay)}" ${ay === curr ? 'selected' : ''}>A.Y. ${escapeHtml(ay)}</option>`;
    });
}

/* ==========================================================================
   COMPUTATION & FILTERING
========================================================================== */
function getFilteredClasses() {
    return allClasses.filter(item => {
        if (currentAyFilter && item.academicYear !== currentAyFilter) return false;
        if (currentSemFilter) {
            const semStr = String(item.semester || "").toLowerCase();
            if (currentSemFilter === "1" && !semStr.includes("1")) return false;
            if (currentSemFilter === "2" && !semStr.includes("2")) return false;
        }
        if (currentDeptFilter && !item.program.toUpperCase().includes(currentDeptFilter.toUpperCase())) {
            return false;
        }
        if (currentSearchQuery) {
            const q = currentSearchQuery.toLowerCase();
            const matchName = item.faculty.toLowerCase().includes(q);
            const matchCode = item.subjectCode.toLowerCase().includes(q);
            const matchSubj = item.subjectName.toLowerCase().includes(q);
            const matchSec = item.section.toLowerCase().includes(q);
            if (!matchName && !matchCode && !matchSubj && !matchSec) return false;
        }
        return true;
    });
}

function computeFacultyLoads(filteredClasses) {
    return allFaculty.map(faculty => {
        // Classes assigned to this faculty member
        const assigned = filteredClasses.filter(c => {
            if (c.facultyUid) {
                return c.facultyUid === faculty.uid || c.facultyUid === faculty.id;
            }
            if (c.facultyId && faculty.employeeId) {
                return c.facultyId === faculty.employeeId;
            }
            return sameFaculty(c.faculty, faculty.name);
        });

        const uniqueSubjects = [...new Set(assigned.map(c => c.subjectCode))];
        const uniqueSections = [...new Set(assigned.map(c => c.section))];
        const totalHours = Number(assigned.reduce((sum, c) => sum + (Number(c.hours) || 0), 0).toFixed(1));

        return {
            ...faculty,
            assignedClasses: assigned,
            totalSubjects: uniqueSubjects.length,
            totalSections: uniqueSections.length,
            totalHours,
            loadStatus: getLoadStatus(totalHours)
        };
    }).filter(f => {
        // If department filter is active, only show faculty of that department or who have classes in that department
        if (currentDeptFilter) {
            const inDept = String(f.department || "").toUpperCase().includes(currentDeptFilter.toUpperCase());
            const hasClassInDept = f.assignedClasses.length > 0;
            if (!inDept && !hasClassInDept) return false;
        }
        // If search query is entered, check faculty name, employeeId, email
        if (currentSearchQuery) {
            const q = currentSearchQuery.toLowerCase();
            const matchFaculty = f.name.toLowerCase().includes(q) ||
                f.employeeId.toLowerCase().includes(q) ||
                f.email.toLowerCase().includes(q);
            const hasMatchingClass = f.assignedClasses.length > 0;
            if (!matchFaculty && !hasMatchingClass) return false;
        }
        return true;
    });
}

/* ==========================================================================
   RENDERING
========================================================================== */
function render() {
    const filteredClasses = getFilteredClasses();
    const facultyLoads = computeFacultyLoads(filteredClasses);

    // Update KPI stats
    if (totalFacultyCountEl) totalFacultyCountEl.textContent = allFaculty.length;
    if (assignedFacultyCountEl) {
        const assignedCount = facultyLoads.filter(f => f.totalHours > 0).length;
        assignedFacultyCountEl.textContent = assignedCount;
    }
    if (totalSectionsCountEl) {
        const secSet = new Set(filteredClasses.map(c => c.section));
        totalSectionsCountEl.textContent = secSet.size;
    }
    if (totalTeachingHoursCountEl) {
        const totalH = filteredClasses.reduce((sum, c) => sum + (Number(c.hours) || 0), 0);
        totalTeachingHoursCountEl.textContent = `${Number(totalH.toFixed(1))} hrs`;
    }

    if (currentViewMode === "cards") {
        renderCardsView(facultyLoads);
    } else {
        renderTableView(filteredClasses);
    }
}

function renderCardsView(facultyLoads) {
    if (!facultyCardsContainer) return;
    facultyCardsContainer.style.display = "grid";
    if (facultyTableContainer) facultyTableContainer.style.display = "none";

    if (facultyLoads.length === 0) {
        facultyCardsContainer.innerHTML = "";
        if (emptyFacultyLoading) emptyFacultyLoading.style.display = "block";
        return;
    }

    if (emptyFacultyLoading) emptyFacultyLoading.style.display = "none";

    facultyCardsContainer.innerHTML = facultyLoads.map(f => {
        const pref = f.roomPreferences || facultyRoomPreferencesMap.get(f.uid) || facultyRoomPreferencesMap.get(f.id) || {};
        const hasPrefs = Boolean(pref.preferredBuilding || (pref.preferredRooms && pref.preferredRooms.length > 0) || pref.accessibilityNotes);

        return `
            <div class="faculty-load-card">
                <div>
                    <div class="faculty-card-header">
                        <div>
                            <h4 class="faculty-card-name">${escapeHtml(f.name)}</h4>
                            <p class="faculty-card-sub">
                                ID: <strong>${escapeHtml(f.employeeId || "N/A")}</strong> • ${escapeHtml(f.department || "Faculty")}
                            </p>
                            ${hasPrefs ? `
                                <div style="margin-top:6px;">
                                    <span class="pref-pill ${pref.restrictedRoomList ? 'restricted' : ''}" title="${escapeHtml(pref.accessibilityNotes || 'Configured Preferences')}">
                                        ♿ ${escapeHtml(pref.preferredBuilding || (pref.preferredRooms?.length ? pref.preferredRooms.length + ' Preferred Rooms' : 'Preferences'))}
                                    </span>
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="faculty-stats-row">
                        <div class="faculty-stat-item">
                            <span class="faculty-stat-num">${f.totalSubjects}</span>
                            <span class="faculty-stat-label">Subjects</span>
                        </div>
                        <div class="faculty-stat-item">
                            <span class="faculty-stat-num">${f.totalSections}</span>
                            <span class="faculty-stat-label">Sections</span>
                        </div>
                        <div class="faculty-stat-item">
                            <span class="faculty-stat-num">${f.totalHours}</span>
                            <span class="faculty-stat-label">Hours</span>
                        </div>
                    </div>
                </div>

                <div class="faculty-card-actions">
                    <button type="button" class="btn-card-action btn-secondary-action view-timetable-btn" data-faculty-uid="${escapeHtml(f.uid)}">
                        View Timetable
                    </button>
                    <button type="button" class="btn-card-action btn-primary-action assign-to-faculty-btn" data-faculty-uid="${escapeHtml(f.uid)}">
                        Assign Class
                    </button>
                </div>
            </div>
        `;
    }).join("");

    // Attach listeners
    facultyCardsContainer.querySelectorAll(".view-timetable-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const uid = btn.dataset.facultyUid;
            openFacultyTimetableModal(uid);
        });
    });

    facultyCardsContainer.querySelectorAll(".assign-to-faculty-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const uid = btn.dataset.facultyUid;
            openAssignModal(uid);
        });
    });
}

function renderTableView(filteredClasses) {
    if (!facultyTableContainer || !facultyLoadingTableBody) return;
    facultyTableContainer.style.display = "block";
    if (facultyCardsContainer) facultyCardsContainer.style.display = "none";

    if (filteredClasses.length === 0) {
        facultyLoadingTableBody.innerHTML = "";
        if (emptyFacultyLoading) emptyFacultyLoading.style.display = "block";
        return;
    }

    if (emptyFacultyLoading) emptyFacultyLoading.style.display = "none";

    facultyLoadingTableBody.innerHTML = filteredClasses.map(c => {
        const facObj = allFaculty.find(f => f.uid === c.facultyUid || sameFaculty(f.name, c.faculty));
        const facIdDisplay = facObj ? (facObj.employeeId || facObj.uid) : (c.facultyId || "—");

        return `
            <tr>
                <td><strong>${escapeHtml(c.faculty)}</strong></td>
                <td><span style="font-size:12px; color:#555;">${escapeHtml(facIdDisplay)}</span></td>
                <td>${escapeHtml(c.subjectName)}</td>
                <td><code>${escapeHtml(c.subjectCode)}</code></td>
                <td><strong>${escapeHtml(c.section)}</strong></td>
                <td>${escapeHtml(c.day)}</td>
                <td>${escapeHtml(c.time)}</td>
                <td>${escapeHtml(c.room)}</td>
                <td style="text-align:center;">${c.hours} hrs</td>
                <td style="text-align:center;">
                    <button type="button" class="reassign-btn" data-schedule-id="${escapeHtml(c.scheduleId)}" data-entry-idx="${c.entryIndex}" style="background:#2e7d32; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; font-weight:bold; margin-right:4px;">
                        Reassign
                    </button>
                    <button type="button" class="unassign-btn" data-schedule-id="${escapeHtml(c.scheduleId)}" data-entry-idx="${c.entryIndex}" style="background:#c62828; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; font-weight:bold;">
                        Remove
                    </button>
                </td>
            </tr>
        `;
    }).join("");

    // Attach row listeners
    facultyLoadingTableBody.querySelectorAll(".reassign-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const schedId = btn.dataset.scheduleId;
            const entryIdx = Number(btn.dataset.entryIdx);
            openAssignModal(null, schedId, entryIdx);
        });
    });

    facultyLoadingTableBody.querySelectorAll(".unassign-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const schedId = btn.dataset.scheduleId;
            const entryIdx = Number(btn.dataset.entryIdx);
            removeAssignment(schedId, entryIdx);
        });
    });
}

/* ==========================================================================
   ASSIGN / REASSIGN MODAL WITH CONFLICT CHECK
========================================================================== */
function openAssignModal(preselectedFacultyUid = null, preselectedScheduleId = null, preselectedEntryIdx = null) {
    if (!assignFacultyModal) return;

    // Close any other open modals
    if (facultyTimetableModal) facultyTimetableModal.style.display = "none";
    if (customConfirmModal) customConfirmModal.style.display = "none";

    // Populate Faculty dropdown
    assignFacultySelect.innerHTML = `<option value="">-- Select Faculty Member --</option>`;
    allFaculty.forEach(f => {
        const isSel = preselectedFacultyUid && f.uid === preselectedFacultyUid;
        assignFacultySelect.innerHTML += `
            <option value="${escapeHtml(f.name)}" data-uid="${escapeHtml(f.uid)}" data-employee-id="${escapeHtml(f.employeeId || '')}" ${isSel ? 'selected' : ''}>
                ${escapeHtml(f.name)}${f.employeeId ? ' (' + escapeHtml(f.employeeId) + ')' : ''}
            </option>
        `;
    });

    // Populate Schedule / Section dropdown
    assignScheduleSelect.innerHTML = `<option value="">-- Select Class Schedule / Section --</option>`;
    rawClassSchedules.filter(s => s.status !== "archived").forEach(s => {
        const isSel = preselectedScheduleId && s.id === preselectedScheduleId;
        const label = `${s.section || s.name} (${s.academicYear || ''} ${s.semester || ''})`;
        assignScheduleSelect.innerHTML += `<option value="${escapeHtml(s.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    });

    // Populate Subject dropdown if schedule is selected
    populateModalSubjects(preselectedScheduleId, preselectedEntryIdx);

    assignConflictNotice.style.display = "none";
    assignConflictNotice.innerHTML = "";

    assignFacultyModal.style.display = "flex";
}

function populateModalSubjects(scheduleId = null, selectEntryIdx = null) {
    const sId = scheduleId || assignScheduleSelect.value;
    assignSubjectSelect.innerHTML = `<option value="">-- Select Subject --</option>`;
    assignClassDetails.style.display = "none";

    if (!sId) return;

    const sched = rawClassSchedules.find(s => s.id === sId);
    if (!sched || !Array.isArray(sched.entries)) return;

    sched.entries.forEach((e, idx) => {
        const isSel = selectEntryIdx !== null && selectEntryIdx === idx;
        assignSubjectSelect.innerHTML += `
            <option value="${idx}" ${isSel ? 'selected' : ''}>
                ${escapeHtml(e.code)} - ${escapeHtml(e.name)}
            </option>
        `;
    });

    if (selectEntryIdx !== null) {
        updateAssignClassDetails();
    }
}

function updateAssignClassDetails() {
    const sId = assignScheduleSelect.value;
    const entryIdx = assignSubjectSelect.value;

    if (!sId || entryIdx === "") {
        assignClassDetails.style.display = "none";
        return;
    }

    const sched = rawClassSchedules.find(s => s.id === sId);
    if (!sched || !sched.entries[entryIdx]) {
        assignClassDetails.style.display = "none";
        return;
    }

    const e = sched.entries[entryIdx];
    assignDetailDay.textContent = e.day || "TBA";
    assignDetailTime.textContent = e.time || "TBA";
    assignDetailRoom.textContent = e.room || "TBA";
    assignDetailHours.textContent = `${e.units || 3} units (${calculateClassDurationHours(e.time, e.units)} hrs)`;
    assignClassDetails.style.display = "block";

    // Re-filter the faculty dropdown to show only eligible faculty for this subject + curriculum
    const entryCriteria = {
        subjectCode: e.code || "",
        programCode: sched.program || "",
        majorCode: sched.major || "",
        yearLevel: sched.yearLevel || "",
        semester: sched.semester || "",
        section: sched.section || sched.name || ""
    };
    const currentFacultyName = assignFacultySelect.value;
    const currentFacultyUid = assignFacultySelect.selectedOptions[0]?.dataset?.uid || "";

    const eligibleForEntry = allFaculty.filter(f => {
        const handled = facultySubjectAssignmentsMap.get(f.uid) || facultySubjectAssignmentsMap.get(f.id) || [];
        // Graceful fallback: if no handled subjects recorded, show all faculty
        if (handled.length === 0) return true;
        return isFacultyEligibleForSubject(handled, entryCriteria);
    });

    // Preserve the currently selected faculty even if not eligible (visible warning will be shown)
    const listForDropdown = [...eligibleForEntry];
    if (currentFacultyName) {
        const alreadyIn = listForDropdown.some(f => sameFaculty(f.name, currentFacultyName) || f.uid === currentFacultyUid);
        if (!alreadyIn) {
            const currentFac = allFaculty.find(f => sameFaculty(f.name, currentFacultyName) || f.uid === currentFacultyUid);
            if (currentFac) listForDropdown.unshift(currentFac);
        }
    }

    assignFacultySelect.innerHTML = `<option value="">-- Select Faculty Member --</option>`;
    listForDropdown.forEach(f => {
        const isSel = currentFacultyUid ? f.uid === currentFacultyUid : sameFaculty(f.name, currentFacultyName);
        assignFacultySelect.innerHTML += `
            <option value="${escapeHtml(f.name)}" data-uid="${escapeHtml(f.uid)}" data-employee-id="${escapeHtml(f.employeeId || '')}" ${isSel ? 'selected' : ''}>
                ${escapeHtml(f.name)}${f.employeeId ? ' (' + escapeHtml(f.employeeId) + ')' : ''}
            </option>
        `;
    });

    validateCandidateAssignment();
}

function validateCandidateAssignment() {
    assignConflictNotice.style.display = "none";
    assignConflictNotice.innerHTML = "";
    saveAssignmentBtn.disabled = false;

    const facultyName = assignFacultySelect.value;
    const facultyUid = assignFacultySelect.selectedOptions[0]?.dataset?.uid || "";
    const sId = assignScheduleSelect.value;
    const entryIdx = assignSubjectSelect.value;

    if (!facultyName || !sId || entryIdx === "") return;

    const sched = rawClassSchedules.find(s => s.id === sId);
    if (!sched || !sched.entries[entryIdx]) return;

    const candidateEntry = sched.entries[entryIdx];

    // --- Eligibility check: faculty must have this subject in handled subjects for this curriculum ---
    const selectedFacultyObj = allFaculty.find(f => (facultyUid && f.uid === facultyUid) || sameFaculty(f.name, facultyName));
    if (selectedFacultyObj) {
        const handledList = facultySubjectAssignmentsMap.get(selectedFacultyObj.uid) ||
                            facultySubjectAssignmentsMap.get(selectedFacultyObj.id) || [];
        const criteria = {
            subjectCode: candidateEntry.code || "",
            programCode: sched.program || "",
            majorCode: sched.major || "",
            yearLevel: sched.yearLevel || "",
            semester: sched.semester || "",
            section: sched.section || sched.name || ""
        };
        if (handledList.length > 0 && !isFacultyEligibleForSubject(handledList, criteria)) {
            assignConflictNotice.innerHTML =
                `<strong>Eligibility Warning:</strong> ${escapeHtml(facultyName)} does not have ` +
                `<strong>${escapeHtml(candidateEntry.code || "")}</strong> listed as a handled subject ` +
                `for this curriculum (${escapeHtml(sched.program || "")} ${escapeHtml(sched.major || "")}).`;
            assignConflictNotice.style.display = "block";
            saveAssignmentBtn.disabled = true;
            return;
        }
    }

    const candDays = String(candidateEntry.day || "").split("/").map(s => s.trim());
    const candTimes = String(candidateEntry.time || "").split("/").map(s => s.trim());

    // Check conflict against ALL other classes this faculty has in the same AY & Semester
    const facultyClasses = allClasses.filter(c => {
        // Exclude the class currently being edited
        if (c.scheduleId === sId && c.entryIndex === Number(entryIdx)) return false;
        if (c.academicYear !== sched.academicYear || c.semester !== sched.semester) return false;
        if (c.facultyUid && (c.facultyUid === facultyUid)) return true;
        return sameFaculty(c.faculty, facultyName);
    });

    const conflicts = [];

    candDays.forEach((cDay, i) => {
        const cTime = candTimes[i] || candTimes[0] || "";
        if (!cDay || !cTime || cDay === "TBA" || cTime === "TBA") return;

        facultyClasses.forEach(fc => {
            if (fc.day.toLowerCase() === cDay.toLowerCase() && timesOverlap(fc.time, cTime)) {
                conflicts.push(
                    `<strong>Faculty Conflict on ${cDay}:</strong> ${facultyName} is already assigned to another class (${fc.section} - ${fc.subjectCode}) from ${fc.time}.`
                );
            }
        });
    });

    if (conflicts.length > 0) {
        assignConflictNotice.innerHTML = conflicts.join("<br>");
        assignConflictNotice.style.display = "block";
        saveAssignmentBtn.disabled = true;
    }
}

assignScheduleSelect.addEventListener("change", () => {
    populateModalSubjects();
    validateCandidateAssignment();
});

assignSubjectSelect.addEventListener("change", () => {
    updateAssignClassDetails();
});

assignFacultySelect.addEventListener("change", () => {
    validateCandidateAssignment();
});

assignFacultyForm.addEventListener("submit", async e => {
    e.preventDefault();

    const facultyName = assignFacultySelect.value;
    const facultyUid = assignFacultySelect.selectedOptions[0]?.dataset?.uid || "";
    const facultyId = assignFacultySelect.selectedOptions[0]?.dataset?.employeeId || "";
    const sId = assignScheduleSelect.value;
    const entryIdx = Number(assignSubjectSelect.value);

    if (!facultyName || !sId || isNaN(entryIdx)) {
        showToast("Please complete all required fields.");
        return;
    }

    const sched = rawClassSchedules.find(s => s.id === sId);
    if (!sched || !sched.entries[entryIdx]) {
        showToast("Class entry not found.");
        return;
    }

    // Update entry in schedule
    sched.entries[entryIdx].faculty = facultyName;
    sched.entries[entryIdx].facultyUid = facultyUid;
    sched.entries[entryIdx].facultyId = facultyId;

    try {
        saveAssignmentBtn.disabled = true;
        saveAssignmentBtn.textContent = "Saving...";

        await updateDoc(doc(db, "classSchedules", sId), {
            entries: sched.entries,
            updatedAt: new Date()
        });

        showToast(`Assigned ${facultyName} to ${sched.entries[entryIdx].code} successfully.`);
        assignFacultyModal.style.display = "none";

        // Reload data to synchronize
        await loadData();
    } catch (err) {
        console.error("Failed to save assignment:", err);
        showToast(`Failed to update assignment: ${err.message}`);
    } finally {
        saveAssignmentBtn.disabled = false;
        saveAssignmentBtn.textContent = "Save Assignment";
    }
});

async function removeAssignment(scheduleId, entryIndex) {
    const sched = rawClassSchedules.find(s => s.id === scheduleId);
    if (!sched || !sched.entries[entryIndex]) {
        showToast("Class schedule entry not found.");
        return;
    }

    const entry = sched.entries[entryIndex];
    const confirmed = await showConfirm(`Remove faculty assignment (${entry.faculty}) from ${entry.code} - ${entry.name}?`);
    if (!confirmed) return;

    entry.faculty = "Unassigned";
    entry.facultyUid = "";
    entry.facultyId = "";

    try {
        await updateDoc(doc(db, "classSchedules", scheduleId), {
            entries: sched.entries,
            updatedAt: new Date()
        });

        showToast("Assignment removed successfully.");
        await loadData();
    } catch (err) {
        console.error("Failed to remove assignment:", err);
        showToast(`Failed to remove assignment: ${err.message}`);
    }
}

/* ==========================================================================
   FACULTY TIMETABLE MODAL  (Calendar view)
========================================================================== */
function openFacultyTimetableModal(facultyUid) {
    const faculty = allFaculty.find(f => f.uid === facultyUid || f.id === facultyUid);
    if (!faculty) return;

    // Close any other open modals
    if (assignFacultyModal) assignFacultyModal.style.display = "none";
    if (customConfirmModal) customConfirmModal.style.display = "none";

    /* ── Collect this faculty's class entries ── */
    const filteredClasses = getFilteredClasses();
    const assigned = filteredClasses.filter(c => {
        if (c.facultyUid) {
            return c.facultyUid === faculty.uid || c.facultyUid === faculty.id;
        }
        if (c.facultyId && faculty.employeeId) {
            return c.facultyId === faculty.employeeId;
        }
        return sameFaculty(c.faculty, faculty.name);
    });

    /* ── Modal header ── */
    ftModalTitle.textContent = `${faculty.name} — Teaching Load`;
    ftModalSubtitle.textContent = `Faculty ID: ${faculty.employeeId || 'N/A'} • ${faculty.department || 'Faculty'}`;

    /* ── Summary stats ── */
    const uniqueSubjects = [...new Set(assigned.map(c => c.subjectCode))];
    const uniqueSections = [...new Set(assigned.map(c => c.section))];
    const totalHours = Number(assigned.reduce((sum, c) => sum + (Number(c.hours) || 0), 0).toFixed(1));
    const status = getLoadStatus(totalHours);

    const pref = faculty.roomPreferences || facultyRoomPreferencesMap.get(faculty.uid) || facultyRoomPreferencesMap.get(faculty.id);
    const prefDisplay = pref && (pref.preferredBuilding || (pref.preferredRooms && pref.preferredRooms.length > 0) || pref.accessibilityNotes)
        ? `<span class="pref-pill ${pref.restrictedRoomList ? 'restricted' : ''}">♿ ${escapeHtml(pref.preferredBuilding || (pref.preferredRooms?.length ? pref.preferredRooms.length + ' Rooms' : 'Configured'))}</span>`
        : `<span style="color:#777; font-size:12px;">Not Configured</span>`;

    ftSummaryBox.innerHTML = `
        <div><strong>Total Subjects:</strong> ${uniqueSubjects.length}</div>
        <div><strong>Total Sections:</strong> ${uniqueSections.length}</div>
        <div><strong>Teaching Hours:</strong> ${totalHours} hrs</div>
        <div><strong>Status:</strong> <span class="load-badge ${status.className}">${status.text}</span></div>
        <div><strong>Room Pref:</strong> ${prefDisplay}</div>
    `;

    /* ── Build a synthetic schedule object for renderClassCalendar ──
       The renderer expects entries with: code, name, day, time, room, section, units
       We derive these from the flat allClasses records.  */
    const entries = assigned.map(c => ({
        code:        c.subjectCode  || "",
        name:        c.subjectName  || "",
        day:         c.day          || "",
        time:        c.time         || "",
        room:        c.room         || "",
        section:     c.section      || "",
        units:       c.hours        || "",
        facultyName: faculty.name,
        facultyUid:  faculty.uid || faculty.id,
        scheduleId:  c.scheduleId   || "",
        entryIndex:  c.entryIndex,
        multiIndex:  c.multiIndex ?? 0
    }));

    if (entries.length === 0) {
        ftCalendarBody.innerHTML = `
            <div style="padding:40px 20px; text-align:center; color:#777; font-size:14px;
                        background:#fafaf7; border-radius:10px; border:1px solid #d0ccbf;">
                <div style="font-size:32px; margin-bottom:8px;">📅</div>
                <strong style="color:#333; font-size:15px;">No assigned classes for the selected academic period.</strong>
                <p style="margin-top:6px; font-size:12px; color:#888;">
                    This faculty member has no class assignments yet.
                </p>
            </div>`;
    } else {
        /* isFacultySchedule = true → conflict detection ON, Section shown in last col, showEditAction = true */
        const html = renderClassCalendar({
            entries,
            isFacultySchedule: true,
            showEditAction: true
        });
        ftCalendarBody.innerHTML = html;

        // Attach listeners for Edit buttons in Schedule Details table
        ftCalendarBody.querySelectorAll(".cal-edit-schedule-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const schedId = btn.dataset.schedId;
                const entryIdx = Number(btn.dataset.entryIdx);
                const multiIdx = Number(btn.dataset.multiIdx || 0);
                if (!schedId || isNaN(entryIdx)) return;
                openEditScheduleDetailModal(schedId, entryIdx, multiIdx, faculty.uid || faculty.id);
            });
        });

        // Attach listeners for single unassign clash buttons
        ftCalendarBody.querySelectorAll(".cal-unassign-clash-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const schedId = btn.dataset.schedId;
                const entryIdx = Number(btn.dataset.entryIdx);
                if (!schedId || isNaN(entryIdx)) return;
                await removeAssignment(schedId, entryIdx);
                openFacultyTimetableModal(facultyUid);
            });
        });

        // Attach listener for "Mark Conflicting Subjects as Unassigned" bulk button
        ftCalendarBody.querySelector(".cal-unassign-all-conflicts-btn")?.addEventListener("click", async function() {
            const rawJson = this.dataset.conflicts;
            if (!rawJson) return;

            let conflictData;
            try {
                conflictData = JSON.parse(rawJson);
            } catch (e) {
                console.error("Could not parse conflict data:", e);
                return;
            }

            const confirmed = await showConfirm(
                `Mark conflicting class assignments for ${faculty.name} as Unassigned?`
            );
            if (!confirmed) return;

            // In each clash pair (b1 vs b2), unassign b2 so that b1 remains assigned
            const unassignMap = new Map();
            conflictData.forEach(pair => {
                if (pair.b2 && pair.b2.schedId && pair.b2.entryIdx !== null) {
                    if (!unassignMap.has(pair.b2.schedId)) {
                        unassignMap.set(pair.b2.schedId, new Set());
                    }
                    unassignMap.get(pair.b2.schedId).add(pair.b2.entryIdx);
                }
            });

            try {
                showToast("Unassigning conflicting classes...");
                for (const [sId, entryIndices] of unassignMap.entries()) {
                    const sched = rawClassSchedules.find(s => s.id === sId);
                    if (!sched || !Array.isArray(sched.entries)) continue;

                    entryIndices.forEach(idx => {
                        if (sched.entries[idx]) {
                            sched.entries[idx].faculty = "Unassigned";
                            sched.entries[idx].facultyUid = "";
                            sched.entries[idx].facultyId = "";
                        }
                    });

                    await updateDoc(doc(db, "classSchedules", sId), {
                        entries: sched.entries,
                        updatedAt: new Date()
                    });
                }

                showToast("Conflicting classes marked as Unassigned.");
                await loadData();
                openFacultyTimetableModal(facultyUid);
            } catch (err) {
                console.error("Failed to unassign conflicts:", err);
                showToast(`Failed to update assignments: ${err.message}`);
            }
        });
    }

    facultyTimetableModal.style.display = "flex";
}



/* ==========================================================================
   EDIT SCHEDULE DETAILS MODAL & CONFLICT RESOLUTION ENGINE
========================================================================== */
function openEditScheduleDetailModal(schedId, entryIdx, multiIdx, facultyUid) {
    const schedule = rawClassSchedules.find(s => s.id === schedId);
    if (!schedule || !Array.isArray(schedule.entries) || !schedule.entries[entryIdx]) {
        showToast("Schedule record not found.");
        return;
    }

    const entry = schedule.entries[entryIdx];
    const faculty = allFaculty.find(f => f.uid === facultyUid || f.id === facultyUid) || {
        name: entry.faculty || "Faculty",
        uid: facultyUid,
        id: facultyUid
    };

    const daysArr = String(entry.day || "").split("/").map(s => s.trim()).filter(Boolean);
    const timesArr = String(entry.time || "").split("/").map(s => s.trim()).filter(Boolean);
    const roomsArr = String(entry.room || "").split("/").map(s => s.trim()).filter(Boolean);

    const currentDay = daysArr[multiIdx] || daysArr[0] || "Monday";
    const currentTime = timesArr[multiIdx] || timesArr[0] || "7:30 AM - 9:00 AM";
    const currentRoom = roomsArr[multiIdx] || roomsArr[0] || "";

    currentEditContext = {
        schedId,
        entryIdx,
        multiIdx,
        facultyUid,
        schedule,
        entry,
        faculty,
        daysArr,
        timesArr,
        roomsArr,
        originalDay: currentDay,
        originalTime: currentTime,
        originalRoom: currentRoom,
        overrideConfirmed: false
    };

    // Subtitle & Header strip
    if (editDetailSubtitle) {
        editDetailSubtitle.textContent = `${schedule.section || schedule.name} • ${schedule.academicYear || ''} ${schedule.semester ? (schedule.semester === '1' ? '1st Sem' : '2nd Sem') : ''}`;
    }
    if (editDetailSubjectDisplay) editDetailSubjectDisplay.textContent = `${entry.code || ''} - ${entry.name || ''}`;
    if (editDetailSectionDisplay) editDetailSectionDisplay.textContent = schedule.section || schedule.name || "—";
    if (editDetailFacultyDisplay) editDetailFacultyDisplay.textContent = faculty.name;
    if (editDetailHoursDisplay) {
        editDetailHoursDisplay.textContent = `${entry.units || 3} units (${calculateClassDurationHours(currentTime, entry.units)} hrs)`;
    }

    // Faculty Accessibility & Location Preferences Notice
    const pref = faculty.roomPreferences || facultyRoomPreferencesMap.get(faculty.uid) || facultyRoomPreferencesMap.get(faculty.id);
    if (pref && (pref.preferredBuilding || (pref.preferredRooms && pref.preferredRooms.length > 0) || pref.accessibilityNotes)) {
        if (editDetailPrefBanner) editDetailPrefBanner.style.display = "flex";
        let text = "";
        if (pref.preferredBuilding) text += `Preferred Building: <strong>${escapeHtml(pref.preferredBuilding)}</strong>. `;
        if (pref.preferredRooms && pref.preferredRooms.length > 0) text += `Allowed Rooms: <strong>${escapeHtml(pref.preferredRooms.join(", "))}</strong>. `;
        if (pref.restrictedRoomList) text += `<span style="color:#b78103; font-weight:700;">(Restricted room list enforced)</span>. `;
        if (pref.accessibilityNotes) text += `<br><span style="color:#555;">Note: ${escapeHtml(pref.accessibilityNotes)}</span>`;
        if (editDetailPrefText) editDetailPrefText.innerHTML = text;
    } else {
        if (editDetailPrefBanner) editDetailPrefBanner.style.display = "none";
    }

    // Prepopulate Day
    if (editDetailDaySelect) editDetailDaySelect.value = normalizeDayName(currentDay) || "Monday";

    // Prepopulate Times
    const range = parseTimeRange(currentTime);
    if (range) {
        if (editDetailStartTimeSelect) editDetailStartTimeSelect.value = minutesToDisplay(range.start);
        if (editDetailEndTimeSelect) editDetailEndTimeSelect.value = minutesToDisplay(range.end);
    } else {
        if (editDetailStartTimeSelect) editDetailStartTimeSelect.value = "7:30 AM";
        if (editDetailEndTimeSelect) editDetailEndTimeSelect.value = "9:00 AM";
    }

    if (editDetailTimeSlotPreset) editDetailTimeSlotPreset.value = "";

    // Prepopulate Rooms with prioritized preferred building/rooms
    populateEditRoomSelect(currentRoom, faculty.uid || faculty.id);

    // Initial conflict & availability validation
    runEditScheduleDetailValidation();

    editScheduleDetailModal.style.display = "flex";
}

function runEditScheduleDetailValidation() {
    if (!currentEditContext) return;

    if (editDetailConflictPanel) editDetailConflictPanel.style.display = "none";
    if (editDetailConflictList) editDetailConflictList.innerHTML = "";
    if (editDetailResolutionsSection) editDetailResolutionsSection.style.display = "none";
    if (editDetailResolutionsList) editDetailResolutionsList.innerHTML = "";
    if (editDetailOverrideBox) editDetailOverrideBox.style.display = "none";
    if (saveEditDetailBtn) saveEditDetailBtn.disabled = false;

    updateActiveTimeDisplay();

    const pDay = editDetailDaySelect ? editDetailDaySelect.value : "Monday";
    const pStart = editDetailStartTimeSelect ? editDetailStartTimeSelect.value : "";
    const pEnd = editDetailEndTimeSelect ? editDetailEndTimeSelect.value : "";
    const pTime = `${pStart} - ${pEnd}`;
    const pRoom = editDetailRoomSelect ? editDetailRoomSelect.value : "";

    const range = parseTimeRange(pTime);
    if (!range) {
        if (editDetailConflictPanel) editDetailConflictPanel.style.display = "block";
        if (editDetailConflictSummary) editDetailConflictSummary.textContent = "Invalid Time Format or Range";
        if (editDetailConflictList) {
            editDetailConflictList.innerHTML = `<li>Start time (<strong>${escapeHtml(pStart)}</strong>) must be strictly earlier than end time (<strong>${escapeHtml(pEnd)}</strong>).</li>`;
        }
        if (saveEditDetailBtn) saveEditDetailBtn.disabled = true;
        return;
    }

    if (!pRoom) {
        if (saveEditDetailBtn) saveEditDetailBtn.disabled = true;
        return;
    }

    const conflicts = [];
    let occupyingConflict = null;

    const targetAY = currentEditContext.schedule.academicYear || "";
    const targetSem = currentEditContext.schedule.semester || "";
    const currentSchedId = currentEditContext.schedId;
    const currentEntryIdx = currentEditContext.entryIdx;
    const currentMultiIdx = currentEditContext.multiIdx;
    const currentSection = currentEditContext.schedule.section || currentEditContext.schedule.name || "";
    const currentFacName = currentEditContext.faculty.name || "";
    const currentFacUid = currentEditContext.faculty.uid || currentEditContext.faculty.id || "";

    // ── Check against all saved active class schedules ──
    rawClassSchedules.forEach(sched => {
        if (sched.status === "archived") return;
        if (targetAY && sched.academicYear !== targetAY) return;
        if (targetSem && sched.semester !== targetSem) return;

        (sched.entries || []).forEach((e, eIdx) => {
            const dArr = String(e.day || "").split("/").map(s => s.trim()).filter(Boolean);
            const tArr = String(e.time || "").split("/").map(s => s.trim()).filter(Boolean);
            const rArr = String(e.room || "").split("/").map(s => s.trim()).filter(Boolean);
            const cnt = Math.max(dArr.length, 1);

            for (let mIdx = 0; mIdx < cnt; mIdx++) {
                // Exclude the current schedule slot being edited to prevent false self-conflict!
                if (sched.id === currentSchedId && eIdx === currentEntryIdx && mIdx === currentMultiIdx) {
                    continue;
                }

                const slotDay = dArr[mIdx] || dArr[0] || "";
                const slotTime = tArr[mIdx] || tArr[0] || "";
                const slotRoom = rArr[mIdx] || rArr[0] || "";

                if (!slotDay || !slotTime || slotDay === "TBA" || slotTime === "TBA") continue;

                // Day match check
                if (slotDay.toLowerCase() !== pDay.toLowerCase()) continue;

                // Time overlap check
                if (!timesOverlap(slotTime, pTime)) continue;

                // 1. Check Room Conflict
                if (sameRoom(slotRoom, pRoom)) {
                    if (isGymOrCourtRoom(pRoom)) {
                        // Gym allowed up to 2 simultaneous sections
                    } else {
                        conflicts.push(`Room Double-Booking: <strong>${escapeHtml(pRoom)}</strong> is occupied by <strong>${escapeHtml(sched.section || sched.name || 'Another Section')}</strong> (${escapeHtml(e.code || '')}) from <strong>${escapeHtml(slotTime)}</strong>.`);
                        if (!occupyingConflict) {
                            occupyingConflict = {
                                sched,
                                entry: e,
                                entryIdx: eIdx,
                                multiIdx: mIdx,
                                section: sched.section || sched.name || "Another Section",
                                code: e.code || "",
                                name: e.name || "",
                                faculty: e.faculty || "Unassigned",
                                day: slotDay,
                                time: slotTime,
                                room: slotRoom
                            };
                        }
                    }
                }

                // 2. Check Faculty Overlap
                if (sameFaculty(e.faculty, currentFacName) || (e.facultyUid && e.facultyUid === currentFacUid)) {
                    conflicts.push(`Faculty Conflict: <strong>${escapeHtml(currentFacName)}</strong> is already assigned to teach <strong>${escapeHtml(sched.section || sched.name || '')} (${escapeHtml(e.code || '')})</strong> on ${escapeHtml(pDay)} from <strong>${escapeHtml(slotTime)}</strong>.`);
                }

                // 3. Check Section Overlap
                if (currentSection && sched.section && currentSection.trim().toLowerCase() === sched.section.trim().toLowerCase()) {
                    conflicts.push(`Section Conflict: Section <strong>${escapeHtml(currentSection)}</strong> already has class <strong>${escapeHtml(e.code || '')} (${escapeHtml(e.name || '')})</strong> scheduled from <strong>${escapeHtml(slotTime)}</strong>.`);
                }
            }
        });
    });

    // 4. Room status & capacity check
    const roomObj = allRooms.find(r => sameRoom(r.roomCode, pRoom));
    if (roomObj) {
        if (roomObj.status === "MAINTENANCE" || roomObj.status === "UNAVAILABLE") {
            conflicts.push(`Room Status Warning: <strong>${escapeHtml(pRoom)}</strong> is marked as <strong>${escapeHtml(roomObj.status)}</strong>.`);
        }
    }

    // 5. Restricted Room List check (Requirement 2)
    const pref = currentEditContext.faculty.roomPreferences || facultyRoomPreferencesMap.get(currentFacUid);
    let restrictedWarning = null;
    if (pref && pref.restrictedRoomList && Array.isArray(pref.preferredRooms) && pref.preferredRooms.length > 0) {
        const isAllowed = pref.preferredRooms.some(r => sameRoom(r, pRoom));
        if (!isAllowed) {
            restrictedWarning = `Room <strong>${escapeHtml(pRoom)}</strong> is not in ${escapeHtml(currentFacName)}'s configured allowed room list (${escapeHtml(pref.preferredRooms.join(', '))}).`;
        }
    }

    if (conflicts.length > 0) {
        if (editDetailConflictPanel) editDetailConflictPanel.style.display = "block";
        if (editDetailConflictSummary) {
            editDetailConflictSummary.textContent = `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} detected for this proposed slot:`;
        }
        if (editDetailConflictList) {
            editDetailConflictList.innerHTML = conflicts.map(c => `<li>${c}</li>`).join("");
        }
        if (saveEditDetailBtn) saveEditDetailBtn.disabled = true;

        // If the room itself is occupied, display Suggested Room Resolutions (Requirement 4)
        if (occupyingConflict) {
            generateAndRenderRoomResolutions(pDay, pTime, pRoom, occupyingConflict);
        }
        return;
    }

    // Zero conflicts detected
    if (restrictedWarning) {
        if (editDetailOverrideBox) {
            editDetailOverrideBox.style.display = "flex";
            if (editDetailOverrideText) {
                editDetailOverrideText.innerHTML = `<strong>Restriction Notice:</strong> ${restrictedWarning} Click 'Confirm Override' to allow this assignment.`;
            }
        }
        if (saveEditDetailBtn) {
            saveEditDetailBtn.disabled = !currentEditContext.overrideConfirmed;
        }
    } else {
        if (saveEditDetailBtn) saveEditDetailBtn.disabled = false;
    }
}

function generateAndRenderRoomResolutions(pDay, pTime, pRoom, occupyingConflict) {
    if (!currentEditContext || !editDetailResolutionsList || !editDetailResolutionsSection) return;

    editDetailResolutionsList.innerHTML = "";
    editDetailResolutionsSection.style.display = "block";

    const targetAY = currentEditContext.schedule.academicYear || "";
    const targetSem = currentEditContext.schedule.semester || "";
    const currentSchedId = currentEditContext.schedId;
    const currentEntryIdx = currentEditContext.entryIdx;
    const currentMultiIdx = currentEditContext.multiIdx;
    const currentFacUid = currentEditContext.faculty.uid || currentEditContext.faculty.id || "";
    const currentFacName = currentEditContext.faculty.name || "";
    const currentSection = currentEditContext.schedule.section || currentEditContext.schedule.name || "";

    const pref = currentEditContext.faculty.roomPreferences || facultyRoomPreferencesMap.get(currentFacUid) || {};
    const prefBuilding = pref.preferredBuilding || "";
    const prefRooms = Array.isArray(pref.preferredRooms) ? pref.preferredRooms : [];

    // Helper: is a room free at (day, time)?
    function isRoomFree(roomCode, day, time) {
        for (const s of rawClassSchedules) {
            if (s.status === "archived") continue;
            if (targetAY && s.academicYear !== targetAY) continue;
            if (targetSem && s.semester !== targetSem) continue;

            for (let eIdx = 0; eIdx < (s.entries || []).length; eIdx++) {
                const e = s.entries[eIdx];
                const dArr = String(e.day || "").split("/").map(str => str.trim()).filter(Boolean);
                const tArr = String(e.time || "").split("/").map(str => str.trim()).filter(Boolean);
                const rArr = String(e.room || "").split("/").map(str => str.trim()).filter(Boolean);
                const cnt = Math.max(dArr.length, 1);

                for (let mIdx = 0; mIdx < cnt; mIdx++) {
                    if (s.id === currentSchedId && eIdx === currentEntryIdx && mIdx === currentMultiIdx) continue;

                    const slDay = dArr[mIdx] || dArr[0] || "";
                    const slTime = tArr[mIdx] || tArr[0] || "";
                    const slRoom = rArr[mIdx] || rArr[0] || "";

                    if (!slDay || !slTime || slDay === "TBA" || slTime === "TBA") continue;
                    if (slDay.toLowerCase() === day.toLowerCase() && timesOverlap(slTime, time) && sameRoom(slRoom, roomCode)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    // Helper: is faculty free at (day, time)?
    function isFacultyFree(facultyName, facultyUid, day, time) {
        for (const s of rawClassSchedules) {
            if (s.status === "archived") continue;
            if (targetAY && s.academicYear !== targetAY) continue;
            if (targetSem && s.semester !== targetSem) continue;

            for (let eIdx = 0; eIdx < (s.entries || []).length; eIdx++) {
                const e = s.entries[eIdx];
                const dArr = String(e.day || "").split("/").map(str => str.trim()).filter(Boolean);
                const tArr = String(e.time || "").split("/").map(str => str.trim()).filter(Boolean);
                const cnt = Math.max(dArr.length, 1);

                for (let mIdx = 0; mIdx < cnt; mIdx++) {
                    if (s.id === currentSchedId && eIdx === currentEntryIdx && mIdx === currentMultiIdx) continue;

                    const slDay = dArr[mIdx] || dArr[0] || "";
                    const slTime = tArr[mIdx] || tArr[0] || "";

                    if (!slDay || !slTime || slDay === "TBA" || slTime === "TBA") continue;
                    if (slDay.toLowerCase() === day.toLowerCase() && timesOverlap(slTime, time)) {
                        if (sameFaculty(e.faculty, facultyName) || (e.facultyUid && e.facultyUid === facultyUid)) {
                            return false;
                        }
                    }
                }
            }
        }
        return true;
    }

    // Helper: is section free at (day, time)?
    function isSectionFree(sectionName, day, time) {
        if (!sectionName) return true;
        for (const s of rawClassSchedules) {
            if (s.status === "archived") continue;
            if (targetAY && s.academicYear !== targetAY) continue;
            if (targetSem && s.semester !== targetSem) continue;
            if (!s.section || s.section.trim().toLowerCase() !== sectionName.trim().toLowerCase()) continue;

            for (let eIdx = 0; eIdx < (s.entries || []).length; eIdx++) {
                const e = s.entries[eIdx];
                const dArr = String(e.day || "").split("/").map(str => str.trim()).filter(Boolean);
                const tArr = String(e.time || "").split("/").map(str => str.trim()).filter(Boolean);
                const cnt = Math.max(dArr.length, 1);

                for (let mIdx = 0; mIdx < cnt; mIdx++) {
                    if (s.id === currentSchedId && eIdx === currentEntryIdx && mIdx === currentMultiIdx) continue;

                    const slDay = dArr[mIdx] || dArr[0] || "";
                    const slTime = tArr[mIdx] || tArr[0] || "";

                    if (!slDay || !slTime || slDay === "TBA" || slTime === "TBA") continue;
                    if (slDay.toLowerCase() === day.toLowerCase() && timesOverlap(slTime, time)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    let cardsHtml = "";

    // ─────────────────────────────────────────────────────────────
    // Priority A: Available Preferred Rooms
    // ─────────────────────────────────────────────────────────────
    const candidatePreferredRooms = allRooms.filter(r => {
        if (sameRoom(r.roomCode, pRoom)) return false;
        if (r.status === "MAINTENANCE" || r.status === "UNAVAILABLE") return false;
        if (prefRooms.length > 0 && prefRooms.some(pr => sameRoom(pr, r.roomCode))) return true;
        if (prefBuilding && r.building === prefBuilding) return true;
        return false;
    });

    const freePreferredRooms = candidatePreferredRooms.filter(r => isRoomFree(r.roomCode, pDay, pTime));

    freePreferredRooms.slice(0, 3).forEach(r => {
        cardsHtml += `
            <div class="resolution-card type-room">
                <div class="resolution-card-content">
                    <span class="resolution-card-badge">Option A • Available Preferred Room</span>
                    <div class="resolution-card-title">${escapeHtml(r.roomCode)} — ${escapeHtml(r.roomName)} (${escapeHtml(r.building || 'Campus')})</div>
                    <div class="resolution-card-desc">
                        Matches instructor location preference in <strong>${escapeHtml(r.building || 'Campus')}</strong>. Verified free on ${escapeHtml(pDay)} during ${escapeHtml(pTime)} (Capacity: ${r.capacity || 50}).
                    </div>
                </div>
                <button type="button" class="btn-resolution-action btn-apply-room" data-room="${escapeHtml(r.roomCode)}">
                    Apply This Room
                </button>
            </div>
        `;
    });

    // ─────────────────────────────────────────────────────────────
    // Priority B: Alternative Time Slots
    // ─────────────────────────────────────────────────────────────
    const altTimeRooms = freePreferredRooms.length > 0 ? freePreferredRooms : (candidatePreferredRooms.length > 0 ? candidatePreferredRooms : allRooms.filter(r => sameRoom(r.roomCode, pRoom)));
    const targetRoomForTime = altTimeRooms[0] || allRooms.find(r => sameRoom(r.roomCode, pRoom));

    const standardTimeSlots = [
        "7:30 AM - 9:00 AM",
        "9:00 AM - 10:30 AM",
        "10:30 AM - 12:00 PM",
        "1:00 PM - 2:30 PM",
        "2:30 PM - 4:00 PM",
        "4:00 PM - 5:30 PM",
        "7:30 AM - 10:00 AM",
        "10:00 AM - 12:30 PM",
        "1:00 PM - 3:30 PM",
        "3:30 PM - 6:00 PM"
    ];

    const daysToTest = [pDay, "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].filter((v, i, a) => a.indexOf(v) === i);
    const validTimeResolutions = [];

    if (targetRoomForTime) {
        for (const testDay of daysToTest) {
            if (validTimeResolutions.length >= 2) break;
            for (const testSlot of standardTimeSlots) {
                if (validTimeResolutions.length >= 2) break;
                if (testDay === pDay && timesOverlap(testSlot, pTime)) continue;

                if (isRoomFree(targetRoomForTime.roomCode, testDay, testSlot) &&
                    isFacultyFree(currentFacName, currentFacUid, testDay, testSlot) &&
                    isSectionFree(currentSection, testDay, testSlot)) {
                    validTimeResolutions.push({
                        day: testDay,
                        time: testSlot,
                        room: targetRoomForTime
                    });
                }
            }
        }
    }

    validTimeResolutions.forEach(tr => {
        cardsHtml += `
            <div class="resolution-card type-time">
                <div class="resolution-card-content">
                    <span class="resolution-card-badge">Option B • Conflict-Free Time Slot</span>
                    <div class="resolution-card-title">${escapeHtml(tr.day)} • ${escapeHtml(tr.time)} in ${escapeHtml(tr.room.roomCode)}</div>
                    <div class="resolution-card-desc">
                        Both ${escapeHtml(currentFacName)} and Section ${escapeHtml(currentSection)} are completely free. Room ${escapeHtml(tr.room.roomCode)} (${escapeHtml(tr.room.building || 'Campus')}) is available with zero conflicts.
                    </div>
                </div>
                <button type="button" class="btn-resolution-action btn-apply-time" data-day="${escapeHtml(tr.day)}" data-time="${escapeHtml(tr.time)}" data-room="${escapeHtml(tr.room.roomCode)}">
                    Apply This Time
                </button>
            </div>
        `;
    });

    // ─────────────────────────────────────────────────────────────
    // Priority C: Room-Switch Recommendations
    // ─────────────────────────────────────────────────────────────
    if (occupyingConflict) {
        const occClass = occupyingConflict;
        const candidateReplacementRooms = allRooms.filter(r2 => {
            if (sameRoom(r2.roomCode, pRoom)) return false;
            if (r2.status === "MAINTENANCE" || r2.status === "UNAVAILABLE") return false;
            if (r2.capacity < 40) return false;
            return isRoomFree(r2.roomCode, occClass.day, occClass.time);
        });

        if (candidateReplacementRooms.length > 0) {
            const r2 = candidateReplacementRooms[0];
            cardsHtml += `
                <div class="resolution-card type-switch">
                    <div class="resolution-card-content">
                        <span class="resolution-card-badge">Option C • Room Switch Recommendation</span>
                        <div class="resolution-card-title">Exchange Room with ${escapeHtml(occClass.section)} (${escapeHtml(occClass.code)})</div>
                        <div class="resolution-card-desc">
                            Move <strong>${escapeHtml(occClass.section)} (${escapeHtml(occClass.code)})</strong> to <strong>${escapeHtml(r2.roomCode)} (${escapeHtml(r2.building || 'Campus')})</strong> during ${escapeHtml(occClass.time)}. This frees up preferred room <strong>${escapeHtml(pRoom)}</strong> for ${escapeHtml(currentFacName)}.
                        </div>
                    </div>
                    <button type="button" class="btn-resolution-action btn-review-switch"
                        data-target-room="${escapeHtml(pRoom)}"
                        data-rep-room="${escapeHtml(r2.roomCode)}"
                        data-rep-name="${escapeHtml(r2.roomName)}"
                        data-rep-bldg="${escapeHtml(r2.building || '')}">
                        Review Room Switch
                    </button>
                </div>
            `;
        }
    }

    if (!cardsHtml) {
        cardsHtml = `
            <div style="background:#fafaf7; border:1px solid #d0ccbf; border-radius:8px; padding:12px; font-size:12.5px; color:#666; text-align:center;">
                No automated room resolution available for this slot. All alternative rooms in this category are occupied. Please select an alternate day or time slot.
            </div>
        `;
    }

    editDetailResolutionsList.innerHTML = cardsHtml;

    // Attach resolution action listeners
    editDetailResolutionsList.querySelectorAll(".btn-apply-room").forEach(btn => {
        btn.addEventListener("click", () => {
            if (editDetailRoomSelect) editDetailRoomSelect.value = btn.dataset.room;
            runEditScheduleDetailValidation();
            showToast(`Applied recommended room: ${btn.dataset.room}`);
        });
    });

    editDetailResolutionsList.querySelectorAll(".btn-apply-time").forEach(btn => {
        btn.addEventListener("click", () => {
            if (editDetailDaySelect) editDetailDaySelect.value = btn.dataset.day;
            const parts = (btn.dataset.time || "").split("-").map(s => s.trim());
            if (parts.length === 2) {
                if (editDetailStartTimeSelect) editDetailStartTimeSelect.value = parts[0];
                if (editDetailEndTimeSelect) editDetailEndTimeSelect.value = parts[1];
            }
            if (editDetailRoomSelect) editDetailRoomSelect.value = btn.dataset.room;
            runEditScheduleDetailValidation();
            showToast(`Applied recommended slot: ${btn.dataset.day} ${btn.dataset.time}`);
        });
    });

    editDetailResolutionsList.querySelectorAll(".btn-review-switch").forEach(btn => {
        btn.addEventListener("click", () => {
            const targetRoom = btn.dataset.targetRoom;
            const repRoom = btn.dataset.repRoom;
            const repBldg = btn.dataset.repBldg;

            openRoomSwitchReviewModal({
                targetRoom,
                repRoom,
                repBldg,
                occupyingClass: occupyingConflict
            });
        });
    });
}

function openRoomSwitchReviewModal(ctx) {
    if (!currentEditContext || !ctx || !ctx.occupyingClass) return;

    const occ = ctx.occupyingClass;
    const targetRoom = ctx.targetRoom;
    const repRoom = ctx.repRoom;
    const repBldg = ctx.repBldg;

    const pDay = editDetailDaySelect ? editDetailDaySelect.value : "Monday";
    const pStart = editDetailStartTimeSelect ? editDetailStartTimeSelect.value : "";
    const pEnd = editDetailEndTimeSelect ? editDetailEndTimeSelect.value : "";
    const pTime = `${pStart} - ${pEnd}`;

    currentRoomSwitchContext = {
        sched1: currentEditContext.schedule,
        entryIdx1: currentEditContext.entryIdx,
        multiIdx1: currentEditContext.multiIdx,
        proposedDay1: pDay,
        proposedTime1: pTime,
        proposedRoom1: targetRoom,

        sched2: occ.sched,
        entryIdx2: occ.entryIdx,
        multiIdx2: occ.multiIdx,
        day2: occ.day,
        time2: occ.time,
        currentRoom2: occ.room,
        replacementRoom2: repRoom,
        replacementBldg2: repBldg
    };

    if (switchClass1Section) switchClass1Section.textContent = currentEditContext.schedule.section || currentEditContext.schedule.name || "—";
    if (switchClass1Subject) switchClass1Subject.textContent = `${currentEditContext.entry.code || ''} - ${currentEditContext.entry.name || ''}`;
    if (switchClass1Faculty) switchClass1Faculty.textContent = currentEditContext.faculty.name || "Faculty";
    if (switchClass1Time) switchClass1Time.textContent = `${pDay} (${pTime})`;
    if (switchClass1ProposedRoom) switchClass1ProposedRoom.textContent = targetRoom;

    if (switchClass2Section) switchClass2Section.textContent = occ.section || "—";
    if (switchClass2Subject) switchClass2Subject.textContent = `${occ.code || ''} - ${occ.name || ''}`;
    if (switchClass2Faculty) switchClass2Faculty.textContent = occ.faculty || "Unassigned";
    if (switchClass2Time) switchClass2Time.textContent = `${occ.day} (${occ.time})`;
    if (switchClass2ProposedRoom) switchClass2ProposedRoom.textContent = `${repRoom} (${repBldg || 'General'})`;

    if (switchValidationNotice) {
        switchValidationNotice.style.display = "none";
        switchValidationNotice.innerHTML = "";
    }
    if (applyRoomSwitchBtn) {
        applyRoomSwitchBtn.disabled = false;
        applyRoomSwitchBtn.textContent = "Apply Room Switch";
    }

    roomSwitchReviewModal.style.display = "flex";
}

async function applyRoomSwitch() {
    if (!currentRoomSwitchContext) return;

    if (applyRoomSwitchBtn) {
        applyRoomSwitchBtn.disabled = true;
        applyRoomSwitchBtn.textContent = "Validating & Saving...";
    }

    const {
        sched1, entryIdx1, multiIdx1, proposedDay1, proposedTime1, proposedRoom1,
        sched2, entryIdx2, multiIdx2, replacementRoom2
    } = currentRoomSwitchContext;

    try {
        const e1 = sched1.entries[entryIdx1];
        const e2 = sched2.entries[entryIdx2];

        const days1 = String(e1.day || "").split("/").map(s => s.trim()).filter(Boolean);
        const times1 = String(e1.time || "").split("/").map(s => s.trim()).filter(Boolean);
        const rooms1 = String(e1.room || "").split("/").map(s => s.trim()).filter(Boolean);
        days1[multiIdx1] = proposedDay1;
        times1[multiIdx1] = proposedTime1;
        rooms1[multiIdx1] = proposedRoom1;
        e1.day = days1.join(" / ");
        e1.time = times1.join(" / ");
        e1.room = rooms1.join(" / ");

        const rooms2 = String(e2.room || "").split("/").map(s => s.trim()).filter(Boolean);
        rooms2[multiIdx2] = replacementRoom2;
        e2.room = rooms2.join(" / ");

        // Atomic write batch in Firestore
        const batch = writeBatch(db);
        batch.update(doc(db, "classSchedules", sched1.id), {
            entries: sched1.entries,
            updatedAt: new Date()
        });
        batch.update(doc(db, "classSchedules", sched2.id), {
            entries: sched2.entries,
            updatedAt: new Date()
        });

        await batch.commit();

        showToast(`Room switch applied! ${sched1.section} assigned to ${proposedRoom1}, ${sched2.section} moved to ${replacementRoom2}.`);

        roomSwitchReviewModal.style.display = "none";
        editScheduleDetailModal.style.display = "none";

        await loadData();
        if (currentEditContext && currentEditContext.facultyUid) {
            openFacultyTimetableModal(currentEditContext.facultyUid);
        }
    } catch (err) {
        console.error("Room switch error:", err);
        if (switchValidationNotice) {
            switchValidationNotice.style.display = "block";
            switchValidationNotice.textContent = `Room switch transaction failed: ${err.message}. Schedules were not modified.`;
        }
        showToast(`Failed to apply room switch: ${err.message}`);
    } finally {
        if (applyRoomSwitchBtn) {
            applyRoomSwitchBtn.disabled = false;
            applyRoomSwitchBtn.textContent = "Apply Room Switch";
        }
    }
}

async function saveScheduleDetailChanges() {
    if (!currentEditContext) return;

    const pDay = editDetailDaySelect ? editDetailDaySelect.value : "Monday";
    const pStart = editDetailStartTimeSelect ? editDetailStartTimeSelect.value : "";
    const pEnd = editDetailEndTimeSelect ? editDetailEndTimeSelect.value : "";
    const pTime = `${pStart} - ${pEnd}`;
    const pRoom = editDetailRoomSelect ? editDetailRoomSelect.value : "";

    const range = parseTimeRange(pTime);
    if (!range) {
        showToast("Please enter a valid start and end time.");
        return;
    }

    if (!pRoom) {
        showToast("Please select a room assignment.");
        return;
    }

    // Check restricted room override confirmation if needed
    const pref = currentEditContext.faculty.roomPreferences || facultyRoomPreferencesMap.get(currentEditContext.faculty.uid);
    if (pref && pref.restrictedRoomList && Array.isArray(pref.preferredRooms) && pref.preferredRooms.length > 0) {
        const isAllowed = pref.preferredRooms.some(r => sameRoom(r, pRoom));
        if (!isAllowed && !currentEditContext.overrideConfirmed) {
            const confirmed = await showConfirm(
                `Room ${pRoom} is outside ${currentEditContext.faculty.name}'s restricted room list. Are you sure you want to override this restriction?`
            );
            if (!confirmed) return;
            currentEditContext.overrideConfirmed = true;
        }
    }

    const { schedId, entryIdx, multiIdx, schedule, entry, daysArr, timesArr, roomsArr, facultyUid } = currentEditContext;

    daysArr[multiIdx] = pDay;
    timesArr[multiIdx] = pTime;
    roomsArr[multiIdx] = pRoom;
    entry.day = daysArr.join(" / ");
    entry.time = timesArr.join(" / ");
    entry.room = roomsArr.join(" / ");

    try {
        if (saveEditDetailBtn) {
            saveEditDetailBtn.disabled = true;
            saveEditDetailBtn.textContent = "Saving...";
        }

        await updateDoc(doc(db, "classSchedules", schedId), {
            entries: schedule.entries,
            updatedAt: new Date()
        });

        showToast(`Schedule details for ${entry.code} updated successfully.`);
        editScheduleDetailModal.style.display = "none";

        await loadData();
        if (facultyUid) {
            openFacultyTimetableModal(facultyUid);
        }
    } catch (err) {
        console.error("Failed to save schedule details:", err);
        showToast(`Failed to update schedule: ${err.message}`);
    } finally {
        if (saveEditDetailBtn) {
            saveEditDetailBtn.disabled = false;
            saveEditDetailBtn.textContent = "Save Changes";
        }
    }
}

// ── Event listeners for new modals ──
closeEditDetailModalBtn?.addEventListener("click", () => { editScheduleDetailModal.style.display = "none"; });
cancelEditDetailBtn?.addEventListener("click", () => { editScheduleDetailModal.style.display = "none"; });

closeRoomSwitchModalBtn?.addEventListener("click", () => { roomSwitchReviewModal.style.display = "none"; });
cancelRoomSwitchBtn?.addEventListener("click", () => { roomSwitchReviewModal.style.display = "none"; });

editDetailConfirmOverrideBtn?.addEventListener("click", () => {
    if (currentEditContext) {
        currentEditContext.overrideConfirmed = true;
        if (editDetailOverrideBox) {
            editDetailOverrideBox.innerHTML = `<span>✓ Restriction override confirmed by administrator.</span>`;
            editDetailOverrideBox.style.background = "#e8f5e9";
            editDetailOverrideBox.style.borderColor = "#c8e6c9";
            editDetailOverrideBox.style.color = "#1b5e20";
        }
        if (saveEditDetailBtn) saveEditDetailBtn.disabled = false;
    }
});

saveEditDetailBtn?.addEventListener("click", saveScheduleDetailChanges);
applyRoomSwitchBtn?.addEventListener("click", applyRoomSwitch);

editDetailDaySelect?.addEventListener("change", runEditScheduleDetailValidation);
editDetailRoomSelect?.addEventListener("change", () => {
    if (currentEditContext) currentEditContext.overrideConfirmed = false;
    runEditScheduleDetailValidation();
});

editDetailStartTimeSelect?.addEventListener("change", () => {
    const sMins = parseTime(editDetailStartTimeSelect.value);
    const eMins = parseTime(editDetailEndTimeSelect.value);
    if (eMins <= sMins) {
        const nextMins = Math.min(sMins + 90, 19 * 60);
        editDetailEndTimeSelect.value = minutesToDisplay(nextMins);
    }
    runEditScheduleDetailValidation();
});

editDetailEndTimeSelect?.addEventListener("change", runEditScheduleDetailValidation);

editDetailTimeSlotPreset?.addEventListener("change", () => {
    const val = editDetailTimeSlotPreset.value;
    if (val && val.includes("-")) {
        const parts = val.split("-").map(s => s.trim());
        if (parts.length === 2) {
            editDetailStartTimeSelect.value = parts[0];
            editDetailEndTimeSelect.value = parts[1];
        }
        runEditScheduleDetailValidation();
    }
});

closeFtModalBtn?.addEventListener("click", () => { facultyTimetableModal.style.display = "none"; });
closeFtBtn?.addEventListener("click", () => { facultyTimetableModal.style.display = "none"; });
closeAssignModalBtn?.addEventListener("click", () => { assignFacultyModal.style.display = "none"; });
cancelAssignModalBtn?.addEventListener("click", () => { assignFacultyModal.style.display = "none"; });

// Close modal when clicking outside on overlay backdrop
window.addEventListener("click", e => {
    if (e.target === assignFacultyModal) assignFacultyModal.style.display = "none";
    if (e.target === facultyTimetableModal) facultyTimetableModal.style.display = "none";
    if (e.target === customConfirmModal) customConfirmModal.style.display = "none";
    if (e.target === editScheduleDetailModal) editScheduleDetailModal.style.display = "none";
    if (e.target === roomSwitchReviewModal) roomSwitchReviewModal.style.display = "none";
});

// Close modal when pressing Escape key
window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        if (assignFacultyModal && assignFacultyModal.style.display === "flex") assignFacultyModal.style.display = "none";
        if (facultyTimetableModal && facultyTimetableModal.style.display === "flex") facultyTimetableModal.style.display = "none";
        if (customConfirmModal && customConfirmModal.style.display === "flex") customConfirmModal.style.display = "none";
        if (editScheduleDetailModal && editScheduleDetailModal.style.display === "flex") editScheduleDetailModal.style.display = "none";
        if (roomSwitchReviewModal && roomSwitchReviewModal.style.display === "flex") roomSwitchReviewModal.style.display = "none";
    }
});

/* ==========================================================================
   VIEW SWITCH & EVENT LISTENERS
========================================================================== */
viewCardsBtn?.addEventListener("click", () => {
    currentViewMode = "cards";
    viewCardsBtn.classList.add("active");
    viewTableBtn.classList.remove("active");
    render();
});

viewTableBtn?.addEventListener("click", () => {
    currentViewMode = "table";
    viewTableBtn.classList.add("active");
    viewCardsBtn.classList.remove("active");
    render();
});

openAssignModalBtn?.addEventListener("click", () => {
    openAssignModal();
});

facultySearchInput?.addEventListener("input", e => {
    currentSearchQuery = e.target.value.trim();
    render();
});

facultyAyFilter?.addEventListener("change", e => {
    currentAyFilter = e.target.value.trim();
    render();
});

facultySemFilter?.addEventListener("change", e => {
    currentSemFilter = e.target.value.trim();
    render();
});

facultyDeptFilter?.addEventListener("change", e => {
    currentDeptFilter = e.target.value.trim();
    render();
});
