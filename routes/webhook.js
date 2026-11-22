/**
 * routes/webhook.js  (multi-tenant)
 *
 * Meta's webhook for ALL tenants. Each change carries metadata.phone_number_id, which is looked up
 * in whatsapp_connection to find the tenant, its decrypted token and its settings.
 *
 * What this adds compared with the first version:
 *  - EVERY message in a request is handled (not only the first), per-phone queue so replies stay in order
 *  - duplicate protection (memory + database unique key)
 *  - HUMAN MODE: when staff took over, the customer's message is saved but the bot stays silent
 *  - if staff take over while Gemini is thinking, the bot's reply is discarded
 *  - the customer's messages get wa_message_id, last_customer_message_at, reply context, location, media
 *  - Gemini has per-customer memory; a timeout or failure sends a fallback reply, flags the chat as
 *    escalated and alerts the team
 *  - read receipts + typing indicator, delivery ticks, reactions, edits, deletes
 *  - coexistence events (history / staff replies from the phone) are stored per tenant
 *
 * Mounted at /webhook in server.js (replace the old router).
 */

const express = require("express");
const db = require("../db.js");
const cryptoHelper = require("../crypto.js");
const wa = require("../whatsapp.js");
const chatStore = require("../chatStore.js");
const memory = require("../memory.js");
const mediaStore = require("../mediaStore.js");
const { generateReply } = require("../gemini.js");
const { notifyTeam } = require("../alerts.js");
const { parseJson } = require("../jsonSafe.js");

const router = express.Router();

const TRACE = String(process.env.BOT_TRACE || "true").toLowerCase() !== "false";
const trace = (id, step) => { if (TRACE) console.error(`[trace] ${new Date().toISOString()} ...${String(id).slice(-8)} ${step}`); };

const GEMINI_STEP_TIMEOUT_MS = Number(process.env.GEMINI_STEP_TIMEOUT_MS) || 90000;
const FALLBACK_REPLY = "Sorry, we're having a technical problem right now. A member of our team will get back to you shortly.";

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Verification + receiving
// ---------------------------------------------------------------------------

router.get("/", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

router.post("/", (req, res) => {
  res.sendStatus(200); // acknowledge Meta immediately, work in the background
  processWebhook(req.body).catch((err) => console.error("[webhook] Uncaught error:", err));
});

// ---------------------------------------------------------------------------
// Tenant lookup (cached for a minute)
// ---------------------------------------------------------------------------

const tenantCache = new Map();

/** { tenantId, tenant, profile, conn } for a phone_number_id, or null if no tenant owns it. */
async function resolveTenant(phoneNumberId) {
  if (!phoneNumberId) return null;
  const cached = tenantCache.get(phoneNumberId);
  if (cached && Date.now() - cached.at < 60000) return cached.ctx;

  const row = await db.one(
    `SELECT t.*, wc.waba_id AS wc_waba_id, wc.phone_number_id AS wc_phone_number_id, wc.access_token_enc AS wc_token
       FROM whatsapp_connection wc JOIN tenants t ON t.id = wc.tenant_id
      WHERE wc.phone_number_id = ?`,
    [phoneNumberId]
  );
  if (!row) return null;

  let token;
  try {
    token = cryptoHelper.decryptString(row.wc_token);
  } catch (err) {
    console.error(`[webhook] Could not decrypt the token for tenant ${row.id}:`, err.message);
    return null;
  }
  const ctx = {
    tenantId: row.id,
    tenant: row,
    profile: parseJson(row.business_profile_json),
    conn: { tenantId: row.id, token, phoneNumberId: row.wc_phone_number_id, wabaId: row.wc_waba_id },
  };
  tenantCache.set(phoneNumberId, { at: Date.now(), ctx });
  return ctx;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

const processed = new Set();
function alreadyProcessed(key) {
  if (processed.has(key)) return true;
  processed.add(key);
  if (processed.size > 4000) processed.delete(processed.values().next().value);
  return false;
}

const queues = new Map();
function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

async function processWebhook(body) {
  const parsed = wa.parseWebhook(body);

  // Coexistence events: store raw (history arrives only once), handle staff echoes from the phone.
  for (const ev of parsed.coex) {
    try {
      const ctx = await resolveTenant(ev.phoneNumberId);
      await db.run("INSERT INTO wa_raw_events (tenant_id, field, payload, received_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))", [
        ctx ? ctx.tenantId : null, ev.field, JSON.stringify(ev.value || {}),
      ]);
      if (ctx && ev.field === "smb_message_echoes") await handleEchoes(ctx, ev.value);
    } catch (err) {
      console.error("[coex] Could not handle an event:", err.message);
    }
  }

  // Delivery receipts
  for (const s of parsed.statuses) {
    resolveTenant(s.phoneNumberId)
      .then((ctx) => (ctx ? chatStore.applyStatusUpdate(ctx.tenantId, s) : null))
      .catch((err) => console.error("[db] Could not save a delivery receipt:", err.message));
  }

  // Customer messages
  for (const message of parsed.messages) {
    const ctx = await resolveTenant(message.phoneNumberId).catch(() => null);
    if (!ctx) {
      console.warn(`[webhook] Message for unknown phone_number_id ${message.phoneNumberId}; ignored.`);
      continue;
    }
    enqueue(`${ctx.tenantId}:${message.from}`, () =>
      handleIncomingMessage(ctx, message).catch((err) => console.error(`[webhook] Error handling message ${message.id}:`, err))
    );
  }
}

async function handleEchoes(ctx, value) {
  for (const echo of (value && value.message_echoes) || []) {
    const phone = String(echo.to || "").replace(/\D/g, "");
    if (!phone || !echo.id) continue;
    let body = "";
    if (echo.type === "text") body = (echo.text && echo.text.body) || "";
    else {
      const caption = echo[echo.type] && echo[echo.type].caption;
      body = `[Sent from the Business app: ${echo.type}${caption ? " - " + caption : ""}]`;
    }
    const saved = await chatStore.recordStaffEcho(ctx.tenantId, { phone, body, waMessageId: echo.id, timestamp: echo.timestamp, msgType: echo.type });
    if (!saved.duplicate) trace(echo.id, `tenant ${ctx.tenantId}: staff replied from the phone to ${phone} - chat is now in human mode`);
  }
}

/** Send a bot/staff text and save every part (with its WhatsApp id and whether Meta accepted it). */
async function sendAndRecord(ctx, to, body, senderType = "bot") {
  let results;
  try {
    results = await wa.sendText(ctx.conn, to, body);
  } catch (err) {
    console.error(`[whatsapp] Could not send to ${to}:`, err.message);
    results = [{ text: body, id: null, ok: false, error: err.message }];
  }
  for (const r of results) {
    try {
      await chatStore.recordOutgoing(ctx.tenantId, { phone: to, body: r.text, senderType, waMessageId: r.id, status: r.ok ? "sent" : "failed", error: r.error });
    } catch (err) {
      console.error("[db] Could not save the outgoing message:", err.message);
    }
  }
  return results.length > 0 && results.every((r) => r.ok);
}

async function handleIncomingMessage(ctx, message) {
  const { id, from, name, type, text } = message;
  const { tenantId } = ctx;
  const receivedAt = Date.now();

  if (alreadyProcessed(`${tenantId}:${id}`)) return;

  // Things that are not new messages
  if (type === "reaction") {
    if (message.reaction && message.reaction.messageId) await chatStore.setCustomerReaction(tenantId, message.reaction.messageId, message.reaction.emoji);
    return;
  }
  if (type === "edit" && message.edit) { await chatStore.applyEdit(tenantId, message.edit.messageId, message.edit.body); return; }
  if (type === "revoke" && message.revoke) { await chatStore.applyRevoke(tenantId, message.revoke.messageId); return; }

  console.log(`[webhook] tenant ${tenantId}: ${from} (${name || "unknown"}) sent ${type}: ${text || "(empty)"}`);
  trace(id, `1 tenant ${tenantId} message from ${from}`);

  // Save first: tells us about duplicates and whether staff have taken over.
  let conversation = null;
  let savedMessageId = null;
  try {
    const saved = await chatStore.recordIncoming(tenantId, message);
    if (saved.duplicate) { trace(id, "duplicate - skipped"); return; }
    conversation = saved.conversation;
    savedMessageId = saved.messageId || null;
  } catch (err) {
    console.error("[db] Could not save the incoming message. Stopping here:", err.message);
    return;
  }
  trace(id, `2 saved (chat mode: ${conversation ? conversation.mode : "?"})`);

  // Photo / voice note / document: keep it, and show photos/PDFs to Gemini for this reply only.
  let attachments = [];
  if (message.media && savedMessageId) {
    try {
      const kept = await mediaStore.attach(tenantId, ctx.conn, savedMessageId, from, message.media);
      if (kept && mediaStore.canShowToAi(kept)) attachments = [{ mimeType: kept.mime, data: kept.buffer.toString("base64") }];
    } catch (err) {
      console.error("[media] Could not save the customer's file:", err.message);
    }
  }

  // The bot only answers for active tenants (suspended / read-only / cancelled keep their messages).
  if (ctx.tenant.status !== "active") { trace(id, `tenant status is ${ctx.tenant.status} - bot silent`); return; }

  // HUMAN MODE: staff are handling this customer.
  if (conversation && conversation.mode === "human") { trace(id, "HUMAN mode - bot stays silent on purpose"); return; }

  wa.markReadAndTyping(ctx.conn, id);

  if (!text) {
    await sendAndRecord(ctx, from, "I can read text messages on WhatsApp. Please type your question and I will help.");
    return;
  }

  let history = [];
  try {
    history = await memory.getHistory(tenantId, from);
  } catch (err) {
    console.error("[db] Could not load the chat history. Answering without it:", err.message);
  }
  trace(id, `3 history loaded (${history.length} turns), asking Gemini...`);

  const geminiStartedAt = Date.now();
  let result;
  try {
    result = await withTimeout(
      generateReply({ tenant: ctx.tenant, profile: ctx.profile, userMessage: text, history, phone: from, customerName: name, attachments }),
      GEMINI_STEP_TIMEOUT_MS,
      "Gemini step"
    );
  } catch (err) {
    console.error(`[bot] Gemini step failed: ${err.message}`);
    trace(id, `4x Gemini FAILED (${err.message}) - fallback reply`);
    await sendAndRecord(ctx, from, FALLBACK_REPLY, "bot");
    await chatStore.markEscalated(tenantId, from).catch((e) => console.error("[db] Could not flag the chat:", e.message));
    notifyTeam(tenantId, { type: "escalation", phone: from, name, title: "The bot could not answer a customer", text: err.message }).catch(() => {});
    return;
  }
  const { reply, updatedHistory } = result;
  trace(id, `5 Gemini answered in ${Date.now() - geminiStartedAt}ms`);

  // Did a staff member take over while Gemini was thinking? Then do not talk over them.
  try {
    const latest = await chatStore.getConversation(tenantId, from);
    if (latest && latest.mode === "human") { trace(id, "staff took over meanwhile - bot reply discarded"); return; }
  } catch { /* carry on */ }

  await memory.saveHistory(tenantId, from, updatedHistory).catch((err) => console.error("[db] Could not save the chat history:", err.message));

  const delivered = await sendAndRecord(ctx, from, reply, "bot");
  trace(id, `6 finished: ${delivered ? "accepted by Meta" : "NOT delivered"} (total ${Date.now() - receivedAt}ms)`);
}

module.exports = router;