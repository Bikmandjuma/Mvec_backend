// Runs tests/e2e/flows.mjs + flows2.mjs against the backend on a throwaway
// MySQL database (dropped afterwards unless KEEP_DB=1) and reports failures.
// Usage: node tests/e2e/run.mjs        (VERBOSE=1 prints every step)
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFlows } from "./flows.mjs";
import { runMoreFlows } from "./flows2.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
require("dotenv").config({ quiet: true });

const ADMIN = { E2E_ADMIN_EMAIL: "admin@e2e.test", E2E_ADMIN_PASSWORD: "AdminPassw0rd!" };
const MYSQL_DB = "ikiguzi_e2e_test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mysqlAdmin(sql) {
  const mysql = require("mysql2/promise");
  const c = require(path.join(root, "src/database/config")).development;
  const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.username, password: c.password || undefined });
  await conn.query(sql);
  await conn.end();
}

async function startServer(env, port) {
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, ...env, PORT: String(port), NODE_ENV: "development", RATE_LIMITS: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/categories`); if (r.ok) return { child, getLog: () => log }; } catch {}
    await sleep(500);
  }
  child.kill();
  throw new Error(`server on ${port} did not start:\n${log}`);
}

async function run() {
  const port = 4112;
  const env = { DB_DATABASE: MYSQL_DB };
  await mysqlAdmin(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
  await mysqlAdmin(`CREATE DATABASE \`${MYSQL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  execFileSync(path.join(root, "node_modules/.bin/sequelize-cli"), ["db:migrate"], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  const server = await startServer(env, port);
  try {
    execFileSync(process.execPath, ["tests/e2e/make-admin.cjs"], { cwd: root, env: { ...process.env, ...env, ...ADMIN }, stdio: "inherit" });
    const ctx = { adminEmail: ADMIN.E2E_ADMIN_EMAIL, adminPassword: ADMIN.E2E_ADMIN_PASSWORD };
    const result = await runFlows(`http://localhost:${port}/api`, ctx);
    const more = await runMoreFlows(`http://localhost:${port}/api`, ctx);
    result.transcript.push(...more.transcript);
    result.failures.push(...more.failures);
    result.log = server.getLog();
    return result;
  } finally {
    server.child.kill();
    await sleep(300);
    if (process.env.KEEP_DB) console.log(`  kept database ${MYSQL_DB} for inspection`);
    else await mysqlAdmin(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``).catch(() => {});
  }
}

const show = (v) => JSON.stringify(v);
const r = await run();
if (process.env.VERBOSE) r.transcript.forEach((t) => console.log(`  ${t.status} ${t.step} ${show(t.data)}`));
console.log(`${r.transcript.length} steps, ${r.failures.length} expectation failures`);
r.failures.forEach((f) => console.log("  ✗", f));
const errors = (r.log.match(/^.*(Error|error:|TypeError|ReferenceError|mysql-compat|\[error ).*$/gm) || []);
if (errors.length) { console.log("server errors:"); [...new Set(errors)].slice(0, 20).forEach((l) => console.log("  ", l.slice(0, 220))); }
process.exitCode = r.failures.length || errors.length ? 1 : 0;
