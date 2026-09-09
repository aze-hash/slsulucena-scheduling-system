/* ==========================================================================
   ROOM ASSIGNMENT DASHBOARD
   Read-only monitoring page. Reads existing Firestore data only:
     - `rooms` collection -> lecture-room tabs (roomName, roomType)
     - `examSchedules` collection -> generated exam entries
   Never writes, duplicates, or modifies schedules.
   ========================================================================== */

import { db, auth } from "../firebase.js";
import { parseTimeToMinutes } from "./js/schedule-calendar.js";

import {
    collection,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

/* ---------------- Constants ---------------- */

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/* Time-grid constants — identical to the Faculty Assignment calendar
   (proctoring.js / schedule-calendar.js) so both pages share the same
   hourly structure, proportions and positioning behaviour. */
const CAL_START_MINUTES = 7 * 60;   // 7:00 AM
const CAL_END_MINUTES = 18 * 60;    // 6:00 PM
const CAL_TOTAL_MINUTES = CAL_END_MINUTES - CAL_START_MINUTES;
const HOUR_PX = 64;                 // pixel height per hour
const TOTAL_CALENDAR_COLORS = 16;
/* Height (px) the exam card grows to while hovered. Cards that sit too low
   in a day column are expanded upward instead (see --ra-grow / ra-expand-up)
   so the expanded card is never clipped by the calendar scroll container. */
const EXPANDED_CARD_MIN_HEIGHT = 170;

/* ---------------- State ---------------- */

let lectureRooms = [];
let allSchedules = [];
let allExamEntries = [];
let selectedRoom = "";

const filters = { academicYear: "", semester: "", examType: "", program: "", section: "", room: "" };

/* ---------------- DOM ---------------- */

const $ = id => document.getElementById(id);
const tabsEl = () => $("raRoomTabs");
const counterEl = () => $("raRoomCounter");
const calendarEl = () => $("raCalendar");
const emptyEl = () => $("raEmpty");
const summaryEl = () => $("raRoomSummary");
const conflictBannerEl = () => $("raConflictBanner");
const calendarTitleEl = () => $("raCalendarTitle");
const calendarSubtitleEl = () => $("raCalendarSubtitle");
const aySelect = () => $("raAcademicYear");
const semSelect = () => $("raSemester");
const examTypeSelect = () => $("raExamType");
const programSelect = () => $("raProgram");
const sectionSelect = () => $("raSection");
const roomSelect = () => $("raRoom");

/* ---------------- Helpers ---------------- */

function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
}

function normalise(value) {
    return String(value ?? "").trim().toLowerCase();
}

function normaliseRoom(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseTime(val) {
    if (val === null || val === undefined) return NaN;
    const parts = String(val).trim().split(":").map(Number);
    if (!parts.length || Number.isNaN(parts[0])) return NaN;
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;
    if (hour >= 1 && hour <= 6) hour += 12; // 1-6 are PM (matches exam.js)
    return hour * 60 + minute;
}

function minutesToDisplay(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) return "";
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatTimeDisplay(slot) {
    if (!slot) return "—";
    const raw = String(slot).trim();
    if (raw.toUpperCase() === "TBA" || !raw.includes("-")) return escapeHtml(raw);
    const parts = raw.split("-").map(p => p.trim());
    const sMin = parseTime(parts[0]);
    const eMin = parseTime(parts[1]);
    if (Number.isNaN(sMin) || Number.isNaN(eMin)) return escapeHtml(raw);
    return `${minutesToDisplay(sMin)} – ${minutesToDisplay(eMin)}`;
}

function getDayName(dateStr) {
    if (!dateStr) return "";
    const d = new Date(`${dateStr}T00:00:00`);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { weekday: "long" });
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return "—";
    if (String(dateStr).toUpperCase() === "TBA") return "TBA";
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatExamType(examType) {
    const t = String(examType || "").trim();
    if (!t) return "—";
    if (/prelim/i.test(t)) return "Preliminary Examination";
    if (/midterm|mid-term/i.test(t)) return "Midterm Examination";
    if (/final/i.test(t)) return "Final Examination";
    return t;
}

function normaliseSemester(value) {
    const s = String(value || "").trim().toLowerCase();
    if (!s) return "";
    if (s === "1" || s.includes("1st") || s.includes("first")) return "1st Semester";
    if (s === "2" || s.includes("2nd") || s.includes("second")) return "2nd Semester";
    return String(value).trim();
}

function showToast(message) {
    const toast = $("customToast");
    const msgEl = $("customToastMessage");
    if (!toast || !msgEl) { alert(message); return; }
    msgEl.textContent = message;
    toast.style.display = "flex";
}

function naturalRoomSort(a, b) {
    return String(a.roomName || "").localeCompare(String(b.roomName || ""), "en", { numeric: true, sensitivity: "base" });
}

/* ---------------- Data loading (read-only) ---------------- */

async function loadLectureRooms() {
    const snap = await getDocs(collection(db, "rooms"));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Only "Lecture Room". Exclude laboratories of any kind + Gymnasium.
    const filtered = all
        .filter(r => {
            const type = normalise(r.roomType);
            if (!type) return false;
            if (type === "lecture room") return true;
            if (type.includes("lab")) return false;
            if (type.includes("gym")) return false;
            return false;
        })
        .filter(r => String(r.roomName || r.roomCode || "").trim() !== "")
        .map(r => ({
            id: r.id,
            roomName: String(r.roomName || r.roomCode).trim(),
            roomCode: r.roomCode || "",
            roomType: r.roomType || "",
            building: r.building || ""
        }))
        .sort(naturalRoomSort);
    const seen = new Set();
    lectureRooms = filtered.filter(r => {
        const key = normaliseRoom(r.roomName);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function loadExamSchedules() {
    const snap = await getDocs(collection(db, "examSchedules"));
    allSchedules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    allExamEntries = [];
    allSchedules.forEach(sched => {
        const exams = Array.isArray(sched.exams) ? sched.exams : [];
        exams.forEach((exam, idx) => {
            const date = String(exam.date || "").trim();
            let day = String(exam.day || "").trim();
            if (!day && date && date.toUpperCase() !== "TBA") day = getDayName(date);
            allExamEntries.push({
                scheduleId: sched.id,
                academicYear: String(sched.academicYear || "").trim(),
                semester: String(sched.semester || "").trim(),
                semesterNorm: normaliseSemester(sched.semester),
                program: String(sched.program || "").trim(),
                section: String(sched.section || "").trim(),
                examType: String(exam.examType || sched.examType || "Preliminary").trim(),
                code: String(exam.code || exam.subjectCode || "").trim(),
                name: String(exam.name || exam.subjectName || "").trim(),
                date,
                day,
                time: String(exam.time || "").trim(),
                room: String(exam.room || "").trim(),
                proctor: String(exam.proctor || sched.proctor || "").trim(),
                _idx: idx
            });
        });
    });
}
/* ---------------- Filters ---------------- */

function populateFilterOptions() {
    const years = [...new Set(allSchedules.map(s => String(s.academicYear || "").trim()).filter(Boolean))]
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    const programs = [...new Set(allSchedules.map(s => String(s.program || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const sections = [...new Set(allSchedules.map(s => String(s.section || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const ay = aySelect();
    if (ay) {
        const cur = ay.value;
        ay.innerHTML = `<option value="">All Academic Years</option>` +
            years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
        if (cur && years.includes(cur)) ay.value = cur;
    }
    const pr = programSelect();
    if (pr) {
        const cur = pr.value;
        pr.innerHTML = `<option value="">All Programs</option>` +
            programs.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
        if (cur && programs.includes(cur)) pr.value = cur;
    }
    const sc = sectionSelect();
    if (sc) {
        const cur = sc.value;
        sc.innerHTML = `<option value="">All Sections</option>` +
            sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
        if (cur && sections.includes(cur)) sc.value = cur;
    }
    const rm = roomSelect();
    if (rm) {
        const cur = rm.value || selectedRoom;
        rm.innerHTML = `<option value="">Select Room</option>` +
            lectureRooms.map(r => `<option value="${escapeHtml(r.roomName)}">${escapeHtml(r.roomName)}</option>`).join("");
        if (cur && lectureRooms.some(r => r.roomName === cur)) rm.value = cur;
    }
}

function readFiltersFromUI() {
    filters.academicYear = aySelect() ? aySelect().value : "";
    filters.semester = semSelect() ? semSelect().value : "";
    filters.examType = examTypeSelect() ? examTypeSelect().value : "";
    filters.program = programSelect() ? programSelect().value : "";
    filters.section = sectionSelect() ? sectionSelect().value : "";
    filters.room = roomSelect() ? roomSelect().value : "";
    if (filters.room) selectedRoom = filters.room;
}

function entryMatchesFilters(entry) {
    if (filters.academicYear && entry.academicYear !== filters.academicYear) return false;
    if (filters.semester && entry.semesterNorm !== filters.semester) return false;
    if (filters.examType && !normalise(entry.examType).includes(normalise(filters.examType))) return false;
    if (filters.program && entry.program !== filters.program) return false;
    if (filters.section && entry.section !== filters.section) return false;
    return true;
}

/* ---------------- Room tabs (dynamic roomName) ---------------- */

function countExamsForRoom(roomName) {
    const key = normaliseRoom(roomName);
    return allExamEntries.filter(e =>
        normaliseRoom(e.room) === key &&
        String(e.time || "").toUpperCase() !== "TBA" &&
        entryMatchesFilters(e)
    ).length;
}

function renderRoomTabs() {
    const tabs = tabsEl();
    if (!tabs) return;
    tabs.innerHTML = "";
    const counter = counterEl();
    if (!lectureRooms.length) {
        tabs.innerHTML = `<p class="ra-muted">No lecture rooms found.</p>`;
        if (counter) counter.textContent = "0 rooms";
        return;
    }
    if (counter) counter.textContent = `${lectureRooms.length} rooms`;
    if (!lectureRooms.some(r => r.roomName === selectedRoom)) {
        selectedRoom = lectureRooms[0].roomName;
        const rm = roomSelect();
        if (rm) rm.value = selectedRoom;
        filters.room = selectedRoom;
    }
    lectureRooms.forEach(room => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ra-room-tab" + (room.roomName === selectedRoom ? " active" : "");
        btn.dataset.room = room.roomName;
        const label = document.createElement("span");
        label.textContent = room.roomName;
        const badge = document.createElement("span");
        badge.className = "ra-tab-count";
        badge.textContent = countExamsForRoom(room.roomName);
        btn.appendChild(label);
        btn.appendChild(badge);
        btn.addEventListener("click", () => {
            selectedRoom = room.roomName;
            filters.room = room.roomName;
            const rm = roomSelect();
            if (rm) rm.value = room.roomName;
            renderRoomTabs();
            renderCalendar();
        });
        tabs.appendChild(btn);
    });
}

function examsForSelectedRoom() {
    const key = normaliseRoom(selectedRoom);
    return allExamEntries.filter(e =>
        normaliseRoom(e.room) === key &&
        String(e.time || "").toUpperCase() !== "TBA" &&
        String(e.date || "").toUpperCase() !== "TBA" &&
        entryMatchesFilters(e)
    );
}

function conflictGroupKey(exam) {
    return `${String(exam.date || "").trim()}___${normalise(exam.time).replace(/\s+/g, "")}`;
}

function detectConflicts(exams) {
    const groups = new Map();
    exams.forEach(exam => {
        const gkey = conflictGroupKey(exam);
        if (!groups.has(gkey)) groups.set(gkey, []);
        groups.get(gkey).push(exam);
    });
    const conflictKeys = new Set();
    const conflictList = [];
    groups.forEach((group, gkey) => {
        const unique = new Set(group.map(e => `${e.scheduleId}::${e.code}::${e.section}::${e._idx}`));
        if (group.length > 1 && unique.size > 1) {
            conflictKeys.add(gkey);
            conflictList.push({ key: gkey, date: group[0].date, time: group[0].time, exams: group });
        }
    });
    return { conflictKeys, conflictList };
}

/* ---------------- Time-grid calendar helpers ----------------
   Same structure/behaviour as the Faculty Assignment calendar
   (proctoring.js): vertical time axis, hourly grid lines and
   exam blocks positioned by their actual start/end times. */

function buildSubjectColorMap(entries) {
    const map = new Map();
    let colorIndex = 1;
    for (const entry of entries) {
        const key = String(entry.code || entry.name || "").trim().toUpperCase();
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
        html += `<div class="cal-time-label" style="top:${top}px">${escapeHtml(minutesToDisplay(mins))}</div>`;
    }
    return html;
}

/**
 * Build the absolutely-positioned exam blocks for one weekday column.
 * Blocks are placed by their real start/end minutes (e.g. 7:30-10:00 spans
 * the correct portion of the hourly grid); overlapping exams are laid out
 * side-by-side exactly like the Faculty Assignment calendar.
 */
function buildDayBlocks(exams, day, colorMap, conflictKeys) {
    const dayBlocks = [];
    exams.forEach(exam => {
        if (String(exam.day || "").trim() !== day) return;
        const parsed = parseTimeToMinutes(exam.time);
        if (!parsed) return;
        dayBlocks.push({ ...exam, start: parsed.start, end: parsed.end });
    });

    if (!dayBlocks.length) return { html: "", count: 0 };

    dayBlocks.sort((a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        a.start - b.start ||
        String(a.section).localeCompare(String(b.section))
    );

    const clusters = groupOverlaps(dayBlocks);
    let html = "";
    let count = 0;

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd = Math.min(block.end, CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;
            count++;

            const top = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct = 100 / colCount;
            const leftPct = widthPct * colIndex;

            const isConflict = conflictKeys.has(conflictGroupKey(block));
            const subjectKey = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass = colorMap.get(subjectKey) || `cal-block-color-${(colIndex % TOTAL_CALENDAR_COLORS) + 1}`;

            const dateLabel = escapeHtml(formatDateDisplay(block.date));
            const dayLabel = block.day ? ` - ${escapeHtml(block.day)}` : "";
            const proctorLabel = escapeHtml(block.proctor || "TBA");

            /* Hover expansion: cards too close to the bottom of the day column
               grow upward (--ra-grow + ra-expand-up) so the expanded card is
               never clipped by the calendar scroll container. */
            const calendarHeightPx = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
            const growDelta = Math.max(EXPANDED_CARD_MIN_HEIGHT - height, 0);
            const expandUp = growDelta > 0 && (top + EXPANDED_CARD_MIN_HEIGHT > calendarHeightPx) && top >= growDelta;

            html += `
<div class="cal-block${isConflict ? " ra-conflict-card" : ""}${expandUp ? " ra-expand-up" : ""} ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);--ra-grow:${growDelta.toFixed(1)}px;" title="${escapeHtml(block.code)} — ${escapeHtml(block.name)}&#10;${escapeHtml(formatExamType(block.examType))} | ${escapeHtml(block.section)} | ${escapeHtml(formatDateDisplay(block.date))} | ${formatTimeDisplay(block.time)} | Room: ${escapeHtml(block.room)} | Proctor: ${proctorLabel}">
  ${isConflict ? `<span class="ra-conflict-chip">Room conflict</span>` : ""}
  <div class="ra-card-section">${escapeHtml(block.section || "—")}</div>
  <div class="ra-card-subject">${escapeHtml(block.name || block.code || "—")}${block.code ? ` <span class="ra-card-code">(${escapeHtml(block.code)})</span>` : ""}</div>
  <span class="ra-examtype-badge">${escapeHtml(formatExamType(block.examType))}</span>
  <div class="ra-card-meta">
    <div><span class="ra-meta-label">Date:</span><span>${dateLabel}${dayLabel}</span></div>
    <div><span class="ra-meta-label">Time:</span><span>${formatTimeDisplay(block.time)}</span></div>
    <div><span class="ra-meta-label">Room:</span><span>${escapeHtml(block.room)}</span></div>
    <div><span class="ra-meta-label">Proctor:</span><span>${proctorLabel}</span></div>
  </div>
</div>`;
        });
    }

    return { html, count };
}

function renderCalendar() {
    const cal = calendarEl();
    if (!cal) return;
    readFiltersFromUI();
    const summary = summaryEl();
    const banner = conflictBannerEl();
    const title = calendarTitleEl();
    const subtitle = calendarSubtitleEl();
    if (!lectureRooms.length) {
        cal.innerHTML = `<p class="ra-empty">No lecture rooms available.</p>`;
        if (summary) summary.innerHTML = "";
        if (banner) banner.style.display = "none";
        if (title) title.textContent = "Weekly Examination Room Usage";
        return;
    }
    const exams = examsForSelectedRoom();
    const found = detectConflicts(exams);
    if (title) title.textContent = `Weekly Examination Room Usage — ${selectedRoom}`;
    if (subtitle) {
        const parts = [];
        if (filters.academicYear) parts.push(`A.Y. ${filters.academicYear}`);
        if (filters.semester) parts.push(filters.semester);
        if (filters.examType) parts.push(formatExamType(filters.examType));
        if (filters.program) parts.push(filters.program);
        if (filters.section) parts.push(filters.section);
        subtitle.textContent = parts.length
            ? `Monitoring room assignment - ${parts.join(" - ")}`
            : "Monitoring room assignment for the selected lecture room.";
    }
    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
    const colorMap = buildSubjectColorMap(exams);
    let placedCount = 0;

    const dayColumnsHtml = WEEKDAYS.map(day => {
        const blocks = buildDayBlocks(exams, day, colorMap, found.conflictKeys);
        placedCount += blocks.count;
        return `
<div class="cal-day-col">
  <div class="cal-day-header"><span class="cal-day-name">${escapeHtml(day)}</span></div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks.html}
  </div>
</div>`;
    }).join("");

    cal.innerHTML = `
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
</div>`;
    const empty = emptyEl();
    if (empty) empty.style.display = "none";
    const outOfGrid = exams.filter(e => !WEEKDAYS.includes(String(e.day || "").trim())).length;
    if (summary) {
        summary.innerHTML =
            `<span class="ra-summary-chip ra-chip-total"><b>${exams.length}</b>&nbsp;exams</span>` +
            `<span class="ra-summary-chip ra-chip-occupied"><b>${placedCount}</b>&nbsp;occupied</span>` +
            `<span class="ra-summary-chip ra-chip-conflict"><b>${found.conflictList.length}</b>&nbsp;conflicts</span>` +
            (outOfGrid ? `<span class="ra-summary-chip"><b>${outOfGrid}</b>&nbsp;outside Mon-Fri</span>` : "");
    }
    if (banner) {
        if (found.conflictList.length) {
            let items = "";
            found.conflictList.slice(0, 8).forEach(c => {
                const sections = [...new Set(c.exams.map(e => e.section))].map(escapeHtml).join(", ");
                const codes = [...new Set(c.exams.map(e => e.code))].map(escapeHtml).join(", ");
                items += `<li><strong>${escapeHtml(formatDateDisplay(c.date))}</strong> at <strong>${formatTimeDisplay(c.time)}</strong> — ${sections} (${codes})</li>`;
            });
            if (found.conflictList.length > 8) items += `<li>...and ${found.conflictList.length - 8} more.</li>`;
            banner.innerHTML = `<span class="ra-cb-icon">!</span><div><div class="ra-cb-title">Room conflict in ${escapeHtml(selectedRoom)} — resolve on Exam Schedule page.</div><ul class="ra-cb-list">${items}</ul></div>`;
            banner.style.display = "flex";
        } else {
            banner.style.display = "none";
            banner.innerHTML = "";
        }
    }
    const tabs = tabsEl();
    if (tabs) {
        tabs.querySelectorAll(".ra-room-tab").forEach(btn => {
            const badge = btn.querySelector(".ra-tab-count");
            if (badge) badge.textContent = countExamsForRoom(btn.dataset.room);
        });
    }
}

/* ---------------- Events + init ---------------- */

function bindFilterEvents() {
    [aySelect(), semSelect(), examTypeSelect(), programSelect(), sectionSelect()].forEach(sel => {
        sel?.addEventListener("change", () => { renderRoomTabs(); renderCalendar(); });
    });
    roomSelect()?.addEventListener("change", () => {
        const rm = roomSelect();
        if (rm && rm.value) {
            selectedRoom = rm.value;
            filters.room = rm.value;
            renderRoomTabs();
            renderCalendar();
        }
    });
}

document.addEventListener("click", event => {
    if (event.target.id === "customToastClose" || event.target.id === "customToast") {
        const toast = $("customToast");
        if (toast) toast.style.display = "none";
    }
});

$("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try { await signOut(auth); } catch (e) { console.error("Sign out error:", e); }
    window.location.replace("login.html");
});

async function init() {
    try {
        await loadLectureRooms();
        await loadExamSchedules();
        populateFilterOptions();
        if (lectureRooms.length) {
            selectedRoom = lectureRooms[0].roomName;
            filters.room = selectedRoom;
            const rm = roomSelect();
            if (rm) rm.value = selectedRoom;
        }
        bindFilterEvents();
        renderRoomTabs();
        renderCalendar();
    } catch (err) {
        console.error("Room Assignment init error:", err);
        const cal = calendarEl();
        if (cal) cal.innerHTML = `<p class="ra-empty">Could not load room assignment data.</p>`;
        showToast("Could not load room assignment data. Please check your connection and refresh.");
    }
}

onAuthStateChanged(auth, user => {
    if (!user) {
        window.location.replace("login.html");
    } else {
        init();
    }
});


