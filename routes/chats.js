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

// Generate demo data for testing the UI
router.post("/seed-demo", auth.requireAuth, wrap(async (req, res) => {
  const tenantId = req.user.tenant_id;
  const demoPhones = ["256701234567", "256772345678", "256753456789"];
  
  for (const phone of demoPhones) {
    // Create customer
    await db.run("INSERT IGNORE INTO customers (tenant_id, phone, whatsapp_name, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))", [tenantId, phone, "Demo Customer " + phone.slice(-4)]);
    
    // Create conversation
    await db.run(`
      INSERT INTO conversations (tenant_id, phone, last_message_at, last_message_preview, created_at)
      VALUES (?, ?, UTC_TIMESTAMP(3), 'I would like to know the price of solar panels.', UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE last_message_at = UTC_TIMESTAMP(3)
    `, [tenantId, phone]);

    // Create messages
    const msgs = [
      ["in", "customer", "Hello, do you have solar panels in stock?"],
      ["out", "bot", "Yes! We have 200W and 300W panels available. Which one are you interested in?"],
      ["in", "customer", "I would like to know the price of solar panels."]
    ];
    
    for (const [dir, sender, body] of msgs) {
      await db.run(
        "INSERT INTO messages (tenant_id, phone, direction, sender_type, body, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [tenantId, phone, dir, sender, body]
      );
    }
  }
  
  res.json({ ok: true, message: "Demo data seeded!" });
}));


module.exports = router;