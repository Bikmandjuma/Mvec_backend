// Startup check: the app only runs when MySQL is reachable and every
// migration has been applied, with a message that says how to fix it.
const fs = require("fs");
const path = require("path");
const { sequelize } = require(".");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function hint(err) {
  const code = err?.original?.code || err?.parent?.code || err?.code;
  const { host, port, database, username } = sequelize.config;
  if (code === "ER_BAD_DB_ERROR") return `Database "${database}" does not exist. Create it once: CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; then run npm run db:migrate.`;
  if (code === "ECONNREFUSED") return `Nothing is listening on ${host}:${port}. Start MySQL (XAMPP: start "MySQL Database"), or set DB_HOST/DB_PORT in .env.`;
  if (code === "ER_ACCESS_DENIED_ERROR") return `MySQL refused user "${username}". Check DB_USERNAME and DB_PASSWORD in .env.`;
  return err.message;
}

async function pendingMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".js")).sort();
  let applied = [];
  try {
    const [rows] = await sequelize.query("SELECT name FROM `SequelizeMeta`");
    applied = rows.map((r) => r.name);
  } catch {
    return files; // no migrations table yet
  }
  return files.filter((f) => !applied.includes(f));
}

async function connectDatabase() {
  try {
    await sequelize.authenticate();
  } catch (err) {
    throw Object.assign(new Error(`Cannot connect to MySQL. ${hint(err)}`), { cause: err });
  }
  const pending = await pendingMigrations();
  if (pending.length) {
    throw new Error(`The database is missing ${pending.length} migration(s) (${pending.join(", ")}). Run: npm run db:migrate`);
  }
  return sequelize.config.database;
}

module.exports = { connectDatabase, pendingMigrations };
