/**
 * chatHelpers.js
 * Small input-cleaning helpers for the chat API (kept here so routes/chats.js does not depend on
 * what apiUtil.js happens to export).
 */

const { HttpError } = require("./apiUtil.js");

/** "256759744057" (digits only, 6-20 long) or an HttpError. */
function parsePhone(value, status = 404) {
  const phone = String(value || "").trim();
  if (!/^\d{6,20}$/.test(phone)) throw new HttpError(status, "That phone number is not valid.", "BAD_PHONE");
  return phone;
}

/** Integer from a query/body value, clamped to [min, max]; `fallback` when missing or not a number. */
function intParam(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A search box value, safe to put inside LIKE '%...%'. */
function searchTerm(value) {
  return String(value || "").replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Text from the request body.
 *   undefined -> undefined (field not sent: leave it alone)
 *   null / "" -> null      (clear it)
 *   string    -> trimmed, clipped to max
 */
function cleanText(value, max) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

module.exports = { parsePhone, intParam, searchTerm, cleanText };