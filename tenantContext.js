/**
 * tenantContext.js — resolves req.tenant for authenticated tenant users.
 * Super admins manage tenants via /api/platform/*, not through this.
 */
const db = require("./db.js");

async function loadTenant(req, _res, next) {
  try {
    if (!req.user) return next();
    const t = await db.one("SELECT * FROM tenants WHERE id = ?", [req.user.tenant_id]);
    req.tenant = t || null;
    next();
  } catch (e) {
    console.error("[tenant] load failed:", e.message);
    next();
  }
}

/** Blocks writes when tenant is read_only or suspended. Read GETs still work. */
function requireActiveBilling(req, res, next) {
  if (!req.tenant) return res.status(400).json({ error: "No tenant context.", code: "NO_TENANT" });
  if (["read_only", "suspended", "cancelled"].includes(req.tenant.status)) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    return res.status(402).json({
      error: "Your subscription is not active. Please renew to make changes.",
      code: "BILLING_INACTIVE",
      status: req.tenant.status,
    });
  }
  next();
}

module.exports = { loadTenant, requireActiveBilling };