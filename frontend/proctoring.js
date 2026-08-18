import { db } from "../firebase.js";
import { deleteReportsByCategoryFromFirestore } from "./reportStorage.js";

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

        const examSnapshot = await getDocs(collection(db, "examSchedules"));
        const firestoreSchedules = examSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        const records = [];
        for (const sched of firestoreSchedules) {
            const facultyName = resolveFacultyName(sched, usersMap);
            const sectionName = sched.section || sched.sectionName || sched.className || sched.name || "Section Schedule";

            records.push({
                id: sched.id,
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
        console.error("Error loading faculty proctoring data from Firestore:", error);
        proctoringRecords = [];
        populateFilters([]);
        renderProctoringTable();
        showToast("Error loading faculty proctoring data from Firestore.");
    }
}

/* ------------------------------------------------------------------ */
/*  PDF Viewing / Print Generator (1:1 with exam.js export style)     */
/* ------------------------------------------------------------------ */

function formatExamDate(dateStr) {
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

function openProctoringSchedulePdf(recordId) {
    const record = proctoringRecords.find(r => r.id === recordId);
    if (!record) {
        showToast("Proctoring schedule record not found.");
        return;
    }

    const logoUrl = new URL('logo (1).png', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    const examType = record.examType || "Preliminary";
    const examTypeUpper = examType.toUpperCase();
    const sectionName = escapeHtml(record.section || "");
    const proctorName = escapeHtml(record.facultyName || "");
    const examDates = record.examDates || {};
    const exams = Array.isArray(record.exams) ? record.exams : [];

    const daySet = new Set(exams.map(e => e.day).filter(Boolean));
    const DAYS_ORDER = (Object.keys(examDates).length > 0
        ? Object.keys(examDates)
        : [...daySet]
    ).sort((a, b) => {
        const dateA = examDates[a] || "";
        const dateB = examDates[b] || "";
        return dateA.localeCompare(dateB);
    });

    function groupExamsByDay(examList) {
        const groups = {};
        for (const day of DAYS_ORDER) {
            groups[day] = examList.filter(exam =>
                normalise(exam.day) === normalise(day) || exam.day === day
            );
        }
        return groups;
    }

    const examsByDay = groupExamsByDay(exams);
    let dayTablesHtml = "";
    for (const day of DAYS_ORDER) {
        const dayExams = examsByDay[day];
        if (!dayExams || dayExams.length === 0) continue;

        const dateStr = examDates[day] || "";
        const formattedDate = formatExamDate(dateStr);
        const dayLabel = formattedDate ? `${formattedDate} (${day})` : day;

        let rowsHtml = "";
        for (const exam of dayExams) {
            rowsHtml += `<tr>
                <td>${escapeHtml(exam.time || "-")}</td>
                <td>${escapeHtml(exam.code || exam.subjectCode || "-")} — ${escapeHtml(exam.name || exam.subjectName || "-")}</td>
                <td>${proctorName || "-"}</td>
                <td>${escapeHtml(exam.room || "-")}</td>
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

    if (!dayTablesHtml) {
        dayTablesHtml = `
            <div class="day-section">
                <div class="day-header">Assigned Proctoring Duty</div>
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
                        <tr>
                            <td colspan="4" style="text-align:center; padding: 12px; color: #666;">No exam entries listed for this schedule.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;
    }

    const docTitle = [
        record.academicYear ? `A.Y. ${record.academicYear}` : "",
        record.semester || "",
        record.section || "",
        `${examType} Exam Schedule`
    ].filter(Boolean).join(" ");

    const pageHtml = `
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

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(docTitle)}</title>${printStyles}</head><body>${pageHtml}</body></html>`;

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
        showToast("The print window was blocked by the browser. Please allow popups for this site.");
        return;
    }

    printWindow.document.write(fullHtml);
    printWindow.document.close();
    printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
    };
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
            <td>
                <button type="button" class="archive-view-pdf view-proctoring-pdf-btn" data-record-id="${escapeHtml(item.id)}">View PDF</button>
            </td>
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

document.getElementById("proctoringTableBody")?.addEventListener("click", event => {
    const btn = event.target.closest(".view-proctoring-pdf-btn");
    if (!btn) return;
    const recordId = btn.dataset.recordId;
    if (recordId) {
        openProctoringSchedulePdf(recordId);
    }
});

document.getElementById("deleteAllProctoringBtn")?.addEventListener("click", deleteAllProctoringSchedules);

loadProctoringData();
