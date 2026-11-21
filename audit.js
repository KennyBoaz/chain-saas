/**
 * audit.js — append-only audit log. Never throws; failures are logged and swallowed.
 */
const db = require("./db.js");

async function log({ tenantId = null, actorType, actorId = null, action, targetType = null, targetId = null, detail = null, ip = null }) {
  try {
    await db.run(
      `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, target_type, target_id, detail_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [tenantId, actorType, actorId, action, targetType, targetId, detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (e) {
    console.error("[audit] failed to write audit log:", e.message);
  }
}

module.exports = { log };