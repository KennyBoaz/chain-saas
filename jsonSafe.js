/**
 * jsonSafe.js
 * MySQL "longtext" JSON columns (tenants.branding_json, business_profile_json) come back as
 * STRINGS, not objects. Always read them through parseJson() so spreading or property access
 * never operates on a string.
 */
function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

module.exports = { parseJson };