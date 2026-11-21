/**
 * server.js — Phase 0 boot.
 * Mounts: /health, /, /manifest.webmanifest, /sw.js, /icons/*, /offline.html
 * Later phases add: /api/auth, /api/tenant, /api/billing, /webhook, /admin, /app
 */

// ADD THESE IMPORTS AT THE TOP: phase 1
const authRoutes = require("./routes/auth.js");
const tenantRoutes = require("./routes/tenant.js");
//

require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const auth = require("./auth.js");
const tenantContext = require("./tenantContext.js");
const health = require("./routes/health.js");

const app = express();
app.set("query parser", "simple");
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const MOUNT_PREFIX = process.env.APP_MOUNT_PREFIX || "";
const router = express.Router();

router.use(auth.loadSession);
router.use(tenantContext.loadTenant);

// ---- Health & root ----
router.use(health);

// ---- API Routes ----
router.use("/api/auth", authRoutes);
router.use("/api/tenant", tenantRoutes);
router.use("/api/auth", require("./routes/auth.js"));
router.use("/api/tenant", require("./routes/tenant.js"));
router.use("/api/billing", require("./routes/billing.js"));
router.use("/api/platform", require("./routes/platform.js")); 
router.use("/api/whatsapp", require("./routes/whatsapp.js")); // <-- ADD THIS
router.use("/webhook", require("./routes/webhook.js"));       // <-- ADD THIS
router.use("/api/chats", require("./routes/chats.js")); // Add this line
// <-- ADD THIS LINE


// ---- PWA static assets (Phase 0 placeholder) ----
const PUBLIC = path.join(__dirname, "public");
router.use(
  express.static(PUBLIC, {
    setHeaders(res, filePath) {
      if (filePath.endsWith("sw.js")) {
        res.setHeader("Cache-Control", "no-cache");
      }
      if (filePath.endsWith("manifest.json") || filePath.endsWith("manifest.webmanifest")) {
        res.setHeader("Content-Type", "application/manifest+json");
      }
    },
  })
);

// ---- 404 for /api/* ----
router.use("/api", (_req, res) => res.status(404).json({ error: "Not found.", code: "NO_ROUTE" }));

// ---- JSON error handler ----
app.use(router);
if (MOUNT_PREFIX) app.use(MOUNT_PREFIX, router);

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error("[server] Unhandled error:", err);
  res.status(status).json({ error: status >= 500 ? "Server error." : err.message || "Bad request." });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[boot] Chain SaaS listening on :${PORT}  prefix="${MOUNT_PREFIX || "/"}"`);
});