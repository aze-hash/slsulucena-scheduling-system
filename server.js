import express from "express";
import cors from "cors";

import { db, auth } from "./firebase-admin.js";

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

    const users = snapshot.docs.map((doc) => ({
      uid: doc.id,
      ...doc.data(),
    }));

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
      uid: snapshot.id,
      ...snapshot.data(),
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

      console.log(
        `Firebase Authentication user deleted: ${uid}`
      );
    } catch (authError) {
      // If the Auth account does not exist,
      // continue deleting the Firestore document.
      if (authError.code === "auth/user-not-found") {
        console.log(
          `Auth user not found: ${uid}. Continuing...`
        );
      } else {
        throw authError;
      }
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
// 🏠 ROOT API TEST
// GET /
// ======================================
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Scheduling System API is running.",
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
  console.log(`Scheduling System API running on port ${PORT}`);
});