const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const { hashPassword, verifyPassword } = require("../crypto.js");
const { HttpError, wrap, cleanEmail, cleanName, slugify } = require("../apiUtil.js");
const audit = require("../audit.js");
const email = require("../email.js");

const router = express.Router();

// SIGNUP: Creates a Tenant, a User, and accepts T&C all at once.
router.post("/signup", wrap(async (req, res) => {
  const { businessName, name, email: rawEmail, password, termsVersion } = req.body;
  
  const emailAddr = cleanEmail(rawEmail);
  if (!emailAddr) throw new HttpError(400, "Invalid email address.");
  if (!password || password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
  if (!cleanName(name)) throw new HttpError(400, "Invalid name.");
  if (!cleanName(businessName)) throw new HttpError(400, "Invalid business name.");

  const existing = await db.one("SELECT id FROM users WHERE email = ?", [emailAddr]);
  if (existing) throw new HttpError(409, "An account with this email already exists.");

  const passHash = await hashPassword(password);
  const baseSlug = slugify(businessName);
  
  // Ensure slug is unique
  let slug = baseSlug;
  let counter = 1;
  while (await db.one("SELECT id FROM tenants WHERE slug = ?", [slug])) {
    slug = `${baseSlug}-${counter++}`;
  }

  const clientIp = auth.clientIp(req);
  const userAgent = (req.headers["user-agent"] || "").slice(0, 255);

  // We use a transaction so if anything fails (like the user insert), the tenant is rolled back.
  await db.tx(async (t) => {
    const tenantResult = await t.run(
      `INSERT INTO tenants (slug, business_name, contact_email, status, billing_status, grace_days, read_only_days, created_at, updated_at) 
       VALUES (?, ?, ?, 'pending_payment', 'trial', 0, 3, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [slug, businessName, emailAddr]
    );
    const tenantId = tenantResult.insertId;

    const userResult = await t.run(
      `INSERT INTO users (tenant_id, name, email, password_hash, role, active, created_at) 
       VALUES (?, ?, ?, ?, 'tenant_admin', 1, UTC_TIMESTAMP(3))`,
      [tenantId, name, emailAddr, passHash]
    );

    if (termsVersion) {
      await t.run(
        `INSERT INTO terms_acceptances (tenant_id, user_id, doc_type, doc_version, ip, user_agent, accepted_at) 
         VALUES (?, ?, 'terms', ?, ?, ?, UTC_TIMESTAMP(3))`,
        [tenantId, userResult.insertId, termsVersion, clientIp, userAgent]
      );
    }
  });

  await audit.log({
    actorType: "user", action: "tenant.signup", targetType: "tenant",
    detail: { email: emailAddr, businessName }, ip: clientIp
  });

  // Send welcome email (console stub)
  await email.send({
    to: emailAddr, subject: "Welcome to Chain Innovation",
    text: `Hi ${name}, your account for ${businessName} is ready. Please log in to connect your WhatsApp number.`,
  });

  res.status(201).json({ ok: true, message: "Account created. Please log in." });
}));

// LOGIN
router.post("/login", wrap(async (req, res) => {
  const { email: rawEmail, password } = req.body;
  const emailAddr = cleanEmail(rawEmail);
  if (!emailAddr || !password) throw new HttpError(400, "Email and password required.");

  if (!auth.allowAttempt(`login:${auth.clientIp(req)}`, 5, 15 * 60 * 1000)) {
    throw new HttpError(429, "Too many login attempts. Try again in 15 minutes.");
  }

  const user = await db.one("SELECT * FROM users WHERE email = ?", [emailAddr]);
  if (!user || !user.active) throw new HttpError(401, "Invalid credentials or account disabled.");

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(403, "Account is temporarily locked due to failed logins.");
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const fails = user.failed_logins + 1;
    const lock = fails >= 5 ? new Date(Date.now() + 15 * 60000) : null;
    await db.run("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", [fails, lock, user.id]);
    throw new HttpError(401, "Invalid credentials.");
  }

  await db.run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE id = ?", [user.id]);

  const { csrf } = await auth.createSession({
    subjectType: "user", subjectId: user.id, tenantId: user.tenant_id, req, res
  });

  res.json({
    ok: true, csrf,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id }
  });
}));

// LOGOUT
router.post("/logout", wrap(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// ME (Returns current user + tenant status)
router.get("/me", auth.requireAuth, wrap(async (req, res) => {
  const tenant = await db.one("SELECT * FROM tenants WHERE id = ?", [req.user.tenant_id]);
  res.json({
    user: req.user,
    tenant: {
      id: tenant.id, slug: tenant.slug, name: tenant.business_name,
      status: tenant.status, billingStatus: tenant.billing_status,
      branding: tenant.branding_json || {}, hasWhatsApp: false // Added in Phase 3
    },
    csrf: req.session.csrf_token
  });
}));

module.exports = router;