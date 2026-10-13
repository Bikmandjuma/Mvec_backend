// MySQL test database for integration tests. Require this FIRST in a test
// file (before any model): it switches to the "test" config, whose database
// name must end in _test, creates and migrates it, and wipes it between tests.
// Test files share one database, so `npm test` runs files one at a time.
process.env.NODE_ENV = "test";
const path = require("path");
const { execFileSync } = require("child_process");
const mysql = require("mysql2/promise");
const { sequelize } = require("../../src/database");

const root = path.resolve(__dirname, "../..");
let ready = null;

async function prepare() {
  const c = sequelize.config;
  if (!/_test$/.test(c.database)) throw new Error(`Refusing to use database "${c.database}" for tests; it must end in _test.`);
  const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.username, password: c.password || undefined });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${c.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  execFileSync(path.join(root, "node_modules/.bin/sequelize-cli"), ["db:migrate", "--env", "test"], {
    cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe",
  });
  await sequelize.authenticate();
}

/** Create + migrate the test database (once per process). */
const setup = () => (ready ||= prepare());

/** Empty every table (keeps the schema and migration history). */
async function reset() {
  await setup();
  const [rows] = await sequelize.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'SequelizeMeta'",
  );
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 0", { transaction });
    for (const { t } of rows) await sequelize.query(`DELETE FROM \`${t}\``, { transaction });
    await sequelize.query("SET FOREIGN_KEY_CHECKS = 1", { transaction });
  });
}

const close = () => sequelize.close();

module.exports = { setup, reset, close, sequelize };
