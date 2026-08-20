#!/usr/bin/env node
/**
 * One-time fix: older rows used MySQL CURRENT_TIMESTAMP in Asia/Karachi session,
 * but the app read them as UTC (+5h in the UI for PKT users).
 * Converts known columns from Asia/Karachi wall time to UTC storage.
 */
require("dotenv").config();

const mysql = require("mysql2/promise");
const { dbConfig, isConfigured } = require("../lib/db");

const FIXES = [
  { table: "activity_logs", column: "created_at" },
  { table: "operation_logs", column: "created_at" },
  { table: "sessions", column: "created_at" },
  { table: "users", column: "created_at" },
  { table: "users", column: "updated_at" },
];

async function run() {
  if (!isConfigured()) {
    console.error("Database not configured.");
    process.exit(1);
  }

  const cfg = dbConfig();
  const conn = await mysql.createConnection({ ...cfg, timezone: "Z" });
  await conn.query("SET time_zone = '+00:00'");
  await conn.query(`USE \`${cfg.database}\``);

  for (const { table, column } of FIXES) {
    const [result] = await conn.query(
      `UPDATE \`${table}\`
       SET \`${column}\` = CONVERT_TZ(\`${column}\`, 'Asia/Karachi', 'UTC')
       WHERE \`${column}\` IS NOT NULL`
    );
    console.log(`${table}.${column}: ${result.affectedRows} row(s) adjusted`);
  }

  console.log("Skipped users.last_login_at (already stored via UTC_TIMESTAMP()).");
  await conn.end();
  console.log("Datetime UTC fix complete.");
}

run().catch((err) => {
  console.error("Fix failed:", err.message);
  process.exit(1);
});
