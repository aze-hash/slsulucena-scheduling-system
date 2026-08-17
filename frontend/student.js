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
const navStudentName = document.getElementById("navStudentName");
const navStudentProgramMajor = document.getElementById("navStudentProgramMajor");
const logoutBtn = document.getElementById("logoutBtn");

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

function renderClassSchedules(schedules) {
    if (!schedules.length) {
        classScheduleContainer.innerHTML = '<div class="empty-state">No class schedules found for your program and major.</div>';
        return;
    }

    classScheduleContainer.innerHTML = schedules.map(schedule => {
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
            <article class="schedule-card">
                <div class="schedule-header">
                    <h4>${safe(schedule.name || schedule.section || "Class Schedule")}</h4>
                    <small>${safe(formatAcademicInfo(schedule))}</small>
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

function renderExamSchedules(schedules) {
    if (!schedules.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No exam schedules found for your program and major.</div>';
        return;
    }

    examScheduleContainer.innerHTML = schedules.map(schedule => {
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
            <article class="schedule-card">
                <div class="schedule-header">
                    <h4>${safe(schedule.title || schedule.section || "Exam Schedule")}</h4>
                    <small>${safe(formatAcademicInfo(schedule))}</small>
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

            const classSchedules = classSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => normalize(schedule.program) === program && normalize(schedule.major) === major);

            const examSchedules = examSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => normalize(schedule.program) === program && normalize(schedule.major) === major);

            renderClassSchedules(classSchedules);
            renderExamSchedules(examSchedules);
        } catch (error) {
            console.error("Could not load student dashboard:", error);
            classScheduleContainer.innerHTML = '<div class="empty-state">Unable to load your schedules right now.</div>';
            examScheduleContainer.innerHTML = '<div class="empty-state">Unable to load your schedules right now.</div>';
        }
    });
}

logoutBtn.addEventListener("click", async () => {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Logout failed:", error);
    }
});

initializeStudentDashboard();
