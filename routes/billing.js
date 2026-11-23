const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const billing = require("../billing.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();

// 1. Get available plans (Public)
router.get("/plans", wrap(async (_req, res) => {
  const plans = await db.all("SELECT * FROM plans WHERE active = 1 ORDER BY sort_order ASC");
  res.json({ plans });
}));

// 2. Create a checkout session (Requires Auth)
router.post("/checkout", auth.requireAuth, wrap(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw new HttpError(400, "Plan ID required");

  // If using mock payments, mark as paid immediately and return success
  if (process.env.PAYMENTS_MOCK === "true") {
    const inv = await billing.createInvoice(req.user.tenant_id, planId, "mock");
    await billing.markInvoicePaid(inv.invoiceId, `mock_${Date.now()}`, "manual");
    return res.json({ ok: true, mock: true, message: "Mock payment successful. Tenant activated." });
  }

  // REAL FLUTTERWAVE LOGIC (For later):
  // const inv = await billing.createInvoice(req.user.tenant_id, planId, "flutterwave");
  // const flwUrl = await createFlutterwaveLink(inv);
  // res.json({ ok: true, checkoutUrl: flwUrl });

  res.status(501).json({ error: "Real payments not configured yet. Set PAYMENTS_MOCK=true." });
}));

// 3. Webhook for Flutterwave (Public, verifies signatures)
router.post("/webhook", wrap(async (req, res) => {
  // Verify signature (Flutterwave uses a secret hash)
  const secretHash = process.env.FLW_SECRET_HASH;
  const signature = req.headers["verif-hash"];

  if (secretHash && signature !== secretHash) {
    return res.status(401).send("Invalid signature");
  }

  const payload = req.body;
  
  // Log raw event
  await db.run(
    `INSERT INTO payment_events (provider, event_type, provider_ref, payload, signature_ok, received_at) 
     VALUES ('flutterwave', ?, ?, ?, 1, UTC_TIMESTAMP(3))`,
    [payload.event || "unknown", payload.data?.tx_ref || null, JSON.stringify(payload)]
  );

  // If charge is successful, mark invoice paid
  if (payload.event === "charge.completed" && payload.data.status === "successful") {
    const invoiceNumber = payload.data.tx_ref;
    const invoice = await db.one("SELECT id FROM invoices WHERE number = ?", [invoiceNumber]);
    if (invoice) {
      await billing.markInvoicePaid(invoice.id, payload.data.id, "flutterwave");
    }
  }

  res.status(200).send("OK");
}));

// 4. Run Expiration Check (Can be called by a cron job or Super Admin)
router.post("/run-expirations", wrap(async (req, res) => {
  // In production, this should be protected by a secret token or Super Admin check.
  await billing.processExpirations();
  res.json({ ok: true, message: "Expirations processed." });
}));

module.exports = router;