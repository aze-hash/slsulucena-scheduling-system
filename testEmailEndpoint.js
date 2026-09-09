/**
 * testEmailEndpoint.js
 *
 * End-to-end test of POST /api/auth/update-email (server.js).
 * Start the server first, e.g. on a test port:
 *   $env:PORT=3100; node --use-system-ca server.js
 *
 * Covers:
 *   1. Happy path  -> 200, email changed immediately, same UID, old email rejected
 *   2. Duplicate   -> 409 "This email is already associated with another account."
 *   3. Bad token   -> 401
 *   4. Bad email   -> 400
 *   5. Cleanup of all temp users
 *
 * No passwords are logged. Run: node --use-system-ca testEmailEndpoint.js
 */

import { auth } from "./firebase-admin.js";

const API_KEY = "AIzaSyDPYU4M5hnIubQFsm9onxQboqQW01U-27o";
const BASE = "https://identitytoolkit.googleapis.com/v1/accounts";
const SERVER = process.env.TEST_SERVER_URL || "http://localhost:3100";

const PASSWORD = "TmpTest-9f3k2!";
const RUN_ID = Date.now();
const EMAIL_A = `tmp-ep-a-${RUN_ID}@scheduling-test.invalid`;
const EMAIL_B = `tmp-ep-b-${RUN_ID}@scheduling-test.invalid`;
const EMAIL_C = `tmp-ep-c-${RUN_ID}@scheduling-test.invalid`;

const tempUids = [];

function log(label, ok, detail) {
    console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
}

async function signIn(email) {
    const res = await fetch(`${BASE}:signInWithPassword?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true })
    });
    return res.json();
}

async function callEndpoint(idToken, newEmail) {
    const res = await fetch(`${SERVER}/api/auth/update-email`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${idToken}`
        },
        body: JSON.stringify({ newEmail })
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

async function main() {
    try {
        /* Setup: user A (signs in), user C (owns the duplicate email) */
        const userA = await auth.createUser({ email: EMAIL_A, password: PASSWORD });
        const userC = await auth.createUser({ email: EMAIL_C, password: PASSWORD });
        tempUids.push(userA.uid, userC.uid);
        console.log(`Setup: created users A=${userA.uid} C=${userC.uid}`);

        const signInA = await signIn(EMAIL_A);
        if (!signInA.idToken) throw new Error("Setup sign-in for user A failed");
        console.log("Setup: user A signed in (idToken obtained, mirrors client post-reauth token)");

        /* 1. Happy path: immediate change, same UID */
        const happy = await callEndpoint(signInA.idToken, EMAIL_B);
        const updated = await auth.getUser(userA.uid);
        const okHappy =
            happy.status === 200 &&
            updated.uid === userA.uid &&
            updated.email === EMAIL_B &&
            updated.emailVerified === false;
        log("1. Happy path (200, immediate, same UID, not verified)", okHappy,
            `status=${happy.status} email=${updated.email}`);

        /* 1b. New email is immediately usable, old email is rejected */
        const newSignIn = await signIn(EMAIL_B);
        const oldSignIn = await signIn(EMAIL_A);
        log("1b. New email signs in, old email rejected",
            Boolean(newSignIn.idToken) && !oldSignIn.idToken);

        /* 2. Duplicate email -> 409 */
        const signInB = await signIn(EMAIL_B);
        const dup = await callEndpoint(signInB.idToken, EMAIL_C);
        log("2. Duplicate email rejected (409)", dup.status === 409,
            `status=${dup.status} error="${dup.json.error}"`);

        /* 3. Bad token -> 401 */
        const badToken = await callEndpoint("not-a-real-token", EMAIL_B);
        log("3. Invalid token rejected (401)", badToken.status === 401,
            `status=${badToken.status} error="${badToken.json.error}"`);

        /* 4. Invalid email -> 400 */
        const badEmail = await callEndpoint(signInB.idToken, "not-an-email");
        log("4. Invalid email rejected (400)", badEmail.status === 400,
            `status=${badEmail.status} error="${badEmail.json.error}"`);
    } catch (error) {
        log("Unexpected test error", false, error.message);
    } finally {
        for (const uid of tempUids) {
            try {
                await auth.deleteUser(uid);
                console.log(`Cleanup: deleted ${uid}`);
            } catch (cleanupError) {
                console.error(`Cleanup failed for ${uid}:`, cleanupError.message);
            }
        }
    }
}

main().then(() => process.exit(0));
