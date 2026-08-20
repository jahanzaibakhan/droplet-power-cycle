require("dotenv").config();

const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { dbConfig, isConfigured } = require("../lib/db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  active TINYINT(1) NOT NULL DEFAULT 1,
  force_password_change TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id INT NULL,
  username VARCHAR(64) NULL,
  category ENUM('auth', 'admin', 'operation') NOT NULL,
  action VARCHAR(64) NOT NULL,
  detail TEXT NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_activity_user (user_id),
  KEY idx_activity_created (created_at),
  KEY idx_activity_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operation_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id INT NULL,
  username VARCHAR(64) NULL,
  provider VARCHAR(32) NOT NULL,
  upstream VARCHAR(255) NOT NULL,
  ip VARCHAR(45) NULL,
  operation VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_oplog_user (user_id),
  KEY idx_oplog_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

function randomPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

function seedUsersFromEnv() {
  const seeds = [];
  const defaults = [
    { username: "jahanzaib", email: "admin@dropkick.local", role: "admin" },
    { username: "admin2", email: "admin2@dropkick.local", role: "admin" },
    { username: "operator1", email: "operator1@dropkick.local", role: "user" },
    { username: "operator2", email: "operator2@dropkick.local", role: "user" },
    { username: "operator3", email: "operator3@dropkick.local", role: "user" },
  ];

  const envRows = [
    {
      username: process.env.ADMIN_USERNAME,
      email: process.env.ADMIN_EMAIL,
      role: "admin",
    },
    {
      username: process.env.ADMIN2_USERNAME,
      email: process.env.ADMIN2_EMAIL,
      role: "admin",
    },
    {
      username: process.env.USER1_USERNAME,
      email: process.env.USER1_EMAIL,
      role: "user",
    },
    {
      username: process.env.USER2_USERNAME,
      email: process.env.USER2_EMAIL,
      role: "user",
    },
    {
      username: process.env.USER3_USERNAME,
      email: process.env.USER3_EMAIL,
      role: "user",
    },
  ];

  const source = envRows.some((row) => row.username && row.email) ? envRows : defaults;

  for (const row of source) {
    if (!row.username || !row.email) continue;
    seeds.push({
      username: row.username,
      email: row.email,
      role: row.role,
      password: randomPassword(),
    });
  }

  if (!seeds.length) {
    seeds.push({
      username: process.env.ADMIN_USERNAME || "admin",
      email: process.env.ADMIN_EMAIL || "admin@dropkick.local",
      role: "admin",
      password: randomPassword(),
    });
  }

  return seeds;
}

async function run() {
  if (!isConfigured()) {
    console.error("Set DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME in .env");
    process.exit(1);
  }

  const cfg = dbConfig();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: true,
  });

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${cfg.database}\``);

  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await conn.query(stmt);
  }
  console.log("Schema ready.");

  const [countRows] = await conn.query("SELECT COUNT(*) AS c FROM users");
  const userCount = Number(countRows[0].c) || 0;

  if (userCount === 0) {
    const bcrypt = require("bcryptjs");
    const bcryptRounds = Number(process.env.BCRYPT_ROUNDS) || 10;
    const seeds = seedUsersFromEnv();
    const created = [];

    for (const seed of seeds) {
      const hash = await bcrypt.hash(String(seed.password), bcryptRounds);
      await conn.query(
        `INSERT INTO users (username, email, password_hash, role, force_password_change)
         VALUES (?, ?, ?, ?, 0)`,
        [
          String(seed.username).trim().toLowerCase(),
          String(seed.email).trim().toLowerCase(),
          hash,
          seed.role === "admin" ? "admin" : "user",
        ]
      );
      created.push({
        username: seed.username,
        email: seed.email,
        role: seed.role,
        password: seed.password,
      });
    }

    console.log("\n=== Initial users created (save these passwords — not stored in .env) ===");
    for (const row of created) {
      console.log(`${row.role.padEnd(5)} ${row.username}  ${row.email}  password: ${row.password}`);
    }
    console.log("========================================================================\n");
  } else {
    console.log(`Users table has ${userCount} row(s) — skipping seed.`);
  }

  await conn.end();

  const operationLogs = require("../lib/operationLogs");
  const imported = await operationLogs.importLegacyJson();
  if (imported) console.log(`Imported ${imported} legacy operation log(s) from JSON.`);

  console.log("Migration complete.");
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
