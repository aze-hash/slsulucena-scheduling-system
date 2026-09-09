/**
 * schedule-calendar.js
 * ---------------------
 * Shared utility for rendering released exam schedules and exam schedules
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

/** Days used by the exam schedule calendar (Mon–Fri only) */
const EXAM_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

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
    // Generated slots use compact ranges such as "7:30-9:00".
    const normalised = str.replace(/\s*(?:-|–|—)\s*/g, " - ");

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

const TOTAL_CALENDAR_COLORS = 16;

/**
 * Builds a mapping from subject key to a dedicated .cal-block-color-N class.
 * Ensures every unique subject gets its own distinct color across all days in the schedule.
 */
function buildSubjectColorMap(entries) {
    const map = new Map();
    let colorIndex = 1;

    for (const entry of entries) {
        const key = String(entry.code || entry.subjectCode || entry.name || entry.subjectName || "").trim().toUpperCase();
        if (!key) continue;
        if (!map.has(key)) {
            map.set(key, `cal-block-color-${colorIndex}`);
            colorIndex = (colorIndex % TOTAL_CALENDAR_COLORS) + 1;
        }
    }
    return map;
}

// ─── Exam Schedule Block Builder ─────────────────────────────────────────────

/**
 * Build the positioned blocks HTML for a single day column in a class calendar.
 * @param {Array<Object>} entries - All exam schedule entries
 * @param {string} day - e.g., "Monday"
 * @param {Map<string, string>} [subjectColorMap] - Mapping of subject key to color class
 * @returns {string} HTML
 */
function buildArchivedScheduleDayBlocks(entries, day, subjectColorMap = new Map(), isFacultySchedule = false) {
    // Collect blocks for this specific day
    const dayBlocks = [];

    for (const entry of entries) {
        // Handle multi-day entries like "Monday / Wednesday"
        const rawDays  = String(entry.day  || "").split(/\s*\/\s*/);
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
            const room    = (rawRooms[i] || rawRooms[0] || "").trim();
            const parsed  = parseTimeToMinutes(rawTime);
            if (!parsed) return;

            dayBlocks.push({
                start: parsed.start,
                end:   parsed.end,
                code:  entry.subjectCode || entry.code || "",
                name:  entry.subjectName || entry.name || "",
                time:  rawTime,
                room,
                section: entry.section || "",
                faculty: entry.facultyName || ""
            });
        });
    }

    if (!dayBlocks.length) return "";

    // Group overlapping blocks
    const clusters = groupOverlaps(dayBlocks);
    let html = "";

    for (const cluster of clusters) {
        const colCount = cluster.length;
        const isClusterClash = Boolean(isFacultySchedule && colCount > 1);

        cluster.forEach((block, colIndex) => {
            const clampedStart = Math.max(block.start, CAL_START_MINUTES);
            const clampedEnd   = Math.min(block.end,   CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;

            const top    = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct  = 100 / colCount;
            const leftPct   = widthPct * colIndex;

            const displayTime = `${minutesToDisplay(block.start)} – ${minutesToDisplay(block.end)}`;
            const subjectKey  = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass  = isClusterClash ? "cal-block-conflict" : (subjectColorMap.get(subjectKey) || `cal-block-color-${((colIndex) % TOTAL_CALENDAR_COLORS) + 1}`);

            const displayExtra = [block.room, block.section || block.faculty].filter(Boolean).join(" • ");
            const conflictTag = isClusterClash
                ? `<div class="cal-block-conflict-tag" style="background:#d32f2f; color:#ffffff; font-size:8.5px; font-weight:800; padding:1px 4px; border-radius:3px; display:inline-flex; align-items:center; gap:2px; margin-bottom:2px; line-height:1.2; width:fit-content; letter-spacing:0.3px;">⚠️ CLASH</div>`
                : "";
            const conflictStyle = isClusterClash
                ? `background:#ffebee !important; border-left:3px solid #d32f2f !important; color:#b71c1c !important; box-shadow:0 0 0 1px #ef9a9a, 0 2px 6px rgba(211,47,47,0.25) !important; z-index:4;`
                : "";
            const conflictTitle = isClusterClash
                ? `⚠️ CONFLICT: Instructor has overlapping classes on ${esc(day)} at ${esc(displayTime)}! Subject: ${esc(block.code)}, Section: ${esc(block.section || 'N/A')}, Room: ${esc(block.room || 'N/A')}`
                : `${esc(block.code)} — ${esc(block.name)}${block.section ? ` [${esc(block.section)}]` : ""}${block.faculty ? ` (${esc(block.faculty)})` : ""}`;

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px); ${conflictStyle}" title="${conflictTitle}">
  ${conflictTag}
  <div class="cal-block-code">${esc(block.code)}</div>
  <div class="cal-block-name">${esc(block.name)}</div>
  <div class="cal-block-time">${esc(displayTime)}</div>
  <div class="cal-block-room">${esc(displayExtra)}</div>
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
 * @param {Map<string, string>} [subjectColorMap] - Mapping of subject key to color class
 * @returns {string} HTML
 */
function buildExamDayBlocks(exams, day, subjectColorMap = new Map()) {
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
            room:  exam.room  || "",
            proctor: exam.proctor || exam.facultyName || "TBA"
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
            const subjectKey  = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass  = subjectColorMap.get(subjectKey) || `cal-block-color-${((colIndex) % TOTAL_CALENDAR_COLORS) + 1}`;

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);" title="${esc(block.code)} — ${esc(block.name)} — Proctor: ${esc(block.proctor)}">
  <div class="cal-block-code">${esc(block.code)}</div>
  <div class="cal-block-name">${esc(block.name)}</div>
  <div class="cal-block-time">${esc(displayTime)}</div>
  <div class="cal-block-room">Room: ${esc(block.room)}</div>
  <div class="cal-block-room">Proctor: ${esc(block.proctor)}</div>
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
 * Render a weekly exam schedule as a visual Mon–Fri timetable with schedule details table.
 *
 * @param {Object} schedule  - A examSchedules document (with .entries[] or .rawEntries[])
 * @returns {string} HTML string for the timetable and details table (to be injected into a container)
 */
function renderArchivedScheduleCalendar(schedule) {
    let entries = Array.isArray(schedule.entries) && schedule.entries.length > 0
        ? schedule.entries
        : (Array.isArray(schedule.rawEntries) ? schedule.rawEntries : []);

    if (!entries || entries.length === 0) {
        return `
            <div style="padding:40px 20px; text-align:center; color:#777; font-size:14px; background:#fafaf7; border-radius:10px; border:1px solid #d0ccbf; margin-top:6px;">
                <div style="font-size:32px; margin-bottom:8px;">📅</div>
                <strong style="color:#333; font-size:15px;">No schedule entries found for this section.</strong>
                <p style="margin-top:6px; font-size:12px; color:#888;">The schedule details may not have been saved or exported with entries.</p>
            </div>
        `;
    }

    const isFac = !!schedule.isFacultySchedule;
    let conflictBannerHtml = "";

    if (isFac) {
        // Collect discrete items
        const discreteBlocks = [];
        for (const entry of entries) {
            const rawDays  = String(entry.day  || "").split(/\s*\/\s*/);
            const rawTimes = String(entry.time || "").split(/\s*\/\s*/);
            const rawRooms = String(entry.room || "").split(/\s*\/\s*/);

            rawDays.forEach((d, i) => {
                const dayTrim = d.trim();
                const rawTime = (rawTimes[i] || rawTimes[0] || "").trim();
                const room    = (rawRooms[i] || rawRooms[0] || "").trim();
                const parsed  = parseTimeToMinutes(rawTime);
                if (!parsed || !dayTrim) return;

                discreteBlocks.push({
                    day: dayTrim,
                    start: parsed.start,
                    end: parsed.end,
                    time: rawTime,
                    code: entry.subjectCode || entry.code || "",
                    name: entry.subjectName || entry.name || "",
                    section: entry.section || "",
                    room
                });
            });
        }

        // Find pairs of overlapping blocks on the same day
        const clashPairs = [];
        const seenClashKeys = new Set();

        for (let i = 0; i < discreteBlocks.length; i++) {
            for (let j = i + 1; j < discreteBlocks.length; j++) {
                const b1 = discreteBlocks[i];
                const b2 = discreteBlocks[j];
                if (b1.day.toLowerCase() === b2.day.toLowerCase()) {
                    // Time overlap
                    if (b1.start < b2.end && b2.start < b1.end) {
                        const clashKey = [b1.day, b1.code, b1.section, b2.code, b2.section, b1.start].sort().join("_");
                        if (!seenClashKeys.has(clashKey)) {
                            seenClashKeys.add(clashKey);
                            clashPairs.push({ b1, b2 });
                        }
                    }
                }
            }
        }

        if (clashPairs.length > 0) {
            const listHtml = clashPairs.map(cp => {
                const day = cp.b1.day;
                const time1 = minutesToDisplay(cp.b1.start) + " – " + minutesToDisplay(cp.b1.end);
                const time2 = minutesToDisplay(cp.b2.start) + " – " + minutesToDisplay(cp.b2.end);
                return `
                    <div style="display:flex; align-items:flex-start; gap:8px; padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #ffcdd2;">
                        <span style="font-weight:700; color:#d32f2f; font-size:12px; min-width:85px;">${esc(day)}:</span>
                        <div style="font-size:12px; color:#333; flex-grow:1;">
                            <div><strong style="color:#b71c1c;">${esc(cp.b1.code)}</strong> in <strong>${esc(cp.b1.section || 'Section')}</strong> (${esc(cp.b1.room || 'Room TBA')}) at ${esc(time1)}</div>
                            <div style="color:#d32f2f; font-weight:700; font-size:11px; margin:2px 0;">⚡ CLASHES WITH</div>
                            <div><strong style="color:#b71c1c;">${esc(cp.b2.code)}</strong> in <strong>${esc(cp.b2.section || 'Section')}</strong> (${esc(cp.b2.room || 'Room TBA')}) at ${esc(time2)}</div>
                        </div>
                    </div>
                `;
            }).join("");

            conflictBannerHtml = `
                <div class="faculty-conflict-alert" style="margin-bottom:14px; padding:12px 16px; background:#ffebee; border:2px solid #ef5350; border-radius:10px; box-shadow:0 3px 10px rgba(211,47,47,0.12);">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
                        <div style="font-size:14px; font-weight:bold; color:#b71c1c; display:flex; align-items:center; gap:6px;">
                            <span style="font-size:18px;">⚠️</span> FACULTY SCHEDULE CONFLICT DETECTED
                        </div>
                        <span style="background:#d32f2f; color:#fff; font-size:11px; font-weight:bold; padding:3px 10px; border-radius:999px;">
                            ${clashPairs.length} Overlapping Slot Clash${clashPairs.length > 1 ? 'es' : ''}
                        </span>
                    </div>
                    <div style="font-size:12.5px; color:#5c0000; margin-bottom:8px; line-height:1.4;">
                        This instructor has been assigned multiple simultaneous classes in different rooms. An instructor cannot teach more than one section at the same time.
                    </div>
                    <div style="display:flex; flex-direction:column; gap:6px;">
                        ${listHtml}
                    </div>
                </div>
            `;
        }
    }

    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
    const subjectColorMap = buildSubjectColorMap(entries);

    // Build day columns
    const dayColumnsHtml = EXAM_DAYS.map(day => {
        const blocks = buildArchivedScheduleDayBlocks(entries, day, subjectColorMap, isFac);
        return `
<div class="cal-day-col">
  <div class="cal-day-header"><span class="cal-day-name">${esc(day)}</span></div>
  <div class="cal-day-body" style="height:${calendarHeight}px">
    ${buildHourLines()}
    ${blocks}
  </div>
</div>`;
    }).join("");

    // Build details table rows with matching subject color dots
    const tableRows = entries.map(entry => {
        const subjectKey = String(entry.code || entry.subjectCode || entry.name || entry.subjectName || "").trim().toUpperCase();
        const colorClass = subjectColorMap.get(subjectKey) || "cal-block-color-1";

        return `
        <tr>
            <td style="border:1px solid #d0ccbf; padding:8px 10px; font-weight:bold; color:#1b5e20;">
                <span class="cal-color-dot ${colorClass}" style="display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:middle;"></span>
                ${esc(entry.code || entry.subjectCode || "—")}
            </td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px;">${esc(entry.name || entry.subjectName || "—")}</td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px; text-align:center;">${esc(entry.units ?? "—")}</td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px;">${esc(entry.day || "—")}</td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px; font-weight:600;">${esc(entry.time || "—")}</td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px;">${esc(entry.room || "—")}</td>
            <td style="border:1px solid #d0ccbf; padding:8px 10px; font-weight:600; color:#1b5e20;">${esc(isFac ? (entry.section || "—") : (entry.proctor || entry.facultyName || "TBA"))}</td>
        </tr>`;
    }).join("");

    const subjectCountText = `${entries.length} ${entries.length === 1 ? "subject" : "subjects"}`;

    const detailsTableHtml = `
<details class="cal-details-collapsible" style="margin-top:16px; border:1px solid #d0ccbf; border-radius:10px; background:#fff; overflow:hidden;">
    <summary class="cal-details-summary" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f4f9f4; cursor:pointer; user-select:none; list-style:none;">
        <div class="cal-details-summary-left" style="display:flex; align-items:center; gap:8px;">
            <span class="cal-details-title" style="font-size:14px; font-weight:bold; color:#1b5e20;">Schedule Details</span>
            <span class="cal-details-count" style="font-size:11px; color:#555; background:#e8f5e9; padding:2px 8px; border-radius:10px; border:1px solid #c8e6c9;">${subjectCountText}</span>
        </div>
        <span class="cal-details-toggle-icon" title="Toggle schedule details" style="display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:50%; background:#e8f5e9; border:1px solid #c8e6c9; color:#1b5e20; transition:transform 0.2s ease;">
            <svg class="cal-chevron-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        </span>
    </summary>
    <div class="cal-details-content" style="border-top:1px solid #d0ccbf;">
        <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:12px; background:#fff;">
                <thead>
                    <tr style="background:#e8f5e9; color:#1b5e20;">
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">Subject Code</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">Subject Name</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:center;">Units</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">Day</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">Time</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">Room</th>
                        <th style="border:1px solid #d0ccbf; padding:9px 10px; text-align:left;">${isFac ? "Section" : "Instructor"}</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
    </div>
</details>`;

    return `
${conflictBannerHtml}
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
${detailsTableHtml}`;
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
    const subjectColorMap = buildSubjectColorMap(exams);

    const dayColumnsHtml = dayOrder.map(day => {
        const dateStr   = examDates[day] || "";
        const dateLabel = formatExamDateHeader(dateStr);
        const blocks    = buildExamDayBlocks(exams, day, subjectColorMap);

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

// ─── Public API: Weekly Exam Subject Calendar ────────────────────────────────

/**
 * Build the positioned subject blocks for a single weekday column of a weekly
 * exam calendar. Supports a single day value ("Tuesday") as well as multi-day
 * values ("Monday / Wednesday") while keeping day/time/room entries paired,
 * exactly like the admin Proctoring dashboard does.
 *
 * @param {Array<Object>} exams - Flattened exam entries assigned to the faculty
 * @param {string} day - Column weekday name, e.g. "Monday"
 * @param {Map<string, string>} [subjectColorMap] - Subject -> color class map
 * @returns {string} HTML string of the positioned blocks
 */
function buildWeeklyExamDayBlocks(exams, day, subjectColorMap = new Map()) {
    const dayBlocks = [];

    for (const exam of exams) {
        const rawDays  = String(exam.day  || "").split(/\s*\/\s*/);
        const rawTimes = String(exam.time || "").split(/\s*\/\s*/);
        const rawRooms = String(exam.room || "").split(/\s*\/\s*/);

        rawDays.forEach((d, i) => {
            const dt = d.trim().toLowerCase();
            const dayLower = day.toLowerCase();
            const matchesDay = dt === dayLower ||
                               (dt.length >= 3 && dayLower.startsWith(dt.slice(0, 3))) ||
                               (dayLower.length >= 3 && dt.startsWith(dayLower.slice(0, 3)));
            if (!matchesDay) return;

            const rawTime = (rawTimes[i] || rawTimes[0] || exam.time || "").trim();
            const room    = (rawRooms[i] || rawRooms[0] || exam.room || "").trim();
            const parsed  = parseTimeToMinutes(rawTime);
            if (!parsed) return;

            dayBlocks.push({
                start: parsed.start,
                end:   parsed.end,
                code:  exam.code  || exam.subjectCode  || "",
                name:  exam.name  || exam.subjectName  || "",
                time:  rawTime,
                room,
                section: exam.section || "",
                examType: exam.examType || ""
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
            const clampedEnd   = Math.min(block.end,   CAL_END_MINUTES);
            if (clampedEnd <= clampedStart) return;

            const top    = ((clampedStart - CAL_START_MINUTES) / 60) * HOUR_PX;
            const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_PX, 28);
            const widthPct  = 100 / colCount;
            const leftPct   = widthPct * colIndex;

            const displayTime = `${minutesToDisplay(block.start)} \u2013 ${minutesToDisplay(block.end)}`;
            const subjectKey  = String(block.code || block.name || "").trim().toUpperCase();
            const colorClass  = subjectColorMap.get(subjectKey) || `cal-block-color-${((colIndex) % TOTAL_CALENDAR_COLORS) + 1}`;

            const metaParts = [block.examType, block.section, block.room].filter(Boolean);

            html += `
<div class="cal-block ${colorClass}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;width:calc(${widthPct.toFixed(1)}% - 4px);left:calc(${leftPct.toFixed(1)}% + 2px);" title="${esc(block.code)} \u2014 ${esc(block.name)} \u2014 ${esc(block.examType)} \u2014 ${esc(block.section)} \u2014 Room: ${esc(block.room)}">
  <div class="cal-block-code">${esc(block.code)}</div>
  <div class="cal-block-name">${esc(block.name)}</div>
  <div class="cal-block-time">${esc(displayTime)}</div>
  <div class="cal-block-room">${esc(metaParts.join(" \u2022 "))}</div>
</div>`;
        });
    }

    return html;
}

/**
 * Render the exam SUBJECTS assigned to one faculty member as a weekly
 * Mon\u2013Fri timetable calendar (same visual style as the admin Proctoring
 * dashboard's per-faculty calendar cards).
 *
 * @param {Array<Object>} exams - Flattened exam entries assigned to the faculty
 * @returns {string} HTML string for the weekly timetable
 */
export function renderWeeklyExamCalendar(exams) {
    const entries = Array.isArray(exams) ? exams : [];
    if (!entries.length) {
        return `<div class="empty-state">No exam subjects assigned to you yet.</div>`;
    }

    const calendarHeight = (CAL_TOTAL_MINUTES / 60) * HOUR_PX;
    const subjectColorMap = buildSubjectColorMap(entries);

    const dayColumnsHtml = EXAM_DAYS.map(day => {
        const blocks = buildWeeklyExamDayBlocks(entries, day, subjectColorMap);
        return `
<div class="cal-day-col">
  <div class="cal-day-header"><span class="cal-day-name">${esc(day)}</span></div>
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
