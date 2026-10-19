// Seller / supplier plans (Free and Premium).
//
// The subscription program is OFF until an admin switches it on (Admin →
// Subscriptions). While it is off every seller and supplier has every tool and
// no listing limit, so nobody is affected. When it is on, Free accounts keep
// the basics and Premium-only tools ask them to upgrade.
const Subscription = require("../models/Subscription");
const settings = require("./platformSettings.service");

// What Premium adds over Free (shown on the plan pages, checked in the API).
const FEATURES = {
  unlimitedListings: "Higher or unlimited product listings (fair use)",
  advancedAnalytics: "Advanced sales reports and product performance analytics",
  bulkUpload: "Bulk product upload and easier inventory management",
  storeBranding: "Premium store customization and branding",
  promotions: "Promotional campaigns and featured listings",
  prioritySupport: "Priority customer support",
  lowStockAlerts: "Low-stock alerts and sales notifications",
  growthInsights: "Supplier growth insights",
};

const FREE_INCLUDES = [
  "Create a seller or supplier account and store",
  "List products up to the Free listing limit",
  "Receive and manage orders",
  "Basic sales and inventory tools",
  "Standard support",
];

const ALL = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, true]));
const NONE = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, false]));

const isActivePremium = (sub) =>
  Boolean(sub && sub.plan === "PREMIUM" && sub.status === "ACTIVE" && sub.renewalDate && new Date(sub.renewalDate) > new Date());

/**
 * What a seller/supplier (by user id) can use right now.
 * { programActive, plan: "ALL_ACCESS" | "FREE" | "PREMIUM", features, productLimit }
 */
async function entitlements(userId) {
  const ops = await settings.get();
  if (!ops.subscriptionsEnabled) {
    return { programActive: false, plan: "ALL_ACCESS", features: { ...ALL }, productLimit: null };
  }
  const sub = userId ? await Subscription.findOne({ vendor: userId }).lean() : null;
  if (isActivePremium(sub)) {
    return { programActive: true, plan: "PREMIUM", features: { ...ALL }, productLimit: null, renewalDate: sub.renewalDate };
  }
  return { programActive: true, plan: "FREE", features: { ...NONE }, productLimit: ops.freeProductLimit };
}

// The error a Premium-only action returns to a Free account.
const upgradeError = (feature) =>
  Object.assign(new Error(`${FEATURES[feature] || "This tool"} is part of Seller Premium. Upgrade in Subscription to use it.`), {
    statusCode: 403, code: "PREMIUM_REQUIRED", feature,
  });

// Express middleware: let the request through only if the account has the feature.
// Admins are never limited. Staff act as the store owner (protect swaps req.user).
const requireFeature = (feature) => async (req, res, next) => {
  try {
    if (req.user?.role === "super_admin") return next();
    const ent = await entitlements(req.user?.id || req.user?._id);
    if (ent.features[feature]) return next();
    const err = upgradeError(feature);
    return res.status(err.statusCode).json({ message: err.message, code: err.code, feature });
  } catch (error) {
    return next(error);
  }
};

// Free plan listing limit (only while the program is on).
async function assertCanList(userId, countExisting) {
  const ent = await entitlements(userId);
  if (ent.productLimit === null) return;
  const count = await countExisting();
  if (count >= ent.productLimit) {
    throw Object.assign(new Error(`The Free plan lists up to ${ent.productLimit} products. Upgrade to Seller Premium in Subscription to list more.`), {
      statusCode: 403, code: "PREMIUM_REQUIRED", feature: "unlimitedListings",
    });
  }
}

module.exports = { FEATURES, FREE_INCLUDES, isActivePremium, entitlements, requireFeature, upgradeError, assertCanList };
