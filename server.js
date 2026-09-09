import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

import { db, auth } from "./firebase-admin.js";
import {
  sendExamScheduleNotification,
  normalizeExamType
} from "./emailService.js";

const app = express();

// ======================================
// MIDDLEWARE
// ======================================
app.use(cors());
app.use(express.json());

// ======================================
// FIRESTORE COLLECTIONS
// ======================================
const prospectusRef = db.collection("prospectus");
const usersRef = db.collection("users");
const examSchedulesRef = db.collection("examSchedules");
const emailNotificationsRef = db.collection("emailNotifications");

// ======================================
// 📚 GET ALL PROSPECTUS SUBJECTS
// GET /prospectus
// ======================================
app.get("/prospectus", async (req, res) => {
  try {
    const snapshot = await prospectusRef.get();

    const data = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json(data);
  } catch (error) {
    console.error("Error loading prospectus:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 🎯 GET PROSPECTUS BY PROGRAM CODE
// GET /prospectus/program/:programCode
// ======================================
app.get("/prospectus/program/:programCode", async (req, res) => {
  try {
    const { programCode } = req.params;

    const snapshot = await prospectusRef
      .where("programCode", "==", programCode)
      .get();

    const data = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json(data);
  } catch (error) {
    console.error("Error loading program:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 🎓 FILTER PROSPECTUS
// GET /prospectus/filter
// ======================================
app.get("/prospectus/filter", async (req, res) => {
  try {
    const { programCode, yearLevel, semester } = req.query;

    let queryRef = prospectusRef;

    if (programCode) {
      queryRef = queryRef.where("programCode", "==", programCode);
    }

    if (yearLevel) {
      queryRef = queryRef.where("yearLevel", "==", Number(yearLevel));
    }

    if (semester) {
      queryRef = queryRef.where("semester", "==", Number(semester));
    }

    const snapshot = await queryRef.get();

    const data = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json(data);
  } catch (error) {
    console.error("Error filtering prospectus:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 🔍 GET SINGLE SUBJECT BY ID
// GET /prospectus/:id
// ======================================
app.get("/prospectus/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const snapshot = await prospectusRef.doc(id).get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Subject not found",
      });
    }

    return res.status(200).json({
      id: snapshot.id,
      ...snapshot.data(),
    });
  } catch (error) {
    console.error("Error loading subject:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 👥 GET ALL USERS
// GET /users
// ======================================
app.get("/users", async (req, res) => {
  try {
    const snapshot = await usersRef.get();

    const users = snapshot.docs.map((doc) => {
      const data = doc.data();
      let createdAt = data.createdAt;
      if (createdAt?.toDate) {
        createdAt = createdAt.toDate().toISOString();
      } else if (createdAt?._seconds) {
        createdAt = new Date(createdAt._seconds * 1000).toISOString();
      }
      return {
        ...data,
        createdAt,
        uid: doc.id,
        id: doc.id,
      };
    });

    return res.status(200).json(users);
  } catch (error) {
    console.error("Error loading users:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 👤 GET SINGLE USER
// GET /users/:uid
// ======================================
app.get("/users/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const snapshot = await usersRef.doc(uid).get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      ...snapshot.data(),
      uid: snapshot.id,
      id: snapshot.id,
    });
  } catch (error) {
    console.error("Error loading user:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ======================================
// 🗑️ DELETE USER
// DELETE /users/:uid
// ======================================
app.delete("/users/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: "User UID is required.",
      });
    }

    console.log(`Deleting user: ${uid}`);

    // 1. Delete from Firebase Auth
    try {
      await auth.deleteUser(uid);
      console.log(`Firebase Authentication user deleted: ${uid}`);
    } catch (authError) {
      console.log(`Auth delete note for ${uid}: ${authError.message}. Proceeding to delete Firestore document...`);
    }

    // 2. Delete Firestore user document
    const userDoc = await usersRef.doc(uid).get();

    if (userDoc.exists) {
      await usersRef.doc(uid).delete();
      console.log(`Firestore user document deleted: ${uid}`);
    } else {
      console.log(`Firestore user document not found: ${uid}`);
    }

    // 3. Delete faculty subject assignments if present
    try {
      const assignmentDoc = await db.collection("facultySubjectAssignments").doc(uid).get();
      if (assignmentDoc.exists) {
        await db.collection("facultySubjectAssignments").doc(uid).delete();
        console.log(`Firestore facultySubjectAssignments document deleted: ${uid}`);
      }
    } catch (assignError) {
      console.warn(`Note on deleting facultySubjectAssignments for ${uid}:`, assignError.message);
    }

    return res.status(200).json({
      success: true,
      message: "User deleted successfully.",
      uid,
    });

  } catch (error) {
    console.error("Error deleting user:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete user.",
      error: error.message,
    });
  }
});

// ======================================
// ✏️ UPDATE USER
// PUT /users/:uid
// ======================================
app.put("/users/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const updates = req.body;

        if (!uid) {
            return res.status(400).json({
                success: false,
                message: "User UID is required.",
            });
        }

        if (!updates || typeof updates !== "object") {
            return res.status(400).json({
                success: false,
                message: "Update data is required.",
            });
        }

        console.log(`Updating user ${uid}:`, JSON.stringify(updates));

        // Check if user document exists
        const userDoc = await usersRef.doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        // Add server timestamp
        const updateData = {
            ...updates,
            updatedAt: new Date(),
        };

        // Update the user document
        await usersRef.doc(uid).update(updateData);

        console.log(`User ${uid} updated successfully`);

        return res.status(200).json({
            success: true,
            message: "User updated successfully.",
            uid,
            updates: updateData,
        });

    } catch (error) {
        console.error("Error updating user:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update user.",
            error: error.message,
        });
    }
});

// ======================================
// 📢 PUBLISH EXAM SCHEDULE & SEND NOTIFICATIONS
// POST /api/publish/exam-schedule
// ======================================
app.post("/api/publish/exam-schedule", async (req, res) => {
  try {
    const { scheduleId, scheduleData, examType, publishedBy } = req.body;

    if (!scheduleId && (!scheduleData || !scheduleData.id)) {
      return res.status(400).json({
        success: false,
        message: "Exam schedule ID or data is required."
      });
    }

    const docId = scheduleId || scheduleData.id;
    let schedule = scheduleData;

    if (!schedule || !schedule.section) {
      const docSnap = await examSchedulesRef.doc(docId).get();
      if (docSnap.exists) {
        schedule = { id: docSnap.id, ...docSnap.data() };
      }
    }

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Exam schedule not found."
      });
    }

    const formattedExamType = normalizeExamType(examType || schedule.examType || "Preliminary");
    const releaseId = `${docId}_${Date.now()}`;
    const publishedAt = new Date();

    // 1. Mark exam schedule as published in Firestore
    await examSchedulesRef.doc(docId).set({
      ...schedule,
      id: docId,
      examType: formattedExamType,
      status: "published",
      publishedAt,
      publishedBy: publishedBy || null,
      releaseId,
      updatedAt: new Date()
    }, { merge: true });

    // 2. Query target recipients (Students and Faculty Proctors)
    const program = String(schedule.program || "").trim().toLowerCase();
    const major = String(schedule.major || "").trim().toLowerCase();

    const usersSnap = await usersRef.get();
    const allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // A. Target students
    const targetStudents = allUsers.filter(u => {
      const isStudent = String(u.role || "").trim().toLowerCase() === "student";
      if (!isStudent) return false;
      const uProg = String(u.program || "").trim().toLowerCase();
      const uMaj = String(u.major || "").trim().toLowerCase();
      if (program && uProg !== program) return false;
      if (major && uMaj && uMaj !== major) return false;
      return Boolean(u.email && u.email.includes("@"));
    });

    // B. Target faculty proctors
    const proctorNames = new Set();
    const proctorUids = new Set();

    if (schedule.proctor) proctorNames.add(String(schedule.proctor).trim().toLowerCase());
    if (schedule.proctorUid) proctorUids.add(String(schedule.proctorUid).trim());

    if (Array.isArray(schedule.exams)) {
      schedule.exams.forEach(e => {
        if (e.proctor) proctorNames.add(String(e.proctor).trim().toLowerCase());
        if (e.proctorUid) proctorUids.add(String(e.proctorUid).trim());
      });
    }

    const targetFaculty = allUsers.filter(u => {
      const isFaculty = String(u.role || "").trim().toLowerCase() === "faculty";
      if (!isFaculty) return false;
      if (!u.email || !u.email.includes("@")) return false;

      const normName = String(u.fullName || "").trim().toLowerCase();
      const matchUid = proctorUids.has(u.id) || (u.uid && proctorUids.has(u.uid));
      const matchName = proctorNames.has(normName) || [...proctorNames].some(pn => pn && (pn.includes(normName) || normName.includes(pn)));

      return matchUid || matchName;
    });

    // Combine recipients
    const recipients = [
      ...targetStudents.map(s => ({ ...s, recipientType: "student" })),
      ...targetFaculty.map(f => ({ ...f, recipientType: "faculty" }))
    ];

    // Remove duplicates among recipients by email
    const uniqueRecipients = [];
    const seenEmails = new Set();
    for (const r of recipients) {
      const normEmail = String(r.email).toLowerCase();
      if (!seenEmails.has(normEmail)) {
        seenEmails.add(normEmail);
        uniqueRecipients.push(r);
      }
    }

    // 3. Dispatch emails with duplicate prevention
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const recipient of uniqueRecipients) {
      const notifDocId = `exam_${docId}_${formattedExamType}_${recipient.id}`;

      // Check duplicate
      const existingNotif = await emailNotificationsRef.doc(notifDocId).get();
      if (existingNotif.exists && existingNotif.data().status === "sent") {
        skippedCount++;
        continue;
      }

      const emailResult = await sendExamScheduleNotification({
        recipientEmail: recipient.email,
        recipientName: recipient.fullName || "Student / Faculty",
        scheduleInfo: schedule,
        examType: formattedExamType
      });

      const notifRecord = {
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        recipientName: recipient.fullName || "Student / Faculty",
        notificationType: "exam",
        scheduleType: "exam",
        scheduleId: docId,
        examType: formattedExamType,
        releaseId,
        status: emailResult.success ? "sent" : "failed",
        sentAt: new Date(),
        error: emailResult.error || null
      };

      await emailNotificationsRef.doc(notifDocId).set(notifRecord, { merge: true });

      if (emailResult.success) {
        sentCount++;
      } else {
        failedCount++;
      }
    }

    return res.status(200).json({
      success: true,
      published: true,
      scheduleId: docId,
      examType: formattedExamType,
      recipientsCount: uniqueRecipients.length,
      sentCount,
      failedCount,
      skippedCount,
      message: `${formattedExamType} Examination Schedule published successfully. ${sentCount} notifications processed.`
    });

  } catch (error) {
    console.error("Error publishing exam schedule:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to publish exam schedule.",
      error: error.message
    });
  }
});

// ======================================
// ✉️ UPDATE FIREBASE AUTH EMAIL IMMEDIATELY
// POST /api/auth/update-email
//
// Google's Identity Toolkit backend now rejects client-side updateEmail()
// with auth/operation-not-allowed ("Please verify the new email before
// changing email") and there is no project setting that disables this.
// The Admin SDK is the only way to change the email immediately:
// same UID, no verification email. The client has already reauthenticated
// with the current password before calling this endpoint; the idToken
// proves the caller is the signed-in user.
// ======================================
app.post("/api/auth/update-email", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    const { newEmail } = req.body || {};

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Missing authentication token.",
      });
    }

    if (!newEmail || typeof newEmail !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
      return res.status(400).json({
        success: false,
        error: "A valid new email address is required.",
      });
    }

    // Verify the caller's identity token (checkRevoked = true).
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken, true);
    } catch (tokenError) {
      return res.status(401).json({
        success: false,
        error: "Your session has expired. Please log in again.",
      });
    }

    const uid = decoded.uid;

    // Reject the change if the new email is already used by ANOTHER account.
    try {
      const existing = await auth.getUserByEmail(newEmail.trim().toLowerCase());
      if (existing && existing.uid !== uid) {
        return res.status(409).json({
          success: false,
          error: "This email is already associated with another account.",
        });
      }
      // existing.uid === uid means it is already this user's email; allow the
      // (no-op) update so Firestore and Auth stay consistent.
    } catch (lookupError) {
      // auth/user-not-found simply means the email is free - that is good.
      if (lookupError.code !== "auth/user-not-found") {
        throw lookupError;
      }
    }

    // IMMEDIATE email change: same UID, no verification email is sent.
    await auth.updateUser(uid, { email: newEmail.trim().toLowerCase() });

    return res.status(200).json({
      success: true,
      message: "Email updated.",
      uid: uid,
    });
  } catch (error) {
    console.error(
      "Error updating Firebase Auth email:",
      error.code || "",
      error.message
    );
    return res.status(500).json({
      success: false,
      error: "Unable to update your email address. Please try again.",
    });
  }
});

// ======================================
// 🏠 ROOT API TEST
// GET /
// ======================================
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Examination Scheduling System API is running.",
  });
});

// ======================================
// ❌ 404 HANDLER
// ======================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ======================================
// 🚀 START SERVER
// ======================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Examination Scheduling System API running on port ${PORT}`);
});
