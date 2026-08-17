import { db, auth } from "../firebase.js";
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
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
}

function timesOverlap(firstTime, secondTime) {
    const [firstStart, firstEnd] = firstTime.split("-").map(parseTime);
    const [secondStart, secondEnd] = secondTime.split("-").map(parseTime);

    return firstStart < secondEnd && secondStart < firstEnd;
}

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
       section fills a unique Monday-Friday slot first.  When no unique
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
function findAvailableAssignment(
    requiredRoomType,
    slots,
    excludedDays,
    preferredRoomCode = null,
    subject = null,
    activityDays = null
) {
    if (!(activityDays instanceof Set)) {
        activityDays = new Set(activityDays || []);
    }

    /* Shuffle days first so days with equal load are randomized across runs */
    const shuffledDays = [...days].sort(() => Math.random() - 0.5);
    const orderedDays = shuffledDays.sort(
        (first, second) =>
            (timetable[first] || []).length -
            (timetable[second] || []).length
    );

    for (const day of orderedDays) {
        if (excludedDays.has(day)) continue;

        /* A section may only use the gymnasium for one 2-hour
           activity meeting per day. */
        if (activityDays instanceof Set && activityDays.has(day)) continue;

        /* Randomize slot iteration order so each generation explores different valid times */
        const candidateSlots = [...slots].sort(() => Math.random() - 0.5);

        for (const time of candidateSlots) {
            const sectionConflict = timetable[day].some(item =>
                timesOverlap(item.time, time)
            );

            if (sectionConflict) continue;

            const availableRooms = rooms.filter(room => {
                // Direct match: room.roomType must equal requiredRoomType
                if (room.roomType !== requiredRoomType) {
                    return false;
                }

                return (
                    !timetable[day].some(item =>
                        item.roomCode === room.roomCode &&
                        timesOverlap(item.time, time)
                    ) &&
                    !roomIsTaken(room, day, time)
                );
            }).sort((a, b) => {
                /* Sort by building preference for Lecture Rooms only */
                if (requiredRoomType !== "Lecture Room") return 0;
                const prog = programSelect.value;
                return getBuildingPriority(a.building, prog) - getBuildingPriority(b.building, prog);
            });

            let room;
            if (preferredRoomCode) {
                room = availableRooms.find(item =>
                    item.roomCode === preferredRoomCode
                );
            }

            if (!room && availableRooms.length > 0) {
                if (requiredRoomType !== "Lecture Room") {
                    room = availableRooms[Math.floor(Math.random() * availableRooms.length)];
                } else {
                    /* Group available rooms by building priority */
                    const prog = programSelect.value;
                    const priorityGroups = {};

                    for (const r of availableRooms) {
                        const p = getBuildingPriority(r.building, prog);
                        if (!priorityGroups[p]) priorityGroups[p] = [];
                        priorityGroups[p].push(r);
                    }

                    /* Pick the highest-priority group (lowest priority number) */
                    const bestPriority = Math.min(
                        ...Object.keys(priorityGroups).map(Number)
                    );
                    const bestRooms = priorityGroups[bestPriority] || [];

                    /* Randomly select one room from the best group */
                    if (bestRooms.length > 0) {
                        room = bestRooms[Math.floor(Math.random() * bestRooms.length)];
                    } else {
                        continue;
                    }
                }
            }

            if (room) {
                return { day, time, room };
            }
        }
    }

    return null;
}

    /* Track the days this section already has an activity/gymnasium
       meeting so it never exceeds 2 hours of gym use in a single day
       (one 2-hour activity meeting per day, per section). */
    const activityDays = new Set();

    for (const subject of subjects) {
        const isActivity =
            /activity|gym/.test(subject.meetingType) ||
            subject.requiredRoomType === "Gymnasium";
        const isLectureLab = /lecture.*lab|lab.*lecture/.test(subject.meetingType);
        const isMajor = subject.subjectType.toLowerCase() === "major";

        /* Research subjects (RES01, RES02) have only 1 meeting per week, 3 hours */
        const isResearch = /^RES\d/i.test(subject.code);

        const slots = isResearch
            ? majorSlots       /* 3-hour slots for research */
            : isActivity
                ? activitySlots
                : (isLectureLab || isMajor ? majorSlots : minorSlots);

        /* Research subjects: only 1 meeting entry */
        /* Major subjects: first meeting in Lecture Room, second in its lab/room type */
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

        const assignedDays = [];

        for (const requiredRoomType of meetings) {
            const excludedDays = new Set();

            assignedDays.forEach(day => {
                const index = days.indexOf(day);

                if (days[index - 1]) excludedDays.add(days[index - 1]);
                excludedDays.add(day);
                if (days[index + 1]) excludedDays.add(days[index + 1]);
            });

let selected = findAvailableAssignment(
    requiredRoomType,
    slots,
    excludedDays,
    null,    // Do NOT reuse the same lecture room — scatter across buildings
    subject, // Pass the current subject for lab room matching
    isActivity ? (activityDays || []) : []
);

/* Fallback for activity/gymnasium subjects: only reached when no unique
   free slot exists on Monday-Friday.  Allow a SECOND section to share a
   gymnasium slot that already has exactly one section (never more than
   two sections at the same day and time). */
if (!selected && isActivity) {
    const gymDays = [...days].sort(() => Math.random() - 0.5);
    for (const day of gymDays) {
        if (excludedDays.has(day)) continue;
        if (activityDays.has(day)) continue;

        const candidateActivitySlots = [...activitySlots].sort(() => Math.random() - 0.5);
        for (const time of candidateActivitySlots) {
            const sectionConflict = timetable[day].some(item =>
                timesOverlap(item.time, time)
            );
            if (sectionConflict) continue;

            const gym = rooms.find(r => r.roomType === "Gymnasium");
            if (gym && !roomIsTaken(gym, day, time, true)) {
                selected = { day, time, room: gym };
                break;
            }
        }

        if (selected) break;
    }
}

            if (!selected) {
                showToast(
                    `No available day, time, and room is available for ${subject.code}.`
                );
                return;
            }

            assignedDays.push(selected.day);

            /* Record that this section already uses the gymnasium on this
               day so a second activity meeting cannot be placed there. */
            if (isActivity) {
                activityDays.add(selected.day);
            }

            timetable[selected.day].push({
                time: selected.time,
                roomCode: selected.room.roomCode
            });

            output.push({
                code: subject.code,
                name: subject.name,
                units: subject.units,
                day: selected.day,
                time: selected.time,
                room: selected.room.roomName || selected.room.roomCode,
                roomCode: selected.room.roomCode
            });
        }
    }

    const aggregatedSchedule = [
        ...output.reduce((map, item) => {
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
        rawEntries: output
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
    /* Only ACTIVE schedules are eligible for export + archiving.
       Archived schedules stay in the archive and are never re-exported here. */
    const schedules = getSavedSchedules().filter(
        schedule => (schedule.status || "active") !== "archived"
    );

    if (!schedules.length) {
        showToast("There are no active saved schedules to export.");
        return;
    }

    // Build absolute URL for the logo image
    const logoUrl = new URL('logo (1).png', window.location.href).href;
    const logoUrl1 = new URL('mainlogo1.png', window.location.href).href;

    // Shared printable CSS for each class schedule PDF
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

    // Build a standalone printable HTML document for each schedule
    const documents = schedules.map(schedule => {
        const academicYear = schedule.academicYear || "";
        const semester = schedule.semester || "";
        const yearLevel = schedule.yearLevel || "";
        const filename = [
            academicYear ? `A.Y. ${academicYear}` : "A.Y.",
            semester
        ].filter(Boolean).join(" ");

        const body = `
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
            <h1>${escapeHtml(schedule.name)}</h1>
            <p>${escapeHtml([academicYear ? `A.Y. ${academicYear}` : "", semester, yearLevel].filter(Boolean).join(" \u2022 "))}</p>
            <table>
                <thead><tr><th>Subject Code</th><th>Subject Name</th><th>Units</th><th>Day</th><th>Time</th><th>Room</th></tr></thead>
                <tbody>${scheduleRows(schedule.entries)}</tbody>
            </table>
        `;

        const html = `<!DOCTYPE html><html><head><title>${escapeHtml(filename)}</title>${printStyles}</head><body>${body}</body></html>`;

        return {
            schedule,
            html,
            filename,
            report: {
                category: "Class Schedule",
                academicYear,
                semester,
                yearLevel,
                title: schedule.name,
                filename,
                html
            }
        };
    });

    /* Open the print window first so we know the export UI will be available.
       If the browser blocks it we abort WITHOUT archiving anything. */
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
        showToast("The print window was blocked by the browser. No schedules were archived.");
        return;
    }

    /* Save each exported schedule to the Firestore reports collection (full history).
       Only schedules whose report is successfully saved count as exported. */
    const exportedScheduleIds = new Set();

    for (const doc of documents) {
        try {
            await saveReportToFirestore(doc.report);
            console.log("Report saved to Firestore:", doc.report.filename);
            exportedScheduleIds.add(doc.schedule.id);
        } catch (error) {
            console.error("Could not save report to Firestore for", doc.schedule.name, ":", error);
        }
    }

    /* Write the combined printable document to the print window,
       then print.  Content is written AFTER the reports are persisted so the
       export is only considered successful once every required step passed. */
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>All Section Schedules</title>
            ${printStyles}
            <style>
                .schedule-page { break-after: page; page-break-after: always; }
                .schedule-page:last-child { break-after: auto; page-break-after: auto; }
            </style>
        </head>
        <body>
            ${documents.map(doc => `
                <section class="schedule-page">
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
                    <h1>${escapeHtml(doc.schedule.name)}</h1>
                    <p>${escapeHtml([doc.schedule.academicYear ? `A.Y. ${doc.schedule.academicYear}` : "", doc.schedule.semester, doc.schedule.yearLevel].filter(Boolean).join(" \u2022 "))}</p>
                    <table>
                        <thead><tr><th>Subject Code</th><th>Subject Name</th><th>Units</th><th>Day</th><th>Time</th><th>Room</th></tr></thead>
                        <tbody>${scheduleRows(doc.schedule.entries)}</tbody>
                    </table>
                </section>
            `).join("")}
        </body>
        </html>
    `);

    printWindow.document.close();

    printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
    };

    /* Only mark schedules as ARCHIVED after their PDF export completed
       successfully.  Failed schedules stay ACTIVE so the admin can retry. */
    const exportedSchedules = schedules.filter(schedule => exportedScheduleIds.has(schedule.id));
    const failedSchedules = schedules.filter(schedule => !exportedScheduleIds.has(schedule.id));

    if (exportedSchedules.length) {
        const now = new Date().toISOString();
        const allSchedules = getSavedSchedules();

        /* Update Firestore first (authoritative), then localStorage. */
        for (const schedule of exportedSchedules) {
            try {
                await archiveScheduleInFirestore(schedule);
            } catch (error) {
                console.error("Could not archive schedule in Firestore:", schedule.name, error);
            }
        }

        const updated = allSchedules.map(schedule =>
            exportedScheduleIds.has(schedule.id)
                ? { ...schedule, status: "archived", exportedAt: now }
                : schedule
        );
        setSavedSchedules(updated);
    }

    renderSavedSchedules();

    if (failedSchedules.length > 0) {
        showToast(
            `${exportedSchedules.length} schedule(s) exported successfully. ${failedSchedules.length} schedule(s) could not be exported.`
        );
    } else {
        showToast(
            `${exportedSchedules.length} schedule(s) exported successfully and archived.`
        );
    }
});
