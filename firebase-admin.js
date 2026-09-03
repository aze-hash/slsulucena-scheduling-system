import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.warn("Could not parse FIREBASE_SERVICE_ACCOUNT env var:", err.message);
  }
}

if (!serviceAccount) {
  const localKeyPath = path.resolve("./serviceAccountKey.json");
  if (fs.existsSync(localKeyPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(localKeyPath, "utf8"));
    } catch (err) {
      console.warn("Could not read local serviceAccountKey.json:", err.message);
    }
  }
}

if (!getApps().length) {
  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  } else {
    initializeApp();
  }
}

const db = getFirestore();
const auth = getAuth();

export { db, auth };