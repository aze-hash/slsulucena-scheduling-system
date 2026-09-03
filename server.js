import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

import { db, auth } from "./firebase-admin.js";
import {
  sendClassScheduleNotification,
  sendExamScheduleNotification,
  normalizeExamType,
  verifySmtpConnection,
  sendTestEmail
} from "./emailService.js";

const app = express();

// ======================================
// MIDDLEWARE & CORS
// ======================================
const allowedOrigins = [
  "https://slsulucena-scheduling-system.web.app",
  "https://slsulucena-scheduling-system.firebaseapp.com",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5500",
  "http://localhost:8080"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
      origin.endsWith(".web.app") ||
      origin.endsWith(".firebaseapp.com")
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// ======================================
// FIRESTORE COLLECTIONS
// ======================================
const prospectusRef = db.collection("prospectus");
const usersRef = db.collection("users");
const classSchedulesRef = db.collection("classSchedules");
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
//
// Example:
// /prospectus/filter?programCode=BIT-CPT&yearLevel=1&semester=1
// ======================================
app.get("/prospectus/filter", async (req, res) => {
  try {
    const { programCode, yearLevel, semester } = req.query;

    let queryRef = prospectusRef;

    if (programCode) {
      queryRef = queryRef.where(
        "programCode",
        "==",
        programCode
      );
    }

    if (yearLevel) {
      queryRef = queryRef.where(
        "yearLevel",
        "==",
        Number(yearLevel)
      );
    }

    if (semester) {
      queryRef = queryRef.where(
        "semester",
        "==",
        Number(semester)
      );
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
//
// Deletes from:
// 1. Firebase Authentication
// 2. Firestore users collection
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

    // ----------------------------------
    // 1. Delete from Firebase Auth
    // ----------------------------------
    try {
      await auth.deleteUser(uid);
      console.log(`Firebase Authentication user deleted: ${uid}`);
    } catch (authError) {
      console.log(`Auth delete note for ${uid}: ${authError.message}. Proceeding to delete Firestore document...`);
    }

    // ----------------------------------
    // 2. Delete Firestore user document
    // ----------------------------------
    const userDoc = await usersRef.doc(uid).get();

    if (userDoc.exists) {
      await usersRef.doc(uid).delete();

      console.log(
        `Firestore user document deleted: ${uid}`
      );
    } else {
      console.log(
        `Firestore user document not found: ${uid}`
      );
    }

    // ----------------------------------
    // 3. Delete faculty subject assignments if present
    // ----------------------------------
    try {
      const assignmentDoc = await db.collection("facultySubjectAssignments").doc(uid).get();
      if (assignmentDoc.exists) {
        await db.collection("facultySubjectAssignments").doc(uid).delete();
        console.log(`Firestore facultySubjectAssignments document deleted: ${uid}`);
      }
    } catch (assignError) {
      console.warn(`Note on deleting facultySubjectAssignments for ${uid}:`, assignError.message);
    }

    // ----------------------------------
    // SUCCESS
    // ----------------------------------
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
// 🧪 TEST EMAIL ENDPOINT
// GET /api/test-email
// ======================================
app.get("/api/test-email", async (req, res) => {
  try {
    const targetEmail = process.env.EMAIL_USER;
    if (!targetEmail) {
      return res.status(500).json({
        success: false,
        message: "EMAIL_USER is not configured in server environment variables."
      });
    }

    const result = await sendTestEmail(targetEmail);
    if (result.success) {
      return res.status(200).json({
        success: true,
        message: `Test email sent successfully to ${targetEmail}`,
        messageId: result.messageId
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Failed to send test email.",
        error: result.error
      });
    }
  } catch (err) {
    console.error("Error in /api/test-email:", err);
    return res.status(500).json({
      success: false,
      message: "Error executing test email dispatch.",
      error: err.message
    });
  }
});

// ======================================
// 📢 INTERNAL PUBLISH: EXAM SCHEDULE
// ======================================
async function publishExamScheduleInternal({ scheduleId, scheduleData, examType, publishedBy }) {
  const docId = scheduleId || scheduleData?.id;
  if (!docId) {
    return { status: 400, body: { success: false, message: "Exam schedule ID is required." } };
  }

  let schedule = scheduleData;
  const docSnap = await examSchedulesRef.doc(docId).get();
  if (docSnap.exists) {
    schedule = { id: docSnap.id, ...docSnap.data(), ...(scheduleData || {}) };
  }

  if (!schedule) {
    return { status: 404, body: { success: false, message: "Exam schedule not found." } };
  }

  const formattedExamType = normalizeExamType(examType || schedule.examType || "Preliminary");
  const releaseId = schedule.releaseId || `${docId}_${Date.now()}`;
  const publishedAt = schedule.publishedAt ? new Date(schedule.publishedAt) : new Date();

  // Ensure schedule is marked as published in Firestore without altering schema
  await examSchedulesRef.doc(docId).set({
    ...schedule,
    id: docId,
    examType: formattedExamType,
    status: "published",
    publishedAt,
    publishedBy: publishedBy || schedule.publishedBy || null,
    releaseId,
    updatedAt: new Date()
  }, { merge: true });

  // Query users to identify affected recipients
  const usersSnap = await usersRef.get();
  const allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const norm = (val) => String(val || "").trim().toLowerCase();

  const targetProgram = norm(schedule.program);
  const targetMajor = norm(schedule.major);
  const targetSection = norm(schedule.section);
  const targetYearLevel = schedule.yearLevel ? String(schedule.yearLevel).trim() : "";

  // 1. Target Students belonging to the exam schedule section
  const targetStudents = allUsers.filter(u => {
    const isStudent = norm(u.role) === "student";
    if (!isStudent) return false;
    if (!u.email || !u.email.includes("@")) return false;

    const uSection = norm(u.section);
    const uProg = norm(u.program);
    const uMaj = norm(u.major);
    const uYear = u.yearLevel ? String(u.yearLevel).trim() : "";

    // A. If student has an explicit section
    if (uSection) {
      if (targetSection && uSection === targetSection) return true;
      if (targetSection && (targetSection.includes(uSection) || uSection.includes(targetSection))) return true;
      return false;
    }

    // B. Match by program, major, yearLevel
    let progMatch = !uProg || !targetProgram || targetProgram === uProg || targetSection.startsWith(uProg) || targetSection.includes(uProg);
    let majMatch = !uMaj || !targetMajor || targetMajor === uMaj || targetSection.includes(uMaj);
    let yearMatch = !uYear || !targetYearLevel || uYear === targetYearLevel || targetSection.includes(uYear);

    return progMatch && majMatch && yearMatch;
  });

  // 2. Target Faculty Proctors assigned to this exam schedule
  // Faculty users are used for EXAMINATION PROCTORING ONLY. Unrelated faculty and teaching assignments are NEVER used.
  const proctorUids = new Set();
  const proctorNames = new Set();

  const addProctorUid = (uid) => {
    if (!uid) return;
    String(uid).split(",").forEach(item => {
      const trimmed = item.trim();
      if (trimmed) proctorUids.add(trimmed);
    });
  };

  const addProctorName = (name) => {
    if (!name) return;
    const trimmed = norm(name);
    if (trimmed && trimmed !== "tba") proctorNames.add(trimmed);
  };

  addProctorUid(schedule.proctorUid);
  addProctorUid(schedule.facultyUid);
  addProctorUid(schedule.assignedFacultyUid);
  addProctorName(schedule.proctor);

  if (Array.isArray(schedule.exams)) {
    schedule.exams.forEach(e => {
      addProctorUid(e.proctorUid);
      addProctorUid(e.facultyUid);
      addProctorName(e.proctor);
    });
  }

  const targetFaculty = allUsers.filter(u => {
    const isFaculty = norm(u.role) === "faculty";
    if (!isFaculty) return false;
    if (!u.email || !u.email.includes("@")) return false;

    // Check UID match
    const uDocId = u.id || "";
    const uUid = u.uid || "";
    if ((uDocId && proctorUids.has(uDocId)) || (uUid && proctorUids.has(uUid))) {
      return true;
    }

    // Check Name match
    const facultyFullName = norm(u.fullName || u.name || u.facultyName || [u.firstName, u.lastName].filter(Boolean).join(" "));
    if (facultyFullName && proctorNames.size > 0) {
      if (proctorNames.has(facultyFullName)) return true;
      for (const pName of proctorNames) {
        if (pName.includes(facultyFullName) || facultyFullName.includes(pName)) return true;
        const tokens = facultyFullName.split(/\s+/).filter(t => t.length > 2);
        if (tokens.length >= 2 && tokens.every(tok => pName.includes(tok))) return true;
      }
    }

    return false;
  });

  // 3. Deduplicate recipients by lowercase email
  const uniqueRecipientsMap = new Map();

  targetStudents.forEach(s => {
    const emailKey = norm(s.email);
    if (!uniqueRecipientsMap.has(emailKey)) {
      uniqueRecipientsMap.set(emailKey, {
        userId: s.id || s.uid,
        email: s.email,
        name: s.fullName || "Student",
        recipientType: "student"
      });
    }
  });

  targetFaculty.forEach(f => {
    const emailKey = norm(f.email);
    if (!uniqueRecipientsMap.has(emailKey)) {
      uniqueRecipientsMap.set(emailKey, {
        userId: f.id || f.uid,
        email: f.email,
        name: f.fullName || f.name || "Faculty Proctor",
        recipientType: "faculty"
      });
    }
  });

  const recipients = Array.from(uniqueRecipientsMap.values());

  // 4. Dispatch email notifications using Promise.allSettled()
  let sentCount = 0;
  let failedCount = 0;
  const dispatchPromises = recipients.map(async (recip) => {
    const notifDocId = `exam_${docId}_${formattedExamType}_${recip.userId}`;
    try {
      const emailResult = await sendExamScheduleNotification({
        recipientEmail: recip.email,
        recipientName: recip.name,
        scheduleInfo: schedule,
        examType: formattedExamType
      });

      const notifRecord = {
        recipientUserId: recip.userId,
        recipientEmail: recip.email,
        recipientName: recip.name,
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
      return { ...recip, ...emailResult };
    } catch (err) {
      await emailNotificationsRef.doc(notifDocId).set({
        recipientUserId: recip.userId,
        recipientEmail: recip.email,
        recipientName: recip.name,
        notificationType: "exam",
        scheduleType: "exam",
        scheduleId: docId,
        examType: formattedExamType,
        releaseId,
        status: "failed",
        sentAt: new Date(),
        error: err.message
      }, { merge: true });
      return { ...recip, success: false, error: err.message };
    }
  });

  const settledResults = await Promise.allSettled(dispatchPromises);

  settledResults.forEach(item => {
    if (item.status === "fulfilled" && item.value.success) {
      sentCount++;
    } else {
      failedCount++;
      const errDetail = item.status === "fulfilled" ? item.value.error : (item.reason?.message || item.reason);
      const recipientEmail = item.status === "fulfilled" ? item.value.email : "Unknown";
      console.error(`[Email Failure] Recipient: ${recipientEmail} | Error: ${errDetail}`);
    }
  });

  // 5. Server Console Output (Formatted as required)
  console.log("========================================");
  console.log(`Schedule published: ${schedule.title || schedule.section || docId}`);
  console.log("Schedule Type: exam");
  console.log(`Recipients found: ${recipients.length} (Students: ${targetStudents.length}, Faculty Proctors: ${targetFaculty.length})`);
  console.log(`Emails sent: ${sentCount}`);
  console.log(`Emails failed: ${failedCount}`);
  console.log("========================================");

  return {
    status: 200,
    body: {
      success: failedCount === 0 || sentCount > 0,
      published: true,
      scheduleId: docId,
      scheduleType: "exam",
      examType: formattedExamType,
      recipientsCount: recipients.length,
      sentCount,
      failedCount,
      message: `${formattedExamType} Examination Schedule published. ${sentCount} email notifications sent, ${failedCount} failed.`
    }
  };
}

// ======================================
// 📢 INTERNAL PUBLISH: CLASS SCHEDULE
// ======================================
async function publishClassScheduleInternal({ scheduleId, scheduleData, publishedBy }) {
  const docId = scheduleId || scheduleData?.id;
  if (!docId) {
    return { status: 400, body: { success: false, message: "Class schedule ID is required." } };
  }

  let schedule = scheduleData;
  const docSnap = await classSchedulesRef.doc(docId).get();
  if (docSnap.exists) {
    schedule = { id: docSnap.id, ...docSnap.data(), ...(scheduleData || {}) };
  }

  if (!schedule) {
    return { status: 404, body: { success: false, message: "Class schedule not found." } };
  }

  const releaseId = schedule.releaseId || `${docId}_${Date.now()}`;
  const publishedAt = schedule.publishedAt ? new Date(schedule.publishedAt) : new Date();

  // Ensure schedule is marked as published in Firestore without altering schema
  await classSchedulesRef.doc(docId).set({
    ...schedule,
    id: docId,
    status: "published",
    publishedAt,
    publishedBy: publishedBy || schedule.publishedBy || null,
    releaseId,
    updatedAt: new Date()
  }, { merge: true });

  // Query users to identify affected recipients
  const usersSnap = await usersRef.get();
  const allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const norm = (val) => String(val || "").trim().toLowerCase();

  const targetProgram = norm(schedule.program);
  const targetMajor = norm(schedule.major);
  const targetSection = norm(schedule.section || schedule.name);
  const targetYearLevel = schedule.yearLevel ? String(schedule.yearLevel).trim() : "";

  // SYSTEM RULE: Faculty are for examination proctoring only. Class schedules are sent to STUDENTS ONLY.
  const targetStudents = allUsers.filter(u => {
    const isStudent = norm(u.role) === "student";
    if (!isStudent) return false;
    if (!u.email || !u.email.includes("@")) return false;

    const uSection = norm(u.section);
    const uProg = norm(u.program);
    const uMaj = norm(u.major);
    const uYear = u.yearLevel ? String(u.yearLevel).trim() : "";

    if (uSection) {
      if (targetSection && uSection === targetSection) return true;
      if (targetSection && (targetSection.includes(uSection) || uSection.includes(targetSection))) return true;
      return false;
    }

    let progMatch = !uProg || !targetProgram || targetProgram === uProg || targetSection.startsWith(uProg) || targetSection.includes(uProg);
    let majMatch = !uMaj || !targetMajor || targetMajor === uMaj || targetSection.includes(uMaj);
    let yearMatch = !uYear || !targetYearLevel || uYear === targetYearLevel || targetSection.includes(uYear);

    return progMatch && majMatch && yearMatch;
  });

  // Deduplicate by lowercase email
  const uniqueRecipientsMap = new Map();
  targetStudents.forEach(s => {
    const emailKey = norm(s.email);
    if (!uniqueRecipientsMap.has(emailKey)) {
      uniqueRecipientsMap.set(emailKey, {
        userId: s.id || s.uid,
        email: s.email,
        name: s.fullName || "Student",
        recipientType: "student"
      });
    }
  });

  const recipients = Array.from(uniqueRecipientsMap.values());

  let sentCount = 0;
  let failedCount = 0;
  const dispatchPromises = recipients.map(async (recip) => {
    const notifDocId = `class_${docId}_${recip.userId}`;
    try {
      const emailResult = await sendClassScheduleNotification({
        recipientEmail: recip.email,
        recipientName: recip.name,
        scheduleInfo: schedule
      });

      const notifRecord = {
        recipientUserId: recip.userId,
        recipientEmail: recip.email,
        recipientName: recip.name,
        notificationType: "class",
        scheduleType: "class",
        scheduleId: docId,
        releaseId,
        status: emailResult.success ? "sent" : "failed",
        sentAt: new Date(),
        error: emailResult.error || null
      };

      await emailNotificationsRef.doc(notifDocId).set(notifRecord, { merge: true });
      return { ...recip, ...emailResult };
    } catch (err) {
      await emailNotificationsRef.doc(notifDocId).set({
        recipientUserId: recip.userId,
        recipientEmail: recip.email,
        recipientName: recip.name,
        notificationType: "class",
        scheduleType: "class",
        scheduleId: docId,
        releaseId,
        status: "failed",
        sentAt: new Date(),
        error: err.message
      }, { merge: true });
      return { ...recip, success: false, error: err.message };
    }
  });

  const settledResults = await Promise.allSettled(dispatchPromises);

  settledResults.forEach(item => {
    if (item.status === "fulfilled" && item.value.success) {
      sentCount++;
    } else {
      failedCount++;
      const errDetail = item.status === "fulfilled" ? item.value.error : (item.reason?.message || item.reason);
      const recipientEmail = item.status === "fulfilled" ? item.value.email : "Unknown";
      console.error(`[Email Failure] Recipient: ${recipientEmail} | Error: ${errDetail}`);
    }
  });

  // Server Console Output
  console.log("========================================");
  console.log(`Schedule published: ${schedule.section || schedule.name || docId}`);
  console.log("Schedule Type: class");
  console.log(`Recipients found: ${recipients.length} (Students only - Faculty excluded per system rule)`);
  console.log(`Emails sent: ${sentCount}`);
  console.log(`Emails failed: ${failedCount}`);
  console.log("========================================");

  return {
    status: 200,
    body: {
      success: failedCount === 0 || sentCount > 0,
      published: true,
      scheduleId: docId,
      scheduleType: "class",
      recipientsCount: recipients.length,
      sentCount,
      failedCount,
      message: `Class schedule published. ${sentCount} email notifications sent, ${failedCount} failed.`
    }
  };
}

// ======================================
// 📢 UNIFIED PUBLISH SCHEDULE API
// POST /api/publish-schedule
// ======================================
app.post("/api/publish-schedule", async (req, res) => {
  try {
    const { scheduleId, scheduleType, scheduleData, publishedBy, examType } = req.body;

    if (!scheduleId && (!scheduleData || !scheduleData.id)) {
      return res.status(400).json({
        success: false,
        message: "scheduleId is required."
      });
    }

    const type = String(scheduleType || (scheduleData?.exams ? "exam" : "class")).trim().toLowerCase();

    if (type === "exam") {
      const result = await publishExamScheduleInternal({
        scheduleId,
        scheduleData,
        examType,
        publishedBy
      });
      return res.status(result.status || 200).json(result.body);
    } else if (type === "class") {
      const result = await publishClassScheduleInternal({
        scheduleId,
        scheduleData,
        publishedBy
      });
      return res.status(result.status || 200).json(result.body);
    } else {
      return res.status(400).json({
        success: false,
        message: `Invalid scheduleType "${scheduleType}". Must be "exam" or "class".`
      });
    }
  } catch (error) {
    console.error("Error in /api/publish-schedule:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to publish schedule.",
      error: error.message
    });
  }
});

// ======================================
// 📢 LEGACY ALIAS: POST /api/publish/class-schedule
// ======================================
app.post("/api/publish/class-schedule", async (req, res) => {
  try {
    const result = await publishClassScheduleInternal(req.body);
    return res.status(result.status || 200).json(result.body);
  } catch (error) {
    console.error("Error publishing class schedule:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to publish class schedule.",
      error: error.message
    });
  }
});

// ======================================
// 📢 LEGACY ALIAS: POST /api/publish/exam-schedule
// ======================================
app.post("/api/publish/exam-schedule", async (req, res) => {
  try {
    const result = await publishExamScheduleInternal(req.body);
    return res.status(result.status || 200).json(result.body);
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
// 🏠 ROOT API TEST
// GET /
// ======================================
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Scheduling System API is running.",
  });
});


app.get("/api/test-publish-route", (req, res) => {
    res.json({
        success: true,
        message: "Publish schedule route is deployed."
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
// 🚀 START SERVER & VERIFY SMTP
// ======================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Scheduling System API running on port ${PORT}`);
  await verifySmtpConnection();
});