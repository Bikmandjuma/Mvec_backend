const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const friendlyErrors = require("../src/middleware/friendlyErrors");
const { translate } = friendlyErrors;

test("bad ids in a 500 become a 400 the user can act on", () => {
  const out = translate('Cast to ObjectId failed for value "abc" (type string) at path "_id" for model "Order"');
  assert.equal(out.status, 400);
  assert.match(out.message, /not valid/);
});

test("validation errors list what to fix", () => {
  const out = translate("Order validation failed: shippingAddress.city: Path `shippingAddress.city` is required.");
  assert.equal(out.status, 400);
  assert.match(out.message, /shippingAddress.city is required/);
});

test("database outages say the problem is on our side", () => {
  for (const msg of ["Operation `orders.find()` buffering timed out after 10000ms", "Transaction numbers are only allowed on a replica set member or mongos"]) {
    const out = translate(msg);
    assert.equal(out.status, 503);
    assert.match(out.message, /on our side/);
  }
});

test("messages written for users are kept", () => {
  assert.equal(translate("We could not cancel this order. Please try again."), null);
});

test("5xx responses carry a reference and hide internals", async () => {
  const app = express();
  app.use(friendlyErrors);
  app.get("/boom", (req, res) => res.status(500).json({ message: "Cannot read properties of undefined (reading 'items')", stack: "at x" }));
  app.get("/fine", (req, res) => res.status(400).json({ message: "Your cart is empty." }));
  const original = console.error;
  console.error = () => {};
  try {
    const boom = await request(app).get("/boom");
    assert.equal(boom.status, 500);
    assert.match(boom.body.message, /on our side, not yours/);
    assert.match(boom.body.reference, /^[0-9A-F]{8}$/);
    assert.ok(boom.body.message.includes(boom.body.reference));
    assert.equal(boom.body.stack, undefined);
    const fine = await request(app).get("/fine");
    assert.deepEqual(fine.body, { message: "Your cart is empty." });
  } finally {
    console.error = original;
  }
});
