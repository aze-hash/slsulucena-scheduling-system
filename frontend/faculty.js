import { auth, db } from "../firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    collection,
    getDoc,
    getDocs,
    doc,
    addDoc,
    query,
    where,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const classScheduleContainer = document.getElementById("classScheduleContainer");
const examScheduleContainer = document.getElementById("examScheduleContainer");
const classSearchInput = document.getElementById("classSearchInput");
const navFacultyName = document.getElementById("navFacultyName");
const navFacultyRole = document.getElementById("navFacultyRole");
const logoutBtn = document.getElementById("logoutBtn");

const rescheduleForm = document.getElementById("rescheduleForm");
const sectionSelect = document.getElementById("sectionSelect");
const reasonInput = document.getElementById("reasonInput");
const submitRequestBtn = document.getElementById("submitRequestBtn");
const requestStatus = document.getElementById("requestStatus");
const requestNotifications = document.getElementById("requestNotifications");

const rescheduleModal = document.getElementById("rescheduleModal");
const openRescheduleModalBtn = document.getElementById("openRescheduleModalBtn");
const closeRescheduleModalBtn = document.getElementById("closeRescheduleModalBtn");

const notificationsModal = document.getElementById("notificationsModal");
const openNotificationsModalBtn = document.getElementById("openNotificationsModalBtn");
const closeNotificationsModalBtn = document.getElementById("closeNotificationsModalBtn");
const notificationBadge = document.getElementById("notificationBadge");
const recentExamsBadge = document.getElementById("recentExamsBadge");

let currentFacultyName = "";
let currentFacultyUid = "";
let assignedExamSchedules = [];
let allClassSchedules = [];
let classSearchTerm = "";

function getScheduleTimestamp(schedule) {
    const raw = schedule.generatedAt || schedule.createdAt || schedule.updatedAt;
    if (!raw) return 0;
    if (raw.toDate) return raw.toDate().getTime();
    if (raw.seconds) return raw.seconds * 1000;
    if (raw instanceof Date) return raw.getTime();
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function watchUnreadExamSchedulesNotification(assignedSchedules, facultyUid) {
    if (!recentExamsBadge || !facultyUid || !assignedSchedules.length) {
        if (recentExamsBadge) recentExamsBadge.hidden = true;
        return;
    }

    onSnapshot(
        query(
            collection(db, "facultyScheduleNotifications"),
            where("facultyUid", "==", facultyUid)
        ),
        snapshot => {
            const viewedMap = {};
            snapshot.docs.forEach(d => {
                const data = d.data();
                if (data.scheduleId) {
                    viewedMap[data.scheduleId] = !!data.viewed;
                }
            });

            const hasUnread = assignedSchedules.some(s => !viewedMap[s.id]);
            recentExamsBadge.hidden = !hasUnread;
        },
        error => {
            console.error("Could not watch recent exam notifications:", error);
        }
    );
}

function safe(value) {
    const amp = String.fromCharCode(38);
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": amp + "amp;",
        "<": amp + "lt;",
        ">": amp + "gt;",
        '"': amp + "quot;",
        "'": amp + "#039;"
    }[char]));
}

function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
}

function formatAcademicInfo(schedule) {
    const parts = [
        schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
        schedule.semester ? `${schedule.semester}` : "",
        schedule.yearLevel ? `${schedule.yearLevel}` : ""
    ].filter(Boolean);

    return parts.join(" • ") || "Schedule";
}

function scheduleMatchesSearch(schedule, term) {
    if (!term) return true;

    const haystack = [
        schedule.name,
        schedule.section,
        schedule.program,
        schedule.major,
        schedule.academicYear,
        schedule.semester,
        schedule.yearLevel,
        ...(Array.isArray(schedule.entries) ? schedule.entries.flatMap(entry => [
            entry.subjectCode,
            entry.code,
            entry.subjectName,
            entry.name,
            entry.units,
            entry.day,
            entry.time,
            entry.room
        ]) : [])
    ].map(normalize).filter(Boolean).join(" ");

    return haystack.includes(term);
}

function renderClassSchedules(schedules) {
    const filtered = schedules.filter(schedule => scheduleMatchesSearch(schedule, classSearchTerm));

    if (!filtered.length) {
        classScheduleContainer.innerHTML = classSearchTerm
            ? '<div class="empty-state">No class schedules match your search.</div>'
            : '<div class="empty-state">No class schedules have been created yet.</div>';
        return;
    }

    classScheduleContainer.innerHTML = filtered.map(schedule => {
        const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

        const rows = entries.length
            ? entries.map(entry => `
                <tr>
                    <td>${safe(entry.subjectCode || entry.code || "-")}</td>
                    <td>${safe(entry.subjectName || entry.name || "-")}</td>
                    <td>${safe(entry.units || "-")}</td>
                    <td>${safe(entry.day || "-")}</td>
                    <td>${safe(entry.time || "-")}</td>
                    <td>${safe(entry.room || "-")}</td>
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

function formatExamDate(dateStr) {
    if (!dateStr) return "";
    const parts = String(dateStr).split("-");
    if (parts.length !== 3) return dateStr;
    const year = parts[0];
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
    return `${monthNames[month]} ${day}, ${year}`;
}

function getExamTypeTitle(schedule) {
    const rawType = schedule.examType || schedule.title || "Exam Schedule";
    const norm = normalize(rawType);
    let examName = rawType;
    if (!norm.includes("exam")) {
        if (norm === "preliminary" || norm === "prelim") examName = "Preliminary Examination";
        else if (norm === "midterm") examName = "Midterm Examination";
        else if (norm === "final" || norm === "finals") examName = "Final Examination";
    }

    const section = schedule.section ? schedule.section.trim() : "";
    if (section) {
        if (normalize(examName).includes(normalize(section))) {
            return examName;
        }
        return `${section} ${examName}`;
    }
    return examName;
}

function formatExamAcademicInfo(schedule) {
    const parts = [
        schedule.academicYear ? `A.Y. ${schedule.academicYear}` : "",
        schedule.semester ? `${schedule.semester}` : "",
        schedule.yearLevel ? `${schedule.yearLevel}` : ""
    ].filter(Boolean);

    return parts.join(" • ") || "Schedule";
}

function renderExamSchedules(schedules) {
    if (!schedules.length) {
        examScheduleContainer.innerHTML = '<div class="empty-state">No exam schedules are assigned to you as proctor.</div>';
        return;
    }

    examScheduleContainer.innerHTML = schedules.map(schedule => {
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
        const examDates = schedule.examDates || {};
        const proctor = schedule.proctor || "";
        const daySet = new Set(exams.map(exam => exam.day).filter(Boolean));
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
                groups[day] = examList.filter(exam => exam.day === day);
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

            const rows = dayExams.map(exam => `
                <tr>
                    <td>${safe(exam.time || "-")}</td>
                    <td>${safe(exam.code || exam.subjectCode || "-")} — ${safe(exam.name || exam.subjectName || "-")}</td>
                    <td>${safe(exam.room || "-")}</td>
                </tr>
            `).join("");

            dayTablesHtml += `
                <div class="exam-day-section">
                    <div class="exam-day-header">${safe(dayLabel)}</div>
                    <div class="table-container">
                        <table class="exam-pdf-style">
                            <thead>
                                <tr>
                                    <th>TIME</th>
                                    <th>SUBJECT</th>
                                    <th>ROOM</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        const examTypeTitle = getExamTypeTitle(schedule);
        const academicSubtext = formatExamAcademicInfo(schedule);

        return `
            <article class="schedule-card">
                <div class="schedule-header exam-schedule-header">
                    <div class="schedule-title-info">
                        <h4>${safe(examTypeTitle)}</h4>
                        <small>${safe(academicSubtext)}</small>
                    </div>
                    <div class="schedule-proctor">
                        <span>Proctor:</span>
                        <strong>${safe(proctor || "-")}</strong>
                    </div>
                </div>
                ${dayTablesHtml}
            </article>
        `;
    }).join("");
}

function showRequestStatus(message, type = "success") {
    requestStatus.hidden = false;
    requestStatus.textContent = message;
    requestStatus.className = `request-status ${type}`;
}

function populateSectionSelect() {
    const sections = [...new Set(assignedExamSchedules.map(schedule => schedule.section).filter(Boolean))];

    if (!sections.length) {
        sectionSelect.innerHTML = '<option value="">No sections assigned to you yet</option>';
        sectionSelect.disabled = true;
        return;
    }

    sectionSelect.disabled = false;
    sectionSelect.innerHTML = `
        <option value="">-- Select the section you are assigned to --</option>
        ${sections.map(section => `<option value="${safe(section)}">${safe(section)}</option>`).join("")}
    `;
}

function formatRequestDate(value) {
    if (!value) return "";
    if (value.toDate) {
        return value.toDate().toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric"
        });
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function renderRequestNotifications(requests) {
    const reviewed = requests
        .filter(request => {
            const status = normalize(request.status);
            return status === "approved" || status === "denied";
        })
        .sort((a, b) => {
            const aDate = a.reviewedAt?.toDate ? a.reviewedAt.toDate() : new Date(a.reviewedAt || 0);
            const bDate = b.reviewedAt?.toDate ? b.reviewedAt.toDate() : new Date(b.reviewedAt || 0);
            return bDate - aDate;
        });

    // Update the notification badge count
    if (reviewed.length) {
        notificationBadge.textContent = reviewed.length;
        notificationBadge.hidden = false;
    } else {
        notificationBadge.hidden = true;
    }

    if (!reviewed.length) {
        requestNotifications.innerHTML = '<div class="empty-state">No notifications yet.</div>';
        return;
    }

    requestNotifications.innerHTML = reviewed.map(request => {
        const status = normalize(request.status);
        const isApproved = status === "approved";
        const icon = isApproved ? "✓" : "✕";
        const title = isApproved ? "Request Approved" : "Request Denied";
        const message = isApproved
            ? `Your reschedule request for ${safe(request.section || "your section")} has been approved by the admin.`
            : `Your reschedule request for ${safe(request.section || "your section")} was denied by the admin.`;

        return `
            <div class="notification-item ${isApproved ? "notification-approved" : "notification-denied"}">
                <div class="notification-icon">${icon}</div>
                <div class="notification-content">
                    <strong>${title}</strong>
                    <p>${message}</p>
                    <small>${safe(formatRequestDate(request.reviewedAt || request.updatedAt))}</small>
                </div>
            </div>
        `;
    }).join("");
}

function watchRescheduleNotifications() {
    if (!currentFacultyUid) return;

    onSnapshot(
        query(
            collection(db, "rescheduleRequests"),
            where("facultyUid", "==", currentFacultyUid)
        ),
        snapshot => {
            const requests = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
            renderRequestNotifications(requests);
        },
        error => {
            console.error("Could not watch reschedule notifications:", error);
        }
    );
}

async function loadPendingRequests() {
    if (!currentFacultyUid) return [];

    try {
        const requestsQuery = query(
            collection(db, "rescheduleRequests"),
            where("facultyUid", "==", currentFacultyUid),
            where("status", "==", "pending")
        );
        const snapshot = await getDocs(requestsQuery);
        return snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
        console.error("Could not load pending requests:", error);
        return [];
    }
}

async function handleRescheduleSubmit(event) {
    event.preventDefault();

    const section = sectionSelect.value;
    const reason = reasonInput.value.trim();

    if (!section) {
        showRequestStatus("Please select a section.", "error");
        return;
    }

    if (!reason) {
        showRequestStatus("Please provide a reason for your unavailability.", "error");
        return;
    }

    const selectedSchedule = assignedExamSchedules.find(schedule => schedule.section === section);

    if (!selectedSchedule) {
        showRequestStatus("Could not find the selected section in your assigned exam schedules.", "error");
        return;
    }

    // Check if there is already a pending request for this section
    const pendingRequests = await loadPendingRequests();
    const alreadyPending = pendingRequests.some(request =>
        normalize(request.section) === normalize(section)
    );

    if (alreadyPending) {
        showRequestStatus(`You already have a pending reschedule request for ${section}. Please wait for the chairperson to review it.`, "error");
        return;
    }

    submitRequestBtn.disabled = true;
    submitRequestBtn.textContent = "Submitting...";

    try {
        const requestData = {
            facultyUid: currentFacultyUid,
            facultyName: currentFacultyName,
            section: section,
            reason: reason,
            examType: selectedSchedule.examType || "",
            examDates: selectedSchedule.examDates || {},
            examScheduleId: selectedSchedule.id || "",
            status: "pending",
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await addDoc(collection(db, "rescheduleRequests"), requestData);

        showRequestStatus(`Your reschedule request for ${section} has been submitted to the chairperson for review.`);
        rescheduleForm.reset();
        populateSectionSelect();
    } catch (error) {
        console.error("Could not submit reschedule request:", error);
        showRequestStatus(`Failed to submit your request: ${error.message}`, "error");
    } finally {
        submitRequestBtn.disabled = false;
        submitRequestBtn.textContent = "Submit Request";
    }
}

async function initializeFacultyDashboard() {
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
            if (normalize(profile.role || "") !== "faculty") {
                window.location.href = "login.html";
                return;
            }

            const fullName = profile.fullName || "Faculty";
            currentFacultyName = fullName;
            currentFacultyUid = user.uid;
            navFacultyName.textContent = fullName;
            navFacultyRole.textContent = "Instructor";

            const classSnapshot = await getDocs(collection(db, "classSchedules"));
            const examSnapshot = await getDocs(collection(db, "examSchedules"));

            allClassSchedules = classSnapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));

            const examSchedules = examSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => {
                    const matchesUid = schedule.proctorUid === user.uid ||
                                       schedule.facultyUid === user.uid ||
                                       schedule.assignedFacultyUid === user.uid;
                    const matchesName = normalize(schedule.proctor) === normalize(fullName);
                    return matchesUid || matchesName;
                });

            examSchedules.sort((a, b) => getScheduleTimestamp(b) - getScheduleTimestamp(a));
            assignedExamSchedules = examSchedules;

            renderClassSchedules(allClassSchedules);
            // Home page shows only the latest assigned exam schedule
            renderExamSchedules(assignedExamSchedules.slice(0, 1));
            populateSectionSelect();
            watchRescheduleNotifications();
            watchUnreadExamSchedulesNotification(assignedExamSchedules, currentFacultyUid);
        } catch (error) {
            console.error("Could not load faculty dashboard:", error);
            classScheduleContainer.innerHTML = '<div class="empty-state">Unable to load class schedules right now.</div>';
            examScheduleContainer.innerHTML = '<div class="empty-state">Unable to load exam schedules right now.</div>';
        }
    });
}

function openRescheduleModal() {
    rescheduleModal.hidden = false;
    requestStatus.hidden = true;
    requestStatus.textContent = "";
    requestStatus.className = "request-status";
}

function closeRescheduleModal() {
    rescheduleModal.hidden = true;
}

function openNotificationsModal() {
    notificationsModal.hidden = false;
}

function closeNotificationsModal() {
    notificationsModal.hidden = true;
}

openRescheduleModalBtn.addEventListener("click", openRescheduleModal);

closeRescheduleModalBtn.addEventListener("click", closeRescheduleModal);

rescheduleModal.addEventListener("click", event => {
    if (event.target === rescheduleModal) {
        closeRescheduleModal();
    }
});

openNotificationsModalBtn.addEventListener("click", openNotificationsModal);

closeNotificationsModalBtn.addEventListener("click", closeNotificationsModal);

notificationsModal.addEventListener("click", event => {
    if (event.target === notificationsModal) {
        closeNotificationsModal();
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        if (!rescheduleModal.hidden) {
            closeRescheduleModal();
        }
        if (!notificationsModal.hidden) {
            closeNotificationsModal();
        }
    }
});

classSearchInput.addEventListener("input", () => {
    classSearchTerm = normalize(classSearchInput.value);
    renderClassSchedules(allClassSchedules);
});

logoutBtn.addEventListener("click", async () => {
    try {
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Logout failed:", error);
    }
});

const mobileMenuToggleBtn = document.getElementById("mobileMenuToggleBtn");
const navUl = document.querySelector("nav ul");

if (mobileMenuToggleBtn && navUl) {
    mobileMenuToggleBtn.addEventListener("click", () => {
        navUl.classList.toggle("show");
        mobileMenuToggleBtn.textContent = navUl.classList.contains("show") ? "✕" : "☰";
    });
}

rescheduleForm.addEventListener("submit", handleRescheduleSubmit);

initializeFacultyDashboard();
