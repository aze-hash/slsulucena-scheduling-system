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
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ==========================================================================
   STATE
========================================================================== */
let allFaculty = [];
let allClasses = []; // Flat list of all discrete class entries from classSchedules
let rawClassSchedules = []; // Full schedule documents
let facultySubjectAssignmentsMap = new Map(); // facultyId -> subjectKeys[]
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
        await Promise.all([
            loadFaculty(),
            loadFacultySubjectAssignments(),
            loadClassSchedules()
        ]);

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
            facultyList.push({
                uid: d.id,
                id: d.id,
                employeeId: u.employeeId || u.facultyId || "",
                name: u.fullName || u.name || "Unknown Faculty",
                email: u.email || "",
                department: u.department || u.program || "General"
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
                facultyList.push({
                    uid: d.id,
                    id: d.id,
                    employeeId: f.employeeId || f.facultyId || "",
                    name: name,
                    email: f.email || "",
                    department: f.department || "General"
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
        return `
            <div class="faculty-load-card">
                <div>
                    <div class="faculty-card-header">
                        <div>
                            <h4 class="faculty-card-name">${escapeHtml(f.name)}</h4>
                            <p class="faculty-card-sub">
                                ID: <strong>${escapeHtml(f.employeeId || "N/A")}</strong> • ${escapeHtml(f.department || "Faculty")}
                            </p>
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

    ftSummaryBox.innerHTML = `
        <div><strong>Total Subjects:</strong> ${uniqueSubjects.length}</div>
        <div><strong>Total Sections:</strong> ${uniqueSections.length}</div>
        <div><strong>Teaching Hours:</strong> ${totalHours} hrs</div>
        <div><strong>Status:</strong> <span class="load-badge ${status.className}">${status.text}</span></div>
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
        entryIndex:  c.entryIndex
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
        /* isFacultySchedule = true → conflict detection ON, Section shown in last col */
        const html = renderClassCalendar({
            entries,
            isFacultySchedule: true
        });
        ftCalendarBody.innerHTML = html;

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


closeFtModalBtn?.addEventListener("click", () => { facultyTimetableModal.style.display = "none"; });
closeFtBtn?.addEventListener("click", () => { facultyTimetableModal.style.display = "none"; });
closeAssignModalBtn?.addEventListener("click", () => { assignFacultyModal.style.display = "none"; });
cancelAssignModalBtn?.addEventListener("click", () => { assignFacultyModal.style.display = "none"; });

// Close modal when clicking outside on overlay backdrop
window.addEventListener("click", e => {
    if (e.target === assignFacultyModal) {
        assignFacultyModal.style.display = "none";
    }
    if (e.target === facultyTimetableModal) {
        facultyTimetableModal.style.display = "none";
    }
    if (e.target === customConfirmModal) {
        customConfirmModal.style.display = "none";
    }
});

// Close modal when pressing Escape key
window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        if (assignFacultyModal && assignFacultyModal.style.display === "flex") {
            assignFacultyModal.style.display = "none";
        }
        if (facultyTimetableModal && facultyTimetableModal.style.display === "flex") {
            facultyTimetableModal.style.display = "none";
        }
        if (customConfirmModal && customConfirmModal.style.display === "flex") {
            customConfirmModal.style.display = "none";
        }
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
