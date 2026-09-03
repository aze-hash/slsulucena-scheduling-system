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

let cachedTransporter = null;

/**
 * Creates and returns the nodemailer transporter using environment variables.
 */
export function getEmailTransporter(forceNew = false) {
    if (cachedTransporter && !forceNew) {
        return cachedTransporter;
    }

    const host = process.env.EMAIL_HOST || "smtp.gmail.com";
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;
    const port = parseInt(process.env.EMAIL_PORT, 10) || 587;
    const secure = process.env.EMAIL_SECURE === "true" || port === 465;

    if (!user || !pass) {
        return null;
    }

    cachedTransporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
            user,
            pass
        }
    });

    return cachedTransporter;
}

/**
 * Verifies Gmail SMTP connection on server startup.
 */
export async function verifySmtpConnection() {
    const transporter = getEmailTransporter();
    if (!transporter) {
        console.warn("⚠️ [SMTP Warning] Gmail SMTP is not configured. Missing EMAIL_USER or EMAIL_PASSWORD environment variables.");
        return { success: false, message: "Missing EMAIL_USER or EMAIL_PASSWORD" };
    }

    try {
        await transporter.verify();
        console.log("✅ [SMTP Success] Connected to Gmail SMTP server successfully. Ready to send emails.");
        return { success: true };
    } catch (err) {
        console.error("❌ [SMTP Error] Failed to connect to Gmail SMTP:", err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Resolves the application base URL
 */
export function getAppBaseUrl() {
    const raw = process.env.APP_BASE_URL || "https://slsulucena-scheduling-system.web.app";
    return raw.replace(/\/+$/, "");
}

/**
 * Sends a test email to verify SMTP delivery
 */
export async function sendTestEmail(toEmail) {
    const recipient = toEmail || process.env.EMAIL_USER;
    if (!recipient) {
        return {
            success: false,
            error: "No test recipient email specified and EMAIL_USER is not set in environment variables."
        };
    }

    const transporter = getEmailTransporter();
    if (!transporter) {
        return {
            success: false,
            error: "SMTP transporter is not configured. Please check EMAIL_USER and EMAIL_PASSWORD in .env."
        };
    }

    const fromAddress = process.env.EMAIL_FROM || `"SLSU Lucena Scheduling System" <${process.env.EMAIL_USER}>`;

    try {
        const info = await transporter.sendMail({
            from: fromAddress,
            to: recipient,
            subject: "SLSU Lucena Scheduling System - Test Email",
            text: "This is a test email confirming that Gmail SMTP notifications are functioning correctly on the SLSU Lucena Scheduling System server.",
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #1b5e20;">SLSU Lucena Scheduling System</h2>
                    <p>This is a test notification confirming that Gmail SMTP is correctly configured and working on your Node.js backend.</p>
                    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
                </div>
            `
        });

        return {
            success: true,
            messageId: info.messageId,
            recipient
        };
    } catch (err) {
        console.error(`[EmailService] Test email failed for ${recipient}:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
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
        console.error(`[EmailService] Transporter not configured. Cannot send class schedule email to ${recipientEmail}. [Subject: ${subject}]`);
        return {
            success: false,
            error: "SMTP transporter is not configured. Please verify EMAIL_USER and EMAIL_PASSWORD in .env."
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
        console.error(`[EmailService] Transporter not configured. Cannot send exam schedule email to ${recipientEmail}. [Subject: ${subject}]`);
        return {
            success: false,
            error: "SMTP transporter is not configured. Please verify EMAIL_USER and EMAIL_PASSWORD in .env."
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
