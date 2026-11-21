const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const media = require("../media.js");
const { wrap } = require("../apiUtil.js");
const audit = require("../audit.js");

const router = express.Router();
router.use(auth.requireAuth);
router.use(auth.requireTenantAdmin); 
// We require Admin for these routes. Tenant staff can view later.

// Get current tenant
router.get("/me", wrap(async (req, res) => {
  const tenant = await db.one("SELECT * FROM tenants WHERE id = ?", [req.user.tenant_id]);
  res.json({ tenant });
}));

// Update basic profile
router.put("/profile", wrap(async (req, res) => {
  const { businessName } = req.body;
  if (!businessName) return res.status(400).json({ error: "Business name required." });

  await db.run(
    "UPDATE tenants SET business_name = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [businessName, req.user.tenant_id]
  );
  await audit.log({
    tenantId: req.user.tenant_id, actorType: "user", actorId: req.user.id,
    action: "tenant.profile_update", ip: auth.clientIp(req)
  });
  res.json({ ok: true });
}));

// Update branding (Colors, Slogan)
router.put("/branding", wrap(async (req, res) => {
  const { primaryColor, secondaryColor, slogan } = req.body;
  
  const current = await db.one("SELECT branding_json FROM tenants WHERE id = ?", [req.user.tenant_id]);
  const currentBranding = current.branding_json || {};
  
  const updatedBranding = {
    ...currentBranding,
    primaryColor: primaryColor || currentBranding.primaryColor || "#243b32",
    secondaryColor: secondaryColor || currentBranding.secondaryColor || "#a8873a",
    slogan: slogan !== undefined ? slogan : currentBranding.slogan || ""
  };

  await db.run(
    "UPDATE tenants SET branding_json = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [JSON.stringify(updatedBranding), req.user.tenant_id]
  );
  res.json({ ok: true, branding: updatedBranding });
}));

// Upload Logo
router.post("/logo", media.upload.single("logo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  // Save URL path to branding JSON
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  const current = await db.one("SELECT branding_json FROM tenants WHERE id = ?", [req.user.tenant_id]);
  const currentBranding = current.branding_json || {};
  
  currentBranding.logoUrl = logoUrl;
  
  await db.run(
    "UPDATE tenants SET branding_json = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [JSON.stringify(currentBranding), req.user.tenant_id]
  );
  
  res.json({ ok: true, logoUrl });
}));

module.exports = router;