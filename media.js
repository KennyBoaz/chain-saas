const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cryptoHelper = require("./crypto.js");
const db = require("./db.js");

// ==========================================
// 1. LOGO UPLOAD (Tenant Settings)
// ==========================================
const LOGO_DIR = path.join(__dirname, "public", "uploads", "logos");
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `tenant-${req.user.tenant_id}-${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [".png", ".jpg", ".jpeg", ".webp"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPG, and WEBP images are allowed."));
    }
  },
});

// ==========================================
// 2. CHAT MEDIA DOWNLOADER (Webhook)
// ==========================================
const CHAT_MEDIA_DIR = path.join(__dirname, "public", "uploads", "chat");
if (!fs.existsSync(CHAT_MEDIA_DIR)) fs.mkdirSync(CHAT_MEDIA_DIR, { recursive: true });

async function downloadAndSaveMedia(tenantId, mediaId, mimeType) {
  try {
    // 1. Get tenant's access token
    const conn = await db.one("SELECT phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
    if (!conn) return null;
    const accessToken = cryptoHelper.decryptString(conn.access_token_enc);

    // 2. Get media URL from Meta
    const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";
    const metaRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const mediaUrl = metaRes.data.url;

    // 3. Download the file
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer"
    });

    // 4. Save to local storage
    const ext = mimeType.split("/")[1]?.split(";")[0] || "bin";
    const filename = `${mediaId}.${ext}`;
    const filepath = path.join(CHAT_MEDIA_DIR, filename);
    fs.writeFileSync(filepath, fileRes.data);

    return `/uploads/chat/${filename}`;
  } catch (err) {
    console.error("[Media] Failed to download:", err.message);
    return null;
  }
}

// ==========================================
// 3. UPLOAD MEDIA FROM STAFF (Inbox)
// ==========================================
const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHAT_MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `staff-${Date.now()}-${Math.floor(Math.random() * 1000)}${ext}`;
    cb(null, unique);
  },
});

const uploadChatMedia = multer({
  storage: chatStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max for chat media
});

// ==========================================
// EXPORTS
// ==========================================
module.exports = { 
  upload: uploadLogo, 
  downloadAndSaveMedia, 
  uploadChatMedia 
};