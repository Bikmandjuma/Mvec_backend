// Automatic notifications for everything that happens to an order, a refund
// or an affiliate payout. Each event creates in-app notifications (the bell)
// and, for the moments people must not miss, an SMS and/or email.
// Delivery failures are logged and never break the action that triggered them.
const Notification = require("../models/Notification");
const User = require("../models/User");
const messaging = require("./messaging.service");

const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const idOf = (doc) => String(doc?._id || doc?.id || doc || "");
const vendorIdsOf = (order) => [...new Set((order.items || []).filter((i) => i.vendor).map((i) => idOf(i.vendor)))];

async function notify(recipient, { type = "ORDER", title, message = "", reference = "", link = "", sms, email }) {
  const recipientId = idOf(recipient);
  if (!recipientId) return;
  try {
    await Notification.create({ recipient: recipientId, type, title, message, reference, link, channel: "IN_APP" });
  } catch (err) {
    console.error("Notification save failed:", err.message);
  }
  if (!sms && !email) return;
  const user = await User.findById(recipientId).select("phone email").lean().catch(() => null);
  if (sms) {
    const phone = typeof sms === "object" && sms.phone ? sms.phone : user?.phone;
    const text = typeof sms === "object" ? sms.text : sms;
    if (phone && messaging.smsAvailable()) {
      messaging.sendSms(phone, text).catch((err) => console.error("SMS failed:", err.message));
    }
  }
  if (email && user?.email && messaging.emailConfigured()) {
    messaging.sendEmail({ to: user.email, subject: title, text: email }).catch((err) => console.error("Email failed:", err.message));
  }
}

async function adminIds() {
  const admins = await User.find({ role: "super_admin" }).select("_id").lean();
  return admins.map((a) => a._id);
}

const orderLink = (order) => `/orders/${idOf(order)}`;

module.exports = {
  notify,

  // Something is waiting for an administrator (shown in the bell and the dashboard queue).
  async adminAlert({ title, message = "", link = "/admin" }) {
    for (const adminId of await adminIds()) await notify(adminId, { type: "ADMIN", title, message, link });
  },

  // A seller or supplier sent their profile for review: tell the admins.
  async profileSubmitted({ kind, name, resubmitted }) {
    const store = kind === "supplier" ? "supplier" : "seller";
    for (const adminId of await adminIds()) {
      await notify(adminId, {
        type: "ADMIN",
        title: `${resubmitted ? "Updated" : "New"} ${store} profile to verify: ${name}`,
        message: `Review the profile and approve or reject it so the ${store} can start working.`,
        link: kind === "supplier" ? "/admin/suppliers" : "/admin/vendors",
      });
    }
  },

  // MVEC verified or rejected a seller/supplier profile.
  async verificationDecision(userId, { kind, name, decision, reason }) {
    const store = kind === "supplier" ? "supplier account" : "store";
    const approved = decision === "VERIFIED";
    const text = approved
      ? `Good news: MVEC verified your ${store} ${name}. You now show as verified to buyers${kind === "supplier" ? " and vendors" : ""}.`
      : `MVEC could not verify your ${store} ${name}. Reason: ${reason} Update your profile and submit it again.`;
    await notify(userId, {
      type: "ADMIN",
      title: approved ? `Your ${store} is verified` : `Your ${store} needs changes`,
      message: text,
      link: kind === "supplier" ? "/supplier/settings" : "/vendor",
      sms: text,
      email: text,
    });
  },

  // A supply request or supplier payout moved: tell the supplier.
  async supplierUpdate(userId, { title, message, link }) {
    await notify(userId, { type: "ADMIN", title, message, link });
  },

  async manualRefundNeeded(order, disbursement) {
    for (const adminId of await adminIds()) {
      await notify(adminId, {
        type: "PAYMENT",
        title: `Manual refund needed for ${order.orderNumber}`,
        message: disbursement.lastError,
        reference: order.orderNumber,
        link: "/admin/transfers",
      });
    }
  },

  async premiumActivated(userId, until) {
    await notify(userId, {
      type: "SUBSCRIPTION",
      title: "Premium is active",
      message: `Thank you! Ads are hidden until ${new Date(until).toLocaleDateString("en-GB")}.`,
      link: "/buyer/subscription",
    });
  },

  async orderPlaced(order) {
    await notify(order.user, {
      title: `Order ${order.orderNumber} placed`,
      message: `Pay ${money(order.totalAmount)} within 30 minutes to keep your items reserved.`,
      reference: order.orderNumber,
      link: `/payment/${idOf(order)}`,
    });
  },

  async paymentReminder(order) {
    await notify(order.user, {
      type: "PAYMENT",
      title: `Order ${order.orderNumber} is waiting for payment`,
      message: "Pay in the next 10 minutes or the order is cancelled and the items are released.",
      reference: order.orderNumber,
      link: `/payment/${idOf(order)}`,
      sms: `MVEC: order ${order.orderNumber} (${money(order.totalAmount)}) is not paid yet. Pay within 10 minutes to keep it.`,
    });
  },

  async paymentConfirmed(order) {
    const ConversionAudit = require("../models/ConversionAudit");
    const pending = await ConversionAudit.find({ order: order._id, status: "PENDING" }).lean();
    for (const audit of pending) {
      await module.exports.affiliateCommission(audit.affiliateUser, {
        orderNumber: order.orderNumber,
        amount: audit.commissionEarned,
        approved: false,
      });
    }
    const buyerPhone = order.recipient?.phone;
    await notify(order.user, {
      type: "PAYMENT",
      title: `Payment received for ${order.orderNumber}`,
      message: `MVEC is holding ${money(order.totalAmount)} until you confirm delivery. Your delivery code is on the order page.`,
      reference: order.orderNumber,
      link: orderLink(order),
      sms: {
        phone: buyerPhone,
        text: `MVEC: payment for ${order.orderNumber} received. Delivery code: ${order.deliveryOtp}. Give it ONLY when you have your items.`,
      },
      email: `We received ${money(order.totalAmount)} for order ${order.orderNumber}.\nMVEC holds the payment until you confirm delivery.\nYour delivery code is ${order.deliveryOtp}. Give it only to the person handing you your items.`,
    });
    for (const vendorId of vendorIdsOf(order)) {
      const lines = order.items.filter((i) => idOf(i.vendor) === vendorId);
      await notify(vendorId, {
        title: `New paid order ${order.orderNumber}`,
        message: `${lines.reduce((n, i) => n + i.quantity, 0)} item(s) to prepare for ${order.shippingAddress?.city || "delivery"}.`,
        reference: order.orderNumber,
        link: `/vendor/orders/${idOf(order)}`,
        sms: `MVEC: new paid order ${order.orderNumber}. Please prepare it for delivery.`,
      });
    }
  },

  async orderStatusChanged(order) {
    const labels = {
      PROCESSING: ["is being prepared", false],
      READY_FOR_SHIPMENT: ["is packed and ready to ship", false],
      SHIPPED: ["has been shipped", true],
      OUT_FOR_DELIVERY: ["is out for delivery", true],
    };
    const pickupReady = order.shippingMethod === "PICKUP" && order.orderStatus === "READY_FOR_SHIPMENT";
    const [text, sms] = pickupReady ? ["is ready for pickup", true] : labels[order.orderStatus] || [];
    if (!text) return;
    await notify(order.user, {
      type: "DELIVERY",
      title: `Order ${order.orderNumber} ${text}`,
      message: order.orderStatus === "OUT_FOR_DELIVERY" || pickupReady ? "Have your delivery code ready. Only give it once you have your items." : "",
      reference: order.orderNumber,
      link: orderLink(order),
      sms: sms ? { phone: order.recipient?.phone, text: `MVEC: order ${order.orderNumber} ${text}.` } : undefined,
    });
  },

  async courierAssigned(order) {
    await notify(order.courier, {
      type: "DELIVERY",
      title: `New delivery ${order.orderNumber}`,
      message: `${order.recipient?.name || "Buyer"}, ${order.shippingAddress?.street || ""} ${order.shippingAddress?.city || ""}`.trim(),
      reference: order.orderNumber,
      link: "/delivery/deliveries",
      sms: `MVEC: delivery ${order.orderNumber} assigned to you. Open your deliveries for the address.`,
    });
  },

  async orderDelivered(order, { complete, vendorIds = [] } = {}) {
    for (const vendorId of vendorIds) {
      await notify(vendorId, {
        type: "PAYOUT",
        title: `Payment released for ${order.orderNumber}`,
        message: "The buyer confirmed delivery. Your earnings are now available.",
        reference: order.orderNumber,
        link: "/vendor/payouts",
      });
    }
    if (complete) {
      const ConversionAudit = require("../models/ConversionAudit");
      const approved = await ConversionAudit.find({ order: order._id, status: "APPROVED" }).lean();
      for (const audit of approved) {
        await module.exports.affiliateCommission(audit.affiliateUser, {
          orderNumber: order.orderNumber,
          amount: (audit.commissionEarned || 0) - (audit.reversedAmount || 0),
          approved: true,
        });
      }
      await notify(order.user, {
        type: "DELIVERY",
        title: `Order ${order.orderNumber} delivered`,
        message: "Thanks for shopping on MVEC. You can now review the products.",
        reference: order.orderNumber,
        link: orderLink(order),
      });
    }
  },

  async orderCancelled(order, { reason, refunded } = {}) {
    await notify(order.user, {
      title: `Order ${order.orderNumber} cancelled`,
      message: reason || (refunded ? "Your refund is on its way to your mobile money number." : "You were not charged."),
      reference: order.orderNumber,
      link: orderLink(order),
    });
    if (refunded) {
      for (const vendorId of vendorIdsOf(order)) {
        await notify(vendorId, {
          title: `Order ${order.orderNumber} was cancelled`,
          message: "The buyer cancelled before shipping. Do not send these items.",
          reference: order.orderNumber,
          link: `/vendor/orders/${idOf(order)}`,
          sms: `MVEC: order ${order.orderNumber} was cancelled by the buyer. Do not ship it.`,
        });
      }
    }
  },

  async refundSent(order, amount) {
    await notify(order.user, {
      type: "PAYMENT",
      title: `Refund sent for ${order.orderNumber}`,
      message: `${money(amount)} was sent back to your mobile money number.`,
      reference: order.orderNumber,
      link: orderLink(order),
      sms: { phone: order.recipient?.phone, text: `MVEC: ${money(amount)} refund for ${order.orderNumber} was sent to your mobile money.` },
    });
  },

  async refundFailed(order, amount, reason) {
    for (const adminId of await adminIds()) {
      await notify(adminId, {
        type: "ADMIN",
        title: `Refund failed for ${order.orderNumber}`,
        message: `${money(amount)} could not be sent automatically (${reason}). Retry it from Payments.`,
        reference: order.orderNumber,
        link: "/admin/payments",
      });
    }
  },

  // A buyer reported a problem: every seller on the order and every admin
  // gets it (each with a link to their own disputes page), and the buyer
  // gets a receipt.
  async disputeOpened(order, dispute) {
    const reason = String(dispute.reason || "").toLowerCase().replace(/_/g, " ");
    const reference = dispute.disputeNumber || order.orderNumber;
    for (const id of vendorIdsOf(order)) {
      await notify(id, {
        type: "ORDER",
        title: `Problem reported on ${order.orderNumber}`,
        message: `The buyer reported: ${reason}. Payment is on hold. Respond with your side so MVEC can resolve it.`,
        reference,
        link: "/vendor/refunds",
      });
    }
    for (const id of await adminIds()) {
      await notify(id, {
        type: "ADMIN",
        title: `Problem reported on ${order.orderNumber}`,
        message: `${reason}. Payment is on hold until MVEC reviews it.`,
        reference,
        link: "/admin/disputes",
      });
    }
    if (order.user) {
      await notify(order.user, {
        type: "ORDER",
        title: `We received your report on ${order.orderNumber}`,
        message: "The seller and MVEC have been told. The payment stays on hold until the problem is resolved.",
        reference,
        link: orderLink(order),
      });
    }
  },

  // A new message on a dispute goes to everyone else involved.
  async disputeReply(order, dispute, { fromUserId, fromRole }) {
    const reference = dispute.disputeNumber || order.orderNumber;
    const from = fromRole === "super_admin" ? "MVEC" : fromRole === "vendor" ? "The seller" : "The buyer";
    const title = `${from} replied on ${reference}`;
    const message = `New message on the problem reported for ${order.orderNumber}.`;
    const skip = String(fromUserId);
    for (const id of vendorIdsOf(order)) {
      if (id !== skip) await notify(id, { type: "ORDER", title, message, reference, link: "/vendor/refunds" });
    }
    if (fromRole !== "super_admin") {
      for (const id of await adminIds()) await notify(id, { type: "ADMIN", title, message, reference, link: "/admin/disputes" });
    }
    const buyer = order.user ? idOf(order.user) : null;
    if (buyer && buyer !== skip) await notify(buyer, { type: "ORDER", title, message, reference, link: orderLink(order) });
  },

  async affiliateCommission(affiliateUserId, { orderNumber, amount, approved }) {
    await notify(affiliateUserId, {
      type: "PAYOUT",
      title: approved ? "Commission approved" : "You earned a commission",
      message: approved
        ? `${money(amount)} from order ${orderNumber} is now available to withdraw.`
        : `${money(amount)} from order ${orderNumber}. It becomes available after delivery.`,
      reference: orderNumber,
      link: "/affiliate/commissions",
    });
  },

  async vendorPayout(vendorId, { amount, status, supplier = false }) {
    await notify(vendorId, {
      type: "PAYOUT",
      title: status === "PAID" ? "Withdrawal sent" : "Withdrawal failed",
      message: status === "PAID"
        ? `${money(amount)} was sent to your mobile money.`
        : `The ${money(amount)} transfer failed and the amount is back in your balance. Check your number and try again.`,
      link: supplier ? "/supplier/payments" : "/vendor/payouts",
      sms: status === "PAID" ? `MVEC: your ${money(amount)} withdrawal was sent to your mobile money.` : undefined,
    });
  },

  async affiliatePayout(affiliateUserId, { amount, status, reason }) {
    const titles = { COMPLETED: "Withdrawal sent", FAILED: "Withdrawal failed", REJECTED: "Withdrawal rejected", PROCESSING: "Withdrawal in progress" };
    await notify(affiliateUserId, {
      type: "PAYOUT",
      title: titles[status] || "Withdrawal update",
      message: status === "COMPLETED" ? `${money(amount)} was sent to your mobile money.` : reason || `${money(amount)} withdrawal is ${String(status).toLowerCase()}.`,
      link: "/affiliate/withdrawals",
      sms: status === "COMPLETED" ? `MVEC: your ${money(amount)} affiliate withdrawal was sent to your mobile money.` : undefined,
    });
  },
};
