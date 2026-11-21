const { GoogleGenAI, Type } = require("@google/genai");
const db = require("./db.js");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Define the tools the AI can use
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

async function generateReply(tenantId, phone, userMessage) {
  // 1. Get the tenant's custom persona
  const tenant = await db.one("SELECT business_name, system_prompt FROM tenants WHERE id = ?", [tenantId]);
  
  const defaultPrompt = `You are a helpful customer service assistant for ${tenant.business_name}. Keep answers brief and polite. If a customer wants to book an appointment, create an order, or report an issue, use your tools.`;
  const systemPrompt = tenant.system_prompt || defaultPrompt;

  // 2. Start the chat
  const chat = ai.chats.create({
    model: MODEL,
    config: {
      systemInstruction: systemPrompt,
      tools: tools,
      maxOutputTokens: 500
    }
  });

  try {
    // 3. Send user message
    let response = await chat.sendMessage({ message: userMessage });

    // 4. Check if Gemini wants to call a function
    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      let toolResult = {};

      // 5. Execute the requested tool locally
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

      // 6. Send the tool result back to Gemini so it can formulate a final text reply
      response = await chat.sendMessage({
        message: [{
          functionResponse: {
            name: call.name,
            response: toolResult
          }
        }]
      });
    }

    return response.text || "I'm sorry, I couldn't generate a reply.";
  } catch (err) {
    console.error("[Gemini] Error:", err.message);
    return "Sorry, our AI assistant is currently offline. A human will reply soon.";
  }
}

module.exports = { generateReply };