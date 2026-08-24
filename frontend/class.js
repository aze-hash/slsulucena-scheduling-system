import { db, auth } from "../firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { saveReportToFirestore } from "./reportStorage.js";

import {
    collection,
    getDocs,
    query,
    where,
    doc,
    setDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ------------------------------------------------------------------ */
/*  Custom centered notification system (replaces browser alert/confirm) */
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

function showConfirm(message) {
    return new Promise(resolve => {
        const modal = document.getElementById("customConfirmModal");
        const msgEl = document.getElementById("customConfirmMessage");
        const cancelBtn = document.getElementById("customConfirmCancel");
        const okBtn = document.getElementById("customConfirmOk");

        if (!modal || !msgEl || !cancelBtn || !okBtn) {
            resolve(confirm(message));
            return;
        }

        msgEl.textContent = message;
        modal.style.display = "flex";

        function cleanup() {
            modal.style.display = "none";
            cancelBtn.removeEventListener("click", onCancel);
            okBtn.removeEventListener("click", onOk);
            modal.removeEventListener("click", onBackdrop);
        }

        function onCancel() { cleanup(); resolve(false); }
        function onOk() { cleanup(); resolve(true); }
        function onBackdrop(event) {
            if (event.target === modal) { cleanup(); resolve(false); }
        }

        cancelBtn.addEventListener("click", onCancel);
        okBtn.addEventListener("click", onOk);
        modal.addEventListener("click", onBackdrop);
    });
}

const semesterSelect = document.getElementById("semester");
const programSelect = document.getElementById("program");
const majorSelect = document.getElementById("major");
const yearLevelSelect = document.getElementById("yearLevel");
const sectionSelect = document.getElementById("section");

const subjectBody = document.getElementById("subjectTableBody");
const scheduleBody = document.getElementById("scheduleTableBody");
const modal = document.getElementById("scheduleModal");
const saveScheduleBtn = document.getElementById("saveScheduleBtn");
const savedSchedulesList = document.getElementById("savedSchedulesList");
const emptySavedSchedules = document.getElementById("emptySavedSchedules");
const generatingOverlay = document.getElementById("generatingOverlay");
const generateBtn = document.getElementById("generateBtn");
const savedOverlay = document.getElementById("savedOverlay");

const SAVED_SCHEDULES_KEY = "chairpersonSavedSchedules";

const ARCHIVE_PAGE_SIZE = 10;

let generatedSchedule = null;
let archiveCurrentPage = 1;
let archiveFilterYear = "";
let archiveFilterSemester = "";
let archiveFilterSearch = "";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const minorSlots = [
    "7:30-9:00", "9:00-10:30", "10:30-12:00",
    "1:00-2:30", "2:30-4:00", "4:00-5:30"
];

const majorSlots = [
    "7:30-10:00", "10:00-12:30", "1:00-3:30", "3:30-6:00"
];

const activitySlots = [
    "8:00-10:00", "10:00-12:00",
    "1:00-3:00", "3:00-5:00"
];

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function getSavedSchedules() {
    try {
        return JSON.parse(localStorage.getItem(SAVED_SCHEDULES_KEY)) || [];
    } catch {
        return [];
    }
}

function setSavedSchedules(schedules) {
    localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(schedules));
}

/* ------------------------------------------------------------------ */
/*  Firestore helpers                                                  */
/* ------------------------------------------------------------------ */

const SCHEDULES_COLLECTION = "classSchedules";

/**
 * Returns a stable document ID for a schedule so that saving the same
 * combination (section + semester + program + major + yearLevel) always
 * overwrites the same Firestore document.
 */
function scheduleDocId(schedule) {
    const raw = [
        schedule.section || "",
        schedule.semester || "",
        schedule.program || "",
        schedule.major || "",
        schedule.yearLevel || "",
        schedule.academicYear || ""
    ].join("_");

    return raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
}

async function saveScheduleToFirestore(schedule) {
    const docId = scheduleDocId(schedule);

    const data = {
        name: schedule.name,
        section: schedule.section,
        semester: schedule.semester,
        program: schedule.program,
        major: schedule.major,
        yearLevel: schedule.yearLevel,
        academicYear: schedule.academicYear || "",
        entries: schedule.entries,
        rawEntries: schedule.rawEntries,
        status: schedule.status === "archived" ? "archived" : "active",
        createdAt: schedule.createdAt
            ? new Date(schedule.createdAt)
            : new Date(),
        updatedAt: new Date(),
        savedBy: auth.currentUser?.uid || null
    };

    if (schedule.exportedAt) {
        data.exportedAt = schedule.exportedAt instanceof Date
            ? schedule.exportedAt
            : new Date(schedule.exportedAt);
    }

    await setDoc(doc(db, SCHEDULES_COLLECTION, docId), data);
}

async function loadSchedulesFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, SCHEDULES_COLLECTION));
        return snapshot.docs.map(document => {
            const data = document.data();

            return {
                id: document.id,
                name: data.name || "",
                section: data.section || "",
                semester: data.semester || "",
                program: data.program || "",
                major: data.major || "",
                yearLevel: data.yearLevel || "",
                academicYear: data.academicYear || "",
                entries: data.entries || [],
                rawEntries: data.rawEntries || [],
                /* Legacy records without a status field are treated as active so
                   they remain visible in Saved Schedules until exported. */
                status: data.status === "archived" ? "archived" : "active",
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString(),
                updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || new Date().toISOString(),
                exportedAt: data.exportedAt?.toDate?.()?.toISOString?.() || data.exportedAt || null
            };
        });
    } catch (error) {
        console.error("Could not load schedules from Firestore:", error);
        return [];
    }
}

async function archiveScheduleInFirestore(schedule) {
    const docId = scheduleDocId(schedule);
    await updateDoc(doc(db, SCHEDULES_COLLECTION, docId), {
        status: "archived",
        exportedAt: serverTimestamp(),
        updatedAt: new Date()
    });
}

async function deleteScheduleFromFirestore(docId) {
    try {
        await deleteDoc(doc(db, SCHEDULES_COLLECTION, docId));
        
    } catch (error) {
        console.error("Could not delete schedule from Firestore:", error);
        throw error;
    }
}

function parseTime(value) {
    if (!value) return 0;
    const parts = String(value).trim().split(":").map(Number);
    let hour = parts[0] || 0;
    const minute = parts[1] || 0;
    // School operating hours: 7:00 AM to 6:30 PM.
    // Hours 1 to 6 are PM (13:00 to 18:00).
    if (hour >= 1 && hour <= 6) {
        hour += 12;
    }
    return hour * 60 + minute;
}

function parseTimeRange(slotStr) {
    if (!slotStr || !slotStr.includes("-")) return null;
    const [firstStart, firstEnd] = slotStr.split("-").map(parseTime);
    return { start: firstStart, end: firstEnd };
}

function timesOverlap(firstTime, secondTime) {
    if (!firstTime || !secondTime) return false;
    const [firstStart, firstEnd] = firstTime.split("-").map(parseTime);
    const [secondStart, secondEnd] = secondTime.split("-").map(parseTime);

    return firstStart < secondEnd && secondStart < firstEnd;
}

/**
 * Checks if adding candidateTime to existingDayEntries maintains an acceptable vacant gap.
 * Allows: 0 min (back-to-back), up to 90 min (1.5 hours) vacant.
 * Disallows: long vacant gaps (> 90 minutes / 1.5 hours).
 */
function isVacantGapAcceptable(existingDayEntries, candidateTime) {
    const candidateRange = parseTimeRange(candidateTime);
    if (!candidateRange) return false;

    const allRanges = (existingDayEntries || [])
        .map(t => typeof t === "string" ? parseTimeRange(t) : parseTimeRange(t.time))
        .filter(Boolean);
    allRanges.push(candidateRange);

    allRanges.sort((a, b) => a.start - b.start);

    for (let i = 0; i < allRanges.length - 1; i++) {
        const currentEnd = allRanges[i].end;
        const nextStart = allRanges[i + 1].start;

        const rawGap = nextStart - currentEnd;
        if (rawGap <= 0) continue; // back-to-back or overlapping

        // Lunch break allowance (12:00-13:00 or 12:30-13:00)
        let lunchAllowance = 0;
        const lunchStart = 12 * 60; // 720 (12:00 PM)
        const lunchEnd = 13 * 60;   // 780 (1:00 PM)

        if (currentEnd <= lunchStart && nextStart >= lunchEnd) {
            lunchAllowance = 60; // 1-hour lunch break
        } else if (currentEnd <= 750 && nextStart >= lunchEnd) {
            lunchAllowance = 30; // 30-min lunch break
        }

        const netVacantGap = Math.max(0, rawGap - lunchAllowance);

        // Disallow long vacant time (> 1.5 hours / 90 minutes)
        if (netVacantGap > 90) {
            return false;
        }
    }

    return true;
}

/**
 * Calculates a compactness penalty for ranking candidate slots.
 * Prefers back-to-back (0 penalty) and smaller vacant gaps over larger gaps.
 */
function calculateDayPlacementVacantPenalty(existingDayEntries, candidateTime) {
    if (!existingDayEntries || existingDayEntries.length === 0) return 0;
    const candidateRange = parseTimeRange(candidateTime);
    if (!candidateRange) return 0;

    let minGap = Infinity;
    for (const item of existingDayEntries) {
        const r = typeof item === "string" ? parseTimeRange(item) : parseTimeRange(item.time);
        if (!r) continue;

        if (candidateRange.start >= r.end) {
            let gap = candidateRange.start - r.end;
            if (r.end <= 720 && candidateRange.start >= 780) gap = Math.max(0, gap - 60);
            else if (r.end <= 750 && candidateRange.start >= 780) gap = Math.max(0, gap - 30);
            if (gap < minGap) minGap = gap;
        } else if (r.start >= candidateRange.end) {
            let gap = r.start - candidateRange.end;
            if (candidateRange.end <= 720 && r.start >= 780) gap = Math.max(0, gap - 60);
            else if (candidateRange.end <= 750 && r.start >= 780) gap = Math.max(0, gap - 30);
            if (gap < minGap) minGap = gap;
        }
    }

    return minGap === Infinity ? 0 : minGap;
}

const DAY_PAIRS = [
    ["Monday", "Thursday"],
    ["Tuesday", "Friday"],
    ["Monday", "Wednesday"],
    ["Wednesday", "Friday"],
    ["Tuesday", "Thursday"],
    ["Monday", "Friday"]
];

function normalizeRoomType(roomType) {
    const type = String(roomType || "").trim();

    // Gym
    if (type.toLowerCase().includes("gym")) {
        return "Gymnasium";
    }

    // General laboratory
    if (type === "Laboratory") return "Laboratory";

    // Major laboratories
    if (type === "MT Laboratory") return "MT Laboratory";
    if (type === "AT Laboratory") return "AT Laboratory";
    if (type === "CP Laboratory") return "CP Laboratory";
    if (type === "CT Laboratory") return "CT Laboratory";
    if (type === "ELT Laboratory") return "ELT Laboratory";
    if (type === "ELX Laboratory") return "ELX Laboratory";
    if (type === "FSM Laboratory") return "FSM Laboratory";
    if (type === "CPT Laboratory") return "CPT Laboratory";

    return "Lecture Room";
}

function isLabRoomType(roomType) {
    const labTypes = [
        "Laboratory",
        "MT Laboratory", "AT Laboratory", "CP Laboratory",
        "CT Laboratory", "ELT Laboratory", "ELX Laboratory",
        "FSM Laboratory", "CPT Laboratory"
    ];
    return labTypes.includes(roomType);
}

function getBuildingPriority(building, prog) {
    if (prog === "BIT" || prog === "BINDTECH") {
        if (building === "Building B") return 0;
        if (building === "Admin Building") return 1;
        return 2;
    }
    if (prog === "BTVTED") {
        if (building === "Building A") return 0;
        if (building === "Admin Building") return 1;
        return 2;
    }
    return 0;
}

function scheduleRows(entries) {
    return entries.map(item => `
        <tr>
            <td>${escapeHtml(item.code)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.units)}</td>
            <td>${escapeHtml(item.day)}</td>
            <td>${escapeHtml(item.time)}</td>
            <td>${escapeHtml(item.room)}</td>
        </tr>
    `).join("");
}

function getSavedBookings(academicYear, semester) {
    return getSavedSchedules().flatMap(schedule => {
        /* ROOM AVAILABILITY SCOPING:
           Only ACTIVE schedules in the SAME Academic Year AND SAME Semester
           reserve rooms.  Archived schedules and schedules from other
           academic years or other semesters must NOT block room availability. */
        if ((schedule.status || "active") === "archived") return [];
        if (academicYear && schedule.academicYear !== academicYear) return [];
        if (semester && schedule.semester !== semester) return [];

        if (schedule.rawEntries?.length) {
            return schedule.rawEntries;
        }

        return (schedule.entries || []).flatMap(entry => {
            const entryDays = String(entry.day || "").split(" / ");
            const entryTimes = String(entry.time || "").split(" / ");
            const entryRooms = String(entry.room || "").split(" / ");

            return entryDays.map((day, index) => ({
                day: day.trim(),
                time: (entryTimes[index] || entryTimes[0] || "").trim(),
                room: (entryRooms[index] || entryRooms[0] || "").trim(),
                roomCode: ""
            }));
        });
    });
}

programSelect.addEventListener("change", () => {
    majorSelect.innerHTML = `<option value="">Select Major</option>`;

    if (programSelect.value === "BIT" || programSelect.value === "BINDTECH") {
        majorSelect.innerHTML += `<option value="CPT">CPT</option>`;
    }

    if (programSelect.value === "BTVTED") {
        majorSelect.innerHTML += `
            <option value="AT">AT</option>
            <option value="MT">MT</option>
            <option value="CP">CP</option>
            <option value="FSM">FSM</option>
            <option value="CT">CT</option>
            <option value="ELT">ELT</option>
            <option value="ELX">ELX</option>
        `;
    }

    sectionSelect.innerHTML = `<option value="">Select Section</option>`;
});

majorSelect.addEventListener("change", loadSections);
yearLevelSelect.addEventListener("change", loadSections);

async function loadSections() {
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);

    if (!programCode || !majorCode || !yearLevel) {
        sectionSelect.innerHTML = `
            <option value="">Select Program, Major, and Year Level first</option>
        `;
        return;
    }

    sectionSelect.innerHTML = `<option value="">Loading sections...</option>`;

    try {
        const sectionQuery = query(
            collection(db, "sections"),
            where("programCode", "==", programCode),
            where("majorCode", "==", majorCode),
            where("yearLevel", "==", yearLevel)
        );

        const snapshot = await getDocs(sectionQuery);

        sectionSelect.innerHTML = `<option value="">Select Section</option>`;

        if (snapshot.empty) {
            sectionSelect.innerHTML += `
                <option value="" disabled>No sections found</option>
            `;
            return;
        }

        snapshot.forEach(doc => {
            const section = doc.data();

            sectionSelect.innerHTML += `
                <option value="${escapeHtml(section.sectionCode)}">
                    ${escapeHtml(section.sectionCode)}
                </option>
            `;
        });
    } catch (error) {
        console.error(error);
        showToast(`Could not load sections: ${error.message}`);
    }
} 

// Section add UI handlers (modal version)
const addSectionBtn = document.getElementById("addSectionBtn");
const addSectionModal = document.getElementById("addSectionModal");
const newSectionInput = document.getElementById("newSectionInput");
const saveNewSectionBtn = document.getElementById("saveNewSectionBtn");
const cancelNewSectionBtn = document.getElementById("cancelNewSectionBtn");

addSectionBtn.style.display = "none"; // hidden initially

// Show plus button when the section dropdown is interacted with
function showPlusButton() {
    addSectionBtn.style.display = "inline";
}
function hidePlusButton() {
    // Hide only if modal is not open
    if (addSectionModal.style.display !== "flex") {
        addSectionBtn.style.display = "none";
    }
}
// Show on focus and click of the select
sectionSelect.addEventListener("focus", showPlusButton);
sectionSelect.addEventListener("click", showPlusButton);
// Hide when clicking outside the select and button
document.addEventListener("click", (e) => {
    if (!sectionSelect.contains(e.target) && !addSectionBtn.contains(e.target) && !addSectionModal.contains(e.target)) {
        hidePlusButton();
    }
});



cancelNewSectionBtn.addEventListener("click", () => {
    addSectionModal.style.display = "none";
    newSectionInput.value = "";
    // hide plus button after closing modal
    hidePlusButton();
});

addSectionBtn.addEventListener("click", () => {
    addSectionModal.style.display = "flex";
    newSectionInput.focus();
});
saveNewSectionBtn.addEventListener("click", async () => {
    const newCode = newSectionInput.value.trim();
    if (!newCode) {
        showToast("Section code cannot be empty.");
        return;
    }
    // Validate format: allow alphanumeric, hyphens, underscores
    if (!/^[A-Za-z0-9_-]+$/.test(newCode)) {
        showToast("Section code must be alphanumeric (letters, numbers, _ or -).");
        return;
    }
    // Check for duplicate section code
    const exists = Array.from(sectionSelect.options).some(opt => opt.value === newCode);
    if (exists) {
        showToast("Section already exists.");
        return;
    }
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);
    if (!programCode || !majorCode || !yearLevel) {
        showToast("Select Program, Major, and Year Level before adding a section.");
        return;
    }
    try {
        const docRef = doc(collection(db, "sections"), newCode);
        await setDoc(docRef, {
            sectionCode: newCode,
            programCode,
            majorCode,
            yearLevel,
            createdAt: serverTimestamp()
        });
        const option = document.createElement("option");
        option.value = newCode;
        option.textContent = newCode;
        sectionSelect.appendChild(option);
        sectionSelect.value = newCode;
        showToast("Section added successfully.");
        addSectionModal.style.display = "none";
        newSectionInput.value = "";
    } catch (e) {
        console.error(e);
        showToast(`Failed to add section: ${e.message}`);
    }
});



document.getElementById("loadSubjectsBtn").addEventListener("click", loadSubjects);

async function loadSubjects() {
    const semester = Number(semesterSelect.value);
    const programCode = programSelect.value;
    const majorCode = majorSelect.value;
    const yearLevel = Number(yearLevelSelect.value);

    subjectBody.innerHTML = "";

    if (!semester || !programCode || !majorCode || !yearLevel) {
        showToast("Please complete all filters.");
        return;
    }

    try {
        const subjectQuery = query(
            collection(db, "prospectus"),
            where("programCode", "==", programCode),
            where("majorCode", "==", majorCode),
            where("yearLevel", "==", yearLevel),
            where("semester", "==", semester)
        );

        const snapshot = await getDocs(subjectQuery);

        if (snapshot.empty) {
            subjectBody.innerHTML = `
                <tr>
                    <td colspan="5">No subjects found.</td>
                </tr>
            `;
            return;
        }

        snapshot.forEach(doc => {
            const subject = doc.data();

            subjectBody.innerHTML += `
                <tr
                    data-subject-type="${escapeHtml(subject.subjectType || "")}"
                    data-meeting-type="${escapeHtml(subject.meetingType || "")}"
                    data-required-room-type="${escapeHtml(subject.requiredRoomType || "")}"
                >
                    <td>${escapeHtml(subject.subjectCode)}</td>
                    <td>${escapeHtml(subject.subjectName)}</td>
                    <td>${subject.units}</td>
                    <td>${subject.lecHours}</td>
                    <td>${subject.labHours}</td>
                </tr>
            `;
        });
    } catch (error) {
        console.error(error);
        showToast(`Could not load subjects: ${error.message}`);
    }
}

document.querySelector(".close-modal").addEventListener("click", () => {
    modal.style.display = "none";
});

window.addEventListener("click", event => {
    if (event.target === modal) {
        modal.style.display = "none";
    }
});

document.getElementById("generateBtn").addEventListener("click", generateSchedule);

async function generateSchedule() {
    const section = sectionSelect.value;

    if (!section) {
        showToast("Please select a section.");
        return;
    }

    const subjectRows = [...subjectBody.querySelectorAll("tr")]
        .filter(row => row.querySelectorAll("td").length === 5);

    if (!subjectRows.length) {
        showToast("Please load subjects first.");
        return;
    }

    /* Show the generating overlay and disable the button while the
       scheduling algorithm is running. */
    generatingOverlay.style.display = "flex";
    generateBtn.disabled = true;

    try {
        let rooms;

        try {
            const roomSnapshot = await getDocs(collection(db, "rooms"));
            rooms = roomSnapshot.docs.map(doc => doc.data());
        } catch (error) {
            showToast(`Could not load rooms: ${error.message}`);
            return;
        }

    const timetable = {
        Monday: [],
        Tuesday: [],
        Wednesday: [],
        Thursday: [],
        Friday: []
    };

    const academicYearInput = document.getElementById("academicYear");
    const currentAcademicYear = academicYearInput.value.trim();
    const currentSemester = semesterSelect.options[semesterSelect.selectedIndex].text;
    const savedBookings = getSavedBookings(currentAcademicYear, currentSemester);

    const subjects = subjectRows.map(row => {
        const cells = row.querySelectorAll("td");

        return {
            code: cells[0].textContent.trim(),
            name: cells[1].textContent.trim(),
            units: Number(cells[2].textContent),
            subjectType: row.dataset.subjectType || "",
            meetingType: (row.dataset.meetingType || "").toLowerCase(),
            requiredRoomType: normalizeRoomType(
                row.dataset.requiredRoomType || ""
            )
        };
    }).sort((first, second) => {
        /* Schedule activity/gymnasium subjects FIRST so they secure a
           gymnasium slot before other classes fill the timetable. */
        const firstActivity =
            /activity|gym/.test(first.meetingType) ||
            first.requiredRoomType === "Gymnasium";
        const secondActivity =
            /activity|gym/.test(second.meetingType) ||
            second.requiredRoomType === "Gymnasium";

        if (firstActivity !== secondActivity) {
            return firstActivity ? -1 : 1;
        }

        return second.units - first.units;
    });

    const output = [];

    function roomIsTaken(room, day, time, allowGymSharing = false) {
        const matchingBookings = savedBookings.filter(booking =>
            booking.day === day &&
            booking.time &&
            timesOverlap(booking.time, time) &&
            (
                booking.roomCode === room.roomCode ||
                booking.room === room.roomCode ||
                booking.room === room.roomName
            )
        );

        /* The gymnasium is assigned one section per slot by default so each
           section fills a unique Monday-Friday slot first. When no unique
           slot is available, the fallback enables allowGymSharing, which lets
           a SECOND section join the same day/time (never more than two). */
        if (room.roomType === "Gymnasium") {
            return allowGymSharing
                ? matchingBookings.length >= 2
                : matchingBookings.length > 0;
        }

        /* Lecture rooms and laboratories can hold only one course. */
        return matchingBookings.length > 0;
    }

    function selectBestRoom(availableRooms, requiredRoomType, prog) {
        if (!availableRooms || availableRooms.length === 0) return null;
        if (requiredRoomType !== "Lecture Room") {
            return availableRooms[Math.floor(Math.random() * availableRooms.length)];
        }

        /* Group available lecture rooms by building priority */
        const priorityGroups = {};
        for (const r of availableRooms) {
            const p = getBuildingPriority(r.building, prog);
            if (!priorityGroups[p]) priorityGroups[p] = [];
            priorityGroups[p].push(r);
        }

        const bestPriority = Math.min(...Object.keys(priorityGroups).map(Number));
        const bestRooms = priorityGroups[bestPriority] || [];

        if (bestRooms.length > 0) {
            return bestRooms[Math.floor(Math.random() * bestRooms.length)];
        }
        return availableRooms[0];
    }

    /**
     * Finds the best available time slot and room for a single meeting on a given day.
     */
    function findBestMeetingSlotAndRoom(
        day,
        reqRoomType,
        slots,
        timetableInstance,
        prog
    ) {
        const candidateSlots = slots.filter(time => {
            const range = parseTimeRange(time);
            if (!range) return false;
            // Empty day must start at 7:30 AM (start === 450)
            if (timetableInstance[day].length === 0 && range.start !== 450) return false;
            return true;
        }).sort((s1, s2) => {
            const gap1 = calculateDayPlacementVacantPenalty(timetableInstance[day], s1);
            const gap2 = calculateDayPlacementVacantPenalty(timetableInstance[day], s2);
            if (gap1 !== gap2) return gap1 - gap2;
            const start1 = parseTimeRange(s1)?.start || 0;
            const start2 = parseTimeRange(s2)?.start || 0;
            return start1 - start2;
        });

        for (const time of candidateSlots) {
            // 1. Section conflict check on this day
            const conflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
            if (conflict) continue;

            // 2. Vacant gap check
            if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

            // 3. Room availability check
            const availableRooms = rooms.filter(room => {
                if (room.roomType !== reqRoomType) return false;
                return (
                    !timetableInstance[day].some(item =>
                        item.roomCode === room.roomCode && timesOverlap(item.time, time)
                    ) &&
                    !roomIsTaken(room, day, time)
                );
            });
            if (availableRooms.length === 0) continue;

            const room = selectBestRoom(availableRooms, reqRoomType, prog);
            if (room) {
                return { time, room };
            }
        }

        return null;
    }

    /**
     * Finds flexible multi-day assignment for two-meeting subjects:
     * - Schedules the two meetings on TWO DISTINCT DAYS across Mon-Fri
     * - Allows independent, non-synchronized time slots to prevent room deadlocks
     * - Balances section load across days and respects vacant gap limits
     */
    function findAvailableTwoMeetingAssignment(
        meetings,
        slots,
        subject,
        timetableInstance
    ) {
        const [reqRoomType1, reqRoomType2] = meetings;
        const prog = programSelect.value;

        // Generate all distinct day pairs from days ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
        const allDayPairs = [];
        for (let i = 0; i < days.length; i++) {
            for (let j = i + 1; j < days.length; j++) {
                allDayPairs.push([days[i], days[j]]);
            }
        }

        // Sort candidate day pairs by total section load to balance days evenly across Mon-Fri
        const candidateDayPairs = allDayPairs.sort((a, b) => {
            const loadA = (timetableInstance[a[0]]?.length || 0) + (timetableInstance[a[1]]?.length || 0);
            const loadB = (timetableInstance[b[0]]?.length || 0) + (timetableInstance[b[1]]?.length || 0);
            if (loadA !== loadB) return loadA - loadB;

            const diffA = Math.abs((timetableInstance[a[0]]?.length || 0) - (timetableInstance[a[1]]?.length || 0));
            const diffB = Math.abs((timetableInstance[b[0]]?.length || 0) - (timetableInstance[b[1]]?.length || 0));
            if (diffA !== diffB) return diffA - diffB;

            return Math.random() - 0.5;
        });

        for (const [day1, day2] of candidateDayPairs) {
            // Meeting 1 on day1
            const m1 = findBestMeetingSlotAndRoom(day1, reqRoomType1, slots, timetableInstance, prog);
            if (!m1) continue;

            // Meeting 2 on day2
            const m2 = findBestMeetingSlotAndRoom(day2, reqRoomType2, slots, timetableInstance, prog);
            if (!m2) continue;

            return {
                day1,
                time1: m1.time,
                room1: m1.room,
                day2,
                time2: m2.time,
                room2: m2.room
            };
        }

        // Try reversing day assignment if room types differ (e.g. Lecture + Laboratory)
        if (reqRoomType1 !== reqRoomType2) {
            for (const [day1, day2] of candidateDayPairs) {
                const m1 = findBestMeetingSlotAndRoom(day2, reqRoomType1, slots, timetableInstance, prog);
                if (!m1) continue;
                const m2 = findBestMeetingSlotAndRoom(day1, reqRoomType2, slots, timetableInstance, prog);
                if (!m2) continue;

                return {
                    day1: day2,
                    time1: m1.time,
                    room1: m1.room,
                    day2: day1,
                    time2: m2.time,
                    room2: m2.room
                };
            }
        }

        return null;
    }

    /**
     * Finds an assignment for single-meeting subjects (Research, Activity/Gymnasium).
     * Respects vacant gap limit and gym constraints.
     * Starts empty days at 7:30 AM (450) or 8:00 AM (480 for activity).
     */
    function findAvailableSingleAssignment(
        requiredRoomType,
        slots,
        subject,
        timetableInstance,
        activityDays
    ) {
        const isActivity = /activity|gym/.test(subject.meetingType) || requiredRoomType === "Gymnasium";
        const prog = programSelect.value;

        // For Activity, prefer Wednesday when days are empty to keep Mon/Thu & Tue/Fri pairs aligned
        const candidateDays = [...days].sort((a, b) => {
            const loadA = timetableInstance[a]?.length || 0;
            const loadB = timetableInstance[b]?.length || 0;
            if (loadA !== loadB) return loadA - loadB;
            if (isActivity) {
                if (a === "Wednesday") return -1;
                if (b === "Wednesday") return 1;
            }
            return Math.random() - 0.5;
        });

        for (const day of candidateDays) {
            if (isActivity && activityDays instanceof Set && activityDays.has(day)) continue;

            const candidateSlots = slots.filter(time => {
                const range = parseTimeRange(time);
                if (!range) return false;
                if (isActivity) {
                    if (timetableInstance[day].length === 0 && range.start !== 480) return false;
                } else {
                    if (timetableInstance[day].length === 0 && range.start !== 450) return false;
                }
                return true;
            }).sort((s1, s2) => {
                const gap1 = calculateDayPlacementVacantPenalty(timetableInstance[day], s1);
                const gap2 = calculateDayPlacementVacantPenalty(timetableInstance[day], s2);
                if (gap1 !== gap2) return gap1 - gap2;
                const start1 = parseTimeRange(s1)?.start || 0;
                const start2 = parseTimeRange(s2)?.start || 0;
                return start1 - start2;
            });

            for (const time of candidateSlots) {
                const sectionConflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
                if (sectionConflict) continue;

                if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

                const availableRooms = rooms.filter(room => {
                    if (room.roomType !== requiredRoomType) return false;
                    return (
                        !timetableInstance[day].some(item =>
                            item.roomCode === room.roomCode && timesOverlap(item.time, time)
                        ) &&
                        !roomIsTaken(room, day, time)
                    );
                });

                if (availableRooms.length > 0) {
                    const room = selectBestRoom(availableRooms, requiredRoomType, prog);
                    if (room) {
                        return { day, time, room };
                    }
                }
            }
        }

        // Fallback for Gymnasium with sharing enabled if needed
        if (isActivity) {
            for (const day of candidateDays) {
                if (activityDays instanceof Set && activityDays.has(day)) continue;
                const candidateSlots = slots.filter(time => {
                    const range = parseTimeRange(time);
                    if (!range) return false;
                    if (timetableInstance[day].length === 0 && range.start !== 480) return false;
                    return true;
                }).sort((s1, s2) => {
                    const start1 = parseTimeRange(s1)?.start || 0;
                    const start2 = parseTimeRange(s2)?.start || 0;
                    return start1 - start2;
                });

                for (const time of candidateSlots) {
                    const sectionConflict = timetableInstance[day].some(item => timesOverlap(item.time, time));
                    if (sectionConflict) continue;
                    if (!isVacantGapAcceptable(timetableInstance[day], time)) continue;

                    const gym = rooms.find(r => r.roomType === "Gymnasium");
                    if (gym && !roomIsTaken(gym, day, time, true)) {
                        return { day, time, room: gym };
                    }
                }
            }
        }

        return null;
    }

    let scheduleSuccess = false;
    let finalOutput = [];
    let lastFailureReason = "";
    const MAX_SOLVER_ATTEMPTS = 20;

    for (let attempt = 1; attempt <= MAX_SOLVER_ATTEMPTS; attempt++) {
        const timetableInstance = {
            Monday: [],
            Tuesday: [],
            Wednesday: [],
            Thursday: [],
            Friday: []
        };

        const currentOutput = [];
        const activityDays = new Set();
        let attemptFailed = false;

        for (const subject of subjects) {
            const isActivity =
                /activity|gym/.test(subject.meetingType) ||
                subject.requiredRoomType === "Gymnasium";
            const isLectureLab = /lecture.*lab|lab.*lecture/.test(subject.meetingType);
            const isMajor = subject.subjectType.toLowerCase() === "major";
            const isResearch = /^RES\d/i.test(subject.code);

            const slots = isResearch
                ? majorSlots
                : isActivity
                    ? activitySlots
                    : (isLectureLab || isMajor ? majorSlots : minorSlots);

            const meetings = isResearch
                ? [subject.requiredRoomType]
                : isActivity
                    ? ["Gymnasium"]
                    : isMajor
                        ? ["Lecture Room", subject.requiredRoomType]
                        : isLectureLab
                            ? ["Lecture Room", subject.requiredRoomType]
                            : isLabRoomType(subject.requiredRoomType)
                                ? ["Lecture Room", subject.requiredRoomType]
                                : [subject.requiredRoomType, subject.requiredRoomType];

            if (meetings.length === 2) {
                const result = findAvailableTwoMeetingAssignment(
                    meetings,
                    slots,
                    subject,
                    timetableInstance
                );

                if (!result) {
                    lastFailureReason = `No available day/time slot found for ${subject.code} (${subject.name}).`;
                    attemptFailed = true;
                    break;
                }

                timetableInstance[result.day1].push({
                    time: result.time1,
                    roomCode: result.room1.roomCode
                });
                timetableInstance[result.day2].push({
                    time: result.time2,
                    roomCode: result.room2.roomCode
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day1,
                    time: result.time1,
                    room: result.room1.roomName || result.room1.roomCode,
                    roomCode: result.room1.roomCode
                });
                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day2,
                    time: result.time2,
                    room: result.room2.roomName || result.room2.roomCode,
                    roomCode: result.room2.roomCode
                });
            } else {
                const reqRoomType = meetings[0];
                const result = findAvailableSingleAssignment(
                    reqRoomType,
                    slots,
                    subject,
                    timetableInstance,
                    activityDays
                );

                if (!result) {
                    lastFailureReason = `No available day/time slot found for ${subject.code} (${subject.name}).`;
                    attemptFailed = true;
                    break;
                }

                if (isActivity) {
                    activityDays.add(result.day);
                }

                timetableInstance[result.day].push({
                    time: result.time,
                    roomCode: result.room.roomCode
                });

                currentOutput.push({
                    code: subject.code,
                    name: subject.name,
                    units: subject.units,
                    day: result.day,
                    time: result.time,
                    room: result.room.roomName || result.room.roomCode,
                    roomCode: result.room.roomCode
                });
            }
        }

        // Validate that every scheduled day starts at 7:30 AM (or 8:00 AM for activity)
        if (!attemptFailed && currentOutput.length > 0) {
            for (const day of days) {
                const dayClasses = timetableInstance[day];
                if (dayClasses && dayClasses.length > 0) {
                    const earliestClass = dayClasses.reduce((min, cur) => {
                        const startCur = parseTimeRange(cur.time)?.start ?? 9999;
                        const startMin = parseTimeRange(min.time)?.start ?? 9999;
                        return startCur < startMin ? cur : min;
                    }, dayClasses[0]);

                    const earliestStart = parseTimeRange(earliestClass.time)?.start;
                    const matchingOutput = currentOutput.find(o => o.day === day && o.time === earliestClass.time);
                    const matchingSubject = matchingOutput ? subjects.find(s => s.code === matchingOutput.code) : null;
                    const isActivitySubject = matchingSubject
                        ? (/activity|gym/.test(matchingSubject.meetingType) || matchingSubject.requiredRoomType === "Gymnasium")
                        : false;

                    const expectedStart = isActivitySubject ? 480 : 450; // 8:00 AM for activity, 7:30 AM for regular
                    if (earliestStart !== expectedStart) {
                        attemptFailed = true;
                        lastFailureReason = `Schedule on ${day} does not start at ${isActivitySubject ? "8:00 AM" : "7:30 AM"}.`;
                        break;
                    }
                }
            }
        }

        if (!attemptFailed && currentOutput.length > 0) {
            scheduleSuccess = true;
            finalOutput = currentOutput;
            break;
        }
    }

    if (!scheduleSuccess) {
        showToast(lastFailureReason || "Could not generate a complete schedule without conflicts.");
        return;
    }

    const aggregatedSchedule = [
        ...finalOutput.reduce((map, item) => {
            if (!map.has(item.code)) {
                map.set(item.code, {
                    code: item.code,
                    name: item.name,
                    units: item.units,
                    days: [],
                    times: [],
                    rooms: []
                });
            }

            const entry = map.get(item.code);

            entry.days.push(item.day);
            entry.times.push(item.time);
            entry.rooms.push(item.room);

            return map;
        }, new Map()).values()
    ].map(item => ({
        code: item.code,
        name: item.name,
        units: item.units,
        day: item.days.join(" / "),
        time: item.times.join(" / "),
        room: item.rooms.join(" / ")
    }));

    scheduleBody.innerHTML = scheduleRows(aggregatedSchedule);

    generatedSchedule = {
        id: crypto.randomUUID(),
        name: `${section}`,
        section,
        academicYear: currentAcademicYear,
        semester: currentSemester,
        program: programSelect.value,
        major: majorSelect.value,
        yearLevel: yearLevelSelect.options[yearLevelSelect.selectedIndex].text,
        createdAt: new Date().toISOString(),
        entries: aggregatedSchedule,
        rawEntries: finalOutput
    };

    saveScheduleBtn.disabled = false;

    document.getElementById("scheduleConflicts").innerHTML = `
        <div style="padding:8px 12px; background:#eef9f1; border-radius:6px; color:#155724; text-align:center;">
            Schedule generated successfully.
        </div>
    `;

    modal.style.display = "block";
    } finally {
        generatingOverlay.style.display = "none";
        generateBtn.disabled = false;
    }
}

saveScheduleBtn.addEventListener("click", async () => {
    if (!generatedSchedule || saveScheduleBtn.disabled) return;

    const setButtonLoading = () => {
        saveScheduleBtn.disabled = true;
        saveScheduleBtn.classList.add("loading");
        saveScheduleBtn.innerHTML = '<span class="btn-spinner"></span> Saving...';
    };

    const resetButtonState = () => {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.classList.remove("loading");
        saveScheduleBtn.innerHTML = 'Save Schedule';
    };

    const triggerButtonShake = () => {
        saveScheduleBtn.classList.add("btn-shake");
        setTimeout(() => saveScheduleBtn.classList.remove("btn-shake"), 450);
    };

    // 1. Immediately disable and set loading state
    setButtonLoading();

    try {
        /* Perform a fresh query against Firestore to check for existing saved schedules */
        const firestoreSchedules = await loadSchedulesFromFirestore();
        setSavedSchedules(firestoreSchedules);
        renderSavedSchedules();

        const schedules = firestoreSchedules;

        const existingIndex = schedules.findIndex(schedule =>
            (schedule.section || "").trim().toLowerCase() === (generatedSchedule.section || "").trim().toLowerCase() &&
            (schedule.academicYear || "").trim() === (generatedSchedule.academicYear || "").trim() &&
            (schedule.semester || "").trim().toLowerCase() === (generatedSchedule.semester || "").trim().toLowerCase()
        );

        if (existingIndex >= 0) {
            // Re-enable button while user reviews confirmation modal
            resetButtonState();

            const confirmed = await showConfirm(`A schedule for ${generatedSchedule.section} already exists for A.Y. ${generatedSchedule.academicYear}, ${generatedSchedule.semester}. Replace it?`);
            if (!confirmed) {
                return;
            }

            // Re-apply loading state for the save operation
            setButtonLoading();
        }

        /* Use the stable Firestore document ID as the schedule ID */
        const docId = scheduleDocId(generatedSchedule);
        generatedSchedule.id = docId;
        generatedSchedule.status = "active";

        const updatedSchedules = schedules.filter(s =>
            s.id !== docId && !(
                (s.section || "").trim().toLowerCase() === (generatedSchedule.section || "").trim().toLowerCase() &&
                (s.academicYear || "").trim() === (generatedSchedule.academicYear || "").trim() &&
                (s.semester || "").trim().toLowerCase() === (generatedSchedule.semester || "").trim().toLowerCase()
            )
        );
        updatedSchedules.unshift(generatedSchedule);

        /* Persist to Firestore */
        await saveScheduleToFirestore(generatedSchedule);
        console.log("Schedule saved to Firestore:", generatedSchedule.name);

        /* Update local storage and UI */
        setSavedSchedules(updatedSchedules);
        renderSavedSchedules();
        if (typeof renderArchive === "function") renderArchive();

        /* Close modal using smooth fade-out and scale-down animation */
        const modalContent = modal.querySelector(".modal-content");
        if (modalContent) modalContent.classList.add("scale-down");
        modal.classList.add("fade-out");

        setTimeout(() => {
            modal.style.display = "none";
            modal.classList.remove("fade-out");
            if (modalContent) modalContent.classList.remove("scale-down");
            resetButtonState();
        }, 300);

        /* Show the saved success overlay with checkmark animation */
        savedOverlay.classList.remove("fade-out");
        savedOverlay.style.display = "flex";

        setTimeout(() => {
            savedOverlay.classList.add("fade-out");
        }, 1200);

        setTimeout(() => {
            savedOverlay.style.display = "none";
            savedOverlay.classList.remove("fade-out");
        }, 1600);

    } catch (error) {
        console.error("Could not save schedule to Firestore:", error);
        resetButtonState();
        triggerButtonShake();
        showToast("Failed to save schedule. Please try again.");
    }
});

function renderSavedSchedules() {
    /* Only ACTIVE schedules are shown in Saved Schedules.
       Archived schedules are displayed in the Schedule Archive section below. */
    const schedules = getSavedSchedules().filter(
        schedule => (schedule.status || "active") !== "archived"
    );

    emptySavedSchedules.hidden = schedules.length > 0;

    savedSchedulesList.innerHTML = schedules.map(schedule => `
        <article style="margin-top:16px">
            <div class="section-header">
<div>
                    <h4 style="margin:0">${escapeHtml(schedule.name)}</h4>
                    <small>
                        ${escapeHtml(
                            [
                                schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
                                schedule.semester,
                                schedule.yearLevel
                            ].filter(Boolean).join(" • ")
                        )}
                    </small>
                </div>

                <button type="button" data-delete-schedule="${schedule.id}">
                    Delete
                </button>
            </div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Subject Code</th>
                            <th>Subject Name</th>
                            <th>Units</th>
                            <th>Day</th>
                            <th>Time</th>
                            <th>Room</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${scheduleRows(schedule.entries)}
                    </tbody>
                </table>
            </div>
        </article>
    `).join("");
}



savedSchedulesList.addEventListener("click", async event => {
    const scheduleId = event.target.dataset.deleteSchedule;

    if (!scheduleId) return;

    if (!await showConfirm("Delete this saved schedule?")) return;

    /* Find the schedule so we can compute its stable Firestore document ID */
    const schedules = getSavedSchedules();
    const schedule = schedules.find(item => item.id === scheduleId);

    /* Remove from localStorage */
    const remaining = schedules.filter(item => item.id !== scheduleId);
    setSavedSchedules(remaining);
    renderSavedSchedules();

    /* Also remove from Firestore using the stable document ID */
    const firestoreDocId = schedule ? scheduleDocId(schedule) : scheduleId;
    try {
        await deleteScheduleFromFirestore(firestoreDocId);
        console.log("Schedule deleted from Firestore:", firestoreDocId);
    } catch (error) {
        console.error("Could not delete schedule from Firestore:", error);
    }
});

/* Initialise: load saved schedules from Firestore into localStorage for
   the conflict checker, then render.  Firestore is the source of truth. */
(async function init() {
    const firestoreSchedules = await loadSchedulesFromFirestore();

    /* Merge any existing localStorage schedules so nothing is lost */
    const localSchedules = getSavedSchedules();
    const merged = [...firestoreSchedules];

    for (const local of localSchedules) {
        const docId = scheduleDocId(local);
        const exists = merged.some(item => item.id === docId);
        if (!exists) {
            merged.push({ ...local, id: docId });
        }
    }

    /* Sync back to localStorage so the conflict checker works */
    /* (Use the firestore doc id as the localStorage id for consistency) */
    setSavedSchedules(merged);
    renderSavedSchedules();
})();

document.getElementById("deleteAllBtn").addEventListener("click", async () => {
    /* Fetch fresh class schedule documents from Firestore */
    const firestoreSnapshot = await getDocs(collection(db, SCHEDULES_COLLECTION));
    const firestoreSchedules = firestoreSnapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
    }));

    const localSchedules = getSavedSchedules();

    /* Combine Firestore active schedules and local active schedules */
    const activeDocIds = new Set();
    firestoreSnapshot.docs.forEach(d => {
        if ((d.data().status || "active") !== "archived") {
            activeDocIds.add(d.id);
        }
    });

    localSchedules.forEach(s => {
        if ((s.status || "active") !== "archived") {
            if (s.id) activeDocIds.add(s.id);
            const docId = scheduleDocId(s);
            if (docId) activeDocIds.add(docId);
        }
    });

    if (activeDocIds.size === 0) {
        showToast("There are no active saved schedules to delete.");
        return;
    }

    const confirmed = await showConfirm(`Are you sure you want to delete all active saved schedule(s)? This action cannot be undone.`);
    if (!confirmed) {
        return;
    }

    /* Delete each active schedule document from Firestore using its document ID */
    const deletePromises = Array.from(activeDocIds).map(async docId => {
        try {
            await deleteScheduleFromFirestore(docId);
        } catch (error) {
            console.warn(`Could not delete schedule ${docId}:`, error);
        }
    });
    await Promise.all(deletePromises);

    /* Fetch updated list from Firestore after deletion and sync local storage */
    const remainingSchedules = await loadSchedulesFromFirestore();
    setSavedSchedules(remainingSchedules);
    renderSavedSchedules();
    if (typeof renderArchive === "function") renderArchive();

    showToast("All active saved schedules have been deleted successfully.");
});

document.getElementById("exportPdfBtn").addEventListener("click", async () => {
    const modal = document.getElementById("exportConfirmModal");
    modal.style.display = "flex";
    const confirmed = await new Promise(resolve => {
        const yesBtn = document.getElementById("exportConfirmYes");
        const noBtn = document.getElementById("exportConfirmNo");
        const cleanup = () => {
            yesBtn.removeEventListener("click", onYes);
            noBtn.removeEventListener("click", onNo);
        };
        const onYes = () => { cleanup(); modal.style.display = "none"; resolve(true); };
        const onNo = () => { cleanup(); modal.style.display = "none"; resolve(false); };
        yesBtn.addEventListener("click", onYes);
        noBtn.addEventListener("click", onNo);
    });
    if (!confirmed) return;

    /* Only ACTIVE schedules are eligible for archiving */
    const schedules = getSavedSchedules().filter(
        schedule => (schedule.status || "active") !== "archived"
    );

    if (!schedules.length) {
        showToast("There are no active saved schedules to archive.");
        return;
    }

    const archivedScheduleIds = new Set();
    const now = new Date().toISOString();

    for (const schedule of schedules) {
        const academicYear = schedule.academicYear || "";
        const semester = schedule.semester || "";
        const yearLevel = schedule.yearLevel || "";
        const filename = [
            academicYear ? `A.Y. ${academicYear}` : "A.Y.",
            semester
        ].filter(Boolean).join(" ");

        try {
            // Save report record to Firestore reports collection for archive history
            await saveReportToFirestore({
                category: "Class Schedule",
                academicYear,
                semester,
                yearLevel,
                title: schedule.name || schedule.section,
                section: schedule.section,
                filename,
                entries: schedule.entries || [],
                rawEntries: schedule.rawEntries || []
            });

            // Update status in classSchedules collection to archived
            await archiveScheduleInFirestore(schedule);
            archivedScheduleIds.add(schedule.id);
        } catch (error) {
            console.error("Could not archive schedule in Firestore:", schedule.name, error);
        }
    }

    const archivedSchedules = schedules.filter(schedule => archivedScheduleIds.has(schedule.id));
    const failedSchedules = schedules.filter(schedule => !archivedScheduleIds.has(schedule.id));

    if (archivedSchedules.length) {
        const allSchedules = getSavedSchedules();
        const updated = allSchedules.map(schedule =>
            archivedScheduleIds.has(schedule.id)
                ? { ...schedule, status: "archived", exportedAt: now }
                : schedule
        );
        setSavedSchedules(updated);
    }

    renderSavedSchedules();

    if (failedSchedules.length > 0) {
        showToast(
            `${archivedSchedules.length} schedule(s) moved to archive. ${failedSchedules.length} schedule(s) could not be archived.`
        );
    } else {
        showToast(
            `${archivedSchedules.length} schedule(s) moved to archive successfully.`
        );
    }
});

document.getElementById("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try {
        await signOut(auth);
    } catch (e) {
        console.error("Sign out error:", e);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("login.html");
});
