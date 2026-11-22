/**
 * chatStore.js  (multi-tenant)
 *
 * Everything the app writes about a CHAT. Every function takes tenantId FIRST and every query
 * is filtered by it, so one tenant can never read or change another tenant's chats.
 */

const db = require("./db.js");

const PREVIEW_LENGTH = 200;
const STATUS_ORDER = ["pending", "sent", "delivered", "read", "failed"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makePreview(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH - 1)}…` : clean;
}

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** WhatsApp sends unix seconds. This is the moment Meta uses for the 24-hour window. Never in the future. */
function fromWhatsAppTimestamp(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  const date = new Date(seconds * 1000);
  return date.getTime() > Date.now() ? new Date() : date;
}

async function ensureCustomer(tenantId, phone, whatsappName) {
  await db.run(
    `INSERT INTO customers (tenant_id, phone, whatsapp_name, created_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE whatsapp_name = COALESCE(VALUES(whatsapp_name), whatsapp_name)`,
    [tenantId, phone, clip(whatsappName, 150)]
  );
  await db.run(
    `INSERT INTO conversations (tenant_id, phone, created_at)
     VALUES (?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE phone = phone`,
    [tenantId, phone]
  );
}

async function getConversation(tenantId, phone) {
  return db.one("SELECT * FROM conversations WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
}

/**
 * Save a customer's message.
 * Returns { duplicate: true } if this WhatsApp message id is already stored (unique key
 * uq_msg_wa = tenant_id + wa_message_id, so this survives restarts), otherwise
 * { duplicate: false, conversation, messageId }.
 */
async function recordIncoming(tenantId, { id, from, name, type, text, timestamp, replyTo, location }) {
  await ensureCustomer(tenantId, from, name);

  const createdAt = fromWhatsAppTimestamp(timestamp);
  const body = text || "";

  let insert;
  try {
    insert = await db.run(
      `INSERT INTO messages
         (tenant_id, phone, direction, sender_type, msg_type, body, wa_message_id, reply_to_wa_id, latitude, longitude, created_at)
       VALUES (?, ?, 'in', 'customer', ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, from, clip(type, 20) || "text", body, clip(id, 128), clip(replyTo, 128),
        location ? location.latitude : null, location ? location.longitude : null, createdAt,
      ]
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw err;
  }

  await db.run(
    `UPDATE conversations
        SET last_customer_message_at = ?, last_message_at = ?, last_message_preview = ?,
            unread_count = unread_count + 1
      WHERE tenant_id = ? AND phone = ?`,
    [createdAt, createdAt, makePreview(body), tenantId, from]
  );

  // A customer writing again re-opens a chat that had been resolved.
  await db.run(
    `UPDATE conversations SET status = 'open', resolved_at = NULL, resolved_by = NULL
      WHERE tenant_id = ? AND phone = ? AND status = 'resolved'`,
    [tenantId, from]
  );

  return { duplicate: false, conversation: await getConversation(tenantId, from), messageId: insert.insertId };
}

/** Save a text message WE sent. senderType: 'bot' | 'staff'. status: 'sent' | 'failed'. */
async function recordOutgoing(tenantId, { phone, body, senderType = "bot", staffId = null, waMessageId = null, status = "sent", error = null, replyToWaId = null }) {
  await ensureCustomer(tenantId, phone, null);

  const insert = await db.run(
    `INSERT INTO messages
       (tenant_id, phone, direction, sender_type, staff_id, msg_type, body,
        wa_message_id, delivery_status, error_text, reply_to_wa_id, created_at)
     VALUES (?, ?, 'out', ?, ?, 'text', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [tenantId, phone, senderType, staffId, body || "", clip(waMessageId, 128), status, clip(error, 500), clip(replyToWaId, 128)]
  );

  await db.run(
    `UPDATE conversations SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ?
      WHERE tenant_id = ? AND phone = ?`,
    [makePreview(body), tenantId, phone]
  );
  return insert.insertId;
}

/** A photo / video / audio / document a staff member sent from the dashboard. Returns the message id. */
async function recordOutgoingMedia(tenantId, { phone, body, msgType = "document", mime, name, size, staffId = null, waMessageId = null, status = "sent", error = null }) {
  await ensureCustomer(tenantId, phone, null);

  const insert = await db.run(
    `INSERT INTO messages
       (tenant_id, phone, direction, sender_type, staff_id, msg_type, body, wa_message_id,
        delivery_status, error_text, has_media, media_mime, media_name, media_size, created_at)
     VALUES (?, ?, 'out', 'staff', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [tenantId, phone, staffId, clip(msgType, 20) || "document", body || "", clip(waMessageId, 128),
     status, clip(error, 500), clip(mime, 100), clip(name, 255), Number(size) || null]
  );
  await db.run(
    `UPDATE conversations SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ?
      WHERE tenant_id = ? AND phone = ?`,
    [makePreview(body), tenantId, phone]
  );
  return insert.insertId;
}

/**
 * A message the business sent from the WhatsApp Business APP on the phone (a Coexistence
 * "echo"). Saved as a staff message and the chat switches to human mode so the bot stays quiet.
 */
async function recordStaffEcho(tenantId, { phone, body, waMessageId, timestamp, msgType = "text" }) {
  await ensureCustomer(tenantId, phone, null);

  const createdAt = fromWhatsAppTimestamp(timestamp);
  try {
    await db.run(
      `INSERT INTO messages
         (tenant_id, phone, direction, sender_type, msg_type, body, wa_message_id, delivery_status, created_at)
       VALUES (?, ?, 'out', 'staff', ?, ?, ?, 'sent', ?)`,
      [tenantId, phone, clip(msgType, 20) || "text", body || "", clip(waMessageId, 128), createdAt]
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw err;
  }

  await db.run(
    `UPDATE conversations SET last_message_at = ?, last_message_preview = ?
      WHERE tenant_id = ? AND phone = ? AND (last_message_at IS NULL OR last_message_at <= ?)`,
    [createdAt, makePreview(body), tenantId, phone, createdAt]
  );
  await db.run(
    `UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3)
      WHERE tenant_id = ? AND phone = ? AND mode = 'bot'`,
    [tenantId, phone]
  );
  return { duplicate: false };
}

/** A staff member answered from the dashboard: the bot steps back from this chat. */
async function takeOverByStaff(tenantId, phone, staffId) {
  await db.run(
    `UPDATE conversations
        SET mode = 'human', human_since = UTC_TIMESTAMP(3), assigned_to = COALESCE(assigned_to, ?)
      WHERE tenant_id = ? AND phone = ? AND mode = 'bot'`,
    [staffId || null, tenantId, phone]
  );
}

/**
 * Delivery receipt from Meta. Ticks only move forward (a late "delivered" never overwrites
 * "read"). Meta can send the receipt a moment before our insert finishes, so look again a few times.
 */
async function applyStatusUpdate(tenantId, { id, status, errorText }) {
  if (!id || !STATUS_ORDER.includes(status)) return false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const row = await db.one(
      "SELECT id FROM messages WHERE tenant_id = ? AND wa_message_id = ? AND direction = 'out' LIMIT 1",
      [tenantId, id]
    );
    if (row) {
      await db.run(
        `UPDATE messages SET delivery_status = ?, error_text = ?
          WHERE id = ? AND tenant_id = ?
            AND (delivery_status IS NULL
                 OR FIELD(delivery_status, 'pending','sent','delivered','read','failed')
                    < FIELD(?, 'pending','sent','delivered','read','failed'))`,
        [status, status === "failed" ? clip(errorText, 500) : null, row.id, tenantId, status]
      );
      return true;
    }
    await sleep(1000);
  }
  return false;
}

/** Flag a chat as needing a human (optionally pausing the bot). */
async function markEscalated(tenantId, phone, { pauseBot = false } = {}) {
  await ensureCustomer(tenantId, phone, null);

  await db.run(
    `UPDATE conversations SET status = 'escalated', escalated_at = UTC_TIMESTAMP(3)
      WHERE tenant_id = ? AND phone = ? AND status <> 'escalated'`,
    [tenantId, phone]
  );
  if (pauseBot) {
    await db.run(
      `UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3)
        WHERE tenant_id = ? AND phone = ? AND mode = 'bot'`,
      [tenantId, phone]
    );
  }
}

/** Customer reacted with an emoji to one of our messages ("" = removed). */
async function setCustomerReaction(tenantId, waMessageId, emoji) {
  if (!waMessageId) return;
  await db.run("UPDATE messages SET customer_reaction = ? WHERE tenant_id = ? AND wa_message_id = ?", [
    emoji ? clip(emoji, 16) : null, tenantId, waMessageId,
  ]);
}

async function applyEdit(tenantId, waMessageId, body) {
  if (!waMessageId) return;
  await db.run("UPDATE messages SET body = ? WHERE tenant_id = ? AND wa_message_id = ?", [body || "", tenantId, waMessageId]);
}

async function applyRevoke(tenantId, waMessageId) {
  if (!waMessageId) return;
  await db.run(
    "UPDATE messages SET body = '[Message deleted by customer]', is_deleted = 1 WHERE tenant_id = ? AND wa_message_id = ?",
    [tenantId, waMessageId]
  );
}

module.exports = {
  makePreview,
  ensureCustomer,
  getConversation,
  recordIncoming,
  recordOutgoing,
  recordOutgoingMedia,
  recordStaffEcho,
  takeOverByStaff,
  applyStatusUpdate,
  markEscalated,
  setCustomerReaction,
  applyEdit,
  applyRevoke,
};