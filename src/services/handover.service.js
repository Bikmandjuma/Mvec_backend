// A seller's parcel reached the buyer (the caller already checked the buyer's
// delivery code): release that seller's money, and the order is DELIVERED once
// every seller in it has handed over. Used by sellers, admins and riders.
const Settlement = require("../models/Settlement");
const VendorWallet = require("../models/VendorWallet");
const financialService = require("./financial.service");

const vendorsOf = (order) => [...new Set(order.items.filter((i) => i.vendor).map((i) => String(i.vendor)))];

/** Every HELD settlement of the seller in this order (one per item, plus its parcel fee). */
async function releaseVendorEscrow(orderId, vendorId, session) {
  const settlements = await Settlement.find({ order: orderId, vendor: vendorId, status: "HELD" }).session(session);
  for (const settlement of settlements) {
    await financialService.releaseEscrowToVendor({ settlementId: settlement._id, session });
  }
}

/**
 * A rider carried this seller's parcel, so its delivery fee (held for the
 * seller at payment, commission-free) belongs to the rider.
 */
async function moveParcelFeeToRider(orderId, vendorId, riderId, session) {
  const fee = await Settlement.findOne({ order: orderId, vendor: vendorId, orderItemId: null, status: "HELD" }).session(session);
  if (!fee) return;
  const amount = Number(fee.netAmount) || 0;
  await VendorWallet.findOneAndUpdate({ vendor: vendorId }, { $inc: { pendingBalance: -amount } }, { session });
  await VendorWallet.findOneAndUpdate({ vendor: riderId }, { $inc: { pendingBalance: amount } }, { upsert: true, session });
  fee.vendor = riderId;
  await fee.save({ session });
  await financialService.releaseEscrowToVendor({ settlementId: fee._id, session });
}

/**
 * Hands over `vendorIds`' parcels. `riders` maps a seller id to the rider who
 * carried that parcel. Saves the order; returns { complete, released }.
 */
async function handOver({ order, vendorIds, riders = {}, session }) {
  for (const vendorId of vendorIds) {
    if (riders[vendorId]) await moveParcelFeeToRider(order._id, vendorId, riders[vendorId], session);
    await releaseVendorEscrow(order._id, vendorId, session);
  }
  const delivered = new Set([...(order.deliveredVendors || []).map(String), ...vendorIds]);
  order.deliveredVendors = [...delivered];
  const complete = vendorsOf(order).every((v) => delivered.has(v));

  // Cash on delivery: the seller collected the money at the door.
  const cashOnDelivery = order.paymentMethod === "CASH_ON_DELIVERY" && order.paymentStatus === "PENDING";
  if (cashOnDelivery && complete) {
    order.paymentStatus = "PAID";
    order.paidOffline = true;
    order.paidAt = new Date();
  }
  if (complete) {
    order.orderStatus = "DELIVERED";
    order.isDelivered = true;
    order.deliveredAt = new Date();
  }
  await order.save({ session });
  // Affiliate commission is approved once the whole order is delivered.
  if (complete) await financialService.approveAffiliateCommissionsForOrder({ orderId: order._id, session });
  return { complete, released: vendorIds };
}

module.exports = { handOver, releaseVendorEscrow, vendorsOf };
