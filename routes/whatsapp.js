const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const auth = require("../auth.js");
const cryptoHelper = require("../crypto.js");
const { HttpError, wrap } = require("../apiUtil.js");
const audit = require("../audit.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// 1. Get connection status
router.get("/status", auth.requireAuth, wrap(async (req, res) => {
  const conn = await db.one("SELECT * FROM whatsapp_connection WHERE tenant_id = ?", [req.user.tenant_id]);
  res.json({ connected: !!conn, connection: conn || null, csrf: req.session.csrf_token });
}));

// 2. Exchange Meta Auth Code for Access Token (Embedded Signup)
router.post("/connect", auth.requireTenantAdmin, wrap(async (req, res) => {
  const { code, wabaId, phoneNumberId } = req.body;
  if (!code || !wabaId || !phoneNumberId) throw new HttpError(400, "Missing Meta parameters.");

  // A. Exchange code for token via Meta Graph API
  let tokenData;
  try {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        code: code
      }
    });
    tokenData = response.data;
  } catch (err) {
    console.error("[Meta] Token exchange failed:", err.response?.data || err.message);
    throw new HttpError(500, "Failed to exchange code with Meta.");
  }

  const accessToken = tokenData.access_token;
  
  // B. Encrypt the token for database storage
  const encryptedToken = cryptoHelper.encryptString(accessToken);

  // C. Save or update the connection (1 per tenant)
  await db.run(`
    INSERT INTO whatsapp_connection (tenant_id, waba_id, phone_number_id, access_token_enc, connected_by, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE 
      waba_id = VALUES(waba_id),
      phone_number_id = VALUES(phone_number_id),
      access_token_enc = VALUES(access_token_enc),
      updated_at = UTC_TIMESTAMP(3)
  `, [req.user.tenant_id, wabaId, phoneNumberId, encryptedToken, req.user.id]);

  await audit.log({
    tenantId: req.user.tenant_id, actorType: "user", actorId: req.user.id,
    action: "whatsapp.connected", ip: auth.clientIp(req)
  });

  res.json({ ok: true, message: "WhatsApp connected successfully." });
}));

// 3. Disconnect
router.post("/disconnect", auth.requireTenantAdmin, wrap(async (req, res) => {
  await db.run("DELETE FROM whatsapp_connection WHERE tenant_id = ?", [req.user.tenant_id]);
  res.json({ ok: true, message: "Disconnected." });
}));

module.exports = router;