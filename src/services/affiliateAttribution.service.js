const crypto = require("crypto");
const orm = require("../database/orm");
const AffiliateAttribution = require("../models/AffiliateAttribution");
const AffiliateLink = require("../models/AffiliateLink");
const AffiliateWallet = require("../models/AffiliateWallet");
const ConversionAudit = require("../models/ConversionAudit");
const Settlement = require("../models/Settlement");
const Order = require("../models/Order");
const Product = require("../models/Product");
// Required lazily: affiliateProgram loads models that load this file's callers.
const program = () => require("./affiliateProgram.service");

// Referral window: a click is eligible while now < clickedAt + 30 days. The
// boundary instant itself is already expired, and clicks dated in the future
// (clock skew, tampering) are never eligible.
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Products a visitor can still land on and buy.
const PROMOTABLE_STATUSES = ["ACTIVE", "OUT_OF_STOCK"];

const VISITOR_ID_PATTERN = /^[a-f0-9]{32}$/;
const mintVisitorId = () => crypto.randomBytes(16).toString("hex");
const cleanVisitorId = (value) =>
  typeof value === "string" && VISITOR_ID_PATTERN.test(value) ? value : null;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function isWithinWindow(clickedAt, now = new Date()) {
  if (!clickedAt) return false;
  const age = now.getTime() - new Date(clickedAt).getTime();
  return age >= 0 && age < ATTRIBUTION_WINDOW_MS;
}

/**
 * Last-click write: the newest click on any eligible link for the product
 * replaces the previous attribution and restarts the 30-day window.
 */
async function recordClickAttribution({ visitorId, link, now = new Date() }) {
  if (!link.targetProduct) return null;
  const productId = link.targetProduct._id || link.targetProduct;
  const product = await Product.findById(productId).select("status");
  if (!product || !PROMOTABLE_STATUSES.includes(product.status)) return null;
  if (!(await program().termsForOne(productId)).eligible) return null;

  return AffiliateAttribution.findOneAndUpdate(
    { visitorId, product: productId },
    {
      $set: {
        link: link._id,
        affiliateUser: link.affiliateUser,
        affiliateCode: link.affiliateCode,
        clickedAt: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  );
}

/**
 * Checkout-time lookup. Returns Map<productId, {link, affiliateUser,
 * affiliateCode, clickedAt}> using only server-side records; the caller passes
 * a visitorId and product ids it already validated against the database.
 */
async function resolveAttributions({ visitorId, buyerId = null, productIds = [], now = new Date() }) {
  const result = new Map();
  const vid = cleanVisitorId(visitorId);
  if (!vid || !productIds.length) return result;

  // Products whose seller runs the program right now, with the seller's rate.
  const terms = await program().termsFor(productIds);
  const rows = await AffiliateAttribution.find({
    visitorId: vid,
    product: { $in: productIds },
    clickedAt: { $gt: new Date(now.getTime() - ATTRIBUTION_WINDOW_MS), $lte: now },
  });

  for (const row of rows) {
    if (buyerId && String(row.affiliateUser) === String(buyerId)) continue; // no self-referral
    const t = terms.get(String(row.product));
    if (!t || !t.eligible) continue; // seller left the program since the click
    const link = await AffiliateLink.findById(row.link).select("targetProduct affiliateUser");
    if (!link || String(link.targetProduct) !== String(row.product)) continue;
    result.set(String(row.product), {
      link: link._id,
      affiliateUser: row.affiliateUser,
      affiliateCode: row.affiliateCode,
      clickedAt: row.clickedAt,
      vendorRate: t.vendorRate,
    });
  }
  return result;
}

/** Copies a resolved attribution onto a pending order item (mutates the plain item object). */
function applyAttribution(item, attribution) {
  if (!attribution) return item;
  item.affiliateUser = attribution.affiliateUser;
  item.affiliateLink = attribution.link;
  item.affiliateCode = attribution.affiliateCode;
  item.affiliateClickedAt = attribution.clickedAt;
  item.affiliateVendorRate = Number(attribution.vendorRate) || 0;
  return item;
}

/** Which affiliate (if any) earns on this order item. Legacy order-level fields are honoured as a fallback. */
function itemAffiliate(order, item) {
  if (item.affiliateUser && item.affiliateCode) {
    return { user: item.affiliateUser, code: item.affiliateCode, link: item.affiliateLink || null };
  }
  if (order.affiliateUser && order.affiliateCode) {
    return { user: order.affiliateUser, code: order.affiliateCode, link: null };
  }
  return null;
}

/**
 * Creates the commission record for one paid order item. Idempotent on
 * (order, orderItemId): a repeated webhook finds the row and changes nothing.
 */
async function recordConversion({ order, item, settlement, session }) {
  const aff = itemAffiliate(order, item);
  if (!aff || !settlement || !(settlement.affiliateShare > 0)) return null;

  const res = await ConversionAudit.updateOne(
    { order: order._id, orderItemId: item._id },
    {
      $setOnInsert: {
        affiliateUser: aff.user,
        link: aff.link,
        targetProduct: item.product || null,
        referralCode: aff.code,
        conversionValue: settlement.grossAmount,
        commissionEarned: settlement.affiliateShare,
        settlement: settlement._id,
        buyer: order.user,
        quantity: item.quantity,
        clickedAt: item.affiliateClickedAt || null,
        status: "PENDING",
        convertedAt: new Date(),
      },
    },
    { upsert: true, session }
  );

  if (res.upsertedCount && aff.link) {
    await AffiliateLink.updateOne({ _id: aff.link }, { $inc: { conversionCount: 1 } }, { session });
  }
  return res.upsertedCount ? true : false;
}

/**
 * Reverses commission after a refund/cancellation.
 *  - refundAmount omitted (or >= order total): full reversal of what remains.
 *  - otherwise proportional to refundAmount / order total, never above what remains.
 * `key` makes the call idempotent: replaying the same refund event is a no-op.
 */
async function reverseOrderCommission({ orderId, refundAmount = null, key, reason = "" }) {
  if (!key) throw new Error("A reversal key is required.");
  const order = await Order.findById(orderId).select("totalAmount");
  if (!order) throw new Error("Order not found.");

  const session = await orm.startSession();
  const outcome = [];
  try {
    await session.withTransaction(async () => {
      outcome.length = 0;
      const audits = await ConversionAudit.find({
        order: orderId,
        status: { $in: ["PENDING", "APPROVED", "PAID"] },
      }).session(session);

      const full = refundAmount == null || Number(refundAmount) >= order.totalAmount;
      const ratio = full ? 1 : Math.max(0, Number(refundAmount)) / order.totalAmount;

      for (const audit of audits) {
        if (audit.reversals.some((r) => r.key === key)) continue;
        const remaining = round2(audit.commissionEarned - audit.reversedAmount);
        const amount = Math.min(remaining, full ? remaining : round2(audit.commissionEarned * ratio));
        if (!(amount > 0)) continue;

        // Atomic guard so two concurrent replays cannot both apply.
        const claimed = await ConversionAudit.findOneAndUpdate(
          { _id: audit._id, "reversals.key": { $ne: key } },
          {
            $inc: { reversedAmount: amount },
            $push: { reversals: { key, amount, reason, at: new Date() } },
          },
          { returnDocument: "after", session }
        );
        if (!claimed) continue;

        const settlement = audit.settlement ? await Settlement.findById(audit.settlement).session(session) : null;
        const wallet = await AffiliateWallet.findOne({ affiliateUser: audit.affiliateUser }).session(session);
        let unrecovered = 0;
        if (wallet) {
          if (!settlement || settlement.status !== "RELEASED") {
            wallet.pendingBalance = Math.max(0, wallet.pendingBalance - amount);
          } else {
            const taken = Math.min(wallet.availableBalance, amount);
            wallet.availableBalance -= taken;
            unrecovered = round2(amount - taken); // already withdrawn
          }
          await wallet.save({ session });
        }

        if (unrecovered > 0) claimed.unrecoveredAmount = round2(claimed.unrecoveredAmount + unrecovered);
        if (claimed.reversedAmount >= claimed.commissionEarned) claimed.status = "REVERSED";
        await claimed.save({ session });
        outcome.push({ audit: audit._id, amount, unrecovered });
      }
    });
  } finally {
    await session.endSession();
  }
  return outcome;
}

module.exports = {
  ATTRIBUTION_WINDOW_MS,
  PROMOTABLE_STATUSES,
  mintVisitorId,
  cleanVisitorId,
  isWithinWindow,
  recordClickAttribution,
  resolveAttributions,
  applyAttribution,
  itemAffiliate,
  recordConversion,
  reverseOrderCommission,
};
