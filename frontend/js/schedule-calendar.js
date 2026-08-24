/**
 * schedule-calendar.js
 * ---------------------
 * Shared utility for rendering released class schedules and exam schedules
 * as visual weekly timetable grids on the Student Dashboard and Faculty Dashboard.
 *
 * DOES NOT modify any Firestore data, schedule generation logic, or admin pages.
 * Only used for display purposes.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Calendar starts at 7:00 AM (420 minutes from midnight) */
const CAL_START_MINUTES = 7 * 60; // 420

/** Calendar ends at 6:00 PM (1080 minutes from midnight) */
const CAL_END_MINUTES = 18 * 60; // 1080

/** Total visible minutes in the calendar */
const CAL_TOTAL_MINUTES = CAL_END_MINUTES - CAL_START_MINUTES; // 660

/** Pixel height per 60-minute hour slot in the calendar */
const HOUR_PX = 64;

/** Days used by the class schedule calendar (Mon–Fri only) */
const CLASS_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// ─── Time Parsing ─────────────────────────────────────────────────────────────

/**
 * Convert a raw time value (various formats) to { start, end } in minutes
 * from midnight. Returns null if parsing fails.
 *
 * Handles:
 *   "7:30-10:00"
 *   "7:30 - 10:00"
 *   "7:30 AM-10:00 AM"
 *   "7:30 AM - 10:00 AM"
 *   "1:00 PM - 3:30 PM"
 *
 * @param {string} rawTime
 * @returns {{ start: number, end: number } | null}
 */
export function parseTimeToMinutes(rawTime) {
    if (!rawTime) return null;
    const str = String(rawTime).trim();

    // Normalise separators: "7:30-10:00" → "7:30 - 10:00"
    // Also handle em-dash and en-dash
    const normalised = str.replace(/\s*[–—-]\s*/g, " - ");

    // Split on " - "
    const parts = normalised.split(" - ");
    if (parts.length < 2) return null;

    const startStr = parts[0].trim();
    const endStr   = parts[1].trim();

    const start = parseOnePart(startStr);
    const end   = parseOnePart(endStr);

    if (start === null || end === null) return null;
    return { start, end };
}

/**
 * Parse a single time token like "7:30", "7:30 AM", "1:00 PM" into minutes.
 * @param {string} token
 * @returns {number|null}
 */
function parseOnePart(token) {
    const upper = token.toUpperCase().trim();
    const isPM  = upper.includes("PM");
    const isAM  = upper.includes("AM");

    // Strip AM/PM
    const cleaned = upper.replace(/[AP]M/, "").trim();
    const colonIdx = cleaned.indexOf(":");

    let hours, minutes;
    if (colonIdx !== -1) {
        hours   = parseInt(cleaned.slice(0, colonIdx), 10);
        minutes = parseInt(cleaned.slice(colonIdx + 1), 10);
    } else {
        hours   = parseInt(cleaned, 10);
        minutes = 0;
    }

    if (isNaN(hours) || isNaN(minutes)) return null;

    // Convert 12-hour to 24-hour
    if (isPM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours  = 0;

    // Heuristic for ambiguous times (no AM/PM): treat ≤6 as PM (afternoon)
    if (!isPM && !isAM) {
        if (hours >= 1 && hours <= 6) hours += 12;
    }

    return hours * 60 + minutes;
}

/**
 * Format minutes-from-midnight back to "h:mm AM/PM" display string.
 * @param {number} totalMinutes
 * @returns {string}
 */
function minutesToDisplay(totalMinutes) {
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

// ─── HTML Escape ──────────────────────────────────────────────────────────────

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
}

// ─── Time Row Labels (left column) ────────────────────────────────────────────

/**
 * Build the time-label rows for the left column of the calendar.
 * One label per full hour, from CAL_START to CAL_END.
 * @returns {string} HTML
 */
function buildTimeLabels() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-time-label" style="top:${top}px">${minutesToDisplay(mins)}</div>`;
    }
    return html;
}

// ─── Block Overlap Detection ──────────────────────────────────────────────────

/**
 * Groups an array of { start, end, ...rest } blocks into overlap clusters.
 * Within each cluster, blocks are laid out side-by-side.
 * @param {Array<{start:number, end:number}>} blocks
 * @returns {Array<Array<{start:number, end:number}>>} clusters
 */
function groupOverlaps(blocks) {
    // Sort by start time
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

// ─── Class Schedule Block Builder ─────────────────────────────────────────────

/**
 * Build the positioned blocks HTML for a single day column in a class calendar.
 * @param {Array<Object>} entries - All class schedule entries
 * @param {string} day - e.g., "Monday"
 * @returns {string} HTML
 */
function buildClassDayBlocks(entries, day) {
    // Collect blocks for this specific day
    const dayBlocks = [];

    for (const entry of entries) {
        // Handle multi-day entries like "Monday / Wednesday"
        const rawDays  = String(entry.day  || "").split(/\s*\/\s*/);
        const rawTimes = String(entry.time || "").split(/\s*\/\s*/);
        const rawRooms = String(entry.room || "").split(/\s*\/\s*/);

        rawDays.forEach((d, i) => {
            if (d.trim().toLowerCase() !== day.toLowerCase()) return;

            const rawTime = (rawTimes[i] || rawTimes[0] || "").trim();
            const room    = (rawRooms[i] || rawRooms[0] || "").trim();
            const parsed  = parseTimeToMinutes(rawTime);
            if (!parsed) return;

            dayBlocks.push({
                start: parsed.start,
                end:   parsed.end,
                code:  entry.subjectCode || entry.code || "",
                name:  entry.subjectName || entry.name || "",
                time:  rawTime,
                room
            });
        });
    }

    if (!dayBlocks.length) return "";

    // Group overlapping blocks
    const clusters = groupOverlaps(dayBlocks);
    let html = "";

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd   = Math.min(block.end,   CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;

            const top    = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct  = 100 / colCount;
            const leftPct   = widthPct * colIndex;

            const displayTime = `${minutesToDisplay(block.start)} – ${minutesToDisplay(block.end)}`;
            const colorClass  = `cal-block-color-${(colIndex % 5) + 1}`;

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);" title="${esc(block.code)} — ${esc(block.name)}">
  <div class="cal-block-code">${esc(block.code)}</div>
  <div class="cal-block-name">${esc(block.name)}</div>
  <div class="cal-block-time">${esc(displayTime)}</div>
  <div class="cal-block-room">${esc(block.room)}</div>
</div>`;
        });
    }

    return html;
}

// ─── Exam Schedule Block Builder ──────────────────────────────────────────────

/**
 * Build the positioned blocks HTML for a single day column in an exam calendar.
 * @param {Array<Object>} exams - All exam entries
 * @param {string} day - e.g., "Monday"
 * @returns {string} HTML
 */
function buildExamDayBlocks(exams, day) {
    const dayBlocks = [];

    for (const exam of exams) {
        if (String(exam.day || "").trim().toLowerCase() !== day.toLowerCase()) continue;

        const rawTime = String(exam.time || "").trim();
        const parsed  = parseTimeToMinutes(rawTime);
        if (!parsed) continue;

        dayBlocks.push({
            start: parsed.start,
            end:   parsed.end,
            code:  exam.code  || exam.subjectCode  || "",
            name:  exam.name  || exam.subjectName  || "",
            time:  rawTime,
            room:  exam.room  || ""
        });
    }

    if (!dayBlocks.length) return "";

    const clusters = groupOverlaps(dayBlocks);
    let html = "";

    for (const cluster of clusters) {
        const colCount = cluster.length;
        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd   = Math.min(block.end,   CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;

            const top    = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct  = 100 / colCount;
            const leftPct   = widthPct * colIndex;

            const displayTime = `${minutesToDisplay(block.start)} – ${minutesToDisplay(block.end)}`;
            const colorClass  = `cal-block-color-exam`;

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);" title="${esc(block.code)} — ${esc(block.name)}">
  <div class="cal-block-code">${esc(block.code)}</div>
  <div class="cal-block-name">${esc(block.name)}</div>
  <div class="cal-block-time">${esc(displayTime)}</div>
  <div class="cal-block-room">${esc(block.room)}</div>
</div>`;
        });
    }

    return html;
}

// ─── Hour Grid Lines ──────────────────────────────────────────────────────────

/**
 * Build the background horizontal hour lines for a day column.
 * @returns {string} HTML
 */
function buildHourLines() {
    let html = "";
    for (let mins = CAL_START_MINUTES; mins <= CAL_END_MINUTES; mins += 60) {
        const top = ((mins - CAL_START_MINUTES) / 60) * HOUR_PX;
        html += `<div class="cal-hour-line" style="top:${top}px"></div>`;
    }
    return html;
}

// ─── Format exam date for display ─────────────────────────────────────────────

/**
 * Format an ISO date string "YYYY-MM-DD" to "Mon DD, YYYY".
 * @param {string} dateStr
 * @returns {string}
 */
function formatExamDateHeader(dateStr) {
    if (!dateStr) return "";
    const parts = String(dateStr).split("-");
    if (parts.length !== 3) return dateStr;
    const [year, month, day] = parts.map(Number);
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${monthNames[month - 1]} ${day}, ${year}`;
}

// ─── Public API: Render Class Calendar ────────────────────────────────────────

/**
 * Render a weekly class schedule as a visual Mon–Fri timetable.
 *
 * @param {Object} schedule  - A classSchedules document (with .entries[])
 * @returns {string} HTML string for the timetable (to be injected into a container)
 */
export function renderClassCalendar(schedule) {
    const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;

    // Build day columns
    const dayColumnsHtml = CLASS_DAYS.map(day => {
        const blocks = buildClassDayBlocks(entries, day);
        return `
<div class="cal-day-col">
  <div class="cal-day-header">${esc(day)}</div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks}
  </div>
</div>`;
    }).join("");

    return `
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
}

// ─── Public API: Render Exam Calendar ─────────────────────────────────────────

/**
 * Render an exam schedule as a date-driven timetable.
 * Columns are the actual exam dates from schedule.examDates, sorted by ISO date.
 *
 * @param {Object} schedule  - An examSchedules document (with .exams[] and .examDates{})
 * @returns {string} HTML string for the timetable
 */
export function renderExamCalendar(schedule) {
    const exams     = Array.isArray(schedule.exams) ? schedule.exams : [];
    const examDates = schedule.examDates || {};

    // Determine column order: prefer examDates keys sorted by ISO date value
    let dayOrder = [];

    if (Object.keys(examDates).length > 0) {
        dayOrder = Object.keys(examDates).sort((a, b) => {
            const da = examDates[a] || "";
            const db = examDates[b] || "";
            return da.localeCompare(db);
        });
    } else {
        // Fallback: derive unique days from exams array in appearance order
        const seen = new Set();
        for (const exam of exams) {
            const d = String(exam.day || "").trim();
            if (d && !seen.has(d)) { seen.add(d); dayOrder.push(d); }
        }
    }

    if (!dayOrder.length) return `<div class="empty-state">No examination schedule has been released yet.</div>`;

    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;

    const dayColumnsHtml = dayOrder.map(day => {
        const dateStr   = examDates[day] || "";
        const dateLabel = formatExamDateHeader(dateStr);
        const blocks    = buildExamDayBlocks(exams, day);

        return `
<div class="cal-day-col">
  <div class="cal-day-header">
    <span class="cal-day-name">${esc(day)}</span>
    ${dateLabel ? `<span class="cal-day-date">${esc(dateLabel)}</span>` : ""}
  </div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks}
  </div>
</div>`;
    }).join("");

    return `
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
}
