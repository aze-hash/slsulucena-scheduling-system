import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import dns from "node:dns";

// Prefer IPv4 over IPv6 to avoid 60-second timeouts on networks with broken IPv6 routing
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

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
// Enable REST transport for Firestore to prevent gRPC connection deadline timeouts
try {
  db.settings({ preferRest: true });
} catch (settingsErr) {
  console.warn("Could not set Firestore preferRest setting:", settingsErr.message);
}

const auth = getAuth();

export { db, auth };