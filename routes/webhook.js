const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const cryptoHelper = require("../crypto.js");
const { generateReply } = require("../gemini.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// 1. Meta Webhook Verification (GET)
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2. Incoming Messages (POST)
router.post("/", async (req, res) => {
  res.sendStatus(200); // Always reply 200 to Meta immediately

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const phoneNumberId = value.metadata.phone_number_id;
    const customerPhone = message.from;
    const textBody = message.text.body;

    // A. Find the tenant based on the phone number ID Meta just messaged
    const connection = await db.one(
      "SELECT tenant_id, access_token_enc FROM whatsapp_connection WHERE phone_number_id = ?", 
      [phoneNumberId]
    );

    if (!connection) {
      console.log(`[Webhook] Ignored message. No tenant connected to number: ${phoneNumberId}`);
      return;
    }

    // B. Check tenant status (Read-only or Suspended tenants do not get bot replies)
    const tenant = await db.one("SELECT status FROM tenants WHERE id = ?", [connection.tenant_id]);
    if (tenant.status === "suspended" || tenant.status === "read_only") {
      console.log(`[Webhook] Ignored message. Tenant ${connection.tenant_id} is ${tenant.status}.`);
      return;
    }

    // C. Save message to DB
    await db.run(`
      INSERT INTO messages (tenant_id, phone, direction, sender_type, body, created_at)
      VALUES (?, ?, 'in', 'customer', ?, UTC_TIMESTAMP(3))
    `, [connection.tenant_id, customerPhone, textBody]);

    // D. Generate AI Reply
    const aiReply = await generateReply(connection.tenant_id, textBody);

    // E. Send the reply back to WhatsApp
    const accessToken = cryptoHelper.decryptString(connection.access_token_enc);
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: customerPhone,
        type: "text",
        text: { body: aiReply }
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // F. Save outgoing message to DB
    await db.run(`
      INSERT INTO messages (tenant_id, phone, direction, sender_type, body, created_at)
      VALUES (?, ?, 'out', 'bot', ?, UTC_TIMESTAMP(3))
    `, [connection.tenant_id, customerPhone, aiReply]);

  } catch (err) {
    console.error("[Webhook] Error processing message:", err.message);
  }
});

module.exports = router;