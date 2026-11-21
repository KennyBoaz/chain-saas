/**
 * auth.js — session, CSRF, role guards. Cookie-based.
 * Reused pattern from the old single-tenant app, now multi-tenant aware.
 */
const crypto = require("crypto");
const db = require("./db.js");
const { sha256Hex, randomToken } = require("./crypto.js");

const COOKIE = process.env.SESSION_COOKIE_NAME || "chain_sid";
const TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 168) * 3600 * 1000;
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TTL_MS,
};

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
}

async function createSession({ subjectType, subjectId, tenantId, req, res }) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  await db.run(
    `INSERT INTO sessions (token_hash, subject_type, subject_id, tenant_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha256Hex(token), subjectType, subjectId, tenantId ?? null, csrf, clientIp(req),
     (req.headers["user-agent"] || "").slice(0, 255), now, now, expires]
  );
  res.cookie(COOKIE, token, COOKIE_OPTS);
  return { csrf };
}

async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256Hex(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

async function destroyAllSessionsFor(subjectType, subjectId) {
  await db.run("DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?", [subjectType, subjectId]);
}

/**
 * Middleware: attaches req.session (or null) and req.user / req.platformStaff.
 * Always runs; never throws.
 */
async function loadSession(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return next();
    const row = await db.one(
      "SELECT * FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)",
      [sha256Hex(token)]
    );
    if (!row) return next();

    // Touch last_seen at most once per minute
    const last = new Date(row.last_seen_at).getTime();
    if (Date.now() - last > 60_000) {
      db.run("UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?", [row.id]).catch(() => {});
    }

    req.session = row;
    if (row.subject_type === "user") {
      const u = await db.one(
        "SELECT id, tenant_id, name, email, role, active, email_verified_at FROM users WHERE id = ?",
        [row.subject_id]
      );
      if (u && u.active) req.user = u;
    } else if (row.subject_type === "platform_staff") {
      const p = await db.one(
        "SELECT id, name, email, role, active FROM platform_staff WHERE id = ?",
        [row.subject_id]
      );
      if (p && p.active) req.platformStaff = p;
    }
    next();
  } catch (e) {
    console.error("[auth] loadSession failed:", e.message);
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in.", code: "AUTH_REQUIRED" });
  next();
}
function requireTenantAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in.", code: "AUTH_REQUIRED" });
  if (req.user.role !== "tenant_admin") return res.status(403).json({ error: "Admins only.", code: "FORBIDDEN" });
  next();
}
function requireSuperAdmin(req, res, next) {
  if (!req.platformStaff) return res.status(401).json({ error: "Please sign in.", code: "AUTH_REQUIRED" });
  if (req.platformStaff.role !== "super_admin") return res.status(403).json({ error: "Super admin only.", code: "FORBIDDEN" });
  next();
}
function requirePlatformStaff(req, res, next) {
  if (!req.platformStaff) return res.status(401).json({ error: "Please sign in.", code: "AUTH_REQUIRED" });
  next();
}

/** CSRF check for non-GET requests when using cookie sessions. */
function checkCsrf(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const header = req.headers["x-csrf-token"];
  if (!req.session || !header || header !== req.session.csrf_token) {
    return res.status(403).json({ error: "Invalid CSRF token.", code: "CSRF" });
  }
  next();
}

// Simple in-memory rate limiter (per IP, per action). Good enough for Phase 0–3.
const buckets = new Map();
function allowAttempt(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

module.exports = {
  createSession, destroySession, destroyAllSessionsFor,
  loadSession, requireAuth, requireTenantAdmin, requireSuperAdmin, requirePlatformStaff,
  checkCsrf, allowAttempt, clientIp,
};