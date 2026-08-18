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
        location.href = "login.html";
        return;
    }

    const profile = await getDoc(doc(db, "users", user.uid));

    if (!profile.exists() || profile.data().role !== "Admin") {
        location.href = "login.html";
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
        body.innerHTML = `<tr><td colspan="6">No reschedule requests have been submitted yet.</td></tr>`;
        return;
    }

    const sorted = [...requests].sort((a, b) => getDate(b) - getDate(a));

    body.innerHTML = sorted.map(request => {
        const status = String(request.status || "pending").toLowerCase();
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
        const statusClass = status === "approved" ? "status-approved" :
            status === "denied" ? "status-denied" : "status-pending";

        const examDateDisplay = request.examDateLabel || request.examDate || "-";

        return `
            <tr>
                <td>${safe(request.facultyName || request.requestingFacultyName || "Unknown Faculty")}</td>
                <td>${safe(request.section || "-")}</td>
                <td>${safe(examDateDisplay)}</td>
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
    document.getElementById("modalSection").textContent =
        request.section || "-";
    document.getElementById("modalExamDate").textContent =
        request.examDateLabel || request.examDate || "-";
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

    // Render journey preview
    const previewContainer = document.getElementById("modalJourneyPreview");
    const affectedExams = Array.isArray(request.affectedExams) ? request.affectedExams : [];

    if (affectedExams.length) {
        const rows = affectedExams.map(exam => `
            <tr>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.time || "-")}</td>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.code || "-")} — ${safe(exam.name || "-")}</td>
                <td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${safe(exam.room || "-")}</td>
            </tr>
        `).join("");

        previewContainer.innerHTML = `
            <table class="exam-pdf-style" style="width: 100%; border-collapse: collapse; font-size: 0.9em; border: 1px solid #cbd5e1;">
                <thead>
                    <tr style="background: #f1f5f9; text-align: left;">
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

function intervalsOverlap(intA, intB) {
    if (!intA || !intB) return false;
    return Math.max(intA.start, intB.start) < Math.min(intA.end, intB.end);
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
            alert("Reschedule request has been denied.");
            closeRequestModal();
        } catch (error) {
            console.error("Could not deny request:", error);
            alert("Failed to deny the request. Please try again.");
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
            const affectedExams = Array.isArray(currentRequest.affectedExams) ? currentRequest.affectedExams : [];
            const affectedScheduleIds = Array.isArray(currentRequest.affectedExamScheduleIds)
                ? currentRequest.affectedExamScheduleIds
                : (currentRequest.examScheduleId ? [currentRequest.examScheduleId] : []);

            const affectedIntervals = affectedExams
                .map(e => parseTimeInterval(e.time))
                .filter(Boolean);

            // 1. Fetch registered faculty from users collection
            const usersSnapshot = await getDocs(collection(db, "users"));
            const facultyUsers = usersSnapshot.docs
                .map(d => ({ uid: d.id, ...d.data() }))
                .filter(u => String(u.role || "").toLowerCase() === "faculty")
                .filter(u => u.uid !== currentRequest.requestingFacultyId && u.uid !== currentRequest.facultyUid);

            // 2. Fetch all examSchedules to check proctoring assignments on examDate
            const examSchedulesSnapshot = await getDocs(collection(db, "examSchedules"));
            const allExamSchedules = examSchedulesSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            // Evaluate candidates
            const candidateResults = facultyUsers.map(faculty => {
                const fullName = faculty.fullName || "Faculty Member";

                const assignedOnDate = [];
                allExamSchedules.forEach(schedule => {
                    const matchesFaculty = schedule.proctorUid === faculty.uid ||
                        schedule.facultyUid === faculty.uid ||
                        schedule.assignedFacultyUid === faculty.uid ||
                        String(schedule.proctor || "").trim().toLowerCase() === String(fullName).trim().toLowerCase();

                    if (!matchesFaculty) return;

                    const examDatesObj = schedule.examDates || {};
                    const exams = Array.isArray(schedule.exams) ? schedule.exams : [];

                    const matchingDays = Object.entries(examDatesObj)
                        .filter(([dayLabel, dateStr]) => dateStr === examDate)
                        .map(([dayLabel]) => dayLabel);

                    const dayExams = exams.filter(e => matchingDays.includes(e.day) || e.day === examDate);
                    dayExams.forEach(exam => {
                        assignedOnDate.push({
                            scheduleId: schedule.id,
                            time: exam.time,
                            interval: parseTimeInterval(exam.time)
                        });
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

                for (const schedId of affectedScheduleIds) {
                    await updateDoc(doc(db, "examSchedules", schedId), {
                        proctor: selected.fullName,
                        proctorUid: selected.uid,
                        facultyUid: selected.uid,
                        assignedFacultyUid: selected.uid,
                        updatedAt: new Date()
                    });
                }

                await updateDoc(doc(db, "rescheduleRequests", requestId), {
                    status: "approved",
                    replacementFacultyId: selected.uid,
                    replacementFacultyName: selected.fullName,
                    reviewedBy: currentAdminName,
                    reviewedAt: new Date(),
                    updatedAt: new Date()
                });

                alert(`Reschedule request approved! System automatically assigned ${selected.fullName} (0 time conflicts) as the replacement proctor for the entire day.`);
                closeRequestModal();
            } else {
                approveBtn.disabled = false;
                approveBtn.textContent = "Approve";

                candidateFacultyList = candidateResults;
                revealManualReplacementFallback(candidateResults);
            }
        } catch (error) {
            console.error("Could not execute automated replacement search:", error);
            alert(`Failed to execute replacement algorithm: ${error.message}`);
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

    const confirmed = confirm(`Are you sure you want to manually reassign this exam journey to ${replacementName}?`);
    if (!confirmed) return;

    const confirmBtn = document.getElementById("confirmManualReassignBtn");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Reassigning...";

    try {
        const affectedScheduleIds = Array.isArray(currentRequest.affectedExamScheduleIds)
            ? currentRequest.affectedExamScheduleIds
            : (currentRequest.examScheduleId ? [currentRequest.examScheduleId] : []);

        for (const schedId of affectedScheduleIds) {
            await updateDoc(doc(db, "examSchedules", schedId), {
                proctor: replacementName,
                proctorUid: replacementUid,
                facultyUid: replacementUid,
                assignedFacultyUid: replacementUid,
                updatedAt: new Date()
            });
        }

        await updateDoc(doc(db, "rescheduleRequests", currentRequestId), {
            status: "approved",
            replacementFacultyId: replacementUid,
            replacementFacultyName: replacementName,
            reviewedBy: currentAdminName,
            reviewedAt: new Date(),
            updatedAt: new Date()
        });

        alert(`Proctoring successfully reassigned to ${replacementName}.`);
        closeRequestModal();
    } catch (error) {
        console.error("Could not execute manual reassign:", error);
        alert(`Failed to reassign proctoring: ${error.message}`);
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
    await signOut(auth);
    location.href = "login.html";
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
