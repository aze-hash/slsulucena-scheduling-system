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
    deleteDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* =========================
   API
========================= */

const API_URL = "https://slsulucena-scheduling-system.onrender.com";

/* =========================
   STATE
========================= */

let allUsers = [];
let facultyAssignmentsMap = new Map(); // maps facultyUserId -> string[] handledSubjects
let prospectusSubjects = []; // cached prospectus subjects from Firestore
let currentTab = "Student";
let searchTerm = "";
let programFilter = "";
let majorFilter = "";

// Modal State
let activeFacultyUser = null;
let selectedSubjectKeys = new Set(); // composite keys: `${programCode}_${majorCode}_${yearLevel}_${semester}_${subjectCode}`
let modalSearchTerm = "";
let modalProgramFilter = "";
let modalMajorFilter = "";
let modalYearFilter = "";
let modalSemesterFilter = "";

/* =========================
   COMPOSITE SUBJECT KEY
========================= */

/**
 * Returns a composite key that uniquely identifies a prospectus subject record,
 * even when multiple subjects share the same subjectCode across different programs/majors.
 * Format: `${programCode}_${majorCode}_${yearLevel}_${semester}_${subjectCode}`
 */
function getSubjectKey(subject) {
    return [
        String(subject.programCode  || "").trim(),
        String(subject.majorCode    || "").trim(),
        String(subject.yearLevel    || "").trim(),
        String(subject.semester     || "").trim(),
        String(subject.subjectCode  || "").trim()
    ].join("_");
}

/* =========================
   AUTHENTICATION
========================= */

onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.replace("login.html");
        return;
    }

    try {
        const profile = await getDoc(doc(db, "users", user.uid));

        if (!profile.exists() || profile.data().role !== "Admin") {
            window.location.replace("login.html");
            return;
        }

        document.getElementById("adminName").textContent =
            profile.data().fullName || "SLSU Admin";

        // Load users, faculty subject assignments, and prospectus subjects concurrently in parallel
        await Promise.all([
            loadFacultySubjectAssignments(),
            loadProspectusSubjects(),
            loadUsers()
        ]);

    } catch (error) {
        console.error("Authentication/profile error:", error);

        document.getElementById("usersNotice").textContent =
            "Unable to verify administrator access.";
    }
});

/* =========================
   LOAD FACULTY SUBJECT ASSIGNMENTS
========================= */

let facultyAssignmentsPromise = null;

async function loadFacultySubjectAssignments() {
    if (facultyAssignmentsPromise) return facultyAssignmentsPromise;

    facultyAssignmentsPromise = (async () => {
        facultyAssignmentsMap.clear();
        try {
            const snapshot = await getDocs(collection(db, "facultySubjectAssignments"));
            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                const handled = Array.isArray(data.handledSubjects) ? data.handledSubjects : [];
                facultyAssignmentsMap.set(docSnap.id, handled);
                if (data.facultyId && data.facultyId !== docSnap.id) {
                    facultyAssignmentsMap.set(data.facultyId, handled);
                }
            });
            console.log("Faculty subject assignments loaded:", facultyAssignmentsMap.size);
        } catch (error) {
            console.warn("Could not load faculty subject assignments from Firestore:", error);
        } finally {
            facultyAssignmentsPromise = null;
        }
    })();

    return facultyAssignmentsPromise;
}

/* =========================
   LOAD PROSPECTUS SUBJECTS
========================= */

let prospectusPromise = null;

async function loadProspectusSubjects() {
    if (prospectusSubjects.length > 0) return prospectusSubjects;
    if (prospectusPromise) return prospectusPromise;

    prospectusPromise = (async () => {
        try {
            const snapshot = await getDocs(collection(db, "prospectus"));
            const list = [];

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data();
                if (!data.subjectCode) return;

                list.push({
                    id: docSnap.id,
                    subjectCode: String(data.subjectCode || "").trim(),
                    subjectName: String(data.subjectName || "").trim(),
                    programCode: String(data.programCode || "").trim(),
                    majorCode: String(data.majorCode || "").trim(),
                    yearLevel: data.yearLevel !== undefined ? Number(data.yearLevel) : "",
                    semester: data.semester !== undefined ? Number(data.semester) : "",
                    units: data.units !== undefined ? Number(data.units) : "",
                    subjectType: data.subjectType || ""
                });
            });

            prospectusSubjects = list;
            console.log("Prospectus subjects loaded:", prospectusSubjects.length);
            return prospectusSubjects;
        } catch (error) {
            console.error("Could not load prospectus subjects:", error);
            return [];
        } finally {
            prospectusPromise = null;
        }
    })();

    return prospectusPromise;
}

/* =========================
   LOAD USERS FROM RENDER API / FIRESTORE
========================= */

let usersPromise = null;

async function loadUsers() {
    if (usersPromise) return usersPromise;

    usersPromise = (async () => {
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

        // Ensure faculty assignments are loaded before rendering user table
        await loadFacultySubjectAssignments();

        updateCounts();
        renderUsers();
    })().finally(() => {
        usersPromise = null;
    });

    return usersPromise;
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
   RENDER USERS TABLE
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

    // Toggle column headers: Students have Program/Major; Faculty have Assigned Subjects
    const programMajorHeader = document.getElementById("programMajorHeader");
    const assignedSubjectsHeader = document.getElementById("assignedSubjectsHeader");

    if (programMajorHeader) {
        programMajorHeader.style.display = isStudent ? "" : "none";
    }
    if (assignedSubjectsHeader) {
        assignedSubjectsHeader.style.display = isStudent ? "none" : "";
    }

    if (!users.length) {
        body.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state">
                    No ${currentTab.toLowerCase()} users found.
                </td>
            </tr>
        `;

        return;
    }

    body.innerHTML = users.map(user => {
        const userId = user.id || user.uid;
        const initials = getInitials(user.fullName);

        if (isStudent) {
            const program = user.program
                ? `<span class="program-tag">${safe(user.program)}</span>`
                : "";

            const major = user.major
                ? `<span class="major-tag">${safe(user.major)}</span>`
                : "";

            const programMajor = (program || major)
                ? `<div>${program}${major}</div>`
                : `<span class="date-text">—</span>`;

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
                        <span class="role-badge role-student">
                            Student
                        </span>
                    </td>

                    <td>${programMajor}</td>

                    <td class="date-text">
                        ${safe(formatDate(getDate(user)))}
                    </td>

                    <td>
                        <button
                            class="delete-btn"
                            data-user-id="${safe(userId)}"
                            data-user-name="${safe(user.fullName || "Unknown")}"
                        >
                            Delete
                        </button>
                    </td>
                </tr>
            `;
        } else {
            // Faculty row
            const handledList = facultyAssignmentsMap.get(userId) || [];
            const count = handledList.length;
            const countText = count > 0
                ? `${count} subject${count === 1 ? "" : "s"} assigned`
                : "No subjects assigned";

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
                        <span class="role-badge role-faculty">
                            Faculty
                        </span>
                    </td>

                    <td class="date-text">
                        ${safe(formatDate(getDate(user)))}
                    </td>

                    <td>
                        <div class="assigned-subjects-cell">
                            <button
                                class="manage-subjects-btn"
                                data-user-id="${safe(userId)}"
                                data-user-name="${safe(user.fullName || "Unknown")}"
                                data-user-email="${safe(user.email || "")}"
                            >
                                Manage Subjects
                            </button>
                            <span class="assigned-count-text ${count > 0 ? "has-subjects" : ""}">
                                ${safe(countText)}
                            </span>
                        </div>
                    </td>

                    <td>
                        <button
                            class="delete-btn"
                            data-user-id="${safe(userId)}"
                            data-user-name="${safe(user.fullName || "Unknown")}"
                        >
                            Delete
                        </button>
                    </td>
                </tr>
            `;
        }
    }).join("");

    /* =========================
       BUTTON EVENT LISTENERS
    ========================= */

    body.querySelectorAll(".delete-btn").forEach(button => {
        button.addEventListener("click", () => {
            const userId = button.dataset.userId;
            const userName = button.dataset.userName;
            handleDeleteUser(userId, userName);
        });
    });

    body.querySelectorAll(".manage-subjects-btn").forEach(button => {
        button.addEventListener("click", () => {
            const userId = button.dataset.userId;
            const userName = button.dataset.userName;
            const userEmail = button.dataset.userEmail;
            openAssignSubjectsModal(userId, userName, userEmail);
        });
    });
}

/* =========================
   DELETE USER (WITH SUBJECT ASSIGNMENT CLEANUP)
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
            throw new Error("You are not authenticated.");
        }

        let deletedViaApi = false;

        try {
            // Get Firebase ID token
            const token = await user.getIdToken();

            console.log(`Deleting user through Render API: ${userId}`);

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

        // Clean up facultySubjectAssignments document to avoid orphaned subject records
        try {
            await deleteDoc(doc(db, "facultySubjectAssignments", userId));
            facultyAssignmentsMap.delete(userId);
            console.log(`Faculty subject assignment cleaned up for ${userId}`);
        } catch (cleanupError) {
            console.warn("Could not clean up facultySubjectAssignments:", cleanupError);
        }

        alert(`${userName} has been deleted successfully.`);

        // Remove immediately from local array
        allUsers = allUsers.filter(
            u => (u.id !== userId && u.uid !== userId)
        );

        updateCounts();
        renderUsers();

    } catch (error) {
        console.error("Could not delete user:", error);
        alert(`Failed to delete ${userName}.\n\n${error.message}`);
    }
}

/* =========================
   MANAGE SUBJECTS MODAL
========================= */

async function openAssignSubjectsModal(userId, userName, userEmail) {
    activeFacultyUser = {
        id: userId,
        uid: userId,
        fullName: userName,
        email: userEmail
    };

    // Load existing assigned subjects (stored as composite keys)
    const existing = facultyAssignmentsMap.get(userId) || [];
    selectedSubjectKeys = new Set(existing);

    // Reset filters
    modalSearchTerm = "";
    modalProgramFilter = "";
    modalMajorFilter = "";
    modalYearFilter = "";
    modalSemesterFilter = "";

    document.getElementById("subjectSearchInput").value = "";
    document.getElementById("subjectProgramFilter").value = "";
    document.getElementById("subjectYearFilter").value = "";
    document.getElementById("subjectSemesterFilter").value = "";

    updateModalMajorFilterDropdown();

    // Populate faculty header banner
    document.getElementById("modalFacultyName").textContent = userName || "Faculty Member";
    document.getElementById("modalFacultyEmail").textContent = userEmail || "—";
    updateModalHeaderBadge();

    // Ensure prospectus subjects are loaded
    if (!prospectusSubjects.length) {
        await loadProspectusSubjects();
    }

    renderModalSubjectList();

    // Display modal
    const modalOverlay = document.getElementById("assignSubjectsModal");
    if (modalOverlay) {
        modalOverlay.style.display = "flex";
    }
}

function closeAssignSubjectsModal() {
    const modalOverlay = document.getElementById("assignSubjectsModal");
    if (modalOverlay) {
        modalOverlay.style.display = "none";
    }
    activeFacultyUser = null;
    selectedSubjectKeys.clear();
}

function updateModalHeaderBadge() {
    const count = selectedSubjectKeys.size;
    const badge = document.getElementById("modalAssignedBadge");
    if (badge) {
        badge.textContent = count > 0
            ? `${count} subject${count === 1 ? "" : "s"} assigned`
            : "No subjects assigned";
    }
}

function updateModalMajorFilterDropdown() {
    const majorSelect = document.getElementById("subjectMajorFilter");
    if (!majorSelect) return;

    modalMajorFilter = "";
    majorSelect.innerHTML = `<option value="">All Majors</option>`;

    if (modalProgramFilter === "BIT" || modalProgramFilter === "BINDTECH") {
        majorSelect.innerHTML += `<option value="CPT">CPT</option>`;
    } else if (modalProgramFilter === "BTVTED") {
        majorSelect.innerHTML += `
            <option value="AT">AT</option>
            <option value="MT">MT</option>
            <option value="CP">CP</option>
            <option value="FSM">FSM</option>
            <option value="CT">CT</option>
            <option value="ELT">ELT</option>
            <option value="ELX">ELX</option>
        `;
    } else {
        // All Programs or empty: collect unique majors from prospectus
        const majors = [...new Set(prospectusSubjects.map(s => s.majorCode).filter(Boolean))].sort();
        majors.forEach(m => {
            majorSelect.innerHTML += `<option value="${safe(m)}">${safe(m)}</option>`;
        });
    }
}

function getFilteredProspectusSubjects() {
    return prospectusSubjects.filter(item => {
        if (modalSearchTerm) {
            const term = modalSearchTerm.toLowerCase();
            const code = item.subjectCode.toLowerCase();
            const name = item.subjectName.toLowerCase();
            if (!code.includes(term) && !name.includes(term)) {
                return false;
            }
        }

        if (modalProgramFilter) {
            if (item.programCode.toUpperCase() !== modalProgramFilter.toUpperCase()) {
                return false;
            }
        }

        if (modalMajorFilter) {
            if (item.majorCode.toUpperCase() !== modalMajorFilter.toUpperCase()) {
                return false;
            }
        }

        if (modalYearFilter) {
            if (String(item.yearLevel) !== String(modalYearFilter)) {
                return false;
            }
        }

        if (modalSemesterFilter) {
            if (String(item.semester) !== String(modalSemesterFilter)) {
                return false;
            }
        }

        return true;
    }).sort((a, b) => a.subjectCode.localeCompare(b.subjectCode));
}

function renderModalSubjectList() {
    const container = document.getElementById("subjectListContainer");
    const countStatus = document.getElementById("subjectCountStatus");
    const selectedCountStatus = document.getElementById("selectedTotalCountStatus");

    if (!container) return;

    const filtered = getFilteredProspectusSubjects();

    if (countStatus) {
        countStatus.textContent = `Showing ${filtered.length} of ${prospectusSubjects.length} subjects`;
    }

    if (selectedCountStatus) {
        const selCount = selectedSubjectKeys.size;
        selectedCountStatus.textContent = `${selCount} subject${selCount === 1 ? "" : "s"} selected`;
    }

    if (!filtered.length) {
        container.innerHTML = `
            <div style="text-align:center; padding:30px 15px; color:#777; font-size:14px;">
                No subjects found matching the active search or filters.
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(subject => {
        // Use composite key so subjects with the same subjectCode but different
        // program/major/year/semester are treated as completely independent records.
        const subjectKey = getSubjectKey(subject);
        const isChecked = selectedSubjectKeys.has(subjectKey);

        return `
            <label class="subject-item-label ${isChecked ? "checked" : ""}">
                <input
                    type="checkbox"
                    class="subject-checkbox"
                    data-subject-key="${safe(subjectKey)}"
                    ${isChecked ? "checked" : ""}
                >
                <div class="subject-item-details">
                    <span class="subject-code-badge">${safe(subject.subjectCode)}</span>
                    <span class="subject-name-text">${safe(subject.subjectName)}</span>
                    <div class="subject-meta-tags">
                        ${subject.units ? `<span class="meta-tag units">${safe(subject.units)} Units</span>` : ""}
                        ${subject.programCode ? `<span class="meta-tag curriculum">${safe(subject.programCode)}${subject.majorCode ? ` - ${safe(subject.majorCode)}` : ""}</span>` : ""}
                        ${subject.yearLevel ? `<span class="meta-tag">Yr ${safe(subject.yearLevel)}</span>` : ""}
                        ${subject.semester ? `<span class="meta-tag">Sem ${safe(subject.semester)}</span>` : ""}
                    </div>
                </div>
            </label>
        `;
    }).join("");

    // Checkbox click handlers — each row operates on its own unique composite key.
    // No cross-row syncing by subject code to preserve independence of same-code subjects.
    container.querySelectorAll(".subject-checkbox").forEach(cb => {
        cb.addEventListener("change", event => {
            const subjectKey = event.target.dataset.subjectKey;
            const label = event.target.closest(".subject-item-label");

            if (event.target.checked) {
                selectedSubjectKeys.add(subjectKey);
                label?.classList.add("checked");
            } else {
                selectedSubjectKeys.delete(subjectKey);
                label?.classList.remove("checked");
            }

            updateModalHeaderBadge();
            if (selectedCountStatus) {
                const selCount = selectedSubjectKeys.size;
                selectedCountStatus.textContent = `${selCount} subject${selCount === 1 ? "" : "s"} selected`;
            }
        });
    });
}

/* =========================
   MODAL ACTIONS & EVENT LISTENERS
========================= */

// Select All visible
document.getElementById("selectAllVisibleBtn")?.addEventListener("click", () => {
    const visible = getFilteredProspectusSubjects();
    visible.forEach(s => selectedSubjectKeys.add(getSubjectKey(s)));
    updateModalHeaderBadge();
    renderModalSubjectList();
});

// Deselect All visible
document.getElementById("deselectAllVisibleBtn")?.addEventListener("click", () => {
    const visible = getFilteredProspectusSubjects();
    visible.forEach(s => selectedSubjectKeys.delete(getSubjectKey(s)));
    updateModalHeaderBadge();
    renderModalSubjectList();
});

// Search input in modal
document.getElementById("subjectSearchInput")?.addEventListener("input", event => {
    modalSearchTerm = event.target.value.trim();
    renderModalSubjectList();
});

// Program filter in modal
document.getElementById("subjectProgramFilter")?.addEventListener("change", event => {
    modalProgramFilter = event.target.value;
    updateModalMajorFilterDropdown();
    renderModalSubjectList();
});

// Major filter in modal
document.getElementById("subjectMajorFilter")?.addEventListener("change", event => {
    modalMajorFilter = event.target.value;
    renderModalSubjectList();
});

// Year filter in modal
document.getElementById("subjectYearFilter")?.addEventListener("change", event => {
    modalYearFilter = event.target.value;
    renderModalSubjectList();
});

// Semester filter in modal
document.getElementById("subjectSemesterFilter")?.addEventListener("change", event => {
    modalSemesterFilter = event.target.value;
    renderModalSubjectList();
});

// Save subjects button
document.getElementById("saveAssignBtn")?.addEventListener("click", async () => {
    if (!activeFacultyUser || !activeFacultyUser.id) {
        console.error("No active faculty user selected for assignment.");
        return;
    }

    const saveBtn = document.getElementById("saveAssignBtn");
    const originalText = saveBtn.textContent;

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";

        // Build the array of composite keys to store.
        // Each key uniquely identifies a subject record: programCode_majorCode_yearLevel_semester_subjectCode
        const handledArray = Array.from(selectedSubjectKeys).filter(Boolean);
        const facultyUserId = activeFacultyUser.id;

        console.log(`Saving assigned subjects for faculty ${facultyUserId}:`, handledArray);

        // Save to Firestore facultySubjectAssignments collection
        await setDoc(doc(db, "facultySubjectAssignments", facultyUserId), {
            facultyId: facultyUserId,
            handledSubjects: handledArray,
            updatedAt: serverTimestamp()
        }, { merge: true });

        // Update local state map
        facultyAssignmentsMap.set(facultyUserId, handledArray);

        alert(`Assigned subjects updated successfully for ${activeFacultyUser.fullName} (${handledArray.length} subject${handledArray.length === 1 ? "" : "s"}).`);

        closeAssignSubjectsModal();
        renderUsers();

    } catch (error) {
        console.error("Error saving faculty subject assignments:", error);
        alert(`Failed to save assigned subjects: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
});

// Cancel and Close buttons
document.getElementById("closeAssignModalBtn")?.addEventListener("click", () => {
    closeAssignSubjectsModal();
});

document.getElementById("cancelAssignBtn")?.addEventListener("click", () => {
    closeAssignSubjectsModal();
});

// Close modal on outside overlay click
document.getElementById("assignSubjectsModal")?.addEventListener("click", event => {
    if (event.target === document.getElementById("assignSubjectsModal")) {
        closeAssignSubjectsModal();
    }
});

/* =========================
   INITIALS & DATE UTILS
========================= */

function getInitials(name) {
    if (!name) return "?";

    return name
        .split(" ")
        .filter(part => part.length > 0)
        .slice(0, 2)
        .map(part => part[0].toUpperCase())
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

    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
}

/* =========================
   TAB SWITCHING
========================= */

document.getElementById("tabStudents").addEventListener("click", () => {
    currentTab = "Student";

    document.getElementById("tabStudents").classList.add("active");
    document.getElementById("tabFaculty").classList.remove("active");

    document.getElementById("programFilter").style.display = "";
    document.getElementById("majorFilter").style.display = "";

    renderUsers();
});

document.getElementById("tabFaculty").addEventListener("click", () => {
    currentTab = "Faculty";

    document.getElementById("tabFaculty").classList.add("active");
    document.getElementById("tabStudents").classList.remove("active");

    document.getElementById("programFilter").style.display = "none";
    document.getElementById("majorFilter").style.display = "none";

    renderUsers();
});

/* =========================
   SEARCH (MAIN PAGE)
========================= */

document.getElementById("searchInput").addEventListener("input", event => {
    searchTerm = event.target.value.trim();
    renderUsers();
});

/* =========================
   PROGRAM & MAJOR FILTERS (MAIN PAGE)
========================= */

const programFilterEl = document.getElementById("programFilter");
const majorFilterEl = document.getElementById("majorFilter");

programFilterEl.addEventListener("change", () => {
    programFilter = programFilterEl.value;
    majorFilter = "";

    majorFilterEl.innerHTML = `<option value="">All Majors</option>`;

    if (programFilter === "BIT" || programFilter === "BINDTECH") {
        majorFilterEl.innerHTML += `<option value="CPT">CPT</option>`;
    }

    if (programFilter === "BTVTED") {
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
});

majorFilterEl.addEventListener("change", () => {
    majorFilter = majorFilterEl.value;
    renderUsers();
});

/* =========================
   LOGOUT
========================= */

document.getElementById("logoutLink")?.addEventListener("click", async event => {
    event.preventDefault();
    try {
        await signOut(auth);
    } catch (e) {
        console.error("Logout failed:", e);
    }
    sessionStorage.clear();
    localStorage.clear();
    window.location.replace("login.html");
});
