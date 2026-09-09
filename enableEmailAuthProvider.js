/**
 * enableEmailAuthProvider.js
 *
 * Diagnoses the Firebase Authentication configuration behind
 * `auth/operation-not-allowed` when changing an email address.
 *
 * Findings for this project:
 *   1. Reauthentication (verifyPassword) requires the Email/Password
 *      provider to be ENABLED (Identity Toolkit v2: signIn.email.enabled).
 *      If it is disabled, this script can enable it.
 *   2. Client-side IMMEDIATE email change (updateEmail -> accounts:update
 *      with an email field) is REJECTED by Google's v2 backend with
 *      OPERATION_NOT_ALLOWED "Please verify the new email before changing
 *      email". This is mandatory server-side enforcement (email enumeration
 *      protection) - no Console setting or admin API field disables it.
 *      The supported immediate path is the Admin SDK (auth.updateUser),
 *      implemented in server.js POST /api/auth/update-email.
 *
 * Usage:
 *   node --use-system-ca enableEmailAuthProvider.js --check   # read-only diagnostic
 *   node --use-system-ca enableEmailAuthProvider.js           # enable provider if disabled
 *
 * Requires: serviceAccountKey.json (or FIREBASE_SERVICE_ACCOUNT env var)
 * with Owner/Editor or Firebase Authentication Admin permissions, and the
 * Identity Toolkit API enabled for the project.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { GoogleAuth } from "google-auth-library";

dotenv.config();

const PROJECT_ID = "slsulucena-scheduling-system";
const SCOPES = [
    "https://www.googleapis.com/auth/identitytoolkit",
    "https://www.googleapis.com/auth/cloud-platform"
];
const CONFIG_URL =
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config`;

const readOnly = process.argv.includes("--check");

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    const keyPath = path.resolve("./serviceAccountKey.json");
    if (fs.existsSync(keyPath)) {
        return JSON.parse(fs.readFileSync(keyPath, "utf8"));
    }
    console.error("No service account credentials found.");
    console.error("Provide serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT env var.");
    process.exit(1);
}

async function main() {
    const serviceAccount = loadServiceAccount();

    if (serviceAccount.project_id && serviceAccount.project_id !== PROJECT_ID) {
        console.warn(
            `Warning: service account project_id "${serviceAccount.project_id}" ` +
            `differs from target project "${PROJECT_ID}".`
        );
    }

    const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: SCOPES
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();

    if (!token) {
        console.error("Could not obtain an access token. Check the service account key.");
        process.exit(1);
    }

    /* --- Step 1: read the current project config (never logs secrets) --- */
    const getRes = await fetch(CONFIG_URL, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!getRes.ok) {
        const errText = await getRes.text();
        console.error(`GET config failed (${getRes.status}):`, errText);
        if (getRes.status === 403) {
            console.error(
                "Hint: the Identity Toolkit API may be disabled for this project, or the " +
                "service account lacks permissions (needs Owner/Editor or Firebase Auth Admin)."
            );
        }
        process.exit(1);
    }

    const config = await getRes.json();
    const signIn = config.signIn || {};
    const emailProvider = signIn.email || {};
    const passwordSignupEnabled = emailProvider.enabled === true;

    console.log("Firebase Authentication project config:");
    console.log(`  - Email/Password sign-in (signIn.email.enabled): ${passwordSignupEnabled ? "ENABLED" : "DISABLED"}`);
    console.log(`  - Password required for email provider: ${emailProvider.passwordRequired ? "yes" : "no"}`);
    console.log(`  - Blocking functions: ${Object.keys(config.blockingFunctions || {}).length ? "configured" : "none"}`);
    console.log(`  - Client permission restrictions: ${JSON.stringify((config.client || {}).permissions || {})}`);
    console.log(`  - Authorized domains: ${(config.authorizedDomains || []).length} configured`);

    if (!passwordSignupEnabled) {
        console.log(
            "\nPROBLEM FOUND: The Email/Password provider is DISABLED. " +
            "Reauthentication (and any email change) will fail until it is enabled."
        );
        if (readOnly) {
            console.log("\nRun without --check to enable it automatically.");
            return;
        }

        console.log("\nEnabling Email/Password sign-in provider...");
        const patchRes = await fetch(`${CONFIG_URL}?updateMask=signIn.email.enabled`, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ signIn: { email: { enabled: true } } })
        });

        if (!patchRes.ok) {
            console.error(`PATCH config failed (${patchRes.status}):`, await patchRes.text());
            console.error(
                "\nManual fix: Firebase Console -> Authentication -> Sign-in method -> " +
                "Email/Password -> Enable."
            );
            process.exit(1);
        }

        const updated = await patchRes.json();
        console.log(
            `DONE: Email/Password provider is now ${updated.signIn?.email?.enabled ? "ENABLED" : "STILL DISABLED"}.`
        );
        return;
    }

    console.log(
        "\nOK: Email/Password provider is enabled, so reauthentication works.\n" +
        "\nIMPORTANT - about auth/operation-not-allowed on immediate email changes:\n" +
        "  Google's Identity Toolkit v2 backend (Identity Platform) REJECTS the\n" +
        "  client-side immediate email change (updateEmail / accounts:update with\n" +
        "  an email field) with:\n" +
        "    OPERATION_NOT_ALLOWED: Please verify the new email before changing email.\n" +
        "  This is enforced server-side (mandatory email enumeration protection).\n" +
        "  There is NO Firebase Console setting and NO field in the Identity Toolkit\n" +
        "  admin config that disables it. verifyBeforeUpdateEmail() would work but\n" +
        "  sends a verification email, which this project must not do.\n" +
        "\n  REMEDY: change the email IMMEDIATELY via the Admin SDK\n" +
        "  (auth.updateUser(uid, { email }) - same UID, no email sent).\n" +
        "  This project implements that in server.js:\n" +
        "    POST /api/auth/update-email  (called by frontend/faculty.js after\n" +
        "    the faculty member reauthenticates with their current password)."
    );
}

main().catch(error => {
    console.error("Unexpected error:", error.message);
    process.exit(1);
});
