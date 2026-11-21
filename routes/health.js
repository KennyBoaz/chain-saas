const express = require("express");
const db = require("../db.js");

const router = express.Router();

router.get("/health", async (_req, res) => {
  let dbOk = false;
  try { dbOk = await db.ping(); } catch (_) {}
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk,
    service: "chain-saas",
    version: require("../package.json").version,
    time: new Date().toISOString(),
  });
});

router.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Chain Innovation SaaS platform is running.\n" +
    "Health: GET /health\n" +
    "Admin dashboard: /admin/  (coming in Phase 5)\n"
  );
});

module.exports = router;