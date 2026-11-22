/**
 * gemini.js  (multi-tenant)
 *
 * One Gemini turn for one customer of one tenant: history + tools + the tenant's own system prompt.
 *
 * KEY FIXES compared with the first Chain SaaS version
 *  - A model that fails with 404 / "not found" / "not supported" (or 400/403 about the model) no
 *    longer aborts the turn: it is skipped and the next model is tried.
 *  - The customer's conversation history is loaded and saved (the old version had no memory).
 *  - Every failure logs the real error, so the cause is visible in the log.
 *
 * ENV
 *   GEMINI_API_KEY          required (one platform key for all tenants)
 *   GEMINI_MODELS           optional, comma separated, in order of preference
 *                           e.g. "gemini-3.7-flash,gemini-3.8-flash,gemini-2.5-flash"
 *   GEMINI_MODEL / GEMINI_FALLBACK_MODEL   used when GEMINI_MODELS is not set
 *   GEMINI_TIMEOUT_MS (30000)   GEMINI_COOLDOWN_MS (300000)   GEMINI_THINKING_LEVEL (optional)
 */

const { GoogleGenAI } = require("@google/genai");
const { functionDeclarations, executeTool, describeHours } = require("./tools.js");
const { toGeminiHistory, fromGeminiHistory } = require("./memory.js");

const MODEL_CANDIDATES = (
  process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(",").map((s) => s.trim())
    : [process.env.GEMINI_MODEL || "gemini-3.7-flash", process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash"]
).filter((model, i, arr) => model && arr.indexOf(model) === i);

const MAX_TOOL_ROUNDS = 6;
const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30000;
const COOLDOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS) || 5 * 60 * 1000;

const modelDownUntil = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in your .env file.");
  cachedClient = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  return cachedClient;
}

function markModelDown(model, reason) {
  modelDownUntil.set(model, Date.now() + COOLDOWN_MS);
  console.warn(`[gemini] Skipping "${model}" for ${Math.round(COOLDOWN_MS / 1000)}s (${reason}).`);
}

function orderedModels() {
  const now = Date.now();
  const healthy = [], down = [];
  for (const model of MODEL_CANDIDATES) ((modelDownUntil.get(model) || 0) > now ? down : healthy).push(model);
  return [...healthy, ...down];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemInstruction({ tenant, profile, phone, customerName }) {
  const base = (tenant.system_prompt && tenant.system_prompt.trim()) ||
    `You are the WhatsApp assistant for ${tenant.business_name}. Be warm, brief and helpful, like real WhatsApp texting.`;

  const offset = (Number.isFinite(Number(profile.utcOffsetHours)) ? Number(profile.utcOffsetHours) : 3) * 3600 * 1000;
  const today = new Date(Date.now() + offset).toISOString().slice(0, 10);

  const rules = [
    "ADDITIONAL RULES (these take priority over anything above)",
    "- OUTPUT FORMAT: write ONLY the message the customer will read, inside <reply> and </reply> tags, like <reply>Hello!</reply>. Put nothing outside the tags: no planning, no notes to yourself. The customer never sees your thinking.",
    `- Opening hours: ${describeHours(profile)}. Use exactly these if a customer asks.`,
    "- Prices and stock: when a customer asks about a specific item, brand, price or availability, call search_products first and quote ONLY what it returns. If nothing is found, never guess: say you will check with the team and call log_inquiry with follow_up_needed true.",
    "- Appointments: call check_availability for the date before offering times and offer only the slots it returns. Call book_appointment only after the customer confirms a slot. If booking fails, offer the alternative slots it returns. Dates must be YYYY-MM-DD.",
    "- Interest without an order: when a customer shows interest in a product, price or visit but is not ordering or booking, call log_inquiry quietly, then carry on helping. Never mention that you logged it.",
    "- Photos and files: a message like [Customer sent a image: ...] means the customer sent a photo. If the photo or PDF is attached, look at it and use what you see. Never claim you saw something you cannot see. For voice notes, videos or files you cannot open, say so briefly and ask the customer to type what they need, or offer to connect them with a team member.",
  ];
  if (profile.delivery) rules.push(`- Delivery: ${profile.delivery}`);
  if (profile.payment) rules.push(`- Payment: ${profile.payment}`);
  if (profile.returns) rules.push(`- Returns and exchanges: ${profile.returns}`);

  return [base, "", rules.join("\n"), "", `Current customer WhatsApp number: ${phone}`, `Current customer profile name: ${customerName || "unknown"}`, `Today's date: ${today}`].join("\n");
}

function buildChatConfig(args) {
  const config = {
    systemInstruction: buildSystemInstruction(args),
    tools: [{ functionDeclarations }],
    automaticFunctionCalling: { disable: true },
  };
  if (process.env.GEMINI_THINKING_LEVEL) config.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL.toUpperCase() };
  return config;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function getFunctionCalls(response) {
  if (Array.isArray(response?.functionCalls) && response.functionCalls.length) return response.functionCalls;
  return (response?.candidates?.[0]?.content?.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
}

function getText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const fromParts = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
  if (fromParts) return fromParts;
  return typeof response?.text === "string" ? response.text.trim() : "";
}

const normalizeArgs = (args) => {
  if (!args) return {};
  if (typeof args === "string") { try { return JSON.parse(args); } catch { return {}; } }
  return args;
};

// ---------------------------------------------------------------------------
// Keeping the model's planning out of the customer's chat
// ---------------------------------------------------------------------------

const PLANNING_START = [
  /^(?:(?:now|next|okay|ok|so),?\s*)?let'?s\s+(?:acknowledge|reply|respond|give|confirm|ask|reassure|thank|greet|keep|be|warmly|politely|write|draft|say|send)\b/i,
  /^(?:(?:now|next|okay|ok|so),?\s*)?(?:the\s+)?(?:customer|user)\b/i,
  /^(?:(?:now|next|okay|ok|so),?\s*)?i\s+(?:should|need to|will|must)\s+(?:reply|respond|acknowledge|ask|confirm|greet|thank|keep)\b/i,
  /^keep it (?:short|brief|natural)\b/i,
];
const PLANNING_ANYWHERE = /\blet'?s\s+(?:acknowledge|reply|respond|give|confirm|ask|reassure|thank|greet|keep|be|warmly|politely)\b|\bkeep it (?:short|brief|natural)\b|\b1-2 sentences\b|\bthe customer\b/i;

function stripPlanning(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const starts = [0];
  const re = /(?<=[.!?)"\u201d])(?=[A-Z])|\n{2,}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[0] === "") re.lastIndex += 1;
    starts.push(m.index + m[0].length);
  }
  const segments = starts.map((start, i) => raw.slice(start, starts[i + 1] ?? raw.length).trim());
  if (segments.length < 2 || !PLANNING_START.some((rx) => rx.test(segments[0]))) return raw;
  let i = 0;
  while (i < segments.length - 1 && (i === 0 || PLANNING_ANYWHERE.test(segments[i]))) i += 1;
  return raw.slice(starts[i]).trim() || raw;
}

function extractReply(raw) {
  const text = String(raw || "");
  const closed = text.match(/<reply>([\s\S]*?)<\/reply>/i);
  if (closed && closed[1].trim()) return closed[1].trim();
  const open = text.match(/<reply>([\s\S]*)$/i);
  if (open && open[1].trim()) return open[1].trim();
  return stripPlanning(text.replace(/<\/?reply>/gi, ""));
}

const hasToolPart = (entry) => (entry.parts || []).some((p) => p && (p.functionCall || p.functionResponse));
const entryText = (entry) => (typeof entry.content === "string" && entry.content ? entry.content : (entry.parts || []).filter((p) => p && p.text && !p.thought).map((p) => p.text).join("\n"));

function cleanStoredTurn(entry) {
  if (!entry || entry.role !== "model" || hasToolPart(entry)) return entry;
  const text = entryText(entry);
  if (!text) return entry;
  const wanted = `<reply>${extractReply(text)}</reply>`;
  return wanted === text ? entry : { ...entry, content: wanted, parts: [{ text: wanted }] };
}

/** History to save: photos removed (only their text stays), final model answer stored as the clean reply. */
function tidyHistory(entries, reply) {
  const out = (entries || []).map((entry) => (entry && Array.isArray(entry.parts) ? { ...entry, parts: entry.parts.filter((p) => !(p && (p.inlineData || p.fileData))) } : entry));
  if (reply) {
    const last = out[out.length - 1];
    if (last && last.role === "model" && !hasToolPart(last)) {
      const text = `<reply>${reply}</reply>`;
      last.content = text;
      last.parts = [{ text }];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const statusOf = (err) => err.status || err.statusCode || err.response?.status;

const isRateLimitError = (err) => statusOf(err) === 429 || /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(String(err.message || ""));

function isRetryableServerError(err) {
  const m = String(err.message || "");
  const name = String(err.name || "");
  return [500, 502, 503, 504].includes(statusOf(err)) || /UNAVAILABLE|high demand|internal error|timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(m) || name === "AbortError" || name === "TimeoutError";
}

/** This model cannot be used by this key (wrong name, retired, no access): try the next one. */
function isModelUnavailable(err) {
  const s = statusOf(err);
  const m = String(err.message || "");
  return s === 404 || /NOT_FOUND|not found|is not supported|does not exist|not available|PERMISSION_DENIED/i.test(m) || (s === 403 && /model/i.test(m));
}

// ---------------------------------------------------------------------------
// Resilient send (retry + fallback to the next model)
// ---------------------------------------------------------------------------

async function sendResilient({ ai, models, chat, history, config, messageOrParts }) {
  let activeChat = chat;
  let lastErr;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    if (modelIndex > 0) activeChat = ai.chats.create({ model, history, config });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await activeChat.sendMessage({ message: messageOrParts });
        console.log(`[gemini] "${model}" answered in ${Date.now() - startedAt}ms (attempt ${attempt}).`);
        return { response, chat: activeChat, model };
      } catch (err) {
        lastErr = err;
        console.error(`[gemini] "${model}" attempt ${attempt} failed (status ${statusOf(err) || "?"}): ${String(err.message || err).slice(0, 200)}`);

        if (isModelUnavailable(err)) { markModelDown(model, "model not available for this key"); break; }
        if (isRateLimitError(err)) { markModelDown(model, "429 rate limit"); break; }
        if (isRetryableServerError(err)) {
          if (attempt < MAX_ATTEMPTS_PER_MODEL && statusOf(err) !== 504) { await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)); continue; }
          markModelDown(model, `still failing after ${attempt} attempts`);
          break;
        }
        throw err; // a genuinely bad request: switching models will not fix it
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.tenant   the tenants row (id, business_name, system_prompt)
 * @param {object} args.profile  parsed business_profile_json
 * @param {Array}  [args.attachments]  photos / PDFs for THIS reply only: [{ mimeType, data (base64) }]
 * @returns {Promise<{ reply: string, updatedHistory: Array, rateLimited: boolean }>}
 */
async function generateReply({ tenant, profile = {}, userMessage, history, phone, customerName, attachments = [] }) {
  const startedAt = Date.now();
  const ai = getClient();
  const config = buildChatConfig({ tenant, profile, phone, customerName });
  const seedHistory = toGeminiHistory((history || []).map(cleanStoredTurn));
  const toolCtx = { tenantId: tenant.id, profile, phone, customerName };

  let models = orderedModels();
  let chat = ai.chats.create({ model: models[0], history: seedHistory, config });
  console.log(`[gemini] tenant ${tenant.id} turn for ${phone}. Models: ${models.join(" -> ")}${attachments.length ? ` (+${attachments.length} attachment)` : ""}`);

  const withFiles = attachments.length
    ? [...attachments.map((a) => ({ inlineData: { mimeType: a.mimeType, data: a.data } })), { text: userMessage }]
    : userMessage;

  let response;
  try {
    let result;
    try {
      result = await sendResilient({ ai, models, chat, history: seedHistory, config, messageOrParts: withFiles });
    } catch (err) {
      if (attachments.length && !isRateLimitError(err) && !isRetryableServerError(err)) {
        console.warn("[gemini] The attachment was refused. Answering without it.");
        chat = ai.chats.create({ model: models[0], history: seedHistory, config });
        result = await sendResilient({ ai, models, chat, history: seedHistory, config, messageOrParts: userMessage });
      } else {
        throw err;
      }
    }
    response = result.response;
    chat = result.chat;
    models = models.slice(models.indexOf(result.model));
  } catch (err) {
    return handleGeminiError(err, history, userMessage);
  }

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const calls = getFunctionCalls(response);

    if (!calls.length) {
      const reply = extractReply(getText(response));
      const updatedHistory = tidyHistory(fromGeminiHistory(chat.getHistory()), reply);
      console.log(`[timing] Gemini turn finished in ${Date.now() - startedAt}ms (${round - 1} tool round(s)).`);
      if (!reply) {
        console.warn("[gemini] Model returned no text. Using a fallback reply.");
        return { reply: "Sorry, I had trouble putting a reply together. Could you say that again?", updatedHistory, rateLimited: false };
      }
      return { reply, updatedHistory, rateLimited: false };
    }

    console.log(`[gemini] Round ${round}: tools requested: ${calls.map((c) => c.name).join(", ")}`);
    const functionResponseParts = [];
    for (const call of calls) {
      const toolResult = await executeTool(call.name, normalizeArgs(call.args), toolCtx);
      const functionResponse = { name: call.name, response: toolResult };
      if (call.id) functionResponse.id = call.id;
      functionResponseParts.push({ functionResponse });
    }

    try {
      const result = await sendResilient({ ai, models, chat, history: chat.getHistory(), config, messageOrParts: functionResponseParts });
      response = result.response;
      chat = result.chat;
      models = models.slice(models.indexOf(result.model));
    } catch (err) {
      return handleGeminiError(err, history, userMessage);
    }
  }

  console.warn(`[gemini] Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
  return {
    reply: "I need to check on that with the team. Someone will follow up with you shortly.",
    updatedHistory: tidyHistory(fromGeminiHistory(chat.getHistory()), null),
    rateLimited: false,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function withFallbackTurn(history, userMessage, reply) {
  const now = new Date().toISOString();
  return [
    ...(history || []).map(cleanStoredTurn),
    { role: "user", content: userMessage, parts: [{ text: userMessage }], timestamp: now },
    { role: "model", content: `<reply>${reply}</reply>`, parts: [{ text: `<reply>${reply}</reply>` }], timestamp: now },
  ];
}

function handleGeminiError(err, history, userMessage) {
  const rateLimited = isRateLimitError(err);
  console.error(`[gemini] FAILED (${rateLimited ? "rate limit" : "api error"}) status ${statusOf(err) || "?"}: ${err.message || err}`);
  if (err.errorDetails) console.error("[gemini] Details:", JSON.stringify(err.errorDetails));

  const reply = rateLimited
    ? "We are getting a lot of messages right now. Please try again in a moment."
    : "Sorry, I am having a technical problem right now. Please try again shortly.";
  return { reply, updatedHistory: withFallbackTurn(history, userMessage, reply), rateLimited };
}

module.exports = { generateReply, extractReply, stripPlanning, MODEL_CANDIDATES };