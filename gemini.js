const { GoogleGenAI } = require("@google/genai");
const db = require("./db.js");

// --- CONFIGURATION ---
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";

const MODEL_CANDIDATES = [PRIMARY_MODEL, FALLBACK_MODEL].filter(
  (model, index, arr) => model && arr.indexOf(model) === index
);

const MAX_TOOL_ROUNDS = 6;
const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30000;
const COOLDOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS) || 5 * 60 * 1000;

const modelDownUntil = new Map();
let cachedClient = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in your environment variables.");
  cachedClient = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return cachedClient;
}

// --- MODEL HEALTH & FALLBACKS ---
function markModelDown(model, reason) {
  modelDownUntil.set(model, Date.now() + COOLDOWN_MS);
  console.warn(`[gemini] Marking "${model}" as unavailable for ${Math.round(COOLDOWN_MS / 1000)}s (${reason}).`);
}

function orderedModels() {
  const now = Date.now();
  const healthy = [];
  const down = [];
  for (const model of MODEL_CANDIDATES) {
    if ((modelDownUntil.get(model) || 0) > now) down.push(model);
    else healthy.push(model);
  }
  return [...healthy, ...down];
}

// --- ERROR CLASSIFICATION ---
function isRateLimitError(err) {
  const status = err.status || err.statusCode || err.response?.status;
  const message = String(err.message || "");
  return status === 429 || /429/.test(message) || /RESOURCE_EXHAUSTED/i.test(message) || /quota/i.test(message);
}

function isRetryableServerError(err) {
  const status = err.status || err.statusCode || err.response?.status;
  const message = String(err.message || "");
  const name = String(err.name || "");
  return (
    [500, 502, 503, 504].includes(status) ||
    /UNAVAILABLE/i.test(message) ||
    /high demand/i.test(message) ||
    /internal error/i.test(message) ||
    /timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message) ||
    name === "AbortError" || name === "TimeoutError"
  );
}

// --- RESILIENT SEND (Retries + Fallbacks) ---
async function sendResilient({ ai, models, chat, history, config, messageOrParts }) {
  let activeChat = chat;
  let lastErr;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    if (modelIndex > 0) {
      activeChat = ai.chats.create({ model, history, config });
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        const response = await activeChat.sendMessage({ message: messageOrParts });
        return { response, chat: activeChat, model };
      } catch (err) {
        lastErr = err;

        if (isRateLimitError(err)) {
          markModelDown(model, "429 rate limit");
          break;
        }

        if (isRetryableServerError(err)) {
          if (attempt < MAX_ATTEMPTS_PER_MODEL && err.status !== 504) {
            await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
            continue;
          }
          markModelDown(model, `still failing after ${attempt} attempts`);
          break;
        }
        throw err;
      }
    }
  }
  throw lastErr;
}

// --- TOOLS DEFINITION ---
const functionDeclarations = [
  {
    name: "book_appointment",
    description: "Book an appointment for the customer.",
    parameters: {
      type: "OBJECT",
      properties: {
        date: { type: "STRING", description: "Date in YYYY-MM-DD format" },
        time: { type: "STRING", description: "Time, e.g., 14:00" },
        purpose: { type: "STRING", description: "Reason for appointment" }
      },
      required: ["date", "time", "purpose"]
    }
  },
  {
    name: "create_order",
    description: "Create a new order for products.",
    parameters: {
      type: "OBJECT",
      properties: {
        items: { type: "STRING", description: "List of items ordered" },
        address: { type: "STRING", description: "Delivery address" }
      },
      required: ["items", "address"]
    }
  },
  {
    name: "create_support_ticket",
    description: "Create a support ticket if the user has a problem.",
    parameters: {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING", description: "Short summary of the issue" },
        details: { type: "STRING", description: "Full details of the complaint" }
      },
      required: ["summary", "details"]
    }
  }
];

const tools = [{ functionDeclarations }];

// --- TOOL EXECUTOR (Multi-tenant safe) ---
async function executeTool(name, args, tenantId, phone) {
  if (name === "book_appointment") {
    const ref = "APT-" + Math.floor(Math.random() * 1000000);
    await db.run(`
      INSERT INTO appointments (tenant_id, ref, phone, appt_date, appt_time, purpose, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [tenantId, ref, phone, args.date, args.time, args.purpose]);
    return { success: true, reference: ref, message: "Appointment booked." };
  } 
  else if (name === "create_order") {
    const ref = "ORD-" + Math.floor(Math.random() * 1000000);
    await db.run(`
      INSERT INTO orders (tenant_id, ref, phone, items, delivery_address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [tenantId, ref, phone, args.items, args.address]);
    return { success: true, reference: ref, message: "Order created." };
  }
  else if (name === "create_support_ticket") {
    const ref = "TKT-" + Math.floor(Math.random() * 1000000);
    await db.run(`
      INSERT INTO issues (tenant_id, ref, type, phone, summary, details, status, created_at, updated_at)
      VALUES (?, ?, 'support', ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [tenantId, ref, phone, args.summary, args.details]);
    return { success: true, reference: ref, message: "Ticket created." };
  }
  return { error: "Unknown tool" };
}

// --- STRIP THINKING / PLANNING ---
function extractReply(text) {
  const raw = String(text || "").trim();
  const closed = raw.match(/<reply>([\s\S]*?)<\/reply>/i);
  if (closed && closed[1].trim()) return closed[1].trim();
  const open = raw.match(/<reply>([\s\S]*)$/i);
  if (open && open[1].trim()) return open[1].trim();
  return raw.replace(/<\/?reply>/gi, "").trim();
}

// --- MAIN ENTRY POINT ---
async function generateReply(tenantId, phone, userMessage, attachments = []) {
  const ai = getClient();
  
  // Fetch tenant custom prompt
  const tenant = await db.one("SELECT business_name, system_prompt FROM tenants WHERE id = ?", [tenantId]);
  const defaultPrompt = `You are a helpful customer service assistant for ${tenant.business_name}. Keep answers brief and polite.`;
  
  const systemPrompt = `
${tenant.system_prompt || defaultPrompt}

ADDITIONAL RULES (take priority):
- OUTPUT FORMAT: write ONLY the message the customer will read, inside <reply> and </reply> tags. Put nothing outside the tags. Never write planning or notes to yourself.
- Today's date: ${new Date().toISOString().slice(0, 10)}
- Customer phone: ${phone}
  `.trim();

  const config = {
    systemInstruction: systemPrompt,
    tools: tools,
    automaticFunctionCalling: { disable: true },
  };

  let models = orderedModels();
  let chat = ai.chats.create({ model: models[0], config });

  // Handle photo/PDF attachments (Vision)
  const withFiles = attachments.length
    ? [...attachments.map((a) => ({ inlineData: { mimeType: a.mimeType, data: a.data } })), { text: userMessage }]
    : userMessage;

  let response;
  try {
    let result = await sendResilient({ ai, models, chat, history: [], config, messageOrParts: withFiles });
    response = result.response;
    chat = result.chat;
    models = models.slice(models.indexOf(result.model));
  } catch (err) {
    console.error("[gemini] Initial send failed:", err.message);
    return "Sorry, I am having a technical problem right now. Please try again shortly.";
  }

  // --- TOOL CALLING LOOP ---
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      const rawText = response.text || "";
      return extractReply(rawText) || "Sorry, I couldn't generate a reply.";
    }

    const functionResponseParts = [];
    for (const call of calls) {
      console.log(`[gemini] Executing tool: ${call.name}`);
      const toolResult = await executeTool(call.name, call.args, tenantId, phone);
      functionResponseParts.push({
        functionResponse: { name: call.name, response: toolResult }
      });
    }

    try {
      const result = await sendResilient({ 
        ai, models, chat, history: chat.getHistory(), config, messageOrParts: functionResponseParts 
      });
      response = result.response;
      chat = result.chat;
      models = models.slice(models.indexOf(result.model));
    } catch (err) {
      console.error("[gemini] Tool loop failed:", err.message);
      return "I need to check on that with the team. Someone will follow up shortly.";
    }
  }

  return "I need to check on that with the team. Someone will follow up shortly.";
}

module.exports = { generateReply };