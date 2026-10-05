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
let facultyDiscreteClasses = [];
let facultyFilterYear = "";
let facultyFilterSemester = "";
let facultyFilterDepartment = "";
let facultyLoadingSearch = "";
let facultyViewMode = "combined";

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

function populateFacultyFilters() {
    const yearSelect = document.getElementById("facultyLoadingAcademicYear");
    const deptSelect = document.getElementById("facultyLoadingDepartment");

    if (yearSelect) {
        const years = [...new Set(
            facultyDiscreteClasses.map(c => c.academicYear).filter(Boolean)
        )].sort((a, b) => b.localeCompare(a));
        const cur = yearSelect.value;
        yearSelect.innerHTML = `<option value="">All Academic Years</option>` +
            years.map(y => `<option value="${escapeHtml(y)}">A.Y. ${escapeHtml(y)}</option>`).join("");
        if (cur && years.includes(cur)) yearSelect.value = cur;
    }

    if (deptSelect) {
        const depts = [...new Set([
            ...facultyLoadingRecords.map(f => f.department).filter(Boolean),
            ...facultyDiscreteClasses.map(c => c.program).filter(Boolean)
        ])].sort((a, b) => a.localeCompare(b));
        const cur = deptSelect.value;
        deptSelect.innerHTML = `<option value="">All Programs / Depts</option>` +
            depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
        if (cur && depts.includes(cur)) deptSelect.value = cur;
    }
}

function getFilteredFacultyRecords() {
    let result = facultyLoadingRecords.map(f => {
        let classes = f.assignedClasses || [];

        if (facultyFilterYear) {
            classes = classes.filter(c => (c.academicYear || "") === facultyFilterYear);
        }
        if (facultyFilterSemester) {
            classes = classes.filter(c => (c.semester || "").toLowerCase() === facultyFilterSemester.toLowerCase());
        }
        if (facultyFilterDepartment) {
            const dept = normalise(facultyFilterDepartment);
            classes = classes.filter(c => normalise(c.program) === dept || normalise(f.department) === dept);
        }

        const uniqueSubjects = [...new Set(classes.map(c => c.subjectCode))];
        const uniqueSections = [...new Set(classes.map(c => c.section))];
        const totalHours = Number(classes.reduce((sum, c) => sum + (Number(c.hours) || 0), 0).toFixed(1));

        return {
            ...f,
            filteredClasses: classes,
            totalSubjects: uniqueSubjects.length,
            totalSections: uniqueSections.length,
            totalHours,
            loadStatus: getLoadStatus(totalHours)
        };
    });

    if (facultyFilterDepartment) {
        const dept = normalise(facultyFilterDepartment);
        result = result.filter(f => normalise(f.department) === dept || f.filteredClasses.length > 0);
    }

    if (facultyLoadingSearch) {
        const q = normalise(facultyLoadingSearch);
        result = result.filter(f =>
            normalise(f.name).includes(q) ||
            normalise(f.employeeId).includes(q) ||
            normalise(f.department).includes(q) ||
            (Array.isArray(f.filteredClasses) && f.filteredClasses.some(c =>
                normalise(c.subjectCode).includes(q) ||
                normalise(c.subjectName).includes(q) ||
                normalise(c.section).includes(q) ||
                normalise(c.room).includes(q) ||
                normalise(c.day).includes(q)
            ))
        );
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

function renderFacultyLoadingTable() {
    const thead = document.getElementById("facultyLoadingTableHead");
    const tbody = document.getElementById("facultyLoadingTableBody");
    const emptyNote = document.getElementById("emptyFacultyLoading");
    const statsBadge = document.getElementById("facultyLoadingStatsBadge");
    if (!tbody || !emptyNote) return;

    populateFacultyFilters();

    const filtered = getFilteredFacultyRecords();

    // Calculate aggregated stats
    const totalFaculty = filtered.length;
    const assignedFaculty = filtered.filter(f => f.totalHours > 0).length;
    const totalClasses = filtered.reduce((sum, f) => sum + f.filteredClasses.length, 0);
    const totalTeachingHours = Number(filtered.reduce((sum, f) => sum + f.totalHours, 0).toFixed(1));

    if (statsBadge) {
        statsBadge.innerHTML = `Showing <strong>${totalFaculty}</strong> faculty (${assignedFaculty} assigned) • <strong>${totalClasses}</strong> class assignments • <strong>${totalTeachingHours} hrs/wk</strong> total`;
    }

    if (!filtered.length) {
        if (thead) thead.innerHTML = "";
        tbody.innerHTML = "";
        emptyNote.textContent = facultyLoadingRecords.length === 0
            ? "No faculty loading data found."
            : "No faculty loading records matching the active filters or search.";
        emptyNote.hidden = false;
        return;
    }

    emptyNote.hidden = true;

    if (facultyViewMode === "combined") {
        // Combined Master Report View
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="min-width:200px;">Faculty / Instructor</th>
                    <th style="min-width:110px;">Employee ID</th>
                    <th style="min-width:110px;">Course Code</th>
                    <th style="min-width:180px;">Course Description</th>
                    <th style="min-width:100px;">Section</th>
                    <th style="min-width:130px;">Schedule (Day/Time)</th>
                    <th style="min-width:80px; text-align:center;">Room</th>
                    <th style="min-width:60px; text-align:center;">Units</th>
                    <th style="min-width:80px; text-align:center;">Hours/Wk</th>
                    <th style="min-width:120px; text-align:center;">Load Status</th>
                    <th style="min-width:100px; text-align:center;">Action</th>
                </tr>
            `;
        }

        let rowsHtml = "";
        filtered.forEach(f => {
            const status = f.loadStatus;
            const classes = f.filteredClasses || [];

            // Group Header Row for this faculty
            rowsHtml += `
                <tr class="master-fac-header-row">
                    <td colspan="9" style="background:#e8f5e9; font-weight:bold; color:#1b5e20; padding:10px 12px;">
                        <span>👤 <strong>${escapeHtml(f.name)}</strong></span>
                        <span style="font-weight:normal; color:#555; margin-left:8px;">[ID: ${escapeHtml(f.employeeId || 'N/A')}]</span>
                        <span style="font-weight:normal; background:#fff; border:1px solid #c8e6c9; padding:2px 8px; border-radius:10px; font-size:11px; margin-left:8px; color:#2e7d32;">
                            ${escapeHtml(f.department || 'General')}
                        </span>
                        <span style="font-weight:normal; margin-left:12px; color:#555; font-size:12px;">
                            Assignments: <strong>${classes.length}</strong> | Total: <strong>${f.totalHours} hrs/wk</strong>
                        </span>
                    </td>
                    <td style="text-align:center; background:#e8f5e9; padding:10px 6px;">
                        <span style="background:${status.bg}; color:${status.color}; border:1px solid ${status.border}; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:bold;">
                            ${escapeHtml(status.text)}
                        </span>
                    </td>
                    <td style="text-align:center; background:#e8f5e9; padding:10px 6px;">
                        <button type="button" class="faculty-loading-print-btn" data-faculty-id="${escapeHtml(f.uid || f.id)}" style="padding:4px 10px; border:none; border-radius:6px; background:#2e7d32; color:#fff; font-size:11px; font-weight:bold; cursor:pointer;" title="Print Individual Teaching Load Sheet">
                            🖨️ Print
                        </button>
                    </td>
                </tr>
            `;

            if (classes.length > 0) {
                classes.forEach(c => {
                    rowsHtml += `
                        <tr class="master-class-row">
                            <td style="padding-left:26px; color:#555; font-size:12px;">
                                ↳ <span style="color:#222;">${escapeHtml(f.name)}</span>
                            </td>
                            <td style="font-size:12px; color:#666;">${escapeHtml(f.employeeId || '—')}</td>
                            <td><strong style="color:#1b5e20;">${escapeHtml(c.subjectCode)}</strong></td>
                            <td style="font-size:12px;">${escapeHtml(c.subjectName)}</td>
                            <td><span style="background:#e8f5e9; color:#1b5e20; border:1px solid #c8e6c9; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600;">${escapeHtml(c.section)}</span></td>
                            <td style="font-size:12px;"><strong>${escapeHtml(c.day)}</strong> ${escapeHtml(c.time)}</td>
                            <td style="text-align:center; font-size:12px;">${escapeHtml(c.room)}</td>
                            <td style="text-align:center; font-size:12px;">${c.units || 3}</td>
                            <td style="text-align:center; font-weight:bold; font-size:12px;">${c.hours || 3} hrs</td>
                            <td style="text-align:center; font-size:11px; color:#666;">${escapeHtml(status.text)}</td>
                            <td style="text-align:center; color:#aaa; font-size:11px;">—</td>
                        </tr>
                    `;
                });
            } else {
                rowsHtml += `
                    <tr class="master-class-row">
                        <td style="padding-left:26px; color:#777; font-size:12px;">↳ ${escapeHtml(f.name)}</td>
                        <td style="font-size:12px; color:#777;">${escapeHtml(f.employeeId || '—')}</td>
                        <td colspan="7" style="text-align:center; color:#999; font-style:italic; padding:10px;">
                            No active teaching assignments recorded for this period
                        </td>
                        <td style="text-align:center; font-size:11px; color:#777;">${escapeHtml(status.text)}</td>
                        <td style="text-align:center; color:#aaa; font-size:11px;">—</td>
                    </tr>
                `;
            }
        });

        // Master Grand Totals Row
        rowsHtml += `
            <tr style="background:#f1f8e9; border-top:2px solid #2e7d32; font-weight:bold;">
                <td colspan="7" style="padding:10px 12px; font-size:13px; color:#1b5e20;">
                    MASTER GRAND TOTALS (${totalFaculty} Faculty Members • ${totalClasses} Classes Assigned)
                </td>
                <td style="text-align:center; font-size:13px; color:#1b5e20;">
                    ${filtered.reduce((sum, f) => sum + (f.filteredClasses || []).reduce((s, c) => s + (Number(c.units) || 0), 0), 0)}
                </td>
                <td style="text-align:center; font-size:13px; color:#1b5e20;">
                    ${totalTeachingHours} hrs
                </td>
                <td colspan="2" style="text-align:center; font-size:12px; color:#555;">
                    ${assignedFaculty} Assigned
                </td>
            </tr>
        `;

        tbody.innerHTML = rowsHtml;
    } else {
        // Summary View
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="min-width:180px;">Faculty Name</th>
                    <th style="min-width:120px;">Employee ID</th>
                    <th style="min-width:150px;">Department</th>
                    <th style="min-width:100px; text-align:center;">Subjects</th>
                    <th style="min-width:100px; text-align:center;">Sections</th>
                    <th style="min-width:130px; text-align:center;">Teaching Hours</th>
                    <th style="min-width:140px; text-align:center;">Load Status</th>
                    <th style="min-width:120px; text-align:center;">Action</th>
                </tr>
            `;
        }

        tbody.innerHTML = filtered.map(f => {
            const status = f.loadStatus;
            return `
                <tr>
                    <td>
                        <strong>${escapeHtml(f.name)}</strong>
                        ${f.department ? `<div style="font-size:12px; color:#666;">${escapeHtml(f.department)}</div>` : ""}
                    </td>
                    <td>${escapeHtml(f.employeeId || "—")}</td>
                    <td>${escapeHtml(f.department || "General")}</td>
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

        facultyDiscreteClasses = discreteClasses;

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

/* ------------------------------------------------------------------ */
/*  Google Sheets & Spreadsheet Exporters                             */
/* ------------------------------------------------------------------ */

function escapeCsvField(val) {
    const str = String(val ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function triggerDownload(content, filename, mimeType = "text/csv;charset=utf-8;") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function getMasterReportRows(filteredData) {
    const rows = [];
    filteredData.forEach(f => {
        const classes = f.filteredClasses || [];
        if (classes.length > 0) {
            classes.forEach(c => {
                rows.push({
                    facultyName: f.name,
                    employeeId: f.employeeId || "—",
                    department: f.department || "General",
                    courseCode: c.subjectCode,
                    courseDescription: c.subjectName,
                    section: c.section,
                    day: c.day,
                    time: c.time,
                    room: c.room,
                    units: c.units || 3,
                    hours: c.hours || 3,
                    loadStatus: f.loadStatus.text,
                    academicYear: c.academicYear || facultyFilterYear || "—",
                    semester: c.semester || facultyFilterSemester || "—"
                });
            });
        } else {
            rows.push({
                facultyName: f.name,
                employeeId: f.employeeId || "—",
                department: f.department || "General",
                courseCode: "—",
                courseDescription: "No active teaching assignments",
                section: "—",
                day: "—",
                time: "—",
                room: "—",
                units: 0,
                hours: 0,
                loadStatus: f.loadStatus.text,
                academicYear: facultyFilterYear || "—",
                semester: facultyFilterSemester || "—"
            });
        }
    });
    return rows;
}

function getSummaryReportRows(filteredData) {
    return filteredData.map(f => ({
        facultyName: f.name,
        employeeId: f.employeeId || "—",
        department: f.department || "General",
        totalSubjects: f.totalSubjects,
        totalSections: f.totalSections,
        totalHours: f.totalHours,
        loadStatus: f.loadStatus.text
    }));
}

async function exportCombinedToGoogleSheets() {
    const filtered = getFilteredFacultyRecords();
    if (!filtered.length) {
        showToast("No faculty loading data available to export.");
        return;
    }

    const masterRows = getMasterReportRows(filtered);

    // Build Tab-Separated Values (TSV) for native Google Sheets clipboard paste
    const headers = [
        "Faculty Member",
        "Employee ID",
        "Department",
        "Course Code",
        "Course Description",
        "Section",
        "Day",
        "Time",
        "Room",
        "Units",
        "Hours/Week",
        "Load Status",
        "Academic Year",
        "Semester"
    ];

    const tsvLines = [headers.join("\t")];
    masterRows.forEach(r => {
        tsvLines.push([
            r.facultyName,
            r.employeeId,
            r.department,
            r.courseCode,
            r.courseDescription,
            r.section,
            r.day,
            r.time,
            r.room,
            r.units,
            r.hours,
            r.loadStatus,
            r.academicYear,
            r.semester
        ].map(val => String(val).replace(/[\t\r\n]/g, " ")).join("\t"));
    });
    const tsvContent = tsvLines.join("\n");

    // Build rich HTML table for clipboard styling in Google Sheets
    const htmlTable = `
        <table border="1">
            <thead>
                <tr style="background:#2e7d32; color:#ffffff; font-weight:bold;">
                    ${headers.map(h => `<th style="padding:6px 10px;">${escapeHtml(h)}</th>`).join("")}
                </tr>
            </thead>
            <tbody>
                ${masterRows.map((r, idx) => `
                    <tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f9f9f9'};">
                        <td style="padding:4px 8px;"><strong>${escapeHtml(r.facultyName)}</strong></td>
                        <td style="padding:4px 8px;">${escapeHtml(r.employeeId)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.department)}</td>
                        <td style="padding:4px 8px;"><code>${escapeHtml(r.courseCode)}</code></td>
                        <td style="padding:4px 8px;">${escapeHtml(r.courseDescription)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.section)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.day)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.time)}</td>
                        <td style="padding:4px 8px; text-align:center;">${escapeHtml(r.room)}</td>
                        <td style="padding:4px 8px; text-align:center;">${r.units}</td>
                        <td style="padding:4px 8px; text-align:center;"><strong>${r.hours}</strong></td>
                        <td style="padding:4px 8px; text-align:center;">${escapeHtml(r.loadStatus)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.academicYear)}</td>
                        <td style="padding:4px 8px;">${escapeHtml(r.semester)}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;

    let copied = false;
    if (navigator.clipboard && window.ClipboardItem) {
        try {
            const textBlob = new Blob([tsvContent], { type: "text/plain" });
            const htmlBlob = new Blob([htmlTable], { type: "text/html" });
            await navigator.clipboard.write([
                new ClipboardItem({
                    "text/plain": textBlob,
                    "text/html": htmlBlob
                })
            ]);
            copied = true;
        } catch (_) {}
    }

    if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(tsvContent);
            copied = true;
        } catch (_) {}
    }

    if (!copied) {
        try {
            const ta = document.createElement("textarea");
            ta.value = tsvContent;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            copied = true;
        } catch (_) {}
    }

    // Close export modal
    const modal = document.getElementById("facultyExportModal");
    if (modal) modal.style.display = "none";

    // Launch Google Sheets
    window.open("https://sheets.new", "_blank");

    showToast("Master loading report copied to clipboard! In your new Google Sheet, press Ctrl+V to paste.");
}

function exportCombinedToCsv(type = "master") {
    const filtered = getFilteredFacultyRecords();
    if (!filtered.length) {
        showToast("No faculty loading data available to export.");
        return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);

    if (type === "master") {
        const rows = getMasterReportRows(filtered);
        const headers = [
            "Faculty Member",
            "Employee ID",
            "Department",
            "Course Code",
            "Course Description",
            "Section",
            "Day",
            "Time",
            "Room",
            "Units",
            "Weekly Hours",
            "Load Status",
            "Academic Year",
            "Semester"
        ];

        const csvLines = [headers.map(escapeCsvField).join(",")];
        rows.forEach(r => {
            csvLines.push([
                r.facultyName,
                r.employeeId,
                r.department,
                r.courseCode,
                r.courseDescription,
                r.section,
                r.day,
                r.time,
                r.room,
                r.units,
                r.hours,
                r.loadStatus,
                r.academicYear,
                r.semester
            ].map(escapeCsvField).join(","));
        });

        // Prepend UTF-8 BOM \uFEFF for proper encoding in Excel and Google Sheets
        const csvContent = "\uFEFF" + csvLines.join("\r\n");
        triggerDownload(csvContent, `SLSU_Faculty_Loading_Combined_Master_${timestamp}.csv`);
        showToast("Combined Master CSV downloaded. You can upload or import it directly into Google Sheets.");
    } else {
        const rows = getSummaryReportRows(filtered);
        const headers = [
            "Faculty Member",
            "Employee ID",
            "Department",
            "Total Subjects",
            "Total Sections",
            "Weekly Teaching Hours",
            "Load Status"
        ];

        const csvLines = [headers.map(escapeCsvField).join(",")];
        rows.forEach(r => {
            csvLines.push([
                r.facultyName,
                r.employeeId,
                r.department,
                r.totalSubjects,
                r.totalSections,
                r.totalHours,
                r.loadStatus
            ].map(escapeCsvField).join(","));
        });

        const csvContent = "\uFEFF" + csvLines.join("\r\n");
        triggerDownload(csvContent, `SLSU_Faculty_Loading_Summary_${timestamp}.csv`);
        showToast("Faculty Summary CSV downloaded.");
    }

    const modal = document.getElementById("facultyExportModal");
    if (modal) modal.style.display = "none";
}

function exportCombinedToExcel() {
    const filtered = getFilteredFacultyRecords();
    if (!filtered.length) {
        showToast("No faculty loading data available to export.");
        return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);

    if (typeof window.XLSX !== "undefined") {
        try {
            const wb = window.XLSX.utils.book_new();

            // Sheet 1: Master Detailed Report
            const masterData = getMasterReportRows(filtered).map(r => ({
                "Faculty Member": r.facultyName,
                "Employee ID": r.employeeId,
                "Department": r.department,
                "Course Code": r.courseCode,
                "Course Description": r.courseDescription,
                "Section": r.section,
                "Day": r.day,
                "Time": r.time,
                "Room": r.room,
                "Units": r.units,
                "Weekly Hours": r.hours,
                "Load Status": r.loadStatus,
                "Academic Year": r.academicYear,
                "Semester": r.semester
            }));
            const wsMaster = window.XLSX.utils.json_to_sheet(masterData);

            // Auto column widths
            const colWidthsMaster = [
                { wch: 26 }, { wch: 14 }, { wch: 18 }, { wch: 12 }, { wch: 30 },
                { wch: 14 }, { wch: 10 }, { wch: 15 }, { wch: 10 }, { wch: 8 },
                { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }
            ];
            wsMaster["!cols"] = colWidthsMaster;
            window.XLSX.utils.book_append_sheet(wb, wsMaster, "Master Loading Report");

            // Sheet 2: Faculty Summary
            const summaryData = getSummaryReportRows(filtered).map(r => ({
                "Faculty Member": r.facultyName,
                "Employee ID": r.employeeId,
                "Department": r.department,
                "Total Subjects": r.totalSubjects,
                "Total Sections": r.totalSections,
                "Weekly Teaching Hours": r.totalHours,
                "Load Status": r.loadStatus
            }));
            const wsSummary = window.XLSX.utils.json_to_sheet(summaryData);
            const colWidthsSummary = [
                { wch: 26 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 14 }
            ];
            wsSummary["!cols"] = colWidthsSummary;
            window.XLSX.utils.book_append_sheet(wb, wsSummary, "Faculty Summary");

            window.XLSX.writeFile(wb, `SLSU_Faculty_Loading_Master_Report_${timestamp}.xlsx`);
            showToast("Excel workbook (.xlsx) downloaded. Drag and drop into Google Drive to open in Google Sheets!");

            const modal = document.getElementById("facultyExportModal");
            if (modal) modal.style.display = "none";
            return;
        } catch (err) {
            console.warn("SheetJS error, falling back to CSV:", err);
        }
    }

    // Fallback if XLSX library is unavailable
    exportCombinedToCsv("master");
}

/* ------------------------------------------------------------------ */
/*  Print Combined Faculty Loading Report                             */
/* ------------------------------------------------------------------ */

function printFacultyLoadingCombined() {
    const filtered = getFilteredFacultyRecords();
    if (!filtered.length) {
        showToast("No faculty loading data available to print.");
        return;
    }

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;
    const nowStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const totalFaculty = filtered.length;
    const assignedFaculty = filtered.filter(f => f.totalHours > 0).length;
    const totalClasses = filtered.reduce((sum, f) => sum + f.filteredClasses.length, 0);
    const totalTeachingHours = Number(filtered.reduce((sum, f) => sum + f.totalHours, 0).toFixed(1));
    const totalTeachingUnits = filtered.reduce((sum, f) => sum + f.filteredClasses.reduce((s, c) => s + (Number(c.units) || 0), 0), 0);

    const periodStr = [
        facultyFilterYear ? `Academic Year ${facultyFilterYear}` : "",
        facultyFilterSemester ? facultyFilterSemester : "",
        facultyFilterDepartment ? `Department: ${facultyFilterDepartment}` : ""
    ].filter(Boolean).join(" • ") || "All Academic Periods";

    let rowsHtml = "";
    filtered.forEach(f => {
        const classes = f.filteredClasses || [];
        const status = f.loadStatus;

        rowsHtml += `
            <tr style="background:#e8f5e9; font-weight:bold;">
                <td colspan="7" style="border:1px solid #777; padding:6px 8px; color:#1b5e20;">
                    👤 ${escapeHtml(f.name)} 
                    <span style="font-weight:normal; color:#444; font-size:10px;">[ID: ${escapeHtml(f.employeeId || 'N/A')}]</span>
                    <span style="font-weight:normal; margin-left:8px; font-size:10px; color:#2e7d32;">${escapeHtml(f.department || 'General')}</span>
                    <span style="font-weight:normal; margin-left:10px; font-size:10px; color:#555;">(${classes.length} class(es) assigned)</span>
                </td>
                <td style="border:1px solid #777; text-align:center; padding:6px 4px; font-size:10px;">
                    ${classes.reduce((sum, c) => sum + (Number(c.units) || 0), 0)} u
                </td>
                <td style="border:1px solid #777; text-align:center; padding:6px 4px; font-size:10px; font-weight:bold;">
                    ${f.totalHours} hrs
                </td>
                <td style="border:1px solid #777; text-align:center; padding:6px 4px; font-size:10px; color:${status.color};">
                    ${escapeHtml(status.text)}
                </td>
            </tr>
        `;

        if (classes.length > 0) {
            classes.forEach(c => {
                rowsHtml += `
                    <tr>
                        <td style="padding-left:18px; font-size:10px; border:1px solid #bbb;"><code>${escapeHtml(c.subjectCode)}</code></td>
                        <td style="font-size:10px; border:1px solid #bbb;">${escapeHtml(c.subjectName)}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;"><strong>${escapeHtml(c.section)}</strong></td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${escapeHtml(c.day)}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${escapeHtml(c.time)}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${escapeHtml(c.room)}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${escapeHtml(c.program || f.department || "—")}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${c.units || 3}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center;">${c.hours || 3}</td>
                        <td style="font-size:10px; border:1px solid #bbb; text-align:center; color:#666;">Active</td>
                    </tr>
                `;
            });
        } else {
            rowsHtml += `
                <tr>
                    <td colspan="10" style="text-align:center; color:#777; font-style:italic; font-size:10px; padding:6px; border:1px solid #bbb;">
                        No teaching assignments recorded for this period
                    </td>
                </tr>
            `;
        }
    });

    const html = `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>SLSU Lucena - Combined Master Faculty Loading Report</title>
        <style>
            @page { size: A4 landscape; margin: 10mm 12mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; padding: 12px; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 8px; }
            .logo-img { width: 55px; height: 55px; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #000; }
            .dtlc-name, .campus-name { font-size: 11px; font-weight: bold; color: #222; margin-top: 1px; }
            .city-name { font-size: 10px; color: #555; }
            .divider { border-top: 2px solid #1b5e20; margin: 6px 0 10px 0; }
            .report-title { text-align: center; font-size: 14px; font-weight: bold; text-decoration: underline; margin-bottom: 2px; }
            .report-sub { text-align: center; font-size: 11px; color: #555; margin-bottom: 10px; }
            .summary-box { display: flex; justify-content: space-around; background: #f1f8e9; border: 1px solid #c8e6c9; border-radius: 6px; padding: 8px; margin-bottom: 12px; font-size: 11px; }
            .summary-box strong { color: #1b5e20; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-top: 4px; }
            th { background: #a7c7a3; color: #1b5e20; font-weight: bold; text-align: center; border: 1px solid #777; padding: 5px 4px; }
            td { padding: 4px 5px; }
            .signatures { display: flex; justify-content: space-between; margin-top: 30px; page-break-inside: avoid; }
            .sign-col { text-align: center; width: 220px; font-size: 10.5px; }
            .sign-line { border-bottom: 1px solid #333; margin-bottom: 6px; height: 32px; }
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
        <div class="report-title">MASTER FACULTY TEACHING LOAD COMBINED REPORT</div>
        <div class="report-sub">${escapeHtml(periodStr)} • Generated on ${escapeHtml(nowStr)}</div>

        <div class="summary-box">
            <div>Total Faculty: <strong>${totalFaculty}</strong></div>
            <div>Assigned Faculty: <strong>${assignedFaculty}</strong></div>
            <div>Total Classes: <strong>${totalClasses}</strong></div>
            <div>Total Units: <strong>${totalTeachingUnits}</strong></div>
            <div>Total Teaching Hours: <strong>${totalTeachingHours} hrs/wk</strong></div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width:11%;">Course Code</th>
                    <th style="width:25%;">Course Description</th>
                    <th style="width:10%;">Section</th>
                    <th style="width:6%;">Day</th>
                    <th style="width:14%;">Time</th>
                    <th style="width:8%;">Room</th>
                    <th style="width:10%;">Program</th>
                    <th style="width:5%;">Units</th>
                    <th style="width:5%;">Hours</th>
                    <th style="width:6%;">Status</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
                <tr style="background:#f1f8e9; border:2px solid #2e7d32; font-weight:bold; font-size:10px;">
                    <td colspan="7" style="padding:6px; color:#1b5e20;">GRAND TOTALS (${totalFaculty} Instructors • ${totalClasses} Classes)</td>
                    <td style="text-align:center; color:#1b5e20; border:1px solid #777;">${totalTeachingUnits}</td>
                    <td style="text-align:center; color:#1b5e20; border:1px solid #777;">${totalTeachingHours}</td>
                    <td style="text-align:center; color:#1b5e20; border:1px solid #777;">${assignedFaculty} Active</td>
                </tr>
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

function printFacultyLoadingSummary() {
    const filtered = getFilteredFacultyRecords();
    if (!filtered.length) {
        showToast("No faculty loading data available to print.");
        return;
    }

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;
    const nowStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const totalFaculty = filtered.length;
    const assignedFaculty = filtered.filter(f => f.totalHours > 0).length;
    const totalTeachingHours = filtered.reduce((sum, f) => sum + (f.totalHours || 0), 0).toFixed(1);

    const rows = filtered.map(f => `
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

// Filter listeners
document.getElementById("facultyLoadingAcademicYear")?.addEventListener("change", event => {
    facultyFilterYear = event.target.value;
    renderFacultyLoadingTable();
});

document.getElementById("facultyLoadingSemester")?.addEventListener("change", event => {
    facultyFilterSemester = event.target.value;
    renderFacultyLoadingTable();
});

document.getElementById("facultyLoadingDepartment")?.addEventListener("change", event => {
    facultyFilterDepartment = event.target.value;
    renderFacultyLoadingTable();
});

document.getElementById("facultyLoadingSearch")?.addEventListener("input", event => {
    facultyLoadingSearch = event.target.value;
    renderFacultyLoadingTable();
});

// View Mode toggle listeners
document.getElementById("facultyViewCombinedBtn")?.addEventListener("click", () => {
    facultyViewMode = "combined";
    const combinedBtn = document.getElementById("facultyViewCombinedBtn");
    const summaryBtn = document.getElementById("facultyViewSummaryBtn");
    if (combinedBtn) {
        combinedBtn.classList.add("active");
        combinedBtn.style.background = "#2e7d32";
        combinedBtn.style.color = "#fff";
    }
    if (summaryBtn) {
        summaryBtn.classList.remove("active");
        summaryBtn.style.background = "transparent";
        summaryBtn.style.color = "#2e7d32";
    }
    renderFacultyLoadingTable();
});

document.getElementById("facultyViewSummaryBtn")?.addEventListener("click", () => {
    facultyViewMode = "summary";
    const combinedBtn = document.getElementById("facultyViewCombinedBtn");
    const summaryBtn = document.getElementById("facultyViewSummaryBtn");
    if (summaryBtn) {
        summaryBtn.classList.add("active");
        summaryBtn.style.background = "#2e7d32";
        summaryBtn.style.color = "#fff";
    }
    if (combinedBtn) {
        combinedBtn.classList.remove("active");
        combinedBtn.style.background = "transparent";
        combinedBtn.style.color = "#2e7d32";
    }
    renderFacultyLoadingTable();
});

// Export Modal & Action listeners
const facultyExportModal = document.getElementById("facultyExportModal");
document.getElementById("exportFacultyLoadingBtn")?.addEventListener("click", () => {
    if (facultyExportModal) facultyExportModal.style.display = "flex";
});

document.getElementById("facultyExportModalClose")?.addEventListener("click", () => {
    if (facultyExportModal) facultyExportModal.style.display = "none";
});

document.getElementById("exportToSheetsWebBtn")?.addEventListener("click", exportCombinedToGoogleSheets);
document.getElementById("exportToExcelBtn")?.addEventListener("click", exportCombinedToExcel);
document.getElementById("exportToCsvMasterBtn")?.addEventListener("click", () => exportCombinedToCsv("master"));
document.getElementById("exportToCsvSummaryBtn")?.addEventListener("click", () => exportCombinedToCsv("summary"));

document.getElementById("printCombinedFacultyLoadingBtn")?.addEventListener("click", printFacultyLoadingCombined);
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

    // Close modals on backdrop click
    if (event.target.id === "examCalendarModal") {
        closeCalendarModal();
    }
    if (event.target.id === "classCalendarModal") {
        closeClassCalendarModal();
    }
    if (event.target.id === "facultyExportModal") {
        const modal = document.getElementById("facultyExportModal");
        if (modal) modal.style.display = "none";
    }
});

// Escape key to close all modals
document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeCalendarModal();
        closeClassCalendarModal();
        const exportModal = document.getElementById("facultyExportModal");
        if (exportModal) exportModal.style.display = "none";
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
