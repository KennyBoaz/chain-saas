/**
 * tools.js  (multi-tenant)
 *
 * The functions Gemini can ask us to run, their declarations, and executeTool().
 * ctx = { tenantId, profile, phone, customerName } - the REAL chat identity. We trust it over
 * anything the AI typed into the arguments, and every query is filtered by ctx.tenantId.
 *
 * Per-tenant settings come from tenants.business_profile_json (saved by PUT /api/tenant/profile):
 *   {
 *     "hours": "mon-sat 09:00-19:00; sun 10:00-16:00",   // days not listed = closed
 *     "appointmentMinutes": 60,
 *     "utcOffsetHours": 3,                                // Kampala = 3 (default)
 *     "delivery": "...", "payment": "...", "returns": "..."   // used by gemini.js
 *   }
 *
 * .env:  PAUSE_BOT_ON_ESCALATION=true|false  (default false)
 */

const { Type } = require("@google/genai");
const db = require("./db.js");
const chatStore = require("./chatStore.js");
const { notifyTeam } = require("./alerts.js");

const PAUSE_BOT_ON_ESCALATION = String(process.env.PAUSE_BOT_ON_ESCALATION || "false").toLowerCase() === "true";

function makeId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}${rand}`;
}

function clip(value, max) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

// ---------------------------------------------------------------------------
// Opening hours and appointment slots (per tenant)
// ---------------------------------------------------------------------------

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_HOURS = "mon-sat 09:00-18:00";
const NOTICE_MINUTES = 30;

function parseHours(text) {
  const hours = {};
  String(text || "").split(";").forEach((part) => {
    const m = part.trim().toLowerCase().match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const from = DAY_NAMES.indexOf(m[1]);
    const to = m[2] ? DAY_NAMES.indexOf(m[2]) : from;
    const open = Number(m[3]) * 60 + Number(m[4]);
    const close = Number(m[5]) * 60 + Number(m[6]);
    if (from < 0 || to < 0 || close <= open) return;
    let day = from;
    for (let n = 0; n < 7; n += 1) {
      hours[day] = [open, close];
      if (day === to) break;
      day = (day + 1) % 7;
    }
  });
  return hours;
}

function hoursFor(profile) {
  const parsed = parseHours((profile && profile.hours) || DEFAULT_HOURS);
  return Object.keys(parsed).length ? parsed : parseHours(DEFAULT_HOURS);
}

const slotMinutes = (profile) => Math.max(15, Number(profile && profile.appointmentMinutes) || 60);
const offsetMs = (profile) => (Number.isFinite(Number(profile && profile.utcOffsetHours)) ? Number(profile.utcOffsetHours) : 3) * 3600 * 1000;

const minutesToTime = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");

function clockText(min) {
  const h24 = Math.floor(min / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

function describeHours(profile) {
  const HOURS = hoursFor(profile);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  order.forEach((day) => {
    const range = HOURS[day];
    if (!range) return;
    const last = groups[groups.length - 1];
    if (last && last.range[0] === range[0] && last.range[1] === range[1] && last.days[last.days.length - 1] === order[order.indexOf(day) - 1]) last.days.push(day);
    else groups.push({ days: [day], range });
  });
  const text = groups.map((g) => {
    const label = g.days.length === 1 ? DAY_LONG[g.days[0]] : `${DAY_LONG[g.days[0]]} to ${DAY_LONG[g.days[g.days.length - 1]]}`;
    return `${label} ${clockText(g.range[0])} - ${clockText(g.range[1])}`;
  }).join("; ");
  const closed = order.filter((d) => !HOURS[d]).map((d) => DAY_LONG[d]);
  return text + (closed.length ? `; closed on ${closed.join(", ")}` : "");
}

function normalizeTime(value) {
  const m = String(value === undefined || value === null ? "" : value).trim().toLowerCase().replace(/\./g, "").match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

const toMinutes = (hhmm) => (hhmm ? hhmm.split(":").map(Number).reduce((h, m) => h * 60 + m) : null);

function parseDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return { weekday: d.getUTCDay() };
}

function localNow(profile, now = Date.now()) {
  const d = new Date(now + offsetMs(profile));
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

async function availableSlots(ctx, dateStr, nowMs = Date.now()) {
  const profile = ctx.profile || {};
  const parsed = parseDate(dateStr);
  if (!parsed) return { error: "Use a real date in YYYY-MM-DD format, for example 2026-10-12." };
  const today = localNow(profile, nowMs);
  if (dateStr < today.date) return { error: `That date has already passed. Today is ${today.date}.` };

  const range = hoursFor(profile)[parsed.weekday];
  if (!range) return { closed: true, slots: [], isFree: () => false };

  const SLOT = slotMinutes(profile);
  const booked = (await db.all(
    "SELECT appt_time FROM appointments WHERE tenant_id = ? AND appt_date = ? AND status IN ('new','in_progress')",
    [ctx.tenantId, dateStr]
  )).map((row) => toMinutes(normalizeTime(row.appt_time))).filter((n) => n !== null);

  const isFree = (min) =>
    min >= range[0] && min + SLOT <= range[1] &&
    !(dateStr === today.date && min < today.minutes + NOTICE_MINUTES) &&
    !booked.some((b) => Math.abs(b - min) < SLOT);

  const slots = [];
  for (let min = range[0]; min + SLOT <= range[1]; min += SLOT) if (isFree(min)) slots.push(minutesToTime(min));
  return { closed: false, slots, isFree };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function check_availability({ date, time } = {}, ctx) {
  const res = await availableSlots(ctx, date);
  if (res.error) return { date: date || null, error: res.error };
  const requested = normalizeTime(time);
  return {
    date,
    store_closed_that_day: Boolean(res.closed),
    opening_hours: describeHours(ctx.profile),
    appointment_length_minutes: slotMinutes(ctx.profile),
    available_slots: res.slots,
    requested_time: requested,
    requested_time_available: requested ? res.slots.includes(requested) : null,
    note: res.closed ? "The business is closed on that day." : res.slots.length === 0 ? "No free slots remain on that day." : undefined,
  };
}

async function book_appointment({ name, phone, date, time, purpose } = {}, ctx) {
  const when = normalizeTime(time);
  if (!when) return { success: false, reason: "A specific time is needed, for example 14:00 or 2pm." };
  const res = await availableSlots(ctx, date);
  if (res.error) return { success: false, reason: res.error };
  if (res.closed) return { success: false, reason: "The business is closed on that day.", opening_hours: describeHours(ctx.profile) };
  if (!res.isFree(toMinutes(when))) {
    return { success: false, reason: "That time is not available (outside opening hours, in the past, or already booked).", available_slots: res.slots, opening_hours: describeHours(ctx.profile) };
  }

  const ref = makeId("APT");
  await db.run(
    `INSERT INTO appointments
       (tenant_id, ref, phone, contact_phone, name, appt_date, appt_time, purpose, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [ctx.tenantId, ref, clip(ctx.phone || phone, 32), clip(phone, 40), clip(name || ctx.customerName, 150), date, when, clip(purpose, 500)]
  );

  notifyTeam(ctx.tenantId, { type: "appointment", phone: ctx.phone, name: name || ctx.customerName, title: "New appointment request", text: `${date} at ${when}${purpose ? " - " + purpose : ""}` }).catch(() => {});
  return { success: true, appointment_id: ref, name: name || null, phone: phone || null, date, time: when, purpose: purpose || null, message: "Appointment booked. A team member will confirm if needed." };
}

async function log_inquiry({ category, summary, details, follow_up_needed } = {}, ctx) {
  const ref = makeId("INQ");
  const follow = follow_up_needed !== false;
  const text = (category ? `[${String(category).slice(0, 40)}] ` : "") + (details || "");

  await db.run(
    `INSERT INTO issues
       (tenant_id, ref, type, phone, customer_name, summary, details, status, resolution_note, resolved_at, created_at, updated_at)
     VALUES (?, ?, 'inquiry', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [ctx.tenantId, ref, clip(ctx.phone, 32), clip(ctx.customerName, 150), summary || "Customer inquiry", text || null,
     follow ? "new" : "resolved", follow ? null : "No follow-up needed", follow ? null : new Date()]
  );
  if (follow) {
    notifyTeam(ctx.tenantId, { type: "inquiry", phone: ctx.phone, name: ctx.customerName, title: "New inquiry", text: summary }).catch(() => {});
  }
  return { success: true, inquiry_id: ref, message: "Inquiry noted for the team." };
}

async function search_products({ query, category } = {}, ctx) {
  const terms = String(query || "").replace(/[%_\\]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4);
  const where = ["tenant_id = ?", "active = 1"];
  const params = [ctx.tenantId];
  terms.forEach((term) => {
    where.push("(name LIKE ? OR brand LIKE ? OR category LIKE ? OR details LIKE ?)");
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
  });
  if (category) {
    where.push("category LIKE ?");
    params.push(`%${String(category).replace(/[%_\\]/g, " ").trim()}%`);
  }
  const rows = await db.all(`SELECT name, brand, category, price_ugx, stock, details FROM products WHERE ${where.join(" AND ")} ORDER BY name LIMIT 6`, params);
  if (rows.length === 0) {
    return { found: 0, message: "Nothing like that is in the price list. Do not guess a price or stock level: say you will check with the team and log an inquiry." };
  }
  return {
    found: rows.length,
    items: rows.map((r) => ({
      name: r.name, brand: r.brand || null, category: r.category || null,
      price: r.price_ugx === null || r.price_ugx === undefined ? "price on request" : "UGX " + Number(r.price_ugx).toLocaleString("en-US"),
      stock: { in_stock: "in stock", low: "low stock", out: "out of stock" }[r.stock] || r.stock,
      details: r.details || null,
    })),
  };
}

async function create_order({ items, quantity, delivery_address, delivery_date, customer_name, phone } = {}, ctx) {
  const itemList = Array.isArray(items) ? items : items ? [String(items)] : [];
  const ref = makeId("ORD");

  await db.run(
    `INSERT INTO orders
       (tenant_id, ref, phone, contact_phone, customer_name, items, quantity, delivery_address, delivery_date, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [ctx.tenantId, ref, clip(ctx.phone || phone, 32), clip(phone, 40), clip(customer_name || ctx.customerName, 150),
     JSON.stringify(itemList), clip(quantity, 100), clip(delivery_address, 500), clip(delivery_date, 60)]
  );

  notifyTeam(ctx.tenantId, { type: "order", phone: ctx.phone, name: customer_name || ctx.customerName, title: "New order", text: itemList.join(", ") + (quantity ? ` (qty ${quantity})` : "") }).catch(() => {});
  return {
    success: true, order_ref: ref, items: itemList, quantity: quantity ?? null,
    delivery_address: delivery_address || null, delivery_date: delivery_date || null,
    message: "Order logged. The team will follow up to confirm stock and delivery.",
  };
}

async function create_support_ticket({ order_ref, issue_description, customer_name, phone } = {}, ctx) {
  const ref = makeId("TCK");
  await db.run(
    `INSERT INTO issues
       (tenant_id, ref, type, phone, contact_phone, customer_name, order_ref, summary, status, created_at, updated_at)
     VALUES (?, ?, 'support', ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [ctx.tenantId, ref, clip(ctx.phone || phone, 32), clip(phone, 40), clip(customer_name || ctx.customerName, 150), clip(order_ref, 40), issue_description || null]
  );
  notifyTeam(ctx.tenantId, { type: "inquiry", phone: ctx.phone, name: customer_name || ctx.customerName, title: "New support ticket", text: issue_description }).catch(() => {});
  return { success: true, ticket_id: ref, order_ref: order_ref || null, message: "Support ticket created. The team will get back to the customer." };
}

async function escalate_to_human({ reason, conversation_summary } = {}, ctx) {
  const ref = makeId("ESC");
  await db.run(
    `INSERT INTO issues (tenant_id, ref, type, phone, customer_name, summary, details, status, created_at, updated_at)
     VALUES (?, ?, 'escalation', ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [ctx.tenantId, ref, clip(ctx.phone, 32), clip(ctx.customerName, 150), reason || null, conversation_summary || null]
  );

  if (ctx.phone) {
    try {
      await chatStore.markEscalated(ctx.tenantId, ctx.phone, { pauseBot: PAUSE_BOT_ON_ESCALATION });
    } catch (err) {
      console.error("[tool] Could not flag the conversation as escalated:", err.message);
    }
  }
  console.error(`[tool] HUMAN HANDOFF tenant ${ctx.tenantId} ${ref} +${ctx.phone || "?"}: ${reason}`);

  notifyTeam(ctx.tenantId, { type: "escalation", phone: ctx.phone, name: ctx.customerName, title: "Customer needs a person", text: [reason, conversation_summary].filter(Boolean).join("\n") }).catch(() => {});
  return { success: true, escalation_id: ref, message: "A human teammate has been alerted. Stay with the customer and let them know someone will follow up." };
}

const implementations = { check_availability, book_appointment, log_inquiry, search_products, create_order, create_support_ticket, escalate_to_human };

/** Never throws: errors come back as { error } so the model can explain them. */
async function executeTool(name, args, ctx) {
  const fn = implementations[name];
  if (!fn) return { error: `Unknown function: ${name}` };
  try {
    const result = await fn(args || {}, ctx);
    return result && typeof result === "object" ? result : { result };
  } catch (err) {
    console.error(`[tool] ${name} failed:`, err);
    return { error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Declarations sent to Gemini
// ---------------------------------------------------------------------------

const S = (description) => ({ type: Type.STRING, description });

const functionDeclarations = [
  {
    name: "check_availability",
    description: "Look up REAL free appointment slots for a date from the appointments diary and the business's opening hours. Always call this before offering appointment times. Dates must be YYYY-MM-DD.",
    parameters: { type: Type.OBJECT, properties: { date: S("Date to check as YYYY-MM-DD. Work it out from today's date if the customer says 'tomorrow' or 'Monday'."), time: S("Optional preferred time, e.g. 14:00 or 2pm.") }, required: ["date"] },
  },
  {
    name: "book_appointment",
    description: "Book an appointment ONLY after the customer has confirmed a slot that check_availability showed as free. If it fails, offer the alternative slots it returns.",
    parameters: { type: Type.OBJECT, properties: { name: S("Customer's full name."), phone: S("Customer's WhatsApp / phone number."), date: S("Appointment date as YYYY-MM-DD."), time: S("Appointment time, e.g. 14:00."), purpose: S("Why they want the appointment.") }, required: ["name", "phone", "date", "time"] },
  },
  {
    name: "create_order",
    description: "Create an order after the customer has confirmed what they want, how much, and where/when to deliver.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of product names the customer wants." },
        quantity: S("Quantity, e.g. '2' or '3 crates'."), delivery_address: S("Where to deliver the order."),
        delivery_date: S("Requested delivery date, preferably YYYY-MM-DD."), customer_name: S("Customer's full name."), phone: S("Customer's WhatsApp / phone number."),
      },
      required: ["items", "quantity", "customer_name", "phone"],
    },
  },
  {
    name: "create_support_ticket",
    description: "Open a support ticket when a customer has a problem with an order or needs follow-up that is not a new booking.",
    parameters: { type: Type.OBJECT, properties: { order_ref: S("Existing order reference if the customer has one."), issue_description: S("What went wrong, in the customer's words."), customer_name: S("Customer's full name."), phone: S("Customer's WhatsApp / phone number.") }, required: ["issue_description", "customer_name", "phone"] },
  },
  {
    name: "escalate_to_human",
    description: "Hand the conversation to a human teammate. Use when the customer asks for a person, is upset, or the assistant cannot help.",
    parameters: { type: Type.OBJECT, properties: { reason: S("Short reason for the handoff."), conversation_summary: S("A brief summary of the conversation so far, so the human can pick it up.") }, required: ["reason", "conversation_summary"] },
  },
  {
    name: "log_inquiry",
    description: "Record a customer's interest or question for the team (a product, price, availability, sizing, a visit) when they are NOT placing an order or booking. Use it quietly, without mentioning it to the customer, then keep helping. Set follow_up_needed true if the team should contact them.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: S("One of: product, pricing, availability, sizing, delivery, visit, other."),
        summary: S("One short line, e.g. 'Wants black leather belt for a party, asked exact price'."),
        details: S("Useful details: item, size, occasion, budget, when they need it."),
        follow_up_needed: { type: Type.BOOLEAN, description: "True if a team member should contact the customer." },
      },
      required: ["summary"],
    },
  },
  {
    name: "search_products",
    description: "Look up CONFIRMED prices and stock in the business's price list. Call this whenever a customer asks about a specific item, brand, price or availability, and quote only what it returns. If nothing is found, never guess.",
    parameters: { type: Type.OBJECT, properties: { query: S("Words to search for, e.g. 'santoni loafers' or 'amouage'."), category: S("Optional category, e.g. shoes, fragrances, belts, suits.") }, required: ["query"] },
  },
];

module.exports = { describeHours, normalizeTime, executeTool, functionDeclarations };