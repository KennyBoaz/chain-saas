const { GoogleGenAI, Type } = require("@google/genai");
const db = require("./db.js");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// The fallback chain for maximum uptime
const FALLBACK_MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-2.5-flash",
  "gemini-1.5-flash"
];

const tools = [{
  functionDeclarations: [
    {
      name: "book_appointment",
      description: "Book an appointment for the customer.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          date: { type: Type.STRING, description: "Date in YYYY-MM-DD format" },
          time: { type: Type.STRING, description: "Time, e.g., 14:00" },
          purpose: { type: Type.STRING, description: "Reason for appointment" }
        },
        required: ["date", "time", "purpose"]
      }
    },
    {
      name: "create_order",
      description: "Create a new order for products.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          items: { type: Type.STRING, description: "List of items ordered" },
          address: { type: Type.STRING, description: "Delivery address" }
        },
        required: ["items", "address"]
      }
    },
    {
      name: "create_support_ticket",
      description: "Create a support ticket if the user has a problem.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING, description: "Short summary of the issue" },
          details: { type: Type.STRING, description: "Full details of the complaint" }
        },
        required: ["summary", "details"]
      }
    }
  ]
}];

// Helper: Only send what's inside <reply> tags to the customer
function extractReply(text) {
  const match = String(text).match(/<reply>([\s\S]*?)<\/reply>/i);
  if (match && match[1].trim()) return match[1].trim();
  return String(text).replace(/<\/?reply>/gi, "").trim();
}

async function generateReply(tenantId, phone, userMessage) {
  // 1. Get the tenant's custom persona
  const tenant = await db.one("SELECT business_name, system_prompt FROM tenants WHERE id = ?", [tenantId]);
  
  // We enforce the <reply> tag rule to prevent the AI from writing its thoughts
  const defaultPrompt = `You are a helpful customer service assistant for ${tenant.business_name}. Keep answers brief and polite. If a customer wants to book an appointment, create an order, or report an issue, use your tools. ALWAYS put your final answer to the customer inside <reply> and </reply> tags. Never include your internal planning.`;
  
  const systemPrompt = tenant.system_prompt 
    ? `${tenant.system_prompt}\n\nIMPORTANT: ALWAYS put your final answer to the customer inside <reply> and </reply> tags.`
    : defaultPrompt;

  let lastError = null;

  // 2. Try each model in the fallback chain
  for (const modelName of FALLBACK_MODELS) {
    try {
      console.log(`[Gemini] Attempting generation with ${modelName}...`);
      
      const chat = ai.chats.create({
        model: modelName,
        config: {
          systemInstruction: systemPrompt,
          tools: tools,
          maxOutputTokens: 500
        }
      });

      let response = await chat.sendMessage({ message: userMessage });

      // 3. Check if Gemini wants to call a function
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        let toolResult = {};

        // 4. Execute the requested tool locally (Multi-tenant safe)
        if (call.name === "book_appointment") {
          const args = call.args;
          const ref = "APT-" + Math.floor(Math.random() * 1000000);
          await db.run(`
            INSERT INTO appointments (tenant_id, ref, phone, appt_date, appt_time, purpose, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          `, [tenantId, ref, phone, args.date, args.time, args.purpose]);
          toolResult = { success: true, reference: ref, message: "Appointment booked." };
        } 
        else if (call.name === "create_order") {
          const args = call.args;
          const ref = "ORD-" + Math.floor(Math.random() * 1000000);
          await db.run(`
            INSERT INTO orders (tenant_id, ref, phone, items, delivery_address, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          `, [tenantId, ref, phone, args.items, args.address]);
          toolResult = { success: true, reference: ref, message: "Order created." };
        }
        else if (call.name === "create_support_ticket") {
          const args = call.args;
          const ref = "TKT-" + Math.floor(Math.random() * 1000000);
          await db.run(`
            INSERT INTO issues (tenant_id, ref, type, phone, summary, details, status, created_at, updated_at)
            VALUES (?, ?, 'support', ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          `, [tenantId, ref, phone, args.summary, args.details]);
          toolResult = { success: true, reference: ref, message: "Ticket created." };
        }

        // 5. Send the tool result back to Gemini so it can formulate the final text
        response = await chat.sendMessage({
          message: [{
            functionResponse: {
              name: call.name,
              response: toolResult
            }
          }]
        });
      }

      // 6. Success! Extract the clean reply and return it
      const rawText = response.text || "I'm sorry, I couldn't generate a reply.";
      return extractReply(rawText);

    } catch (err) {
      console.warn(`[Gemini] Model ${modelName} failed: ${err.message}. Trying next fallback...`);
      lastError = err;
    }
  }

  // If all models fail
  console.error("[Gemini] All models failed. Last error:", lastError.message);
  return "Sorry, our AI assistant is currently offline. A human will reply soon.";
}

module.exports = { generateReply };