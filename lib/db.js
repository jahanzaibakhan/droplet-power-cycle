const mysql = require("mysql2/promise");

let pool = null;

function dbConfig() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
    charset: "utf8mb4",
  };
}

function isConfigured() {
  return Boolean(process.env.DB_USER && process.env.DB_NAME && process.env.DB_PASSWORD);
}

function getPool() {
  if (!isConfigured()) {
    const error = new Error("Database is not configured. Set DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME in .env");
    error.status = 503;
    throw error;
  }
  if (!pool) {
    pool = mysql.createPool(dbConfig());
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function ping() {
  await getPool().query("SELECT 1");
  return true;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, ping, isConfigured, closePool, dbConfig };
