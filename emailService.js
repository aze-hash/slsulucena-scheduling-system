import nodemailer from "nodemailer";

/**
 * HTML escaper to sanitize dynamic inputs in HTML emails
 */
function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

/**
 * Normalizes examination type string (e.g. "preliminary", "prelim" -> "Preliminary")
 */
export function normalizeExamType(rawType) {
    const norm = String(rawType || "Examination").trim().toLowerCase();
    if (norm.includes("prelim")) return "Preliminary";
    if (norm.includes("midterm")) return "Midterm";
    if (norm.includes("final")) return "Final";
    return rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1) : "Examination";
}

/**
 * Resolves the application base URL
 */
export function getAppBaseUrl() {
    const raw = process.env.APP_BASE_URL || "https://slsulucena-scheduling-system.firebaseapp.com";
    return raw.replace(/\/+$/, "");
}

/**
 * Safe startup check that reports whether required SMTP variables are present
 * Never prints the actual password.
 */
export function checkSmtpConfig() {
    const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD;
    const isConfigured = Boolean(
        host &&
        user &&
        pass &&
        !String(user).includes("your-email@gmail.com") &&
        !String(pass).includes("your-app-password")
    );
    console.log(`[EmailService] SMTP configuration loaded: ${isConfigured}`);
    return isConfigured;
}

/**
 * Creates and returns the nodemailer transporter using environment variables.
 * Supports both SMTP_* and EMAIL_* naming conventions.
 */
export function getEmailTransporter() {
    const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const rawPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.EMAIL_PASSWORD;
    const port = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT, 10) || 587;
    const secure = (process.env.SMTP_SECURE || process.env.EMAIL_SECURE) === "true" || port === 465;

    if (!host || !user || !rawPass) {
        return null;
    }

    const trimmedUser = String(user).trim();
    if (trimmedUser === "your-email@gmail.com") {
        return null;
    }

    // Gmail App Passwords are 16 chars, often formatted with spaces: 'xxxx xxxx xxxx xxxx'
    const trimmedPass = String(rawPass).trim();
    const cleanPass = (trimmedPass.includes(" ") && trimmedPass.replace(/\s+/g, "").length === 16)
        ? trimmedPass.replace(/\s+/g, "")
        : trimmedPass;

    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
            user: trimmedUser,
            pass: cleanPass
        }
    });
}

/**
 * Sends Examination Schedule notification email.
 * Per spec:
 * - Must NOT contain the actual examination schedule (no subject, section, room, date, time, proctor).
 * - Contains only the notification that the selected exam type is now available and the system link.
 * 
 * @param {object} params
 * @param {string} params.recipientEmail - Recipient email address
 * @param {string} [params.recipientName] - Recipient display name
 * @param {object} [params.scheduleInfo] - Schedule data (not included in email body)
 * @param {string} [params.examType] - Exam type label (e.g. "Preliminary", "Midterm", "Final")
 * @param {"student"|"faculty"} [params.recipientType] - Role of the recipient
 */
export async function sendExamScheduleNotification({
    recipientEmail,
    recipientName = "Student",
    scheduleInfo = {},
    examType = "Preliminary",
    recipientType = "student"
}) {
    if (!recipientEmail || typeof recipientEmail !== "string" || !recipientEmail.includes("@")) {
        return {
            success: false,
            error: "Invalid or missing recipient email address."
        };
    }

    const appUrl = getAppBaseUrl();
    const formattedExamType = normalizeExamType(examType || scheduleInfo.examType);
    const isFaculty = String(recipientType).trim().toLowerCase() === "faculty";
    const destinationUrl = appUrl;

    const subject = `[Exam Schedule] ${formattedExamType} Examination Schedule Available`;

    const bodyInstruction = isFaculty
        ? "Please log in to the Examination Scheduling System to view your assigned examination schedule."
        : "Please log in to the Examination Scheduling System to view your schedule.";

    const textContent = [
        "Hello,",
        "",
        `The ${formattedExamType} Examination Schedule is now available.`,
        "",
        bodyInstruction,
        "",
        "CLICK HERE TO VIEW SCHEDULE:",
        destinationUrl,
        "",
        "Thank you.",
        "Examination Scheduling System"
    ].join("\n");

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f1e6; color: #1a1a1a; margin: 0; padding: 0; }
  .wrapper { width: 100%; max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e0dbce; }
  .header { background: #1b5e20; padding: 24px; text-align: center; color: #ffffff; }
  .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
  .body { padding: 32px 28px; line-height: 1.6; font-size: 15px; color: #2d3748; }
  .body p { margin: 0 0 16px; }
  .btn-container { text-align: center; margin: 28px 0; }
  .btn { display: inline-block; background: #2e7d32; color: #ffffff !important; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; box-shadow: 0 3px 8px rgba(46, 125, 50, 0.35); text-transform: uppercase; letter-spacing: 0.5px; }
  .footer { background: #faf8f2; padding: 18px 24px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e6e2d8; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Southern Luzon State University - Lucena</h1>
    </div>
    <div class="body">
      <p>Hello,</p>
      <p>The ${escapeHtml(formattedExamType)} Examination Schedule is now available.</p>
      <p>${escapeHtml(bodyInstruction)}</p>
      <div class="btn-container">
        <a href="${destinationUrl}" class="btn" target="_blank">CLICK HERE TO VIEW SCHEDULE</a>
      </div>
      <p>Thank you.<br>Examination Scheduling System</p>
    </div>
    <div class="footer">
      This is an automated notification from the Examination Scheduling System. Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>`;

    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const fromAddress = process.env.MAIL_FROM || process.env.EMAIL_FROM || `"SLSU Lucena Scheduling System" <${user || 'no-reply@slsulucena.edu.ph'}>`;
    const transporter = getEmailTransporter();

    if (!transporter) {
        console.warn(`[EmailService] SMTP not configured. Skipping live email delivery for ${recipientEmail}. [Subject: ${subject}]`);
        return {
            success: true,
            simulated: true,
            message: "SMTP not configured. Notification skipped without error."
        };
    }

    try {
        const info = await transporter.sendMail({
            from: fromAddress,
            to: recipientEmail,
            subject,
            text: textContent,
            html: htmlContent
        });
        return {
            success: true,
            messageId: info.messageId
        };
    } catch (err) {
        console.error(`[EmailService] Failed to send exam schedule email to ${recipientEmail}:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
}
