import { db, auth } from "../firebase.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
    loadReportsFromFirestore,
    deleteReportFromFirestore,
    deleteReportsByCategoryFromFirestore,
    deleteArchivedExamSchedulesFromFirestore,
    deleteArchivedClassSchedulesFromFirestore
} from "./reportStorage.js";
import { renderExamCalendar, renderClassCalendar } from "./js/schedule-calendar.js";

import {
    collection,
    getDocs,
    getDoc,
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

function formatDate(rawDate) {
    if (!rawDate) return "—";
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return String(rawDate);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric"
    });
}

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
}

/* ------------------------------------------------------------------ */
/*  Global state & pagination settings                                */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 10;

let examArchiveReports = [];
let examFilterYear = "";
let examFilterSemester = "";
let examFilterExamType = "";
let examFilterSearch = "";
let examCurrentPage = 1;

let classArchiveRecords = [];
let classFilterYear = "";
let classFilterSemester = "";
let classFilterSearch = "";

let facultyLoadingRecords = [];
let facultyLoadingSearch = "";

/* ------------------------------------------------------------------ */
/*  Filter Population                                                 */
/* ------------------------------------------------------------------ */

function populateExamYearFilter(reports) {
    const yearSelect = document.getElementById("examArchiveAcademicYear");
    if (!yearSelect) return;

    const years = [...new Set(
        reports.map(r => r.academicYear).filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));

    const currentValue = yearSelect.value;
    yearSelect.innerHTML = `<option value="">All Academic Years</option>` +
        years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");

    if (currentValue && years.includes(currentValue)) {
        yearSelect.value = currentValue;
    }
}

/* ------------------------------------------------------------------ */
/*  Render Table                                                      */
/* ------------------------------------------------------------------ */

function renderExamArchive() {
    const tbody = document.getElementById("examArchiveTableBody");
    const emptyNote = document.getElementById("emptyExamArchive");
    const pagination = document.getElementById("examArchivePagination");
    const pageInfo = document.getElementById("examArchivePageInfo");
    const pageNumbers = document.getElementById("examArchivePageNumbers");
    const prevBtn = document.getElementById("examArchivePrevPage");
    const nextBtn = document.getElementById("examArchiveNextPage");

    if (!tbody || !emptyNote) return;

    populateExamYearFilter(examArchiveReports);

    let filtered = [...examArchiveReports];

    if (examFilterYear) {
        filtered = filtered.filter(r => (r.academicYear || "") === examFilterYear);
    }
    if (examFilterSemester) {
        filtered = filtered.filter(r => (r.semester || "") === examFilterSemester);
    }
    if (examFilterExamType) {
        filtered = filtered.filter(r => (r.examType || "").toLowerCase() === examFilterExamType.toLowerCase());
    }
    if (examFilterSearch) {
        const term = normalise(examFilterSearch);
        filtered = filtered.filter(r =>
            normalise(r.title).includes(term) ||
            normalise(r.section).includes(term) ||
            normalise(r.academicYear).includes(term) ||
            normalise(r.semester).includes(term) ||
            normalise(r.examType).includes(term)
        );
    }

    filtered.sort((a, b) => {
        const aTime = a.createdAt || "";
        const bTime = b.createdAt || "";
        return String(bTime).localeCompare(String(aTime));
    });

    if (!filtered.length) {
        tbody.innerHTML = "";
        emptyNote.textContent = examArchiveReports.length === 0
            ? "No archived examination schedules found."
            : "No archived examination schedules matching the selected filter(s).";
        emptyNote.hidden = false;
        if (pagination) pagination.style.display = "none";
        return;
    }

    emptyNote.hidden = true;

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (examCurrentPage > totalPages) examCurrentPage = totalPages;
    if (examCurrentPage < 1) examCurrentPage = 1;

    const startIndex = (examCurrentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(startIndex, startIndex + PAGE_SIZE);

    tbody.innerHTML = pageItems.map(report => `
        <tr>
            <td>
                <strong>${escapeHtml(report.section || report.title || "Exam Schedule")}</strong>
                ${report.yearLevel ? `<div style="font-size:12px; color:#666;">${escapeHtml(report.yearLevel)}</div>` : ""}
            </td>
            <td>${escapeHtml(report.academicYear ? `A.Y. ${report.academicYear}` : "—")}</td>
            <td>${escapeHtml(report.semester || "—")}</td>
            <td><span style="background:#fff3e0; color:#e65100; border:1px solid #ffe0b2; padding:3px 8px; border-radius:12px; font-size:12px; font-weight:700;">${escapeHtml(report.examType || "Preliminary")}</span></td>
            <td style="font-size:12px; color:#555;">${escapeHtml(formatDate(report.createdAt))}</td>
            <td style="text-align:center;">
                <div style="display:inline-flex; gap:6px; align-items:center; justify-content:center; flex-wrap:wrap;">
                    <button type="button" class="archive-view-pdf" data-view-exam-id="${escapeHtml(report.id)}" style="padding:6px 12px; border:none; border-radius:6px; background:#2e7d32; color:#fff; font-size:12px; font-weight:bold; cursor:pointer;">
                        📄 PDF
                    </button>
                    <button type="button" class="archive-view-cal" data-view-cal-id="${escapeHtml(report.id)}" style="padding:6px 12px; border:1px solid #2e7d32; border-radius:6px; background:#fff; color:#2e7d32; font-size:12px; font-weight:bold; cursor:pointer;">
                        📅 Timetable
                    </button>
                    <button type="button" class="archive-delete-btn" data-delete-id="${escapeHtml(report.id)}" style="padding:6px 10px; border:1px solid #ffcdd2; border-radius:6px; background:#ffebee; color:#c62828; font-size:12px; font-weight:bold; cursor:pointer;">
                        🗑️
                    </button>
                </div>
            </td>
        </tr>
    `).join("");

    const showPagination = filtered.length > PAGE_SIZE;
    if (pagination) pagination.style.display = showPagination ? "flex" : "none";

    if (pageInfo) {
        const first = startIndex + 1;
        const last = Math.min(startIndex + PAGE_SIZE, filtered.length);
        pageInfo.textContent = `Showing ${first}–${last} of ${filtered.length} archived schedule(s)`;
    }

    if (prevBtn) prevBtn.disabled = examCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = examCurrentPage >= totalPages;

    if (pageNumbers) {
        if (totalPages <= 1) {
            pageNumbers.innerHTML = "";
        } else {
            const startPage = Math.max(1, examCurrentPage - 2);
            const endPage = Math.min(totalPages, examCurrentPage + 2);
            const pages = [];
            for (let page = startPage; page <= endPage; page += 1) {
                pages.push(`
                    <button
                        type="button"
                        class="archive-page-number${page === examCurrentPage ? " active" : ""}"
                        data-exam-page="${page}"
                        style="padding:5px 10px; border:1px solid #ccc; border-radius:4px; background:${page === examCurrentPage ? '#2e7d32' : '#fff'}; color:${page === examCurrentPage ? '#fff' : '#333'}; font-weight:bold; cursor:pointer;"
                    >${page}</button>
                `);
            }
            pageNumbers.innerHTML = pages.join("");
        }
    }
}

/* ------------------------------------------------------------------ */
/*  PDF Generation                                                    */
/* ------------------------------------------------------------------ */

function generateExamPdfHtml(report) {
    if (report.html) return report.html;

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    const examType = report.examType || "Preliminary";
    const examTypeUpper = examType.toUpperCase();
    const sectionName = escapeHtml(report.section || report.title || "Section Schedule");
    const exams = Array.isArray(report.exams) ? report.exams : [];

    const dateLabel = rawDate => {
        if (!rawDate || rawDate === "TBA") return "Date to be announced";
        const date = new Date(`${rawDate}T00:00:00`);
        if (Number.isNaN(date.getTime())) return String(rawDate);
        return date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "long"
        });
    };

    const groupedExams = new Map();
    exams.forEach(exam => {
        const key = exam.date || "TBA";
        if (!groupedExams.has(key)) groupedExams.set(key, []);
        groupedExams.get(key).push(exam);
    });

    const dateKeys = [...groupedExams.keys()].sort((a, b) => {
        if (a === "TBA") return 1;
        if (b === "TBA") return -1;
        return String(a).localeCompare(String(b));
    });

    const scheduleSections = dateKeys.length
        ? dateKeys.map(date => `
            <section class="exam-day">
                <div class="exam-date">${escapeHtml(dateLabel(date))}</div>
                <table class="schedule-table">
                    <thead>
                        <tr>
                            <th style="width:18%;">TIME</th>
                            <th style="width:42%;">SUBJECT</th>
                            <th style="width:20%;">PROCTOR</th>
                            <th style="width:20%;">ROOM</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${groupedExams.get(date).map(e => `
                            <tr>
                                <td>${escapeHtml(e.time || "—")}</td>
                                <td>${escapeHtml([e.code || e.subjectCode, e.name || e.subjectName].filter(Boolean).join(" — ") || "—")}</td>
                                <td>${escapeHtml(e.proctor || e.facultyName || "TBA")}</td>
                                <td>${escapeHtml(e.room || "—")}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </section>
        `).join("")
        : `<div class="empty-schedule">No examination entries recorded.</div>`;

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>${sectionName} - ${escapeHtml(examType)} Examination Schedule</title>
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 10px; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #000000; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 10px 0; }
            .title-section { text-align: center; font-size: 14px; font-weight: bold; color: #000000; margin-bottom: 10px; text-decoration: underline; }
            .section-row { text-align: center; font-size: 12px; font-weight: bold; color: #555; padding: 4px 10px 10px; }
            .exam-day { page-break-inside: avoid; margin-bottom: 14px; }
            .exam-date { text-align: center; color: #030303; font-size: 11px; font-weight: bold; margin: 8px 0 3px; }
            .schedule-table { width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 2px; }
            .schedule-table th, .schedule-table td { border: 1px solid #888888; padding: 4px 6px; text-align: left; }
            .schedule-table th { background: #a7c7a3; color: #1b5e20; font-weight: bold; text-align: center; }
            .schedule-table td { vertical-align: middle; }
            .schedule-table tbody tr:nth-child(even) { background: #f7f7f7; }
            .empty-schedule { text-align: center; padding: 16px; border: 1px solid #888; }
        </style>
    </head>
    <body>
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
        ${scheduleSections}
    </body>
    </html>`;
}

function viewExamSchedulePdf(reportId) {
    const report = examArchiveReports.find(r => r.id === reportId);
    if (!report) {
        showToast("Could not find the archived exam report document.");
        return;
    }
    const html = generateExamPdfHtml(report);
    openPrintWindow(html);
}

/* ------------------------------------------------------------------ */
/*  Calendar Modal                                                    */
/* ------------------------------------------------------------------ */

function viewExamScheduleCalendar(reportId) {
    const report = examArchiveReports.find(r => r.id === reportId);
    if (!report) {
        showToast("Could not find the examination schedule.");
        return;
    }

    const modal = document.getElementById("examCalendarModal");
    const titleEl = document.getElementById("calModalTitle");
    const subtitleEl = document.getElementById("calModalSubtitle");
    const bodyEl = document.getElementById("calModalBody");

    if (!modal || !bodyEl) return;

    if (titleEl) titleEl.textContent = `${report.section || report.title || "Exam Schedule"} - Timetable`;
    if (subtitleEl) {
        subtitleEl.textContent = [
            report.academicYear ? `A.Y. ${report.academicYear}` : "",
            report.semester || "",
            report.examType ? `${report.examType} Exam` : ""
        ].filter(Boolean).join(" • ");
    }

    bodyEl.innerHTML = renderExamCalendar(report);
    modal.style.display = "flex";
}

function closeCalendarModal() {
    const modal = document.getElementById("examCalendarModal");
    if (modal) modal.style.display = "none";
}

document.getElementById("calModalClose")?.addEventListener("click", closeCalendarModal);

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeCalendarModal();
});

/* ------------------------------------------------------------------ */
/*  Data Loading & Normalization                                      */
/* ------------------------------------------------------------------ */

async function loadExamArchiveData() {
    try {
        const [firestoreReports, examSchedulesSnap] = await Promise.all([
            loadReportsFromFirestore(),
            getDocs(collection(db, "examSchedules"))
        ]);

        const rawList = [];

        // 1. Reports collection
        firestoreReports.forEach(r => {
            rawList.push({
                id: r.id,
                source: "reports",
                title: r.title || r.section || "Exam Schedule",
                section: r.section || r.title || "Exam Schedule",
                academicYear: r.academicYear || "",
                semester: r.semester || "",
                yearLevel: r.yearLevel || "",
                examType: r.examType || "Preliminary",
                exams: r.entries || r.exams || [],
                html: r.html || "",
                createdAt: r.createdAt || new Date().toISOString()
            });
        });

        // 2. examSchedules collection
        examSchedulesSnap.docs.forEach(docSnap => {
            const data = docSnap.data();
            rawList.push({
                id: docSnap.id,
                source: "examSchedules",
                title: data.section || data.name || "Exam Schedule",
                section: data.section || data.name || "Exam Schedule",
                academicYear: data.academicYear || "",
                semester: data.semester || "",
                yearLevel: data.yearLevel || "",
                examType: data.examType || "Preliminary",
                exams: data.exams || [],
                status: data.status || "draft",
                html: "",
                createdAt: data.publishedAt || data.updatedAt || data.createdAt || new Date().toISOString()
            });
        });

        // Deduplicate by section + academicYear + semester + examType
        const dedupedMap = new Map();
        rawList.forEach(item => {
            const key = [
                normalise(item.section),
                normalise(item.academicYear),
                normalise(item.semester),
                normalise(item.examType)
            ].join("::");

            const existing = dedupedMap.get(key);
            if (!existing) {
                dedupedMap.set(key, item);
            } else {
                const itemHasExams = (item.exams || []).length > 0;
                const existingHasExams = (existing.exams || []).length > 0;
                const itemTime = new Date(item.createdAt || 0).getTime();
                const existingTime = new Date(existing.createdAt || 0).getTime();

                if ((!existingHasExams && itemHasExams) || (itemTime > existingTime && itemHasExams)) {
                    dedupedMap.set(key, item);
                }
            }
        });

        examArchiveReports = Array.from(dedupedMap.values());
        renderExamArchive();
    } catch (error) {
        console.error("Could not load exam archive data:", error);
        showToast("Error loading archived examination schedules.");
    }
}

/* ------------------------------------------------------------------ */
/*  Event Listeners                                                   */
/* ------------------------------------------------------------------ */

document.getElementById("examArchiveAcademicYear")?.addEventListener("change", event => {
    examFilterYear = event.target.value;
    examCurrentPage = 1;
    renderExamArchive();
});

document.getElementById("examArchiveSemester")?.addEventListener("change", event => {
    examFilterSemester = event.target.value;
    examCurrentPage = 1;
    renderExamArchive();
});

document.getElementById("examArchiveExamType")?.addEventListener("change", event => {
    examFilterExamType = event.target.value;
    examCurrentPage = 1;
    renderExamArchive();
});

document.getElementById("examArchiveSearch")?.addEventListener("input", event => {
    examFilterSearch = event.target.value;
    examCurrentPage = 1;
    renderExamArchive();
});

// Delete All Archive
document.getElementById("deleteAllExamArchiveBtn")?.addEventListener("click", async () => {
    const confirmed = confirm("Are you sure you want to delete all archived examination schedules?");
    if (!confirmed) return;

    try {
        await Promise.all([
            deleteReportsByCategoryFromFirestore("Exam Schedule"),
            deleteArchivedExamSchedulesFromFirestore()
        ]);

        examArchiveReports = [];
        examFilterYear = "";
        examFilterSemester = "";
        examFilterExamType = "";
        examFilterSearch = "";
        examCurrentPage = 1;

        const yearSelect = document.getElementById("examArchiveAcademicYear");
        const semSelect = document.getElementById("examArchiveSemester");
        const typeSelect = document.getElementById("examArchiveExamType");
        const searchInput = document.getElementById("examArchiveSearch");
        if (yearSelect) yearSelect.value = "";
        if (semSelect) semSelect.value = "";
        if (typeSelect) typeSelect.value = "";
        if (searchInput) searchInput.value = "";

        await loadExamArchiveData();
        showToast("All archived examination schedules have been deleted.");
    } catch (error) {
        console.error("Could not delete all archived exam schedules:", error);
        showToast("Error deleting archived examination schedules.");
    }
});

/* ------------------------------------------------------------------ */
/*  Class Schedule Archive                                            */
/* ------------------------------------------------------------------ */

function populateClassYearFilter(records) {
    const yearSelect = document.getElementById("classArchiveAcademicYear");
    if (!yearSelect) return;

    const years = [...new Set(
        records.map(r => r.academicYear).filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));

    const currentValue = yearSelect.value;
    yearSelect.innerHTML = `<option value="">All Academic Years</option>` +
        years.map(year => `<option value="${escapeHtml(year)}">A.Y. ${escapeHtml(year)}</option>`).join("");

    if (currentValue && years.includes(currentValue)) {
        yearSelect.value = currentValue;
    }
}

function renderClassArchive() {
    const tbody = document.getElementById("classArchiveTableBody");
    const emptyNote = document.getElementById("emptyClassArchive");
    if (!tbody || !emptyNote) return;

    populateClassYearFilter(classArchiveRecords);

    let filtered = [...classArchiveRecords];

    if (classFilterYear) {
        filtered = filtered.filter(r => (r.academicYear || "") === classFilterYear);
    }
    if (classFilterSemester) {
        filtered = filtered.filter(r => (r.semester || "") === classFilterSemester);
    }
    if (classFilterSearch) {
        const term = normalise(classFilterSearch);
        filtered = filtered.filter(r =>
            normalise(r.title).includes(term) ||
            normalise(r.section).includes(term) ||
            normalise(r.academicYear).includes(term) ||
            normalise(r.semester).includes(term) ||
            normalise(r.program).includes(term) ||
            (Array.isArray(r.entries) && r.entries.some(e =>
                normalise(e.code).includes(term) ||
                normalise(e.name).includes(term) ||
                normalise(e.faculty).includes(term)
            ))
        );
    }

    filtered.sort((a, b) => {
        const aTime = a.createdAt || "";
        const bTime = b.createdAt || "";
        return String(bTime).localeCompare(String(aTime));
    });

    if (!filtered.length) {
        tbody.innerHTML = "";
        emptyNote.textContent = classArchiveRecords.length === 0
            ? "No archived class schedules found."
            : "No archived class schedules matching the selected filter(s).";
        emptyNote.hidden = false;
        return;
    }

    emptyNote.hidden = true;

    tbody.innerHTML = filtered.map(item => `
        <tr>
            <td>
                <strong>${escapeHtml(item.section || item.title || "Class Schedule")}</strong>
                ${item.program ? `<div style="font-size:12px; color:#666;">${escapeHtml(item.program)}${item.major ? ` - ${escapeHtml(item.major)}` : ""}</div>` : ""}
            </td>
            <td>${escapeHtml(item.academicYear ? `A.Y. ${item.academicYear}` : "—")}</td>
            <td>${escapeHtml(item.semester || "—")}</td>
            <td style="text-align:center;">
                <span style="background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9; padding:3px 8px; border-radius:12px; font-size:12px; font-weight:700;">
                    ${(item.entries || []).length} Subject${(item.entries || []).length === 1 ? "" : "s"}
                </span>
            </td>
            <td style="font-size:12px; color:#555;">${escapeHtml(formatDate(item.createdAt))}</td>
            <td style="text-align:center;">
                <div style="display:inline-flex; gap:6px; align-items:center; justify-content:center; flex-wrap:wrap;">
                    <button type="button" class="class-archive-view-cal" data-view-class-id="${escapeHtml(item.id)}" style="padding:6px 12px; border:1px solid #2e7d32; border-radius:6px; background:#fff; color:#2e7d32; font-size:12px; font-weight:bold; cursor:pointer;">
                        📅 Timetable
                    </button>
                    <button type="button" class="class-archive-delete-btn" data-delete-id="${escapeHtml(item.id)}" style="padding:6px 10px; border:1px solid #ffcdd2; border-radius:6px; background:#ffebee; color:#c62828; font-size:12px; font-weight:bold; cursor:pointer;">
                        🗑️
                    </button>
                </div>
            </td>
        </tr>
    `).join("");
}

function viewClassScheduleCalendar(scheduleId) {
    const schedule = classArchiveRecords.find(r => r.id === scheduleId);
    if (!schedule) {
        showToast("Could not find the class schedule.");
        return;
    }

    const modal = document.getElementById("classCalendarModal");
    const titleEl = document.getElementById("classCalModalTitle");
    const subtitleEl = document.getElementById("classCalModalSubtitle");
    const bodyEl = document.getElementById("classCalModalBody");

    if (!modal || !bodyEl) return;

    if (titleEl) titleEl.textContent = `${schedule.section || schedule.title || "Class Schedule"} - Timetable`;
    if (subtitleEl) {
        subtitleEl.textContent = [
            schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
            schedule.semester || "",
            schedule.program || "",
            schedule.major || ""
        ].filter(Boolean).join(" • ");
    }

    bodyEl.innerHTML = renderClassCalendar(schedule);
    modal.style.display = "flex";
}

function closeClassCalendarModal() {
    const modal = document.getElementById("classCalendarModal");
    if (modal) modal.style.display = "none";
}

document.getElementById("classCalModalClose")?.addEventListener("click", closeClassCalendarModal);

async function loadClassArchiveData() {
    try {
        const [firestoreReports, classSchedulesSnap] = await Promise.all([
            loadReportsFromFirestore(),
            getDocs(collection(db, "classSchedules"))
        ]);

        const rawList = [];

        // 1. Reports collection
        firestoreReports.forEach(r => {
            if ((r.category || "").toLowerCase().includes("class")) {
                rawList.push({
                    id: r.id,
                    source: "reports",
                    title: r.title || r.section || "Class Schedule",
                    section: r.section || r.title || "Class Schedule",
                    academicYear: r.academicYear || "",
                    semester: r.semester || "",
                    program: r.program || "",
                    major: r.major || "",
                    entries: r.entries || [],
                    createdAt: r.createdAt || new Date().toISOString()
                });
            }
        });

        // 2. classSchedules collection
        classSchedulesSnap.docs.forEach(docSnap => {
            const data = docSnap.data();
            rawList.push({
                id: docSnap.id,
                source: "classSchedules",
                title: data.section || data.name || "Class Schedule",
                section: data.section || data.name || "Class Schedule",
                academicYear: data.academicYear || "",
                semester: data.semester || "",
                program: data.program || "",
                major: data.major || "",
                status: data.status || "published",
                entries: data.entries || [],
                createdAt: data.publishedAt || data.updatedAt || data.createdAt || new Date().toISOString()
            });
        });

        // Deduplicate by section + academicYear + semester
        const dedupedMap = new Map();
        rawList.forEach(item => {
            const key = [
                normalise(item.section),
                normalise(item.academicYear),
                normalise(item.semester)
            ].join("::");

            const existing = dedupedMap.get(key);
            if (!existing) {
                dedupedMap.set(key, item);
            } else {
                const itemHasEntries = (item.entries || []).length > 0;
                const existingHasEntries = (existing.entries || []).length > 0;
                const itemTime = new Date(item.createdAt || 0).getTime();
                const existingTime = new Date(existing.createdAt || 0).getTime();

                if ((!existingHasEntries && itemHasEntries) || (itemTime > existingTime && itemHasEntries)) {
                    dedupedMap.set(key, item);
                }
            }
        });

        classArchiveRecords = Array.from(dedupedMap.values());
        renderClassArchive();
    } catch (error) {
        console.error("Could not load class archive data:", error);
        const emptyNote = document.getElementById("emptyClassArchive");
        if (emptyNote) {
            emptyNote.textContent = "Error loading archived class schedules.";
            emptyNote.hidden = false;
        }
    }
}

document.getElementById("classArchiveAcademicYear")?.addEventListener("change", event => {
    classFilterYear = event.target.value;
    renderClassArchive();
});

document.getElementById("classArchiveSemester")?.addEventListener("change", event => {
    classFilterSemester = event.target.value;
    renderClassArchive();
});

document.getElementById("classArchiveSearch")?.addEventListener("input", event => {
    classFilterSearch = event.target.value;
    renderClassArchive();
});

// Delete All Class Archive
document.getElementById("deleteAllClassArchiveBtn")?.addEventListener("click", async () => {
    const confirmed = confirm("Are you sure you want to delete all archived class schedules?");
    if (!confirmed) return;

    try {
        await Promise.all([
            deleteReportsByCategoryFromFirestore("Class Schedule"),
            deleteArchivedClassSchedulesFromFirestore()
        ]);

        classArchiveRecords = [];
        classFilterYear = "";
        classFilterSemester = "";
        classFilterSearch = "";

        const yearSelect = document.getElementById("classArchiveAcademicYear");
        const semSelect = document.getElementById("classArchiveSemester");
        const searchInput = document.getElementById("classArchiveSearch");
        if (yearSelect) yearSelect.value = "";
        if (semSelect) semSelect.value = "";
        if (searchInput) searchInput.value = "";

        await loadClassArchiveData();
        showToast("All archived class schedules have been deleted.");
    } catch (error) {
        console.error("Could not delete all archived class schedules:", error);
        showToast("Error deleting archived class schedules.");
    }
});

/* ------------------------------------------------------------------ */
/*  Faculty Loading Reports                                           */
/* ------------------------------------------------------------------ */

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

function getLoadStatus(totalHours) {
    if (totalHours <= 0) {
        return { text: "No Load", color: "#757575", bg: "#f5f5f5", border: "#e0e0e0" };
    } else if (totalHours > 21) {
        return { text: "Over Capacity", color: "#c62828", bg: "#ffebee", border: "#ffcdd2" };
    } else if (totalHours >= 19) {
        return { text: "Overload", color: "#e65100", bg: "#fff3e0", border: "#ffe0b2" };
    } else {
        return { text: "Normal Load", color: "#2e7d32", bg: "#e8f5e9", border: "#c8e6c9" };
    }
}

function sameFaculty(f1, f2) {
    if (!f1 || !f2) return false;
    const n1 = normalise(f1);
    const n2 = normalise(f2);
    if (!n1 || !n2 || n1 === "unassigned" || n2 === "unassigned" || n1 === "tba" || n2 === "tba") return false;
    return n1 === n2;
}

function renderFacultyLoadingTable() {
    const tbody = document.getElementById("facultyLoadingTableBody");
    const emptyNote = document.getElementById("emptyFacultyLoading");
    if (!tbody || !emptyNote) return;

    let filtered = [...facultyLoadingRecords];

    if (facultyLoadingSearch) {
        const q = normalise(facultyLoadingSearch);
        filtered = filtered.filter(f =>
            normalise(f.name).includes(q) ||
            normalise(f.employeeId).includes(q) ||
            normalise(f.department).includes(q) ||
            (Array.isArray(f.assignedClasses) && f.assignedClasses.some(c =>
                normalise(c.subjectCode).includes(q) ||
                normalise(c.subjectName).includes(q) ||
                normalise(c.section).includes(q)
            ))
        );
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));

    if (!filtered.length) {
        tbody.innerHTML = "";
        emptyNote.textContent = facultyLoadingRecords.length === 0
            ? "No faculty loading data found."
            : "No faculty loading records matching the search query.";
        emptyNote.hidden = false;
        return;
    }

    emptyNote.hidden = true;

    tbody.innerHTML = filtered.map(f => {
        const status = f.loadStatus;
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(f.name)}</strong>
                    ${f.department ? `<div style="font-size:12px; color:#666;">${escapeHtml(f.department)}</div>` : ""}
                </td>
                <td>${escapeHtml(f.employeeId || "—")}</td>
                <td style="text-align:center;">
                    <span style="font-weight:bold;">${f.totalSubjects}</span>
                </td>
                <td style="text-align:center;">
                    <span style="font-weight:bold;">${f.totalSections}</span>
                </td>
                <td style="text-align:center;">
                    <strong>${f.totalHours} hrs/wk</strong>
                </td>
                <td style="text-align:center;">
                    <span style="background:${status.bg}; color:${status.color}; border:1px solid ${status.border}; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:700;">
                        ${escapeHtml(status.text)}
                    </span>
                </td>
                <td style="text-align:center;">
                    <button type="button" class="faculty-loading-print-btn" data-faculty-id="${escapeHtml(f.uid || f.id)}" style="padding:6px 12px; border:none; border-radius:6px; background:#2e7d32; color:#fff; font-size:12px; font-weight:bold; cursor:pointer;">
                        🖨️ Print Load
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

async function loadFacultyLoadingData() {
    try {
        const [usersSnap, classSchedulesSnap] = await Promise.all([
            getDocs(collection(db, "users")),
            getDocs(collection(db, "classSchedules"))
        ]);

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

        // Legacy fallback
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

        // Collect all discrete class assignments
        const discreteClasses = [];

        classSchedulesSnap.docs.forEach(docSnap => {
            const schedule = docSnap.data();
            if (schedule.status === "archived") return;

            const sec = schedule.section || schedule.name || "";
            const prog = schedule.program || "";
            const ay = schedule.academicYear || "";
            const sem = schedule.semester || "";
            const entries = schedule.entries || [];

            entries.forEach(entry => {
                const facName = entry.faculty || "";
                if (!facName || normalise(facName) === "unassigned" || normalise(facName) === "tba") {
                    return;
                }

                const days = String(entry.day || "").split("/").map(s => s.trim()).filter(Boolean);
                const times = String(entry.time || "").split("/").map(s => s.trim()).filter(Boolean);
                const rooms = String(entry.room || "").split("/").map(s => s.trim()).filter(Boolean);
                const count = Math.max(days.length, 1);

                for (let i = 0; i < count; i++) {
                    const day = days[i] || days[0] || "TBA";
                    const time = times[i] || times[0] || "TBA";
                    const room = rooms[i] || rooms[0] || "TBA";
                    const hours = calculateClassDurationHours(time, entry.units);

                    discreteClasses.push({
                        scheduleId: docSnap.id,
                        section: sec,
                        program: prog,
                        academicYear: ay,
                        semester: sem,
                        subjectCode: entry.code || "",
                        subjectName: entry.name || "",
                        units: Number(entry.units) || 3,
                        day,
                        time,
                        room,
                        hours,
                        faculty: facName,
                        facultyId: entry.facultyId || "",
                        facultyUid: entry.facultyUid || ""
                    });
                }
            });
        });

        // Ensure any assigned faculty not in facultyList is added
        discreteClasses.forEach(c => {
            if (c.faculty && !facultyList.some(f => f.uid === c.facultyUid || sameFaculty(f.name, c.faculty))) {
                facultyList.push({
                    uid: c.facultyUid || c.faculty,
                    id: c.facultyUid || c.faculty,
                    employeeId: c.facultyId || "",
                    name: c.faculty,
                    email: "",
                    department: c.program || "General"
                });
            }
        });

        // Aggregate loads
        facultyLoadingRecords = facultyList.map(faculty => {
            const assigned = discreteClasses.filter(c => {
                if (c.facultyUid && (c.facultyUid === faculty.uid || c.facultyUid === faculty.id)) return true;
                if (c.facultyId && faculty.employeeId && c.facultyId === faculty.employeeId) return true;
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
        });

        renderFacultyLoadingTable();
    } catch (error) {
        console.error("Could not load faculty loading data:", error);
        const emptyNote = document.getElementById("emptyFacultyLoading");
        if (emptyNote) {
            emptyNote.textContent = "Error loading faculty loading reports.";
            emptyNote.hidden = false;
        }
    }
}

function printFacultyLoadingSummary() {
    if (!facultyLoadingRecords.length) {
        showToast("No faculty loading data available to print.");
        return;
    }

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;
    const nowStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const totalFaculty = facultyLoadingRecords.length;
    const assignedFaculty = facultyLoadingRecords.filter(f => f.totalHours > 0).length;
    const totalTeachingHours = facultyLoadingRecords.reduce((sum, f) => sum + (f.totalHours || 0), 0).toFixed(1);

    const rows = facultyLoadingRecords.map(f => `
        <tr>
            <td><strong>${escapeHtml(f.name)}</strong></td>
            <td>${escapeHtml(f.employeeId || "—")}</td>
            <td>${escapeHtml(f.department || "General")}</td>
            <td style="text-align:center;">${f.totalSubjects}</td>
            <td style="text-align:center;">${f.totalSections}</td>
            <td style="text-align:center;"><strong>${f.totalHours}</strong></td>
            <td style="text-align:center;">
                <span style="font-weight:bold; color:${f.loadStatus.color};">${f.loadStatus.text}</span>
            </td>
        </tr>
    `).join("");

    const html = `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>SLSU Lucena - Faculty Loading Summary Report</title>
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 12px; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #000; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 12px 0; }
            .report-title { text-align: center; font-size: 14px; font-weight: bold; text-decoration: underline; margin-bottom: 4px; }
            .report-sub { text-align: center; font-size: 12px; color: #555; margin-bottom: 12px; }
            .summary-box { display: flex; justify-content: space-around; background: #f1f8e9; border: 1px solid #c8e6c9; border-radius: 6px; padding: 8px; margin-bottom: 14px; font-size: 12px; }
            .summary-box strong { color: #1b5e20; }
            table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
            th, td { border: 1px solid #888; padding: 5px 6px; text-align: left; }
            th { background: #a7c7a3; color: #1b5e20; font-weight: bold; text-align: center; }
            tbody tr:nth-child(even) { background: #f9f9f9; }
            .signatures { display: flex; justify-content: space-between; margin-top: 40px; page-break-inside: avoid; }
            .sign-col { text-align: center; width: 200px; font-size: 11px; }
            .sign-line { border-bottom: 1px solid #333; margin-bottom: 6px; height: 35px; }
        </style>
    </head>
    <body>
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
        <div class="report-title">FACULTY TEACHING LOAD SUMMARY REPORT</div>
        <div class="report-sub">Generated on ${escapeHtml(nowStr)}</div>

        <div class="summary-box">
            <div>Total Faculty: <strong>${totalFaculty}</strong></div>
            <div>Assigned Faculty: <strong>${assignedFaculty}</strong></div>
            <div>Total Teaching Hours: <strong>${totalTeachingHours} hrs/wk</strong></div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width:25%;">Faculty Member</th>
                    <th style="width:13%;">Employee ID</th>
                    <th style="width:18%;">Department</th>
                    <th style="width:10%;">Subjects</th>
                    <th style="width:10%;">Sections</th>
                    <th style="width:12%;">Weekly Hours</th>
                    <th style="width:12%;">Load Status</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>

        <div class="signatures">
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Prepared by:</strong><br>
                Department Chairperson
            </div>
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Verified by:</strong><br>
                Academic Program Head
            </div>
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Approved by:</strong><br>
                Campus Director
            </div>
        </div>
    </body>
    </html>`;

    openPrintWindow(html);
}

function printFacultyIndividualLoad(facultyUid) {
    const f = facultyLoadingRecords.find(r => r.uid === facultyUid || r.id === facultyUid);
    if (!f) {
        showToast("Could not find faculty loading record.");
        return;
    }

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;
    const nowStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const classRows = (f.assignedClasses || []).length
        ? f.assignedClasses.map(c => `
            <tr>
                <td><code>${escapeHtml(c.subjectCode)}</code></td>
                <td>${escapeHtml(c.subjectName)}</td>
                <td><strong>${escapeHtml(c.section)}</strong></td>
                <td style="text-align:center;">${escapeHtml(c.day)}</td>
                <td style="text-align:center;">${escapeHtml(c.time)}</td>
                <td style="text-align:center;">${escapeHtml(c.room)}</td>
                <td style="text-align:center;">${c.units || 3}</td>
                <td style="text-align:center;"><strong>${c.hours || 3} hrs</strong></td>
            </tr>
        `).join("")
        : `<tr><td colspan="8" style="text-align:center; padding:12px; color:#777;">No assigned classes recorded.</td></tr>`;

    const totalUnits = (f.assignedClasses || []).reduce((sum, c) => sum + (Number(c.units) || 0), 0);

    const html = `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>${escapeHtml(f.name)} - Individual Teaching Load</title>
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 12px; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #000; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 12px 0; }
            .report-title { text-align: center; font-size: 14px; font-weight: bold; text-decoration: underline; margin-bottom: 4px; }
            .faculty-meta { display: flex; justify-content: space-between; background: #f9f9f9; border: 1px solid #ddd; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
            th, td { border: 1px solid #888; padding: 5px 6px; text-align: left; }
            th { background: #a7c7a3; color: #1b5e20; font-weight: bold; text-align: center; }
            tbody tr:nth-child(even) { background: #f9f9f9; }
            .summary-footer { display: flex; justify-content: flex-end; gap: 20px; margin-top: 10px; font-size: 12px; font-weight: bold; }
            .signatures { display: flex; justify-content: space-between; margin-top: 40px; page-break-inside: avoid; }
            .sign-col { text-align: center; width: 200px; font-size: 11px; }
            .sign-line { border-bottom: 1px solid #333; margin-bottom: 6px; height: 35px; }
        </style>
    </head>
    <body>
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
        <div class="report-title">INDIVIDUAL FACULTY TEACHING LOAD SHEET</div>
        <div style="text-align:center; font-size:11px; color:#666; margin-bottom:10px;">Date Generated: ${escapeHtml(nowStr)}</div>

        <div class="faculty-meta">
            <div>
                <strong>Faculty:</strong> ${escapeHtml(f.name)}<br>
                <strong>Employee ID:</strong> ${escapeHtml(f.employeeId || "N/A")}
            </div>
            <div>
                <strong>Department:</strong> ${escapeHtml(f.department || "General")}<br>
                <strong>Load Status:</strong> <span style="color:${f.loadStatus.color}; font-weight:bold;">${f.loadStatus.text}</span>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width:12%;">Course Code</th>
                    <th style="width:30%;">Course Title / Description</th>
                    <th style="width:14%;">Section</th>
                    <th style="width:10%;">Day</th>
                    <th style="width:14%;">Time</th>
                    <th style="width:10%;">Room</th>
                    <th style="width:5%;">Units</th>
                    <th style="width:8%;">Hours/Wk</th>
                </tr>
            </thead>
            <tbody>
                ${classRows}
            </tbody>
        </table>

        <div class="summary-footer">
            <div>Total Teaching Units: <strong>${totalUnits}</strong></div>
            <div>Total Teaching Hours: <strong>${f.totalHours} hrs/week</strong></div>
        </div>

        <div class="signatures">
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Conforme:</strong><br>
                ${escapeHtml(f.name)}<br>
                <span style="color:#666; font-size:10px;">Faculty Member</span>
            </div>
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Verified:</strong><br>
                Department Chairperson
            </div>
            <div class="sign-col">
                <div class="sign-line"></div>
                <strong>Approved:</strong><br>
                Campus Director
            </div>
        </div>
    </body>
    </html>`;

    openPrintWindow(html);
}

document.getElementById("facultyLoadingSearch")?.addEventListener("input", event => {
    facultyLoadingSearch = event.target.value;
    renderFacultyLoadingTable();
});

document.getElementById("printAllFacultyLoadingBtn")?.addEventListener("click", printFacultyLoadingSummary);

/* ------------------------------------------------------------------ */
/*  Table Click Delegation & Modal Events                             */
/* ------------------------------------------------------------------ */

document.addEventListener("click", async event => {
    // View Exam PDF
    const pdfBtn = event.target.closest(".archive-view-pdf");
    if (pdfBtn) {
        const reportId = pdfBtn.dataset.viewExamId;
        if (reportId) viewExamSchedulePdf(reportId);
        return;
    }

    // View Exam Timetable
    const examCalBtn = event.target.closest(".archive-view-cal");
    if (examCalBtn) {
        const calId = examCalBtn.dataset.viewCalId;
        if (calId) viewExamScheduleCalendar(calId);
        return;
    }

    // View Class Timetable
    const classCalBtn = event.target.closest(".class-archive-view-cal");
    if (classCalBtn) {
        const classId = classCalBtn.dataset.viewClassId;
        if (classId) viewClassScheduleCalendar(classId);
        return;
    }

    // Print Individual Faculty Load
    const facPrintBtn = event.target.closest(".faculty-loading-print-btn");
    if (facPrintBtn) {
        const facultyId = facPrintBtn.dataset.facultyId;
        if (facultyId) printFacultyIndividualLoad(facultyId);
        return;
    }

    // Delete single Exam Archive
    const delExamBtn = event.target.closest(".archive-delete-btn");
    if (delExamBtn) {
        const delId = delExamBtn.dataset.deleteId;
        if (!delId) return;
        const confirmed = confirm("Are you sure you want to delete this archived examination schedule?");
        if (!confirmed) return;

        try {
            const item = examArchiveReports.find(r => r.id === delId);
            if (item?.source === "reports") {
                await deleteReportFromFirestore(delId);
            } else {
                await deleteDoc(doc(db, "examSchedules", delId));
            }
            showToast("Archived exam schedule deleted.");
            await loadExamArchiveData();
        } catch (err) {
            console.error("Delete error:", err);
            showToast(`Could not delete: ${err.message}`);
        }
        return;
    }

    // Delete single Class Archive
    const delClassBtn = event.target.closest(".class-archive-delete-btn");
    if (delClassBtn) {
        const delId = delClassBtn.dataset.deleteId;
        if (!delId) return;
        const confirmed = confirm("Are you sure you want to delete this archived class schedule?");
        if (!confirmed) return;

        try {
            const item = classArchiveRecords.find(r => r.id === delId);
            if (item?.source === "reports") {
                await deleteReportFromFirestore(delId);
            } else {
                await deleteDoc(doc(db, "classSchedules", delId));
            }
            showToast("Archived class schedule deleted.");
            await loadClassArchiveData();
        } catch (err) {
            console.error("Delete error:", err);
            showToast(`Could not delete: ${err.message}`);
        }
        return;
    }

    // Exam Pagination
    if (event.target.id === "examArchivePrevPage") {
        examCurrentPage -= 1;
        renderExamArchive();
    }
    if (event.target.id === "examArchiveNextPage") {
        examCurrentPage += 1;
        renderExamArchive();
    }
    const examPageNum = event.target.dataset?.examPage;
    if (examPageNum) {
        examCurrentPage = Number(examPageNum);
        renderExamArchive();
    }

    // Close calendar modals on backdrop click
    if (event.target.id === "examCalendarModal") {
        closeCalendarModal();
    }
    if (event.target.id === "classCalendarModal") {
        closeClassCalendarModal();
    }
});

// Escape key to close both modals
document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeCalendarModal();
        closeClassCalendarModal();
    }
});

/* ------------------------------------------------------------------ */
/*  Initialization & Logout                                           */
/* ------------------------------------------------------------------ */

loadExamArchiveData();
loadClassArchiveData();
loadFacultyLoadingData();

document.getElementById("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try {
        if (auth) await signOut(auth);
    } catch (e) {
        console.error("Sign out error:", e);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("login.html");
});
