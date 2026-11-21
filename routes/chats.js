const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const auth = require("../auth.js");
const cryptoHelper = require("../crypto.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// Get list of conversations
router.get("/conversations", auth.requireAuth, wrap(async (req, res) => {
  const conversations = await db.all(`
    SELECT phone, last_message_at, last_message_preview, unread_count, mode, status
    FROM conversations 
    WHERE tenant_id = ? 
    ORDER BY last_message_at DESC LIMIT 50
  `, [req.user.tenant_id]);
  res.json({ conversations });
}));

// Get messages for a specific conversation
router.get("/conversations/:phone/messages", auth.requireAuth, wrap(async (req, res) => {
  const messages = await db.all(`
    SELECT id, direction, sender_type, body, created_at 
    FROM messages 
    WHERE tenant_id = ? AND phone = ? 
    ORDER BY created_at ASC LIMIT 100
  `, [req.user.tenant_id, req.params.phone]);
  res.json({ messages });
}));

// Send a manual reply (staff)
router.post("/conversations/:phone/reply", auth.requireAuth, wrap(async (req, res) => {
  const { text } = req.body;
  const customerPhone = req.params.phone;
  const tenantId = req.user.tenant_id;

  // 1. Get their WhatsApp connection
  const conn = await db.one("SELECT phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
  if (!conn) throw new HttpError(400, "WhatsApp not connected.");

  // 2. Send to Meta
  const accessToken = cryptoHelper.decryptString(conn.access_token_enc);
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: customerPhone,
        type: "text",
        text: { body: text }
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error("[Meta Send Error]", err.response?.data || err.message);
    throw new HttpError(500, "Failed to send message via WhatsApp.");
  }

  // 3. Save to DB (as 'staff')
  await db.run(`
    INSERT INTO messages (tenant_id, phone, direction, sender_type, staff_id, body, created_at)
    VALUES (?, ?, 'out', 'staff', ?, ?, UTC_TIMESTAMP(3))
  `, [tenantId, customerPhone, req.user.id, text]);

  // Update conversation preview
  await db.run(`
    UPDATE conversations 
    SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ? 
    WHERE tenant_id = ? AND phone = ?
  `, [text, tenantId, customerPhone]);

  res.json({ ok: true });
}));

module.exports = router;