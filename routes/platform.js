const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const billing = require("../billing.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();


const { verifyPassword } = require("../crypto.js");

// SUPER ADMIN LOGIN (Public route)
router.post("/login", wrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new HttpError(400, "Email and password required.");

  const staff = await db.one("SELECT * FROM platform_staff WHERE email = ?", [email]);
  if (!staff || !staff.active) throw new HttpError(401, "Invalid credentials.");

  const valid = await verifyPassword(password, staff.password_hash);
  if (!valid) throw new HttpError(401, "Invalid credentials.");

  // Create session for platform_staff
  const { csrf } = await auth.createSession({
    subjectType: "platform_staff", 
    subjectId: staff.id, 
    tenantId: null, 
    req, 
    res
  });

  res.json({
    ok: true, 
    csrf,
    user: { id: staff.id, name: staff.name, email: staff.email, role: "super_admin" }
  });
}));


// Protect all platform routes: Must be Super Admin

router.use(auth.requirePlatformStaff);
router.use((req, res, next) => {
  if (req.platformStaff.role !== "super_admin" && req.platformStaff.role !== "billing") {
    return res.status(403).json({ error: "Super Admin or Billing access required." });
  }
  next();
});

// GET all tenants
router.get("/tenants", wrap(async (_req, res) => {
  const tenants = await db.all(`
    SELECT t.id, t.business_name, t.slug, t.status, t.billing_status, t.created_at,
           s.current_period_end
    FROM tenants t
    LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status = 'active'
    ORDER BY t.id DESC
  `);
  res.json({ tenants });
}));

// Manually mark an invoice as paid (Cash payment)
router.post("/tenants/:id/mark-paid", wrap(async (req, res) => {
  const tenantId = req.params.id;
  const { planId, note } = req.body;

  // 1. Create invoice
  const inv = await billing.createInvoice(tenantId, planId, "cash");
  
  // 2. Mark it paid immediately
  await billing.markInvoicePaid(inv.invoiceId, note || "cash-payment", "cash", req.platformStaff.id);

  res.json({ ok: true, message: "Tenant activated via cash payment." });
}));

// Generate a Connect Token (For cash clients to log in without paying online)
router.post("/tenants/:id/connect-token", wrap(async (req, res) => {
  const crypto = require("crypto");
  const token = crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.run(
    `INSERT INTO connect_tokens (tenant_id, token_hash, purpose, created_by, expires_at, created_at)
     VALUES (?, ?, 'activate', ?, ?, UTC_TIMESTAMP(3))`,
    [req.params.id, hash, req.platformStaff.id, expiresAt]
  );

  res.json({ ok: true, token, message: "Give this token to the client." });
}));


// ==========================================
// SUPER ADMIN & TEAM MANAGEMENT
// ==========================================

// 1. Team & Tasks
router.get("/team", wrap(async (_req, res) => {
  const team = await db.all("SELECT id, name, email, role FROM platform_staff WHERE active = 1");
  res.json({ team });
}));

router.post("/tasks", wrap(async (req, res) => {
  const { title, detail, assignedTo, tenantId, dueAt } = req.body;
  const result = await db.run(`
    INSERT INTO platform_tasks (title, detail, assigned_to, assigned_by, tenant_id, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
  `, [title, detail, assignedTo, req.platformStaff.id, tenantId || null, dueAt || null]);
  res.json({ ok: true, taskId: result.insertId });
}));

router.get("/tasks", wrap(async (req, res) => {
  // If super_admin, show all tasks. If team member, show only theirs.
  let query = `
    SELECT t.*, p.name AS assignee_name, ten.business_name AS tenant_name
    FROM platform_tasks t
    JOIN platform_staff p ON p.id = t.assigned_to
    LEFT JOIN tenants ten ON ten.id = t.tenant_id
  `;
  let params = [];
  
  if (req.platformStaff.role !== "super_admin") {
    query += " WHERE t.assigned_to = ?";
    params.push(req.platformStaff.id);
  }
  
  query += " ORDER BY t.created_at DESC LIMIT 50";
  const tasks = await db.all(query, params);
  res.json({ tasks });
}));

// 2. Global Settings (e.g., Bank Details for Cash clients)
router.get("/settings", wrap(async (_req, res) => {
  const settings = await db.all("SELECT skey, svalue, is_secret FROM platform_settings");
  const map = {};
  settings.forEach(s => map[s.skey] = s.is_secret ? "********" : s.svalue);
  res.json({ settings: map });
}));

router.post("/settings", wrap(async (req, res) => {
  const { key, value, isSecret } = req.body;
  await db.run(`
    INSERT INTO platform_settings (skey, svalue, is_secret, updated_by, updated_at)
    VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE svalue = VALUES(svalue), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)
  `, [key, value, isSecret ? 1 : 0, req.platformStaff.id]);
  res.json({ ok: true });
}));

// 3. Tenant Overrides
router.post("/tenants/:id/extend", wrap(async (req, res) => {
  const { days } = req.body;
  const tenantId = req.params.id;
  
  // Find their latest subscription and add days to it
  const sub = await db.one("SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [tenantId]);
  if (sub) {
    await db.run(
      "UPDATE subscriptions SET current_period_end = DATE_ADD(current_period_end, INTERVAL ? DAY) WHERE id = ?",
      [days, sub.id]
    );
  } else {
    // If no sub exists, create one starting now
    const plan = await db.one("SELECT id FROM plans LIMIT 1");
    await db.run(
      "INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, source, created_at, updated_at) VALUES (?, ?, 'active', UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY), 'manual', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [tenantId, plan.id, days]
    );
  }
  
  // Ensure tenant is marked active
  await db.run("UPDATE tenants SET status = 'active', billing_status = 'active' WHERE id = ?", [tenantId]);
  res.json({ ok: true, message: `Extended by ${days} days.` });
}));

router.post("/tenants/:id/suspend", wrap(async (req, res) => {
  await db.run("UPDATE tenants SET status = 'suspended', billing_status = 'suspended' WHERE id = ?", [req.params.id]);
  res.json({ ok: true, message: "Tenant suspended." });
}));

module.exports = router;