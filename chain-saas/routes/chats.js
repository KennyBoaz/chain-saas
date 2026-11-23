/**
 * routes/chats.js  (multi-tenant)   mounted at /api/chats
 *
 * Everything the staff dashboard needs. EVERY query is filtered by req.user.tenant_id.
 * Cookie sessions: requireAuth (signed in) + checkCsrf (X-CSRF-Token header on every non-GET).
 *
 *   GET   /summary                                   badge counts + latest ids (the dashboard polls this)
 *   GET   /conversations   ?filter=&search=&limit=&offset=
 *   GET   /conversations/:phone                      details + that customer's orders / appointments / tickets
 *   GET   /conversations/:phone/messages   ?after=ID | ?before=ID &limit=
 *   POST  /conversations/:phone/messages             { text, reply_to? }
 *   POST  /conversations/:phone/media                raw file bytes (Content-Type = file type, X-Filename, X-Caption)
 *   POST  /conversations/:phone/template             { name, language, params[] }
 *   POST  /conversations/:phone/(read|takeover|handback|resolve|reopen|pin|unread|assign|reset-bot-memory)
 *   GET   /conversations/:phone/export
 *   POST  /conversations/:phone/delete               tenant admin only, { confirm: phone, also_records }
 *   PATCH /conversations/:phone/customer             { display_name?, notes? }
 *   POST  /messages/:id/(react|star|save-note|forward|retry)
 *   GET   /media/:id                                 a stored file (signed-in staff of the same tenant only)
 *   GET   /templates   /team
 *   GET   /issues  /orders  /appointments            ?status=open|all|new|in_progress|resolved|cancelled &type= &phone= &search=
 *   PATCH /issues/:id   /orders/:id   /appointments/:id    { status?, note?, assign_to_me? }
 *   GET   /tickets                                   same as /issues but answers { tickets } (for the interim inbox page)
 */

const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const wa = require("../whatsapp.js");
const chatStore = require("../chatStore.js");
const svc = require("../conversations.js");
const mediaStore = require("../mediaStore.js");
const { HttpError, wrap } = require("../apiUtil.js");
const { parsePhone, intParam, searchTerm, cleanText } = require("../chatHelpers.js");

const router = express.Router();
const tid = (req) => req.user.tenant_id;

// ===========================================================================
// File upload (raw bytes, so it is declared BEFORE the JSON-only guards below)
// ===========================================================================

const OUT_TYPES = {
  "image/jpeg": "image", "image/png": "image",
  "video/mp4": "video", "video/3gpp": "video",
  "audio/aac": "audio", "audio/mp4": "audio", "audio/mpeg": "audio", "audio/amr": "audio", "audio/ogg": "audio",
  "application/pdf": "document", "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "text/plain": "document",
};
const PLACEHOLDER = { image: "[Photo]", video: "[Video]", audio: "[Audio]" };
const IMAGE_LIMIT = 5 * 1024 * 1024; // WhatsApp's own limit for photos

const headerText = (req, name, max) => {
  try { return decodeURIComponent(String(req.headers[name] || "")).slice(0, max); } catch { return ""; }
};

router.post(
  "/conversations/:phone/media",
  express.raw({ type: () => true, limit: mediaStore.MAX_BYTES }),
  auth.requireAuth,
  auth.checkCsrf,
  wrap(async (req, res) => {
    const tenantId = tid(req);
    const phone = parsePhone(req.params.phone);
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, "No file was received.", "EMPTY");

    const mime = mediaStore.normalizeMime(req.headers["content-type"]);
    const type = OUT_TYPES[mime];
    if (!type) {
      throw new HttpError(415, mime === "image/webp"
        ? "WhatsApp does not accept WebP photos. Send a JPEG or PNG instead."
        : "That file type can't be sent on WhatsApp. Use a JPEG/PNG photo, MP4 video, audio, PDF, Word, Excel, PowerPoint or text file.", "BAD_TYPE");
    }
    if (type === "image" && buffer.length > IMAGE_LIMIT) throw new HttpError(413, "Photos must be 5 MB or smaller on WhatsApp.", "TOO_BIG");
    if (!mediaStore.sniffOk(buffer, mime)) throw new HttpError(415, "That file does not look like a real " + mime + ".", "BAD_CONTENT");

    const conversation = await svc.requireConversation(tenantId, phone);
    if (!svc.windowInfo(conversation.last_customer_message_at).open) {
      throw new HttpError(409, "The 24-hour window has closed. Send an approved template instead.", "WINDOW_CLOSED");
    }
    const conn = await svc.requireConnection(tenantId);

    const name = mediaStore.cleanName(headerText(req, "x-filename", 200), mediaStore.defaultName(type, mime));
    const caption = type === "audio" ? "" : headerText(req, "x-caption", 1000).trim();

    let sent;
    try {
      const mediaId = await wa.uploadMedia(conn, buffer, mime, name);
      sent = await wa.sendMedia(conn, phone, { type, mediaId, caption, filename: name });
    } catch (err) {
      console.error(`[media] tenant ${tenantId}: upload to WhatsApp failed for ${phone}:`, err.message);
      sent = { ok: false, id: null, error: err.message };
    }

    const id = await chatStore.recordOutgoingMedia(tenantId, {
      phone, body: caption || PLACEHOLDER[type] || `[Document: ${name}]`, msgType: type, mime, name, size: buffer.length,
      staffId: req.user.id, waMessageId: sent.id, status: sent.ok ? "sent" : "failed", error: sent.error,
    });
    try {
      await mediaStore.save(tenantId, id, buffer);
    } catch (err) {
      console.error("[media] Could not keep a copy of the sent file:", err.message);
      await db.run("UPDATE messages SET has_media = 0 WHERE id = ? AND tenant_id = ?", [id, tenantId]).catch(() => {});
    }
    await chatStore.takeOverByStaff(tenantId, phone, req.user.id).catch(() => {});

    const messages = await svc.getMessagesByIds(tenantId, [id]);
    if (!sent.ok) return res.status(502).json({ error: sent.error || "WhatsApp did not accept the file.", messages });
    res.json({ messages });
  })
);

// ===========================================================================
// Everything below needs a signed-in user and (for writes) a valid CSRF token
// ===========================================================================

router.use(auth.requireAuth);
router.use(auth.checkCsrf);

// ---------------------------------------------------------------------------
// Summary (badges + "something new happened" detection)
// ---------------------------------------------------------------------------

router.get("/summary", wrap(async (req, res) => {
  const t = tid(req);
  const row = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND status = 'escalated') AS escalated_chats,
       (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND mode = 'human' AND status <> 'resolved') AS human_chats,
       (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND unread_count > 0 AND status <> 'resolved') AS unread_chats,
       (SELECT COALESCE(SUM(unread_count), 0) FROM conversations
         WHERE tenant_id = ? AND (mode = 'human' OR status = 'escalated') AND status <> 'resolved') AS unread_needing_staff,
       (SELECT COUNT(*) FROM issues WHERE tenant_id = ? AND status = 'new') AS new_issues,
       (SELECT COUNT(*) FROM orders WHERE tenant_id = ? AND status = 'new') AS new_orders,
       (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND status = 'new') AS new_appointments,
       (SELECT COALESCE(MAX(id), 0) FROM messages WHERE tenant_id = ? AND direction = 'in') AS last_incoming_message_id,
       (SELECT COALESCE(MAX(id), 0) FROM messages WHERE tenant_id = ?) AS last_message_id,
       (SELECT COALESCE(MAX(id), 0) FROM issues WHERE tenant_id = ?) AS last_issue_id,
       (SELECT COALESCE(MAX(id), 0) FROM orders WHERE tenant_id = ?) AS last_order_id,
       (SELECT COALESCE(MAX(id), 0) FROM appointments WHERE tenant_id = ?) AS last_appointment_id`,
    Array(12).fill(t)
  );
  const summary = {};
  for (const [key, value] of Object.entries(row)) summary[key] = Number(value) || 0;
  res.json({ summary });
}));

// ---------------------------------------------------------------------------
// Chat list and one chat
// ---------------------------------------------------------------------------

function shapeConversation(row) {
  return {
    phone: row.phone,
    name: row.name || null,
    mode: row.mode,
    status: row.status,
    pinned: Boolean(row.pinned),
    unread_count: Number(row.unread_count) || 0,
    assigned_to: row.assigned_to || null,
    assigned_name: row.assigned_name || null,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    last_customer_message_at: row.last_customer_message_at,
    window: svc.windowInfo(row.last_customer_message_at),
    open_issues: Number(row.open_issues) || 0,
    open_orders: Number(row.open_orders) || 0,
    open_appointments: Number(row.open_appointments) || 0,
  };
}

const CONVERSATION_SELECT = `
  SELECT c.phone, c.mode, c.status, c.unread_count, c.assigned_to, c.pinned,
         c.last_customer_message_at, c.last_message_at, c.last_message_preview,
         COALESCE(cu.display_name, cu.whatsapp_name) AS name,
         su.name AS assigned_name,
         (SELECT COUNT(*) FROM issues i WHERE i.tenant_id = c.tenant_id AND i.phone = c.phone AND i.status IN ('new','in_progress')) AS open_issues,
         (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone AND o.status IN ('new','in_progress')) AS open_orders,
         (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id = c.tenant_id AND a.phone = c.phone AND a.status IN ('new','in_progress')) AS open_appointments
    FROM conversations c
    JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.phone = c.phone
    LEFT JOIN users su ON su.id = c.assigned_to AND su.tenant_id = c.tenant_id`;

router.get("/conversations", wrap(async (req, res) => {
  const filter = String(req.query.filter || "active");
  const where = ["c.tenant_id = ?"];
  const params = [tid(req)];

  switch (filter) {
    case "all": break;
    case "unread": where.push("c.unread_count > 0"); break;
    case "human": where.push("c.mode = 'human'"); break;
    case "escalated": where.push("c.status = 'escalated'"); break;
    case "window_open": where.push("c.last_customer_message_at >= ?"); params.push(new Date(Date.now() - svc.WINDOW_MS)); break;
    case "open_issue": where.push("EXISTS (SELECT 1 FROM issues i WHERE i.tenant_id = c.tenant_id AND i.phone = c.phone AND i.status IN ('new','in_progress'))"); break;
    case "resolved": where.push("c.status = 'resolved'"); break;
    case "active": where.push("c.status <> 'resolved'"); break;
    default: throw new HttpError(400, "Unknown filter.", "BAD_FILTER");
  }

  const term = searchTerm(req.query.search);
  if (term) {
    where.push("(cu.display_name LIKE ? OR cu.whatsapp_name LIKE ? OR c.phone LIKE ?)");
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }

  const limit = intParam(req.query.limit, 30, 1, 100);
  const offset = intParam(req.query.offset, 0, 0, 100000);

  const rows = await db.all(
    `${CONVERSATION_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY c.pinned DESC, (c.status = 'escalated') DESC, COALESCE(c.last_message_at, c.created_at) DESC, c.phone
      LIMIT ? OFFSET ?`,
    [...params, limit + 1, offset]
  );
  res.json({ conversations: rows.slice(0, limit).map(shapeConversation), has_more: rows.length > limit });
}));

function parseItems(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return text ? [String(text)] : [];
  }
}

router.get("/conversations/:phone", wrap(async (req, res) => {
  const t = tid(req);
  const phone = parsePhone(req.params.phone);
  const row = await db.one(`${CONVERSATION_SELECT} WHERE c.tenant_id = ? AND c.phone = ?`, [t, phone]);
  if (!row) throw new HttpError(404, "Chat not found.", "NOT_FOUND");

  const customer = await db.one("SELECT phone, whatsapp_name, display_name, notes, created_at FROM customers WHERE tenant_id = ? AND phone = ?", [t, phone]);
  const orders = await db.all(
    `SELECT id, ref, items, quantity, delivery_address, delivery_date, status, created_at
       FROM orders WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`, [t, phone]);
  const appointments = await db.all(
    `SELECT id, ref, appt_date, appt_time, purpose, status, created_at
       FROM appointments WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`, [t, phone]);
  const issues = await db.all(
    `SELECT id, ref, type, summary, details, status, created_at
       FROM issues WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`, [t, phone]);

  res.json({
    conversation: shapeConversation(row),
    customer,
    orders: orders.map((o) => ({ ...o, items: parseItems(o.items) })),
    appointments,
    issues,
  });
}));

router.get("/conversations/:phone/messages", wrap(async (req, res) => {
  const t = tid(req);
  const phone = parsePhone(req.params.phone);
  await svc.requireConversation(t, phone);

  const after = intParam(req.query.after, null, 1);
  const before = intParam(req.query.before, null, 1);
  const limit = intParam(req.query.limit, after ? 100 : 50, 1, 200);
  res.json({ messages: await svc.listMessages(t, phone, { after, before, limit }) });
}));

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

router.post("/conversations/:phone/messages", wrap(async (req, res) => {
  const body = req.body || {};
  const replyTo = Number(body.reply_to ?? body.replyTo) > 0 ? Number(body.reply_to ?? body.replyTo) : null;
  const result = await svc.sendStaffMessage(tid(req), { phone: parsePhone(req.params.phone), text: body.text, staffId: req.user.id, replyTo });

  if (!result.delivered) {
    return res.status(502).json({ error: `WhatsApp did not accept the message: ${result.error}`, code: "SEND_FAILED", delivered: false, messages: result.messages });
  }
  res.status(201).json({ delivered: true, messages: result.messages });
}));

function messageId(req) {
  const id = intParam(req.params.id, null, 1);
  if (!id) throw new HttpError(404, "Message not found.", "NOT_FOUND");
  return id;
}

router.post("/messages/:id/retry", wrap(async (req, res) => {
  const result = await svc.retryStaffMessage(tid(req), messageId(req));
  if (!result.delivered) {
    return res.status(502).json({ error: `WhatsApp did not accept the message: ${result.error}`, code: "SEND_FAILED", delivered: false, message: result.message });
  }
  res.json({ delivered: true, message: result.message });
}));

// react / star also answer on the older path used by the interim inbox page
router.post(["/messages/:id/react", "/conversations/:phone/messages/:id/react"], wrap(async (req, res) => {
  const emoji = req.body && typeof req.body.emoji === "string" ? req.body.emoji : "";
  res.json({ ok: true, message: await svc.reactToMessage(tid(req), { messageId: messageId(req), emoji }) });
}));

router.post(["/messages/:id/star", "/conversations/:phone/messages/:id/star"], wrap(async (req, res) => {
  res.json({ ok: true, message: await svc.setStarred(tid(req), messageId(req), Boolean(req.body && req.body.starred)) });
}));

router.post("/messages/:id/save-note", wrap(async (req, res) => {
  res.json({ notes: await svc.saveMessageToNotes(tid(req), messageId(req)) });
}));

router.post("/messages/:id/forward", wrap(async (req, res) => {
  const toPhone = parsePhone(req.body && req.body.to_phone, 400);
  const result = await svc.forwardMessage(tid(req), { messageId: messageId(req), toPhone, staffId: req.user.id });
  if (!result.delivered) return res.status(502).json({ error: `WhatsApp did not accept the message: ${result.error}`, code: "SEND_FAILED", delivered: false });
  res.status(201).json({ delivered: true });
}));

// ---------------------------------------------------------------------------
// Chat actions
// ---------------------------------------------------------------------------

router.post("/conversations/:phone/read", wrap(async (req, res) => {
  const t = tid(req), phone = parsePhone(req.params.phone);
  await svc.requireConversation(t, phone);
  await svc.markRead(t, phone);
  res.json({ ok: true });
}));

router.post("/conversations/:phone/takeover", wrap(async (req, res) => {
  await svc.takeOver(tid(req), parsePhone(req.params.phone), req.user.id);
  res.json({ ok: true });
}));

router.post("/conversations/:phone/handback", wrap(async (req, res) => {
  res.json({ ok: true, ...(await svc.handBack(tid(req), parsePhone(req.params.phone))) });
}));

router.post("/conversations/:phone/resolve", wrap(async (req, res) => {
  const note = cleanText(req.body && req.body.note, 2000);
  res.json({ ok: true, ...(await svc.resolve(tid(req), parsePhone(req.params.phone), req.user.id, note)) });
}));

router.post("/conversations/:phone/reopen", wrap(async (req, res) => {
  await svc.reopen(tid(req), parsePhone(req.params.phone));
  res.json({ ok: true });
}));

router.post("/conversations/:phone/pin", wrap(async (req, res) => {
  await svc.setPinned(tid(req), parsePhone(req.params.phone), Boolean(req.body && req.body.pinned));
  res.json({ ok: true });
}));

router.post("/conversations/:phone/unread", wrap(async (req, res) => {
  await svc.markUnread(tid(req), parsePhone(req.params.phone));
  res.json({ ok: true });
}));

router.post("/conversations/:phone/assign", wrap(async (req, res) => {
  const raw = req.body ? req.body.staff_id : null;
  const staffId = raw === null || raw === undefined || raw === "" ? null : intParam(raw, null, 1);
  await svc.assignChat(tid(req), parsePhone(req.params.phone), staffId);
  res.json({ ok: true });
}));

router.post("/conversations/:phone/reset-bot-memory", wrap(async (req, res) => {
  await svc.resetBotMemory(tid(req), parsePhone(req.params.phone));
  res.json({ ok: true });
}));

router.get("/conversations/:phone/export", wrap(async (req, res) => {
  res.json(await svc.exportText(tid(req), parsePhone(req.params.phone)));
}));

/** Tenant admin only. The body must repeat the phone number as a safety check. */
router.post("/conversations/:phone/delete", auth.requireTenantAdmin, wrap(async (req, res) => {
  const phone = parsePhone(req.params.phone);
  if (!req.body || req.body.confirm !== phone) throw new HttpError(400, "Type the phone number to confirm.", "CONFIRM_MISMATCH");
  await svc.deleteConversation(tid(req), phone, Boolean(req.body.also_records));
  console.warn(`[admin] ${req.user.email} (tenant ${tid(req)}) permanently deleted the conversation with ${phone}${req.body.also_records ? " and its records" : ""}.`);
  res.json({ ok: true });
}));

router.patch("/conversations/:phone/customer", wrap(async (req, res) => {
  const t = tid(req), phone = parsePhone(req.params.phone);
  await svc.requireConversation(t, phone);

  const body = req.body || {};
  const displayName = cleanText(body.display_name, 150);
  const notes = cleanText(body.notes, 5000);
  const sets = [], params = [];
  if (displayName !== undefined) { sets.push("display_name = ?"); params.push(displayName); }
  if (notes !== undefined) { sets.push("notes = ?"); params.push(notes); }
  if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

  await db.run(`UPDATE customers SET ${sets.join(", ")} WHERE tenant_id = ? AND phone = ?`, [...params, t, phone]);
  res.json({ customer: await db.one("SELECT phone, whatsapp_name, display_name, notes FROM customers WHERE tenant_id = ? AND phone = ?", [t, phone]) });
}));

/** Active staff of this tenant (for "assign to..."). */
router.get("/team", wrap(async (req, res) => {
  res.json({ staff: await db.all("SELECT id, name FROM users WHERE tenant_id = ? AND active = 1 ORDER BY name", [tid(req)]) });
}));

// ---------------------------------------------------------------------------
// Files (served only to signed-in staff of the SAME tenant)
// ---------------------------------------------------------------------------

router.get("/media/:id", wrap(async (req, res) => {
  const id = intParam(req.params.id, null, 1);
  if (!id) throw new HttpError(404, "File not found.", "NOT_FOUND");

  const row = await db.one("SELECT has_media, media_mime, media_name FROM messages WHERE id = ? AND tenant_id = ?", [id, tid(req)]);
  const mime = row && mediaStore.normalizeMime(row.media_mime);
  if (!row || !row.has_media || !mediaStore.isAllowed(mime)) throw new HttpError(404, "File not found.", "NOT_FOUND");

  const inline = /^(image|audio|video)\//.test(mime);
  const name = mediaStore.cleanName(row.media_name, "file");
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.sendFile(mediaStore.pathFor(tid(req), id), { dotfiles: "allow", cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found." });
  });
}));

// ---------------------------------------------------------------------------
// Templates (the only thing WhatsApp allows after the 24-hour window)
// ---------------------------------------------------------------------------

const templateCache = new Map(); // tenantId -> { at, list }

async function approvedTemplates(tenantId, conn) {
  const cached = templateCache.get(tenantId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.list;
  const all = await wa.fetchTemplates(conn);
  const list = all
    .filter((t) => String(t.status).toUpperCase() === "APPROVED")
    .map(wa.summariseTemplate)
    .sort((a, b) => a.name.localeCompare(b.name));
  templateCache.set(tenantId, { at: Date.now(), list });
  return list;
}

router.get("/templates", wrap(async (req, res) => {
  const t = tid(req);
  const conn = await wa.loadConnection(t);
  if (!conn || !conn.wabaId) return res.json({ configured: false, templates: [] });
  try {
    res.json({ configured: true, templates: await approvedTemplates(t, conn) });
  } catch (err) {
    // 424 (not 5xx) so the dashboard shows Meta's reason instead of "Server error."
    throw new HttpError(424, "Could not load templates from WhatsApp: " + wa.describeSendError(err), "META_TEMPLATES");
  }
}));

/** WhatsApp rejects values with line breaks, tabs or long runs of spaces. */
const cleanParam = (v) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 1000);

router.post("/conversations/:phone/template", wrap(async (req, res) => {
  const t = tid(req);
  const phone = parsePhone(req.params.phone);
  const { name, language } = req.body || {};
  if (!/^[a-z0-9_]{1,512}$/.test(String(name || ""))) throw new HttpError(400, "Choose a template.", "BAD_TEMPLATE");
  if (!/^[A-Za-z]{2,3}(_[A-Za-z]{2})?$/.test(String(language || ""))) throw new HttpError(400, "The template language is not valid.", "BAD_LANGUAGE");
  const params = (Array.isArray(req.body.params) ? req.body.params : []).map(cleanParam);

  await svc.requireConversation(t, phone);
  const conn = await svc.requireConnection(t);

  let list;
  try {
    list = await approvedTemplates(t, conn);
  } catch (err) {
    throw new HttpError(424, "Could not check the template with WhatsApp: " + wa.describeSendError(err), "META_TEMPLATES");
  }
  const template = list.find((x) => x.name === name && x.language === language);
  if (!template) throw new HttpError(404, "That template is not approved (or no longer exists).", "NOT_FOUND");
  if (!template.supported) throw new HttpError(400, `That template can't be sent from here (${template.reason}).`, "UNSUPPORTED");
  if (params.length !== template.variables || params.some((p) => !p)) throw new HttpError(400, `This template needs ${template.variables} value(s). Fill in every blank.`, "BAD_PARAMS");

  const fill = (text) => String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || "");
  const shown = [template.header, fill(template.body)].filter(Boolean).join("\n");

  const sent = await wa.sendTemplate(conn, phone, { name, language, params });
  const id = await chatStore.recordOutgoing(t, { phone, body: shown, senderType: "staff", staffId: req.user.id, waMessageId: sent.id, status: sent.ok ? "sent" : "failed", error: sent.error });
  await chatStore.takeOverByStaff(t, phone, req.user.id).catch(() => {});

  const messages = await svc.getMessagesByIds(t, [id]);
  if (!sent.ok) return res.status(502).json({ error: sent.error || "WhatsApp did not accept the template.", messages });
  res.json({ messages });
}));

// ===========================================================================
// Tickets / orders / appointments (same three endpoints each)
// ===========================================================================

const STATUS_FLOW = ["new", "in_progress", "resolved", "cancelled"];
const ISSUE_TYPES = ["support", "escalation", "inquiry"];

// Table names, aliases and column names are fixed here in code (never taken from the request).
const TYPES = {
  issues: {
    table: "issues", alias: "i",
    statuses: ["new", "in_progress", "resolved"], doneStatuses: ["resolved"],
    noteColumn: "resolution_note", ownerColumn: "assigned_to", doneColumn: "resolved_by",
    from: `issues i
      LEFT JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.phone = i.phone
      LEFT JOIN users sa ON sa.id = i.assigned_to AND sa.tenant_id = i.tenant_id
      LEFT JOIN users sr ON sr.id = i.resolved_by AND sr.tenant_id = i.tenant_id`,
    select: `i.id, i.ref, i.type, i.phone, i.contact_phone, i.customer_name, i.order_ref,
      i.summary, i.details, i.status, i.assigned_to, sa.name AS assigned_name,
      i.resolution_note, i.resolved_by, sr.name AS resolved_by_name, i.resolved_at,
      i.created_at, i.updated_at, COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["i.ref", "i.customer_name", "i.phone", "i.summary", "i.details", "i.order_ref"],
  },
  orders: {
    table: "orders", alias: "o",
    statuses: STATUS_FLOW, doneStatuses: ["resolved", "cancelled"],
    noteColumn: "staff_note", ownerColumn: "handled_by", doneColumn: "handled_by",
    from: `orders o
      LEFT JOIN customers cu ON cu.tenant_id = o.tenant_id AND cu.phone = o.phone
      LEFT JOIN users sh ON sh.id = o.handled_by AND sh.tenant_id = o.tenant_id`,
    select: `o.id, o.ref, o.phone, o.contact_phone, o.customer_name, o.items, o.quantity,
      o.delivery_address, o.delivery_date, o.status, o.staff_note, o.handled_by,
      sh.name AS handled_by_name, o.resolved_at, o.created_at, o.updated_at,
      COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["o.ref", "o.customer_name", "o.phone", "o.items", "o.delivery_address"],
  },
  appointments: {
    table: "appointments", alias: "a",
    statuses: STATUS_FLOW, doneStatuses: ["resolved", "cancelled"],
    noteColumn: "staff_note", ownerColumn: "handled_by", doneColumn: "handled_by",
    from: `appointments a
      LEFT JOIN customers cu ON cu.tenant_id = a.tenant_id AND cu.phone = a.phone
      LEFT JOIN users sh ON sh.id = a.handled_by AND sh.tenant_id = a.tenant_id`,
    select: `a.id, a.ref, a.phone, a.contact_phone, a.name AS customer_name, a.appt_date,
      a.appt_time, a.purpose, a.status, a.staff_note, a.handled_by,
      sh.name AS handled_by_name, a.resolved_at, a.created_at, a.updated_at,
      COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["a.ref", "a.name", "a.phone", "a.purpose"],
  },
};

function shapeRow(key, row) {
  return key === "orders" ? { ...row, items: parseItems(row.items) } : row;
}

function listHandler(key, answerKey) {
  const cfg = TYPES[key];
  const a = cfg.alias;
  return wrap(async (req, res) => {
    const where = [`${a}.tenant_id = ?`];
    const params = [tid(req)];

    const status = String(req.query.status || "open");
    if (status === "open") {
      where.push(`${a}.status IN ('new','in_progress')`);
    } else if (status !== "all") {
      if (!cfg.statuses.includes(status)) throw new HttpError(400, "Unknown status.", "BAD_STATUS");
      where.push(`${a}.status = ?`);
      params.push(status);
    }
    if (key === "issues" && req.query.type) {
      const type = String(req.query.type);
      if (!ISSUE_TYPES.includes(type)) throw new HttpError(400, "Unknown issue type.", "BAD_TYPE");
      where.push("i.type = ?");
      params.push(type);
    }
    if (req.query.phone) {
      where.push(`${a}.phone = ?`);
      params.push(parsePhone(req.query.phone, 400));
    }
    const term = searchTerm(req.query.search);
    if (term) {
      where.push(`(${cfg.searchColumns.map((c) => `${c} LIKE ?`).join(" OR ")})`);
      for (let n = 0; n < cfg.searchColumns.length; n += 1) params.push(`%${term}%`);
    }

    const limit = intParam(req.query.limit, 30, 1, 100);
    const offset = intParam(req.query.offset, 0, 0, 100000);
    const rows = await db.all(
      `SELECT ${cfg.select} FROM ${cfg.from}
        WHERE ${where.join(" AND ")}
        ORDER BY ${a}.created_at DESC, ${a}.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    );
    res.json({ [answerKey]: rows.slice(0, limit).map((r) => shapeRow(key, r)), has_more: rows.length > limit });
  });
}

for (const [key, cfg] of Object.entries(TYPES)) {
  const a = cfg.alias;
  router.get(`/${key}`, listHandler(key, key));

  router.patch(`/${key}/:id`, wrap(async (req, res) => {
    const t = tid(req);
    const id = intParam(req.params.id, null, 1);
    const existing = id ? await db.one(`SELECT id FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [id, t]) : null;
    if (!existing) throw new HttpError(404, "Not found.", "NOT_FOUND");

    const body = req.body || {};
    const sets = [], params = [];

    if (body.status !== undefined) {
      if (!cfg.statuses.includes(body.status)) throw new HttpError(400, `Status must be one of: ${cfg.statuses.join(", ")}.`, "BAD_STATUS");
      sets.push("status = ?");
      params.push(body.status);

      if (cfg.doneStatuses.includes(body.status)) {
        sets.push("resolved_at = UTC_TIMESTAMP(3)", `${cfg.doneColumn} = ?`);
        params.push(req.user.id);
      } else {
        sets.push("resolved_at = NULL");
        if (cfg.doneColumn !== cfg.ownerColumn) sets.push(`${cfg.doneColumn} = NULL`);
        if (body.status === "in_progress") { sets.push(`${cfg.ownerColumn} = ?`); params.push(req.user.id); }
      }
    }
    if (body.assign_to_me === true && !sets.some((s) => s.startsWith(`${cfg.ownerColumn} =`))) {
      sets.push(`${cfg.ownerColumn} = ?`);
      params.push(req.user.id);
    }
    const note = cleanText(body.note, 2000);
    if (note !== undefined) { sets.push(`${cfg.noteColumn} = ?`); params.push(note); }
    if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

    sets.push("updated_at = UTC_TIMESTAMP(3)");
    await db.run(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [...params, id, t]);

    const row = await db.one(`SELECT ${cfg.select} FROM ${cfg.from} WHERE ${a}.id = ? AND ${a}.tenant_id = ?`, [id, t]);
    res.json({ item: shapeRow(key, row) });
  }));
}

// Same list as /issues, answered as { tickets } (used by the interim inbox page until Phase 3 replaces it)
router.get("/tickets", listHandler("issues", "tickets"));

module.exports = router;