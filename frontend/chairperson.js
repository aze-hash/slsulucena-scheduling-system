import { auth, db } from "../firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    doc,
    getDoc,
    getDocs,
    collection,
    query,
    where,
    onSnapshot,
    updateDoc,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

let currentAdminName = "SLSU Admin";
let currentAdminUid = "";
let currentRequestId = null;
let currentRequest = null;
let candidateFacultyList = [];

onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.replace("login.html");
        return;
    }

    const profile = await getDoc(doc(db, "users", user.uid));

    if (!profile.exists() || profile.data().role !== "Admin") {
        window.location.replace("login.html");
        return;
    }

    currentAdminUid = user.uid;
    currentAdminName = profile.data().fullName || "SLSU Admin";
    document.getElementById("adminName").textContent = currentAdminName;

    watchStudents();
    watchFaculty();
    watchClassSchedules();
    watchExamSchedules();
    watchRescheduleRequests();

    // Initialize the two dashboard visualization charts independently
    initFacultySubjectAssignmentsChart();
    initScheduleOverviewChart();
});

function watchStudents() {
    onSnapshot(
        query(collection(db, "users"), where("role", "==", "Student")),
        snapshot => {
            document.getElementById("studentCount").textContent = snapshot.size;
        },
        error => console.error(error)
    );
}

let facultyCountState = { registered: 0, legacy: 0 };

function watchFaculty() {
    onSnapshot(
        collection(db, "users"),
        usersSnapshot => {
            facultyCountState.registered = usersSnapshot.docs.filter(
                document => String(document.data().role || "").toLowerCase() === "faculty"
            ).length;
            updateFacultyCount();
        },
        error => console.error(error)
    );

    onSnapshot(
        collection(db, "faculty"),
        facultySnapshot => {
            facultyCountState.legacy = facultySnapshot.size;
            updateFacultyCount();
        },
        error => console.error(error)
    );
}

function updateFacultyCount() {
    document.getElementById("facultyCount").textContent =
        facultyCountState.registered + facultyCountState.legacy;
}

let scheduleState = { class: 0, exam: 0 };

function watchClassSchedules() {
    onSnapshot(
        collection(db, "classSchedules"),
        snapshot => {
            scheduleState.class = snapshot.size;
            updateScheduleCounts();
        },
        error => console.error(error)
    );
}

function watchExamSchedules() {
    onSnapshot(
        collection(db, "examSchedules"),
        snapshot => {
            scheduleState.exam = snapshot.size;
            updateScheduleCounts();
        },
        error => {
            console.error(error);
            document.getElementById("dashboardNotice").textContent =
                "Unable to load exam schedules. Check your Firestore rules.";
        }
    );
}

function updateScheduleCounts() {
    document.getElementById("classScheduleCount").textContent = scheduleState.class;
    document.getElementById("examScheduleCount").textContent = scheduleState.exam;
    updateDashboardNotice();
}

function updateDashboardNotice() {
    const { class: classCount, exam: examCount } = scheduleState;

    if (!classCount && !examCount) {
        document.getElementById("dashboardNotice").innerHTML =
            "Your dashboard is live. No class or exam schedules have been saved yet.";
        return;
    }

    const classText = `<strong>${classCount}</strong> class schedule${classCount === 1 ? "" : "s"}`;
    const examText = `<strong>${examCount}</strong> exam schedule${examCount === 1 ? "" : "s"}`;

    document.getElementById("dashboardNotice").innerHTML =
        `Your dashboard is live. ${classCount ? classText : "no class schedules"} and ${examCount ? examText : "no exam schedules"} are saved in Firestore.`;
}

function watchRescheduleRequests() {
    onSnapshot(
        collection(db, "rescheduleRequests"),
        snapshot => {
            const requests = snapshot.docs.map(document => ({
                id: document.id,
                ...document.data()
            }));

            renderRescheduleRequests(requests);

            const pendingCount = requests.filter(request =>
                String(request.status || "").toLowerCase() === "pending"
            ).length;

            document.getElementById("pendingRequestCount").textContent =
                pendingCount;
            document.getElementById("pendingRequestBadge").textContent =
                `${pendingCount} pending`;
        },
        error => {
            console.error("Could not watch reschedule requests:", error);
            document.getElementById("rescheduleRequestsBody").innerHTML =
                `<tr><td colspan="6">Unable to load reschedule requests.</td></tr>`;
        }
    );
}

function renderRescheduleRequests(requests) {
    const body = document.getElementById("rescheduleRequestsBody");

    if (!requests.length) {
        body.innerHTML = `<tr><td colspan="7">No reschedule requests have been submitted yet.</td></tr>`;
        return;
    }

    const sorted = [...requests].sort((a, b) => getDate(b) - getDate(a));

    body.innerHTML = sorted.map(request => {
        const status = String(request.status || "pending").toLowerCase();
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
        const statusClass = status === "approved" ? "status-approved" :
            status === "denied" ? "status-denied" : "status-pending";

        const examTypeDisplay = request.examType || (request.affectedExams && request.affectedExams[0]?.examType) || "Exam Schedule";
        const subjectDisplay = request.subjectCode
            ? `${safe(request.subjectCode)}${request.subjectName ? ` - ${safe(request.subjectName)}` : ""}`
            : (request.affectedExams?.[0]?.code || "-");

        return `
            <tr>
                <td>${safe(request.facultyName || request.requestingFacultyName || "Unknown Faculty")}</td>
                <td><strong>${subjectDisplay}</strong></td>
                <td>${safe(request.section || "-")}</td>
                <td>${safe(examTypeDisplay)}</td>
                <td>${safe(formatDate(getDate(request)))}</td>
                <td><span class="status-badge ${statusClass}">${safe(statusLabel)}</span></td>
                <td>
                    <div class="request-actions">
                        <button class="view-btn" data-request-id="${safe(request.id)}">View</button>
                        <button class="delete-btn" data-request-id="${safe(request.id)}">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");

    body.querySelectorAll(".view-btn").forEach(button => {
        button.addEventListener("click", () => {
            const requestId = button.dataset.requestId;
            const request = sorted.find(item => item.id === requestId);
            if (request) {
                openRequestModal(request);
            }
        });
    });

    body.querySelectorAll(".delete-btn").forEach(button => {
        button.addEventListener("click", () => {
            const requestId = button.dataset.requestId;
            handleDeleteRequest(requestId);
        });
    });
}

async function handleDeleteRequest(requestId) {
    if (!requestId) return;

    const confirmed = confirm("Are you sure you want to delete this reschedule request?");

    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, "rescheduleRequests", requestId));
    } catch (error) {
        console.error("Could not delete request:", error);
        alert("Failed to delete the request. Please try again.");
    }
}

function openRequestModal(request) {
    currentRequestId = request.id;
    currentRequest = request;

    document.getElementById("modalFacultyName").textContent =
        request.facultyName || request.requestingFacultyName || "-";

    const modalSubject = document.getElementById("modalSubject");
    if (modalSubject) {
        modalSubject.textContent = request.subjectCode
            ? `${request.subjectCode}${request.subjectName ? ` - ${request.subjectName}` : ""}`
            : (request.affectedExams?.[0]?.code || "-");
    }

    document.getElementById("modalSection").textContent =
        request.section || "-";

    const modalExamType = document.getElementById("modalExamType") || document.getElementById("modalExamDate");
    if (modalExamType) {
        modalExamType.textContent = request.examType || (request.affectedExams && request.affectedExams[0]?.examType) || "Exam Schedule";
    }

    const modalScheduleTime = document.getElementById("modalScheduleTime");
    if (modalScheduleTime) {
        const dateStr = request.examDate || "-";
        const timeStr = request.examTime || "-";
        modalScheduleTime.textContent = `${dateStr} (${timeStr})`;
    }

    const modalRoom = document.getElementById("modalRoom");
    if (modalRoom) {
        modalRoom.textContent = request.examRoom || "-";
    }

    document.getElementById("modalReason").textContent =
        request.reason || "-";

    const status = String(request.status || "pending").toLowerCase();
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    const statusClass = status === "approved" ? "status-approved" :
        status === "denied" ? "status-denied" : "status-pending";
    const isPending = status === "pending";

    const modalStatus = document.getElementById("modalStatus");
    modalStatus.textContent = statusLabel;
    modalStatus.className = `status-badge ${statusClass}`;

    // Render details preview
    const previewContainer = document.getElementById("modalJourneyPreview");
    const affectedExams = Array.isArray(request.affectedExams) && request.affectedExams.length
        ? request.affectedExams
        : (request.subjectCode ? [{
            time: request.examTime || "-",
            code: request.subjectCode,
            name: request.subjectName || "",
            room: request.examRoom || "-",
            day: request.examDate || "-"
        }] : []);

    if (affectedExams.length) {
        const rows = affectedExams.map(exam => `
            <tr>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.day || request.examDate || "-")}</td>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.time || "-")}</td>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;"><strong>${safe(exam.code || "-")}</strong> — ${safe(exam.name || "-")}</td>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.room || "-")}</td>
            </tr>
        `).join("");

        previewContainer.innerHTML = `
            <table class="exam-pdf-style" style="width: 100%; border-collapse: collapse; font-size: 0.9em; border: 1px solid #cbd5e1;">
                <thead>
                    <tr style="background: #f1f5f9; text-align: left;">
                        <th style="padding: 6px;">DATE</th>
                        <th style="padding: 6px;">TIME</th>
                        <th style="padding: 6px;">SUBJECT</th>
                        <th style="padding: 6px;">ROOM</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    } else {
        previewContainer.innerHTML = '<div class="empty-state">No detailed exam timetable available for this request.</div>';
    }

    // Reset manual replacement container
    const manualContainer = document.getElementById("manualReplacementContainer");
    if (manualContainer) manualContainer.style.display = "none";

    const footerActions = document.getElementById("modalFooterActions");
    if (footerActions) footerActions.style.display = isPending ? "flex" : "none";

    const approveBtn = document.getElementById("modalApproveBtn");
    approveBtn.disabled = false;
    approveBtn.textContent = "Approve";
    approveBtn.style.display = isPending ? "inline-block" : "none";

    document.getElementById("modalDenyBtn").style.display = isPending ? "inline-block" : "none";

    document.getElementById("requestModal").style.display = "flex";
}

function closeRequestModal() {
    document.getElementById("requestModal").style.display = "none";
    currentRequestId = null;
    currentRequest = null;
}

function showActionModal(title, messageHtml, type = "success") {
    return new Promise(resolve => {
        const modal = document.getElementById("actionNotificationModal");
        const titleEl = document.getElementById("actionModalTitle");
        const msgEl = document.getElementById("actionModalMessage");
        const iconEl = document.getElementById("actionModalIcon");
        const okBtn = document.getElementById("actionModalCloseBtn");

        if (!modal || !titleEl || !msgEl || !okBtn) {
            alert(messageHtml.replace(/<[^>]*>/g, ""));
            resolve();
            return;
        }

        titleEl.textContent = title || (type === "success" ? "Success" : "Notification");
        msgEl.innerHTML = messageHtml;

        if (iconEl) {
            if (type === "success") {
                iconEl.textContent = "✓";
                iconEl.style.background = "#dcfce7";
                iconEl.style.color = "#15803d";
            } else if (type === "error") {
                iconEl.textContent = "✕";
                iconEl.style.background = "#fee2e2";
                iconEl.style.color = "#b91c1c";
            } else {
                iconEl.textContent = "ℹ";
                iconEl.style.background = "#e0f2fe";
                iconEl.style.color = "#0369a1";
            }
        }

        modal.style.display = "flex";

        function cleanup() {
            modal.style.display = "none";
            okBtn.removeEventListener("click", onOk);
            modal.removeEventListener("click", onBackdrop);
            resolve();
        }

        function onOk() { cleanup(); }
        function onBackdrop(event) {
            if (event.target === modal) cleanup();
        }

        okBtn.addEventListener("click", onOk);
        modal.addEventListener("click", onBackdrop);
    });
}

function parseTimeInterval(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split("-").map(s => s.trim());
    if (parts.length !== 2) return null;

    function toMinutes(t) {
        const match = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const ampm = match[3] ? match[3].toUpperCase() : null;

        if (ampm) {
            if (ampm === "PM" && hours < 12) hours += 12;
            if (ampm === "AM" && hours === 12) hours = 0;
        }
        return hours * 60 + minutes;
    }

    const start = toMinutes(parts[0]);
    const end = toMinutes(parts[1]);

    if (start === null || end === null || end <= start) return null;
    return { start, end };
}

function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
}

function intervalsOverlap(intA, intB) {
    if (!intA || !intB) return false;
    return Math.max(intA.start, intB.start) < Math.min(intA.end, intB.end);
}

async function applyExamSubjectReassignment(request, replacementUid, replacementName) {
    const schedId = request.examScheduleId;
    if (!schedId) {
        const affectedScheduleIds = Array.isArray(request.affectedExamScheduleIds)
            ? request.affectedExamScheduleIds
            : [];
        for (const id of affectedScheduleIds) {
            await updateDoc(doc(db, "examSchedules", id), {
                proctor: replacementName,
                proctorUid: replacementUid,
                facultyUid: replacementUid,
                assignedFacultyUid: replacementUid,
                updatedAt: new Date()
            });
        }
        return;
    }

    const schedDocRef = doc(db, "examSchedules", schedId);
    const schedSnap = await getDoc(schedDocRef);
    if (!schedSnap.exists()) {
        console.warn("Target exam schedule doc not found:", schedId);
        return;
    }

    const schedData = schedSnap.data();
    const exams = Array.isArray(schedData.exams) ? schedData.exams : [];

    const reqSubject = normalize(request.subjectCode || "");
    const reqDay = normalize(request.examDay || request.examDate || "");
    const reqTime = normalize(request.examTime || "");

    const updatedExams = exams.map(exam => {
        const examCode = normalize(exam.code || exam.subjectCode || "");
        const examDay = normalize(exam.day || exam.date || "");
        const examTime = normalize(exam.time || "");

        const codeMatches = examCode === reqSubject || (reqSubject && (examCode.includes(reqSubject) || reqSubject.includes(examCode)));
        const dayMatches = !reqDay || examDay === reqDay || examDay.includes(reqDay) || reqDay.includes(examDay);
        const timeMatches = !reqTime || examTime === reqTime;

        if (codeMatches && (dayMatches || timeMatches || exams.length === 1)) {
            return {
                ...exam,
                proctor: replacementName,
                proctorUid: replacementUid
            };
        }
        return exam;
    });

    const uniqueProctors = [...new Set(updatedExams.map(e => e.proctor).filter(Boolean))].join(", ");
    const uniqueProctorUids = [...new Set(updatedExams.map(e => e.proctorUid).filter(Boolean))].join(",");

    await updateDoc(schedDocRef, {
        exams: updatedExams,
        proctor: uniqueProctors || replacementName,
        proctorUid: uniqueProctorUids || replacementUid,
        updatedAt: new Date()
    });
}

async function handleRequestDecision(requestId, action) {
    if (!requestId || !currentRequest) return;

    if (action === "denied") {
        const confirmed = confirm("Are you sure you want to deny this reschedule request?");
        if (!confirmed) return;

        try {
            await updateDoc(doc(db, "rescheduleRequests", requestId), {
                status: "denied",
                reviewedBy: currentAdminName,
                reviewedAt: new Date(),
                updatedAt: new Date()
            });
            closeRequestModal();
            await showActionModal(
                "Request Denied",
                `Reschedule request for <strong>${safe(currentRequest?.subjectCode || "this exam")}</strong> has been denied.`,
                "info"
            );
        } catch (error) {
            console.error("Could not deny request:", error);
            await showActionModal(
                "Action Failed",
                "Failed to deny the request. Please try again.",
                "error"
            );
        }
        return;
    }

    if (action === "approved") {
        const confirmed = confirm("Are you sure you want to approve this reschedule request?");
        if (!confirmed) return;

        const approveBtn = document.getElementById("modalApproveBtn");
        approveBtn.disabled = true;
        approveBtn.textContent = "Searching Replacement...";

        try {
            const examDate = currentRequest.examDate;
            const affectedExams = Array.isArray(currentRequest.affectedExams) && currentRequest.affectedExams.length
                ? currentRequest.affectedExams
                : (currentRequest.subjectCode ? [{
                    time: currentRequest.examTime,
                    code: currentRequest.subjectCode,
                    name: currentRequest.subjectName,
                    room: currentRequest.examRoom,
                    day: currentRequest.examDate
                }] : []);

            const affectedIntervals = (currentRequest.examTime ? [currentRequest.examTime] : affectedExams.map(e => e.time))
                .map(parseTimeInterval)
                .filter(Boolean);

            // 1. Fetch registered faculty from users collection
            const usersSnapshot = await getDocs(collection(db, "users"));
            const rawFacultyUsers = usersSnapshot.docs
                .map(d => ({ uid: d.id, ...d.data() }))
                .filter(u => String(u.role || "").toLowerCase() === "faculty")
                .filter(u => u.uid !== currentRequest.requestingFacultyId && u.uid !== currentRequest.facultyUid);

            // 1.1 Fetch facultySubjectAssignments to exclude faculty who teach the affected exam subjects
            const affectedSubjectCodes = new Set(
                (currentRequest.subjectCode ? [currentRequest.subjectCode] : affectedExams.map(e => e.code || e.subjectCode))
                    .map(c => String(c || "").trim().toLowerCase())
                    .filter(Boolean)
            );
            const assignmentsSnapshot = await getDocs(collection(db, "facultySubjectAssignments"));
            const facultySubjectMap = new Map();
            assignmentsSnapshot.docs.forEach(d => {
                const data = d.data();
                const handled = Array.isArray(data.handledSubjects)
                    ? [...new Set(data.handledSubjects.flatMap(s => {
                        if (!s) return [];
                        if (typeof s === "object") {
                            const c = s.subjectCode || s.code || s.id || "";
                            return c ? [String(c).trim().toLowerCase()] : [];
                        }
                        const str = String(s).trim().toLowerCase();
                        if (!str) return [];
                        const res = [str];
                        if (str.includes("_")) {
                            const parts = str.split("_");
                            const last = parts[parts.length - 1].trim();
                            if (last) res.push(last);
                        }
                        return res;
                    }))]
                    : [];
                facultySubjectMap.set(d.id, handled);
                if (data.facultyId) facultySubjectMap.set(data.facultyId, handled);
            });

            const facultyUsers = rawFacultyUsers.filter(faculty => {
                const handled = facultySubjectMap.get(faculty.uid) || facultySubjectMap.get(faculty.id) || [];
                const handlesExamSubject = handled.some(c => affectedSubjectCodes.has(c));
                return !handlesExamSubject;
            });

            // 2. Fetch all examSchedules to check proctoring assignments on examDate
            const examSchedulesSnapshot = await getDocs(collection(db, "examSchedules"));
            const allExamSchedules = examSchedulesSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            // Evaluate candidates
            const candidateResults = facultyUsers.map(faculty => {
                const fullName = faculty.fullName || "Faculty Member";

                const assignedOnDate = [];
                allExamSchedules.forEach(schedule => {
                    const exams = Array.isArray(schedule.exams) ? schedule.exams : [];
                    const examDatesObj = schedule.examDates || {};

                    const matchingDays = Object.entries(examDatesObj)
                        .filter(([dayLabel, dateStr]) => !examDate || examDate === "All Exam Days" || dateStr === examDate || dayLabel === examDate)
                        .map(([dayLabel]) => dayLabel);

                    exams.forEach(exam => {
                        const isAssigned = exam.proctorUid === faculty.uid ||
                            String(exam.proctor || "").trim().toLowerCase() === String(fullName).trim().toLowerCase() ||
                            ((!exam.proctorUid && !exam.proctor) && (schedule.proctorUid === faculty.uid || String(schedule.proctor || "").trim().toLowerCase() === String(fullName).trim().toLowerCase()));

                        if (!isAssigned) return;

                        const matchesDate = !examDate || examDate === "All Exam Days" || matchingDays.includes(exam.day) || exam.day === examDate;
                        if (matchesDate) {
                            assignedOnDate.push({
                                scheduleId: schedule.id,
                                time: exam.time,
                                interval: parseTimeInterval(exam.time)
                            });
                        }
                    });
                });

                let conflictCount = 0;
                assignedOnDate.forEach(assignment => {
                    if (assignment.interval && affectedIntervals.length > 0) {
                        const hasOverlap = affectedIntervals.some(affInt => intervalsOverlap(affInt, assignment.interval));
                        if (hasOverlap) conflictCount++;
                    }
                });

                return {
                    faculty,
                    fullName,
                    uid: faculty.uid,
                    assignedCount: assignedOnDate.length,
                    conflictCount: conflictCount
                };
            });

            const zeroConflictCandidates = candidateResults.filter(c => c.conflictCount === 0);

            if (zeroConflictCandidates.length > 0) {
                zeroConflictCandidates.sort((a, b) => a.assignedCount - b.assignedCount);
                const selected = zeroConflictCandidates[0];

                // Update the exam schedule document at subject level
                await applyExamSubjectReassignment(currentRequest, selected.uid, selected.fullName);

                await updateDoc(doc(db, "rescheduleRequests", requestId), {
                    status: "approved",
                    replacementFacultyId: selected.uid,
                    replacementFacultyName: selected.fullName,
                    reviewedBy: currentAdminName,
                    reviewedAt: new Date(),
                    updatedAt: new Date()
                });

                const subjectLabel = currentRequest.subjectCode || "subject";
                closeRequestModal();
                await showActionModal(
                    "Reschedule Request Approved",
                    `Reschedule request approved!<br><br>System automatically assigned <strong>${safe(selected.fullName)}</strong> (0 time conflicts) as the replacement proctor for <strong>${safe(subjectLabel)}</strong>.`,
                    "success"
                );
            } else {
                approveBtn.disabled = false;
                approveBtn.textContent = "Approve";

                candidateFacultyList = candidateResults;
                revealManualReplacementFallback(candidateResults);
            }
        } catch (error) {
            console.error("Could not execute automated replacement search:", error);
            await showActionModal(
                "Action Failed",
                `Failed to execute replacement algorithm: ${safe(error.message)}`,
                "error"
            );
            approveBtn.disabled = false;
            approveBtn.textContent = "Approve";
        }
    }
}

function revealManualReplacementFallback(candidates) {
    const container = document.getElementById("manualReplacementContainer");
    const select = document.getElementById("manualReplacementSelect");
    const footerActions = document.getElementById("modalFooterActions");

    if (!container || !select) return;

    select.innerHTML = `<option value="">-- Select Replacement Faculty --</option>` +
        candidates.map(c => {
            const conflictInfo = c.conflictCount > 0 ? `(${c.conflictCount} time conflict${c.conflictCount > 1 ? 's' : ''})` : `(0 conflicts, ${c.assignedCount} exams)`;
            return `<option value="${safe(c.uid)}" data-name="${safe(c.fullName)}">${safe(c.fullName)} ${safe(conflictInfo)}</option>`;
        }).join("");

    container.style.display = "block";
    if (footerActions) footerActions.style.display = "none";
}

async function handleManualReassign() {
    if (!currentRequestId || !currentRequest) return;
    const select = document.getElementById("manualReplacementSelect");
    const replacementUid = select.value;
    const selectedOption = select.options[select.selectedIndex];
    const replacementName = selectedOption ? selectedOption.getAttribute("data-name") || selectedOption.text : "";

    if (!replacementUid) {
        alert("Please select a faculty member to reassign.");
        return;
    }

    const subjectLabel = currentRequest.subjectCode || "this exam";
    const confirmed = confirm(`Are you sure you want to manually reassign ${subjectLabel} to ${replacementName}?`);
    if (!confirmed) return;

    const confirmBtn = document.getElementById("confirmManualReassignBtn");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Reassigning...";

    try {
        await applyExamSubjectReassignment(currentRequest, replacementUid, replacementName);

        await updateDoc(doc(db, "rescheduleRequests", currentRequestId), {
            status: "approved",
            replacementFacultyId: replacementUid,
            replacementFacultyName: replacementName,
            reviewedBy: currentAdminName,
            reviewedAt: new Date(),
            updatedAt: new Date()
        });

        closeRequestModal();
        await showActionModal(
            "Proctoring Reassigned",
            `Proctoring for <strong>${safe(subjectLabel)}</strong> successfully reassigned to <strong>${safe(replacementName)}</strong>.`,
            "success"
        );
    } catch (error) {
        console.error("Could not execute manual reassign:", error);
        await showActionModal(
            "Reassign Failed",
            `Failed to reassign proctoring: ${safe(error.message)}`,
            "error"
        );
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Reassign";
    }
}

function getDate(data) {
    const value =
        data.updatedAt ||
        data.createdAt ||
        data.dateCreated ||
        data.timestamp;

    if (value?.toDate) {
        return value.toDate();
    }

    const date = new Date(value || 0);

    return Number.isNaN(date.getTime())
        ? new Date(0)
        : date;
}

function formatDate(date) {
    return date.getTime()
        ? date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric"
        })
        : "—";
}

function safe(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
}

document.getElementById("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try {
        await signOut(auth);
    } catch (e) {
        console.error("Sign out error:", e);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("home.html");
});

document.getElementById("closeModalBtn")?.addEventListener("click", closeRequestModal);

document.getElementById("modalApproveBtn")?.addEventListener("click", () => {
    handleRequestDecision(currentRequestId, "approved");
});

document.getElementById("modalDenyBtn")?.addEventListener("click", () => {
    handleRequestDecision(currentRequestId, "denied");
});

document.getElementById("confirmManualReassignBtn")?.addEventListener("click", handleManualReassign);

document.getElementById("requestModal")?.addEventListener("click", event => {
    if (event.target === document.getElementById("requestModal")) {
        closeRequestModal();
    }
});

/* ================================================================== */
/*  1. Faculty Subject Assignments — Horizontal Bar Chart             */
/* ================================================================== */

let facultyChartInstance = null;
let cachedFacultyAssignments = []; // [{ facultyId, fullName, count }]
let facultyNameMap = new Map();

async function initFacultySubjectAssignmentsChart() {
    try {
        const filterSelect = document.getElementById("facultyChartFilter");
        if (filterSelect) {
            filterSelect.addEventListener("change", () => {
                renderFacultyChart();
            });
        }

        // Fetch registered and legacy faculty names for lookup
        await loadFacultyNamesMap();

        // Listen in real-time to facultySubjectAssignments
        onSnapshot(
            collection(db, "facultySubjectAssignments"),
            snapshot => {
                const list = [];
                snapshot.docs.forEach(docSnap => {
                    const data = docSnap.data();
                    const handled = Array.isArray(data.handledSubjects) ? data.handledSubjects : [];
                    const facultyId = data.facultyId || docSnap.id;
                    const name = facultyNameMap.get(facultyId) || facultyNameMap.get(docSnap.id) || "Faculty Member";

                    if (handled.length > 0) {
                        list.push({
                            facultyId,
                            fullName: name,
                            count: handled.length
                        });
                    }
                });

                // Sort from highest to lowest
                list.sort((a, b) => b.count - a.count);
                cachedFacultyAssignments = list;
                renderFacultyChart();
            },
            error => {
                console.error("Error watching faculty subject assignments:", error);
                showFacultyChartEmptyState("No subject assignments yet.");
            }
        );
    } catch (err) {
        console.error("Failed to initialize faculty subject assignments chart:", err);
        showFacultyChartEmptyState("No subject assignments yet.");
    }
}

async function loadFacultyNamesMap() {
    try {
        const [usersSnap, legacySnap] = await Promise.all([
            getDocs(collection(db, "users")),
            getDocs(collection(db, "faculty"))
        ]);

        usersSnap.docs.forEach(d => {
            const data = d.data();
            const name = data.fullName || data.name || "";
            if (name) {
                facultyNameMap.set(d.id, name);
                if (data.uid) facultyNameMap.set(data.uid, name);
            }
        });

        legacySnap.docs.forEach(d => {
            const data = d.data();
            const name = data.fullName || data.name || data.facultyName || "";
            if (name) {
                if (!facultyNameMap.has(d.id)) facultyNameMap.set(d.id, name);
                if (data.uid && !facultyNameMap.has(data.uid)) facultyNameMap.set(data.uid, name);
            }
        });
    } catch (e) {
        console.warn("Could not load faculty name map:", e);
    }
}

function showFacultyChartEmptyState(message) {
    const emptyEl = document.getElementById("facultyChartEmptyState");
    const canvas = document.getElementById("facultySubjectsChart");
    if (emptyEl) {
        emptyEl.textContent = message || "No subject assignments yet.";
        emptyEl.style.display = "flex";
    }
    if (canvas) {
        canvas.style.display = "none";
    }
    if (facultyChartInstance) {
        facultyChartInstance.destroy();
        facultyChartInstance = null;
    }
}

function renderFacultyChart() {
    const canvas = document.getElementById("facultySubjectsChart");
    const emptyEl = document.getElementById("facultyChartEmptyState");
    const filterSelect = document.getElementById("facultyChartFilter");

    if (!canvas) return;

    if (!cachedFacultyAssignments || cachedFacultyAssignments.length === 0) {
        showFacultyChartEmptyState("No subject assignments yet.");
        return;
    }

    const filterVal = filterSelect ? filterSelect.value : "5";
    let dataToDisplay = [...cachedFacultyAssignments];

    if (filterVal === "5") {
        dataToDisplay = dataToDisplay.slice(0, 5);
    } else if (filterVal === "10") {
        dataToDisplay = dataToDisplay.slice(0, 10);
    }

    if (dataToDisplay.length === 0) {
        showFacultyChartEmptyState("No subject assignments yet.");
        return;
    }

    if (emptyEl) emptyEl.style.display = "none";
    canvas.style.display = "block";

    const labels = dataToDisplay.map(d => d.fullName);
    const dataValues = dataToDisplay.map(d => d.count);
    const maxVal = Math.max(...dataValues, 1);

    if (facultyChartInstance) {
        facultyChartInstance.destroy();
    }

    if (typeof Chart === "undefined") {
        console.warn("Chart.js is not loaded.");
        return;
    }

    const endOfBarPlugin = {
        id: "endOfBarValues",
        afterDatasetsDraw(chart) {
            const { ctx, scales: { x } } = chart;
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                meta.data.forEach((bar, index) => {
                    const value = dataset.data[index];
                    ctx.save();
                    ctx.fillStyle = "#1b5e20";
                    ctx.font = "bold 12px Arial, sans-serif";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "middle";
                    const xPos = bar.x + 8;
                    const yPos = bar.y;
                    ctx.fillText(String(value), xPos, yPos);
                    ctx.restore();
                });
            });
        }
    };

    facultyChartInstance = new Chart(canvas, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "Assigned Subjects",
                data: dataValues,
                backgroundColor: "rgba(46, 125, 50, 0.85)",
                borderColor: "#2e7d32",
                borderWidth: 1,
                borderRadius: 6,
                barPercentage: 0.7,
                categoryPercentage: 0.85
            }]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    right: 35
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "rgba(27, 94, 32, 0.92)",
                    titleFont: { weight: "bold", size: 13 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    callbacks: {
                        label: context => ` ${context.parsed.x} assigned subject${context.parsed.x === 1 ? "" : "s"}`
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    suggestedMax: maxVal + 1,
                    ticks: {
                        precision: 0,
                        color: "#555",
                        font: { size: 11 }
                    },
                    grid: {
                        color: "rgba(0, 0, 0, 0.05)"
                    },
                    title: {
                        display: true,
                        text: "Number of Assigned Subjects",
                        color: "#666",
                        font: { size: 11, weight: "bold" }
                    }
                },
                y: {
                    ticks: {
                        color: "#1a1a1a",
                        font: { size: 12, weight: "bold" }
                    },
                    grid: {
                        display: false
                    }
                }
            },
            animation: {
                duration: 600,
                easing: "easeOutQuart"
            }
        },
        plugins: [endOfBarPlugin]
    });
}

/* ================================================================== */
/*  2. Schedule Overview — Donut Chart                                */
/* ================================================================== */

let scheduleOverviewChartInstance = null;
let rawClassSchedules = [];
let rawExamSchedules = [];
let rawRescheduleRequests = [];

function initScheduleOverviewChart() {
    try {
        const filterSelect = document.getElementById("scheduleOverviewFilter");
        if (filterSelect) {
            filterSelect.addEventListener("change", () => {
                renderScheduleOverviewChart();
            });
        }

        // Real-time watchers for the 3 categories
        onSnapshot(collection(db, "classSchedules"), snapshot => {
            rawClassSchedules = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            renderScheduleOverviewChart();
        }, err => console.warn("Chart classSchedules watch error:", err));

        onSnapshot(collection(db, "examSchedules"), snapshot => {
            rawExamSchedules = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            renderScheduleOverviewChart();
        }, err => console.warn("Chart examSchedules watch error:", err));

        onSnapshot(collection(db, "rescheduleRequests"), snapshot => {
            rawRescheduleRequests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            renderScheduleOverviewChart();
        }, err => console.warn("Chart rescheduleRequests watch error:", err));

    } catch (err) {
        console.error("Failed to initialize schedule overview chart:", err);
        showScheduleOverviewEmptyState("No schedule data available.");
    }
}

function matchSemesterFilter(recordSemester, filterValue) {
    if (filterValue === "all") return true;

    const semStr = String(recordSemester || "").trim().toLowerCase();

    if (filterValue === "1st Semester") {
        return semStr.includes("1") || semStr.includes("first");
    }

    if (filterValue === "2nd Semester") {
        return semStr.includes("2") || semStr.includes("second");
    }

    if (filterValue === "this_semester") {
        // Dynamic detection of current academic semester: Aug-Dec is 1st sem, Jan-Jul is 2nd sem
        const month = new Date().getMonth(); // 0-indexed: 7=Aug, 11=Dec
        const isFirstSem = (month >= 7 || month === 0);
        return isFirstSem
            ? (semStr.includes("1") || semStr.includes("first") || !semStr)
            : (semStr.includes("2") || semStr.includes("second"));
    }

    return true;
}

function showScheduleOverviewEmptyState(message) {
    const emptyEl = document.getElementById("scheduleChartEmptyState");
    const legendEl = document.getElementById("scheduleOverviewLegend");
    const totalCountEl = document.getElementById("donutTotalCount");

    if (emptyEl) {
        emptyEl.textContent = message || "No schedule data available.";
        emptyEl.style.display = "flex";
    }
    if (totalCountEl) totalCountEl.textContent = "0";

    if (legendEl) {
        legendEl.innerHTML = `
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#2e7d32;"></span>
                    <span class="legend-name">Class Schedules</span>
                </div>
                <div class="legend-values"><span class="legend-count">0</span><span class="legend-pct">0.0%</span></div>
            </div>
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#3b82f6;"></span>
                    <span class="legend-name">Exam Schedules</span>
                </div>
                <div class="legend-values"><span class="legend-count">0</span><span class="legend-pct">0.0%</span></div>
            </div>
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#f59e0b;"></span>
                    <span class="legend-name">Reschedule Requests</span>
                </div>
                <div class="legend-values"><span class="legend-count">0</span><span class="legend-pct">0.0%</span></div>
            </div>
        `;
    }

    if (scheduleOverviewChartInstance) {
        scheduleOverviewChartInstance.destroy();
        scheduleOverviewChartInstance = null;
    }
}

function renderScheduleOverviewChart() {
    const canvas = document.getElementById("scheduleOverviewChart");
    const emptyEl = document.getElementById("scheduleChartEmptyState");
    const legendEl = document.getElementById("scheduleOverviewLegend");
    const totalCountEl = document.getElementById("donutTotalCount");
    const filterSelect = document.getElementById("scheduleOverviewFilter");

    if (!canvas) return;

    const filterVal = filterSelect ? filterSelect.value : "this_semester";

    const classCount = rawClassSchedules.filter(s => matchSemesterFilter(s.semester, filterVal)).length;
    const examCount = rawExamSchedules.filter(s => matchSemesterFilter(s.semester, filterVal)).length;
    const requestCount = rawRescheduleRequests.filter(s => {
        // If request has semester, check it; otherwise, check if its affectedExams have matching semester
        if (s.semester) return matchSemesterFilter(s.semester, filterVal);
        if (Array.isArray(s.affectedExams) && s.affectedExams.length > 0) {
            return matchSemesterFilter(s.affectedExams[0]?.semester, filterVal);
        }
        return matchSemesterFilter("", filterVal);
    }).length;

    const totalCount = classCount + examCount + requestCount;

    if (totalCountEl) {
        totalCountEl.textContent = totalCount;
    }

    // Calculate percentages
    const classPct = totalCount > 0 ? ((classCount / totalCount) * 100).toFixed(1) : "0.0";
    const examPct = totalCount > 0 ? ((examCount / totalCount) * 100).toFixed(1) : "0.0";
    const requestPct = totalCount > 0 ? ((requestCount / totalCount) * 100).toFixed(1) : "0.0";

    // Render legend
    if (legendEl) {
        legendEl.innerHTML = `
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#2e7d32;"></span>
                    <span class="legend-name">Class Schedules</span>
                </div>
                <div class="legend-values">
                    <span class="legend-count">${classCount}</span>
                    <span class="legend-pct">${classPct}%</span>
                </div>
            </div>
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#3b82f6;"></span>
                    <span class="legend-name">Exam Schedules</span>
                </div>
                <div class="legend-values">
                    <span class="legend-count">${examCount}</span>
                    <span class="legend-pct">${examPct}%</span>
                </div>
            </div>
            <div class="legend-row">
                <div class="legend-label-group">
                    <span class="legend-color-dot" style="background:#f59e0b;"></span>
                    <span class="legend-name">Reschedule Requests</span>
                </div>
                <div class="legend-values">
                    <span class="legend-count">${requestCount}</span>
                    <span class="legend-pct">${requestPct}%</span>
                </div>
            </div>
        `;
    }

    if (totalCount === 0) {
        showScheduleOverviewEmptyState("No schedule data available.");
        return;
    }

    if (emptyEl) emptyEl.style.display = "none";
    canvas.style.display = "block";

    if (scheduleOverviewChartInstance) {
        scheduleOverviewChartInstance.destroy();
    }

    if (typeof Chart === "undefined") {
        console.warn("Chart.js is not loaded.");
        return;
    }

    scheduleOverviewChartInstance = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: ["Class Schedules", "Exam Schedules", "Reschedule Requests"],
            datasets: [{
                data: [classCount, examCount, requestCount],
                backgroundColor: [
                    "#2e7d32",
                    "#3b82f6",
                    "#f59e0b"
                ],
                borderColor: "#ffffff",
                borderWidth: 2,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: "70%",
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "rgba(27, 94, 32, 0.92)",
                    titleFont: { weight: "bold", size: 13 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        label: context => {
                            const val = context.parsed;
                            const pct = totalCount > 0 ? ((val / totalCount) * 100).toFixed(1) : 0;
                            return ` ${context.label}: ${val} (${pct}%)`;
                        }
                    }
                }
            },
            animation: {
                animateRotate: true,
                animateScale: true,
                duration: 700,
                easing: "easeOutQuart"
            }
        }
    });
}
