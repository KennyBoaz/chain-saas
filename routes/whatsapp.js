/**
 * whatsapp.js  (multi-tenant)
 *
 * Talks to Meta's WhatsApp Cloud API. Unlike the single-shop version there is NO global
 * connection: every send/download function takes a `conn` object first:
 *
 *     conn = { tenantId, token, phoneNumberId, wabaId }
 *
 * Get one with loadConnection(tenantId) (dashboard routes) or from the webhook's tenant lookup.
 */

const axios = require("axios");
const https = require("https");
const db = require("./db.js");
const cryptoHelper = require("./crypto.js");

const GRAPH_API_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const GRAPH_BASE = process.env.WHATSAPP_GRAPH_BASE || "https://graph.facebook.com";
const MAX_TEXT_LENGTH = 4096;
const SEND_ATTEMPTS = 2;
const SAFE_RETRY_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

const graph = axios.create({
  baseURL: GRAPH_BASE,
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
  headers: { "Content-Type": "application/json" },
});

const auth = (conn) => ({ headers: { Authorization: `Bearer ${conn.token}` } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function toConn(row) {
  try {
    return {
      tenantId: row.tenant_id,
      token: cryptoHelper.decryptString(row.access_token_enc),
      phoneNumberId: row.phone_number_id,
      wabaId: row.waba_id || "",
    };
  } catch (err) {
    console.error(`[whatsapp] Could not decrypt the access token for tenant ${row.tenant_id}:`, err.message);
    return null;
  }
}

/** The saved WhatsApp connection of one tenant (token decrypted), or null. */
async function loadConnection(tenantId) {
  const row = await db.one(
    "SELECT tenant_id, waba_id, phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?",
    [tenantId]
  );
  return row ? toConn(row) : null;
}

// ---------------------------------------------------------------------------
// Parsing webhook payloads
// ---------------------------------------------------------------------------

const COEX_FIELDS = new Set(["history", "smb_message_echoes", "smb_app_state_sync"]);
const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

function extractText(message) {
  if (!message) return "";
  switch (message.type) {
    case "text":
      return message.text?.body || "";
    case "button":
      return message.button?.text || message.button?.payload || "";
    case "interactive": {
      const i = message.interactive || {};
      return i.button_reply?.title || i.list_reply?.title || i.nfm_reply?.response_json || "";
    }
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker": {
      const caption = message[message.type]?.caption || "";
      return caption ? `[Customer sent a ${message.type}: ${caption}]` : `[Customer sent a ${message.type}]`;
    }
    case "location": {
      const loc = message.location || {};
      return `[Location: ${loc.latitude}, ${loc.longitude}]`;
    }
    default:
      return "";
  }
}

function extractMedia(message) {
  if (!message || !MEDIA_TYPES.has(message.type)) return null;
  const part = message[message.type] || {};
  if (!part.id) return null;
  return { id: part.id, type: message.type, mime: part.mime_type || null, filename: part.filename || null, caption: part.caption || null };
}

/**
 * Flatten a webhook body. EVERY entry / change / message is returned (not just the first),
 * each tagged with the phoneNumberId so the caller can find the tenant.
 *
 * @returns {{ messages: object[], statuses: object[], coex: object[] }}
 */
function parseWebhook(body) {
  const out = { messages: [], statuses: [], coex: [] };

  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || null;

      if (COEX_FIELDS.has(change.field)) {
        out.coex.push({ field: change.field, phoneNumberId, value });
        continue;
      }
      if (change.field && change.field !== "messages") continue;

      for (const m of value.messages || []) {
        const contact = (value.contacts || []).find((c) => c.wa_id === m.from) || value.contacts?.[0];
        out.messages.push({
          phoneNumberId,
          id: m.id,
          from: m.from,
          name: contact?.profile?.name || null,
          type: m.type,
          text: extractText(m),
          timestamp: m.timestamp,
          media: extractMedia(m),
          replyTo: m.context?.id || null,
          location: m.type === "location" && m.location ? { latitude: m.location.latitude, longitude: m.location.longitude } : null,
          reaction: m.type === "reaction" ? { messageId: m.reaction?.message_id || null, emoji: m.reaction?.emoji || "" } : null,
          edit: m.type === "edit" && m.edit ? { messageId: m.edit.message_id, body: m.edit.body || "" } : null,
          revoke: m.type === "revoke" && m.revoke ? { messageId: m.revoke.original_message_id } : null,
        });
      }

      for (const s of value.statuses || []) {
        const error = Array.isArray(s.errors) ? s.errors[0] : null;
        let errorText = null;
        if (error) {
          const detail = error.error_data?.details;
          errorText = `${error.code ?? "error"}: ${error.title || error.message || "send failed"}${detail ? ` - ${detail}` : ""}`.slice(0, 480);
        }
        out.statuses.push({ phoneNumberId, id: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id, errorText });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function chunkText(text) {
  const value = String(text || "").trim();
  if (!value) return [];
  const chunks = [];
  for (let i = 0; i < value.length; i += MAX_TEXT_LENGTH) chunks.push(value.slice(i, i + MAX_TEXT_LENGTH));
  return chunks;
}

function describeSendError(err) {
  const e = err.response?.data?.error;
  if (e) {
    const detail = e.error_data?.details;
    return `${e.code ?? err.response.status}: ${e.message || e.type || "send failed"}${detail ? ` - ${detail}` : ""}`.slice(0, 480);
  }
  return String(err.code || err.message || "send failed").slice(0, 480);
}

function logWhatsAppError(err, conn, to) {
  const status = err.response?.status;
  const data = err.response?.data;
  const tag = `[whatsapp] tenant ${conn.tenantId}`;
  if (status === 401 || data?.error?.code === 190) {
    console.error(`${tag}: the access token is expired or invalid (HTTP ${status || 401}). Replies are NOT reaching customers until the tenant reconnects WhatsApp.`);
  } else if (status === 429) {
    console.error(`${tag}: rate limited by Meta while sending to ${to}.`);
  } else {
    console.error(`${tag}: failed to send to ${to}.`, status ? `HTTP ${status} ${JSON.stringify(data)}` : err.message);
  }
}

/**
 * Send a text (split into chunks if long). Returns [{ text, id, ok, error }].
 * opts.replyTo = wa_message_id to quote.
 */
async function sendText(conn, to, body, opts = {}) {
  const url = `/${GRAPH_API_VERSION}/${conn.phoneNumberId}/messages`;
  const chunks = chunkText(body);
  const results = [];

  for (const chunk of chunks) {
    const result = { text: chunk, id: null, ok: false, error: null };

    for (let attempt = 1; attempt <= SEND_ATTEMPTS && !result.ok; attempt += 1) {
      try {
        const response = await graph.post(
          url,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { preview_url: false, body: chunk },
            ...(opts.replyTo && chunk === chunks[0] ? { context: { message_id: opts.replyTo } } : {}),
          },
          auth(conn)
        );
        result.id = response.data?.messages?.[0]?.id || null;
        result.ok = true;
      } catch (err) {
        const status = err.response?.status;
        const retryable = (status && status >= 500) || SAFE_RETRY_CODES.includes(err.code);
        result.error = describeSendError(err);
        if (retryable && attempt < SEND_ATTEMPTS) {
          await sleep(500);
          continue;
        }
        logWhatsAppError(err, conn, to);
        break;
      }
    }
    results.push(result);
  }
  return results;
}

/** Read receipt + "typing..." (fire and forget, never throws). */
function markReadAndTyping(conn, messageId) {
  if (!conn || !messageId) return;
  graph
    .post(
      `/${GRAPH_API_VERSION}/${conn.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } },
      auth(conn)
    )
    .catch((err) => {
      const status = err.response?.status;
      if (status === 401 || err.response?.data?.error?.code === 190) logWhatsAppError(err, conn, "(read receipt)");
    });
}

async function sendReaction(conn, to, messageId, emoji) {
  try {
    const response = await graph.post(
      `/${GRAPH_API_VERSION}/${conn.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "reaction", reaction: { message_id: messageId, emoji } },
      auth(conn)
    );
    return { ok: true, id: response.data?.messages?.[0]?.id || null, error: null };
  } catch (err) {
    logWhatsAppError(err, conn, to);
    return { ok: false, id: null, error: describeSendError(err) };
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

async function downloadMedia(conn, mediaId, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const meta = await graph.get(`/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`, auth(conn));
  const info = meta.data || {};
  if (!info.url) throw new Error("WhatsApp did not return a download link for this file.");
  if (Number(info.file_size) > maxBytes) {
    const err = new Error(`file is too large (${info.file_size} bytes)`);
    err.code = "TOO_LARGE";
    throw err;
  }
  const file = await axios.get(info.url, { ...auth(conn), responseType: "arraybuffer", timeout: 30000, maxContentLength: maxBytes, maxBodyLength: maxBytes });
  const buffer = Buffer.from(file.data);
  const mime = info.mime_type || String(file.headers["content-type"] || "").split(";")[0] || null;
  return { buffer, mime, size: buffer.length };
}

async function uploadMedia(conn, buffer, mime, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buffer], { type: mime }), filename || "file");

  const res = await fetch(`${GRAPH_BASE}/${GRAPH_API_VERSION}/${conn.phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const e = data && data.error;
    const detail = e && e.error_data && e.error_data.details;
    throw new Error(e ? `${e.code ?? res.status}: ${e.message || "upload failed"}${detail ? " - " + detail : ""}` : `upload failed (HTTP ${res.status})`);
  }
  return data.id;
}

async function sendMedia(conn, to, { type, mediaId, caption, filename }) {
  const part = { id: mediaId };
  if (caption && type !== "audio") part.caption = String(caption).slice(0, 1000);
  if (type === "document" && filename) part.filename = filename;
  try {
    const response = await graph.post(
      `/${GRAPH_API_VERSION}/${conn.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type, [type]: part },
      auth(conn)
    );
    return { ok: true, id: response.data?.messages?.[0]?.id || null, error: null };
  } catch (err) {
    logWhatsAppError(err, conn, to);
    return { ok: false, id: null, error: describeSendError(err) };
  }
}

// ---------------------------------------------------------------------------
// Templates (the only thing allowed after the 24-hour window)
// ---------------------------------------------------------------------------

async function fetchTemplates(conn) {
  if (!conn.wabaId) {
    const err = new Error("No WhatsApp Business Account id is saved for this tenant.");
    err.code = "NO_WABA";
    throw err;
  }
  let url = `/${GRAPH_API_VERSION}/${conn.wabaId}/message_templates`;
  let params = { fields: "name,language,status,category,parameter_format,components", limit: 100 };
  const all = [];
  for (let page = 0; page < 5 && url; page += 1) {
    const response = await graph.get(url, { ...auth(conn), params });
    all.push(...(response.data?.data || []));
    url = response.data?.paging?.next || null;
    params = undefined;
  }
  return all;
}

function summariseTemplate(t) {
  const comps = Array.isArray(t.components) ? t.components : [];
  const find = (type) => comps.find((c) => String(c.type).toUpperCase() === type);
  const header = find("HEADER");
  const body = find("BODY");
  const footer = find("FOOTER");
  const buttons = find("BUTTONS");

  const bodyText = (body && body.text) || "";
  const numbers = Array.from(bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => Number(m[1]));
  const variables = numbers.length ? Math.max(...numbers) : 0;

  let supported = true;
  let reason = "";
  const no = (why) => { if (supported) { supported = false; reason = why; } };

  if (String(t.parameter_format || "").toUpperCase() === "NAMED" || /\{\{\s*[A-Za-z_]/.test(bodyText)) no("named variables");
  const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
  if (unique.some((n, i) => n !== i + 1)) no("variables are not numbered 1, 2, 3...");
  if (header) {
    const format = String(header.format || "TEXT").toUpperCase();
    if (format !== "TEXT") no("it has a " + format.toLowerCase() + " header");
    else if (/\{\{/.test(header.text || "")) no("its header has a variable");
  }
  if (buttons && Array.isArray(buttons.buttons)) {
    for (const b of buttons.buttons) {
      const kind = String(b.type || "").toUpperCase();
      if (["COPY_CODE", "FLOW", "OTP", "MPM", "CATALOG", "SPM"].includes(kind) || /\{\{/.test(b.url || "")) { no("it has a button that needs extra data"); break; }
    }
  }
  return {
    name: t.name, language: t.language, category: t.category || null, variables, body: bodyText,
    header: header && String(header.format || "TEXT").toUpperCase() === "TEXT" ? header.text || "" : "",
    footer: (footer && footer.text) || "", supported, reason,
  };
}

async function sendTemplate(conn, to, { name, language, params = [] }) {
  const template = { name, language: { code: language } };
  if (params.length) template.components = [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }];
  try {
    const response = await graph.post(
      `/${GRAPH_API_VERSION}/${conn.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template },
      auth(conn)
    );
    return { ok: true, id: response.data?.messages?.[0]?.id || null, error: null };
  } catch (err) {
    logWhatsAppError(err, conn, to);
    return { ok: false, id: null, error: describeSendError(err) };
  }
}

module.exports = {
  loadConnection,
  parseWebhook,
  sendText,
  markReadAndTyping,
  sendReaction,
  downloadMedia,
  uploadMedia,
  sendMedia,
  fetchTemplates,
  summariseTemplate,
  sendTemplate,
  describeSendError,
};