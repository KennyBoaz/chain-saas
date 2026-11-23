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
// 2. CHAT MEDIA DIRECTORY
// ==========================================
const CHAT_MEDIA_DIR = path.join(__dirname, "public", "uploads", "chat");
if (!fs.existsSync(CHAT_MEDIA_DIR)) fs.mkdirSync(CHAT_MEDIA_DIR, { recursive: true });

// ==========================================
// 3. DOWNLOAD INCOMING MEDIA (Webhook)
// ==========================================
// Handles image, video, audio, document. Returns { localUrl, base64, mimeType }
async function downloadIncomingMedia(tenantId, mediaId, msgType) {
  try {
    const conn = await db.one("SELECT access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
    if (!conn) throw new Error("No WhatsApp connection for tenant");
    
    const accessToken = cryptoHelper.decryptString(conn.access_token_enc);
    const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

    // 1. Get Media URL and MIME type from Meta
    const metaRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    const mediaUrl = metaRes.data.url;
    const mimeType = metaRes.data.mime_type || "application/octet-stream";

    // 2. Determine correct extension
    let ext = "bin";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
    else if (mimeType.includes("png")) ext = "png";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("mp4")) ext = "mp4";
    else if (mimeType.includes("3gpp")) ext = "3gp";
    else if (mimeType.includes("ogg")) ext = "ogg";
    else if (mimeType.includes("mpeg")) ext = "mp3";
    else if (mimeType.includes("pdf")) ext = "pdf";
    else if (mimeType.includes("word")) ext = "docx";
    else if (mimeType.includes("sheet")) ext = "xlsx";
    else if (mimeType.split("/")[1]) ext = mimeType.split("/")[1].split(";")[0];

    // 3. Download the raw bytes
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer"
    });

    // 4. Save to disk
    const filename = `${mediaId}.${ext}`;
    const filepath = path.join(CHAT_MEDIA_DIR, filename);
    fs.writeFileSync(filepath, fileRes.data);

    // 5. Convert to base64 for Gemini (only for images and PDFs)
    let base64Data = null;
    if (msgType === "image" || msgType === "document") {
      if (mimeType.includes("image") || mimeType.includes("pdf")) {
        base64Data = fileRes.data.toString("base64");
      }
    }

    return {
      localUrl: `/uploads/chat/${filename}`,
      mimeType,
      base64Data
    };

  } catch (err) {
    console.error(`[Media] Failed to download ${mediaId}:`, err.message);
    return { localUrl: null, mimeType: null, base64Data: null };
  }
}

// ==========================================
// 4. UPLOAD OUTBOUND MEDIA (Inbox)
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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".mp4", ".mp3", ".ogg", ".docx", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("File type not supported by WhatsApp."));
  },
});

// Helper to send outbound media to Meta
async function sendMediaToMeta(tenantId, phone, filePath, mimeType) {
  const conn = await db.one("SELECT phone_number_id, access_token_enc FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
  if (!conn) throw new Error("No WhatsApp connection for tenant");
  
  const accessToken = cryptoHelper.decryptString(conn.access_token_enc);
  const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";
  
  // 1. Upload Media to Meta
  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("type", mimeType);
  form.append("messaging_product", "whatsapp");

  const uploadRes = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` } }
  );
  
  const mediaId = uploadRes.data.id;

  // 2. Determine message type
  let type = "document";
  if (mimeType.includes("image")) type = "image";
  else if (mimeType.includes("video")) type = "video";
  else if (mimeType.includes("audio")) type = "audio";

  // 3. Send Message
  const sendRes = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${conn.phone_number_id}/messages`,
    { 
      messaging_product: "whatsapp", 
      to: phone, 
      type: type, 
      [type]: { id: mediaId, caption: type === "image" || type === "document" ? "Attached file" : undefined } 
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return sendRes.data.messages?.[0]?.id;
}

module.exports = { 
  upload: uploadLogo, 
  downloadIncomingMedia, 
  uploadChatMedia,
  sendMediaToMeta,
  CHAT_MEDIA_DIR
};