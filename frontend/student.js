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

import { renderExamCalendar } from "./js/schedule-calendar.js";

const examScheduleContainer = document.getElementById("examScheduleContainer");
const examSearchInput = document.getElementById("examSearchInput");
const navStudentName = document.getElementById("navStudentName");
const navStudentProgramMajor = document.getElementById("navStudentProgramMajor");
const logoutBtn = document.getElementById("logoutBtn");

const PINNED_EXAM_KEY = "studentPinnedExamScheduleId";

let allExamSchedules = [];
let examSearchTerm = "";

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

function renderExamSchedules() {
    if (!examScheduleContainer) return;

    if (!allExamSchedules.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No examination schedule has been released yet.</div>';
        return;
    }

    let filtered = allExamSchedules;

    // Filter by search term (section or subject)
    if (examSearchTerm) {
        filtered = filtered.filter(schedule => {
            const sectionName = normalize(schedule.section || schedule.title || "");
            return sectionName.includes(examSearchTerm);
        });
    }

    if (!filtered.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No examination schedules match your search.</div>';
        return;
    }

    // Pinning
    const pinnedId = getPinnedExamId();
    const hasPinnedMatch = pinnedId && filtered.some(s => s.id === pinnedId);
    const displayList = hasPinnedMatch ? filtered.filter(s => s.id === pinnedId) : filtered;

    const pinnedBanner = hasPinnedMatch
        ? `<div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; background:#e8f5e9; border:1px solid #c8e6c9; border-radius:8px; padding:8px 14px; font-size:13px; color:#1b5e20;">
               <span>📌 Showing your pinned examination schedule.</span>
               <button type="button" id="unpinShowAllExamBtn" style="background:none; border:none; color:#1565c0; font-weight:bold; cursor:pointer; text-decoration:underline;">Show all ${filtered.length} schedules</button>
           </div>`
        : "";

    examScheduleContainer.innerHTML = pinnedBanner + displayList.map(schedule => {
        const isPinned = schedule.id === pinnedId;
        const examType = schedule.examType ? ` — ${safe(schedule.examType)} Examination` : "";
        const calendarHtml = renderExamCalendar(schedule);

        return `
            <article class="schedule-card" data-id="${safe(schedule.id)}">
                <div class="schedule-header">
                    <div class="schedule-header-title">
                        <h4>${safe(schedule.section || schedule.title || "Exam Schedule")}${examType}</h4>
                        <small>${safe(formatAcademicInfo(schedule))}</small>
                    </div>
                    <button type="button" class="pin-btn ${isPinned ? "pinned" : ""}" data-id="${safe(schedule.id)}">
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

    const id = btn.dataset.id;
    if (!id) return;

    const currentPinned = getPinnedExamId();
    if (currentPinned === id) {
        setPinnedExamId("");
    } else {
        setPinnedExamId(id);
    }
    renderExamSchedules();
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
            if (navStudentName) navStudentName.textContent = fullName;
            if (navStudentProgramMajor) navStudentProgramMajor.textContent = `${profile.program || "Program"} • ${profile.major || "Major"}`;

            const examSnapshot = await getDocs(collection(db, "examSchedules"));

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
            console.log(`[Student Dashboard] Total exam schedules in DB: ${examSnapshot.docs.length}`);
            console.log(`[Student Dashboard] Matched exam schedules: ${allExamSchedules.length}`, allExamSchedules);

            renderExamSchedules();
        } catch (error) {
            console.error("Could not load student dashboard:", error);
            if (examScheduleContainer) {
                examScheduleContainer.innerHTML = '<div class="empty-state">Unable to load your schedules right now.</div>';
            }
        }
    });
}

if (examSearchInput) {
    examSearchInput.addEventListener("input", () => {
        examSearchTerm = normalize(examSearchInput.value);
        renderExamSchedules();
    });
}

if (examScheduleContainer) {
    examScheduleContainer.addEventListener("click", handlePinToggle);
}

logoutBtn?.addEventListener("click", async () => {
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
