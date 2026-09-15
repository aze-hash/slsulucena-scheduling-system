import { auth, db } from "../firebase.js";
import { API_BASE_URL } from "./apiConfig.js";

import {
    onAuthStateChanged,
    signOut,
    verifyBeforeUpdateEmail,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    collection,
    getDoc,
    getDocs,
    updateDoc,
    doc,
    addDoc,
    query,
    where,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { renderExamCalendar, renderWeeklyExamCalendar } from "./js/schedule-calendar.js";

const examScheduleContainer = document.getElementById("examScheduleContainer");
const navFacultyName = document.getElementById("navFacultyName");
const navFacultyRole = document.getElementById("navFacultyRole");
const logoutBtn = document.getElementById("logoutBtn");

const rescheduleForm = document.getElementById("rescheduleForm");
const examSelect = document.getElementById("examSelect");
const examDetailsPreview = document.getElementById("examDetailsPreview") || document.getElementById("examJourneyPreview");
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
const markAllNotificationsReadBtn = document.getElementById("markAllNotificationsReadBtn");
const notificationBadge = document.getElementById("notificationBadge");
const recentExamsBadge = document.getElementById("recentExamsBadge");

/* Faculty Profile modal */
const navProfileBtn = document.getElementById("navProfileBtn");
const facultyProfileModal = document.getElementById("facultyProfileModal");
const closeProfileModalBtn = document.getElementById("closeProfileModalBtn");
const profileViewName = document.getElementById("profileViewName");
const profileViewFacultyId = document.getElementById("profileViewFacultyId");
const profileViewEmail = document.getElementById("profileViewEmail");

const profileEmailViewMode = document.getElementById("profileEmailViewMode");
const profileEditEmailBtn = document.getElementById("profileEditEmailBtn");
const profileEmailEditMode = document.getElementById("profileEmailEditMode");
const profileEditEmailInput = document.getElementById("profileEditEmailInput");
const profileReauthBox = document.getElementById("profileReauthBox");
const profilePasswordInput = document.getElementById("profilePasswordInput");
const profileSaveEmailBtn = document.getElementById("profileSaveEmailBtn");
const profileCancelEmailBtn = document.getElementById("profileCancelEmailBtn");

const profilePendingNotice = document.getElementById("profilePendingNotice");
const profilePendingEmailVal = document.getElementById("profilePendingEmailVal");
const profileCheckVerificationBtn = document.getElementById("profileCheckVerificationBtn");
const profileResendVerificationBtn = document.getElementById("profileResendVerificationBtn");
const profileCancelPendingBtn = document.getElementById("profileCancelPendingBtn");
const profileEmailMessage = document.getElementById("profileEmailMessage");

let currentFacultyName = "";
let currentFacultyUid = "";
let currentFacultyEmail = "";
let currentFacultyId = "";
let assignedExamSchedules = [];
let assignedExamsList = [];
let latestNotificationsList = [];

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
        examScheduleContainer.innerHTML = '<div class="empty-state">No examination schedule has been released yet.</div>';
        return;
    }

    // Flatten ONLY the exam subject entries assigned to this faculty member so
    // they can be shown together in one weekly calendar (same style as the
    // admin Proctoring dashboard's per-faculty calendar cards).
    const myExamSubjects = [];
    schedules.forEach(schedule => {
        const section = schedule.section || "Section Schedule";
        const examType = schedule.examType || "Exam";
        (Array.isArray(schedule.exams) ? schedule.exams : []).forEach(exam => {
            myExamSubjects.push({
                ...exam,
                section,
                examType,
                academicYear: schedule.academicYear || "",
                semester: schedule.semester || ""
            });
        });
    });

    const scheduleCardsHtml = schedules.map(schedule => {
        const proctor          = schedule.proctor || "";
        const examTypeTitle    = getExamTypeTitle(schedule);
        const academicSubtext  = formatExamAcademicInfo(schedule);
        const calendarHtml     = renderExamCalendar(schedule);

        return `
            <article class="schedule-card" data-schedule-id="${safe(schedule.id)}">
                <div class="schedule-header exam-schedule-header">
                    <div class="schedule-title-info">
                        <h4>${safe(examTypeTitle)}</h4>
                        <div class="schedule-sub-badges">
                            <span class="schedule-section-tag">Section: <strong>${safe(schedule.section || "-")}</strong></span>
                            <small>${safe(academicSubtext)}</small>
                        </div>
                    </div>
                    <div class="schedule-proctor">
                        <span>Proctor:</span>
                        <strong>${safe(proctor || "-")}</strong>
                    </div>
                </div>
                ${calendarHtml}
            </article>
        `;
    }).join("");

    const weeklyCalendarHtml = renderWeeklyExamCalendar(myExamSubjects);

    examScheduleContainer.innerHTML = `
        <div class="weekly-subject-summary" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:8px;">
            <h4 style="margin:0; font-size:15px; color:#1b5e20; font-weight:700;">My Assigned Exam Subjects</h4>
            <span style="font-size:12px; color:#666; font-weight:600;">${myExamSubjects.length} subject${myExamSubjects.length !== 1 ? "s" : ""} assigned to you</span>
        </div>
        ${weeklyCalendarHtml}
        <div class="section-schedules-heading" style="margin:22px 0 6px 0; padding-bottom:8px; border-bottom:2px solid #e8f5e9;">
            <h4 style="margin:0; font-size:15px; color:#1b5e20; font-weight:700;">Detailed Section Schedules</h4>
        </div>
        ${scheduleCardsHtml}
    `;
}

function showRequestStatus(message, type = "success") {
    requestStatus.hidden = false;
    requestStatus.textContent = message;
    requestStatus.className = `request-status ${type}`;
}

function isIndividualExamAssignedToFaculty(exam, schedule, userUid, facultyFullName) {
    if (!schedule) return false;

    // 1. Exam-level UID check
    if (exam.proctorUid && exam.proctorUid === userUid) {
        return true;
    }

    // 2. Exam-level Name check
    const normExamProctor = normalize(exam.proctor || "");
    const normFullName = normalize(facultyFullName || "");

    if (normExamProctor && normFullName) {
        if (normExamProctor === normFullName) return true;
        if (normExamProctor.includes(normFullName) || normFullName.includes(normExamProctor)) return true;

        const nameTokens = normFullName.split(/\s+/).filter(t => t.length > 2);
        if (nameTokens.length >= 2 && nameTokens.every(token => normExamProctor.includes(token))) {
            return true;
        }
    }

    // 3. Fallback: if exam has no specific proctor set, it inherits the schedule assignment
    if (!exam.proctorUid && !exam.proctor) {
        return isAssignedToCurrentFaculty(schedule, userUid, facultyFullName);
    }

    return false;
}

function populateExamSelect() {
    if (!examSelect) return;

    assignedExamsList = [];

    assignedExamSchedules.forEach(schedule => {
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
        const examType = schedule.examType || schedule.title || "Exam Schedule";

        exams.forEach(exam => {
            if (isIndividualExamAssignedToFaculty(exam, schedule, currentFacultyUid, currentFacultyName)) {
                const subjectCode = exam.code || exam.subjectCode || "N/A";
                const subjectName = exam.name || exam.subjectName || "N/A";
                const section = schedule.section || exam.section || "N/A";
                const examDay = exam.day || "";
                const rawDate = schedule.examDates?.[examDay] || exam.date || "";
                const formattedDate = rawDate ? formatExamDate(rawDate) : (examDay || "TBA");
                const examTime = exam.time || "TBA";
                const examRoom = exam.room || schedule.room || "TBA";
                const assignedProctor = exam.proctor || schedule.proctor || currentFacultyName || "TBA";

                assignedExamsList.push({
                    examScheduleId: schedule.id,
                    subjectCode,
                    subjectName,
                    section,
                    examType,
                    examDate: formattedDate,
                    rawDate,
                    examDay,
                    examTime,
                    examRoom,
                    assignedProctor
                });
            }
        });
    });

    if (!assignedExamsList.length) {
        examSelect.innerHTML = '<option value="">No exam assignments found for you</option>';
        examSelect.disabled = true;
        if (examDetailsPreview) {
            examDetailsPreview.hidden = true;
            examDetailsPreview.innerHTML = "";
        }
        return;
    }

    examSelect.disabled = false;
    examSelect.innerHTML = `
        <option value="">-- Select an exam assigned to you --</option>
        ${assignedExamsList.map((item, index) => `
            <option value="${index}">
                [${safe(item.subjectCode)}] ${safe(item.subjectName)} — ${safe(item.section)} (${safe(item.examType)} • ${safe(item.examDate)})
            </option>
        `).join("")}
    `;

    if (examDetailsPreview) {
        examDetailsPreview.hidden = true;
        examDetailsPreview.innerHTML = "";
    }
}

function handleExamChange() {
    if (!examDetailsPreview) return;

    const selectedIndex = examSelect.value;
    if (selectedIndex === "" || !assignedExamsList[selectedIndex]) {
        examDetailsPreview.hidden = true;
        examDetailsPreview.innerHTML = "";
        return;
    }

    const exam = assignedExamsList[selectedIndex];

    examDetailsPreview.hidden = false;
    examDetailsPreview.innerHTML = `
        <div class="exam-details-card">
            <div class="exam-details-card-header">
                Selected Exam Details
            </div>
            <div class="exam-details-grid">
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Subject Code</span>
                    <span class="exam-detail-value">${safe(exam.subjectCode)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Subject Name</span>
                    <span class="exam-detail-value">${safe(exam.subjectName)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Section</span>
                    <span class="exam-detail-value">${safe(exam.section)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Exam Type</span>
                    <span class="exam-detail-value">${safe(exam.examType)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Date</span>
                    <span class="exam-detail-value">${safe(exam.examDate)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Time</span>
                    <span class="exam-detail-value">${safe(exam.examTime)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Room</span>
                    <span class="exam-detail-value">${safe(exam.examRoom)}</span>
                </div>
                <div class="exam-detail-item">
                    <span class="exam-detail-label">Assigned Proctor</span>
                    <span class="exam-detail-value">${safe(exam.assignedProctor)}</span>
                </div>
            </div>
        </div>
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

function getReadNotificationIds() {
    if (!currentFacultyUid) return new Set();
    try {
        const raw = localStorage.getItem(`faculty_read_notifications_${currentFacultyUid}`);
        const parsed = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
        return new Set();
    }
}

function markNotificationAsRead(notificationId) {
    if (!currentFacultyUid || !notificationId) return;
    const readSet = getReadNotificationIds();
    readSet.add(notificationId);
    try {
        localStorage.setItem(
            `faculty_read_notifications_${currentFacultyUid}`,
            JSON.stringify(Array.from(readSet))
        );
    } catch (e) {
        console.error("Could not save read notification:", e);
    }
    renderRequestNotifications(latestNotificationsList);
}

function markAllNotificationsAsRead() {
    if (!currentFacultyUid || !latestNotificationsList.length) return;
    const readSet = getReadNotificationIds();
    latestNotificationsList.forEach(item => {
        if (item.id) readSet.add(item.id);
    });
    try {
        localStorage.setItem(
            `faculty_read_notifications_${currentFacultyUid}`,
            JSON.stringify(Array.from(readSet))
        );
    } catch (e) {
        console.error("Could not save all read notifications:", e);
    }
    renderRequestNotifications(latestNotificationsList);
}

function renderRequestNotifications(requests) {
    latestNotificationsList = requests || [];

    const reviewed = latestNotificationsList
        .filter(request => {
            const status = normalize(request.status);
            return status === "approved" || status === "denied";
        })
        .sort((a, b) => {
            const aDate = a.reviewedAt?.toDate ? a.reviewedAt.toDate() : new Date(a.reviewedAt || a.updatedAt || 0);
            const bDate = b.reviewedAt?.toDate ? b.reviewedAt.toDate() : new Date(b.reviewedAt || b.updatedAt || 0);
            return bDate - aDate;
        });

    const readSet = getReadNotificationIds();
    const unreadCount = reviewed.filter(r => !readSet.has(r.id)).length;

    // Update the notification badge count (if all read, hide number / badge)
    if (unreadCount > 0) {
        notificationBadge.textContent = unreadCount;
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
        const isReplacementFaculty = request.replacementFacultyId === currentFacultyUid && request.facultyUid !== currentFacultyUid;
        const isRead = readSet.has(request.id);
        const icon = isReplacementFaculty ? "📋" : (isApproved ? "✓" : "✕");
        const title = isReplacementFaculty 
            ? "New Proctoring Assignment" 
            : (isApproved ? "Reschedule Request Approved" : "Reschedule Request Denied");

        const subjectDesc = request.subjectCode
            ? `${request.subjectCode}${request.subjectName ? ` - ${request.subjectName}` : ""}`
            : (request.section || "exam schedule");

        let message = "";
        if (isReplacementFaculty) {
            message = `You have been assigned as replacement proctor for ${safe(subjectDesc)} (${safe(request.section || "")}).`;
        } else if (isApproved) {
            message = `Your reschedule request for ${safe(subjectDesc)} (${safe(request.section || "")}) has been approved. Reassigned to ${safe(request.replacementFacultyName || "replacement faculty")}.`;
        } else {
            message = `Your reschedule request for ${safe(subjectDesc)} (${safe(request.section || "")}) was denied by the admin.`;
        }

        return `
            <div class="notification-item ${isApproved ? "notification-approved" : "notification-denied"} ${isRead ? "notification-read" : "notification-unread"}"
                 data-request-id="${safe(request.id)}"
                 data-schedule-id="${safe(request.examScheduleId || "")}"
                 title="Click to mark as read">
                <div class="notification-icon">${icon}</div>
                <div class="notification-content">
                    <strong>${title}</strong>
                    <p>${message}</p>
                    <small>${safe(formatRequestDate(request.reviewedAt || request.updatedAt))}</small>
                </div>
            </div>
        `;
    }).join("");

    // Attach click listeners to notification items
    requestNotifications.querySelectorAll(".notification-item").forEach(item => {
        item.addEventListener("click", () => {
            const reqId = item.dataset.requestId;
            if (reqId) {
                markNotificationAsRead(reqId);
            }
            closeNotificationsModal();

            const scheduleId = item.dataset.scheduleId;
            if (scheduleId) {
                const targetCard = document.querySelector(`[data-schedule-id="${scheduleId}"]`);
                if (targetCard) {
                    targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
                    targetCard.style.outline = "3px solid var(--secondary)";
                    setTimeout(() => {
                        targetCard.style.outline = "";
                    }, 2500);
                }
            }
        });
    });
}

function watchRescheduleNotifications() {
    if (!currentFacultyUid) return;

    const myRequestsMap = new Map();
    const replacementRequestsMap = new Map();

    const updateCombinedNotifications = () => {
        const combined = new Map();
        myRequestsMap.forEach((val, key) => combined.set(key, val));
        replacementRequestsMap.forEach((val, key) => combined.set(key, val));
        renderRequestNotifications(Array.from(combined.values()));
    };

    onSnapshot(
        query(
            collection(db, "rescheduleRequests"),
            where("facultyUid", "==", currentFacultyUid)
        ),
        snapshot => {
            myRequestsMap.clear();
            snapshot.docs.forEach(docSnap => myRequestsMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
            updateCombinedNotifications();
        },
        error => {
            console.error("Could not watch reschedule notifications:", error);
        }
    );

    // Also watch requests where current faculty is assigned as replacement faculty
    onSnapshot(
        query(
            collection(db, "rescheduleRequests"),
            where("replacementFacultyId", "==", currentFacultyUid)
        ),
        snapshot => {
            replacementRequestsMap.clear();
            snapshot.docs.forEach(docSnap => replacementRequestsMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
            updateCombinedNotifications();
        },
        error => {
            console.error("Could not watch replacement reschedule notifications:", error);
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

    const selectedIndex = examSelect.value;
    const reason = reasonInput.value.trim();

    if (selectedIndex === "" || !assignedExamsList[selectedIndex]) {
        showRequestStatus("Please select an exam to reschedule.", "error");
        return;
    }

    if (!reason) {
        showRequestStatus("Please provide a reason for your unavailability.", "error");
        return;
    }

    const selectedExam = assignedExamsList[selectedIndex];

    // Check for duplicate pending requests for: facultyUid + examScheduleId + subjectCode + examType
    const pendingRequests = await loadPendingRequests();
    const alreadyPending = pendingRequests.some(request => {
        const matchesFaculty = (request.facultyUid === currentFacultyUid || request.requestingFacultyId === currentFacultyUid);
        const matchesSchedule = request.examScheduleId === selectedExam.examScheduleId;
        const matchesSubject = normalize(request.subjectCode || "") === normalize(selectedExam.subjectCode);
        const matchesType = normalize(request.examType || "") === normalize(selectedExam.examType);
        return matchesFaculty && matchesSchedule && matchesSubject && matchesType;
    });

    if (alreadyPending) {
        showRequestStatus("A reschedule request for this exam is already pending.", "error");
        return;
    }

    submitRequestBtn.disabled = true;
    submitRequestBtn.textContent = "Submitting...";

    try {
        const requestData = {
            facultyUid: currentFacultyUid,
            facultyName: currentFacultyName,
            subjectCode: selectedExam.subjectCode,
            subjectName: selectedExam.subjectName,
            section: selectedExam.section,
            examType: selectedExam.examType,
            examDate: selectedExam.examDate,
            examTime: selectedExam.examTime,
            examRoom: selectedExam.examRoom,
            examScheduleId: selectedExam.examScheduleId,
            reason: reason,
            status: "pending",
            createdAt: new Date(),
            updatedAt: new Date(),
            reviewedBy: null,
            reviewedAt: null,
            replacementFacultyId: null,
            replacementFacultyName: null,
            requestingFacultyId: currentFacultyUid,
            requestingFacultyName: currentFacultyName
        };

        await addDoc(collection(db, "rescheduleRequests"), requestData);

        showRequestStatus(`Your reschedule request for ${selectedExam.subjectCode} (${selectedExam.section}) has been submitted for review.`);
        rescheduleForm.reset();
        populateExamSelect();
    } catch (error) {
        console.error("Could not submit reschedule request:", error);
        showRequestStatus(`Failed to submit your request: ${error.message}`, "error");
    } finally {
        submitRequestBtn.disabled = false;
        submitRequestBtn.textContent = "Submit Request";
    }
}

function isAssignedToCurrentFaculty(schedule, userUid, facultyFullName) {
    if (!schedule) return false;

    // 1. Direct UID match (primary check)
    const matchesUid = schedule.proctorUid === userUid ||
                       schedule.facultyUid === userUid ||
                       schedule.assignedFacultyUid === userUid ||
                       (schedule.proctorUid && schedule.proctorUid.split(",").map(u => u.trim()).includes(userUid)) ||
                       (Array.isArray(schedule.exams) && schedule.exams.some(e => e.proctorUid === userUid));
    if (matchesUid) return true;

    // 2. Flexible name matching (handles titles/honorifics/formatting variations)
    const normProctor = normalize(schedule.proctor || "");
    const normFullName = normalize(facultyFullName || "");

    if (normProctor && normFullName) {
        if (normProctor === normFullName) return true;
        if (normProctor.includes(normFullName) || normFullName.includes(normProctor)) return true;

        const nameTokens = normFullName.split(/\s+/).filter(t => t.length > 2);
        if (nameTokens.length >= 2 && nameTokens.every(token => normProctor.includes(token))) {
            return true;
        }
    }

    if (Array.isArray(schedule.exams) && normFullName) {
        const matchesExamProctor = schedule.exams.some(e => {
            const ep = normalize(e.proctor || "");
            return ep && (ep === normFullName || ep.includes(normFullName) || normFullName.includes(ep));
        });
        if (matchesExamProctor) return true;
    }

    return false;
}

function watchAssignedExamSchedules(user, fullName) {
    onSnapshot(
        collection(db, "examSchedules"),
        snapshot => {
            const examSchedules = [];

            snapshot.docs.forEach(docSnap => {
                const schedule = { id: docSnap.id, ...docSnap.data() };
                const status = normalize(schedule.status || "generated");
                const isValidStatus = status === "generated" || status === "published" || status === "active";
                if (!isValidStatus) return;

                const allExams = Array.isArray(schedule.exams) ? schedule.exams : [];
                // STRICT isolation: ONLY exam subjects assigned specifically to THIS faculty account
                const myExams = allExams.filter(exam =>
                    isIndividualExamAssignedToFaculty(exam, schedule, user.uid, fullName)
                );

                // Only include the schedule if there is at least one subject assigned to this faculty
                if (myExams.length > 0) {
                    examSchedules.push({
                        ...schedule,
                        exams: myExams,
                        proctor: fullName
                    });
                }
            });

            examSchedules.sort((a, b) => getScheduleTimestamp(b) - getScheduleTimestamp(a));
            assignedExamSchedules = examSchedules;

            // Render ALL exam schedules with only subjects assigned to THIS faculty
            renderExamSchedules(assignedExamSchedules);
            populateExamSelect();
            watchUnreadExamSchedulesNotification(assignedExamSchedules, currentFacultyUid);
        },
        error => {
            console.error("Could not watch assigned exam schedules:", error);
            if (examScheduleContainer) {
                examScheduleContainer.innerHTML = '<div class="empty-state">Unable to load assigned exam schedules right now.</div>';
            }
        }
    );
}

function parseSlotDurationHours(timeRange) {
    if (!timeRange) return 1.5;
    const parts = timeRange.split("-");
    if (parts.length !== 2) return 1.5;

    const parseMinutes = (str) => {
        str = str.trim().toLowerCase();
        const isPM = str.includes("pm");
        const isAM = str.includes("am");
        const clean = str.replace(/[ap]m/g, "").trim();
        const [hStr, mStr] = clean.split(":");
        let h = parseInt(hStr, 10);
        let m = parseInt(mStr || "0", 10);
        if (isNaN(h)) return null;
        if (isNaN(m)) m = 0;
        if (isPM && h < 12) h += 12;
        if (isAM && h === 12) h = 0;
        return h * 60 + m;
    };

    const startMin = parseMinutes(parts[0]);
    const endMin = parseMinutes(parts[1]);
    if (startMin === null || endMin === null || endMin <= startMin) return 1.5;
    return (endMin - startMin) / 60;
}

function calculateWeeklyHours(dayStr, timeStr) {
    if (!timeStr) return 0;
    const days = String(dayStr || "").split(" / ").map(d => d.trim()).filter(Boolean);
    const times = String(timeStr || "").split(" / ").map(t => t.trim()).filter(Boolean);
    const count = Math.max(days.length, times.length, 1);

    let total = 0;
    for (let i = 0; i < count; i++) {
        const t = times[i] || times[0] || timeStr;
        total += parseSlotDurationHours(t);
    }
    return Math.round(total * 10) / 10;
}

function isClassEntryAssignedToFaculty(entry, userUid, fullName) {
    if (!entry) return false;
    if (userUid && entry.facultyId && String(entry.facultyId).trim() === String(userUid).trim()) {
        return true;
    }
    if (fullName && entry.facultyName) {
        const normEntry = normalize(entry.facultyName);
        const normUser = normalize(fullName);
        if (normEntry && normUser && (normEntry === normUser || normEntry.includes(normUser) || normUser.includes(normEntry))) {
            return true;
        }
    }
    return false;
}

function renderClassTeachingSchedules(assignedClasses) {
    if (!classTeachingScheduleContainer) return;

    if (!assignedClasses.length) {
        if (facultyWorkloadSummaryBadge) {
            facultyWorkloadSummaryBadge.innerHTML = `
                <span style="background:#e0e0e0; color:#555; font-size:12px; font-weight:600; padding:4px 10px; border-radius:999px;">
                    0 Units Assigned
                </span>
            `;
        }
        classTeachingScheduleContainer.innerHTML = `
            <div class="empty-state" style="padding:28px 16px; text-align:center; color:#666;">
                <div style="font-size:24px; margin-bottom:8px;">📚</div>
                <p style="margin:0; font-size:14px; font-weight:600; color:#333;">No class teaching assignments published yet.</p>
                <p style="margin:4px 0 0 0; font-size:12px; color:#777;">When exam schedules are published by your department Chairperson, your weekly classes will be displayed here.</p>
            </div>
        `;
        return;
    }

    // Calculate metrics
    let totalUnits = 0;
    let totalWeeklyHours = 0;
    const distinctSections = new Set();

    assignedClasses.forEach(item => {
        totalUnits += Number(item.units) || 0;
        totalWeeklyHours += calculateWeeklyHours(item.day, item.time);
        if (item.section) distinctSections.add(item.section);
    });

    totalWeeklyHours = Math.round(totalWeeklyHours * 10) / 10;

    // Load badge
    let loadBadgeStyle = "";
    let loadLabel = "";
    if (totalUnits <= 18) {
        loadBadgeStyle = "background:#e8f5e9; color:#1b5e20; border:1px solid #c8e6c9;";
        loadLabel = "✓ Normal Load";
    } else if (totalUnits <= 21) {
        loadBadgeStyle = "background:#fff3e0; color:#e65100; border:1px solid #ffe0b2;";
        loadLabel = "⚡ Overload";
    } else {
        loadBadgeStyle = "background:#ffebee; color:#c62828; border:1px solid #ffcdd2;";
        loadLabel = "⚠️ Over Capacity";
    }

    if (facultyWorkloadSummaryBadge) {
        facultyWorkloadSummaryBadge.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="${loadBadgeStyle} padding:4px 12px; border-radius:999px; font-weight:700; font-size:12px;">
                    ${loadLabel} (${totalUnits} Units)
                </span>
                <span style="background:#f1f8e9; color:#33691e; border:1px solid #dcedc8; padding:4px 10px; border-radius:999px; font-weight:600; font-size:12px;">
                    🕒 ${totalWeeklyHours} hrs/wk
                </span>
                <span style="background:#e8eaf6; color:#283593; border:1px solid #c5cae9; padding:4px 10px; border-radius:999px; font-weight:600; font-size:12px;">
                    👥 ${distinctSections.size} Section${distinctSections.size === 1 ? "" : "s"}
                </span>
            </div>
        `;
    }

    classTeachingScheduleContainer.innerHTML = `
        <div class="table-container" style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; margin-top:8px;">
                <thead>
                    <tr style="background:#f0f4ec; text-align:left;">
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Subject Code</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Subject Description</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6; text-align:center;">Units</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Section</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Day</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Time</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6;">Room</th>
                        <th style="padding:10px 12px; font-size:12px; border-bottom:2px solid #cbbfa6; text-align:center;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${assignedClasses.map(item => `
                        <tr style="border-bottom:1px solid #eee;">
                            <td style="padding:10px 12px; font-weight:bold; color:#1b5e20;">${safe(item.code)}</td>
                            <td style="padding:10px 12px;">${safe(item.name)}</td>
                            <td style="padding:10px 12px; text-align:center; font-weight:600;">${safe(item.units)}</td>
                            <td style="padding:10px 12px;"><span style="background:#f5f5f5; border:1px solid #ddd; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:600;">${safe(item.section)}</span></td>
                            <td style="padding:10px 12px;">${safe(item.day)}</td>
                            <td style="padding:10px 12px;">${safe(item.time)}</td>
                            <td style="padding:10px 12px; font-weight:600;">${safe(item.room)}</td>
                            <td style="padding:10px 12px; text-align:center;">
                                ${item.status === "published"
                                    ? `<span style="background:#e8f5e9; color:#1b5e20; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px;">✓ Published</span>`
                                    : `<span style="background:#fff3e0; color:#e65100; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px;">Draft</span>`
                                }
                            </td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}

// Retained only for backward-compatible data recovery; the examination-only
// faculty dashboard never starts this legacy class-teaching listener.
function watchArchivedClassTeachingSchedules(user, fullName) {
    if (!classTeachingScheduleContainer) return;

    onSnapshot(
        collection(db, "examSchedules"),
        snapshot => {
            const assignedClasses = [];

            snapshot.docs.forEach(docSnap => {
                const schedule = { id: docSnap.id, ...docSnap.data() };
                const status = normalize(schedule.status || "draft");
                if (status === "archived") return;

                const entries = Array.isArray(schedule.entries) ? schedule.entries : [];
                entries.forEach(entry => {
                    if (isClassEntryAssignedToFaculty(entry, user.uid, fullName)) {
                        assignedClasses.push({
                            ...entry,
                            scheduleId: schedule.id,
                            scheduleName: schedule.name || schedule.section || "Exam Schedule",
                            section: schedule.section || schedule.name || "",
                            academicYear: schedule.academicYear || "",
                            semester: schedule.semester || "",
                            yearLevel: schedule.yearLevel || "",
                            status: schedule.status || "draft"
                        });
                    }
                });
            });

            // Sort classes: Day, then Time, then Section
            const dayOrder = { "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6 };
            assignedClasses.sort((a, b) => {
                const firstDayA = String(a.day || "").split("/")[0].trim().toLowerCase();
                const firstDayB = String(b.day || "").split("/")[0].trim().toLowerCase();
                const orderA = dayOrder[firstDayA] || 99;
                const orderB = dayOrder[firstDayB] || 99;
                if (orderA !== orderB) return orderA - orderB;
                return String(a.time || "").localeCompare(String(b.time || ""));
            });

            renderClassTeachingSchedules(assignedClasses);
        },
        error => {
            console.error("Could not watch assigned exam schedules:", error);
            if (classTeachingScheduleContainer) {
                classTeachingScheduleContainer.innerHTML = '<div class="empty-state">Unable to load exam schedules right now.</div>';
            }
        }
    );
}

async function initializeFacultyDashboard() {
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
            if (normalize(profile.role || "") !== "faculty") {
                window.location.replace("login.html");
                return;
            }

            // Keep email synchronized if user verified their new email via action link
            if (user.email && profile.email && user.email.toLowerCase() !== profile.email.toLowerCase()) {
                try {
                    await updateDoc(doc(db, "users", user.uid), { email: user.email.toLowerCase() });
                    profile.email = user.email.toLowerCase();
                    localStorage.removeItem(`pending_email_change_${user.uid}`);
                } catch (syncError) {
                    console.error("Auto-syncing verified email to Firestore failed:", syncError);
                }
            }

            const fullName = profile.fullName || "Faculty";
            currentFacultyName = fullName;
            currentFacultyUid = user.uid;
            currentFacultyEmail = profile.email || user.email || "";
            currentFacultyId = profile.employeeId || profile.facultyId || "";
            navFacultyName.textContent = fullName;
            navFacultyRole.textContent = "Instructor";

            watchAssignedExamSchedules(user, fullName);
            watchRescheduleNotifications();
        } catch (error) {
            console.error("Could not load faculty dashboard:", error);
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

/* =========================
   FACULTY PROFILE MODAL (EDITABLE EMAIL)
========================= */

function showProfileMessage(message, type = "info") {
    if (!profileEmailMessage) return;
    profileEmailMessage.textContent = message;
    profileEmailMessage.className = `profile-message ${type}`;
    profileEmailMessage.hidden = false;
}

function hideProfileMessage() {
    if (!profileEmailMessage) return;
    profileEmailMessage.textContent = "";
    profileEmailMessage.className = "profile-message";
    profileEmailMessage.hidden = true;
}

function setProfileSaveLoading(loading) {
    if (!profileSaveEmailBtn) return;
    profileSaveEmailBtn.disabled = loading;
    if (profileCancelEmailBtn) profileCancelEmailBtn.disabled = loading;
    if (profileEditEmailInput) profileEditEmailInput.disabled = loading;
    if (profilePasswordInput) profilePasswordInput.disabled = loading;
    const isLoading = Boolean(loading);
    profileSaveEmailBtn.disabled = isLoading;
    if (profileCancelEmailBtn) profileCancelEmailBtn.disabled = isLoading;
    if (profileEditEmailInput) profileEditEmailInput.disabled = isLoading;
    if (profilePasswordInput) profilePasswordInput.disabled = isLoading;

    profileSaveEmailBtn.classList.toggle("loading", isLoading);
    const btnText = profileSaveEmailBtn.querySelector(".btn-text");
    const btnSpinner = profileSaveEmailBtn.querySelector(".btn-spinner");
    if (btnText) btnText.textContent = loading ? "Saving..." : "Save";
    if (btnSpinner) btnSpinner.hidden = !loading;
    if (btnText) btnText.textContent = isLoading ? "Saving..." : "Save";
    if (btnSpinner) {
        btnSpinner.hidden = !isLoading;
        btnSpinner.style.display = isLoading ? "inline-block" : "none";
    }
}

function getPendingEmailChangeKey(uid) {
    return `pending_email_change_${uid}`;
}

function getPendingEmailChange(uid) {
    if (!uid) return null;
    try {
        const raw = localStorage.getItem(getPendingEmailChangeKey(uid));
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function setPendingEmailChange(uid, email) {
    if (!uid) return;
    try {
        localStorage.setItem(
            getPendingEmailChangeKey(uid),
            JSON.stringify({ pendingEmail: email, timestamp: Date.now() })
        );
    } catch (e) {
        console.warn("Could not save pending email change to localStorage:", e);
    }
}

function clearPendingEmailChange(uid) {
    if (!uid) return;
    try {
        localStorage.removeItem(getPendingEmailChangeKey(uid));
    } catch (e) {
        console.warn("Could not clear pending email change:", e);
    }
}

function enterEmailEditMode() {
    hideProfileMessage();
    if (profileEmailViewMode) profileEmailViewMode.hidden = true;
    if (profileEmailEditMode) profileEmailEditMode.hidden = false;
    if (profileEditEmailInput) {
        profileEditEmailInput.value = currentFacultyEmail || "";
        profileEditEmailInput.focus();
        profileEditEmailInput.select();
    }
    if (profileReauthBox) profileReauthBox.hidden = true;
    if (profilePasswordInput) profilePasswordInput.value = "";
}

function exitEmailEditMode() {
    hideProfileMessage();
    if (profileEmailEditMode) profileEmailEditMode.hidden = true;
    if (profileEmailViewMode) profileEmailViewMode.hidden = false;
    if (profileReauthBox) profileReauthBox.hidden = true;
    if (profilePasswordInput) profilePasswordInput.value = "";
    setProfileSaveLoading(false);
}

function renderProfileView(name, facultyId, email) {
    if (profileViewName) profileViewName.textContent = name || "—";
    if (profileViewFacultyId) profileViewFacultyId.textContent = facultyId || "—";
    if (profileViewEmail) profileViewEmail.textContent = email || "—";
}

async function checkAndSyncVerificationStatus(silent = false) {
    const user = auth.currentUser;
    if (!user) return;

    const pending = getPendingEmailChange(user.uid);
    const pendingEmail = pending?.pendingEmail;

    if (!pendingEmail) {
        if (profilePendingNotice) profilePendingNotice.hidden = true;
        return;
    }

    if (profilePendingNotice) {
        profilePendingNotice.hidden = false;
        if (profilePendingEmailVal) profilePendingEmailVal.textContent = pendingEmail;
    }

    if (profileCheckVerificationBtn) {
        profileCheckVerificationBtn.disabled = true;
        profileCheckVerificationBtn.textContent = "Checking...";
    }

    try {
        // Reload Firebase Auth to fetch the latest email state
        await user.reload();

        const latestEmail = (user.email || "").toLowerCase();
        const targetEmail = pendingEmail.toLowerCase();

        if (latestEmail === targetEmail) {
            // Firebase Auth email update finalized after verification link click!
            // Synchronize Firestore users/{uid} document
            try {
                await updateDoc(doc(db, "users", user.uid), {
                    email: latestEmail
                });

                currentFacultyEmail = latestEmail;
                renderProfileView(currentFacultyName, currentFacultyId, currentFacultyEmail);
                clearPendingEmailChange(user.uid);
                if (profilePendingNotice) profilePendingNotice.hidden = true;
                showProfileMessage("Email address successfully updated and synchronized!", "success");
            } catch (firestoreError) {
                console.error("Firestore sync failed:", firestoreError);
                // Safe and explicit error handling if Auth succeeded but Firestore failed
                showProfileMessage(
                    `Your email was verified in Authentication (${latestEmail}), but updating your profile in the database failed: ${firestoreError.message}. Please click 'I Have Verified' again to retry syncing.`,
                    "error"
                );
            }
        } else {
            if (!silent) {
                showProfileMessage(
                    `Your email has not been verified yet. Please check your inbox at ${pendingEmail} and click the verification link.`,
                    "info"
                );
            }
        }
    } catch (reloadError) {
        console.error("Error reloading user auth status:", reloadError);
        if (!silent) {
            showProfileMessage("Could not check verification status: " + reloadError.message, "error");
        }
    } finally {
        if (profileCheckVerificationBtn) {
            profileCheckVerificationBtn.disabled = false;
            profileCheckVerificationBtn.textContent = "I Have Verified";
        }
    }
}

async function handleSaveEmailChange() {
    const user = auth.currentUser;
    if (!user) {
        showProfileMessage("You must be logged in to update your email.", "error");
        return;
    }

    const newEmail = (profileEditEmailInput?.value || "").trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Validation 1: Not empty
    if (!newEmail) {
        showProfileMessage("Email address cannot be empty.", "error");
        profileEditEmailInput?.focus();
        return;
    }

    // Validation 2: Valid email format
    if (!emailRegex.test(newEmail)) {
        showProfileMessage("Please enter a valid email address.", "error");
        profileEditEmailInput?.focus();
        return;
    }

    // Validation 3: Different from current email
    const currentEmail = (currentFacultyEmail || user.email || "").toLowerCase();
    if (newEmail === currentEmail) {
        showProfileMessage("New email must be different from your current email.", "error");
        profileEditEmailInput?.focus();
        return;
    }

    setProfileSaveLoading(true);
    hideProfileMessage();

    // Validation 4: Pre-check if email already belongs to another user in Firestore
    try {
        const usersCol = collection(db, "users");
        const dupSnap = await getDocs(query(usersCol, where("email", "==", newEmail)));
        const dupFound = dupSnap.docs.some(d => d.id !== user.uid);
        if (dupFound) {
            showProfileMessage("This email is already associated with another account.", "error");
            setProfileSaveLoading(false);
            return;
        }
    } catch (checkErr) {
        console.warn("Firestore pre-check query error:", checkErr);
    }

    // Validation 4b: Check via server endpoint if available
    try {
        const serverCheck = await fetch(`${API_BASE_URL}/api/auth/check-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: newEmail, currentUid: user.uid })
        });
        if (serverCheck.ok) {
            const checkData = await serverCheck.json();
            if (checkData.inUse) {
                showProfileMessage("This email is already associated with another account.", "error");
                setProfileSaveLoading(false);
                return;
            }
        }
    } catch {
        // Backend check optional if server not running or offline
    }

    // If password box is visible and user typed a password, reauthenticate first
    if (profileReauthBox && !profileReauthBox.hidden && profilePasswordInput?.value) {
        try {
            const credential = EmailAuthProvider.credential(user.email, profilePasswordInput.value);
            await reauthenticateWithCredential(user, credential);
        } catch (reauthErr) {
            setProfileSaveLoading(false);
            if (reauthErr.code === "auth/wrong-password" || reauthErr.code === "auth/invalid-credential") {
                showProfileMessage("Incorrect password. Please enter your correct password.", "error");
            } else {
                showProfileMessage(reauthErr.message || "Re-authentication failed.", "error");
            }
            profilePasswordInput?.focus();
            return;
        }
    }

    // Send verification email via Firebase Web SDK
    try {
        await verifyBeforeUpdateEmail(user, newEmail);

        // Verification email dispatched successfully
        setPendingEmailChange(user.uid, newEmail);
        exitEmailEditMode();

        if (profilePendingNotice) {
            profilePendingNotice.hidden = false;
            if (profilePendingEmailVal) profilePendingEmailVal.textContent = newEmail;
        }

        showProfileMessage(
            `A verification link has been sent to ${newEmail}. Please check your inbox and verify your email to finalize this change.`,
            "success"
        );
    } catch (authError) {
        console.error("verifyBeforeUpdateEmail error:", authError.code, authError.message);
        setProfileSaveLoading(false);

        if (authError.code === "auth/requires-recent-login") {
            // Prompt for current password to reauthenticate smoothly
            if (profileReauthBox) profileReauthBox.hidden = false;
            showProfileMessage("For security, please enter your current password to proceed.", "info");
            profilePasswordInput?.focus();
        } else if (authError.code === "auth/email-already-in-use") {
            showProfileMessage("This email is already associated with another account.", "error");
        } else if (authError.code === "auth/invalid-email") {
            showProfileMessage("Please enter a valid email address.", "error");
        } else if (authError.code === "auth/too-many-requests") {
            showProfileMessage("Too many requests. Please wait a moment before trying again.", "error");
        } else {
            showProfileMessage(authError.message || "Failed to update email. Please try again.", "error");
        }
    }
}

async function handleResendVerification() {
    const user = auth.currentUser;
    if (!user) return;
    const pending = getPendingEmailChange(user.uid);
    if (!pending?.pendingEmail) return;

    try {
        if (profileResendVerificationBtn) profileResendVerificationBtn.disabled = true;
        await verifyBeforeUpdateEmail(user, pending.pendingEmail);
        showProfileMessage(`A new verification email was sent to ${pending.pendingEmail}.`, "success");
    } catch (err) {
        showProfileMessage(err.message || "Failed to resend verification email.", "error");
    } finally {
        if (profileResendVerificationBtn) profileResendVerificationBtn.disabled = false;
    }
}

function handleCancelPendingVerification() {
    const user = auth.currentUser;
    if (user) {
        clearPendingEmailChange(user.uid);
    }
    if (profilePendingNotice) profilePendingNotice.hidden = true;
    showProfileMessage("Pending email change request cancelled.", "info");
}

function openProfileModal() {
    if (!facultyProfileModal) return;

    /* Immediately show the already-loaded profile data as a fallback */
    renderProfileView(currentFacultyName, currentFacultyId, currentFacultyEmail);
    exitEmailEditMode();

    facultyProfileModal.hidden = false;
    document.body.style.overflow = "hidden";

    const user = auth.currentUser;
    if (!user) return;

    // Check if there is a pending verification or if already verified
    checkAndSyncVerificationStatus(true);

    getDoc(doc(db, "users", user.uid))
        .then(profileDoc => {
            if (!profileDoc.exists()) return;
            const profile = profileDoc.data();

            /* Keep the cached values in sync */
            currentFacultyName = profile.fullName || currentFacultyName || "Faculty";
            currentFacultyEmail = profile.email || user.email || currentFacultyEmail || "";
            currentFacultyId = profile.employeeId || profile.facultyId || currentFacultyId || "";

            renderProfileView(currentFacultyName, currentFacultyId, currentFacultyEmail);
        })
        .catch(error => {
            console.error("Could not load faculty profile:", error && error.code, error && error.message);
        });
}

function closeProfileModal() {
    if (!facultyProfileModal || facultyProfileModal.hidden) return;
    exitEmailEditMode();
    facultyProfileModal.hidden = true;
    document.body.style.overflow = "";
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

markAllNotificationsReadBtn?.addEventListener("click", markAllNotificationsAsRead);

notificationsModal.addEventListener("click", event => {
    if (event.target === notificationsModal) {
        closeNotificationsModal();
    }
});

/* Faculty Profile modal events */
navProfileBtn?.addEventListener("click", openProfileModal);

closeProfileModalBtn?.addEventListener("click", closeProfileModal);

profileEditEmailBtn?.addEventListener("click", enterEmailEditMode);

profileCancelEmailBtn?.addEventListener("click", exitEmailEditMode);

profileSaveEmailBtn?.addEventListener("click", handleSaveEmailChange);

profileCheckVerificationBtn?.addEventListener("click", () => checkAndSyncVerificationStatus(false));

profileResendVerificationBtn?.addEventListener("click", handleResendVerification);

profileCancelPendingBtn?.addEventListener("click", handleCancelPendingVerification);

window.addEventListener("focus", () => {
    if (facultyProfileModal && !facultyProfileModal.hidden) {
        checkAndSyncVerificationStatus(true);
    }
});

facultyProfileModal?.addEventListener("click", event => {
    if (event.target === facultyProfileModal) {
        closeProfileModal();
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
        if (facultyProfileModal && !facultyProfileModal.hidden) {
            closeProfileModal();
        }
    }
});


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

const mobileMenuToggleBtn = document.getElementById("mobileMenuToggleBtn");
const navUl = document.querySelector("nav ul");

if (mobileMenuToggleBtn && navUl) {
    mobileMenuToggleBtn.addEventListener("click", () => {
        navUl.classList.toggle("show");
        mobileMenuToggleBtn.textContent = navUl.classList.contains("show") ? "✕" : "☰";
    });
}

examSelect?.addEventListener("change", handleExamChange);

rescheduleForm.addEventListener("submit", handleRescheduleSubmit);

exitEmailEditMode();
initializeFacultyDashboard();
