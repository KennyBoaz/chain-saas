/**
 * conversations.js  (multi-tenant)
 *
 * The business rules of working a chat from the dashboard. routes/chats.js stays thin and calls
 * these. EVERY function takes tenantId first and EVERY query is filtered by it.
 *
 * About the 24-hour window: WhatsApp only allows free-form messages within 24 hours of the
 * customer's LAST message. After that only approved templates are allowed.
 */

const fs = require("fs");
const db = require("./db.js");
const memory = require("./memory.js");
const chatStore = require("./chatStore.js");
const wa = require("./whatsapp.js");
const mediaStore = require("./mediaStore.js");
const { HttpError } = require("./apiUtil.js");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_STAFF_TEXT = 4000;
const ALLOWED_REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F64F}", "\u{1F60A}", "\u{1F602}", "\u{1F62E}", "\u{1F622}"];

const MESSAGE_COLUMNS = `m.id, m.phone, m.direction, m.sender_type, m.staff_id, su.name AS staff_name,
  m.msg_type, m.body, m.delivery_status, m.error_text, m.created_at, m.wa_message_id, m.reply_to_wa_id,
  m.starred, m.reaction, m.customer_reaction, m.has_media, m.media_mime, m.media_name, m.media_size,
  m.is_deleted, m.latitude, m.longitude,
  q.body AS quoted_body, q.direction AS quoted_direction, q.sender_type AS quoted_sender`;

const MESSAGE_FROM = `FROM messages m
  LEFT JOIN users su ON su.id = m.staff_id AND su.tenant_id = m.tenant_id
  LEFT JOIN messages q ON q.tenant_id = m.tenant_id AND q.wa_message_id = m.reply_to_wa_id`;

const placeholders = (list) => list.map(() => "?").join(",");

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** { open, expires_at, seconds_left } for the customer's last message time. */
function windowInfo(lastCustomerMessageAt, now = new Date()) {
  const last = toDate(lastCustomerMessageAt);
  if (!last) return { open: false, expires_at: null, seconds_left: 0 };
  const expires = new Date(last.getTime() + WINDOW_MS);
  const secondsLeft = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000));
  return { open: secondsLeft > 0, expires_at: expires.toISOString(), seconds_left: secondsLeft };
}

async function requireConversation(tenantId, phone) {
  const conversation = await chatStore.getConversation(tenantId, phone);
  if (!conversation) throw new HttpError(404, "Chat not found.", "NOT_FOUND");
  return conversation;
}

async function requireConnection(tenantId) {
  const conn = await wa.loadConnection(tenantId);
  if (!conn) throw new HttpError(409, "WhatsApp is not connected. Connect it from the Dashboard first.", "NO_WHATSAPP");
  return conn;
}

async function requireMessage(tenantId, messageId) {
  const message = await db.one("SELECT * FROM messages WHERE id = ? AND tenant_id = ?", [messageId, tenantId]);
  if (!message) throw new HttpError(404, "Message not found.", "NOT_FOUND");
  return message;
}

// ---------------------------------------------------------------------------
// Reading messages
// ---------------------------------------------------------------------------

/** no options: latest `limit` | before: older messages | after: only NEWER messages (polling) */
async function listMessages(tenantId, phone, { after = null, before = null, limit = 50 } = {}) {
  const where = ["m.tenant_id = ?", "m.phone = ?"];
  const params = [tenantId, phone];
  if (after) { where.push("m.id > ?"); params.push(after); }
  if (before) { where.push("m.id < ?"); params.push(before); }
  params.push(limit);

  const rows = await db.all(
    `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
      WHERE ${where.join(" AND ")}
      ORDER BY m.id ${after ? "ASC" : "DESC"}
      LIMIT ?`,
    params
  );
  return after ? rows : rows.reverse();
}

async function getMessagesByIds(tenantId, ids) {
  if (!ids || ids.length === 0) return [];
  return db.all(
    `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
      WHERE m.tenant_id = ? AND m.id IN (${placeholders(ids)})
      ORDER BY m.id ASC`,
    [tenantId, ...ids]
  );
}

async function markRead(tenantId, phone) {
  await db.run("UPDATE conversations SET unread_count = 0 WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
}

// ---------------------------------------------------------------------------
// Staff replies
// ---------------------------------------------------------------------------

/**
 * Send a reply on behalf of a staff member. The message is saved even if WhatsApp refuses it
 * (status "failed") so staff can see it and retry. Returns { delivered, messages, error }.
 */
async function sendStaffMessage(tenantId, { phone, text, staffId, replyTo }) {
  const body = String(text ?? "").trim();
  if (!body) throw new HttpError(400, "Type a message first.", "EMPTY");
  if (body.length > MAX_STAFF_TEXT) throw new HttpError(400, `Message is too long (max ${MAX_STAFF_TEXT} characters).`, "TOO_LONG");

  const conversation = await requireConversation(tenantId, phone);
  if (!windowInfo(conversation.last_customer_message_at).open) {
    throw new HttpError(409, "The 24-hour WhatsApp reply window has closed. Send an approved template instead.", "WINDOW_CLOSED");
  }
  const conn = await requireConnection(tenantId);

  let replyWaId = null;
  if (replyTo) {
    const quoted = await db.one("SELECT wa_message_id FROM messages WHERE id = ? AND tenant_id = ? AND phone = ?", [replyTo, tenantId, phone]);
    replyWaId = (quoted && quoted.wa_message_id) || null;
  }

  let results;
  try {
    results = await wa.sendText(conn, phone, body, { replyTo: replyWaId });
  } catch (err) {
    results = [{ text: body, id: null, ok: false, error: err.message }];
  }

  const ids = [];
  for (const r of results) {
    ids.push(await chatStore.recordOutgoing(tenantId, {
      phone, body: r.text, senderType: "staff", staffId, replyToWaId: replyWaId,
      waMessageId: r.id, status: r.ok ? "sent" : "failed", error: r.error,
    }));
  }

  // A staff reply means a human is handling this chat: pause the bot, assign it, clear unread, reopen.
  await db.run("UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND phone = ? AND mode = 'bot'", [tenantId, phone]);
  await db.run("UPDATE conversations SET assigned_to = ?, unread_count = 0 WHERE tenant_id = ? AND phone = ?", [staffId, tenantId, phone]);
  await db.run("UPDATE conversations SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE tenant_id = ? AND phone = ? AND status = 'resolved'", [tenantId, phone]);

  const delivered = results.length > 0 && results.every((r) => r.ok);
  const failure = results.find((r) => !r.ok);
  return { delivered, messages: await getMessagesByIds(tenantId, ids), error: delivered ? null : (failure && failure.error) || "WhatsApp did not accept the message." };
}

async function retryStaffMessage(tenantId, messageId) {
  const message = await db.one("SELECT * FROM messages WHERE id = ? AND tenant_id = ?", [messageId, tenantId]);
  if (!message || message.direction !== "out" || message.sender_type !== "staff") throw new HttpError(404, "Message not found.", "NOT_FOUND");
  if (message.delivery_status !== "failed") throw new HttpError(409, "Only failed messages can be retried.", "NOT_FAILED");

  const conversation = await requireConversation(tenantId, message.phone);
  if (!windowInfo(conversation.last_customer_message_at).open) {
    throw new HttpError(409, "The 24-hour WhatsApp reply window has closed, so this message can no longer be sent.", "WINDOW_CLOSED");
  }
  const conn = await requireConnection(tenantId);

  let results;
  try {
    results = await wa.sendText(conn, message.phone, message.body, { replyTo: message.reply_to_wa_id || null });
  } catch (err) {
    results = [{ text: message.body, id: null, ok: false, error: err.message }];
  }
  const delivered = results.length > 0 && results.every((r) => r.ok);
  const first = results[0] || {};

  await db.run(
    "UPDATE messages SET wa_message_id = ?, delivery_status = ?, error_text = ? WHERE id = ? AND tenant_id = ?",
    [first.id || null, delivered ? "sent" : "failed", delivered ? null : String(first.error || "send failed").slice(0, 500), messageId, tenantId]
  );
  const [updated] = await getMessagesByIds(tenantId, [messageId]);
  return { delivered, message: updated, error: delivered ? null : first.error || "WhatsApp did not accept the message." };
}

// ---------------------------------------------------------------------------
// Bot <-> human handover
// ---------------------------------------------------------------------------

const historyTurn = (role, text) => ({ role, content: text, parts: [{ text }], timestamp: new Date().toISOString() });

/** While a chat is in human mode the bot sees nothing. On hand-back, give it a short transcript of what it missed. */
async function addHandoverNote(tenantId, phone) {
  const rows = (await db.all(
    `SELECT m.sender_type, m.body, su.name AS staff_name
       FROM messages m
       LEFT JOIN users su ON su.id = m.staff_id AND su.tenant_id = m.tenant_id
      WHERE m.tenant_id = ? AND m.phone = ?
        AND m.id > (SELECT COALESCE(MAX(b.id), 0) FROM messages b WHERE b.tenant_id = ? AND b.phone = ? AND b.sender_type = 'bot')
        AND (m.delivery_status IS NULL OR m.delivery_status <> 'failed')
      ORDER BY m.id DESC LIMIT 60`,
    [tenantId, phone, tenantId, phone]
  )).reverse();

  const lines = rows.filter((r) => r.body).map((r) => {
    const text = String(r.body).replace(/\s+/g, " ").slice(0, 500);
    if (r.sender_type === "customer") return `Customer: ${text}`;
    if (r.sender_type === "staff") return `Team member (${r.staff_name || "staff"}): ${text}`;
    return `Assistant: ${text}`;
  });
  if (lines.length === 0) return false;

  const note = [
    "[Internal note, not from the customer: a human team member handled this chat for a while and the assistant was paused. This is what was said in that time:]",
    ...lines,
    "[End of note. Carry on from here and do not repeat what the team member already told the customer.]",
  ].join("\n").slice(0, 6000);

  const history = await memory.getHistory(tenantId, phone);
  const last = history[history.length - 1];
  if (last && last.role !== "model") history.push(historyTurn("model", "(no reply was sent)"));
  history.push(historyTurn("user", note));
  history.push(historyTurn("model", "Understood. I'll continue from here without repeating what the team already said."));
  await memory.saveHistory(tenantId, phone, history);
  return true;
}

async function takeOver(tenantId, phone, staffId) {
  const conversation = await requireConversation(tenantId, phone);
  if (conversation.mode === "bot") {
    await db.run("UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND phone = ? AND mode = 'bot'", [tenantId, phone]);
  }
  await db.run("UPDATE conversations SET assigned_to = ? WHERE tenant_id = ? AND phone = ?", [staffId, tenantId, phone]);
}

async function handBack(tenantId, phone) {
  const conversation = await requireConversation(tenantId, phone);
  if (conversation.mode !== "human") return { changed: false };
  await addHandoverNote(tenantId, phone);
  await db.run("UPDATE conversations SET mode = 'bot', human_since = NULL WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Resolve / reopen
// ---------------------------------------------------------------------------

async function resolve(tenantId, phone, staffId, note) {
  await requireConversation(tenantId, phone);
  await handBack(tenantId, phone);

  await db.run(
    `UPDATE conversations SET status = 'resolved', resolved_by = ?, resolved_at = UTC_TIMESTAMP(3), unread_count = 0
      WHERE tenant_id = ? AND phone = ?`,
    [staffId, tenantId, phone]
  );
  const closed = await db.run(
    `UPDATE issues SET status = 'resolved', resolved_by = ?, resolved_at = UTC_TIMESTAMP(3),
            resolution_note = COALESCE(?, resolution_note), updated_at = UTC_TIMESTAMP(3)
      WHERE tenant_id = ? AND phone = ? AND type = 'escalation' AND status <> 'resolved'`,
    [staffId, note || null, tenantId, phone]
  );
  const open = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE tenant_id = ? AND phone = ? AND status IN ('new','in_progress')) AS orders,
       (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND phone = ? AND status IN ('new','in_progress')) AS appointments,
       (SELECT COUNT(*) FROM issues WHERE tenant_id = ? AND phone = ? AND status IN ('new','in_progress')) AS issues`,
    [tenantId, phone, tenantId, phone, tenantId, phone]
  );
  return {
    resolved_escalations: Number(closed && closed.affectedRows) || 0,
    still_open: { orders: Number(open.orders) || 0, appointments: Number(open.appointments) || 0, issues: Number(open.issues) || 0 },
  };
}

async function reopen(tenantId, phone) {
  await requireConversation(tenantId, phone);
  await db.run("UPDATE conversations SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE tenant_id = ? AND phone = ? AND status = 'resolved'", [tenantId, phone]);
}

// ---------------------------------------------------------------------------
// Message and chat menu actions
// ---------------------------------------------------------------------------

/** Send (or remove, with emoji "") our emoji reaction on a CUSTOMER's message. */
async function reactToMessage(tenantId, { messageId, emoji }) {
  const message = await requireMessage(tenantId, messageId);
  if (message.direction !== "in" || !message.wa_message_id) throw new HttpError(400, "You can only react to a customer's message.", "BAD_TARGET");
  if (emoji !== "" && !ALLOWED_REACTIONS.includes(emoji)) throw new HttpError(400, "That reaction is not available.", "BAD_EMOJI");

  const conversation = await requireConversation(tenantId, message.phone);
  if (!windowInfo(conversation.last_customer_message_at).open) throw new HttpError(409, "The 24-hour WhatsApp reply window has closed.", "WINDOW_CLOSED");
  const conn = await requireConnection(tenantId);

  let result;
  try {
    result = await wa.sendReaction(conn, message.phone, message.wa_message_id, emoji);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result.ok) throw new HttpError(502, `WhatsApp did not accept the reaction: ${result.error}`, "SEND_FAILED");

  await db.run("UPDATE messages SET reaction = ? WHERE id = ? AND tenant_id = ?", [emoji || null, messageId, tenantId]);
  return (await getMessagesByIds(tenantId, [messageId]))[0];
}

/** Forward a message WE sent (staff or bot) into another customer's chat. */
async function forwardMessage(tenantId, { messageId, toPhone, staffId }) {
  const message = await requireMessage(tenantId, messageId);
  if (message.direction !== "out") throw new HttpError(403, "Only messages we sent can be forwarded. A customer's messages stay in their own chat.", "FORWARD_NOT_ALLOWED");
  if (toPhone === message.phone) throw new HttpError(400, "Choose a different chat.", "SAME_CHAT");
  return sendStaffMessage(tenantId, { phone: toPhone, text: message.body, staffId });
}

async function setStarred(tenantId, messageId, starred) {
  await requireMessage(tenantId, messageId);
  await db.run("UPDATE messages SET starred = ? WHERE id = ? AND tenant_id = ?", [starred ? 1 : 0, messageId, tenantId]);
  return (await getMessagesByIds(tenantId, [messageId]))[0];
}

/** Append a message's text to the customer's private notes. */
async function saveMessageToNotes(tenantId, messageId) {
  const message = await requireMessage(tenantId, messageId);
  const customer = await db.one("SELECT notes FROM customers WHERE tenant_id = ? AND phone = ?", [tenantId, message.phone]);
  const line = "- " + String(message.body || "").replace(/\s+/g, " ").slice(0, 400);
  const next = ((customer && customer.notes) ? customer.notes + "\n" : "") + line;
  if (next.length > 5000) throw new HttpError(400, "This customer's notes are full. Tidy them up first.", "NOTES_FULL");
  await db.run("UPDATE customers SET notes = ? WHERE tenant_id = ? AND phone = ?", [next, tenantId, message.phone]);
  return next;
}

async function setPinned(tenantId, phone, pinned) {
  await requireConversation(tenantId, phone);
  await db.run("UPDATE conversations SET pinned = ? WHERE tenant_id = ? AND phone = ?", [pinned ? 1 : 0, tenantId, phone]);
}

async function markUnread(tenantId, phone) {
  await requireConversation(tenantId, phone);
  await db.run("UPDATE conversations SET unread_count = 1 WHERE tenant_id = ? AND phone = ? AND unread_count = 0", [tenantId, phone]);
}

async function assignChat(tenantId, phone, staffId) {
  await requireConversation(tenantId, phone);
  if (staffId !== null) {
    const person = await db.one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND active = 1", [staffId, tenantId]);
    if (!person) throw new HttpError(400, "That staff member is not available.", "BAD_STAFF");
  }
  await db.run("UPDATE conversations SET assigned_to = ? WHERE tenant_id = ? AND phone = ?", [staffId, tenantId, phone]);
}

/** The bot forgets this customer (starts fresh). Messages and records stay. */
async function resetBotMemory(tenantId, phone) {
  await requireConversation(tenantId, phone);
  await db.run("DELETE FROM bot_history WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
}

/** The whole conversation as plain text. */
async function exportText(tenantId, phone) {
  await requireConversation(tenantId, phone);
  const customer = await db.one("SELECT whatsapp_name, display_name FROM customers WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  const tenant = await db.one("SELECT business_name FROM tenants WHERE id = ?", [tenantId]);
  const rows = await db.all(
    `SELECT m.sender_type, m.body, m.created_at, su.name AS staff_name
       FROM messages m LEFT JOIN users su ON su.id = m.staff_id AND su.tenant_id = m.tenant_id
      WHERE m.tenant_id = ? AND m.phone = ? ORDER BY m.id ASC LIMIT 5000`,
    [tenantId, phone]
  );
  const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kampala", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const name = (customer && (customer.display_name || customer.whatsapp_name)) || phone;
  const shop = (tenant && tenant.business_name) || "Business";
  const lines = rows.map((r) => {
    const who = r.sender_type === "customer" ? name : r.sender_type === "staff" ? `${r.staff_name || "Team"} (team)` : `${shop} bot`;
    const when = toDate(r.created_at);
    return `[${when ? stamp.format(when) : "?"}] ${who}: ${r.body || ""}`;
  });
  return { filename: `chat-${phone}.txt`, text: `WhatsApp conversation with ${name} (+${phone})\nExported ${stamp.format(new Date())} (Africa/Kampala)\n\n${lines.join("\n")}\n` };
}

/**
 * Permanently erase a chat (tenant admin only): messages, files, the bot's memory, the conversation
 * and the customer's record. With alsoRecords, their orders, appointments and tickets go too.
 */
async function deleteConversation(tenantId, phone, alsoRecords) {
  await requireConversation(tenantId, phone);

  const withFiles = await db.all("SELECT id FROM messages WHERE tenant_id = ? AND phone = ? AND has_media = 1", [tenantId, phone]);
  for (const row of withFiles) {
    try { await fs.promises.unlink(mediaStore.pathFor(tenantId, row.id)); } catch { /* already gone */ }
  }

  await db.run("DELETE FROM bot_history WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  if (alsoRecords) {
    await db.run("DELETE FROM orders WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
    await db.run("DELETE FROM appointments WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
    await db.run("DELETE FROM issues WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  }
  await db.run("DELETE FROM messages WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  await db.run("DELETE FROM conversations WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  await db.run("DELETE FROM customers WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
}

module.exports = {
  WINDOW_MS, ALLOWED_REACTIONS, windowInfo, requireConversation, requireConnection,
  listMessages, getMessagesByIds, markRead, sendStaffMessage, retryStaffMessage,
  takeOver, handBack, resolve, reopen,
  reactToMessage, forwardMessage, setStarred, saveMessageToNotes, setPinned, markUnread,
  assignChat, resetBotMemory, exportText, deleteConversation,
};