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
    // Capitalize first letter if unknown
    return rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1) : "Examination";
}

/**
 * Creates and returns the nodemailer transporter using environment variables.
 */
export function getEmailTransporter() {
    const host = process.env.EMAIL_HOST;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;
    const port = parseInt(process.env.EMAIL_PORT, 10) || 587;
    const secure = process.env.EMAIL_SECURE === "true" || port === 465;

    if (!host || !user || !pass) {
        return null;
    }

    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
            user,
            pass
        }
    });
}

/**
 * Resolves the application base URL
 */
export function getAppBaseUrl() {
    const raw = process.env.APP_BASE_URL || "https://slsulucena-scheduling-system.firebaseapp.com";
    return raw.replace(/\/+$/, "");
}

/**
 * Sends Class Schedule Released email notification
 */
export async function sendClassScheduleNotification({
    recipientEmail,
    recipientName = "Student",
    scheduleInfo = {}
}) {
    if (!recipientEmail || typeof recipientEmail !== "string" || !recipientEmail.includes("@")) {
        return {
            success: false,
            error: "Invalid or missing recipient email address."
        };
    }

    const appUrl = getAppBaseUrl();
    const safeName = escapeHtml(recipientName || "Student");
    const safeSection = escapeHtml(scheduleInfo.section || scheduleInfo.name || "");
    const safeAy = escapeHtml(scheduleInfo.academicYear ? `A.Y. ${scheduleInfo.academicYear}` : "");
    const safeSem = escapeHtml(scheduleInfo.semester || "");
    
    const subject = "Class Schedule Released";

    const textContent = `Dear ${recipientName},\n\nThe class schedules are now available.\n\nPlease click the link below to view your schedule:\n${appUrl}\n\nThank you.\nSLSU Lucena Scheduling System`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f1e6; color: #1a1a1a; margin: 0; padding: 0; }
  .wrapper { width: 100%; max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e0dbce; }
  .header { background: #1b5e20; padding: 24px; text-align: center; color: #ffffff; }
  .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
  .body { padding: 32px 28px; line-height: 1.6; font-size: 15px; color: #2d3748; }
  .body p { margin: 0 0 16px; }
  .info-box { background: #f0f7f0; border-left: 4px solid #2e7d32; padding: 12px 16px; border-radius: 6px; margin: 20px 0; font-size: 14px; }
  .btn-container { text-align: center; margin: 28px 0; }
  .btn { display: inline-block; background: #2e7d32; color: #ffffff !important; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; box-shadow: 0 3px 8px rgba(46, 125, 50, 0.35); }
  .footer { background: #faf8f2; padding: 18px 24px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e6e2d8; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Southern Luzon State University - Lucena</h1>
    </div>
    <div class="body">
      <p>Dear ${safeName},</p>
      <p>The class schedules are now available.</p>
      ${(safeSection || safeAy || safeSem) ? `
      <div class="info-box">
        ${safeSection ? `<strong>Section:</strong> ${safeSection}<br>` : ''}
        ${safeAy ? `<strong>Academic Year:</strong> ${safeAy}<br>` : ''}
        ${safeSem ? `<strong>Semester:</strong> ${safeSem}` : ''}
      </div>` : ''}
      <p>Please click the button below to view your schedule.</p>
      <div class="btn-container">
        <a href="${appUrl}" class="btn" target="_blank">View My Class Schedule</a>
      </div>
      <p>Thank you.</p>
    </div>
    <div class="footer">
      This is an automated notification from the SLSU Lucena Scheduling System. Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>
`;

    const fromAddress = process.env.EMAIL_FROM || `"SLSU Lucena Scheduling System" <${process.env.EMAIL_USER || 'no-reply@slsulucena.edu.ph'}>`;
    const transporter = getEmailTransporter();

    if (!transporter) {
        console.warn(`[EmailService] Transporter not configured. Skipping live delivery for ${recipientEmail}. [Subject: ${subject}]`);
        return {
            success: true,
            simulated: true,
            message: "SMTP not configured. Notification simulated successfully."
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
        console.error(`[EmailService] Failed to send class schedule email to ${recipientEmail}:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Sends Examination Schedule Released email notification
 */
export async function sendExamScheduleNotification({
    recipientEmail,
    recipientName = "Student",
    scheduleInfo = {},
    examType = "Preliminary"
}) {
    if (!recipientEmail || typeof recipientEmail !== "string" || !recipientEmail.includes("@")) {
        return {
            success: false,
            error: "Invalid or missing recipient email address."
        };
    }

    const appUrl = getAppBaseUrl();
    const formattedExamType = normalizeExamType(examType || scheduleInfo.examType);
    const safeName = escapeHtml(recipientName || "Student / Faculty");
    const safeSection = escapeHtml(scheduleInfo.section || "");
    const safeAy = escapeHtml(scheduleInfo.academicYear ? `A.Y. ${scheduleInfo.academicYear}` : "");
    const safeSem = escapeHtml(scheduleInfo.semester || "");

    const subject = `${formattedExamType} Examination Schedule Released`;

    const textContent = `Dear ${recipientName},\n\nThe ${formattedExamType} Examination Schedule is now available.\n\nPlease click the link below to view your examination schedule:\n${appUrl}\n\nThank you.\nSLSU Lucena Scheduling System`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f1e6; color: #1a1a1a; margin: 0; padding: 0; }
  .wrapper { width: 100%; max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e0dbce; }
  .header { background: #1b5e20; padding: 24px; text-align: center; color: #ffffff; }
  .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
  .body { padding: 32px 28px; line-height: 1.6; font-size: 15px; color: #2d3748; }
  .body p { margin: 0 0 16px; }
  .info-box { background: #f0f7f0; border-left: 4px solid #2e7d32; padding: 12px 16px; border-radius: 6px; margin: 20px 0; font-size: 14px; }
  .btn-container { text-align: center; margin: 28px 0; }
  .btn { display: inline-block; background: #2e7d32; color: #ffffff !important; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-weight: bold; font-size: 15px; box-shadow: 0 3px 8px rgba(46, 125, 50, 0.35); }
  .footer { background: #faf8f2; padding: 18px 24px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e6e2d8; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Southern Luzon State University - Lucena</h1>
    </div>
    <div class="body">
      <p>Dear ${safeName},</p>
      <p>The ${formattedExamType} Examination Schedule is now available.</p>
      ${(safeSection || safeAy || safeSem) ? `
      <div class="info-box">
        <strong>Examination:</strong> ${formattedExamType} Examinations<br>
        ${safeSection ? `<strong>Section:</strong> ${safeSection}<br>` : ''}
        ${safeAy ? `<strong>Academic Year:</strong> ${safeAy}<br>` : ''}
        ${safeSem ? `<strong>Semester:</strong> ${safeSem}` : ''}
      </div>` : ''}
      <p>Please click the button below to view your examination schedule.</p>
      <div class="btn-container">
        <a href="${appUrl}" class="btn" target="_blank">View My Examination Schedule</a>
      </div>
      <p>Thank you.</p>
    </div>
    <div class="footer">
      This is an automated notification from the SLSU Lucena Scheduling System. Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>
`;

    const fromAddress = process.env.EMAIL_FROM || `"SLSU Lucena Scheduling System" <${process.env.EMAIL_USER || 'no-reply@slsulucena.edu.ph'}>`;
    const transporter = getEmailTransporter();

    if (!transporter) {
        console.warn(`[EmailService] Transporter not configured. Skipping live delivery for ${recipientEmail}. [Subject: ${subject}]`);
        return {
            success: true,
            simulated: true,
            message: "SMTP not configured. Notification simulated successfully."
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
