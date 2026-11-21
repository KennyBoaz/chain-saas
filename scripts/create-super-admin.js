#!/usr/bin/env node
/**
 * Creates (or resets) the first super admin from env vars.
 * Usage:
 *   SUPER_ADMIN_EMAIL=x SUPER_ADMIN_PASSWORD=y SUPER_ADMIN_NAME=z npm run create-super-admin
 */
require("dotenv").config();
const db = require("../db.js");
const { hashPassword } = require("../crypto.js");

(async () => {
  const email = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || "";
  const name = (process.env.SUPER_ADMIN_NAME || "Super Admin").trim();

  if (!email || !password) {
    console.error("Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD env vars first.");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("Password must be at least 12 characters.");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await db.one("SELECT id FROM platform_staff WHERE email = ?", [email]);
  if (existing) {
    await db.run(
      "UPDATE platform_staff SET name = ?, password_hash = ?, role = 'super_admin', active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?",
      [name, hash, existing.id]
    );
    console.log(`Updated super admin #${existing.id} (${email}).`);
  } else {
    const r = await db.run(
      "INSERT INTO platform_staff (name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, 'super_admin', 1, UTC_TIMESTAMP(3))",
      [name, email, hash]
    );
    console.log(`Created super admin #${r.insertId} (${email}).`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });