// mailer.js — thin SMTP wrapper for the notification email channel.
//
// Configured entirely from the environment:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
//
// If SMTP_HOST is not set, sendEmail() no-ops with a warning so the app and the
// in-app notification channel keep working without a relay configured. Outbound
// SMTP must be permitted by the environment's network policy, and a sending
// identity/relay (e.g. SendGrid) is required for mail to actually go out.

const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

const FROM = process.env.MAIL_FROM || 'Squadron Task Tracker <no-reply@108ces.local>';

// Returns true if the message was handed to the transport, false if skipped.
async function sendEmail(to, subject, html) {
  if (!to) return false;
  const tx = getTransporter();
  if (!tx) {
    console.warn(`[mailer] SMTP not configured — skipping email to ${to} ("${subject}")`);
    return false;
  }
  await tx.sendMail({ from: FROM, to, subject, html });
  return true;
}

module.exports = { sendEmail };
