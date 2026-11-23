/**
 * alerts.js (Phase 1 placeholder)
 *
 * Every place that should alert the team already calls notifyTeam(tenantId, event), so when
 * Phase 3 adds per-tenant email / SMS (ported from the Wina Classic alerts.js) nothing else changes.
 * In-dashboard alerts (chime, toast, browser notification) do not need this file: the dashboard
 * polls /api/chats/summary and reacts to changes.
 */
async function notifyTeam(tenantId, event = {}) {
  console.error(`[alerts] tenant ${tenantId}: ${event.type || "info"} - ${event.title || ""} ${event.phone ? "(+" + event.phone + ")" : ""}`);
  return { sent: [], skipped: "email/SMS alerts are added in Phase 3" };
}

module.exports = { notifyTeam };