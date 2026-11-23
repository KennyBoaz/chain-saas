/**
 * email.js — swappable email transport.
 * Today: console stub (writes to stdout + audit_log).
 * Later (Phase 5): cPanel SMTP via nodemailer — only this file changes.
 */
const audit = require("./audit.js");

async function send({ to, subject, text, html, tenantId = null, kind = "generic" }) {
  console.log(`\n[email] to=${to} subject="${subject}" kind=${kind}\n${text || html || ""}\n`);
  await audit.log({
    tenantId,
    actorType: "system",
    action: "email.stub",
    targetType: "email",
    targetId: to,
    detail: { subject, kind },
  });
  return { ok: true, stub: true };
}

module.exports = { send };