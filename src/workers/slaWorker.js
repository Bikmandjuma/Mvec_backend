const cron = require("node-cron");
const promotionService = require("../services/promotion.service");
const orm = require("../database/orm");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Payment = require("../models/Payment");
const socketService = require("../services/socket.service");
const notifications = require("../services/notification.service");
const disbursementService = require("../services/disbursement.service");

/**
 * 1. 30-Minute Unpaid Order Cancellation Worker
 * Runs every minute. Checkout reserves stock as soon as an order is created,
 * so an order nobody pays for must release that stock again. Orders are
 * created with paymentStatus/orderStatus "PENDING"; an order whose buyer has
 * a payment prompt open right now is given a few more minutes.
 */
const UNPAID_ORDER_TTL_MS = 30 * 60 * 1000;
const PAYMENT_GRACE_MS = 10 * 60 * 1000;

const cancelExpiredUnpaidOrders = async () => {
  const expiredBefore = new Date(Date.now() - UNPAID_ORDER_TTL_MS);

  try {
    const expiredOrders = await Order.find({
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      paymentMethod: { $ne: "CASH_ON_DELIVERY" },
      createdAt: { $lte: expiredBefore },
    });

    for (const order of expiredOrders) {
      const inFlight = await Payment.exists({
        parentOrder: order._id,
        status: "PENDING",
        createdAt: { $gte: new Date(Date.now() - PAYMENT_GRACE_MS) },
      });
      if (inFlight) continue;

      const session = await orm.startSession();
      session.startTransaction();

      try {
        // Re-verify order status inside session to prevent race conditions
        const freshOrder = await Order.findById(order._id).session(session);
        if (!freshOrder || freshOrder.paymentStatus !== "PENDING" || freshOrder.orderStatus !== "PENDING") {
          await session.abortTransaction();
          continue;
        }

        freshOrder.orderStatus = "CANCELLED";
        freshOrder.cancellationReason = "PAYMENT_TIMEOUT_EXPIRED_30_MIN";
        await freshOrder.save({ session });

        await Payment.updateMany(
          { parentOrder: freshOrder._id, status: "PENDING" },
          { status: "CANCELLED" },
          { session }
        );

        for (const item of freshOrder.items) {
          if (!item.product) continue;
          await Product.updateOne({ _id: item.product }, { $inc: { stockQuantity: item.quantity } }, { session });
          await Product.updateOne(
            { _id: item.product, status: "OUT_OF_STOCK", stockQuantity: { $gt: 0 } },
            { $set: { status: "ACTIVE" } },
            { session }
          );
        }

        await session.commitTransaction();
        socketService.emitOrderStatusUpdate(freshOrder);
        notifications.orderCancelled(freshOrder, {
          reason: "It was not paid within 30 minutes, so the items were released. You were not charged.",
        }).catch(() => {});
        console.log(`[Expiry Worker] Auto-cancelled unpaid Order #${freshOrder._id}`);
        // Give back any coupon use held by this order.
        await promotionService.release(freshOrder).catch(() => {});
      } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error(`[Expiry Worker] Failed to cancel order #${order._id}:`, err.message);
      } finally {
        session.endSession();
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
// 3. Seller Premium renewals / expiry (hourly).
const renewSubscriptions = async () => {
  try {
    const { renewDueSubscriptions } = require("../services/subscriptionBilling.service");
    const r = await renewDueSubscriptions();
    if (r.renewed || r.ended) console.log(`[Subscription Worker] renewed ${r.renewed}, ended ${r.ended}`);
  } catch (error) {
    console.error("[Subscription Worker] Error:", error.message);
  }
};
exports.renewSubscriptions = renewSubscriptions;

// 4. End ad campaigns past their end date and return unspent budget (hourly).
const endExpiredCampaigns = async () => {
  try {
    const r = await require("../services/advertising.service").sweep();
    if (r.ended) console.log(`[Ads Worker] ended ${r.ended} campaign(s)`);
  } catch (error) {
    console.error("[Ads Worker] Error:", error.message);
  }
};
exports.endExpiredCampaigns = endExpiredCampaigns;
/**
 * Payment reminder: one in-app + SMS nudge 20 minutes after an order was
 * placed, if it is still unpaid (it expires at 30 minutes).
 */
const sendPaymentReminders = async () => {
  const from = new Date(Date.now() - 29 * 60 * 1000);
  const to = new Date(Date.now() - 20 * 60 * 1000);
  try {
    const orders = await Order.find({
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      paymentReminderSentAt: { $exists: false },
      createdAt: { $gte: from, $lte: to },
    }).limit(200);
    for (const order of orders) {
      // Claim it first so a second worker never sends the same reminder.
      const claimed = await Order.updateOne(
        { _id: order._id, paymentReminderSentAt: { $exists: false } },
        { $set: { paymentReminderSentAt: new Date() } },
      );
      if (claimed.modifiedCount) await notifications.paymentReminder(order);
    }
  } catch (error) {
    console.error("[Reminder Worker] failed:", error.message);
  }
};

exports.cancelExpiredUnpaidOrders = cancelExpiredUnpaidOrders;
exports.sendPaymentReminders = sendPaymentReminders;

exports.initBackgroundWorkers = () => {
  cron.schedule("7 * * * *", renewSubscriptions);
  cron.schedule("17 * * * *", endExpiredCampaigns);
  // Problem reports: MVEC steps in when the seller misses the response
  // deadline or the buyer doesn't answer an offer (every 30 minutes).
  cron.schedule("*/30 * * * *", () => {
    require("../services/disputeCase.service").escalateOverdue()
      .then((r) => { if (r.escalated) console.log(`[Disputes] ${r.escalated} case(s) passed to MVEC.`); })
      .catch((e) => console.error("[Disputes] escalation failed:", e.message));
  });
  // Pay sellers for shipped orders the buyer neither confirmed nor disputed
  // within the admin-set number of days (every 15 minutes).
  cron.schedule("*/15 * * * *", () => {
    require("../controllers/order.controller").autoReleaseDueDeliveries()
      .then((r) => { if (r.released) console.log(`[Auto release] ${r.released} order(s) delivered automatically.`); })
      .catch((e) => console.error("[Auto release] failed:", e.message));
  });
  // Run 30-min expiration check every minute: "* * * * *"
  cron.schedule("* * * * *", () => {
    cancelExpiredUnpaidOrders();
    sendPaymentReminders();
  });

  // Confirm or retry refunds and affiliate withdrawals every 5 minutes.
  cron.schedule("*/5 * * * *", () => {
    disbursementService.processDue().catch((err) => console.error("[Disbursement Worker] failed:", err.message));
  });

  // Run 3-Hour SLA audit every 15 minutes: "*/15 * * * *"
  cron.schedule("*/15 * * * *", () => {
    enforceFulfillmentSLA();
    // Wholesale: expire unpaid orders, refund unshipped ones, pay suppliers for
    // shipped orders nobody complained about, and close expired quote requests.
    require("../services/wholesale.service").runAutomations().catch((err) => console.error("[Wholesale Worker] failed:", err.message));
    require("../services/quote.service").expireRequests().catch((err) => console.error("[Quote Worker] failed:", err.message));
  });

  console.log("🚀 [Background Workers] SLA & Expiry Cron Jobs Initialized.");
};
// Exposed for tests (tests/e2e/worker-check.cjs).
exports.cancelExpiredUnpaidOrders = cancelExpiredUnpaidOrders;
exports.enforceFulfillmentSLA = enforceFulfillmentSLA;
