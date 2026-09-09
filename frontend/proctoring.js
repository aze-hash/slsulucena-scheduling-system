import { db, auth } from "../firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    collection,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { parseTimeToMinutes } from "./js/schedule-calendar.js";

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
    const str = String(value ?? "");
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function normalise(str) {
    return String(str || "").trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  Calendar Constants                                                */
/* ------------------------------------------------------------------ */

const CAL_START_MINUTES = 7 * 60;
const CAL_END_MINUTES = 18 * 60;
const CAL_TOTAL_MINUTES = CAL_END_MINUTES - CAL_START_MINUTES;
const HOUR_PX = 48;
const EXAM_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TOTAL_CALENDAR_COLORS = 16;

/* ------------------------------------------------------------------ */
/*  State & Data Loading                                              */
/* ------------------------------------------------------------------ */

let allAssignmentRecords = [];
let searchName = "";
let filterYear = "";
let filterSemester = "";
let filterSection = "";
let filterExamType = "";

const tableCounterBadge = document.getElementById("tableCounterBadge");

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

function resolveFacultyName(schedOrEntry, usersMap) {
    const raw = schedOrEntry.facultyName || schedOrEntry.proctor || schedOrEntry.proctorName ||
                schedOrEntry.assignedFaculty || schedOrEntry.assignedProctor || "";
    const nameFromRaw = extractPersonName(raw);
    if (nameFromRaw) {
        if (usersMap && usersMap.has(nameFromRaw)) {
            return usersMap.get(nameFromRaw);
        }
        return nameFromRaw;
    }

    const id = schedOrEntry.facultyId || schedOrEntry.proctorId || schedOrEntry.assignedFacultyId ||
               schedOrEntry.facultyUID || schedOrEntry.userId || "";
    if (id && usersMap && usersMap.has(String(id).trim())) {
        return usersMap.get(String(id).trim());
    }

    return "";
}

async function loadFacultyAssignmentData() {
    try {
        const emptyNote = document.getElementById("emptyProctoringNote");
        if (emptyNote) {
            emptyNote.hidden = false;
            emptyNote.textContent = "Loading examination proctoring assignments from Firestore...";
        }

        const [usersMap, examSnapshot] = await Promise.all([
            loadFacultyUsersMap(),
            getDocs(collection(db, "examSchedules"))
        ]);

        const records = [];

        examSnapshot.docs.forEach(docSnap => {
            const sched = { id: docSnap.id, ...docSnap.data() };
            if (normalise(sched.status || "") === "archived") return;

            const sectionName = sched.section || sched.sectionName || sched.className || sched.name || "Section Schedule";
            const exams = Array.isArray(sched.exams) ? sched.exams : [];

            if (exams.length > 0) {
                exams.forEach((exam, idx) => {
                    const facName = resolveFacultyName(exam, usersMap) ||
                                    resolveFacultyName(sched, usersMap) ||
                                    "TBA / Unassigned";
                    records.push({
                        id: `exam_${sched.id}_${idx}_${exam.code || exam.subjectCode || Math.random()}`,
                        recordType: "exam",
                        facultyId: exam.proctorId || sched.proctorId || "",
                        facultyName: facName,
                        academicYear: sched.academicYear || "",
                        semester: sched.semester || "",
                        section: sectionName,
                        examType: sched.examType || "Preliminary",
                        subjectCode: exam.code || exam.subjectCode || "—",
                        subjectName: exam.name || exam.subjectName || "—",
                        day: exam.day || "—",
                        time: exam.time || "—",
                        room: exam.room || "—",
                        schedId: sched.id,
                        scheduleDoc: sched
                    });
                });
            } else {
                const facName = resolveFacultyName(sched, usersMap) || "TBA / Unassigned";
                records.push({
                    id: `exam_${sched.id}_general`,
                    recordType: "exam",
                    facultyId: sched.proctorId || "",
                    facultyName: facName,
                    academicYear: sched.academicYear || "",
                    semester: sched.semester || "",
                    section: sectionName,
                    examType: sched.examType || "Preliminary",
                    subjectCode: "All Exams",
                    subjectName: `${sched.examType || "Exam"} Schedule`,
                    day: "—",
                    time: "—",
                    room: "—",
                    schedId: sched.id,
                    scheduleDoc: sched
                });
            }
        });

        allAssignmentRecords = records;
        populateFilters(allAssignmentRecords);
        renderAssignmentsTable();
    } catch (error) {
        console.error("Error loading faculty proctoring data from Firestore:", error);
        allAssignmentRecords = [];
        populateFilters([]);
        renderAssignmentsTable();
        showToast("Error loading faculty proctoring data from Firestore.");
    }
}

function timesOverlap(time1, time2) {
    if (!time1 || !time2) return false;
    const r1 = parseTimeToMinutes(time1);
    const r2 = parseTimeToMinutes(time2);
    if (!r1 || !r2) return false;
    return r1.start < r2.end && r2.start < r1.end;
}

function expandRecordToDiscreteSlots(item) {
    const slots = [];
    const days = String(item.day || "").split(/\s*\/\s*/).map(d => d.trim()).filter(Boolean);
    const times = String(item.time || "").split(/\s*\/\s*/).map(t => t.trim()).filter(Boolean);
    const rooms = String(item.room || "").split(/\s*\/\s*/).map(r => r.trim()).filter(Boolean);
    const maxLen = Math.max(days.length, 1);

    for (let i = 0; i < maxLen; i++) {
        const day = days[i] || days[0] || item.day;
        const time = times[i] || times[0] || item.time;
        const room = rooms[i] || rooms[0] || item.room;
        if (day && day !== "—" && time && time !== "—" && !normalise(time).includes("tba")) {
            slots.push({
                ...item,
                day,
                time,
                room
            });
        }
    }
    return slots;
}

function getFacultyConflictsMap(records) {
    const conflictMap = new Map();
    const groups = new Map();

    records.forEach(r => {
        const fac = normalise(r.facultyName);
        if (!fac || fac.includes("tba") || fac.includes("unassigned")) return;
        const key = `${r.facultyName}___${r.academicYear || ""}___${r.semester || ""}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    });

    groups.forEach((groupRecords, groupKey) => {
        const slots = [];
        groupRecords.forEach(rec => {
            slots.push(...expandRecordToDiscreteSlots(rec));
        });

        const clashes = [];
        const seen = new Set();

        for (let i = 0; i < slots.length; i++) {
            for (let j = i + 1; j < slots.length; j++) {
                const s1 = slots[i];
                const s2 = slots[j];

                if (s1.day && s2.day && s1.day.toLowerCase() === s2.day.toLowerCase()) {
                    if (timesOverlap(s1.time, s2.time)) {
                        const pairKey = [s1.id || s1.subjectCode, s2.id || s2.subjectCode, s1.day, s1.time, s2.time].sort().join("___");
                        if (!seen.has(pairKey)) {
                            seen.add(pairKey);
                            clashes.push({ s1, s2 });
                        }
                    }
                }
            }
        }

        if (clashes.length > 0) {
            conflictMap.set(groupKey, clashes);
        }
    });

    return conflictMap;
}

/* ------------------------------------------------------------------ */
/*  Calendar Rendering Helpers                                        */
/* ------------------------------------------------------------------ */

function minutesToDisplay(totalMinutes) {
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

function buildSubjectColorMap(entries) {
    const map = new Map();
    let colorIndex = 1;

    for (const entry of entries) {
        const key = String(entry.subjectCode || entry.code || entry.subjectName || entry.name || "").trim().toUpperCase();
        if (!key) continue;
        if (!map.has(key)) {
            map.set(key, `cal-block-color-${colorIndex}`);
            colorIndex = (colorIndex % TOTAL_CALENDAR_COLORS) + 1;
        }
    }
    return map;
}

function groupOverlaps(blocks) {
    const sorted = [...blocks].sort((a, b) => a.start - b.start);
    const clusters = [];
    let current = [];

    for (const block of sorted) {
        if (!current.length) {
            current.push(block);
        } else {
            const maxEnd = Math.max(...current.map(b => b.end));
            if (block.start < maxEnd) {
                current.push(block);
            } else {
                clusters.push(current);
                current = [block];
            }
        }
    }
    if (current.length) clusters.push(current);
    return clusters;
}

function buildCalendarDayBlocks(entries, day, subjectColorMap) {
    const dayBlocks = [];

    for (const entry of entries) {
        const rawDays = String(entry.day || "").split(/\s*\/\s*/);
        const rawTimes = String(entry.time || "").split(/\s*\/\s*/);
        const rawRooms = String(entry.room || "").split(/\s*\/\s*/);

        rawDays.forEach((d, i) => {
            const dt = d.trim().toLowerCase();
            const dayLower = day.toLowerCase();
            const matchesDay = dt === dayLower ||
                               (dt.length >= 3 && dayLower.startsWith(dt)) ||
                               (dayLower.length >= 3 && dt.startsWith(dayLower.slice(0, 3)));
            if (!matchesDay) return;

            const rawTime = (rawTimes[i] || rawTimes[0] || "").trim();
            const room = (rawRooms[i] || rawRooms[0] || "").trim();
            const parsed = parseTimeToMinutes(rawTime);
            if (!parsed) return;

            dayBlocks.push({
                start: parsed.start,
                end: parsed.end,
                code: entry.subjectCode || entry.code || "",
                name: entry.subjectName || entry.name || "",
                time: rawTime,
                room,
                section: entry.section || "",
                examType: entry.examType || ""
            });
        });
    }

    if (!dayBlocks.length) return "";

    const clusters = groupOverlaps(dayBlocks);
    let html = "";

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd = Math.min(block.end, CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;

            const top = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 20);
            const widthPct = 100 / colCount;
            const leftPct = widthPct * colIndex;

            const displayTime = `${minutesToDisplay(block.start)} – ${minutesToDisplay(block.end)}`;
            const subjectKey = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass = subjectColorMap.get(subjectKey) || `cal-block-color-${((colIndex) % TOTAL_CALENDAR_COLORS) + 1}`;

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 3px);left:calc(${leftPct.toFixed(1)}% + 1.5px);" title="${escapeHtml(block.code)} — ${escapeHtml(block.name)}&#10;${escapeHtml(block.examType)} | ${escapeHtml(block.section)} | ${escapeHtml(block.room)}">
  <div class="cal-block-code">${escapeHtml(block.code)}</div>
  <div class="cal-block-name">${escapeHtml(block.name)}</div>
  <div class="cal-block-time">${escapeHtml(displayTime)}</div>
  <div class="cal-block-room">${escapeHtml(block.room)}</div>
</div>`;
        });
    }

    return html;
}

function buildHourLines() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-hour-line" style="top:${top}px"></div>`;
    }
    return html;
}

function buildTimeLabels() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-time-label" style="top:${top}px">${minutesToDisplay(mins)}</div>`;
    }
    return html;
}

/* ------------------------------------------------------------------ */
/*  Render Calendar Card Layout                                       */
/* ------------------------------------------------------------------ */

function renderFacultyCalendarCard(facultyName, records, conflictsMap) {
    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
    const subjectColorMap = buildSubjectColorMap(records);

    // Calculate summary stats
    const totalAssignments = records.length;
    const prelimCount = records.filter(r => normalise(r.examType).includes("prelim")).length;
    const midtermCount = records.filter(r => normalise(r.examType).includes("midterm")).length;
    const finalCount = records.filter(r => normalise(r.examType).includes("final")).length;
    const assignedDays = new Set(records.map(r => r.day).filter(d => d && d !== "—")).size;

    // Get AY and Semester info
    const academicYear = records[0]?.academicYear || "";
    const semester = records[0]?.semester || "";

    // Check for conflicts
    const key = `${facultyName}___${academicYear}___${semester}`;
    const clashes = conflictsMap.get(key) || [];
    const hasClash = clashes.length > 0;

    // Build day columns
    const dayColumnsHtml = EXAM_DAYS.map(day => {
        const blocks = buildCalendarDayBlocks(records, day, subjectColorMap);
        return `
<div class="cal-day-col">
  <div class="cal-day-header"><span class="cal-day-name">${escapeHtml(day)}</span></div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks}
  </div>
</div>`;
    }).join("");

    // Build legend showing each subject
    const legendItems = records.slice(0, 8).map(r => {
        const subjectKey = String(r.subjectCode || r.subjectName || "").trim().toUpperCase();
        const colorClass = subjectColorMap.get(subjectKey) || "cal-block-color-1";
        return `<span class="cal-color-dot ${colorClass}" style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle;"></span>${escapeHtml(r.subjectCode)}`;
    }).join(", ");

    const conflictBanner = hasClash ? `
<div style="margin-bottom:12px; padding:10px 14px; background:#ffebee; border:1px solid #ef5350; border-radius:8px; font-size:12px; color:#b71c1c; font-weight:600;">
  ⚠️ Schedule Conflict Detected: ${clashes.length} overlapping assignment${clashes.length > 1 ? 's' : ''}
</div>` : "";

    return `
<div class="faculty-calendar-card" style="background:#fff; border:1px solid #d9d2c5; border-radius:14px; padding:20px; margin-bottom:20px; box-shadow:0 4px 15px rgba(0,0,0,0.05);">
  <!-- Card Header -->
  <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:16px; padding-bottom:14px; border-bottom:2px solid #e8f5e9;">
    <div>
      <div style="font-size:18px; font-weight:bold; color:#1b5e20; margin-bottom:4px;">
        ${escapeHtml(facultyName)}
      </div>
      <div style="font-size:12px; color:#666; margin-bottom:6px;">Faculty / Proctor</div>
      <div style="font-size:13px; color:#444;">
        ${academicYear ? `A.Y. ${escapeHtml(academicYear)}` : ""}${academicYear && semester ? " • " : ""}${semester ? escapeHtml(semester) : ""}
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:11px; color:#666; text-transform:uppercase; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Total Exams</div>
      <div style="font-size:24px; font-weight:bold; color:#1b5e20;">${totalAssignments}</div>
      <div style="font-size:11px; color:#666; margin-top:2px;">${assignedDays} day${assignedDays !== 1 ? 's' : ''}</div>
    </div>
  </div>

  ${conflictBanner}

  <!-- Summary Legend -->
  <div style="display:flex; flex-wrap:wrap; gap:16px; margin-bottom:14px; padding:10px 14px; background:#f8fafc; border-radius:8px; font-size:12px;">
    <div><strong style="color:#1b5e20;">${totalAssignments}</strong> Assignments</div>
    ${prelimCount > 0 ? `<div style="color:#e65100;">${prelimCount} Preliminary</div>` : ""}
    ${midtermCount > 0 ? `<div style="color:#1565c0;">${midtermCount} Midterm</div>` : ""}
    ${finalCount > 0 ? `<div style="color:#c2185b;">${finalCount} Final</div>` : ""}
  </div>

  <!-- Calendar Grid -->
  <div class="cal-timetable-wrapper">
    <div class="cal-timetable">
      <div class="cal-time-col">
        <div class="cal-time-header"></div>
        <div class="cal-time-body" style="height:${calendarHeight}px">
          ${buildTimeLabels()}
        </div>
      </div>
      ${dayColumnsHtml}
    </div>
  </div>

  <!-- Subject Legend -->
  ${legendItems ? `<div style="margin-top:12px; font-size:11px; color:#666; display:flex; flex-wrap:wrap; gap:8px; align-items:center;"><strong style="margin-right:4px;">Subjects:</strong> ${legendItems}</div>` : ""}
</div>`;
}

/* ------------------------------------------------------------------ */
/*  PDF Viewing / Print Generator                                     */
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
        .section-row { background-color: #2e7d32; color: #ffffff; text-align: center; font-size: 13px; font-weight: bold; padding: 7px 10px; margin-bottom: 12px; border-radius: 4px; }
        .schedule-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
        .schedule-table th, .schedule-table td { border: 1px solid #888; padding: 6px 8px; text-align: left; }
        .schedule-table th { background: #a5d6a7; color: #1b5e20; font-weight: bold; text-align: center; }
        .schedule-table td { vertical-align: middle; }
        .schedule-table tbody tr:nth-child(even) { background: #f1f8e9; }
        .summary-box { margin-top: 14px; padding: 8px 12px; background: #f9f9f9; border: 1px solid #ccc; font-size: 12px; display: flex; justify-content: space-between; }
        .signatures-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; }
        .sig-block { text-align: center; font-size: 11px; }
        .sig-line { border-bottom: 1px solid #333; height: 32px; margin-bottom: 6px; }
        .sig-name { font-weight: bold; font-size: 12px; }
        .sig-title { color: #555; }
        .page { break-after: page; page-break-after: always; }
        .page:last-child { break-after: auto; page-break-after: auto; }
    </style>
`;

function openExamProctoringPdf(item) {
    const record = item.scheduleDoc;
    if (!record) {
        showToast("Exam schedule record not found.");
        return;
    }

    const logoUrl = new URL('new slsu logo.jpg', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    const examType = record.examType || item.examType || "Preliminary";
    const examTypeUpper = examType.toUpperCase();
    const sectionName = escapeHtml(record.section || item.section || "");
    const proctorName = escapeHtml(item.facultyName || record.proctor || "");
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
                <td style="font-weight:600;">${escapeHtml(exam.proctor || proctorName || "-")}</td>
                <td>${escapeHtml(exam.room || "-")}</td>
            </tr>`;
        }

        dayTablesHtml += `
            <div style="margin-bottom:12px;">
                <div style="font-size:12px; font-weight:bold; color:#1b5e20; padding:4px 8px; background:#e8f5e9; border-bottom:2px solid #2e7d32;">${escapeHtml(dayLabel)}</div>
                <table class="schedule-table">
                    <thead>
                        <tr>
                            <th style="width:22%;">TIME</th>
                            <th style="width:38%;">SUBJECT</th>
                            <th style="width:22%;">PROCTOR</th>
                            <th style="width:18%;">ROOM</th>
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
            <table class="schedule-table">
                <thead>
                    <tr>
                        <th style="width:22%;">TIME</th>
                        <th style="width:38%;">SUBJECT</th>
                        <th style="width:22%;">PROCTOR</th>
                        <th style="width:18%;">ROOM</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>${escapeHtml(item.time)}</td>
                        <td>${escapeHtml(item.subjectCode)} — ${escapeHtml(item.subjectName)}</td>
                        <td>${proctorName}</td>
                        <td>${escapeHtml(item.room)}</td>
                    </tr>
                </tbody>
            </table>
        `;
    }

    const docTitle = [
        item.academicYear ? `A.Y. ${item.academicYear}` : "",
        item.semester || "",
        item.section || "",
        `${examType} Exam Proctoring Schedule`
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
            <div class="title-section">SCHEDULES OF ${escapeHtml(examTypeUpper)} EXAMINATIONS & PROCTORING</div>
            <div class="section-row">Section: ${sectionName} &nbsp;|&nbsp; Assigned Proctor: ${proctorName}</div>
            ${dayTablesHtml}
            <div class="signatures-grid">
                <div class="sig-block">
                    <div class="sig-line"></div>
                    <div class="sig-name">${proctorName}</div>
                    <div class="sig-title">Assigned Examination Proctor</div>
                </div>
                <div class="sig-block">
                    <div class="sig-line"></div>
                    <div class="sig-name">Department Chairperson</div>
                    <div class="sig-title">Lucena Campus</div>
                </div>
            </div>
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
/*  Render Calendar Cards                                             */
/* ------------------------------------------------------------------ */

function renderAssignmentsTable() {
    const tbody = document.getElementById("proctoringTableBody");
    const thead = document.getElementById("proctoringTableHead");
    const emptyNote = document.getElementById("emptyProctoringNote");

    if (!emptyNote) return;

    let filtered = [...allAssignmentRecords];

    // Filter by search query (faculty name, subject code, subject name, section)
    if (searchName) {
        const term = normalise(searchName);
        filtered = filtered.filter(r =>
            normalise(r.facultyName).includes(term) ||
            normalise(r.subjectCode).includes(term) ||
            normalise(r.subjectName).includes(term) ||
            normalise(r.section).includes(term)
        );
    }

    // Filter by Academic Year
    if (filterYear) {
        filtered = filtered.filter(r => (r.academicYear || "") === filterYear);
    }

    // Filter by Semester
    if (filterSemester) {
        filtered = filtered.filter(r => (r.semester || "") === filterSemester);
    }

    // Filter by Section
    if (filterSection) {
        filtered = filtered.filter(r => (r.section || "") === filterSection);
    }

    // Sort by faculty name
    filtered.sort((a, b) => a.facultyName.localeCompare(b.facultyName));

    const conflictsMap = getFacultyConflictsMap(allAssignmentRecords);

    // Filter by Exam Type (tolerant of "Prelim" / "preliminary" variants)
    if (filterExamType) {
        const term = normalise(filterExamType);
        const keyword = term.includes("prelim") ? "prelim"
            : term.includes("midterm") ? "midterm"
            : term.includes("final") ? "final"
            : term;
        filtered = filtered.filter(r => normalise(r.examType || "").includes(keyword));
    }

    if (tableCounterBadge) {
        const uniqueFaculty = new Set(filtered.map(r => r.facultyName)).size;
        tableCounterBadge.textContent = `Showing ${uniqueFaculty} faculty member${uniqueFaculty !== 1 ? 's' : ''} (${filtered.length} assignment${filtered.length !== 1 ? 's' : ''})`;
    }

    if (!filtered.length) {
        if (tbody) tbody.innerHTML = "";
        emptyNote.hidden = false;
        emptyNote.textContent = allAssignmentRecords.length === 0
            ? "No faculty exam proctoring assignments found."
            : "No exam proctoring assignments match the selected filters.";
        return;
    }

    emptyNote.hidden = true;

    // Group records by faculty member + academic year + semester
    const facultyGroups = new Map();
    filtered.forEach(item => {
        const groupKey = `${item.facultyName}___${item.academicYear || ""}___${item.semester || ""}`;
        if (!facultyGroups.has(groupKey)) {
            facultyGroups.set(groupKey, []);
        }
        facultyGroups.get(groupKey).push(item);
    });

    // Render a calendar card for each faculty member
    let cardsHtml = "";
    facultyGroups.forEach((records, groupKey) => {
        const facultyName = records[0].facultyName;
        cardsHtml += renderFacultyCalendarCard(facultyName, records, conflictsMap);
    });

    // Render calendar cards (reuse the container created on the first render so
    // the filters / search keep working after the table was replaced by cards)
    const existingContainer = document.getElementById("facultyCalendarContainer");
    if (existingContainer) {
        existingContainer.innerHTML = cardsHtml;
    } else {
        const tableWrapper = tbody ? tbody.closest(".table-container") : null;
        if (tableWrapper) {
            const calendarContainer = document.createElement("div");
            calendarContainer.id = "facultyCalendarContainer";
            calendarContainer.innerHTML = cardsHtml;
            tableWrapper.parentNode.replaceChild(calendarContainer, tableWrapper);
        }
    }

    // Also update the table head to be hidden
    if (thead) {
        thead.innerHTML = "";
    }
}

/* ------------------------------------------------------------------ */
/*  Event Listeners & Init                                            */
/* ------------------------------------------------------------------ */

document.getElementById("proctorSearchName")?.addEventListener("input", event => {
    searchName = event.target.value;
    renderAssignmentsTable();
});

document.getElementById("proctorAcademicYear")?.addEventListener("change", event => {
    filterYear = event.target.value;
    renderAssignmentsTable();
});

document.getElementById("proctorSemester")?.addEventListener("change", event => {
    filterSemester = event.target.value;
    renderAssignmentsTable();
});

document.getElementById("proctorSection")?.addEventListener("change", event => {
    filterSection = event.target.value;
    renderAssignmentsTable();
});

document.getElementById("proctorExamTypeFilter")?.addEventListener("change", event => {
    filterExamType = event.target.value;
    renderAssignmentsTable();
});

document.addEventListener("click", event => {
    const generalPdfBtn = event.target.closest?.(".view-assignment-pdf-btn");
    if (generalPdfBtn) {
        const recordId = generalPdfBtn.dataset.recordId;
        const item = allAssignmentRecords.find(r => r.id === recordId);
        if (!item) {
            showToast("Assignment record not found.");
            return;
        }
        openExamProctoringPdf(item);
    }
});

loadFacultyAssignmentData();

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