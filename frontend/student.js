import { auth, db } from "../firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    collection,
    getDoc,
    getDocs,
    doc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const classScheduleContainer = document.getElementById("classScheduleContainer");
const examScheduleContainer = document.getElementById("examScheduleContainer");
const classSearchInput = document.getElementById("classSearchInput");
const navStudentName = document.getElementById("navStudentName");
const navStudentProgramMajor = document.getElementById("navStudentProgramMajor");
const logoutBtn = document.getElementById("logoutBtn");

const PINNED_CLASS_KEY = "studentPinnedClassScheduleId";
const PINNED_EXAM_KEY = "studentPinnedExamScheduleId";

let allClassSchedules = [];
let allExamSchedules = [];
let classSearchTerm = "";

function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function normalize(value) {
    return String(value ?? "").trim().toUpperCase();
}

function formatAcademicInfo(schedule) {
    const parts = [
        schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
        schedule.semester ? `${schedule.semester}` : "",
        schedule.yearLevel ? `${schedule.yearLevel}` : ""
    ].filter(Boolean);

    return parts.join(" • ") || "Schedule";
}

function getPinnedClassId() {
    return localStorage.getItem(PINNED_CLASS_KEY) || "";
}

function setPinnedClassId(id) {
    if (id) {
        localStorage.setItem(PINNED_CLASS_KEY, id);
    } else {
        localStorage.removeItem(PINNED_CLASS_KEY);
    }
}

function getPinnedExamId() {
    return localStorage.getItem(PINNED_EXAM_KEY) || "";
}

function setPinnedExamId(id) {
    if (id) {
        localStorage.setItem(PINNED_EXAM_KEY, id);
    } else {
        localStorage.removeItem(PINNED_EXAM_KEY);
    }
}

function renderClassSchedules() {
    if (!allClassSchedules.length) {
        classScheduleContainer.innerHTML = '<div class="empty-state">No class schedules found for your program and major.</div>';
        return;
    }

    // 1. Filter by Section search term
    let filtered = allClassSchedules;
    if (classSearchTerm) {
        filtered = filtered.filter(schedule => {
            const sectionName = normalize(schedule.section || schedule.name || "");
            return sectionName.includes(classSearchTerm);
        });
    }

    if (!filtered.length) {
        classScheduleContainer.innerHTML = '<div class="empty-state">No class schedules match your section search.</div>';
        return;
    }

    // 2. Check pinning state
    const pinnedId = getPinnedClassId();
    const hasPinnedMatch = pinnedId && filtered.some(s => s.id === pinnedId);

    // If a schedule is pinned and present in filtered list, show ONLY the pinned schedule!
    const displayList = hasPinnedMatch ? filtered.filter(s => s.id === pinnedId) : filtered;

    classScheduleContainer.innerHTML = displayList.map(schedule => {
        const isPinned = schedule.id === pinnedId;
        const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

        const rows = entries.length
            ? entries.map(entry => `
                <tr>
                    <td data-label="Subject Code">${safe(entry.subjectCode || entry.code || "-")}</td>
                    <td data-label="Subject Name">${safe(entry.subjectName || entry.name || "-")}</td>
                    <td data-label="Units">${safe(entry.units || "-")}</td>
                    <td data-label="Day">${safe(entry.day || "-")}</td>
                    <td data-label="Time">${safe(entry.time || "-")}</td>
                    <td data-label="Room">${safe(entry.room || "-")}</td>
                </tr>
            `).join("")
            : `<tr><td colspan="6">No class entries available.</td></tr>`;

        return `
            <article class="schedule-card" data-id="${safe(schedule.id)}">
                <div class="schedule-header">
                    <div class="schedule-header-title">
                        <h4>${safe(schedule.section || schedule.name || "Class Schedule")}</h4>
                        <small>${safe(formatAcademicInfo(schedule))}</small>
                    </div>
                    <button type="button" class="pin-btn ${isPinned ? "pinned" : ""}" data-type="class" data-id="${safe(schedule.id)}">
                        ${isPinned ? "📌 Pinned" : "📌 Pin"}
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
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </article>
        `;
    }).join("");
}

function renderExamSchedules() {
    if (!allExamSchedules.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No exam schedules found for your program and major.</div>';
        return;
    }

    // Check pinning state
    const pinnedId = getPinnedExamId();
    const hasPinnedMatch = pinnedId && allExamSchedules.some(s => s.id === pinnedId);

    // If a schedule is pinned, show ONLY the pinned schedule!
    const displayList = hasPinnedMatch ? allExamSchedules.filter(s => s.id === pinnedId) : allExamSchedules;

    examScheduleContainer.innerHTML = displayList.map(schedule => {
        const isPinned = schedule.id === pinnedId;
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

        const rows = exams.length
            ? exams.map(exam => `
                <tr>
                    <td data-label="Code">${safe(exam.code || exam.subjectCode || "-")}</td>
                    <td data-label="Subject">${safe(exam.name || exam.subjectName || "-")}</td>
                    <td data-label="Day">${safe(exam.day || "-")}</td>
                    <td data-label="Time">${safe(exam.time || "-")}</td>
                    <td data-label="Room">${safe(exam.room || "-")}</td>
                </tr>
            `).join("")
            : `<tr><td colspan="5">No exam entries available.</td></tr>`;

        return `
            <article class="schedule-card" data-id="${safe(schedule.id)}">
                <div class="schedule-header">
                    <div class="schedule-header-title">
                        <h4>${safe(schedule.section || schedule.title || "Exam Schedule")}</h4>
                        <small>${safe(formatAcademicInfo(schedule))}</small>
                    </div>
                    <button type="button" class="pin-btn ${isPinned ? "pinned" : ""}" data-type="exam" data-id="${safe(schedule.id)}">
                        ${isPinned ? "📌 Pinned" : "📌 Pin"}
                    </button>
                </div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Code</th>
                                <th>Subject</th>
                                <th>Day</th>
                                <th>Time</th>
                                <th>Room</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </article>
        `;
    }).join("");
}

function handlePinToggle(event) {
    const btn = event.target.closest(".pin-btn");
    if (!btn) return;

    const type = btn.dataset.type;
    const id = btn.dataset.id;
    if (!type || !id) return;

    if (type === "class") {
        const currentPinned = getPinnedClassId();
        if (currentPinned === id) {
            setPinnedClassId("");
        } else {
            setPinnedClassId(id);
        }
        renderClassSchedules();
    } else if (type === "exam") {
        const currentPinned = getPinnedExamId();
        if (currentPinned === id) {
            setPinnedExamId("");
        } else {
            setPinnedExamId(id);
        }
        renderExamSchedules();
    }
}

async function initializeStudentDashboard() {
    onAuthStateChanged(auth, async user => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }

        try {
            const profileDoc = await getDoc(doc(db, "users", user.uid));
            if (!profileDoc.exists()) {
                window.location.href = "login.html";
                return;
            }

            const profile = profileDoc.data();
            const role = normalize(profile.role || "");
            if (role !== "STUDENT") {
                window.location.href = "login.html";
                return;
            }

            const program = normalize(profile.program || "");
            const major = normalize(profile.major || "");

            const fullName = profile.fullName || "Student";
            navStudentName.textContent = fullName;
            navStudentProgramMajor.textContent = `${profile.program || "Program"} • ${profile.major || "Major"}`;

            const classSnapshot = await getDocs(collection(db, "classSchedules"));
            const examSnapshot = await getDocs(collection(db, "examSchedules"));

            allClassSchedules = classSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => normalize(schedule.program) === program && normalize(schedule.major) === major);

            allExamSchedules = examSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => normalize(schedule.program) === program && normalize(schedule.major) === major);

            renderClassSchedules();
            renderExamSchedules();
        } catch (error) {
            console.error("Could not load student dashboard:", error);
            classScheduleContainer.innerHTML = '<div class="empty-state">Unable to load your schedules right now.</div>';
            examScheduleContainer.innerHTML = '<div class="empty-state">Unable to load your schedules right now.</div>';
        }
    });
}

if (classSearchInput) {
    classSearchInput.addEventListener("input", () => {
        classSearchTerm = normalize(classSearchInput.value);
        renderClassSchedules();
    });
}

classScheduleContainer.addEventListener("click", handlePinToggle);
examScheduleContainer.addEventListener("click", handlePinToggle);

logoutBtn.addEventListener("click", async () => {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Logout failed:", error);
    }
});

initializeStudentDashboard();
