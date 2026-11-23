class HttpError extends Error {
  constructor(status, message, code = "ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function cleanEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^@]+@[^@]+\.[^@]+$/.test(e) ? e : null;
}

function cleanName(name) {
  const n = String(name || "").trim();
  return n.length >= 2 && n.length <= 150 ? n : null;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

module.exports = { HttpError, wrap, cleanEmail, cleanName, slugify };