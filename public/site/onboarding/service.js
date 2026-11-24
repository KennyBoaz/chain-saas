/** WhatsApp onboarding: turns the result of Meta's Embedded Signup into a saved, working connection. */
const axios = require("axios");
const nodeCrypto = require("crypto");
const db = require("../../db.js");
const cryptoHelper = require("../../crypto.js");
const wa = require("../../whatsapp.js");
const audit = require("../../audit.js");
const { HttpError } = require("../../apiUtil.js");

const GRAPH = process.env.META_GRAPH_VERSION || "v26.0";

function config() {
  const shared = process.env.META_CONFIG_ID || "";
  return {
    appId: process.env.META_APP_ID || "",
    graphVersion: GRAPH,
    configIds: { coexistence: process.env.META_CONFIG_ID_COEXISTENCE || shared, api: process.env.META_CONFIG_ID_API || shared },
  };
}

async function exchangeCode(code) {
  try {
    const r = await axios.get(`https://graph.facebook.com/${GRAPH}/oauth/access_token`, {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code },
    });
    if (!r.data.access_token) throw new Error("no token returned");
    return r.data.access_token;
  } catch (err) {
    console.error("[onboarding] Token exchange failed:", err.response?.data || err.message);
    throw new HttpError(502, "Meta did not accept the sign-up code. Please start again.");
  }
}

/**
 * @param {{ tenantId:number, userId:number, ip:string, type:"api"|"coexistence", code:string, wabaId:string, phoneNumberId?:string }} a
 */
async function connect(a) {
  const { tenantId, type, wabaId } = a;
  const token = await exchangeCode(a.code);
  let phoneNumberId = a.phoneNumberId || null;

  // Coexistence reports only the WABA id, so look up its phone number (a coexistence account holds exactly one).
  if (!phoneNumberId) {
    let numbers = [];
    try { numbers = await wa.getPhoneNumbers(token, wabaId); } catch (err) { throw new HttpError(502, "Could not read the WhatsApp number from Meta: " + wa.describeSendError(err)); }
    if (!numbers.length) throw new HttpError(409, "Meta did not return a WhatsApp number for this account. Please finish the Meta steps and try again.");
    phoneNumberId = numbers[0].id;
  }

  let info = {};
  try { info = await wa.getPhoneInfo(token, phoneNumberId); } catch { /* display details are optional */ }

  try {
    await wa.subscribeWaba(token, wabaId);
  } catch (err) {
    throw new HttpError(502, "Connected, but Meta would not start sending messages to Chain: " + wa.describeSendError(err));
  }

  let pinEnc = null;
  if (type === "api") {
    const pin = String(nodeCrypto.randomInt(0, 1000000)).padStart(6, "0");
    try {
      await wa.registerPhone(token, phoneNumberId, pin);
    } catch (err) {
      throw new HttpError(502, "Meta could not register this number for the API: " + wa.describeSendError(err));
    }
    pinEnc = cryptoHelper.encryptString(pin);
  }

  try {
    await db.run(
      `INSERT INTO whatsapp_connection
         (tenant_id, waba_id, phone_number_id, display_phone, verified_name, access_token_enc, pin_enc, mode, connected_by, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE waba_id = VALUES(waba_id), phone_number_id = VALUES(phone_number_id), display_phone = VALUES(display_phone),
         verified_name = VALUES(verified_name), access_token_enc = VALUES(access_token_enc), pin_enc = VALUES(pin_enc), mode = VALUES(mode), updated_at = UTC_TIMESTAMP(3)`,
      [tenantId, wabaId, phoneNumberId, info.display_phone_number || null, info.verified_name || null, cryptoHelper.encryptString(token), pinEnc, type, a.userId]
    );
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") throw new HttpError(500, "The database needs the WhatsApp onboarding update (modules/whatsapp-onboarding/migration.sql).");
    throw err;
  }

  await audit.log({ tenantId, actorType: "user", actorId: a.userId, action: "whatsapp.connected." + type, ip: a.ip });
  return { phone: info.display_phone_number || null, name: info.verified_name || null, type };
}

async function disconnect(tenantId, userId, ip) {
  const conn = await wa.loadConnection(tenantId);
  if (conn && conn.wabaId) await wa.unsubscribeWaba(conn.token, conn.wabaId).catch((e) => console.error("[onboarding] Unsubscribe failed:", e.response?.data || e.message));
  await db.run("DELETE FROM whatsapp_connection WHERE tenant_id = ?", [tenantId]);
  await audit.log({ tenantId, actorType: "user", actorId: userId, action: "whatsapp.disconnected", ip });
}

module.exports = { config, connect, disconnect };