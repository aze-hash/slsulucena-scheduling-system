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

function openPrintWindow(htmlContent) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
        showToast("The print window was blocked by the browser.");
        return;
    }

    printWindow.document.write(htmlContent || "<p>No content available.</p>");
    printWindow.document.close();
    printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
    };
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
        /* Load faculty/user map to resolve UIDs or IDs to full names */
        const usersMap = await loadFacultyUsersMap();

        /* 1. Fetch saved exam schedules from examSchedules collection */
        const examSnapshot = await getDocs(collection(db, "examSchedules"));
        const examSchedules = examSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

        /* 2. Fetch archived exam reports from reports collection */
        const reports = await loadReportsFromFirestore();
        const examReports = reports.filter(r => r.category === "Exam Schedule");

        const records = [];

        /* Map examSchedules */
        for (const sched of examSchedules) {
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
                html: sched.html || null,
                createdAt: sched.createdAt?.toDate?.()?.toISOString?.() || sched.createdAt || new Date().toISOString()
            });
        }

        /* Map examReports if not already present in live examSchedules */
        for (const report of examReports) {
            const reportSection = report.section || report.sectionName || (report.title && !report.title.startsWith("A.Y.") ? report.title : "");
            const exists = records.some(r => r.id === report.id || (reportSection && r.section === reportSection && r.academicYear === report.academicYear && r.semester === report.semester));
            if (!exists) {
                const facultyName = resolveFacultyName(report, usersMap);
                records.push({
                    id: report.id,
                    facultyName,
                    academicYear: report.academicYear || "",
                    semester: report.semester || "",
                    section: reportSection || report.filename || "Exam Schedule",
                    examType: report.examType || "Preliminary",
                    exams: [],
                    examDates: {},
                    html: report.html || null,
                    createdAt: report.createdAt
                });
            }
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
/*  Render Table & Filters                                            */
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
            <td class="faculty-name-cell">${escapeHtml(item.facultyName)}</td>
            <td>${escapeHtml(item.academicYear ? `A.Y. ${item.academicYear}` : "—")}</td>
            <td>${escapeHtml(item.semester || "—")}</td>
            <td>${escapeHtml(item.section || "—")}</td>
            <td>${escapeHtml(item.examType || "—")}</td>
            <td>
                <button type="button" class="archive-view-pdf" data-view-proctor-id="${escapeHtml(item.id)}">View PDF</button>
            </td>
        </tr>
    `).join("");
}

/* ------------------------------------------------------------------ */
/*  Build PDF HTML Generator                                          */
/* ------------------------------------------------------------------ */

function buildProctoringPdfHtml(schedule) {
    const logoUrl = new URL('logo (1).png', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;
    const examTypeUpper = String(schedule.examType || "MIDTERM").toUpperCase();
    const sectionName = escapeHtml(schedule.section || "Section Schedule");
    const proctorName = escapeHtml(schedule.facultyName || "TBA");
    const examDates = schedule.examDates || {};
    const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

    const printStyles = `
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, sans-serif; color: #1a1a1a; padding: 10px; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; object-fit: contain; }
            .logo-left, .logo-right { flex-shrink: 0; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #1b5e20; letter-spacing: 0.5px; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; margin-top: 1px; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 14px 0; }
            .title-section { text-align: center; font-size: 16px; font-weight: bold; color: #1b5e20; margin-bottom: 4px; }
            .section-row { text-align: center; font-size: 14px; font-weight: bold; color: #333; margin-bottom: 12px; }
            .meta-info { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 12px; padding: 8px 12px; background: #f4f6f0; border-radius: 6px; }
            .day-section { margin-bottom: 14px; }
            .day-header { background: #1b5e20; color: white; padding: 6px 10px; font-size: 12px; font-weight: bold; border-radius: 4px 4px 0 0; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
            th, td { border: 1px solid #bdbdbd; padding: 8px; text-align: left; }
            th { background: #e4e8dc; color: #1b5e20; font-weight: bold; }
        </style>
    `;

    const daySet = new Set(exams.map(e => e.day).filter(Boolean));
    const DAYS_ORDER = Object.keys(examDates).length > 0 ? Object.keys(examDates) : [...daySet];

    let dayTablesHtml = "";
    if (DAYS_ORDER.length > 0) {
        for (const day of DAYS_ORDER) {
            const dayExams = exams.filter(e => e.day === day);
            if (!dayExams || dayExams.length === 0) continue;
            const dateStr = examDates[day] || "";
            const dayLabel = dateStr ? `${dateStr} (${day})` : day;

            const rows = dayExams.map(e => `
                <tr>
                    <td>${escapeHtml(e.time || "-")}</td>
                    <td>${escapeHtml(e.code || e.subjectCode || "-")} — ${escapeHtml(e.name || e.subjectName || "-")}</td>
                    <td>${proctorName}</td>
                    <td>${escapeHtml(e.room || "-")}</td>
                </tr>
            `).join("");

            dayTablesHtml += `
                <div class="day-section">
                    <div class="day-header">${escapeHtml(dayLabel)}</div>
                    <table>
                        <thead>
                            <tr>
                                <th>TIME</th>
                                <th>SUBJECT</th>
                                <th>PROCTOR</th>
                                <th>ROOM</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }
    }

    if (!dayTablesHtml) {
        const rows = exams.length ? exams.map(e => `
            <tr>
                <td>${escapeHtml(e.time || "-")}</td>
                <td>${escapeHtml(e.code || e.subjectCode || "-")} — ${escapeHtml(e.name || e.subjectName || "-")}</td>
                <td>${proctorName}</td>
                <td>${escapeHtml(e.room || "-")}</td>
            </tr>
        `).join("") : `<tr><td colspan="4">No exam subjects available.</td></tr>`;

        dayTablesHtml = `
            <table>
                <thead>
                    <tr>
                        <th>TIME</th>
                        <th>SUBJECT</th>
                        <th>PROCTOR</th>
                        <th>ROOM</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Exam Schedule - ${sectionName}</title>${printStyles}</head><body>
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
        <div class="title-section">SCHEDULE OF ${escapeHtml(examTypeUpper)} EXAMINATIONS</div>
        <div class="section-row">Section: ${sectionName}</div>
        <div class="meta-info">
            <span><strong>Academic Year:</strong> ${escapeHtml(schedule.academicYear || "—")}</span>
            <span><strong>Semester:</strong> ${escapeHtml(schedule.semester || "—")}</span>
            <span><strong>Proctor:</strong> ${proctorName}</span>
        </div>
        ${dayTablesHtml}
    </body></html>`;
}

function viewProctoringPdf(recordId) {
    const item = proctoringRecords.find(r => r.id === recordId);
    if (!item) {
        showToast("Could not find the selected proctoring record.");
        return;
    }

    if (item.html) {
        openPrintWindow(item.html);
        return;
    }

    const html = buildProctoringPdfHtml(item);
    openPrintWindow(html);
}

/* ------------------------------------------------------------------ */
/*  Delete All Action                                                 */
/* ------------------------------------------------------------------ */

async function deleteAllProctoringSchedules() {
    const confirmed = confirm("Are you sure you want to delete all faculty proctoring schedule records?");
    if (!confirmed) return;

    try {
        /* Delete examSchedules collection docs */
        const examSnapshot = await getDocs(collection(db, "examSchedules"));
        const deletePromises = examSnapshot.docs.map(d => deleteDoc(doc(db, "examSchedules", d.id)));
        await Promise.all(deletePromises);

        /* Delete exam schedule reports from reports collection */
        await deleteReportsByCategoryFromFirestore("Exam Schedule");

        /* Reset filters */
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

document.addEventListener("click", event => {
    const recordId = event.target.dataset?.viewProctorId;
    if (recordId) {
        viewProctoringPdf(recordId);
    }
});

loadProctoringData();
