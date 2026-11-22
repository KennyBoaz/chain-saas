const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const cryptoHelper = require("../crypto.js");
const { downloadAndSaveMedia } = require("../media.js");
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

    // Handle Delivery Statuses (outbound ticks)
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
    let mediaUrl = null;
    let mediaMime = null;

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
        mediaMime = mediaObj.mime_type || (msgType === "image" ? "image/jpeg" : "application/octet-stream");
        mediaUrl = await downloadAndSaveMedia(tenantId, mediaObj.id, mediaMime);
        
        // If it's an image, save the caption as the prompt. Otherwise, use a placeholder.
        replyText = mediaObj.caption || `[${msgType.toUpperCase()} RECEIVED]`;
        
        await db.run(`
          INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, has_media, media_mime, media_name, created_at)
          VALUES (?, ?, 'in', 'customer', ?, ?, 1, ?, ?, UTC_TIMESTAMP(3))
        `, [tenantId, customerPhone, msgType, replyText, mediaMime, mediaUrl]);

        await db.run(`
          INSERT INTO conversations (tenant_id, phone, last_message_at, last_message_preview, created_at)
          VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE last_message_at = UTC_TIMESTAMP(3), last_message_preview = VALUES(last_message_preview), unread_count = unread_count + 1
        `, [tenantId, customerPhone, replyText]);

        // If the user sent a caption, we pass it to the AI. If they just sent an image, we say "Thanks for the image"
        // In the future, pass the URL to a Vision model (e.g., gemini-pro-vision).
        replyText = mediaObj.caption ? `Customer sent an image with caption: "${mediaObj.caption}"` : "Customer sent an attachment.";
        break;

      case "location":
        replyText = `Customer shared location: https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`;
        await db.run(`
          INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, latitude, longitude, created_at)
          VALUES (?, ?, 'in', 'customer', 'location', ?, ?, ?, UTC_TIMESTAMP(3))
        `, [tenantId, customerPhone, replyText, message.location.latitude, message.location.longitude]);
        break;

      case "reaction":
        // Store reaction on the target message
        const targetWaId = message.reaction.message_id;
        await db.run(
          "UPDATE messages SET customer_reaction = ? WHERE wa_message_id = ? AND tenant_id = ?",
          [message.reaction.emoji || null, targetWaId, tenantId]
        );
        return; // Don't trigger an AI reply for a reaction

      case "edit":
        // Customer edited their message
        const editedText = message.edit.body;
        await db.run(
          "UPDATE messages SET body = ? WHERE wa_message_id = ? AND tenant_id = ?",
          [editedText, message.edit.message_id, tenantId]
        );
        return; // Don't trigger an AI reply

      case "revoke":
        // Customer deleted their message
        await db.run(
          "UPDATE messages SET body = '[Message deleted by customer]', is_deleted = 1 WHERE wa_message_id = ? AND tenant_id = ?",
          [message.revoke.original_message_id, tenantId]
        );
        return;

      case "interactive":
        // Customer tapped a button
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

    // If it wasn't a media/interactive message, save the text normally
    if (msgType === "text" || msgType === "interactive") {
      await db.run(`
        INSERT INTO messages (tenant_id, phone, direction, sender_type, msg_type, body, created_at)
        VALUES (?, ?, 'in', 'customer', ?, ?, UTC_TIMESTAMP(3))
      `, [tenantId, customerPhone, msgType, replyText]);

      await db.run(`
        INSERT INTO conversations (tenant_id, phone, last_message_at, last_message_preview, created_at)
        VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE last_message_at = UTC_TIMESTAMP(3), last_message_preview = VALUES(last_message_preview), unread_count = unread_count + 1
      `, [tenantId, customerPhone, replyText]);
    }

    // Generate AI Reply
    const aiReply = await generateReply(tenantId, customerPhone, replyText);

    // Send Reply via Meta
    const accessToken = cryptoHelper.decryptString(connection.access_token_enc);
    const sendRes = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: "whatsapp", to: customerPhone, type: "text", text: { body: aiReply } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const waMessageId = sendRes.data.messages?.[0]?.id || null;

    // Save AI reply
    await db.run(`
      INSERT INTO messages (tenant_id, phone, direction, sender_type, body, wa_message_id, delivery_status, created_at)
      VALUES (?, ?, 'out', 'bot', ?, ?, 'sent', UTC_TIMESTAMP(3))
    `, [tenantId, customerPhone, aiReply, waMessageId]);

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