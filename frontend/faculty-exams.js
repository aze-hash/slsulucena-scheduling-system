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
    setDoc,
    addDoc,
    query,
    where,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const recentExamSchedulesContainer = document.getElementById("recentExamSchedulesContainer");
const navFacultyName = document.getElementById("navFacultyName");
const navFacultyRole = document.getElementById("navFacultyRole");
const logoutBtn = document.getElementById("logoutBtn");
const recentExamsBadge = document.getElementById("recentExamsBadge");

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

let currentFacultyName = "";
let currentFacultyUid = "";
let assignedExamSchedules = [];
let viewedSchedulesMap = {};
let expandedScheduleIds = new Set();

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

function getScheduleTimestamp(schedule) {
    const raw = schedule.generatedAt || schedule.createdAt || schedule.updatedAt;
    if (!raw) return 0;
    if (raw.toDate) return raw.toDate().getTime();
    if (raw.seconds) return raw.seconds * 1000;
    if (raw instanceof Date) return raw.getTime();
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatExamGeneratedDate(schedule) {
    const raw = schedule.generatedAt || schedule.createdAt || schedule.updatedAt;
    if (!raw) return "";
    let dateObj = null;
    if (raw.toDate) {
        dateObj = raw.toDate();
    } else if (raw.seconds) {
        dateObj = new Date(raw.seconds * 1000);
    } else if (raw instanceof Date) {
        dateObj = raw;
    } else {
        dateObj = new Date(raw);
    }

    if (!dateObj || isNaN(dateObj.getTime())) return "";

    return dateObj.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
    });
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

function buildScheduleTablesHtml(schedule) {
    const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
    const examDates = schedule.examDates || {};
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

    return dayTablesHtml || '<div class="empty-state">No detailed exam timetable entries available.</div>';
}

async function markScheduleAsViewed(scheduleId) {
    if (!currentFacultyUid || !scheduleId) return;

    const docId = `${currentFacultyUid}_${scheduleId}`;
    viewedSchedulesMap[scheduleId] = true;

    try {
        await setDoc(doc(db, "facultyScheduleNotifications", docId), {
            facultyUid: currentFacultyUid,
            scheduleId: scheduleId,
            viewed: true,
            viewedAt: new Date()
        }, { merge: true });
    } catch (error) {
        console.error("Could not update viewed status in Firestore:", error);
    }
}

function updateNavbarBadge() {
    if (!recentExamsBadge) return;
    const hasUnread = assignedExamSchedules.some(schedule => !viewedSchedulesMap[schedule.id]);
    recentExamsBadge.hidden = !hasUnread;
}

function renderRecentExamSchedules() {
    if (!assignedExamSchedules.length) {
        recentExamSchedulesContainer.innerHTML = '<div class="empty-state">No new exam schedules are available.</div>';
        updateNavbarBadge();
        return;
    }

    const allViewed = assignedExamSchedules.every(schedule => viewedSchedulesMap[schedule.id]);
    updateNavbarBadge();

    const bannerHtml = allViewed
        ? '<div class="info-banner">ℹ️ You\'re viewing the latest available exam schedules.</div>'
        : '';

    const cardsHtml = assignedExamSchedules.map(schedule => {
        const isUnread = !viewedSchedulesMap[schedule.id];
        const generatedDate = formatExamGeneratedDate(schedule);
        const examType = schedule.examType || schedule.title || "Exam Schedule";
        const academicInfo = formatAcademicInfo(schedule);
        const section = schedule.section || "";
        const proctor = schedule.proctor || "";
        const isExpanded = expandedScheduleIds.has(schedule.id);

        const newBadgeHtml = isUnread ? '<span class="badge-card-new">NEW</span>' : '';
        const scheduleTables = isExpanded ? buildScheduleTablesHtml(schedule) : '';

        return `
            <article class="recent-exam-card" data-schedule-id="${safe(schedule.id)}">
                <div class="recent-exam-header-row">
                    <div class="recent-exam-title-group">
                        <span class="recent-exam-icon"></span>
                        <h3>${safe(examType)}</h3>
                        ${newBadgeHtml}
                    </div>
                </div>

                <div class="recent-exam-meta">
                    <span>📅 ${safe(academicInfo)}</span>
                    ${generatedDate ? `<span>Generated on ${safe(generatedDate)}</span>` : ""}
                    ${section ? `<span>Section: ${safe(section)}</span>` : ""}
                </div>

                <div class="recent-exam-actions">
                    <button class="view-schedule-btn" type="button" data-action="toggle-schedule" data-schedule-id="${safe(schedule.id)}">
                        ${isExpanded ? "Hide Schedule" : "View Schedule"}
                    </button>
                </div>

                ${isExpanded ? `<div class="recent-exam-table-container">${scheduleTables}</div>` : ""}
            </article>
        `;
    }).join("");

    recentExamSchedulesContainer.innerHTML = bannerHtml + cardsHtml;
}

recentExamSchedulesContainer.addEventListener("click", async event => {
    const toggleBtn = event.target.closest('button[data-action="toggle-schedule"]');
    if (!toggleBtn) return;

    const scheduleId = toggleBtn.getAttribute("data-schedule-id");
    if (!scheduleId) return;

    if (expandedScheduleIds.has(scheduleId)) {
        expandedScheduleIds.delete(scheduleId);
    } else {
        expandedScheduleIds.add(scheduleId);
        if (!viewedSchedulesMap[scheduleId]) {
            await markScheduleAsViewed(scheduleId);
        }
    }

    renderRecentExamSchedules();
});

function watchFacultyScheduleNotifications() {
    if (!currentFacultyUid) return;

    onSnapshot(
        query(
            collection(db, "facultyScheduleNotifications"),
            where("facultyUid", "==", currentFacultyUid)
        ),
        snapshot => {
            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                if (data.scheduleId) {
                    viewedSchedulesMap[data.scheduleId] = !!data.viewed;
                }
            });
            renderRecentExamSchedules();
        },
        error => {
            console.error("Could not listen to faculty schedule notifications:", error);
        }
    );
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

async function initializeFacultyExamsPage() {
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

            const examSnapshot = await getDocs(collection(db, "examSchedules"));

            const examSchedules = examSnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => {
                    // Check if generated/published (ignore draft/unpublished if explicit status exists)
                    const status = normalize(schedule.status || "generated");
                    const isValidStatus = status === "generated" || status === "published" || status === "active";
                    if (!isValidStatus) return false;

                    const matchesUid = schedule.proctorUid === user.uid ||
                                       schedule.facultyUid === user.uid ||
                                       schedule.assignedFacultyUid === user.uid;
                    const matchesName = normalize(schedule.proctor) === normalize(fullName);

                    return matchesUid || matchesName;
                });

            // Sort by generatedAt / createdAt / updatedAt descending (newest first)
            examSchedules.sort((a, b) => getScheduleTimestamp(b) - getScheduleTimestamp(a));
            assignedExamSchedules = examSchedules;

            populateSectionSelect();
            watchRescheduleNotifications();
            watchFacultyScheduleNotifications();
        } catch (error) {
            console.error("Could not load recent exam schedules page:", error);
            recentExamSchedulesContainer.innerHTML = '<div class="empty-state">Unable to load recent exam schedules right now.</div>';
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

initializeFacultyExamsPage();
