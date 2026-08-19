import { db } from "../firebase.js";
import {
    loadReportsFromFirestore,
    deleteReportsByCategoryFromFirestore,
    deleteArchivedClassSchedulesFromFirestore
} from "./reportStorage.js";

import {
    collection,
    getDocs,
    deleteDoc,
    doc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ------------------------------------------------------------------ */
/*  Custom centered notification system                                */
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
/*  Global state & pagination settings                                */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 10;

let classArchiveRecords = [];
let classFilterYear = "";
let classFilterSemester = "";
let classFilterSearch = "";
let classCurrentPage = 1;

let examArchiveReports = [];
let examFilterYear = "";
let examFilterSemester = "";
let examFilterExamType = "";
let examFilterSearch = "";
let examCurrentPage = 1;

/* ------------------------------------------------------------------ */
/*  CLASS SCHEDULE ARCHIVE                                            */
/* ------------------------------------------------------------------ */

function populateClassYearFilter(records) {
    const yearSelect = document.getElementById("classArchiveAcademicYear");
    if (!yearSelect) return;

    const years = [...new Set(
        records.map(r => r.academicYear).filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));

    const currentValue = yearSelect.value;
    yearSelect.innerHTML = `<option value="">All Years</option>` +
        years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");

    if (currentValue && years.includes(currentValue)) {
        yearSelect.value = currentValue;
    }
}

function renderClassArchive() {
    const tbody = document.getElementById("classArchiveTableBody");
    const emptyNote = document.getElementById("emptyClassArchive");

    if (!tbody || !emptyNote) return;

    populateClassYearFilter(classArchiveRecords);

    // If no filter is set by user, default to the latest Academic Year in classArchiveRecords
    if (!classFilterYear && !classFilterSemester && !classFilterSearch.trim() && classArchiveRecords.length > 0) {
        const sortedByLatest = [...classArchiveRecords].sort((a, b) => {
            const aTime = a.exportedAt || a.createdAt || "";
            const bTime = b.exportedAt || b.createdAt || "";
            return String(bTime).localeCompare(String(aTime));
        });
        const latestAY = sortedByLatest[0]?.academicYear;
        if (latestAY) {
            classFilterYear = latestAY;
            const yearSelect = document.getElementById("classArchiveAcademicYear");
            if (yearSelect) yearSelect.value = latestAY;
        }
    }

    const hasFilter = Boolean(classFilterYear || classFilterSemester || classFilterSearch.trim());

    if (!hasFilter) {
        tbody.innerHTML = "";
        emptyNote.textContent = "No archived class schedules available.";
        emptyNote.hidden = false;
        return;
    }

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
            normalise(r.title || r.section || r.name).includes(term) ||
            normalise(r.academicYear).includes(term) ||
            normalise(r.semester).includes(term)
        );
    }

    filtered.sort((a, b) => {
        const aTime = a.exportedAt || a.createdAt || "";
        const bTime = b.createdAt || "";
        return String(bTime).localeCompare(String(aTime));
    });

    if (!filtered.length) {
        tbody.innerHTML = "";
        emptyNote.textContent = "No archived class schedules matching the selected filter(s).";
        emptyNote.hidden = false;
        return;
    }

    emptyNote.hidden = true;

    tbody.innerHTML = filtered.map(item => `
        <tr>
            <td>${escapeHtml(item.title || item.section || item.name || "Section")}</td>
            <td>${escapeHtml(item.academicYear ? `A.Y. ${item.academicYear}` : "—")}</td>
            <td>${escapeHtml(item.semester || "—")}</td>
            <td>${escapeHtml(formatDate(item.exportedAt || item.createdAt))}</td>
            <td>
                <button type="button" class="archive-view-pdf" data-view-class-id="${escapeHtml(item.id)}">View PDF</button>
            </td>
        </tr>
    `).join("");
}

function viewClassSchedulePdf(id) {
    const item = classArchiveRecords.find(r => r.id === id);
    if (!item) {
        showToast("Could not find the archived class schedule record.");
        return;
    }

    if (item.html) {
        openPrintWindow(item.html);
        return;
    }

    /* Fallback: construct printable HTML for class schedules loaded directly from classSchedules collection */
    const logoUrl = new URL('logo (1).png', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    const printStyles = `
        <style>
            @page { size: A4 portrait; margin: 12mm 15mm; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: Arial, sans-serif; color: #1a1a1a; }
            .header-section { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
            .logo-img { width: 65px; height: 65px; }
            .logo-left, .logo-right { flex-shrink: 0; }
            .header-text { text-align: center; flex-grow: 1; }
            .uni-name { font-size: 15px; font-weight: bold; color: #1b5e20; letter-spacing: 0.5px; }
            .dtlc-name, .campus-name { font-size: 12px; font-weight: bold; color: #222; margin-top: 2px; }
            .city-name { font-size: 11px; color: #555; margin-top: 1px; }
            .divider { border-top: 2px solid #1b5e20; margin: 8px 0 10px 0; }
            h1 { color: #1b5e20; margin-bottom: 5px; font-size: 22px;}
            p { margin-top: 0; margin-bottom: 20px; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border: 1px solid #bdbdbd; padding: 8px; text-align: left; }
            th { background: #e4e8dc; color: #1b5e20; }
        </style>
    `;

    const rows = (item.entries || []).map(entry => `
        <tr>
            <td>${escapeHtml(entry.code)}</td>
            <td>${escapeHtml(entry.name)}</td>
            <td>${escapeHtml(entry.units)}</td>
            <td>${escapeHtml(entry.day)}</td>
            <td>${escapeHtml(entry.time)}</td>
            <td>${escapeHtml(entry.room)}</td>
        </tr>
    `).join("");

    const html = `<!DOCTYPE html><html><head><title>${escapeHtml(item.name || item.section)}</title>${printStyles}</head><body>
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
        <h1>${escapeHtml(item.name || item.section)}</h1>
        <p>${escapeHtml([item.academicYear ? `A.Y. ${item.academicYear}` : "", item.semester, item.yearLevel].filter(Boolean).join(" • "))}</p>
        <table>
            <thead><tr><th>Subject Code</th><th>Subject Name</th><th>Units</th><th>Day</th><th>Time</th><th>Room</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </body></html>`;

    openPrintWindow(html);
}

async function loadClassArchiveData() {
    try {
        const reports = await loadReportsFromFirestore();
        const classReports = reports.filter(r => r.category !== "Exam Schedule");

        /* Also fetch archived class schedules from classSchedules collection */
        const snapshot = await getDocs(collection(db, "classSchedules"));
        const classSchedules = snapshot.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.status === "archived");

        /* Merge reports and archived class schedules so nothing is missed */
        const merged = [...classReports];

        for (const sched of classSchedules) {
            const exists = merged.some(r =>
                r.id === sched.id ||
                (r.title === sched.name && r.academicYear === sched.academicYear && r.semester === sched.semester)
            );

            if (!exists) {
                merged.push({
                    id: sched.id,
                    title: sched.name || sched.section,
                    section: sched.section,
                    academicYear: sched.academicYear,
                    semester: sched.semester,
                    yearLevel: sched.yearLevel,
                    entries: sched.entries,
                    exportedAt: sched.exportedAt?.toDate?.()?.toISOString?.() || sched.exportedAt || sched.createdAt
                });
            }
        }

        classArchiveRecords = merged;
        // Deduplicate merged records by title + academicYear + semester (keeping newest)
        const dedupedMap = new Map();
        merged.forEach(item => {
            const key = [
                normalise(item.title || item.section || item.name),
                normalise(item.academicYear),
                normalise(item.semester)
            ].join("::");

            const existing = dedupedMap.get(key);
            if (!existing) {
                dedupedMap.set(key, item);
            } else {
                const existingTime = new Date(existing.exportedAt || existing.createdAt || 0).getTime();
                const itemTime = new Date(item.exportedAt || item.createdAt || 0).getTime();
                if (itemTime > existingTime) {
                    dedupedMap.set(key, item);
                }
            }
        });

        classArchiveRecords = Array.from(dedupedMap.values());
        renderClassArchive();
    } catch (error) {
        console.error("Could not load class archive data:", error);
    }
}

/* ------------------------------------------------------------------ */
/*  EXAM SCHEDULE ARCHIVE                                             */
/* ------------------------------------------------------------------ */

function populateExamYearFilter(reports) {
    const yearSelect = document.getElementById("examArchiveAcademicYear");
    if (!yearSelect) return;

    const years = [...new Set(
        reports.map(r => r.academicYear).filter(Boolean)
    )].sort((a, b) => b.localeCompare(a));

    const currentValue = yearSelect.value;
    yearSelect.innerHTML = `<option value="">All Years</option>` +
        years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("");

    if (currentValue && years.includes(currentValue)) {
        yearSelect.value = currentValue;
    }
}

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

    // If no filter is set by user, default to the latest Academic Year in examArchiveReports
    if (!examFilterYear && !examFilterSemester && !examFilterExamType && !examFilterSearch.trim() && examArchiveReports.length > 0) {
        const sortedByLatest = [...examArchiveReports].sort((a, b) => {
            const aTime = a.createdAt || "";
            const bTime = b.createdAt || "";
            return String(bTime).localeCompare(String(aTime));
        });
        const latestAY = sortedByLatest[0]?.academicYear;
        if (latestAY) {
            examFilterYear = latestAY;
            const yearSelect = document.getElementById("examArchiveAcademicYear");
            if (yearSelect) yearSelect.value = latestAY;
        }
    }

    const hasFilter = Boolean(examFilterYear || examFilterSemester || examFilterExamType || examFilterSearch.trim());

    if (!hasFilter) {
        tbody.innerHTML = "";
        emptyNote.textContent = "No archived exam schedules available.";
        emptyNote.hidden = false;
        if (pagination) pagination.style.display = "none";
        return;
    }

    let filtered = [...examArchiveReports];

    if (examFilterYear) {
        filtered = filtered.filter(r => (r.academicYear || "") === examFilterYear);
    }
    if (examFilterSemester) {
        filtered = filtered.filter(r => (r.semester || "") === examFilterSemester);
    }
    if (examFilterExamType) {
        filtered = filtered.filter(r => (r.examType || "") === examFilterExamType);
    }
    if (examFilterSearch) {
        const term = normalise(examFilterSearch);
        filtered = filtered.filter(r =>
            normalise(r.title).includes(term) ||
            normalise(r.filename).includes(term) ||
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
        emptyNote.textContent = "No archived exam schedules matching the selected filter(s).";
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
            <td>${escapeHtml(report.academicYear ? `A.Y. ${report.academicYear}` : "—")}</td>
            <td>${escapeHtml(report.semester || "—")}</td>
            <td>${escapeHtml(report.examType || "—")}</td>
            <td>${escapeHtml(formatDate(report.createdAt))}</td>
            <td>
                <button type="button" class="archive-view-pdf" data-view-exam-id="${escapeHtml(report.id)}">View PDF</button>
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
                    >${page}</button>
                `);
            }
            pageNumbers.innerHTML = pages.join("");
        }
    }
}

function viewExamSchedulePdf(reportId) {
    const report = examArchiveReports.find(r => r.id === reportId);
    if (!report || !report.html) {
        showToast("Could not find the archived exam report document.");
        return;
    }
    openPrintWindow(report.html);
}

async function loadExamArchiveData() {
    try {
        const allReports = await loadReportsFromFirestore();
        const examReports = allReports.filter(r => r.category === "Exam Schedule");

        // Deduplicate exam reports by title/examType + academicYear + semester (keeping newest)
        const dedupedMap = new Map();
        examReports.forEach(item => {
            const key = [
                normalise(item.title || item.filename || "Exam Schedule"),
                normalise(item.examType),
                normalise(item.academicYear),
                normalise(item.semester)
            ].join("::");

            const existing = dedupedMap.get(key);
            if (!existing) {
                dedupedMap.set(key, item);
            } else {
                const existingTime = new Date(existing.createdAt || 0).getTime();
                const itemTime = new Date(item.createdAt || 0).getTime();
                if (itemTime > existingTime) {
                    dedupedMap.set(key, item);
                }
            }
        });

        examArchiveReports = Array.from(dedupedMap.values());
        renderExamArchive();
    } catch (error) {
        console.error("Could not load exam archive data:", error);
    }
}

/* ------------------------------------------------------------------ */
/*  EVENT LISTENERS                                                    */
/* ------------------------------------------------------------------ */

document.getElementById("classArchiveAcademicYear")?.addEventListener("change", event => {
    classFilterYear = event.target.value;
    classCurrentPage = 1;
    renderClassArchive();
});

document.getElementById("classArchiveSemester")?.addEventListener("change", event => {
    classFilterSemester = event.target.value;
    classCurrentPage = 1;
    renderClassArchive();
});

document.getElementById("classArchiveSearch")?.addEventListener("input", event => {
    classFilterSearch = event.target.value;
    classCurrentPage = 1;
    renderClassArchive();
});

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

document.getElementById("deleteAllClassArchiveBtn")?.addEventListener("click", async () => {
    const confirmed = confirm("Are you sure you want to delete all archived class schedules?");
    if (!confirmed) return;

    try {
        await Promise.all([
            deleteReportsByCategoryFromFirestore("Class Schedule"),
            deleteArchivedClassSchedulesFromFirestore()
        ]);

        classFilterYear = "";
        classFilterSemester = "";
        classFilterSearch = "";
        classCurrentPage = 1;

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

document.getElementById("deleteAllExamArchiveBtn")?.addEventListener("click", async () => {
    const confirmed = confirm("Are you sure you want to delete all archived exam schedules?");
    if (!confirmed) return;

    try {
        await deleteReportsByCategoryFromFirestore("Exam Schedule");

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
        showToast("All archived exam schedules have been deleted.");
    } catch (error) {
        console.error("Could not delete all archived exam schedules:", error);
        showToast("Error deleting archived exam schedules.");
    }
});

document.addEventListener("click", event => {
    /* Class Archive view PDF & pagination */
    const classReportId = event.target.dataset?.viewClassId;
    if (classReportId) {
        viewClassSchedulePdf(classReportId);
    }

    if (event.target.id === "classArchivePrevPage") {
        classCurrentPage -= 1;
        renderClassArchive();
    }
    if (event.target.id === "classArchiveNextPage") {
        classCurrentPage += 1;
        renderClassArchive();
    }
    const classPageNum = event.target.dataset?.classPage;
    if (classPageNum) {
        classCurrentPage = Number(classPageNum);
        renderClassArchive();
    }

    /* Exam Archive view PDF & pagination */
    const examReportId = event.target.dataset?.viewExamId;
    if (examReportId) {
        viewExamSchedulePdf(examReportId);
    }

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
});

/* ------------------------------------------------------------------ */
/*  INITIALISATION                                                    */
/* ------------------------------------------------------------------ */

async function init() {
    await Promise.all([
        loadClassArchiveData(),
        loadExamArchiveData()
    ]);
}

init();
