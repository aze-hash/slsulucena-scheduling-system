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
const examDateSelect = document.getElementById("examDateSelect");
const examJourneyPreview = document.getElementById("examJourneyPreview");
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
                groups[day] = examList.filter(exam =>
                    normalize(exam.day) === normalize(day) || exam.day === day
                );
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
    if (!sectionSelect) return;
    const sections = [...new Set(assignedExamSchedules.map(schedule => schedule.section).filter(Boolean))];

    if (!sections.length) {
        sectionSelect.innerHTML = '<option value="">No sections assigned to you yet</option>';
        sectionSelect.disabled = true;
        if (examDateSelect) {
            examDateSelect.innerHTML = '<option value="">-- Select section first --</option>';
            examDateSelect.disabled = true;
        }
        if (examJourneyPreview) {
            examJourneyPreview.hidden = true;
            examJourneyPreview.innerHTML = "";
        }
        return;
    }

    sectionSelect.disabled = false;
    sectionSelect.innerHTML = `
        <option value="">-- Select the section you are assigned to --</option>
        ${sections.map(section => `<option value="${safe(section)}">${safe(section)}</option>`).join("")}
    `;

    if (examDateSelect) {
        examDateSelect.innerHTML = '<option value="">-- Select section first --</option>';
        examDateSelect.disabled = true;
    }
    if (examJourneyPreview) {
        examJourneyPreview.hidden = true;
        examJourneyPreview.innerHTML = "";
    }
}

function handleSectionChange() {
    const selectedSection = sectionSelect.value;
    if (examJourneyPreview) {
        examJourneyPreview.hidden = true;
        examJourneyPreview.innerHTML = "";
    }

    if (!selectedSection) {
        if (examDateSelect) {
            examDateSelect.innerHTML = '<option value="">-- Select section first --</option>';
            examDateSelect.disabled = true;
        }
        return;
    }

    const matchingSchedules = assignedExamSchedules.filter(s => s.section === selectedSection);
    const datesMap = new Map();

    matchingSchedules.forEach(schedule => {
        const examDatesObj = schedule.examDates || {};
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

        Object.entries(examDatesObj).forEach(([dayLabel, dateStr]) => {
            if (dateStr) {
                const formatted = formatExamDate(dateStr);
                const fullLabel = formatted ? `${formatted} (${dayLabel})` : dateStr;
                datesMap.set(dateStr, fullLabel);
            }
        });

        exams.forEach(exam => {
            if (exam.day && examDatesObj[exam.day]) {
                const dateStr = examDatesObj[exam.day];
                const formatted = formatExamDate(dateStr);
                const fullLabel = formatted ? `${formatted} (${exam.day})` : dateStr;
                datesMap.set(dateStr, fullLabel);
            }
        });
    });

    if (!datesMap.size) {
        if (examDateSelect) {
            examDateSelect.innerHTML = '<option value="">No exam dates found for this section</option>';
            examDateSelect.disabled = true;
        }
        return;
    }

    if (examDateSelect) {
        examDateSelect.disabled = false;
        examDateSelect.innerHTML = `
            <option value="">-- Select assigned exam date --</option>
            ${Array.from(datesMap.entries()).map(([dateStr, label]) => `<option value="${safe(dateStr)}">${safe(label)}</option>`).join("")}
        `;
    }
}

function handleExamDateChange() {
    const selectedSection = sectionSelect.value;
    const selectedDate = examDateSelect ? examDateSelect.value : "";

    if (!selectedSection || !selectedDate) {
        if (examJourneyPreview) {
            examJourneyPreview.hidden = true;
            examJourneyPreview.innerHTML = "";
        }
        return;
    }

    const matchingSchedules = assignedExamSchedules.filter(s => s.section === selectedSection);
    const affectedExams = [];

    matchingSchedules.forEach(schedule => {
        const examDatesObj = schedule.examDates || {};
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

        const matchingDays = Object.entries(examDatesObj)
            .filter(([dayLabel, dateStr]) => dateStr === selectedDate)
            .map(([dayLabel]) => dayLabel);

        const dayExams = exams.filter(e => matchingDays.includes(e.day) || e.day === selectedDate);
        dayExams.forEach(exam => {
            affectedExams.push({
                day: exam.day,
                time: exam.time || "-",
                code: exam.code || exam.subjectCode || "-",
                name: exam.name || exam.subjectName || "-",
                room: exam.room || "-",
                scheduleId: schedule.id
            });
        });
    });

    if (!affectedExams.length) {
        if (examJourneyPreview) {
            examJourneyPreview.hidden = false;
            examJourneyPreview.innerHTML = '<div class="empty-state">No scheduled exams found on this date.</div>';
        }
        return;
    }

    const rows = affectedExams.map(exam => `
        <tr>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.time)}</td>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.code)} — ${safe(exam.name)}</td>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.room)}</td>
        </tr>
    `).join("");

    const formattedDate = formatExamDate(selectedDate);

    if (examJourneyPreview) {
        examJourneyPreview.hidden = false;
        examJourneyPreview.innerHTML = `
            <div class="exam-journey-card" style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 8px; margin: 10px 0;">
                <div style="font-weight: 600; margin-bottom: 8px; color: #1e293b;">
                    Timetable Preview (${safe(formattedDate || selectedDate)}):
                </div>
                <table class="exam-pdf-style" style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
                    <thead>
                        <tr style="background: #e2e8f0; text-align: left;">
                            <th style="padding: 6px;">TIME</th>
                            <th style="padding: 6px;">SUBJECT</th>
                            <th style="padding: 6px;">ROOM</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }
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
        const isReplacementFaculty = request.replacementFacultyId === currentFacultyUid;
        const icon = isApproved ? "✓" : "✕";
        const title = isApproved ? "Request Approved" : "Request Denied";
        
        let message = "";
        if (isApproved) {
            if (isReplacementFaculty) {
                message = `You have been assigned as replacement proctor for ${safe(request.section || "section")} on ${safe(request.examDateLabel || request.examDate || "the assigned date")}.`;
            } else {
                message = `Your reschedule request for ${safe(request.section || "your section")} on ${safe(request.examDateLabel || request.examDate || "the assigned date")} has been approved. Reassigned to ${safe(request.replacementFacultyName || "replacement faculty")}.`;
            }
        } else {
            message = `Your reschedule request for ${safe(request.section || "your section")} on ${safe(request.examDateLabel || request.examDate || "the assigned date")} was denied by the admin.`;
        }

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

    // Also watch requests where current faculty is assigned as replacement faculty
    onSnapshot(
        query(
            collection(db, "rescheduleRequests"),
            where("replacementFacultyId", "==", currentFacultyUid)
        ),
        snapshot => {
            const replacementRequests = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
            renderRequestNotifications(replacementRequests);
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

    const section = sectionSelect.value;
    const examDate = examDateSelect ? examDateSelect.value : "";
    const reason = reasonInput.value.trim();

    if (!section) {
        showRequestStatus("Please select a section.", "error");
        return;
    }

    if (!examDate) {
        showRequestStatus("Please select an assigned exam date.", "error");
        return;
    }

    if (!reason) {
        showRequestStatus("Please provide a reason for your unavailability.", "error");
        return;
    }

    const selectedDateLabel = examDateSelect && examDateSelect.selectedIndex >= 0
        ? examDateSelect.options[examDateSelect.selectedIndex].text
        : examDate;

    // Check for duplicate pending requests in rescheduleRequests matching requestingFacultyId + section + examDate
    const pendingRequests = await loadPendingRequests();
    const alreadyPending = pendingRequests.some(request =>
        normalize(request.section) === normalize(section) &&
        (request.examDate === examDate || normalize(request.examDateLabel) === normalize(selectedDateLabel))
    );

    if (alreadyPending) {
        showRequestStatus(`You already have a pending reschedule request for ${section} on ${selectedDateLabel}. Please wait for the chairperson to review it.`, "error");
        return;
    }

    // Collect affected exams & schedule doc IDs
    const matchingSchedules = assignedExamSchedules.filter(s => s.section === section);
    const affectedExams = [];
    const affectedScheduleIds = [];

    matchingSchedules.forEach(schedule => {
        const examDatesObj = schedule.examDates || {};
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

        const matchingDays = Object.entries(examDatesObj)
            .filter(([dayLabel, dateStr]) => dateStr === examDate)
            .map(([dayLabel]) => dayLabel);

        const dayExams = exams.filter(e => matchingDays.includes(e.day) || e.day === examDate);
        if (dayExams.length > 0) {
            if (!affectedScheduleIds.includes(schedule.id)) {
                affectedScheduleIds.push(schedule.id);
            }
            dayExams.forEach(exam => {
                affectedExams.push({
                    day: exam.day,
                    time: exam.time || "-",
                    code: exam.code || exam.subjectCode || "-",
                    name: exam.name || exam.subjectName || "-",
                    room: exam.room || "-",
                    scheduleId: schedule.id
                });
            });
        }
    });

    submitRequestBtn.disabled = true;
    submitRequestBtn.textContent = "Submitting...";

    try {
        const requestData = {
            section: section,
            examDate: examDate,
            examDateLabel: selectedDateLabel,
            requestingFacultyId: currentFacultyUid,
            requestingFacultyName: currentFacultyName,
            facultyUid: currentFacultyUid,
            facultyName: currentFacultyName,
            affectedExamScheduleIds: affectedScheduleIds,
            affectedExams: affectedExams,
            reason: reason,
            status: "pending",
            replacementFacultyId: null,
            replacementFacultyName: null,
            reviewedBy: null,
            reviewedAt: null,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await addDoc(collection(db, "rescheduleRequests"), requestData);

        showRequestStatus(`Your reschedule request for ${section} on ${selectedDateLabel} has been submitted to the chairperson for review.`);
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

function isAssignedToCurrentFaculty(schedule, userUid, facultyFullName) {
    if (!schedule) return false;

    // 1. Direct UID match (primary check)
    const matchesUid = schedule.proctorUid === userUid ||
                       schedule.facultyUid === userUid ||
                       schedule.assignedFacultyUid === userUid;
    if (matchesUid) return true;

    // 2. Flexible name matching (handles titles/honorifics/formatting variations)
    const normProctor = normalize(schedule.proctor || "");
    const normFullName = normalize(facultyFullName || "");

    if (normProctor && normFullName) {
        if (normProctor === normFullName) return true;
        if (normProctor.includes(normFullName) || normFullName.includes(normProctor)) return true;

        const nameTokens = normFullName.split(/\s+/).filter(t => t.length > 2);
        if (nameTokens.length >= 2) {
            const allTokensMatch = nameTokens.every(token => normProctor.includes(token));
            if (allTokensMatch) return true;
        }
    }

    return false;
}

function watchAssignedExamSchedules(user, fullName) {
    onSnapshot(
        collection(db, "examSchedules"),
        snapshot => {
            const examSchedules = snapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
                .filter(schedule => {
                    const status = normalize(schedule.status || "generated");
                    const isValidStatus = status === "generated" || status === "published" || status === "active";
                    if (!isValidStatus) return false;

                    // STRICT isolation: ONLY exam schedules assigned to THIS faculty account
                    return isAssignedToCurrentFaculty(schedule, user.uid, fullName);
                });

            examSchedules.sort((a, b) => getScheduleTimestamp(b) - getScheduleTimestamp(a));
            assignedExamSchedules = examSchedules;

            // Render ALL exam schedules assigned specifically to THIS faculty account
            renderExamSchedules(assignedExamSchedules);
            populateSectionSelect();
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
            allClassSchedules = classSnapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));

            renderClassSchedules(allClassSchedules);
            watchAssignedExamSchedules(user, fullName);
            watchRescheduleNotifications();
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

sectionSelect?.addEventListener("change", handleSectionChange);
examDateSelect?.addEventListener("change", handleExamDateChange);

rescheduleForm.addEventListener("submit", handleRescheduleSubmit);

initializeFacultyDashboard();
