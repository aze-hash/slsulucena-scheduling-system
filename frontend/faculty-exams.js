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

function getPureExamTypeLabel(schedule) {
    const rawType = schedule.examType || schedule.title || "Exam Schedule";
    const norm = normalize(rawType);
    if (norm.includes("exam")) return rawType;
    if (norm === "preliminary" || norm === "prelim") return "Preliminary Examination";
    if (norm === "midterm") return "Midterm Examination";
    if (norm === "final" || norm === "finals") return "Final Examination";
    return rawType;
}

const recentExamSearchInput = document.getElementById("recentExamSearchInput");
let recentExamSearchTerm = "";

function scheduleMatchesSearch(schedule, term) {
    if (!term) return true;

    const haystack = [
        schedule.title,
        schedule.examType,
        getPureExamTypeLabel(schedule),
        schedule.section,
        schedule.program,
        schedule.major,
        schedule.academicYear,
        schedule.semester,
        schedule.yearLevel,
        schedule.proctor,
        ...(Array.isArray(schedule.exams) ? schedule.exams.flatMap(exam => [
            exam.subjectCode,
            exam.code,
            exam.subjectName,
            exam.name,
            exam.day,
            exam.time,
            exam.room
        ]) : [])
    ].map(normalize).filter(Boolean).join(" ");

    return haystack.includes(term);
}

function renderRecentExamSchedules() {
    const existingBanner = document.querySelector(".info-banner");

    if (!assignedExamSchedules.length) {
        if (existingBanner) existingBanner.remove();
        recentExamSchedulesContainer.innerHTML = '<tr><td colspan="5" class="empty-state">No new exam schedules are available.</td></tr>';
        updateNavbarBadge();
        return;
    }

    const filteredSchedules = assignedExamSchedules.filter(schedule => scheduleMatchesSearch(schedule, recentExamSearchTerm));

    if (!filteredSchedules.length) {
        if (existingBanner) existingBanner.remove();
        recentExamSchedulesContainer.innerHTML = '<tr><td colspan="5" class="empty-state">No recent exam schedules match your search.</td></tr>';
        updateNavbarBadge();
        return;
    }

    const allViewed = assignedExamSchedules.every(schedule => viewedSchedulesMap[schedule.id]);
    updateNavbarBadge();

    const tableWrapper = recentExamSchedulesContainer.closest(".recent-exams-table-wrapper");

    if (allViewed && assignedExamSchedules.length > 0) {
        if (!existingBanner && tableWrapper && tableWrapper.parentNode) {
            const bannerDiv = document.createElement("div");
            bannerDiv.className = "info-banner";
            bannerDiv.innerHTML = "ℹ️ You're viewing the latest available exam schedules.";
            tableWrapper.parentNode.insertBefore(bannerDiv, tableWrapper);
        }
    } else if (existingBanner) {
        existingBanner.remove();
    }

    const rowsHtml = filteredSchedules.map(schedule => {
        const isExpanded = expandedScheduleIds.has(schedule.id);
        const academicYear = schedule.academicYear || "-";
        const semester = schedule.semester || "-";
        const section = schedule.section || "-";
        const examType = getPureExamTypeLabel(schedule);
        const scheduleTables = isExpanded ? buildScheduleTablesHtml(schedule) : "";

        const mainRow = `
            <tr>
                <td>${safe(academicYear)}</td>
                <td>${safe(semester)}</td>
                <td>${safe(section)}</td>
                <td>${safe(examType)}</td>
                <td>
                    <button class="view-schedule-btn" type="button" data-action="toggle-schedule" data-schedule-id="${safe(schedule.id)}">
                        ${isExpanded ? "Hide Schedule" : "View Schedule"}
                    </button>
                </td>
            </tr>
        `;

        const detailRow = isExpanded ? `
            <tr class="schedule-detail-row">
                <td colspan="5">
                    <div class="recent-exam-table-container">
                        ${scheduleTables}
                    </div>
                </td>
            </tr>
        ` : "";

        return mainRow + detailRow;
    }).join("");

    recentExamSchedulesContainer.innerHTML = rowsHtml;
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
    if (!sectionSelect) return;
    const sections = [...new Set(assignedExamSchedules.map(schedule => schedule.section).filter(Boolean))];

    if (!sections.length) {
        sectionSelect.innerHTML = '<option value="">No sections assigned to you yet</option>';
        sectionSelect.disabled = true;
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

    if (!selectedSection) return;

    const matchingSchedules = assignedExamSchedules.filter(s => s.section === selectedSection);
    const affectedExams = [];

    matchingSchedules.forEach(schedule => {
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
        exams.forEach(exam => {
            affectedExams.push({
                day: exam.day || "-",
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
            examJourneyPreview.innerHTML = '<div class="empty-state">No scheduled exams found for this section.</div>';
        }
        return;
    }

    const rows = affectedExams.map(exam => `
        <tr>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.day)}</td>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.time)}</td>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.code)} — ${safe(exam.name)}</td>
            <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.room)}</td>
        </tr>
    `).join("");

    if (examJourneyPreview) {
        examJourneyPreview.hidden = false;
        examJourneyPreview.innerHTML = `
            <div class="exam-journey-card" style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 8px; margin: 10px 0;">
                <div style="font-weight: 600; margin-bottom: 8px; color: #1e293b;">
                    Section Timetable Preview (${safe(selectedSection)}):
                </div>
                <table class="exam-pdf-style" style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
                    <thead>
                        <tr style="background: #e2e8f0; text-align: left;">
                            <th style="padding: 6px;">DAY</th>
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
        const isReplacementFaculty = request.replacementFacultyId === currentFacultyUid && request.facultyUid !== currentFacultyUid;
        const icon = isReplacementFaculty ? "📋" : (isApproved ? "✓" : "✕");
        const title = isReplacementFaculty 
            ? "New Proctoring Assignment" 
            : (isApproved ? "Reschedule Request Approved" : "Reschedule Request Denied");

        let message = "";
        if (isReplacementFaculty) {
            message = `You have been assigned as replacement proctor for ${safe(request.section || "section")}.`;
        } else if (isApproved) {
            message = `Your reschedule request for ${safe(request.section || "your section")} has been approved. Reassigned to ${safe(request.replacementFacultyName || "replacement faculty")}.`;
        } else {
            message = `Your reschedule request for ${safe(request.section || "your section")} was denied by the admin.`;
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

    // Check for duplicate pending requests in rescheduleRequests matching requestingFacultyId + section
    const pendingRequests = await loadPendingRequests();
    const alreadyPending = pendingRequests.some(request =>
        normalize(request.section) === normalize(section)
    );

    if (alreadyPending) {
        showRequestStatus(`You already have a pending reschedule request for ${section}. Please wait for the chairperson to review it.`, "error");
        return;
    }

    // Collect affected exams & schedule doc IDs for this section
    const matchingSchedules = assignedExamSchedules.filter(s => s.section === section);
    const affectedExams = [];
    const affectedScheduleIds = matchingSchedules.map(s => s.id);

    matchingSchedules.forEach(schedule => {
        const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
        exams.forEach(exam => {
            affectedExams.push({
                day: exam.day || "-",
                time: exam.time || "-",
                code: exam.code || exam.subjectCode || "-",
                name: exam.name || exam.subjectName || "-",
                room: exam.room || "-",
                scheduleId: schedule.id
            });
        });
    });

    const examType = matchingSchedules[0]?.examType || matchingSchedules[0]?.title || "Exam Schedule";

    submitRequestBtn.disabled = true;
    submitRequestBtn.textContent = "Submitting...";

    try {
        const requestData = {
            section: section,
            examType: examType,
            examDate: "All Exam Days",
            examDateLabel: "Entire Schedule",
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

            renderRecentExamSchedules();
            populateSectionSelect();
            watchFacultyScheduleNotifications();
        },
        error => {
            console.error("Could not watch recent exam schedules:", error);
            if (recentExamSchedulesContainer) {
                recentExamSchedulesContainer.innerHTML = '<tr><td colspan="5" class="empty-state">Unable to load recent exam schedules right now.</td></tr>';
            }
        }
    );
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

            watchAssignedExamSchedules(user, fullName);
            watchRescheduleNotifications();
        } catch (error) {
            console.error("Could not load recent exam schedules page:", error);
            recentExamSchedulesContainer.innerHTML = '<tr><td colspan="5" class="empty-state">Unable to load recent exam schedules right now.</td></tr>';
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

recentExamSearchInput?.addEventListener("input", () => {
    recentExamSearchTerm = normalize(recentExamSearchInput.value);
    renderRecentExamSchedules();
});

sectionSelect?.addEventListener("change", handleSectionChange);

rescheduleForm.addEventListener("submit", handleRescheduleSubmit);

initializeFacultyExamsPage();
