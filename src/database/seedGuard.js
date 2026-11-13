// Demo seeders must never run against production by accident.
const { isLive } = require("../config/env");
module.exports = function assertSeedingAllowed() {
  if (isLive() && process.env.SEED_ALLOW_PRODUCTION !== "true") {
    throw new Error("Refusing to seed demo data in production. Set SEED_ALLOW_PRODUCTION=true to override.");
  }
};
