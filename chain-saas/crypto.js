/**
 * crypto.js — password hashing (scrypt) + AES-256-GCM for DB-stored tokens.
 */
const crypto = require("crypto");

// ---------- Passwords ----------
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 64;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("base64");
    crypto.scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt}$${key.toString("base64")}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    try {
      const parts = String(stored).split("$");
      if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
      const [, N, r, p, salt, hashB64] = parts;
      const expected = Buffer.from(hashB64, "base64");
      crypto.scrypt(password, salt, expected.length,
        { N: Number(N), r: Number(r), p: Number(p) },
        (err, key) => {
          if (err) return reject(err);
          resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
        });
    } catch (e) { reject(e); }
  });
}

// ---------- Symmetric encryption (AES-256-GCM) ----------
function _key() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return buf;
}

function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.cipher, all base64
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decryptString(blob) {
  const parts = String(blob).split(".");
  if (parts.length !== 3) throw new Error("Bad ciphertext format");
  const [ivB64, tagB64, encB64] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", _key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
}

// ---------- Random tokens ----------
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
function sha256Hex(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

module.exports = { hashPassword, verifyPassword, encryptString, decryptString, randomToken, sha256Hex };