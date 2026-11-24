/** WhatsApp onboarding API, mounted at /api/whatsapp */
const express = require("express");
const db = require("../../db.js");
const auth = require("../../auth.js");
const { HttpError, wrap } = require("../../apiUtil.js");
const { MODES, byId } = require("./modes.js");
const service = require("./service.js");

const router = express.Router();

router.get("/modes", auth.requireAuth, (_req, res) => res.json({ modes: MODES }));

router.get("/config", auth.requireTenantAdmin, (_req, res) => {
  const c = service.config();
  res.json({ appId: c.appId, graphVersion: c.graphVersion, configIds: c.configIds });
});

// Never send the stored token (even encrypted) to the browser.
router.get("/status", auth.requireAuth, wrap(async (req, res) => {
  const conn = await db.one("SELECT waba_id, phone_number_id, display_phone, verified_name, mode, connected_at FROM whatsapp_connection WHERE tenant_id = ?", [req.user.tenant_id]);
  res.json({ connected: !!conn, connection: conn || null, csrf: req.session.csrf_token });
}));

router.post("/connect", auth.requireTenantAdmin, auth.checkCsrf, wrap(async (req, res) => {
  const { connectionType, code, wabaId, phoneNumberId } = req.body || {};
  if (!byId(connectionType)) throw new HttpError(400, "Choose how you want to connect first.");
  if (!code || !wabaId) throw new HttpError(400, "Meta did not return all the details. Please start again.");
  if (connectionType === "api" && !phoneNumberId) throw new HttpError(400, "Meta did not return the phone number. Please start again.");

  const tenant = await db.one("SELECT status FROM tenants WHERE id = ?", [req.user.tenant_id]);
  if (!tenant || tenant.status !== "active") throw new HttpError(403, "Activate your subscription before connecting WhatsApp.");

  const result = await service.connect({ tenantId: req.user.tenant_id, userId: req.user.id, ip: auth.clientIp(req), type: connectionType, code, wabaId: String(wabaId), phoneNumberId: phoneNumberId ? String(phoneNumberId) : null });
  res.json({ ok: true, ...result });
}));

router.post("/disconnect", auth.requireTenantAdmin, auth.checkCsrf, wrap(async (req, res) => {
  await service.disconnect(req.user.tenant_id, req.user.id, auth.clientIp(req));
  res.json({ ok: true, message: "Disconnected." });
}));

module.exports = router;