const cron = require("node-cron");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Payment = require("../models/Payment");

/**
 * 1. 30-Minute Unpaid Order Cancellation Worker
 * Runs every minute to find PENDING_PAYMENT orders created > 30 mins ago.
 */
const cancelExpiredUnpaidOrders = async () => {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  try {
    const expiredOrders = await Order.find({
      paymentStatus: "UNPAID",
      orderStatus: "PENDING_PAYMENT",
      createdAt: { $lte: thirtyMinutesAgo },
    });

    for (const order of expiredOrders) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Re-verify order status inside session to prevent race conditions
        const freshOrder = await Order.findById(order._id).session(session);
        if (!freshOrder || freshOrder.paymentStatus === "PAID" || freshOrder.orderStatus === "CANCELLED") {
          await session.abortTransaction();
          session.endSession();
          continue;
        }

        // 1. Update Order & Payment Status
        freshOrder.orderStatus = "CANCELLED";
        freshOrder.cancellationReason = "PAYMENT_TIMEOUT_EXPIRED_30_MIN";
        await freshOrder.save({ session });

        await Payment.updateMany(
          { parentOrder: freshOrder._id, status: "PENDING" },
          { status: "CANCELLED" },
          { session }
        );

        // 2. Restore Product Inventory Stock
        for (const item of freshOrder.items) {
          await Product.findByIdAndUpdate(
            item.product,
            { $inc: { stockQuantity: item.quantity } },
            { session }
          );
        }

        await session.commitTransaction();
        session.endSession();
        console.log(`[Expiry Worker] Successfully auto-cancelled expired Order #${freshOrder._id}`);
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error(`[Expiry Worker] Failed to cancel order #${order._id}:`, err.message);
      }
    }
  } catch (error) {
    console.error("[Expiry Worker] Error fetching expired orders:", error.message);
  }
};

/**
 * 2. 3-Hour Vendor Fulfillment SLA Enforcer Worker
 * Runs every 15 minutes to flag orders awaiting vendor dispatch > 3 hours after payment.
 */
const enforceFulfillmentSLA = async () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

  try {
    const slaBreachedOrders = await Order.find({
      paymentStatus: "PAID",
      orderStatus: "PROCESSING",
      slaBreached: { $ne: true }, // Not yet flagged
      updatedAt: { $lte: threeHoursAgo }, // Paid > 3 hours ago
    });

    for (const order of slaBreachedOrders) {
      order.slaBreached = true;
      order.slaBreachedAt = new Date();
      order.adminNotes = (order.adminNotes || "") + " | SLA Breached: Vendor failed to dispatch within 3 hours.";
      
      await order.save();

      // Here you can trigger an Admin Email / SMS Alert or automatically flag vendor rating
      console.warn(`[SLA Worker] SLA BREACH FLAGGED for Order #${order._id} (Vendor ID: ${order.vendor})`);
    }
  } catch (error) {
    console.error("[SLA Worker] Error running SLA audit:", error.message);
  }
};

/**
 * Initialize Background Jobs
 */
exports.initBackgroundWorkers = () => {
  // Run 30-min expiration check every minute: "* * * * *"
  cron.schedule("* * * * *", () => {
    cancelExpiredUnpaidOrders();
  });

  // Run 3-Hour SLA audit every 15 minutes: "*/15 * * * *"
  cron.schedule("*/15 * * * *", () => {
    enforceFulfillmentSLA();
  });

  console.log("🚀 [Background Workers] SLA & Expiry Cron Jobs Initialized.");
};