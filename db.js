/**
 * db.js — shared MySQL pool. Tenant-scoped queries MUST include tenant_id.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z",
  charset: "utf8mb4",
  multipleStatements: false,
  dateStrings: false,
});

async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}
async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const api = {
      all: async (sql, p = []) => (await conn.query(sql, p))[0],
      one: async (sql, p = []) => ((await conn.query(sql, p))[0][0] || null),
      run: async (sql, p = []) => (await conn.query(sql, p))[0],
    };
    const out = await fn(api);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
async function ping() {
  const conn = await pool.getConnection();
  try { await conn.ping(); return true; }
  finally { conn.release(); }
}
module.exports = { pool, all, one, run, tx, ping };