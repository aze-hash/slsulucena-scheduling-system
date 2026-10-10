import { db, auth } from "../firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
    collection,
    getDocs,
    getDoc,
    doc,
    setDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ============================================================
   GLOBAL STATE & CONSTANTS
   ============================================================ */

let currentUser = null;
let programsList = [];
let majorsList = [];
let prospectusSubjectsList = [];
let uniqueSubjectCatalog = new Map(); // subjectCode -> representative subject object

// Pagination State
const PAGE_SIZE = 10;
let programsCurrentPage = 1;
let majorsCurrentPage = 1;
let currSubjectsCurrentPage = 1;

// Editing Contexts
let editingProgramId = null;
let editingMajorId = null;
let editingSubjectId = null;

// Fallback hardcoded programs & majors to ensure seamless backward compatibility
const FALLBACK_PROGRAMS = [
    { programCode: "BIT", courseCode: "BIT", programName: "Bachelor in Industrial Technology", courseName: "Bachelor in Industrial Technology", description: "Four-year technical degree program", status: "Active" },
    { programCode: "BINDTECH", courseCode: "BINDTECH", programName: "Bachelor of Industrial Technology", courseName: "Bachelor of Industrial Technology", description: "Four-year industrial technology program", status: "Active" },
    { programCode: "BTVTED", courseCode: "BTVTED", programName: "Bachelor of Technical-Vocational Teacher Education", courseName: "Bachelor of Technical-Vocational Teacher Education", description: "Four-year teacher education degree program", status: "Active" }
];

const FALLBACK_MAJORS = [
    { program: "BIT", programCode: "BIT", majorCode: "CPT", majorName: "Computer Technology", status: "Active" },
    { program: "BINDTECH", programCode: "BINDTECH", majorCode: "CPT", majorName: "Computer Technology", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "AT", majorName: "Automotive Technology", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "CP", majorName: "Computer Programming", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "CT", majorName: "Civil Technology", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "ELT", majorName: "Electrical Technology", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "ELX", majorName: "Electronics Technology", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "FSM", majorName: "Food and Service Management", status: "Active" },
    { program: "BTVTED", programCode: "BTVTED", majorCode: "MT", majorName: "Mechanical Technology", status: "Active" }
];

/* ============================================================
   UI HELPERS: TOAST NOTIFICATIONS & CONFIRMATION MODAL
   ============================================================ */

function showToast(message, type = "success") {
    const toast = document.getElementById("toastPopup");
    const msgEl = document.getElementById("toastMessage");
    const iconEl = document.getElementById("toastIcon");
    if (!toast || !msgEl) return;

    toast.className = `toast-popup toast-${type}`;
    if (type === "error") {
        iconEl.textContent = "✕";
    } else if (type === "warning") {
        iconEl.textContent = "⚠";
    } else {
        iconEl.textContent = "✔";
    }

    msgEl.textContent = message;
    toast.style.display = "flex";

    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.style.display = "none";
    }, 4000);
}

function showConfirmDialog({ title, message, warning = "", okText = "Proceed", isDanger = true }) {
    return new Promise(resolve => {
        const modal = document.getElementById("confirmModal");
        const titleEl = document.getElementById("confirmModalTitle");
        const msgEl = document.getElementById("confirmModalMessage");
        const warnEl = document.getElementById("confirmModalWarning");
        const okBtn = document.getElementById("confirmModalOkBtn");
        const cancelBtn = document.getElementById("confirmModalCancelBtn");
        const closeBtn = document.getElementById("confirmModalCloseBtn");

        titleEl.textContent = title;
        msgEl.textContent = message;

        if (warning) {
            warnEl.textContent = warning;
            warnEl.style.display = "block";
        } else {
            warnEl.style.display = "none";
        }

        okBtn.textContent = okText;
        okBtn.style.background = isDanger ? "#c62828" : "var(--primary)";

        modal.style.display = "flex";

        function cleanup() {
            modal.style.display = "none";
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
            closeBtn.removeEventListener("click", onCancel);
        }

        function onOk() {
            cleanup();
            resolve(true);
        }

        function onCancel() {
            cleanup();
            resolve(false);
        }

        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        closeBtn.addEventListener("click", onCancel);
    });
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ============================================================
   AUTHENTICATION CHECK
   ============================================================ */

onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.replace("login.html");
        return;
    }

    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (!userDoc.exists() || userDoc.data().role !== "Admin") {
            window.location.replace("login.html");
            return;
        }

        currentUser = user;
        const profileData = userDoc.data();
        document.getElementById("adminName").textContent = profileData.fullName || "SLSU Admin";

        // Initialize and load all data from Firestore
        await initCurriculumModule();

    } catch (err) {
        console.error("Auth verification failed:", err);
        showToast("Error authenticating admin account: " + err.message, "error");
    }
});

// Logout handler
document.getElementById("logoutLink")?.addEventListener("click", async e => {
    e.preventDefault();
    try {
        await signOut(auth);
        window.location.replace("login.html");
    } catch (err) {
        console.error("Logout error:", err);
    }
});

/* ============================================================
   DATA INITIALIZATION & FIRESTORE FETCHING
   ============================================================ */

async function initCurriculumModule() {
    try {
        await Promise.all([
            loadPrograms(),
            loadMajors(),
            loadProspectusSubjects()
        ]);

        buildUniqueSubjectCatalog();
        updateDashboardStatistics();
        populateCurriculumFilterDropdowns();
        renderProgramsTable();
        renderMajorsTable();
        renderCurriculumSubjects();

        setupTabNavigation();
        setupEventListeners();

    } catch (err) {
        console.error("Initialization error:", err);
        showToast("Failed to initialize curriculum data: " + err.message, "error");
    }
}

// 1. Load Programs from Firestore
async function loadPrograms() {
    try {
        const snap = await getDocs(collection(db, "programs"));
        const list = [];
        snap.forEach(d => {
            const data = d.data();
            list.push({
                id: d.id,
                programCode: String(data.programCode || data.courseCode || d.id).trim().toUpperCase(),
                programName: String(data.programName || data.courseName || "").trim(),
                description: String(data.description || "").trim(),
                status: String(data.status || "Active").trim(),
                createdAt: data.createdAt || null
            });
        });

        if (list.length === 0) {
            programsList = [...FALLBACK_PROGRAMS];
        } else {
            programsList = list;
        }

        programsList.sort((a, b) => a.programCode.localeCompare(b.programCode));
        const tabBadgeProg = document.getElementById("tabBadgePrograms");
        if (tabBadgeProg) tabBadgeProg.textContent = programsList.length;

    } catch (err) {
        console.error("Error loading programs:", err);
        programsList = [...FALLBACK_PROGRAMS];
    }
}

// 2. Load Majors from Firestore
async function loadMajors() {
    try {
        const snap = await getDocs(collection(db, "majors"));
        const list = [];
        snap.forEach(d => {
            const data = d.data();
            list.push({
                id: d.id,
                program: String(data.program || data.programCode || "").trim().toUpperCase(),
                programCode: String(data.programCode || data.program || "").trim().toUpperCase(),
                majorCode: String(data.majorCode || "").trim().toUpperCase(),
                majorName: String(data.majorName || "").trim(),
                description: String(data.description || "").trim(),
                status: String(data.status || "Active").trim(),
                createdAt: data.createdAt || null
            });
        });

        if (list.length === 0) {
            majorsList = [...FALLBACK_MAJORS];
        } else {
            majorsList = list;
        }

        majorsList.sort((a, b) => {
            if (a.program !== b.program) return a.program.localeCompare(b.program);
            return a.majorCode.localeCompare(b.majorCode);
        });

        const tabBadgeMajors = document.getElementById("tabBadgeMajors");
        if (tabBadgeMajors) tabBadgeMajors.textContent = majorsList.length;

    } catch (err) {
        console.error("Error loading majors:", err);
        majorsList = [...FALLBACK_MAJORS];
    }
}

// 3. Load Subjects from Prospectus collection (Single Source of Truth)
async function loadProspectusSubjects() {
    try {
        const snap = await getDocs(collection(db, "prospectus"));
        const list = [];
        snap.forEach(d => {
            const data = d.data();
            const lec = Number(data.lecHours) || 0;
            const lab = Number(data.labHours) || 0;
            const units = Number(data.units) || 0;
            const computedHours = lec + lab > 0 ? (lec + lab) : units;

            list.push({
                id: d.id,
                subjectCode: String(data.subjectCode || "").trim().toUpperCase(),
                subjectName: String(data.subjectName || "").trim(),
                programCode: String(data.programCode || "").trim().toUpperCase(),
                majorCode: String(data.majorCode || "").trim().toUpperCase(),
                yearLevel: Number(data.yearLevel) || 1,
                semester: Number(data.semester) || 1,
                units: units,
                lecHours: lec,
                labHours: lab,
                hoursPerWeek: Number(data.hoursPerWeek) || computedHours,
                prerequisite: String(data.prerequisite || "").trim(),
                subjectType: String(data.subjectType || "Major").trim(),
                requiredRoomType: String(data.requiredRoomType || "Lecture Room").trim(),
                meetingType: String(data.meetingType || "Lecture").trim(),
                status: String(data.status || "Active").trim(),
                createdAt: data.createdAt || null
            });
        });

        prospectusSubjectsList = list;
        const tabBadgeSubj = document.getElementById("tabBadgeSubjects");
        if (tabBadgeSubj) tabBadgeSubj.textContent = prospectusSubjectsList.length;

    } catch (err) {
        console.error("Error loading prospectus subjects:", err);
        prospectusSubjectsList = [];
    }
}

// Build Unique Subjects Catalog
function buildUniqueSubjectCatalog() {
    uniqueSubjectCatalog.clear();
    prospectusSubjectsList.forEach(s => {
        if (!s.subjectCode) return;
        if (!uniqueSubjectCatalog.has(s.subjectCode)) {
            uniqueSubjectCatalog.set(s.subjectCode, s);
        }
    });
}

// Update Top Statistics Cards
function updateDashboardStatistics() {
    const elProg = document.getElementById("statTotalPrograms");
    if (elProg) elProg.textContent = programsList.length;

    const elMajors = document.getElementById("statTotalMajors");
    if (elMajors) elMajors.textContent = majorsList.length;

    const elSubj = document.getElementById("statTotalSubjects");
    if (elSubj) elSubj.textContent = prospectusSubjectsList.length;
}

/* ============================================================
   TAB SWITCHING LOGIC
   ============================================================ */

function setupTabNavigation() {
    const tabBtns = document.querySelectorAll(".curriculum-tab-btn");
    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

            btn.classList.add("active");
            const targetId = btn.dataset.tab;
            const targetPane = document.getElementById(targetId);
            if (targetPane) targetPane.classList.add("active");
        });
    });
}

/* ============================================================
   TAB 1: MANAGE PROGRAMS CRUD & RENDERING
   ============================================================ */

function getFilteredPrograms() {
    const search = document.getElementById("programSearchInput").value.trim().toLowerCase();
    const status = document.getElementById("programStatusFilter").value;

    return programsList.filter(p => {
        if (status && p.status !== status) return false;
        if (search) {
            const codeMatch = p.programCode.toLowerCase().includes(search);
            const nameMatch = p.programName.toLowerCase().includes(search);
            const descMatch = p.description.toLowerCase().includes(search);
            if (!codeMatch && !nameMatch && !descMatch) return false;
        }
        return true;
    });
}

function renderProgramsTable() {
    const tbody = document.getElementById("programsTableBody");
    const countLabel = document.getElementById("programsCountLabel");
    const prevBtn = document.getElementById("programsPrevBtn");
    const nextBtn = document.getElementById("programsNextBtn");
    const pageNum = document.getElementById("programsPageNum");

    const filtered = getFilteredPrograms();
    const total = filtered.length;
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    if (programsCurrentPage > totalPages) programsCurrentPage = totalPages;
    if (programsCurrentPage < 1) programsCurrentPage = 1;

    const startIdx = (programsCurrentPage - 1) * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    const pageData = filtered.slice(startIdx, endIdx);

    countLabel.textContent = `Showing ${Math.min(startIdx + 1, total)} to ${Math.min(endIdx, total)} of ${total} programs`;
    pageNum.textContent = `${programsCurrentPage} / ${totalPages}`;
    prevBtn.disabled = programsCurrentPage <= 1;
    nextBtn.disabled = programsCurrentPage >= totalPages;

    if (pageData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state-box">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-title">No Academic Programs Found</div>
                    <p class="empty-state-text">No programs match your search criteria. Click "Add New Program" to register one.</p>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = pageData.map(p => {
        const majorsCount = majorsList.filter(m => m.program === p.programCode || m.programCode === p.programCode).length;
        const isActive = p.status === "Active";
        const statusBadge = isActive
            ? `<span class="badge badge-active">Active</span>`
            : `<span class="badge badge-inactive">Inactive</span>`;
        const toggleBtnLabel = isActive ? "Deactivate" : "Activate";
        const toggleBtnClass = isActive ? "deactivate" : "activate";

        return `
            <tr>
                <td><span class="badge badge-code">${escapeHtml(p.programCode)}</span></td>
                <td style="text-align: left; font-weight: 700; color: #222;">${escapeHtml(p.programName)}</td>
                <td><span class="badge badge-units">${majorsCount} major${majorsCount === 1 ? "" : "s"}</span></td>
                <td>${statusBadge}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-action-edit" data-action="edit-program" data-id="${escapeHtml(p.programCode)}">Edit</button>
                        <button class="btn-action-status ${toggleBtnClass}" data-action="toggle-program" data-id="${escapeHtml(p.programCode)}" data-status="${escapeHtml(p.status)}">${toggleBtnLabel}</button>
                        <button class="btn-action-delete" data-action="delete-program" data-id="${escapeHtml(p.programCode)}" title="Delete Program">✕</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

// Open Program Modal (Add / Edit)
function openProgramModal(programCodeToEdit = null) {
    const modal = document.getElementById("programModal");
    const title = document.getElementById("programModalTitle");
    const codeInput = document.getElementById("progInputCode");
    const nameInput = document.getElementById("progInputName");
    const statusInput = document.getElementById("progInputStatus");
    const errBox = document.getElementById("programFormError");

    errBox.style.display = "none";
    errBox.textContent = "";

    if (programCodeToEdit) {
        editingProgramId = programCodeToEdit;
        const prog = programsList.find(p => p.programCode === programCodeToEdit);
        title.textContent = "Edit Academic Program";
        codeInput.value = prog?.programCode || programCodeToEdit;
        codeInput.disabled = true; // Primary ID cannot be renamed
        nameInput.value = prog?.programName || "";
        statusInput.value = prog?.status || "Active";
    } else {
        editingProgramId = null;
        title.textContent = "Add New Academic Program";
        codeInput.value = "";
        codeInput.disabled = false;
        nameInput.value = "";
        statusInput.value = "Active";
    }

    modal.style.display = "flex";
    if (!programCodeToEdit) codeInput.focus();
}

function closeProgramModal() {
    document.getElementById("programModal").style.display = "none";
    editingProgramId = null;
}

// Save Program
async function handleProgramFormSubmit(e) {
    e.preventDefault();
    const errBox = document.getElementById("programFormError");
    errBox.style.display = "none";

    const code = document.getElementById("progInputCode").value.trim().toUpperCase();
    const name = document.getElementById("progInputName").value.trim();
    const status = document.getElementById("progInputStatus").value;

    if (!code || !name) {
        errBox.textContent = "Program Code and Program Name are required.";
        errBox.style.display = "block";
        return;
    }

    if (!editingProgramId) {
        const existing = programsList.find(p => p.programCode === code);
        if (existing) {
            errBox.textContent = `A program with code "${code}" already exists.`;
            errBox.style.display = "block";
            return;
        }
    }

    const saveBtn = document.getElementById("saveProgramSubmitBtn");
    const origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
        const docId = editingProgramId || code;
        const progRef = doc(db, "programs", docId);

        const dataToSave = {
            programCode: docId,
            courseCode: docId,
            programName: name,
            courseName: name,
            description: editingProgramId ? (programsList.find(p => p.programCode === docId)?.description || "") : "",
            status: status,
            updatedAt: serverTimestamp()
        };

        if (!editingProgramId) {
            dataToSave.createdAt = serverTimestamp();
        }

        await setDoc(progRef, dataToSave, { merge: true });

        const idx = programsList.findIndex(p => p.programCode === docId);
        if (idx >= 0) {
            programsList[idx] = { ...programsList[idx], ...dataToSave };
        } else {
            programsList.push({ id: docId, ...dataToSave });
            programsList.sort((a, b) => a.programCode.localeCompare(b.programCode));
        }

        showToast(`Program "${docId}" saved successfully.`);
        closeProgramModal();
        populateCurriculumFilterDropdowns();
        updateDashboardStatistics();
        renderProgramsTable();

    } catch (err) {
        console.error("Error saving program:", err);
        errBox.textContent = "Failed to save program: " + err.message;
        errBox.style.display = "block";
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    }
}

// Toggle Program Status
async function toggleProgramStatus(programCode, currentStatus) {
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";
    const actionWord = newStatus === "Inactive" ? "deactivate" : "activate";

    const confirmed = await showConfirmDialog({
        title: `${actionWord.toUpperCase()} PROGRAM`,
        message: `Are you sure you want to ${actionWord} program "${programCode}"?`,
        warning: newStatus === "Inactive" ? "Deactivating this program hides it from active class and exam scheduling selections." : "",
        okText: `Yes, ${actionWord}`,
        isDanger: newStatus === "Inactive"
    });

    if (!confirmed) return;

    try {
        await updateDoc(doc(db, "programs", programCode), {
            status: newStatus,
            updatedAt: serverTimestamp()
        });

        const prog = programsList.find(p => p.programCode === programCode);
        if (prog) prog.status = newStatus;

        showToast(`Program "${programCode}" is now ${newStatus}.`);
        renderProgramsTable();
    } catch (err) {
        console.error("Error toggling program status:", err);
        showToast("Failed to update program status: " + err.message, "error");
    }
}

// Delete Program Safely
async function deleteProgramSafely(programCode) {
    const hasMajors = majorsList.some(m => m.program === programCode || m.programCode === programCode);
    if (hasMajors) {
        await showConfirmDialog({
            title: "CANNOT DELETE PROGRAM",
            message: `Program "${programCode}" has active majors associated with it.`,
            warning: "Please delete or reassign all majors belonging to this program first, or simply deactivate the program instead.",
            okText: "Understood",
            isDanger: false
        });
        return;
    }

    const hasSubjects = prospectusSubjectsList.some(s => s.programCode === programCode);
    if (hasSubjects) {
        await showConfirmDialog({
            title: "CANNOT DELETE PROGRAM",
            message: `Program "${programCode}" has curriculum subjects assigned in the prospectus catalog.`,
            warning: "To maintain scheduling integrity, programs with assigned curriculum subjects cannot be deleted. You can deactivate it instead.",
            okText: "Understood",
            isDanger: false
        });
        return;
    }

    const confirmed = await showConfirmDialog({
        title: "DELETE PROGRAM",
        message: `Are you sure you want to permanently delete program "${programCode}"?`,
        warning: "This action cannot be undone.",
        okText: "Delete Permanently",
        isDanger: true
    });

    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, "programs", programCode));
        programsList = programsList.filter(p => p.programCode !== programCode);

        showToast(`Program "${programCode}" deleted successfully.`);
        populateCurriculumFilterDropdowns();
        updateDashboardStatistics();
        renderProgramsTable();
    } catch (err) {
        console.error("Error deleting program:", err);
        showToast("Failed to delete program: " + err.message, "error");
    }
}

/* ============================================================
   TAB 2: MANAGE MAJORS CRUD & RENDERING
   ============================================================ */

function getFilteredMajors() {
    const selectedProgram = document.getElementById("majorsProgramSelect").value;
    const search = document.getElementById("majorSearchInput").value.trim().toLowerCase();
    const status = document.getElementById("majorStatusFilter").value;

    return majorsList.filter(m => {
        if (selectedProgram && (m.program !== selectedProgram && m.programCode !== selectedProgram)) return false;
        if (status && m.status !== status) return false;
        if (search) {
            const codeMatch = m.majorCode.toLowerCase().includes(search);
            const nameMatch = m.majorName.toLowerCase().includes(search);
            const progMatch = (m.program || m.programCode || "").toLowerCase().includes(search);
            const descMatch = m.description.toLowerCase().includes(search);
            if (!codeMatch && !nameMatch && !progMatch && !descMatch) return false;
        }
        return true;
    });
}

function renderMajorsTable() {
    const tbody = document.getElementById("majorsTableBody");
    const countLabel = document.getElementById("majorsCountLabel");
    const prevBtn = document.getElementById("majorsPrevBtn");
    const nextBtn = document.getElementById("majorsNextBtn");
    const pageNum = document.getElementById("majorsPageNum");
    const selectedProgram = document.getElementById("majorsProgramSelect").value;
    const notice = document.getElementById("majorProgramNotice");

    const filtered = getFilteredMajors();
    const total = filtered.length;
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    if (majorsCurrentPage > totalPages) majorsCurrentPage = totalPages;
    if (majorsCurrentPage < 1) majorsCurrentPage = 1;

    const startIdx = (majorsCurrentPage - 1) * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    const pageData = filtered.slice(startIdx, endIdx);

    countLabel.textContent = `Showing ${Math.min(startIdx + 1, total)} to ${Math.min(endIdx, total)} of ${total} majors`;
    pageNum.textContent = `${majorsCurrentPage} / ${totalPages}`;
    prevBtn.disabled = majorsCurrentPage <= 1;
    nextBtn.disabled = majorsCurrentPage >= totalPages;

    if (selectedProgram) {
        notice.style.display = "block";
        notice.textContent = `Displaying majors under program "${selectedProgram}". Programs without specialized majors follow a standardized general curriculum.`;
    } else {
        notice.style.display = "none";
    }

    if (pageData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state-box">
                    <div class="empty-state-icon">📑</div>
                    <div class="empty-state-title">No Majors Found</div>
                    <p class="empty-state-text">
                        ${selectedProgram ? `No specialized majors registered for program "${selectedProgram}". This program offers a general curriculum.` : `No majors match your filter.`}
                    </p>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = pageData.map(m => {
        const isActive = m.status === "Active";
        const statusBadge = isActive
            ? `<span class="badge badge-active">Active</span>`
            : `<span class="badge badge-inactive">Inactive</span>`;
        const toggleBtnLabel = isActive ? "Deactivate" : "Activate";
        const toggleBtnClass = isActive ? "deactivate" : "activate";

        return `
            <tr>
                <td><span class="badge badge-code">${escapeHtml(m.majorCode)}</span></td>
                <td style="text-align: left; font-weight: 700; color: #222;">${escapeHtml(m.majorName)}</td>
                <td><span class="badge badge-program">${escapeHtml(m.program || m.programCode)}</span></td>
                <td>${statusBadge}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-action-edit" data-action="edit-major" data-id="${escapeHtml(m.id || `${m.program}-${m.majorCode}`)}">Edit</button>
                        <button class="btn-action-status ${toggleBtnClass}" data-action="toggle-major" data-id="${escapeHtml(m.id || `${m.program}-${m.majorCode}`)}" data-status="${escapeHtml(m.status)}">${toggleBtnLabel}</button>
                        <button class="btn-action-delete" data-action="delete-major" data-id="${escapeHtml(m.id || `${m.program}-${m.majorCode}`)}" title="Delete Major">✕</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

// Open Major Modal
function openMajorModal(majorIdToEdit = null) {
    const modal = document.getElementById("majorModal");
    const title = document.getElementById("majorModalTitle");
    const progSelect = document.getElementById("majorInputProgram");
    const codeInput = document.getElementById("majorInputCode");
    const nameInput = document.getElementById("majorInputName");
    const statusInput = document.getElementById("majorInputStatus");
    const errBox = document.getElementById("majorFormError");

    errBox.style.display = "none";
    errBox.textContent = "";

    progSelect.innerHTML = `<option value="">-- Select Parent Program --</option>`;
    programsList.filter(p => p.status === "Active").forEach(p => {
        progSelect.innerHTML += `<option value="${escapeHtml(p.programCode)}">${escapeHtml(p.programCode)} - ${escapeHtml(p.programName)}</option>`;
    });

    if (majorIdToEdit) {
        editingMajorId = majorIdToEdit;
        const major = majorsList.find(m => m.id === majorIdToEdit || `${m.program}-${m.majorCode}` === majorIdToEdit);
        title.textContent = "Edit Major";
        progSelect.value = major?.program || major?.programCode || "";
        progSelect.disabled = true;
        codeInput.value = major?.majorCode || "";
        codeInput.disabled = true;
        nameInput.value = major?.majorName || "";
        statusInput.value = major?.status || "Active";
    } else {
        editingMajorId = null;
        title.textContent = "Add New Major";
        const currentSelectedProg = document.getElementById("majorsProgramSelect").value;
        progSelect.value = currentSelectedProg || "";
        progSelect.disabled = false;
        codeInput.value = "";
        codeInput.disabled = false;
        nameInput.value = "";
        statusInput.value = "Active";
    }

    modal.style.display = "flex";
}

function closeMajorModal() {
    document.getElementById("majorModal").style.display = "none";
    editingMajorId = null;
}

// Save Major Form
async function handleMajorFormSubmit(e) {
    e.preventDefault();
    const errBox = document.getElementById("majorFormError");
    errBox.style.display = "none";

    const prog = document.getElementById("majorInputProgram").value.trim().toUpperCase();
    const code = document.getElementById("majorInputCode").value.trim().toUpperCase();
    const name = document.getElementById("majorInputName").value.trim();
    const status = document.getElementById("majorInputStatus").value;

    if (!prog || !code || !name) {
        errBox.textContent = "Parent Program, Major Code, and Major Name are required.";
        errBox.style.display = "block";
        return;
    }

    const docId = `${prog}-${code}`;

    if (!editingMajorId) {
        const existing = majorsList.find(m => (m.program === prog || m.programCode === prog) && m.majorCode === code);
        if (existing) {
            errBox.textContent = `Major "${code}" already exists under program "${prog}".`;
            errBox.style.display = "block";
            return;
        }
    }

    const saveBtn = document.getElementById("saveMajorSubmitBtn");
    const origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
        const majorRef = doc(db, "majors", docId);
        const dataToSave = {
            program: prog,
            programCode: prog,
            majorCode: code,
            majorName: name,
            description: editingMajorId ? (majorsList.find(m => m.id === docId)?.description || "") : "",
            status: status,
            updatedAt: serverTimestamp()
        };

        if (!editingMajorId) {
            dataToSave.createdAt = serverTimestamp();
        }

        await setDoc(majorRef, dataToSave, { merge: true });

        const idx = majorsList.findIndex(m => (m.id === docId) || ((m.program === prog || m.programCode === prog) && m.majorCode === code));
        if (idx >= 0) {
            majorsList[idx] = { ...majorsList[idx], ...dataToSave, id: docId };
        } else {
            majorsList.push({ id: docId, ...dataToSave });
            majorsList.sort((a, b) => a.majorCode.localeCompare(b.majorCode));
        }

        showToast(`Major "${code}" for ${prog} saved successfully.`);
        closeMajorModal();
        populateCurriculumFilterDropdowns();
        updateDashboardStatistics();
        renderMajorsTable();

    } catch (err) {
        console.error("Error saving major:", err);
        errBox.textContent = "Failed to save major: " + err.message;
        errBox.style.display = "block";
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    }
}

// Toggle Major Status
async function toggleMajorStatus(majorId, currentStatus) {
    const major = majorsList.find(m => m.id === majorId || `${m.program}-${m.majorCode}` === majorId);
    if (!major) return;

    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";
    const actionWord = newStatus === "Inactive" ? "deactivate" : "activate";

    const confirmed = await showConfirmDialog({
        title: `${actionWord.toUpperCase()} MAJOR`,
        message: `Are you sure you want to ${actionWord} major "${major.majorCode}" (${major.program})?`,
        warning: newStatus === "Inactive" ? "Inactive majors will be excluded from new class and exam generation filters." : "",
        okText: `Yes, ${actionWord}`,
        isDanger: newStatus === "Inactive"
    });

    if (!confirmed) return;

    try {
        await updateDoc(doc(db, "majors", major.id || `${major.program}-${major.majorCode}`), {
            status: newStatus,
            updatedAt: serverTimestamp()
        });

        major.status = newStatus;
        showToast(`Major "${major.majorCode}" is now ${newStatus}.`);
        renderMajorsTable();
    } catch (err) {
        console.error("Error toggling major status:", err);
        showToast("Failed to update major status: " + err.message, "error");
    }
}

// Delete Major Safely
async function deleteMajorSafely(majorId) {
    const major = majorsList.find(m => m.id === majorId || `${m.program}-${m.majorCode}` === majorId);
    if (!major) return;

    const hasSubjects = prospectusSubjectsList.some(s =>
        (s.programCode === major.program || s.programCode === major.programCode) &&
        s.majorCode === major.majorCode
    );

    if (hasSubjects) {
        await showConfirmDialog({
            title: "CANNOT DELETE MAJOR",
            message: `Major "${major.majorCode}" under ${major.program} has assigned curriculum subjects.`,
            warning: "Please remove or reassign all curriculum subjects belonging to this major first, or deactivate the major instead.",
            okText: "Understood",
            isDanger: false
        });
        return;
    }

    const confirmed = await showConfirmDialog({
        title: "DELETE MAJOR",
        message: `Are you sure you want to permanently delete major "${major.majorCode}" under ${major.program}?`,
        warning: "This action cannot be undone.",
        okText: "Delete Permanently",
        isDanger: true
    });

    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, "majors", major.id || `${major.program}-${major.majorCode}`));
        majorsList = majorsList.filter(m => m !== major);

        showToast(`Major "${major.majorCode}" deleted successfully.`);
        populateCurriculumFilterDropdowns();
        updateDashboardStatistics();
        renderMajorsTable();
    } catch (err) {
        console.error("Error deleting major:", err);
        showToast("Failed to delete major: " + err.message, "error");
    }
}

/* ============================================================
   TAB 3: MANAGE CURRICULUM SUBJECTS (PROSPECTUS SINGLE SOURCE OF TRUTH)
   ============================================================ */

function populateCurriculumFilterDropdowns() {
    // 1. Majors Program Filter (Tab 2)
    const majorsProgSelect = document.getElementById("majorsProgramSelect");
    const currentMajorsProg = majorsProgSelect.value;
    majorsProgSelect.innerHTML = `<option value="">-- All Programs --</option>`;
    programsList.forEach(p => {
        majorsProgSelect.innerHTML += `<option value="${escapeHtml(p.programCode)}">${escapeHtml(p.programCode)} - ${escapeHtml(p.programName)}</option>`;
    });
    majorsProgSelect.value = currentMajorsProg;

    // 2. Curriculum Subject Program Filter (Tab 3)
    const currProgSelect = document.getElementById("currFilterProgram");
    const currentProg = currProgSelect.value;
    currProgSelect.innerHTML = `<option value="">-- Select Program --</option>`;
    programsList.filter(p => p.status === "Active").forEach(p => {
        currProgSelect.innerHTML += `<option value="${escapeHtml(p.programCode)}">${escapeHtml(p.programCode)} - ${escapeHtml(p.programName)}</option>`;
    });

    if (currentProg && programsList.some(p => p.programCode === currentProg)) {
        currProgSelect.value = currentProg;
    } else if (programsList.length > 0) {
        currProgSelect.value = programsList[0].programCode;
    }

    updateCurriculumMajorFilterOptions();
}

function updateCurriculumMajorFilterOptions() {
    const progCode = document.getElementById("currFilterProgram").value;
    const majorSelect = document.getElementById("currFilterMajor");
    const currentVal = majorSelect.value;

    majorSelect.innerHTML = `<option value="">All Majors / General</option>`;

    if (!progCode) return;

    const availableMajors = majorsList.filter(m =>
        (m.program === progCode || m.programCode === progCode) && m.status === "Active"
    );

    availableMajors.forEach(m => {
        majorSelect.innerHTML += `<option value="${escapeHtml(m.majorCode)}">${escapeHtml(m.majorCode)} - ${escapeHtml(m.majorName)}</option>`;
    });

    if (currentVal && availableMajors.some(m => m.majorCode === currentVal)) {
        majorSelect.value = currentVal;
    } else {
        majorSelect.value = "";
    }
}

function getActiveCurriculumSubjects() {
    const prog = document.getElementById("currFilterProgram").value;
    const major = document.getElementById("currFilterMajor").value;
    const yearVal = document.getElementById("currFilterYear").value;
    const semVal = document.getElementById("currFilterSem").value;
    const search = document.getElementById("currSubjectSearchInput").value.trim().toLowerCase();

    if (!prog) return [];

    return prospectusSubjectsList.filter(s => {
        if (s.programCode !== prog) return false;

        // Major filter: if a specific major is chosen, match it; otherwise allow all for that program
        if (major) {
            if (s.majorCode !== major) return false;
        }

        // Year Level filter: if selected, match it; otherwise allow all year levels
        if (yearVal) {
            if (Number(s.yearLevel) !== Number(yearVal)) return false;
        }

        // Semester filter: if selected, match it; otherwise allow all semesters
        if (semVal) {
            if (Number(s.semester) !== Number(semVal)) return false;
        }

        // Search text matching
        if (search) {
            const codeMatch = s.subjectCode.toLowerCase().includes(search);
            const nameMatch = s.subjectName.toLowerCase().includes(search);
            const prereqMatch = s.prerequisite.toLowerCase().includes(search);
            if (!codeMatch && !nameMatch && !prereqMatch) return false;
        }

        return true;
    });
}

function renderCurriculumSubjects() {
    const tbody = document.getElementById("currSubjectsTableBody");
    const prog = document.getElementById("currFilterProgram").value;
    const major = document.getElementById("currFilterMajor").value;
    const yearVal = document.getElementById("currFilterYear").value;
    const semVal = document.getElementById("currFilterSem").value;

    const subjects = getActiveCurriculumSubjects();

    // Summary calculation
    let totalUnits = 0;
    let totalLec = 0;
    let totalLab = 0;
    let totalWeekly = 0;

    subjects.forEach(s => {
        totalUnits += s.units;
        totalLec += s.lecHours;
        totalLab += s.labHours;
        totalWeekly += s.hoursPerWeek || (s.lecHours + s.labHours);
    });

    const elSubjs = document.getElementById("currSumSubjects");
    if (elSubjs) elSubjs.textContent = subjects.length;

    const elUnits = document.getElementById("currSumUnits");
    if (elUnits) elUnits.textContent = totalUnits;

    const elLec = document.getElementById("currSumLec");
    if (elLec) elLec.textContent = totalLec;

    const elLab = document.getElementById("currSumLab");
    if (elLab) elLab.textContent = totalLab;

    const elWeekly = document.getElementById("currSumWeekly");
    if (elWeekly) elWeekly.textContent = totalWeekly;

    if (!prog) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="empty-state-box">
                    <div class="empty-state-icon">📚</div>
                    <div class="empty-state-title">Select an Academic Program</div>
                    <p class="empty-state-text">Choose a program above to view and manage its prospectus curriculum subjects.</p>
                </td>
            </tr>
        `;
        const pag = document.getElementById("currSubjectsPagination");
        if (pag) pag.style.display = "none";
        return;
    }

    if (subjects.length === 0) {
        const filterDetails = [
            prog,
            major ? `Major: ${major}` : null,
            yearVal ? `Year ${yearVal}` : null,
            semVal ? `Sem ${semVal}` : null
        ].filter(Boolean).join(", ");

        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="empty-state-box">
                    <div class="empty-state-icon">📖</div>
                    <div class="empty-state-title">No Subjects Found in Prospectus</div>
                    <p class="empty-state-text">No curriculum subjects matching (${filterDetails}). Click "Add Subject to Curriculum" to assign subjects.</p>
                </td>
            </tr>
        `;
        const pag = document.getElementById("currSubjectsPagination");
        if (pag) pag.style.display = "none";
        return;
    }

    // Pagination
    const countLabel = document.getElementById("currSubjectsCountLabel");
    const prevBtn = document.getElementById("currSubjectsPrevBtn");
    const nextBtn = document.getElementById("currSubjectsNextBtn");
    const pageNum = document.getElementById("currSubjectsPageNum");
    const paginationContainer = document.getElementById("currSubjectsPagination");

    paginationContainer.style.display = "flex";
    const total = subjects.length;
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    if (currSubjectsCurrentPage > totalPages) currSubjectsCurrentPage = totalPages;
    if (currSubjectsCurrentPage < 1) currSubjectsCurrentPage = 1;

    const startIdx = (currSubjectsCurrentPage - 1) * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    const pageData = subjects.slice(startIdx, endIdx);

    countLabel.textContent = `Showing ${Math.min(startIdx + 1, total)} to ${Math.min(endIdx, total)} of ${total} subjects`;
    pageNum.textContent = `${currSubjectsCurrentPage} / ${totalPages}`;
    prevBtn.disabled = currSubjectsCurrentPage <= 1;
    nextBtn.disabled = currSubjectsCurrentPage >= totalPages;

    tbody.innerHTML = pageData.map(s => {
        const isActive = s.status === "Active";
        const statusBadge = isActive
            ? `<span class="badge badge-active">Active</span>`
            : `<span class="badge badge-inactive">Inactive</span>`;
        const toggleBtnLabel = isActive ? "Deactivate" : "Activate";
        const toggleBtnClass = isActive ? "deactivate" : "activate";

        return `
            <tr>
                <td><span class="badge badge-code">${escapeHtml(s.subjectCode)}</span></td>
                <td style="text-align: left; font-weight: 700; color: #222;">${escapeHtml(s.subjectName)}</td>
                <td><span class="badge badge-units">${s.units}</span></td>
                <td>${s.lecHours}</td>
                <td>${s.labHours}</td>
                <td style="font-weight: 700; color: var(--dark);">${s.hoursPerWeek || (s.lecHours + s.labHours)} hrs</td>
                <td style="text-align: left; font-size: 13px; color: #555;">${escapeHtml(s.prerequisite || "None")}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-action-edit" data-action="edit-subject" data-id="${escapeHtml(s.id)}">Edit</button>
                        <button class="btn-action-status ${toggleBtnClass}" data-action="toggle-subject" data-id="${escapeHtml(s.id)}" data-status="${escapeHtml(s.status)}">${toggleBtnLabel}</button>
                        <button class="btn-action-delete" data-action="delete-subject" data-id="${escapeHtml(s.id)}" title="Delete Subject from Prospectus">✕</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

// Generate next sequential document ID for prospectus
function generateNextProspectusDocId(programCode, majorCode) {
    const prefix = majorCode ? `${programCode}-${majorCode}` : `${programCode}-GEN`;
    let maxCounter = 0;

    prospectusSubjectsList.forEach(s => {
        if (s.id && s.id.startsWith(prefix + "-")) {
            const part = s.id.slice(prefix.length + 1);
            const num = parseInt(part, 10);
            if (!isNaN(num) && num > maxCounter) {
                maxCounter = num;
            }
        }
    });

    const nextCounter = maxCounter + 1;
    return `${prefix}-${String(nextCounter).padStart(2, "0")}`;
}

// Open Subject Modal
function openSubjectModal(subjectIdToEdit = null) {
    const modal = document.getElementById("subjectModal");
    const title = document.getElementById("subjectModalTitle");

    const modalProgSelect = document.getElementById("subjModalProgSelect");
    const modalMajorSelect = document.getElementById("subjModalMajorSelect");
    const modalYearSelect = document.getElementById("subjModalYearSelect");
    const modalSemSelect = document.getElementById("subjModalSemSelect");

    const codeInput = document.getElementById("subjInputCode");
    const nameInput = document.getElementById("subjInputName");
    const unitsInput = document.getElementById("subjInputUnits");
    const lecInput = document.getElementById("subjInputLec");
    const labInput = document.getElementById("subjInputLab");
    const calcHours = document.getElementById("subjCalculatedHours");
    const prereqInput = document.getElementById("subjInputPrereq");
    const typeInput = document.getElementById("subjInputType");
    const roomTypeInput = document.getElementById("subjInputRoomType");
    const statusInput = document.getElementById("subjInputStatus");
    const errBox = document.getElementById("subjectFormError");

    errBox.style.display = "none";
    errBox.textContent = "";

    // Populate Modal Program dropdown
    modalProgSelect.innerHTML = `<option value="">-- Select Program --</option>`;
    programsList.filter(p => p.status === "Active").forEach(p => {
        modalProgSelect.innerHTML += `<option value="${escapeHtml(p.programCode)}">${escapeHtml(p.programCode)} - ${escapeHtml(p.programName)}</option>`;
    });

    function updateModalMajors(selectedProg, preselectMajor = "") {
        modalMajorSelect.innerHTML = `<option value="">-- No Major / General --</option>`;
        if (!selectedProg) return;
        const majors = majorsList.filter(m => (m.program === selectedProg || m.programCode === selectedProg) && m.status === "Active");
        majors.forEach(m => {
            modalMajorSelect.innerHTML += `<option value="${escapeHtml(m.majorCode)}">${escapeHtml(m.majorCode)} - ${escapeHtml(m.majorName)}</option>`;
        });
        modalMajorSelect.value = preselectMajor || "";
    }

    modalProgSelect.onchange = () => {
        updateModalMajors(modalProgSelect.value);
    };

    const currentFilterProg = document.getElementById("currFilterProgram").value;
    const currentFilterMajor = document.getElementById("currFilterMajor").value;
    const currentFilterYear = document.getElementById("currFilterYear").value || "1";
    const currentFilterSem = document.getElementById("currFilterSem").value || "1";

    if (subjectIdToEdit) {
        editingSubjectId = subjectIdToEdit;
        const subj = prospectusSubjectsList.find(s => s.id === subjectIdToEdit);
        title.textContent = "Edit Curriculum Subject in Prospectus";

        modalProgSelect.value = subj?.programCode || currentFilterProg;
        updateModalMajors(modalProgSelect.value, subj?.majorCode || "");
        modalYearSelect.value = subj?.yearLevel || currentFilterYear;
        modalSemSelect.value = subj?.semester || currentFilterSem;

        codeInput.value = subj?.subjectCode || "";
        codeInput.disabled = true; // Subject code key identifier
        nameInput.value = subj?.subjectName || "";
        unitsInput.value = subj?.units ?? 3;
        lecInput.value = subj?.lecHours ?? 3;
        labInput.value = subj?.labHours ?? 0;
        calcHours.value = `${(Number(subj?.lecHours || 0) + Number(subj?.labHours || 0))} hrs / week`;
        prereqInput.value = subj?.prerequisite || "";
        typeInput.value = subj?.subjectType || "Major";
        roomTypeInput.value = subj?.requiredRoomType || "Lecture Room";
        statusInput.value = subj?.status || "Active";
    } else {
        editingSubjectId = null;
        title.textContent = "Add Subject to Curriculum (Prospectus)";

        modalProgSelect.value = currentFilterProg;
        updateModalMajors(currentFilterProg, currentFilterMajor);
        modalYearSelect.value = currentFilterYear;
        modalSemSelect.value = currentFilterSem;

        codeInput.value = "";
        codeInput.disabled = false;
        nameInput.value = "";
        unitsInput.value = 3;
        lecInput.value = 3;
        labInput.value = 0;
        calcHours.value = "3 hrs / week";
        prereqInput.value = "";
        typeInput.value = "Major";
        roomTypeInput.value = "Lecture Room";
        statusInput.value = "Active";
    }

    modal.style.display = "flex";
}

function closeSubjectModal() {
    document.getElementById("subjectModal").style.display = "none";
    editingSubjectId = null;
}

// Subject Form Submission - Directly saves to PROSPECTUS collection
async function handleSubjectFormSubmit(e) {
    e.preventDefault();
    const errBox = document.getElementById("subjectFormError");
    errBox.style.display = "none";

    const prog = document.getElementById("subjModalProgSelect").value.trim().toUpperCase();
    const major = document.getElementById("subjModalMajorSelect").value.trim().toUpperCase();
    const year = Number(document.getElementById("subjModalYearSelect").value) || 1;
    const sem = Number(document.getElementById("subjModalSemSelect").value) || 1;

    const code = document.getElementById("subjInputCode").value.trim().toUpperCase();
    const name = document.getElementById("subjInputName").value.trim();
    const units = Number(document.getElementById("subjInputUnits").value) || 0;
    const lec = Number(document.getElementById("subjInputLec").value) || 0;
    const lab = Number(document.getElementById("subjInputLab").value) || 0;
    const prereq = document.getElementById("subjInputPrereq").value.trim();
    const type = document.getElementById("subjInputType").value;
    const roomType = document.getElementById("subjInputRoomType").value;
    const status = document.getElementById("subjInputStatus").value;

    if (!prog || !code || !name) {
        errBox.textContent = "Program, Subject Code, and Subject Name are required.";
        errBox.style.display = "block";
        return;
    }

    // Check duplicate assignment within the same curriculum grouping
    if (!editingSubjectId) {
        const isDuplicate = prospectusSubjectsList.some(s =>
            s.programCode === prog &&
            (major ? s.majorCode === major : (!s.majorCode || s.majorCode === "GEN")) &&
            s.yearLevel === year &&
            s.semester === sem &&
            s.subjectCode === code
        );

        if (isDuplicate) {
            errBox.textContent = `Subject "${code}" is already assigned to this curriculum grouping (${prog}${major ? ' - ' + major : ''}, Year ${year}, Sem ${sem}).`;
            errBox.style.display = "block";
            return;
        }
    }

    const saveBtn = document.getElementById("saveSubjectSubmitBtn");
    const origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
        // Document ID: preserve existing if editing, otherwise generate sequential prospectus ID
        let docId = editingSubjectId;
        if (!docId) {
            docId = generateNextProspectusDocId(prog, major);
        }

        const meetingType = (lec > 0 && lab > 0) ? "Lecture+Laboratory" : (lab > 0 ? "Laboratory" : "Lecture");
        const hoursPerWeek = lec + lab;

        const subjectRecord = {
            subjectCode: code,
            subjectName: name,
            programCode: prog,
            majorCode: major || "",
            yearLevel: year,
            semester: sem,
            units: units,
            lecHours: lec,
            labHours: lab,
            hoursPerWeek: hoursPerWeek,
            prerequisite: prereq,
            subjectType: type,
            requiredRoomType: roomType,
            meetingType: meetingType,
            status: status,
            updatedAt: serverTimestamp()
        };

        if (!editingSubjectId) {
            subjectRecord.createdAt = serverTimestamp();
        }

        // WRITE DIRECTLY AND EXCLUSIVELY TO 'prospectus' (Single Source of Truth)
        const prospectusRef = doc(db, "prospectus", docId);
        await setDoc(prospectusRef, subjectRecord, { merge: true });

        // Update local state
        const idx = prospectusSubjectsList.findIndex(s => s.id === docId);
        if (idx >= 0) {
            prospectusSubjectsList[idx] = { ...prospectusSubjectsList[idx], ...subjectRecord, id: docId };
        } else {
            prospectusSubjectsList.push({ ...subjectRecord, id: docId });
        }

        buildUniqueSubjectCatalog();
        updateDashboardStatistics();

        showToast(`Subject "${code}" (${docId}) saved successfully in prospectus.`);
        closeSubjectModal();
        renderCurriculumSubjects();

    } catch (err) {
        console.error("Error saving prospectus subject:", err);
        errBox.textContent = "Failed to save subject: " + err.message;
        errBox.style.display = "block";
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    }
}

// Toggle Subject Status in Prospectus
async function toggleSubjectStatus(subjectDocId, currentStatus) {
    const subject = prospectusSubjectsList.find(s => s.id === subjectDocId);
    if (!subject) return;

    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";
    const actionWord = newStatus === "Inactive" ? "deactivate" : "activate";

    const confirmed = await showConfirmDialog({
        title: `${actionWord.toUpperCase()} SUBJECT`,
        message: `Are you sure you want to ${actionWord} "${subject.subjectCode} - ${subject.subjectName}"?`,
        warning: newStatus === "Inactive" ? "Inactive subjects will not be scheduled in newly generated class or examination timetables." : "",
        okText: `Yes, ${actionWord}`,
        isDanger: newStatus === "Inactive"
    });

    if (!confirmed) return;

    try {
        const updatePayload = {
            status: newStatus,
            updatedAt: serverTimestamp()
        };

        await updateDoc(doc(db, "prospectus", subjectDocId), updatePayload);

        subject.status = newStatus;
        showToast(`Subject "${subject.subjectCode}" is now ${newStatus}.`);
        renderCurriculumSubjects();
    } catch (err) {
        console.error("Error toggling subject status:", err);
        showToast("Failed to update status: " + err.message, "error");
    }
}

// Delete Subject from Prospectus with Reference Safety Check
async function deleteSubjectSafely(subjectDocId) {
    const subject = prospectusSubjectsList.find(s => s.id === subjectDocId);
    if (!subject) return;

    try {
        // 1. Check Class Schedules
        const classSchedulesSnap = await getDocs(collection(db, "classSchedules"));
        let inClassSchedule = false;
        let referencingScheduleSection = "";

        classSchedulesSnap.forEach(d => {
            const data = d.data();
            if (Array.isArray(data.entries)) {
                const found = data.entries.some(e =>
                    String(e.code || "").trim().toUpperCase() === subject.subjectCode &&
                    (data.program === subject.programCode || !data.program)
                );
                if (found) {
                    inClassSchedule = true;
                    referencingScheduleSection = data.section || d.id;
                }
            }
        });

        if (inClassSchedule) {
            await showConfirmDialog({
                title: "CANNOT REMOVE SUBJECT",
                message: `Subject "${subject.subjectCode}" is referenced in existing class schedule for "${referencingScheduleSection}".`,
                warning: "To protect existing timetables and student schedules, this subject cannot be deleted. You can mark it as 'Inactive' instead.",
                okText: "Understood",
                isDanger: false
            });
            return;
        }

        // 2. Check Exam Schedules
        const examSchedulesSnap = await getDocs(collection(db, "examSchedules"));
        let inExamSchedule = false;
        examSchedulesSnap.forEach(d => {
            const data = d.data();
            if (Array.isArray(data.exams)) {
                const found = data.exams.some(e => String(e.code || "").trim().toUpperCase() === subject.subjectCode);
                if (found) inExamSchedule = true;
            }
        });

        if (inExamSchedule) {
            await showConfirmDialog({
                title: "CANNOT REMOVE SUBJECT",
                message: `Subject "${subject.subjectCode}" is referenced in existing examination schedules.`,
                warning: "Please deactivate the subject instead to preserve examination records.",
                okText: "Understood",
                isDanger: false
            });
            return;
        }

        // 3. Confirm deletion
        const confirmed = await showConfirmDialog({
            title: "DELETE PROSPECTUS SUBJECT",
            message: `Are you sure you want to permanently delete "${subject.subjectCode} - ${subject.subjectName}" (${subjectDocId}) from the prospectus?`,
            warning: "This will permanently remove the subject record from the prospectus collection.",
            okText: "Delete Permanently",
            isDanger: true
        });

        if (!confirmed) return;

        // DELETE DIRECTLY FROM 'prospectus'
        await deleteDoc(doc(db, "prospectus", subjectDocId));

        prospectusSubjectsList = prospectusSubjectsList.filter(s => s.id !== subjectDocId);
        buildUniqueSubjectCatalog();
        updateDashboardStatistics();

        showToast(`Subject "${subject.subjectCode}" deleted from prospectus.`);
        renderCurriculumSubjects();

    } catch (err) {
        console.error("Error checking or deleting subject:", err);
        showToast("Error processing request: " + err.message, "error");
    }
}

/* ============================================================
   EVENT LISTENERS SETUP
   ============================================================ */

function setupEventListeners() {
    // Program Table Search & Filter
    document.getElementById("programSearchInput").addEventListener("input", () => {
        programsCurrentPage = 1;
        renderProgramsTable();
    });

    document.getElementById("programStatusFilter").addEventListener("change", () => {
        programsCurrentPage = 1;
        renderProgramsTable();
    });

    document.getElementById("programsPrevBtn").addEventListener("click", () => {
        if (programsCurrentPage > 1) {
            programsCurrentPage--;
            renderProgramsTable();
        }
    });

    document.getElementById("programsNextBtn").addEventListener("click", () => {
        programsCurrentPage++;
        renderProgramsTable();
    });

    document.getElementById("openAddProgramBtn").addEventListener("click", () => openProgramModal());
    document.getElementById("closeProgramModalBtn").addEventListener("click", closeProgramModal);
    document.getElementById("cancelProgramModalBtn").addEventListener("click", closeProgramModal);
    document.getElementById("programForm").addEventListener("submit", handleProgramFormSubmit);

    // Major Table Search & Filter
    document.getElementById("majorsProgramSelect").addEventListener("change", () => {
        majorsCurrentPage = 1;
        renderMajorsTable();
    });

    document.getElementById("majorSearchInput").addEventListener("input", () => {
        majorsCurrentPage = 1;
        renderMajorsTable();
    });

    document.getElementById("majorStatusFilter").addEventListener("change", () => {
        majorsCurrentPage = 1;
        renderMajorsTable();
    });

    document.getElementById("majorsPrevBtn").addEventListener("click", () => {
        if (majorsCurrentPage > 1) {
            majorsCurrentPage--;
            renderMajorsTable();
        }
    });

    document.getElementById("majorsNextBtn").addEventListener("click", () => {
        majorsCurrentPage++;
        renderMajorsTable();
    });

    document.getElementById("openAddMajorBtn").addEventListener("click", () => openMajorModal());
    document.getElementById("closeMajorModalBtn").addEventListener("click", closeMajorModal);
    document.getElementById("cancelMajorModalBtn").addEventListener("click", closeMajorModal);
    document.getElementById("majorForm").addEventListener("submit", handleMajorFormSubmit);

    // Curriculum Filters (Tab 3)
    document.getElementById("currFilterProgram").addEventListener("change", () => {
        updateCurriculumMajorFilterOptions();
        currSubjectsCurrentPage = 1;
        renderCurriculumSubjects();
    });

    document.getElementById("currFilterMajor").addEventListener("change", () => {
        currSubjectsCurrentPage = 1;
        renderCurriculumSubjects();
    });

    document.getElementById("currFilterYear").addEventListener("change", () => {
        currSubjectsCurrentPage = 1;
        renderCurriculumSubjects();
    });

    document.getElementById("currFilterSem").addEventListener("change", () => {
        currSubjectsCurrentPage = 1;
        renderCurriculumSubjects();
    });

    document.getElementById("currSubjectSearchInput").addEventListener("input", () => {
        currSubjectsCurrentPage = 1;
        renderCurriculumSubjects();
    });

    document.getElementById("currSubjectsPrevBtn").addEventListener("click", () => {
        if (currSubjectsCurrentPage > 1) {
            currSubjectsCurrentPage--;
            renderCurriculumSubjects();
        }
    });

    document.getElementById("currSubjectsNextBtn").addEventListener("click", () => {
        currSubjectsCurrentPage++;
        renderCurriculumSubjects();
    });

    // Subject Modal Controls
    document.getElementById("openAddSubjectBtn").addEventListener("click", () => openSubjectModal());
    document.getElementById("closeSubjectModalBtn").addEventListener("click", closeSubjectModal);
    document.getElementById("cancelSubjectModalBtn").addEventListener("click", closeSubjectModal);
    document.getElementById("subjectForm").addEventListener("submit", handleSubjectFormSubmit);

    // Hours per week recalculation
    function updateHoursCalc() {
        const lec = Number(document.getElementById("subjInputLec").value) || 0;
        const lab = Number(document.getElementById("subjInputLab").value) || 0;
        document.getElementById("subjCalculatedHours").value = `${lec + lab} hrs / week`;
    }

    document.getElementById("subjInputLec").addEventListener("input", updateHoursCalc);
    document.getElementById("subjInputLab").addEventListener("input", updateHoursCalc);

    // Event Delegation for Table Action Buttons
    document.addEventListener("click", e => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;

        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const status = btn.dataset.status;

        // Programs Actions
        if (action === "edit-program") openProgramModal(id);
        if (action === "toggle-program") toggleProgramStatus(id, status);
        if (action === "delete-program") deleteProgramSafely(id);

        // Majors Actions
        if (action === "edit-major") openMajorModal(id);
        if (action === "toggle-major") toggleMajorStatus(id, status);
        if (action === "delete-major") deleteMajorSafely(id);

        // Subjects Actions
        if (action === "edit-subject") openSubjectModal(id);
        if (action === "toggle-subject") toggleSubjectStatus(id, status);
        if (action === "delete-subject") deleteSubjectSafely(id);
    });

    // Close modals on backdrop click
    window.addEventListener("click", e => {
        if (e.target.classList.contains("modal-overlay")) {
            e.target.style.display = "none";
        }
    });
}
