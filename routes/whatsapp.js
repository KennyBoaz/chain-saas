const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const auth = require("../auth.js");
const cryptoHelper = require("../crypto.js");
const wa = require("../whatsapp.js");
const { HttpError, wrap } = require("../apiUtil.js");
const audit = require("../audit.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";

// 1. Connection status. Never send the stored token (even encrypted) to the browser.
router.get("/status", auth.requireAuth, wrap(async (req, res) => {
  const conn = await db.one("SELECT waba_id, phone_number_id, connected_at, updated_at FROM whatsapp_connection WHERE tenant_id = ?", [req.user.tenant_id]);
  res.json({ connected: !!conn, connection: conn || null, csrf: req.session.csrf_token });
}));

// 2. Embedded Signup finished in the browser: exchange the code, subscribe to webhooks, save the token.
router.post("/connect", auth.requireTenantAdmin, auth.checkCsrf, wrap(async (req, res) => {
  const { code, wabaId, phoneNumberId } = req.body;
  if (!code || !wabaId || !phoneNumberId) throw new HttpError(400, "Missing Meta parameters.");

  let accessToken;
  try {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code },
    });
    accessToken = response.data.access_token;
  } catch (err) {
    console.error("[Meta] Token exchange failed:", err.response?.data || err.message);
    throw new HttpError(502, "Meta did not accept the sign-up code. Please try connecting again.");
  }
  if (!accessToken) throw new HttpError(502, "Meta did not return an access token.");

  // Required by Meta: subscribe our app to webhooks on THIS customer's WhatsApp Business Account.
  try {
    await wa.subscribeWaba(accessToken, wabaId);
  } catch (err) {
    console.error("[Meta] Webhook subscription failed:", err.response?.data || err.message);
    throw new HttpError(502, "Connected, but Meta would not start sending messages to us: " + wa.describeSendError(err));
  }

  await db.run(
    `INSERT INTO whatsapp_connection (tenant_id, waba_id, phone_number_id, access_token_enc, connected_by, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE waba_id = VALUES(waba_id), phone_number_id = VALUES(phone_number_id),
       access_token_enc = VALUES(access_token_enc), updated_at = UTC_TIMESTAMP(3)`,
    [req.user.tenant_id, wabaId, phoneNumberId, cryptoHelper.encryptString(accessToken), req.user.id]
  );
  await audit.log({ tenantId: req.user.tenant_id, actorType: "user", actorId: req.user.id, action: "whatsapp.connected", ip: auth.clientIp(req) });
  res.json({ ok: true, message: "WhatsApp connected successfully." });
}));

// 3. Disconnect: stop Meta sending us this business's messages, then forget the token.
router.post("/disconnect", auth.requireTenantAdmin, auth.checkCsrf, wrap(async (req, res) => {
  const conn = await wa.loadConnection(req.user.tenant_id);
  if (conn && conn.wabaId) await wa.unsubscribeWaba(conn.token, conn.wabaId).catch((e) => console.error("[Meta] Unsubscribe failed:", e.response?.data || e.message));
  await db.run("DELETE FROM whatsapp_connection WHERE tenant_id = ?", [req.user.tenant_id]);
  await audit.log({ tenantId: req.user.tenant_id, actorType: "user", actorId: req.user.id, action: "whatsapp.disconnected", ip: auth.clientIp(req) });
  res.json({ ok: true, message: "Disconnected." });
}));

module.exports = router;