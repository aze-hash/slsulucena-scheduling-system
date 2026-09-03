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

import { renderExamCalendar } from "./js/schedule-calendar.js";

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

let currentFacultyName = "";
let currentFacultyUid = "";
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

    examScheduleContainer.innerHTML = schedules.map(schedule => {
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

            const fullName = profile.fullName || "Faculty";
            currentFacultyName = fullName;
            currentFacultyUid = user.uid;
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

initializeFacultyDashboard();
