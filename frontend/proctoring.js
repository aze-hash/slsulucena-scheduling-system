import { db } from "../firebase.js";
import { loadReportsFromFirestore, deleteReportsByCategoryFromFirestore } from "./reportStorage.js";

import {
    collection,
    getDocs,
    deleteDoc,
    doc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ------------------------------------------------------------------ */
/*  Toast Notification                                                */
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

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function normalise(str) {
    return String(str || "").trim().toLowerCase();
}

function readLocalStorageSchedules(key) {
    try {
        const val = JSON.parse(localStorage.getItem(key));
        return Array.isArray(val) ? val : [];
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ */
/*  State & Data Loading                                              */
/* ------------------------------------------------------------------ */

let proctoringRecords = [];
let searchName = "";
let filterYear = "";
let filterSemester = "";
let filterSection = "";
let filterExamType = "";

function populateFilters(records) {
    const yearSelect = document.getElementById("proctorAcademicYear");
    const sectionSelect = document.getElementById("proctorSection");

    if (yearSelect) {
        const currentAy = yearSelect.value;
        const years = [...new Set(records.map(r => r.academicYear).filter(Boolean))].sort((a, b) => b.localeCompare(a));
        yearSelect.innerHTML = `<option value="">All Academic Years</option>` +
            years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
        if (currentAy && years.includes(currentAy)) yearSelect.value = currentAy;
    }

    if (sectionSelect) {
        const currentSec = sectionSelect.value;
        const sections = [...new Set(records.map(r => r.section).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        sectionSelect.innerHTML = `<option value="">All Sections</option>` +
            sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
        if (currentSec && sections.includes(currentSec)) sectionSelect.value = currentSec;
    }
}

function extractPersonName(data) {
    if (!data) return "";
    if (typeof data === "string") return data.trim();
    if (typeof data === "object") {
        return data.name || data.fullName || data.facultyName || data.displayName ||
            [data.firstName, data.lastName].filter(Boolean).join(" ") || "";
    }
    return "";
}

async function loadFacultyUsersMap() {
    const map = new Map();
    try {
        const userSnapshot = await getDocs(collection(db, "users"));
        userSnapshot.docs.forEach(d => {
            const data = d.data();
            const name = extractPersonName(data);
            if (name) {
                map.set(d.id, name);
                if (data.uid) map.set(data.uid, name);
            }
        });

        const facultySnapshot = await getDocs(collection(db, "faculty"));
        facultySnapshot.docs.forEach(d => {
            const data = d.data();
            const name = extractPersonName(data);
            if (name) {
                if (!map.has(d.id)) map.set(d.id, name);
                if (data.uid && !map.has(data.uid)) map.set(data.uid, name);
            }
        });
    } catch (err) {
        console.warn("Could not load users/faculty map:", err);
    }
    return map;
}

function resolveFacultyName(sched, usersMap) {
    const raw = sched.proctor || sched.proctorName || sched.facultyName ||
                sched.assignedFaculty || sched.assignedProctor || "";
    const nameFromRaw = extractPersonName(raw);
    if (nameFromRaw) {
        if (usersMap && usersMap.has(nameFromRaw)) {
            return usersMap.get(nameFromRaw);
        }
        return nameFromRaw;
    }

    const id = sched.proctorId || sched.assignedFacultyId || sched.facultyId || sched.facultyUID || sched.userId || "";
    if (id && usersMap && usersMap.has(String(id).trim())) {
        return usersMap.get(String(id).trim());
    }

    return "Unassigned";
}

async function loadProctoringData() {
    try {
        const usersMap = await loadFacultyUsersMap();

        let firestoreSchedules = [];
        try {
            const examSnapshot = await getDocs(collection(db, "examSchedules"));
            firestoreSchedules = examSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.warn("Could not fetch Firestore examSchedules:", e);
        }

        const localSchedules = readLocalStorageSchedules("chairpersonExamSchedules");

        const mergedSchedules = [...firestoreSchedules];
        for (const local of localSchedules) {
            const docId = local.id || "";
            if (docId && !mergedSchedules.some(item => item.id === docId)) {
                mergedSchedules.push(local);
            } else if (!docId) {
                const key = `${local.section}|${local.semester}|${local.examType}`;
                if (!mergedSchedules.some(item => `${item.section}|${item.semester}|${item.examType}` === key)) {
                    mergedSchedules.push(local);
                }
            }
        }

        const records = [];
        for (const sched of mergedSchedules) {
            const facultyName = resolveFacultyName(sched, usersMap);
            const sectionName = sched.section || sched.sectionName || sched.className || sched.name || "Section Schedule";

            records.push({
                id: sched.id || `local-${Math.random()}`,
                facultyName,
                academicYear: sched.academicYear || "",
                semester: sched.semester || "",
                section: sectionName,
                examType: sched.examType || "Preliminary",
                exams: sched.exams || [],
                examDates: sched.examDates || {},
                createdAt: sched.createdAt?.toDate?.()?.toISOString?.() || sched.createdAt || new Date().toISOString()
            });
        }

        proctoringRecords = records;
        populateFilters(proctoringRecords);
        renderProctoringTable();
    } catch (error) {
        console.error("Could not load proctoring data:", error);
        showToast("Error loading faculty proctoring data.");
    }
}

/* ------------------------------------------------------------------ */
/*  Render Table                                                      */
/* ------------------------------------------------------------------ */

function renderProctoringTable() {
    const tbody = document.getElementById("proctoringTableBody");
    const emptyNote = document.getElementById("emptyProctoringNote");

    if (!tbody || !emptyNote) return;

    let filtered = [...proctoringRecords];

    if (searchName) {
        const term = normalise(searchName);
        filtered = filtered.filter(r => normalise(r.facultyName).includes(term));
    }
    if (filterYear) {
        filtered = filtered.filter(r => (r.academicYear || "") === filterYear);
    }
    if (filterSemester) {
        filtered = filtered.filter(r => (r.semester || "") === filterSemester);
    }
    if (filterSection) {
        filtered = filtered.filter(r => (r.section || "") === filterSection);
    }
    if (filterExamType) {
        filtered = filtered.filter(r => (r.examType || "") === filterExamType);
    }

    filtered.sort((a, b) => a.facultyName.localeCompare(b.facultyName));

    if (!filtered.length) {
        tbody.innerHTML = "";
        emptyNote.hidden = false;
        emptyNote.textContent = proctoringRecords.length === 0
            ? "No faculty proctoring exam schedules available."
            : "No faculty proctoring exam schedules found matching the selected filters.";
        return;
    }

    emptyNote.hidden = true;

    tbody.innerHTML = filtered.map(item => `
        <tr>
            <td class="faculty-name-cell" style="font-weight:bold;">${escapeHtml(item.facultyName)}</td>
            <td>${escapeHtml(item.academicYear ? `A.Y. ${item.academicYear}` : "—")}</td>
            <td>${escapeHtml(item.semester || "—")}</td>
            <td>${escapeHtml(item.section || "—")}</td>
            <td>${escapeHtml(item.examType || "—")}</td>
        </tr>
    `).join("");
}

/* ------------------------------------------------------------------ */
/*  Delete All Action                                                 */
/* ------------------------------------------------------------------ */

async function deleteAllProctoringSchedules() {
    const confirmed = confirm("Are you sure you want to delete all faculty proctoring schedule records?");
    if (!confirmed) return;

    try {
        const examSnapshot = await getDocs(collection(db, "examSchedules"));
        const deletePromises = examSnapshot.docs.map(d => deleteDoc(doc(db, "examSchedules", d.id)));
        await Promise.all(deletePromises);

        await deleteReportsByCategoryFromFirestore("Exam Schedule");

        searchName = "";
        filterYear = "";
        filterSemester = "";
        filterSection = "";
        filterExamType = "";

        const nameInput = document.getElementById("proctorSearchName");
        const yearSelect = document.getElementById("proctorAcademicYear");
        const semSelect = document.getElementById("proctorSemester");
        const secSelect = document.getElementById("proctorSection");
        const typeSelect = document.getElementById("proctorExamType");

        if (nameInput) nameInput.value = "";
        if (yearSelect) yearSelect.value = "";
        if (semSelect) semSelect.value = "";
        if (secSelect) secSelect.value = "";
        if (typeSelect) typeSelect.value = "";

        await loadProctoringData();
        showToast("All faculty proctoring schedule records have been deleted.");
    } catch (error) {
        console.error("Could not delete proctoring schedule records:", error);
        showToast("Error deleting faculty proctoring schedule records.");
    }
}

/* ------------------------------------------------------------------ */
/*  Event Listeners & Init                                            */
/* ------------------------------------------------------------------ */

document.getElementById("proctorSearchName")?.addEventListener("input", event => {
    searchName = event.target.value;
    renderProctoringTable();
});

document.getElementById("proctorAcademicYear")?.addEventListener("change", event => {
    filterYear = event.target.value;
    renderProctoringTable();
});

document.getElementById("proctorSemester")?.addEventListener("change", event => {
    filterSemester = event.target.value;
    renderProctoringTable();
});

document.getElementById("proctorSection")?.addEventListener("change", event => {
    filterSection = event.target.value;
    renderProctoringTable();
});

document.getElementById("proctorExamType")?.addEventListener("change", event => {
    filterExamType = event.target.value;
    renderProctoringTable();
});

document.getElementById("deleteAllProctoringBtn")?.addEventListener("click", deleteAllProctoringSchedules);

loadProctoringData();
