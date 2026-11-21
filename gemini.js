const { GoogleGenAI } = require("@google/genai");
const db = require("./db.js");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

async function generateReply(tenantId, userMessage) {
  // 1. Get the tenant's custom persona/branding
  const tenant = await db.one("SELECT business_name, system_prompt, branding_json FROM tenants WHERE id = ?", [tenantId]);
  
  const defaultPrompt = `You are a helpful customer service assistant for ${tenant.business_name}. Keep answers brief and polite.`;
  const systemPrompt = tenant.system_prompt || defaultPrompt;

  // 2. Call Gemini
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMessage,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 250 }
    });
    return response.text || "I'm sorry, I couldn't generate a reply.";
  } catch (err) {
    console.error("[Gemini] Error:", err.message);
    return "Sorry, our AI assistant is currently offline. A human will reply soon.";
  }
}

module.exports = { generateReply };