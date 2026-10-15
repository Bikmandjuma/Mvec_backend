// Preloaded by `npm test` (node --require): every test process uses the
// "test" database config (DB_DATABASE + "_test"), never the real database.
process.env.NODE_ENV = "test";
// Tests never talk to real payment providers or send real messages.
for (const key of ["PAYPACK_CLIENT_ID", "PAYPACK_CLIENT_SECRET", "FLW_SECRET_KEY", "PINDO_API_TOKEN", "AT_API_KEY"]) delete process.env[key];
process.env.SMS_PROVIDER = "log";
