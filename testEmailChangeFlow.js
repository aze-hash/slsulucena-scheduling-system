/**
 * testEmailChangeFlow.js
 *
 * End-to-end reproduction of the immediate email change that the Firebase JS
 * SDK 10.13.2 performs via updateEmail():
 *
 *   1. Create a temporary Firebase Auth user (admin SDK)
 *   2. Sign in with email/password (client REST: accounts:signInWithPassword)
 *   3. Reauthenticate-equivalent fresh token is the sign-in idToken
 *   4. Change email immediately (client REST: accounts:setAccountInfo with email)
 *      -> This is the exact backend call updateEmail() makes.
 *   5. Verify the new email works (sign in with the new email)
 *   6. Delete the temporary user (admin SDK) - always, even on failure
 *
 * No passwords are logged. Run: node --use-system-ca testEmailChangeFlow.js
 */

import { auth } from "./firebase-admin.js";

const API_KEY = "AIzaSyDPYU4M5hnIubQFsm9onxQboqQW01U-27o";
const BASE = "https://identitytoolkit.googleapis.com/v1";

const PASSWORD = "TmpTest-9f3k2!";
const RUN_ID = Date.now();
const EMAIL_V1 = `tmp-emailchange-a-${RUN_ID}@scheduling-test.invalid`;
const EMAIL_V2 = `tmp-emailchange-b-${RUN_ID}@scheduling-test.invalid`;

async function clientCall(endpoint, body) {
    const res = await fetch(`${BASE}/accounts:${endpoint}?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { error: { code: res.status, message: `Non-JSON response: ${text.slice(0, 300)}` } };
    }
    return { ok: res.ok, status: res.status, json };
}

async function runProbes() {
    const probes = [
        ["v1 signInWithPassword (no key)", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword", "POST", {}],
        ["v1 signInWithPassword (bogus key)", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=bogus", "POST", { email: "x@y.z", password: "x" }],
        ["v1 signInWithPassword (real key)", `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, "POST", { email: EMAIL_V1, password: PASSWORD }],
        ["legacy verifyPassword", `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${API_KEY}`, "POST", { email: EMAIL_V1, password: PASSWORD, returnSecureToken: true }]
    ];
    for (const [label, url, method, body] of probes) {
        try {
            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            console.log(`[${label}] status=${res.status} body=${text.slice(0, 160).replace(/\s+/g, " ")}`);
        } catch (e) {
            console.log(`[${label}] FETCH ERROR: ${e.cause?.code || e.message}`);
        }
    }
}

async function main() {
    let uid = null;

    try {
        /* Step 1 - temporary user */
        const user = await auth.createUser({
            email: EMAIL_V1,
            password: PASSWORD,
            displayName: "Email Change Test"
        });
        uid = user.uid;
        console.log("1. Created temp user:", uid);

        /* Step 2 - sign in with email/password (password correct) */
        const signIn = await clientCall("signInWithPassword", {
            email: EMAIL_V1,
            password: PASSWORD,
            returnSecureToken: true
        });
        if (!signIn.ok) {
            console.error("2. Sign-in FAILED:", signIn.json.error?.code, signIn.json.error?.message);
            return;
        }
        console.log("2. Sign-in OK (idToken obtained)");

        /* Step 3 - immediate email change via accounts:update (what updateEmail does).
           On Identity Platform v2 backends this is rejected with
           OPERATION_NOT_ALLOWED "Please verify the new email before changing email". */
        const change = await clientCall("update", {
            idToken: signIn.json.idToken,
            email: EMAIL_V2,
            returnSecureToken: true
        });
        if (!change.ok) {
            console.log("3. Client-side immediate change (updateEmail path):",
                change.json.error?.code, "-", change.json.error?.message);
        } else {
            console.log("3. Client-side immediate email change OK. New email on token:", change.json.email);
        }

        /* Step 3b - the supported IMMEDIATE path: Admin SDK (what
           POST /api/auth/update-email does server-side).
           Same UID, no verification email. */
        const adminUser = await auth.updateUser(uid, { email: EMAIL_V2 });
        console.log("4. Admin SDK immediate email change OK. Same UID:", adminUser.uid === uid,
            "| new email:", adminUser.email);

        /* Step 5 - prove the new email is the sign-in email now */
        const reSignIn = await clientCall("signInWithPassword", {
            email: EMAIL_V2,
            password: PASSWORD,
            returnSecureToken: true
        });
        console.log("4. Sign-in with NEW email:", reSignIn.ok ? "OK (immediate, no verification email)" : `FAILED: ${reSignIn.json.error?.message}`);

        const oldSignIn = await clientCall("signInWithPassword", {
            email: EMAIL_V1,
            password: PASSWORD,
            returnSecureToken: true
        });
        console.log("5. Sign-in with OLD email:", oldSignIn.ok ? "still works (unexpected)" : "rejected (expected)");
    } catch (error) {
        console.error("Test error:", error.code || "", error.message);
    } finally {
        if (uid) {
            try {
                await auth.deleteUser(uid);
                console.log("6. Cleaned up temp user:", uid);
            } catch (cleanupError) {
                console.error("Cleanup failed for", uid, cleanupError.message);
            }
        }
    }
}

main().then(() => process.exit(0));
