const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const auth = require("../auth.js");
const cryptoHelper = require("../crypto.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// 1. Summary (for badges and filters)
router.get("/summary", auth.requireAuth, wrap(async (req, res) => {
  const tenantId = req.user.tenant_id;
  const row = await db.one(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND status = 'escalated') AS escalated_chats,
      (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND mode = 'human' AND status <> 'resolved') AS human_chats,
      (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND unread_count > 0 AND status <> 'resolved') AS unread_chats,
      (SELECT COUNT(*) FROM issues WHERE tenant_id = ? AND status = 'new') AS new_issues,
      (SELECT COUNT(*) FROM orders WHERE tenant_id = ? AND status = 'new') AS new_orders,
      (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND status = 'new') AS new_appointments
  `, [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId]);
  
  const summary = {};
  for (const [key, value] of Object.entries(row)) summary[key] = Number(value) || 0;
  res.json({ summary });
}));

// 2. Conversation List with Filters
router.get("/conversations", auth.requireAuth, wrap(async (req, res) => {
  const tenantId = req.user.tenant_id;
  const filter = String(req.query.filter || "active");
  const where = ["c.tenant_id = ?"];
  const params = [tenantId];

  switch (filter) {
    case "unread": where.push("c.unread_count > 0"); break;
    case "human": where.push("c.mode = 'human'"); break;
    case "escalated": where.push("c.status = 'escalated'"); break;
    case "resolved": where.push("c.status = 'resolved'"); break;
    case "active": where.push("c.status <> 'resolved'"); break;
  }

  const term = String(req.query.search || "").trim();
  if (term) {
    where.push("(cu.display_name LIKE ? OR cu.whatsapp_name LIKE ? OR c.phone LIKE ?)");
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }

  const rows = await db.all(`
    SELECT c.phone, c.mode, c.status, c.unread_count, c.pinned,
           c.last_message_at, c.last_message_preview,
           COALESCE(cu.display_name, cu.whatsapp_name) AS name,
           (SELECT COUNT(*) FROM issues i WHERE i.tenant_id = c.tenant_id AND i.phone = c.phone AND i.status IN ('new','in_progress')) AS open_issues,
           (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone AND o.status IN ('new','in_progress')) AS open_orders
    FROM conversations c
    JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.phone = c.phone
    WHERE ${where.join(" AND ")}
    ORDER BY c.pinned DESC, (c.status = 'escalated') DESC, COALESCE(c.last_message_at, c.created_at) DESC
    LIMIT 50
  `, params);

  res.json({ conversations: rows });
}));

// 3. Chat Details (Customer + Orders + Tickets)
router.get("/conversations/:phone", auth.requireAuth, wrap(async (req, res) => {
  const tenantId = req.user.tenant_id;
  const phone = req.params.phone;

  const conversation = await db.one(`
    SELECT c.*, COALESCE(cu.display_name, cu.whatsapp_name) AS name 
    FROM conversations c
    JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.phone = c.phone
    WHERE c.tenant_id = ? AND c.phone = ?
  `, [tenantId, phone]);

  if (!conversation) throw new HttpError(404, "Chat not found.");

  const customer = await db.one("SELECT * FROM customers WHERE tenant_id = ? AND phone = ?", [tenantId, phone]);
  const orders = await db.all("SELECT * FROM orders WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 10", [tenantId, phone]);
  const issues = await db.all("SELECT * FROM issues WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 10", [tenantId, phone]);
  const appointments = await db.all("SELECT * FROM appointments WHERE tenant_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 10", [tenantId, phone]);

  res.json({ conversation, customer, orders, issues, appointments });
}));

// 4. Messages
router.get("/conversations/:phone/messages", auth.requireAuth, wrap(async (req, res) => {
  const messages = await db.all(`
    SELECT id, direction, sender_type, staff_id, msg_type, body, delivery_status, error_text, created_at, reaction, customer_reaction, starred
    FROM messages 
    WHERE tenant_id = ? AND phone = ? 
    ORDER BY created_at ASC LIMIT 100
  `, [req.user.tenant_id, req.params.phone]);
  res.json({ messages });
}));

// 5. Send Message
router.post("/conversations/:phone/messages", auth.requireAuth, wrap(async (req, res) => {
  const { text } = req.body;
  const customerPhone = req.params.phone;
  const tenantId = req.user.tenant_id;

  const conn = await db.one("SELECT phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
  if (!conn) throw new HttpError(400, "WhatsApp not connected.");

  const accessToken = cryptoHelper.decryptString(conn.access_token_enc);
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/messages`,
      { messaging_product: "whatsapp", to: customerPhone, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error("[Meta Send Error]", err.response?.data || err.message);
    throw new HttpError(502, "Failed to send via WhatsApp.");
  }

  const result = await db.run(`
    INSERT INTO messages (tenant_id, phone, direction, sender_type, staff_id, body, delivery_status, created_at)
    VALUES (?, ?, 'out', 'staff', ?, ?, 'sent', UTC_TIMESTAMP(3))
  `, [tenantId, customerPhone, req.user.id, text]);

  await db.run(`
    UPDATE conversations SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ?, mode = 'human' 
    WHERE tenant_id = ? AND phone = ?
  `, [text, tenantId, customerPhone]);

  const newMessage = await db.one("SELECT * FROM messages WHERE id = ?", [result.insertId]);
  res.status(201).json({ messages: [newMessage] });
}));

// 6. Chat Actions (Takeover, Handback, Resolve)
router.post("/conversations/:phone/takeover", auth.requireAuth, wrap(async (req, res) => {
  await db.run("UPDATE conversations SET mode = 'human', assigned_to = ? WHERE tenant_id = ? AND phone = ?", [req.user.id, req.user.tenant_id, req.params.phone]);
  res.json({ ok: true });
}));

router.post("/conversations/:phone/handback", auth.requireAuth, wrap(async (req, res) => {
  await db.run("UPDATE conversations SET mode = 'bot', assigned_to = NULL WHERE tenant_id = ? AND phone = ?", [req.user.tenant_id, req.params.phone]);
  res.json({ ok: true });
}));

router.post("/conversations/:phone/resolve", auth.requireAuth, wrap(async (req, res) => {
  await db.run("UPDATE conversations SET status = 'resolved' WHERE tenant_id = ? AND phone = ?", [req.user.tenant_id, req.params.phone]);
  res.json({ ok: true });
}));

// 7. Demo Data
router.post("/seed-demo", auth.requireAuth, wrap(async (req, res) => {
  const tenantId = req.user.tenant_id;
  const demoPhones = ["256701234567", "256772345678", "256753456789"];
  
  for (const phone of demoPhones) {
    await db.run("INSERT IGNORE INTO customers (tenant_id, phone, whatsapp_name, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))", [tenantId, phone, "Demo Customer " + phone.slice(-4)]);
    
    await db.run(`
      INSERT INTO conversations (tenant_id, phone, mode, status, last_message_at, last_message_preview, created_at)
      VALUES (?, ?, 'bot', 'open', UTC_TIMESTAMP(3), 'I would like to know the price of solar panels.', UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE last_message_at = UTC_TIMESTAMP(3)
    `, [tenantId, phone]);

    const msgs = [
      ["in", "customer", "Hello, do you have solar panels in stock?"],
      ["out", "bot", "Yes! We have 200W and 300W panels available. Which one are you interested in?"],
      ["in", "customer", "I would like to know the price of solar panels."]
    ];
    
    for (const [dir, sender, body] of msgs) {
      await db.run(
        "INSERT INTO messages (tenant_id, phone, direction, sender_type, body, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [tenantId, phone, dir, sender, body]
      );
    }

    // Add a dummy ticket
    await db.run(`
      INSERT INTO issues (tenant_id, ref, type, phone, summary, status, created_at, updated_at)
      VALUES (?, ?, 'support', ?, 'Customer wants to know shipping fees.', 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [tenantId, "TKT-" + Math.floor(Math.random()*10000), phone]);
  }
  
  res.json({ ok: true });
}));


// ==========================================
// GLOBAL LISTS (Tickets, Orders, Appointments)
// ==========================================

router.get("/tickets", auth.requireAuth, wrap(async (req, res) => {
  const tickets = await db.all(`
    SELECT i.*, c.name AS customer_name 
    FROM issues i
    LEFT JOIN (SELECT phone, COALESCE(display_name, whatsapp_name) AS name FROM customers WHERE tenant_id = ?) c 
      ON c.phone = i.phone
    WHERE i.tenant_id = ? 
    ORDER BY i.created_at DESC LIMIT 50
  `, [req.user.tenant_id, req.user.tenant_id]);
  res.json({ tickets });
}));

router.get("/orders", auth.requireAuth, wrap(async (req, res) => {
  const orders = await db.all(`
    SELECT o.*, c.name AS customer_name 
    FROM orders o
    LEFT JOIN (SELECT phone, COALESCE(display_name, whatsapp_name) AS name FROM customers WHERE tenant_id = ?) c 
      ON c.phone = o.phone
    WHERE o.tenant_id = ? 
    ORDER BY o.created_at DESC LIMIT 50
  `, [req.user.tenant_id, req.user.tenant_id]);
  res.json({ orders });
}));

router.get("/appointments", auth.requireAuth, wrap(async (req, res) => {
  const appts = await db.all(`
    SELECT a.*, c.name AS customer_name 
    FROM appointments a
    LEFT JOIN (SELECT phone, COALESCE(display_name, whatsapp_name) AS name FROM customers WHERE tenant_id = ?) c 
      ON c.phone = a.phone
    WHERE a.tenant_id = ? 
    ORDER BY a.appt_date DESC LIMIT 50
  `, [req.user.tenant_id, req.user.tenant_id]);
  res.json({ appointments: appts });
}));

// ==========================================
// MEDIA UPLOAD
// ==========================================
const { uploadChatMedia } = require("../media.js");

router.post("/conversations/:phone/media", auth.requireAuth, uploadChatMedia.single("file"), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, "No file uploaded.");
  const tenantId = req.user.tenant_id;
  const phone = req.params.phone;
  
  // 1. Get WhatsApp Connection
  const conn = await db.one("SELECT phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
  if (!conn) throw new HttpError(400, "WhatsApp not connected.");

  // 2. Upload media to Meta (Requires a multipart form-data request)
  const accessToken = cryptoHelper.decryptString(conn.access_token_enc);
  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", fs.createReadStream(req.file.path), req.file.originalname);
  form.append("type", req.file.mimetype);
  form.append("messaging_product", "whatsapp");

  try {
    const uploadRes = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` } }
    );
    const mediaId = uploadRes.data.id;

    // 3. Send the Media Message
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/messages`,
      { messaging_product: "whatsapp", to: phone, type: "image", image: { id: mediaId } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // 4. Save to DB
    const result = await db.run(`
      INSERT INTO messages (tenant_id, phone, direction, sender_type, staff_id, msg_type, body, has_media, media_mime, media_name, created_at)
      VALUES (?, ?, 'out', 'staff', ?, 'image', '[Image Attached]', 1, ?, ?, UTC_TIMESTAMP(3))
    `, [tenantId, phone, req.user.id, req.file.mimetype, req.file.originalname]);

    await db.run(`
      UPDATE conversations SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = '[Image Attached]', mode = 'human' 
      WHERE tenant_id = ? AND phone = ?
    `, [tenantId, phone]);

    const newMessage = await db.one("SELECT * FROM messages WHERE id = ?", [result.insertId]);
    res.status(201).json({ messages: [newMessage] });

  } catch (err) {
    console.error("[Meta Media Error]", err.response?.data || err.message);
    throw new HttpError(502, "Failed to send media via WhatsApp.");
  } finally {
  }
}));

module.exports = router;