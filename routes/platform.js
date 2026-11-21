const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const billing = require("../billing.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();

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

module.exports = router;