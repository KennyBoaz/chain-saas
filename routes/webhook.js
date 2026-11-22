const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const cryptoHelper = require("../crypto.js");
const { downloadIncomingMedia } = require("../media.js"); // <-- Correct import
const { generateReply } = require("../gemini.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// Webhook Verification
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Incoming Messages
router.post("/", async (req, res) => {
  res.sendStatus(200); // Ack Meta immediately

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    // Handle Delivery Statuses
    if (value.statuses) {
      for (const status of value.statuses) {
        if (status.status === "failed") {
          await db.run(
            "UPDATE messages SET delivery_status = 'failed', error_text = ? WHERE wa_message_id = ?",
            [status.errors?.[0]?.title || "Unknown error", status.id]
          );
        } else {
          await db.run("UPDATE messages SET delivery_status = ? WHERE wa_message_id = ?", [status.status, status.id]);
        }
      }
      return;
    }

    const message = value.messages?.[0];
    if (!message) return;

    const phoneNumberId = value.metadata.phone_number_id;
    const customerPhone = message.from;
    const msgType = message.type;

    // Find Tenant
    const connection = await db.one(
      "SELECT tenant_id, access_token_enc FROM whatsapp_connection WHERE phone_number_id = ?",
      [phoneNumberId]
    );
    if (!connection) return;

    const tenantId = connection.tenant_id;
    const tenant = await db.one("SELECT status FROM tenants WHERE id = ?", [tenantId]);
    if (["suspended", "read_only", "cancelled"].includes(tenant.status)) return;

    // Ensure Customer Exists
    await db.run(`
      INSERT INTO customers (tenant_id, phone, whatsapp_name, created_at) 
      VALUES (?, ?, ?, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE whatsapp_name = VALUES(whatsapp_name)
    `, [tenantId, customerPhone, value.contacts?.[0]?.profile?.name || null]);

    let replyText = null;
    let attachments = []; // Holds the base64 data for Gemini

    // --- HANDLE MESSAGE TYPES ---
    switch (msgType) {
      case "text":
        replyText = message.text.body;
        break;

      case "image":
      case "video":
      case "document":
      case "audio":
        const mediaObj = message[msgType];
        
        // 1. Download the media using our new bulletproof function
        const mediaData = await downloadIncomingMedia(tenantId, mediaObj.id, msgType);
        
        if (mediaData.localUrl) {
          // 2. Save the media message to the database
          await db.run(`
            INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, has_media, media_mime, media_name, created_at)
            VALUES (?, ?, 'in', 'customer', ?, ?, 1, ?, ?, UTC_TIMESTAMP(3))
          `, [tenantId, customerPhone, msgType, mediaObj.caption || `[${msgType.toUpperCase()}]`, mediaData.mimeType, mediaData.localUrl]);

          // 3. Prepare the text prompt and base64 data for Gemini
          replyText = mediaObj.caption || `Customer sent a ${msgType}.`;
          
          if (mediaData.base64Data) {
            attachments.push({ 
              mimeType: mediaData.mimeType, 
              data: mediaData.base64Data 
            });
          }
        } else {
          replyText = `[Customer sent a ${msgType}, but it could not be downloaded]`;
        }
        break;

      case "location":
        replyText = `Customer shared location: https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`;
        await db.run(`
          INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, latitude, longitude, created_at)
          VALUES (?, ?, 'in', 'customer', 'location', ?, ?, ?, UTC_TIMESTAMP(3))
        `, [tenantId, customerPhone, replyText, message.location.latitude, message.location.longitude]);
        break;

      case "reaction":
        await db.run(
          "UPDATE messages SET customer_reaction = ? WHERE wa_message_id = ? AND tenant_id = ?",
          [message.reaction.emoji || null, message.reaction.message_id, tenantId]
        );
        return; // Don't trigger AI

      case "edit":
        await db.run(
          "UPDATE messages SET body = ? WHERE wa_message_id = ? AND tenant_id = ?",
          [message.edit.body, message.edit.message_id, tenantId]
        );
        return; // Don't trigger AI

      case "revoke":
        await db.run(
          "UPDATE messages SET body = '[Message deleted by customer]', is_deleted = 1 WHERE wa_message_id = ? AND tenant_id = ?",
          [message.revoke.original_message_id, tenantId]
        );
        return; // Don't trigger AI

      case "interactive":
        const btnReply = message.interactive.button_reply || message.interactive.list_reply;
        replyText = `Customer selected button: ${btnReply?.title} (ID: ${btnReply?.id})`;
        await db.run(`
          INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, created_at)
          VALUES (?, ?, 'in', 'customer', 'interactive', ?, UTC_TIMESTAMP(3))
        `, [tenantId, customerPhone, replyText]);
        break;

      default:
        replyText = `[Unsupported message type: ${msgType}]`;
    }

    // Save text/interactive messages to DB (Media was already saved in the switch)
    if (msgType === "text" || msgType === "interactive" || msgType === "location") {
      await db.run(`
        INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, created_at)
        VALUES (?, ?, 'in', 'customer', ?, ?, UTC_TIMESTAMP(3))
      `, [tenantId, customerPhone, msgType, replyText]);
    }

    // Update Conversation preview
    await db.run(`
      INSERT INTO conversations (tenant_id, phone, last_message_at, last_message_preview, created_at)
      VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE last_message_at = UTC_TIMESTAMP(3), last_message_preview = VALUES(last_message_preview), unread_count = unread_count + 1
    `, [tenantId, customerPhone, replyText || `[${msgType}]`]);

    // Generate AI Reply (Passing the attachments array!)
    const aiReply = await generateReply(tenantId, customerPhone, replyText, attachments);

    // Send Reply via Meta
    const accessToken = cryptoHelper.decryptString(connection.access_token_enc);
    const sendRes = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: "whatsapp", to: customerPhone, type: "text", text: { body: aiReply } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const waMessageId = sendRes.data.messages?.[0]?.id || null;

    // Save AI reply to DB
    await db.run(`
      INSERT INTO messages (tenant_id, phone, direction, sender_type, body, wa_message_id, delivery_status, created_at)
      VALUES (?, ?, 'out', 'bot', ?, ?, 'sent', UTC_TIMESTAMP(3))
    `, [tenantId, customerPhone, aiReply, waMessageId]);

    // Update Conversation preview with AI reply
    await db.run(`
      UPDATE conversations 
      SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ? 
      WHERE tenant_id = ? AND phone = ?
    `, [aiReply, tenantId, customerPhone]);

  } catch (err) {
    console.error("[Webhook] Error processing message:", err.message);
  }
});

module.exports = router;