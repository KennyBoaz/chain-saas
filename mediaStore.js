/**
 * mediaStore.js  (multi-tenant) - NOT a replacement for media.js (uploads for logos/chat still use that)
 *
 * Keeps the photos, voice notes, videos and documents of chats. Files are stored privately at
 *     <MEDIA_DIR>/<tenantId>/<messageId>
 * (never inside the public folder). They are only handed out by a logged-in API route that
 * checks the message belongs to the caller's tenant (added in Phase 2).
 *
 * .env (optional): MEDIA_DIR (default ./storage/media), MEDIA_MAX_MB (16), GEMINI_SEE_MEDIA, GEMINI_MAX_ATTACHMENT_MB (4)
 * Automatic cleanup of old files is added in Phase 2.
 */

const fs = require("fs");
const path = require("path");
const db = require("./db.js");
const whatsapp = require("./whatsapp.js");

const DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(__dirname, "storage", "media");
const MAX_BYTES = Math.max(1, Number(process.env.MEDIA_MAX_MB) || 16) * 1024 * 1024;

const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr",
  "video/mp4", "video/3gpp",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeMime = (mime) => String(mime || "").split(";")[0].trim().toLowerCase();
const isAllowed = (mime) => ALLOWED.has(normalizeMime(mime));

function sniffOk(buffer, mime) {
  const type = normalizeMime(mime);
  const head = buffer.subarray(0, 12);
  if (type === "image/jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === "image/png") return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (type === "image/webp") return head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP";
  if (type === "application/pdf") return head.subarray(0, 4).toString() === "%PDF";
  return true;
}

function cleanName(name, fallback) {
  const text = String(name || "").replace(/[\u0000-\u001f\\/:*?"<>|]+/g, "_").trim().slice(0, 120);
  return text || fallback;
}

function defaultName(type, mime) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf", "text/plain": "txt" }[normalizeMime(mime)];
  return (type || "file") + (ext ? "." + ext : "");
}

function pathFor(tenantId, messageId) {
  const t = Number(tenantId), id = Number(messageId);
  if (!Number.isInteger(t) || t < 1 || !Number.isInteger(id) || id < 1) throw new Error("bad media id");
  return path.join(DIR, String(t), String(id));
}

async function save(tenantId, messageId, buffer) {
  const target = pathFor(tenantId, messageId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  const temp = `${target}.tmp`;
  await fs.promises.writeFile(temp, buffer, { mode: 0o640 });
  await fs.promises.rename(temp, target);
}

/**
 * Download a customer's file from WhatsApp (links expire in minutes), keep it, mark the message.
 * Throws on failure; the chat keeps working without the file.
 * Returns { mime, size, buffer } so the bot can look at a photo / PDF without downloading again.
 */
async function attach(tenantId, conn, messageId, phone, media) {
  if (!media || !media.id) return null;

  let got;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      got = await whatsapp.downloadMedia(conn, media.id, { maxBytes: MAX_BYTES });
      break;
    } catch (err) {
      if (err.code === "TOO_LARGE" || attempt === 2) throw err;
      await sleep(1500);
    }
  }

  const mime = normalizeMime(got.mime || media.mime);
  if (!isAllowed(mime)) throw new Error(`file type not kept (${mime || "unknown"})`);
  if (!sniffOk(got.buffer, mime)) throw new Error(`file content does not match its type (${mime})`);

  await save(tenantId, messageId, got.buffer);
  await db.run(
    "UPDATE messages SET has_media = 1, media_mime = ?, media_name = ?, media_size = ? WHERE id = ? AND tenant_id = ?",
    [mime, cleanName(media.filename, defaultName(media.type, mime)), got.size, messageId, tenantId]
  );
  console.error(`[media] tenant ${tenantId}: saved ${mime} (${got.size} bytes) for message ${messageId} from ${phone}.`);
  return { mime, size: got.size, buffer: got.buffer };
}

const AI_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const AI_MAX_BYTES = Math.max(1, Number(process.env.GEMINI_MAX_ATTACHMENT_MB) || 4) * 1024 * 1024;

function canShowToAi(kept) {
  if (/^(false|0|no|off)$/i.test(String(process.env.GEMINI_SEE_MEDIA || ""))) return false;
  return Boolean(kept && AI_MIMES.has(kept.mime) && kept.size <= AI_MAX_BYTES);
}

module.exports = { DIR, MAX_BYTES, ALLOWED, normalizeMime, isAllowed, sniffOk, cleanName, defaultName, pathFor, save, attach, canShowToAi };