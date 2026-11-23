const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const media = require("../media.js");
const { wrap } = require("../apiUtil.js");
const audit = require("../audit.js");
const { parseJson } = require("../jsonSafe.js");

const router = express.Router();
router.use(auth.requireAuth);
router.use(auth.requireTenantAdmin);
router.use(auth.checkCsrf); // every write needs the X-CSRF-Token header

const HEX = /^#[0-9a-f]{6}$/i;
const day = (d) => new Date(d).toISOString().slice(0, 10);

// 1. Current tenant (JSON columns come back parsed)
router.get("/me", wrap(async (req, res) => {
  const t = await db.one("SELECT * FROM tenants WHERE id = ?", [req.user.tenant_id]);
  t.branding_json = parseJson(t.branding_json);
  t.business_profile_json = parseJson(t.business_profile_json);
  res.json({ tenant: t });
}));

// 2. Business name, AI system prompt, business profile (hours, delivery, payment, returns, alerts)
router.put("/profile", wrap(async (req, res) => {
  const { businessName, systemPrompt, businessProfile } = req.body;
  const sets = [], params = [];

  if (businessName !== undefined) {
    if (!String(businessName).trim()) return res.status(400).json({ error: "Business name cannot be empty." });
    sets.push("business_name = ?"); params.push(String(businessName).trim().slice(0, 190));
  }
  if (systemPrompt !== undefined) { sets.push("system_prompt = ?"); params.push(String(systemPrompt).slice(0, 20000)); }
  if (businessProfile !== undefined) {
    if (!businessProfile || typeof businessProfile !== "object" || Array.isArray(businessProfile)) return res.status(400).json({ error: "Invalid business profile." });
    const text = JSON.stringify(businessProfile);
    if (text.length > 20000) return res.status(400).json({ error: "Business profile is too long." });
    sets.push("business_profile_json = ?"); params.push(text);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update." });

  sets.push("updated_at = UTC_TIMESTAMP(3)");
  await db.run(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`, [...params, req.user.tenant_id]);
  await audit.log({ tenantId: req.user.tenant_id, actorType: "user", actorId: req.user.id, action: "tenant.profile_update", ip: auth.clientIp(req) });
  res.json({ ok: true });
}));

// 3. Branding (colors, slogan)
router.put("/branding", wrap(async (req, res) => {
  const { primaryColor, secondaryColor, slogan } = req.body;
  if ((primaryColor && !HEX.test(primaryColor)) || (secondaryColor && !HEX.test(secondaryColor))) return res.status(400).json({ error: "Colors must look like #1e3a32." });

  const current = await db.one("SELECT branding_json FROM tenants WHERE id = ?", [req.user.tenant_id]);
  const old = parseJson(current && current.branding_json);
  const branding = {
    ...old,
    primaryColor: primaryColor || old.primaryColor || "#243b32",
    secondaryColor: secondaryColor || old.secondaryColor || "#a8873a",
    slogan: slogan !== undefined ? String(slogan).slice(0, 120) : old.slogan || "",
  };
  await db.run("UPDATE tenants SET branding_json = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [JSON.stringify(branding), req.user.tenant_id]);
  res.json({ ok: true, branding });
}));

// 4. Logo
router.post("/logo", media.upload.single("logo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  const current = await db.one("SELECT branding_json FROM tenants WHERE id = ?", [req.user.tenant_id]);
  const branding = { ...parseJson(current && current.branding_json), logoUrl };
  await db.run("UPDATE tenants SET branding_json = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [JSON.stringify(branding), req.user.tenant_id]);
  res.json({ ok: true, logoUrl });
}));

// 5. Dashboard numbers: subscription, usage, analytics, setup checklist
router.get("/overview", wrap(async (req, res) => {
  const t = req.user.tenant_id;
  const tenant = await db.one("SELECT * FROM tenants WHERE id = ?", [t]);
  const profile = parseJson(tenant.business_profile_json);

  const sub = await db.one(
    `SELECT s.status, s.source, s.current_period_start, s.current_period_end, p.name AS plan_name, p.amount_ugx, p.billing_cycle, p.limits_json
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? ORDER BY s.id DESC LIMIT 1`, [t]);
  const limits = parseJson(sub && sub.limits_json);
  const end = sub ? sub.current_period_end : tenant.trial_ends_at;
  const daysLeft = end ? Math.ceil((new Date(end).getTime() - Date.now()) / 86400000) : null;

  const c = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE tenant_id = ? AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')) AS messages_month,
       (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND active = 1) AS seats_used,
       (SELECT COUNT(*) FROM customers WHERE tenant_id = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL 14 DAY) AS new_customers,
       (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?) AS chats,
       (SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND unread_count > 0 AND status <> 'resolved') AS unread_chats,
       (SELECT COUNT(*) FROM orders WHERE tenant_id = ?) AS orders,
       (SELECT COUNT(*) FROM appointments WHERE tenant_id = ?) AS appointments,
       (SELECT COUNT(*) FROM issues WHERE tenant_id = ? AND type <> 'escalation') AS tickets,
       (SELECT COUNT(*) FROM issues WHERE tenant_id = ? AND type = 'escalation') AS handoffs,
       EXISTS(SELECT 1 FROM messages WHERE tenant_id = ? AND direction = 'in') AS got_message`,
    Array(10).fill(t));

  const rows = await db.all(
    `SELECT DATE(created_at) AS d, SUM(direction = 'in') AS inbound, SUM(sender_type = 'bot') AS bot, SUM(sender_type = 'staff') AS staff
       FROM messages WHERE tenant_id = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL 14 DAY GROUP BY DATE(created_at)`, [t]);
  const byDay = new Map(rows.map((r) => [day(r.d), r]));
  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = day(Date.now() - i * 86400000), r = byDay.get(d) || {};
    daily.push({ d, inbound: Number(r.inbound) || 0, bot: Number(r.bot) || 0, staff: Number(r.staff) || 0 });
  }

  const wa = await db.one("SELECT phone_number_id, connected_at FROM whatsapp_connection WHERE tenant_id = ?", [t]);
  const n = (v) => Number(v) || 0;

  res.json({
    tenant: { name: tenant.business_name, status: tenant.status, billingStatus: tenant.billing_status },
    subscription: sub ? { plan: sub.plan_name, amount_ugx: n(sub.amount_ugx), cycle: sub.billing_cycle, status: sub.status, source: sub.source, period_start: sub.current_period_start, period_end: sub.current_period_end, days_left: daysLeft } : { plan: null, status: tenant.billing_status, trial: true, period_end: end || null, days_left: daysLeft },
    usage: { messages_month: n(c.messages_month), messages_limit: n(limits.messages_per_month), seats_used: n(c.seats_used), seats_limit: n(limits.staff_seats) },
    totals: { chats: n(c.chats), unread_chats: n(c.unread_chats), new_customers: n(c.new_customers), orders: n(c.orders), appointments: n(c.appointments), tickets: n(c.tickets), handoffs: n(c.handoffs) },
    daily,
    whatsapp: wa ? { connected: true, phone_number_id: wa.phone_number_id, connected_at: wa.connected_at } : { connected: false },
    checklist: { whatsapp: Boolean(wa), prompt: Boolean(tenant.system_prompt && tenant.system_prompt.trim()), hours: Boolean(profile.hours), tested: Boolean(n(c.got_message)) },
  });
}));

module.exports = router;