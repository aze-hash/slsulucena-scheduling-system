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

import { renderClassCalendar, renderExamCalendar } from "./js/schedule-calendar.js";

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
        classScheduleContainer.innerHTML = '<div class="empty-state">No class schedule has been released yet.</div>';
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

    const pinnedBanner = hasPinnedMatch
        ? `<div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; background:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; padding:8px 14px; font-size:13px; color:#1b5e20;">
               <span>📌 Showing your pinned schedule.</span>
               <button type="button" id="unpinShowAllClassBtn" style="background:none; border:none; color:#1565c0; font-weight:bold; cursor:pointer; text-decoration:underline;">Show all ${filtered.length} sections</button>
           </div>`
        : "";

    classScheduleContainer.innerHTML = pinnedBanner + displayList.map(schedule => {
        const isPinned = schedule.id === pinnedId;
        const calendarHtml = renderClassCalendar(schedule);

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
                ${calendarHtml}
            </article>
        `;
    }).join("");

    document.getElementById("unpinShowAllClassBtn")?.addEventListener("click", () => {
        setPinnedClassId("");
        renderClassSchedules();
    });
}


function renderExamSchedules() {
    if (!allExamSchedules.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No examination schedule has been released yet.</div>';
        return;
    }

    // Check pinning state
    const pinnedId = getPinnedExamId();
    const hasPinnedMatch = pinnedId && allExamSchedules.some(s => s.id === pinnedId);

    // If a schedule is pinned, show ONLY the pinned schedule!
    const displayList = hasPinnedMatch ? allExamSchedules.filter(s => s.id === pinnedId) : allExamSchedules;

    const pinnedBanner = hasPinnedMatch
        ? `<div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; background:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; padding:8px 14px; font-size:13px; color:#1b5e20;">
               <span>📌 Showing your pinned exam schedule.</span>
               <button type="button" id="unpinShowAllExamBtn" style="background:none; border:none; color:#1565c0; font-weight:bold; cursor:pointer; text-decoration:underline;">Show all ${allExamSchedules.length} schedules</button>
           </div>`
        : "";

    examScheduleContainer.innerHTML = pinnedBanner + displayList.map(schedule => {
        const isPinned = schedule.id === pinnedId;
        const examType = schedule.examType ? ` — ${safe(schedule.examType)}` : "";
        const calendarHtml = renderExamCalendar(schedule);

        return `
            <article class="schedule-card" data-id="${safe(schedule.id)}">
                <div class="schedule-header">
                    <div class="schedule-header-title">
                        <h4>${safe(schedule.section || schedule.title || "Exam Schedule")}${examType}</h4>
                        <small>${safe(formatAcademicInfo(schedule))}</small>
                    </div>
                    <button type="button" class="pin-btn ${isPinned ? "pinned" : ""}" data-type="exam" data-id="${safe(schedule.id)}">
                        ${isPinned ? "📌 Pinned" : "📌 Pin"}
                    </button>
                </div>
                ${calendarHtml}
            </article>
        `;
    }).join("");

    document.getElementById("unpinShowAllExamBtn")?.addEventListener("click", () => {
        setPinnedExamId("");
        renderExamSchedules();
    });
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
            window.location.replace("login.html");
            return;
        }

        try {
            const profileDoc = await getDoc(doc(db, "users", user.uid));
            if (!profileDoc.exists()) {
                window.location.replace("login.html");
                return;
            }

            const profile = profileDoc.data();
            const role = normalize(profile.role || "");
            if (role !== "STUDENT") {
                window.location.replace("login.html");
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
                .filter(schedule => {
                    const status = normalize(schedule.status);
                    const isPublished = status === "PUBLISHED" || status === "ACTIVE";
                    if (!isPublished) return false;

                    const schedProg = normalize(schedule.program || "");
                    const schedMaj = normalize(schedule.major || "");
                    const schedSec = normalize(schedule.section || schedule.name || "");

                    // Match program: direct match, or section contains program, or student has no program
                    const progMatches = !program || schedProg === program || schedSec.includes(program);
                    if (!progMatches) return false;

                    // Match major: if either is empty, or direct match, or section contains major
                    const majMatches = !major || !schedMaj || schedMaj === major || schedSec.includes(major);
                    return majMatches;
                });

            allExamSchedules = examSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => {
                    const status = normalize(schedule.status);
                    const isPublished = status === "PUBLISHED" || status === "ACTIVE";
                    if (!isPublished) return false;

                    const schedProg = normalize(schedule.program || "");
                    const schedMaj = normalize(schedule.major || "");
                    const schedSec = normalize(schedule.section || schedule.title || "");

                    const progMatches = !program || schedProg === program || schedSec.includes(program);
                    if (!progMatches) return false;

                    const majMatches = !major || !schedMaj || schedMaj === major || schedSec.includes(major);
                    return majMatches;
                });

            console.log(`[Student Dashboard] User: ${fullName}, Program: "${program}", Major: "${major}"`);
            console.log(`[Student Dashboard] Total class schedules in DB: ${classSnapshot.docs.length}`);
            console.log(`[Student Dashboard] Matched class schedules: ${allClassSchedules.length}`, allClassSchedules);
            console.log(`[Student Dashboard] Matched exam schedules: ${allExamSchedules.length}`, allExamSchedules);

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
    } catch (error) {
        console.error("Logout failed:", error);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("login.html");
});

initializeStudentDashboard();
