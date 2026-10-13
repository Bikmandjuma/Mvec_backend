// Runs the SLA worker against the configured MySQL database and prints the outcome.
require("dotenv").config({ quiet: true });
const Order = require("../../src/models/Order");
const User = require("../../src/models/User");
const { sequelize } = require("../../src/database");
const { enforceFulfillmentSLA, cancelExpiredUnpaidOrders } = require("../../src/workers/slaWorker");

(async () => {
  const buyer = await User.findOne({ role: "buyer" });
  const order = await Order.create({
    user: buyer._id, orderNumber: `ORD-SLA-${Date.now()}`, items: [{ name: "x", price: 100, quantity: 1 }],
    shippingAddress: { street: "s", city: "c", state: "st", country: "Rwanda" }, totalAmount: 100,
    paymentStatus: "PAID", orderStatus: "PROCESSING",
  });
  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  await sequelize.query(`UPDATE orders SET updatedAt = ${sequelize.escape(old)} WHERE id = ${sequelize.escape(String(order._id))}`);
  await cancelExpiredUnpaidOrders();
  await enforceFulfillmentSLA();
  const after = await Order.findById(order._id);
  console.log(JSON.stringify({ slaBreached: after.slaBreached, hasBreachedAt: !!after.slaBreachedAt, note: (after.adminNotes || "").includes("SLA Breached") }));
  await Order.deleteOne({ _id: order._id });
  await sequelize.close();
})().catch((e) => { console.error("worker-check failed:", e.message); process.exit(1); });
