const db = require("./db.js");
const audit = require("./audit.js");
const crypto = require("crypto");

/**
 * Creates a pending invoice for a tenant.
 */
async function createInvoice(tenantId, planId, provider = "flutterwave") {
  const plan = await db.one("SELECT * FROM plans WHERE id = ?", [planId]);
  if (!plan) throw new Error("Plan not found");

  const number = `INV-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  
  const result = await db.run(
    `INSERT INTO invoices (tenant_id, number, amount_ugx, status, provider, created_at) 
     VALUES (?, ?, ?, 'pending', ?, UTC_TIMESTAMP(3))`,
    [tenantId, number, plan.amount_ugx, provider]
  );

  return { invoiceId: result.insertId, number, amount: plan.amount_ugx, plan };
}

/**
 * Marks an invoice as paid and activates the subscription.
 * Used by webhooks (Flutterwave), Super Admin (Cash), and Mock Checkout.
 */
async function markInvoicePaid(invoiceId, providerRef, provider = "manual", actorId = null) {
  const invoice = await db.one("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice || invoice.status === "paid") return;

  await db.tx(async (t) => {
    // 1. Mark invoice paid
    await t.run(
      `UPDATE invoices SET status = 'paid', provider_ref = ?, paid_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [providerRef, invoiceId]
    );

    // 2. Figure out which plan was bought (we assume the highest active plan for now, or pass it in)
    // For simplicity, let's grab the most expensive plan if not specified, or the first one.
    const plan = await t.one("SELECT * FROM plans WHERE active = 1 ORDER BY sort_order DESC LIMIT 1");
    
    // 3. Create or extend subscription (30 days)
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    await t.run(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, source, created_at, updated_at)
       VALUES (?, ?, 'active', UTC_TIMESTAMP(3), ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [invoice.tenant_id, plan.id, periodEnd, provider]
    );

    // 4. Update Tenant Status
    await t.run(
      `UPDATE tenants SET status = 'active', billing_status = 'active', updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [invoice.tenant_id]
    );
  });

  await audit.log({
    tenantId: invoice.tenant_id,
    actorType: actorId ? "platform_staff" : "system",
    actorId: actorId,
    action: "billing.invoice_paid",
    targetType: "invoice",
    targetId: invoiceId,
    detail: { provider, providerRef }
  });
}

/**
 * Cron job logic: Checks for expired subscriptions and applies grace periods.
 */
async function processExpirations() {
  // Find active tenants whose latest subscription ended
  const expired = await db.all(`
    SELECT t.id, t.status, s.current_period_end
    FROM tenants t
    JOIN subscriptions s ON s.tenant_id = t.id
    WHERE s.status = 'active' 
      AND s.current_period_end < UTC_TIMESTAMP(3)
      AND t.status = 'active'
  `);

  for (const tenant of expired) {
    // 1. Move to read_only
    await db.run("UPDATE tenants SET status = 'read_only', billing_status = 'read_only' WHERE id = ?", [tenant.id]);
    await db.run("UPDATE subscriptions SET status = 'read_only' WHERE tenant_id = ? AND status = 'active'", [tenant.id]);
    
    // Set read-only expiry (3 days from now)
    const readOnlyUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await db.run(
      "UPDATE subscriptions SET read_only_until = ? WHERE tenant_id = ? AND status = 'read_only'",
      [readOnlyUntil, tenant.id]
    );
  }

  // Find read_only tenants whose 3 days have passed
  const suspended = await db.all(`
    SELECT tenant_id FROM subscriptions 
    WHERE status = 'read_only' AND read_only_until < UTC_TIMESTAMP(3)
  `);

  for (const sub of suspended) {
    // 2. Move to suspended
    await db.run("UPDATE tenants SET status = 'suspended', billing_status = 'suspended' WHERE id = ?", [sub.tenant_id]);
    await db.run("UPDATE subscriptions SET status = 'suspended' WHERE tenant_id = ? AND status = 'read_only'", [sub.tenant_id]);
    
    // Note: Disconnecting WhatsApp will happen in Phase 3 by checking tenant status.
  }
}

module.exports = { createInvoice, markInvoicePaid, processExpirations };