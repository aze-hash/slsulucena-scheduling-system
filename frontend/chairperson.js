import { auth, db } from "../firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

import {
    doc,
    getDoc,
    collection,
    query,
    where,
    onSnapshot,
    updateDoc,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

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

    document.getElementById("adminName").textContent =
        profile.data().fullName || "SLSU Admin";

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
                `<tr><td colspan="4">Unable to load reschedule requests.</td></tr>`;
        }
    );
}

function renderRescheduleRequests(requests) {
    const body = document.getElementById("rescheduleRequestsBody");

    if (!requests.length) {
        body.innerHTML = `<tr><td colspan="4">No reschedule requests have been submitted yet.</td></tr>`;
        return;
    }

    const sorted = [...requests].sort((a, b) => getDate(b) - getDate(a));

    body.innerHTML = sorted.map(request => {
        return `
            <tr>
                <td>${safe(request.facultyName || "Unknown Faculty")}</td>
                <td>${safe(request.section || "-")}</td>
                <td>${safe(formatDate(getDate(request)))}</td>
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

let currentRequestId = null;

function openRequestModal(request) {
    currentRequestId = request.id;

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

    document.getElementById("modalApproveBtn").style.display =
        isPending ? "inline-block" : "none";
    document.getElementById("modalDenyBtn").style.display =
        isPending ? "inline-block" : "none";

    document.getElementById("requestModal").style.display = "flex";
}

function closeRequestModal() {
    document.getElementById("requestModal").style.display = "none";
    currentRequestId = null;
}

async function handleRequestDecision(requestId, action) {
    if (!requestId) return;

    const label = action === "approved" ? "approve" : "deny";
    const confirmed = confirm(`Are you sure you want to ${label} this reschedule request?`);

    if (!confirmed) return;

    try {
        await updateDoc(doc(db, "rescheduleRequests", requestId), {
            status: action,
            reviewedAt: new Date(),
            updatedAt: new Date()
        });
        closeRequestModal();
    } catch (error) {
        console.error(`Could not ${label} request:`, error);
        alert(`Failed to ${label} the request. Please try again.`);
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

document.getElementById("logoutLink").addEventListener("click", async event => {
    event.preventDefault();
    await signOut(auth);
    location.href = "login.html";
});

document.getElementById("closeModalBtn").addEventListener("click", closeRequestModal);

document.getElementById("modalApproveBtn").addEventListener("click", () => {
    handleRequestDecision(currentRequestId, "approved");
});

document.getElementById("modalDenyBtn").addEventListener("click", () => {
    handleRequestDecision(currentRequestId, "denied");
});

document.getElementById("requestModal").addEventListener("click", event => {
    if (event.target === document.getElementById("requestModal")) {
        closeRequestModal();
    }
});
