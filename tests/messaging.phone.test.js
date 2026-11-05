const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const messaging = require("../src/services/messaging.service");

describe("SMS numbers", () => {
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  let lines;
  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.SMS_PROVIDER = "log";
    lines = [];
    console.log = (line) => lines.push(String(line));
  });
  afterEach(() => {
    console.log = originalLog;
    process.env = { ...originalEnv };
  });

  it("sends to +250… whether the account stores 0788…, 250788… or +250788…", async () => {
    for (const phone of ["0788000303", "250788000303", "+250788000303"]) await messaging.sendSms(phone, "hi");
    assert.deepEqual(lines, Array(3).fill("[SMS:log] to +250788000303: hi"));
  });

  it("refuses a number that is not Rwandan instead of sending it to the wrong place", async () => {
    await assert.rejects(messaging.sendSms("12345", "hi"), /Not a valid Rwandan phone number/);
  });
});
