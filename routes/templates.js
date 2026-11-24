/**
 * routes/templates.js  mounted at /api/templates
 * List, create and delete WhatsApp message templates for the signed-in tenant's WABA.
 * (Needs whatsapp_business_management. Creating templates is one of the two things Meta's app review asks to see.)
 */
const express = require("express");
const auth = require("../auth.js");
const wa = require("../whatsapp.js");
const { HttpError, wrap } = require("../apiUtil.js");

const router = express.Router();
router.use(auth.requireAuth);
router.use(auth.checkCsrf);

async function connection(req) {
  const conn = await wa.loadConnection(req.user.tenant_id);
  if (!conn || !conn.wabaId) throw new HttpError(409, "Connect WhatsApp from the Dashboard first.");
  return conn;
}
const metaError = (err) => new HttpError(err.response?.status === 400 ? 400 : 502, wa.describeSendError(err));

router.get("/", wrap(async (req, res) => {
  const conn = await connection(req);
  let all;
  try { all = await wa.fetchTemplates(conn); } catch (err) { throw new HttpError(424, "Could not load templates from WhatsApp: " + wa.describeSendError(err)); }
  res.json({
    templates: all.map((t) => ({ ...wa.summariseTemplate(t), status: String(t.status || "").toUpperCase(), category: t.category || null, rejected_reason: t.rejected_reason || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}));

router.post("/", auth.requireTenantAdmin, wrap(async (req, res) => {
  const conn = await connection(req);
  const b = req.body || {};
  const name = String(b.name || "").trim(), body = String(b.body || "").trim();
  const header = String(b.header || "").trim(), footer = String(b.footer || "").trim();
  const examples = (Array.isArray(b.examples) ? b.examples : []).map((x) => String(x || "").trim());

  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new HttpError(400, "Name: use lowercase letters, numbers and underscores only.");
  if (!/^[A-Za-z]{2,3}(_[A-Za-z]{2})?$/.test(String(b.language || ""))) throw new HttpError(400, "Choose a language.");
  if (!["UTILITY", "MARKETING"].includes(b.category)) throw new HttpError(400, "Category must be Utility or Marketing.");
  if (!body || body.length > 1024) throw new HttpError(400, "The message text is required (up to 1024 characters).");
  if (header.length > 60 || /\{\{/.test(header)) throw new HttpError(400, "The header can be up to 60 characters and cannot contain variables.");
  if (footer.length > 60 || /\{\{/.test(footer)) throw new HttpError(400, "The footer can be up to 60 characters and cannot contain variables.");

  const nums = Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => Number(m[1]));
  const count = nums.length ? Math.max(...nums) : 0;
  if (nums.length && Array.from(new Set(nums)).sort((x, y) => x - y).some((n, i) => n !== i + 1)) throw new HttpError(400, "Number the variables {{1}}, {{2}}, {{3}} in order.");
  if (examples.length !== count || examples.some((x) => !x)) throw new HttpError(400, `Add an example value for each of the ${count} variable(s).`);

  try {
    const out = await wa.createTemplate(conn, { name, language: b.language, category: b.category, body, header, footer, examples });
    res.status(201).json({ ok: true, id: out.id || null, status: out.status || "PENDING" });
  } catch (err) {
    throw metaError(err);
  }
}));

router.delete("/:name", auth.requireTenantAdmin, wrap(async (req, res) => {
  const conn = await connection(req);
  if (!/^[a-z0-9_]{1,512}$/.test(req.params.name)) throw new HttpError(400, "Invalid template name.");
  try { await wa.deleteTemplate(conn, req.params.name); } catch (err) { throw metaError(err); }
  res.json({ ok: true });
}));

module.exports = router;