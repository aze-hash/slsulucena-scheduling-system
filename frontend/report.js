import { db, auth } from "../firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
    loadReportsFromFirestore,
    deleteReportFromFirestore,
    deleteReportsByCategoryFromFirestore,
    deleteArchivedExamSchedulesFromFirestore
} from "./reportStorage.js";
import { renderExamCalendar } from "./js/schedule-calendar.js";

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

// Table click delegation (PDF, Timetable, Delete single)
document.addEventListener("click", async event => {
    // View PDF
    const pdfBtn = event.target.closest(".archive-view-pdf");
    if (pdfBtn) {
        const reportId = pdfBtn.dataset.viewExamId;
        if (reportId) viewExamSchedulePdf(reportId);
        return;
    }

    // View Calendar Timetable
    const calBtn = event.target.closest(".archive-view-cal");
    if (calBtn) {
        const calId = calBtn.dataset.viewCalId;
        if (calId) viewExamScheduleCalendar(calId);
        return;
    }

    // Delete single
    const delBtn = event.target.closest(".archive-delete-btn");
    if (delBtn) {
        const delId = delBtn.dataset.deleteId;
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
            showToast("Archived schedule deleted.");
            await loadExamArchiveData();
        } catch (err) {
            console.error("Delete error:", err);
            showToast(`Could not delete: ${err.message}`);
        }
        return;
    }

    // Pagination
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

    // Close calendar modal on backdrop click
    if (event.target.id === "examCalendarModal") {
        closeCalendarModal();
    }
});

loadExamArchiveData();

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
