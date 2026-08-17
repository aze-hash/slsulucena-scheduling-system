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
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* =========================
   API
========================= */

const API_URL = "https://slsulucena-scheduling-system.onrender.com";

/* =========================
   STATE
========================= */

let allUsers = [];
let currentTab = "Student";
let searchTerm = "";
let programFilter = "";
let majorFilter = "";

/* =========================
   AUTHENTICATION
========================= */

onAuthStateChanged(auth, async user => {
    if (!user) {
        location.href = "login.html";
        return;
    }

    try {
        const profile = await getDoc(doc(db, "users", user.uid));

        if (!profile.exists() || profile.data().role !== "Admin") {
            location.href = "login.html";
            return;
        }

        document.getElementById("adminName").textContent =
            profile.data().fullName || "SLSU Admin";

        // Load users through the secure Render API
        await loadUsers();

    } catch (error) {
        console.error("Authentication/profile error:", error);

        document.getElementById("usersNotice").textContent =
            "Unable to verify administrator access.";
    }
});

/* =========================
   LOAD USERS FROM RENDER API / FIRESTORE
========================= */

async function loadUsers() {
    let rawUsers = [];

    try {
        const user = auth.currentUser;

        if (!user) {
            console.error("No authenticated user.");
            return;
        }

        // Get Firebase ID token
        const token = await user.getIdToken();

        const response = await fetch(`${API_URL}/users`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (response.ok) {
            rawUsers = await response.json();
        } else {
            throw new Error(`API GET /users returned status ${response.status}`);
        }
    } catch (apiError) {
        console.warn("Could not load users via API, trying direct Firestore load:", apiError);
        try {
            const snapshot = await getDocs(collection(db, "users"));
            rawUsers = snapshot.docs.map(docSnap => ({
                ...docSnap.data(),
                id: docSnap.id,
                uid: docSnap.id
            }));
        } catch (fsError) {
            console.error("Could not load users from Firestore fallback:", fsError);
            document.getElementById("usersNotice").textContent =
                "Unable to load users. Please try again.";
            document.getElementById("usersTableBody").innerHTML = `
                <tr>
                    <td colspan="5" class="empty-state">
                        Unable to load users.
                    </td>
                </tr>
            `;
            return;
        }
    }

    allUsers = (rawUsers || []).map(u => {
        const docId = u.id || u.uid || u.docId || u._id;
        return {
            ...u,
            id: docId,
            uid: docId
        };
    });

    console.log("Users loaded successfully:", allUsers.length);

    updateCounts();
    renderUsers();
}

/* =========================
   UPDATE COUNTS
========================= */

function updateCounts() {
    const studentCount = allUsers.filter(user =>
        String(user.role || "").toLowerCase() === "student"
    ).length;

    const facultyCount = allUsers.filter(user =>
        String(user.role || "").toLowerCase() === "faculty"
    ).length;

    document.getElementById("studentCountBadge").textContent =
        studentCount;

    document.getElementById("facultyCountBadge").textContent =
        facultyCount;

    const totalCount = studentCount + facultyCount;

    document.getElementById("usersNotice").textContent =
        `Showing ${totalCount} total registered user${totalCount === 1 ? "" : "s"}.`;
}

/* =========================
   FILTER USERS
========================= */

function getFilteredUsers() {
    const role = currentTab.toLowerCase();

    return allUsers
        .filter(user =>
            String(user.role || "").toLowerCase() === role
        )

        .filter(user => {
            if (!searchTerm) return true;

            const name = String(user.fullName || "").toLowerCase();
            const email = String(user.email || "").toLowerCase();
            const term = searchTerm.toLowerCase();

            return (
                name.includes(term) ||
                email.includes(term)
            );
        })

        .filter(user => {
            if (!programFilter) return true;

            return (
                String(user.program || "").toLowerCase() ===
                programFilter.toLowerCase()
            );
        })

        .filter(user => {
            if (!majorFilter) return true;

            return (
                String(user.major || "").toLowerCase() ===
                majorFilter.toLowerCase()
            );
        })

        .sort((a, b) => {
            const nameA =
                String(a.fullName || "").toUpperCase();

            const nameB =
                String(b.fullName || "").toUpperCase();

            return nameA.localeCompare(nameB);
        });
}

/* =========================
   RENDER USERS
========================= */

function renderUsers() {
    const body = document.getElementById("usersTableBody");
    const users = getFilteredUsers();

    const title =
        currentTab === "Student"
            ? "Registered Students"
            : "Registered Faculty";

    document.getElementById("tableTitle").textContent = title;

    const isStudent = currentTab === "Student";

    // Show/hide Program / Major column
    document.getElementById("programMajorHeader").style.display =
        isStudent ? "" : "none";

    if (!users.length) {
        body.innerHTML = `
            <tr>
                <td colspan="${isStudent ? 5 : 4}" class="empty-state">
                    No ${currentTab.toLowerCase()} users found.
                </td>
            </tr>
        `;

        return;
    }

    body.innerHTML = users.map(user => {
        const initials = getInitials(user.fullName);

        const program = user.program
            ? `<span class="program-tag">${safe(user.program)}</span>`
            : "";

        const major = user.major
            ? `<span class="major-tag">${safe(user.major)}</span>`
            : "";

        const programMajor = (program || major)
            ? `<div>${program}${major}</div>`
            : `<span class="date-text">—</span>`;

        const roleClass =
            isStudent
                ? "role-student"
                : "role-faculty";

        return `
            <tr>
                <td>
                    <div class="user-cell">
                        <div class="user-avatar">
                            ${safe(initials)}
                        </div>

                        <div>
                            <div class="user-name">
                                ${safe(user.fullName || "Unknown")}
                            </div>

                            <div class="user-email">
                                ${safe(user.email || "—")}
                            </div>
                        </div>
                    </div>
                </td>

                <td>
                    <span class="role-badge ${roleClass}">
                        ${safe(currentTab)}
                    </span>
                </td>

                ${isStudent ? `<td>${programMajor}</td>` : ""}

                <td class="date-text">
                    ${safe(formatDate(getDate(user)))}
                </td>

                <td>
                    <button
                        class="delete-btn"
                        data-user-id="${safe(user.id || user.uid)}"
                        data-user-name="${safe(user.fullName || "Unknown")}"
                    >
                        Delete
                    </button>
                </td>
            </tr>
        `;
    }).join("");

    /* =========================
       DELETE BUTTONS
    ========================= */

    body.querySelectorAll(".delete-btn").forEach(button => {

        button.addEventListener("click", () => {

            const userId =
                button.dataset.userId;

            const userName =
                button.dataset.userName;

            handleDeleteUser(
                userId,
                userName
            );
        });

    });
}

/* =========================
   DELETE USER
========================= */

async function handleDeleteUser(userId, userName) {

    if (!userId) {
        console.error("Cannot delete user: Missing user ID.");
        return;
    }

    const confirmed = confirm(
        `Are you sure you want to delete ${userName}?\n\n` +
        `This will permanently remove their account and all associated data.`
    );

    if (!confirmed) return;

    try {
        const user = auth.currentUser;

        if (!user) {
            throw new Error(
                "You are not authenticated."
            );
        }

        let deletedViaApi = false;

        try {
            // Get Firebase ID token
            const token = await user.getIdToken();

            console.log(
                `Deleting user through Render API: ${userId}`
            );

            const response = await fetch(
                `${API_URL}/users/${encodeURIComponent(userId)}`,
                {
                    method: "DELETE",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (response.ok) {
                const result = await response.json();
                console.log("User deleted successfully via API:", result);
                deletedViaApi = true;
            } else {
                console.warn(`Render API returned status ${response.status}. Attempting direct Firestore delete...`);
            }
        } catch (apiError) {
            console.warn("Could not reach Render API for user deletion, attempting direct Firestore delete:", apiError);
        }

        // Always delete document from Firestore if API failed or as backup
        if (!deletedViaApi) {
            await deleteDoc(doc(db, "users", userId));
            console.log(`User document deleted directly from Firestore: ${userId}`);
        }

        alert(
            `${userName} has been deleted successfully.`
        );

        // Remove immediately from local array
        allUsers = allUsers.filter(
            user => (user.id !== userId && user.uid !== userId)
        );

        updateCounts();
        renderUsers();

    } catch (error) {

        console.error(
            "Could not delete user:",
            error
        );

        alert(
            `Failed to delete ${userName}.\n\n${error.message}`
        );
    }
}

/* =========================
   INITIALS
========================= */

function getInitials(name) {

    if (!name) return "?";

    return name
        .split(" ")
        .filter(part => part.length > 0)
        .slice(0, 2)
        .map(part =>
            part[0].toUpperCase()
        )
        .join("");
}

function getDate(data) {
    if (!data) return new Date(0);

    const value =
        data.createdAt ||
        data.registeredAt ||
        data.updatedAt ||
        data.dateCreated ||
        data.timestamp;

    if (!value) return new Date(0);

    if (typeof value.toDate === "function") {
        return value.toDate();
    }

    if (typeof value._seconds === "number") {
        return new Date(value._seconds * 1000);
    }

    if (typeof value.seconds === "number") {
        return new Date(value.seconds * 1000);
    }

    if (typeof value === "number") {
        return new Date(value < 10000000000 ? value * 1000 : value);
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function formatDate(date) {
    if (!date || !date.getTime || date.getTime() === 0) return "—";

    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

/* =========================
   HTML SAFETY
========================= */

function safe(value) {

    if (value === undefined || value === null) return "";

    const span =
        document.createElement("span");

    span.textContent = value;

    return span.innerHTML;
}

/* =========================
   TAB SWITCHING
========================= */

document
    .getElementById("tabStudents")
    .addEventListener("click", () => {

        currentTab = "Student";

        document
            .getElementById("tabStudents")
            .classList.add("active");

        document
            .getElementById("tabFaculty")
            .classList.remove("active");

        document
            .getElementById("programFilter")
            .style.display = "";

        document
            .getElementById("majorFilter")
            .style.display = "";

        renderUsers();
    });

document
    .getElementById("tabFaculty")
    .addEventListener("click", () => {

        currentTab = "Faculty";

        document
            .getElementById("tabFaculty")
            .classList.add("active");

        document
            .getElementById("tabStudents")
            .classList.remove("active");

        document
            .getElementById("programFilter")
            .style.display = "none";

        document
            .getElementById("majorFilter")
            .style.display = "none";

        renderUsers();
    });

/* =========================
   SEARCH
========================= */

document
    .getElementById("searchInput")
    .addEventListener("input", event => {

        searchTerm =
            event.target.value.trim();

        renderUsers();
    });

/* =========================
   PROGRAM & MAJOR FILTERS
========================= */

const programFilterEl =
    document.getElementById("programFilter");

const majorFilterEl =
    document.getElementById("majorFilter");

programFilterEl.addEventListener(
    "change",
    () => {

        programFilter =
            programFilterEl.value;

        majorFilter = "";

        majorFilterEl.innerHTML =
            `<option value="">All Majors</option>`;

        if (
            programFilter === "BIT" ||
            programFilter === "BINDTECH"
        ) {
            majorFilterEl.innerHTML +=
                `<option value="CPT">CPT</option>`;
        }

        if (
            programFilter === "BTVTED"
        ) {
            majorFilterEl.innerHTML += `
                <option value="AT">AT</option>
                <option value="MT">MT</option>
                <option value="CP">CP</option>
                <option value="FSM">FSM</option>
                <option value="CT">CT</option>
                <option value="ELT">ELT</option>
                <option value="ELX">ELX</option>
            `;
        }

        renderUsers();
    }
);

majorFilterEl.addEventListener(
    "change",
    () => {

        majorFilter =
            majorFilterEl.value;

        renderUsers();
    }
);

/* =========================
   LOGOUT
========================= */

document
    .getElementById("logoutLink")
    .addEventListener("click", async event => {

        event.preventDefault();

        await signOut(auth);

        location.href = "login.html";
    });