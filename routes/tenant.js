const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const media = require("../media.js");
const { wrap } = require("../apiUtil.js");
const audit = require("../audit.js");

const router = express.Router();
router.use(auth.requireAuth);
router.use(auth.requireTenantAdmin); 

// 1. Get current tenant
router.get("/me", wrap(async (req, res) => {
  const tenant = await db.one("SELECT * FROM tenants WHERE id = ?", [req.user.tenant_id]);
  res.json({ tenant });
}));

// 2. Update profile (Business Name + AI System Prompt)
router.put("/profile", wrap(async (req, res) => {
  const { businessName, systemPrompt, businessProfile } = req.body;
  const tenantId = req.user.tenant_id;

  const sets = [];
  const params = [];

  if (businessName !== undefined) {
    if (!businessName.trim()) return res.status(400).json({ error: "Business name cannot be empty." });
    sets.push("business_name = ?");
    params.push(businessName);
  }

  if (systemPrompt !== undefined) {
    sets.push("system_prompt = ?");
    params.push(systemPrompt);
  }

  if (businessProfile !== undefined) {
    sets.push("business_profile_json = ?");
    params.push(JSON.stringify(businessProfile));
  }

  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update." });

  sets.push("updated_at = UTC_TIMESTAMP(3)");
  params.push(tenantId);

  await db.run(
    `UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`,
    params
  );

  await audit.log({
    tenantId, actorType: "user", actorId: req.user.id,
    action: "tenant.profile_update", ip: auth.clientIp(req)
  });

  res.json({ ok: true });
}));

// 3. Update branding (Colors, Slogan)
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

// 4. Upload Logo
router.post("/logo", media.upload.single("logo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

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