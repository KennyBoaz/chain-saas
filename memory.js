/**
 * memory.js  (multi-tenant, MySQL-backed)
 *
 * What GEMINI remembers about each customer, keyed by (tenant_id, phone) in the bot_history table.
 * (The chat log staff read lives in `messages`, written by chatStore.js.)
 *
 *   MAX_STORED_MESSAGES   recent turns to keep (default 30)
 */

const db = require("./db.js");

const MAX_STORED_MESSAGES = Number(process.env.MAX_STORED_MESSAGES) || 30;

async function getHistory(tenantId, phone) {
  const row = await db.one("SELECT history_json FROM bot_history WHERE tenant_id = ? AND phone = ?", [tenantId, String(phone)]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.history_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn(`[memory] Stored history for tenant ${tenantId} / ${phone} is not valid JSON; starting fresh.`);
    return [];
  }
}

async function saveHistory(tenantId, phone, messages) {
  const trimmed = Array.isArray(messages) ? messages.slice(-MAX_STORED_MESSAGES) : [];
  await db.run(
    `INSERT INTO bot_history (tenant_id, phone, history_json, updated_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE history_json = VALUES(history_json), updated_at = UTC_TIMESTAMP(3)`,
    [tenantId, String(phone), JSON.stringify(trimmed)]
  );
}

async function appendMessages(tenantId, phone, messages) {
  const list = await getHistory(tenantId, phone);
  const extra = Array.isArray(messages) ? messages : [messages];
  const updated = list.concat(extra.map((m) => ({ timestamp: new Date().toISOString(), ...m }))).slice(-MAX_STORED_MESSAGES);
  await saveHistory(tenantId, phone, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Conversion between our stored format and the Gemini SDK's Content[]
// ---------------------------------------------------------------------------

function toGeminiHistory(stored) {
  const contents = [];
  for (const msg of stored || []) {
    const role = storedRoleToGeminiRole(msg.role);
    if (!role) continue;
    let parts = Array.isArray(msg.parts) ? msg.parts.filter(Boolean) : [];
    if (parts.length === 0) parts = partsFromSimpleMessage(msg);
    if (parts.length === 0) continue;
    contents.push({ role, parts });
  }
  // chats.create() needs history to START with a plain user message. Trimming can leave a tool
  // result with no matching tool call at the front, which Gemini rejects with a 400 error.
  while (contents.length > 0 && !isPlainUserTurn(contents[0])) contents.shift();
  return contents;
}

const isPlainUserTurn = (content) => content.role === "user" && !content.parts.some((part) => part.functionResponse);

function fromGeminiHistory(contents) {
  const now = new Date().toISOString();
  return (contents || []).map((content) => {
    const parts = content.parts || [];
    const hasFunctionResponse = parts.some((part) => part.functionResponse);
    let role = content.role;
    if (content.role === "function" || content.role === "tool" || hasFunctionResponse) role = "tool";
    return { role, content: readableText(parts), parts, timestamp: now };
  });
}

function storedRoleToGeminiRole(role) {
  if (role === "user") return "user";
  if (role === "model") return "model";
  if (role === "tool" || role === "function") return "user"; // tool results are sent as role "user"
  return null;
}

function partsFromSimpleMessage(msg) {
  if (msg.functionCalls && msg.functionCalls.length > 0) {
    return msg.functionCalls.map((call) => ({ functionCall: { name: call.name, args: call.args || {} } }));
  }
  if (msg.functionResponses && msg.functionResponses.length > 0) {
    return msg.functionResponses.map((fr) => ({ functionResponse: { name: fr.name, response: asObject(fr.response) } }));
  }
  if (msg.name && msg.args && msg.role === "model") return [{ functionCall: { name: msg.name, args: msg.args } }];
  if (msg.role === "tool" && (msg.name || msg.content)) {
    return [{ functionResponse: { name: msg.name || "unknown", response: asObject(parseToolContent(msg.content)) } }];
  }
  if (msg.content) return [{ text: msg.content }];
  return [];
}

const readableText = (parts) => (parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();

function parseToolContent(content) {
  if (content == null) return { result: null };
  if (typeof content === "object") return content;
  try { return JSON.parse(content); } catch { return { result: String(content) }; }
}

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : { result: value });

module.exports = { getHistory, saveHistory, appendMessages, toGeminiHistory, fromGeminiHistory };