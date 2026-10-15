const orm = require("../database/orm");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const BuyerSubscription = require("../models/BuyerSubscription");
const Advertisement = require("../models/Advertisement");
const Vendor = require("../models/Vendor");
const SellerCharge = require("../models/SellerCharge");
const VendorWallet = require("../models/VendorWallet");
const subscriptionBilling = require("../services/subscriptionBilling.service");
const advertising = require("../services/advertising.service");
const sellerFinance = require("../services/sellerFinance.service");
const Product = require("../models/Product");

// ─── DISPLAY / DICTIONARY HELPERS ────────────────────────────────────────────
// All mapping constants keep the backend "friendly" values in sync with the
// already-implemented frontend pages (FeaturePages / SmartTable rows).

const SUBSCRIPTION_TIERS = [
  { key: "FREE", name: "Free", price: 0, billing: "Free" },
  { key: "PREMIUM", name: "Vendor Premium", price: 15000, billing: "Monthly" },
];

const AD_PLACEMENTS = {
  HOMEPAGE_HERO: "Homepage hero",
  CATEGORY_BANNER: "Category banner",
  SEARCH_RESULTS: "Search results",
  FEATURED: "Featured",
  PROMOTION: "Promotion",
};

const AD_PLACEMENT_LOOKUP = Object.fromEntries(
  Object.entries(AD_PLACEMENTS).map(([key, label]) => [
    label.toLowerCase(),
    key,
  ])
);

const AD_STATUS_LABEL = {
  PENDING: "In review",
  ACTIVE: "Active",
  PAUSED: "Paused",
  REJECTED: "Rejected",
  COMPLETED: "Completed",
};

const SUB_STATUS_LABEL = {
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-GB") : "—"; // DD/MM/YYYY

const normalizePlan = (plan) => {
  const p = String(plan || "").trim().toUpperCase();
  if (p === "PREMIUM" || p === "VENDOR PREMIUM" || p === "1") return "PREMIUM";
  return "FREE";
};

const normalizePlacement = (placement) => {
  const p = String(placement || "").trim();
  if (AD_PLACEMENTS[p]) return p;
  return AD_PLACEMENT_LOOKUP[p.toLowerCase()] || "SEARCH_RESULTS";
};

const resolveVendor = async (userId) => {
  const vendor = await Vendor.findOne({ user: userId });
  return vendor;
};

const mapSubscription = (sub, holder = "") => ({
  id: sub?.publicId,
  planKey: sub?.plan || "FREE",
  plan:
    sub?.plan === "PREMIUM"
      ? "Vendor Premium"
      : "Free",
  holder,
  price: sub?.price || 0,
  billing:
    sub?.billingCycle === "YEARLY"
      ? "Yearly"
      : sub?.billingCycle === "MONTHLY"
        ? "Monthly"
        : "Free",
  renewal: sub ? fmtDate(sub.renewalDate) : "—",
  renewalDate: sub?.renewalDate || null,
  startDate: sub?.startDate || null,
  autoRenew: sub ? sub.autoRenew !== false : false,
  status: sub
    ? SUB_STATUS_LABEL[sub.status] || "Active"
    : "Available",
});

const buildTierRows = (subscription, holder) => {
  const activeKey = subscription?.status === "ACTIVE" ? subscription.plan : null;
  return SUBSCRIPTION_TIERS.map((tier) => ({
    id: `TIER-${tier.key}`,
    planKey: tier.key,
    plan: tier.name,
    holder,
    price: tier.price,
    billing: tier.billing,
    renewal:
      activeKey === tier.key && subscription?.renewalDate
        ? fmtDate(subscription.renewalDate)
        : "—",
    status: activeKey === tier.key ? "Active" : "Available",
  }));
};

const BuyerSubscriptionTier = {
  FREE: { key: "FREE", name: "Free", price: 0, billing: "Free" },
  PREMIUM: { key: "PREMIUM", name: "Buyer Ad Removal", price: 5000, billing: "Monthly" },
};

const mapBuyerSubscription = (sub) => ({
  id: sub?.publicId,
  planKey: sub?.plan || "FREE",
  plan: sub?.plan === "PREMIUM" ? "Buyer Ad Removal" : "Free",
  price: sub?.price || 0,
  billing:
    sub?.billingCycle === "YEARLY"
      ? "Yearly"
      : sub?.billingCycle === "MONTHLY"
        ? "Monthly"
        : "Free",
  renewal: sub && sub.renewalDate ? fmtDate(sub.renewalDate) : "—",
  status: sub ? SUB_STATUS_LABEL[sub.status] || "Active" : "Available",
});

const buildBuyerTierRows = (subscription) => {
  const activeKey = subscription?.status === "ACTIVE" ? subscription.plan : null;
  return Object.values(BuyerSubscriptionTier).map((tier) => ({
    id: `TIER-${tier.key}`,
    planKey: tier.key,
    plan: tier.name,
    price: tier.price,
    billing: tier.billing,
    renewal:
      activeKey === tier.key && subscription?.renewalDate
        ? fmtDate(subscription.renewalDate)
        : "—",
    status: activeKey === tier.key ? "Active" : "Available",
  }));
};

const mapAdvertisement = (ad) => ({
  id: ad.publicId,
  // Database id: what the status endpoints expect in the URL.
  _id: String(ad._id),
  placementKey: ad.placement,
  product: ad.product,
  productId: ad.productId,
  placement: AD_PLACEMENTS[ad.placement] || ad.placement,
  budget: ad.budget,
  startDate: fmtDate(ad.startDate),
  endDate: ad.endDate ? fmtDate(ad.endDate) : "—",
  clicks: ad.clicks,
  impressions: ad.impressions,
  spent: Number(ad.spent || 0),
  refunded: Number(ad.refunded || 0),
  remaining: advertising.remaining(ad),
  costPerClick: advertising.COST_PER_CLICK,
  rejectionReason: ad.rejectionReason || "",
  placementKey: ad.placement,
  startDateRaw: ad.startDate,
  endDateRaw: ad.endDate,
  ctr: ad.impressions
    ? `${((ad.clicks / ad.impressions) * 100).toFixed(1)}%`
    : "—",
  status: AD_STATUS_LABEL[ad.status] || ad.status,
  statusKey: ad.status,
});

// ════════════════════════════════════════════════════════════════════════════
// VENDOR · SUBSCRIPTION
// ════════════════════════════════════════════════════════════════════════════

// @desc    View the vendor's current subscription and available tiers
// @route   GET /api/vendor/subscription
// @access  Private (vendor)
exports.getVendorSubscription = async (req, res) => {
  try {
    const vendor = await resolveVendor(req.user.id);
    if (!vendor) {
      return res
        .status(404)
        .json({ message: "Vendor profile not found. Please complete onboarding." });
    }

    const subscription = await Subscription.findOne({ vendor: req.user.id });
    const [balance, charges] = await Promise.all([
      VendorWallet.findOne({ vendor: req.user.id }),
      SellerCharge.find({ vendor: req.user.id, type: "SUBSCRIPTION" }).sort({ createdAt: -1 }).limit(24),
    ]);

    return res.status(200).json({
      subscription: subscription ? mapSubscription(subscription, vendor.businessName) : null,
      tiers: buildTierRows(subscription, vendor.businessName),
      availableBalance: Number(balance?.availableBalance || 0),
      charges,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Upgrade / downgrade the vendor freemium subscription tier
// @route   POST /api/vendor/subscription
// @access  Private (vendor)
exports.upgradeVendorSubscription = async (req, res) => {
  try {
    const vendor = await resolveVendor(req.user.id);
    if (!vendor) {
      return res
        .status(404)
        .json({ message: "Vendor profile not found. Please complete onboarding." });
    }

    // Premium is paid from the seller's available balance; "FREE" stops auto-renew.
    const plan = normalizePlan(req.body.plan);
    const { sub: subscription, message } = plan === "PREMIUM"
      ? await subscriptionBilling.startPremium(req.user.id)
      : await subscriptionBilling.cancelPremium(req.user.id);

    const balance = await VendorWallet.findOne({ vendor: req.user.id });
    return res.status(200).json({
      message,
      subscription: subscription ? mapSubscription(subscription, vendor.businessName) : null,
      tiers: buildTierRows(subscription, vendor.businessName),
      availableBalance: Number(balance?.availableBalance || 0),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// BUYER · SUBSCRIPTION (AD REMOVAL)
// ════════════════════════════════════════════════════════════════════════════

// @desc    View the buyer's current ad-removal subscription and tiers
// @route   GET /api/buyer/subscription
// @access  Private (buyer)
exports.getBuyerSubscription = async (req, res) => {
  try {
    const subscription = await BuyerSubscription.findOne({ buyer: req.user.id });

    return res.status(200).json({
      subscription: subscription ? mapBuyerSubscription(subscription) : null,
      tiers: buildBuyerTierRows(subscription),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Upgrade / cancel the buyer's premium ad-removal plan
// @route   POST /api/buyer/subscription
// @access  Private (buyer)
exports.upgradeBuyerSubscription = async (req, res) => {
  try {
    const plan = normalizePlan(req.body.plan);
    let subscription = await BuyerSubscription.findOne({ buyer: req.user.id });

    // Premium is switched on only by a payment (POST /api/buyer/subscription/checkout).
    if (plan === "PREMIUM" && !(subscription?.plan === "PREMIUM" && subscription?.status === "ACTIVE")) {
      return res.status(402).json({
        message: "Premium needs a payment. Choose mobile money or card to subscribe; you have not been charged.",
      });
    }

    if (plan === "PREMIUM") {
      const tier = BuyerSubscriptionTier.PREMIUM;
      if (!subscription) {
        subscription = new BuyerSubscription({ buyer: req.user.id });
      }
      subscription.plan = "PREMIUM";
      subscription.status = "ACTIVE";
      subscription.price = tier.price;
      subscription.billingCycle = "MONTHLY";
      subscription.autoRenew = req.body.autoRenew !== false;
      if (!subscription.startDate) subscription.startDate = new Date();
      subscription.renewalDate = new Date(
        subscription.startDate.getTime() + 30 * 24 * 60 * 60 * 1000
      );
      await subscription.save();
    } else {
      if (subscription) {
        subscription.plan = "FREE";
        subscription.status = "ACTIVE";
        subscription.price = 0;
        subscription.billingCycle = "FREE";
        subscription.renewalDate = null;
        await subscription.save();
      }
    }

    return res.status(200).json({
      message:
        plan === "PREMIUM"
          ? "Buyer Ad Removal activated successfully."
          : "Premium buyer plan cancelled.",
      subscription: mapBuyerSubscription(subscription),
      tiers: buildBuyerTierRows(subscription),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Pay for Premium (5,000 RWF / 30 days) by mobile money or card.
//          Premium switches on when the payment succeeds.
// @route   POST /api/buyer/subscription/checkout   { method: "momo" | "card", phoneNumber? }
// @access  Private (buyer)
exports.buyerPremiumCheckout = async (req, res) => {
  const payments = require("./payment.controller");
  const flutterwave = require("../services/flutterwave.service");
  const paymentService = require("../services/payment.service");
  const Payment = require("../models/Payment");
  const { PREMIUM } = require("../services/buyerSubscription.service");
  try {
    const method = String(req.body.method || "momo").toLowerCase();
    const userId = req.user.id;

    if (method === "momo") {
      const result = await payments.initiateStandalonePayment({
        amount: PREMIUM.price, phoneNumber: req.body.phoneNumber, userId,
        gatewayService: payments.paypackGateway, purpose: "BUYER_PREMIUM",
      });
      return res.status(200).json(result);
    }
    if (method !== "card") return res.status(400).json({ message: "Choose mobile money or card." });

    if (flutterwave.isSandbox() && process.env.NODE_ENV === "production") {
      return res.status(503).json({ message: "Card payments are temporarily unavailable. Please pay with mobile money." });
    }
    const txRef = `PREM-${userId}-${Date.now()}`;
    const payment = await Payment.create({
      user: userId, transactionReference: txRef, method: "CARD", gateway: "FLUTTERWAVE", provider: "CARD",
      amount: PREMIUM.price, currency: "RWF", status: "PENDING", purpose: "BUYER_PREMIUM",
    });
    if (flutterwave.isSandbox()) {
      const result = await flutterwave.verifyByReference(txRef);
      await paymentService.settleGatewayPayment({ payment, provider: "FLUTTERWAVE", status: result.status, amount: PREMIUM.price, payload: result.raw, externalTransactionId: result.id });
      return res.status(200).json({ message: "Card payment confirmed (test mode).", paymentId: payment._id, status: "SUCCESS", checkoutUrl: null });
    }
    const buyer = await User.findById(userId).select("Fullname email phone");
    const frontend = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    const checkout = await flutterwave.createCheckout({
      txRef, amount: PREMIUM.price,
      customer: { email: buyer?.email, phone: buyer?.phone, name: buyer?.Fullname },
      redirectUrl: `${frontend}/buyer/subscription?paymentId=${payment._id}`,
      description: "MVEC Premium (30 days)",
    });
    return res.status(200).json({ message: "Opening the secure card page…", paymentId: payment._id, status: "PENDING", checkoutUrl: checkout.link });
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) return res.status(error.statusCode).json({ message: error.message });
    console.error("Premium checkout failed:", error);
    return res.status(502).json({ message: "We could not start the payment right now. You have not been charged; please try again." });
  }
};

// @desc    Admin list all buyer ad-removal subscriptions
// @route   GET /api/admin/subscriptions?role=buyer
// @access  Private (super_admin)
exports.adminListBuyerSubscriptions = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (pageNum - 1) * limitNum;

    let [subscriptions, total] = await Promise.all([
      BuyerSubscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("buyer", "Fullname email"),
      BuyerSubscription.countDocuments(filter),
    ]);

    if (search) {
      const term = new RegExp(search, "i");
      subscriptions = subscriptions.filter(
        (s) => term.test(s.buyer?.Fullname || "") || term.test(s.publicId || "")
      );
    }

    const rows = subscriptions.map((sub) => ({
      ...mapBuyerSubscription(sub),
      holder: sub.buyer?.Fullname || "—",
      type: sub.plan === "PREMIUM" ? "Buyer Ad Removal" : "Free",
    }));

    return res
      .status(200)
      .json({ data: rows, meta: { page: pageNum, limit: limitNum, total } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// VENDOR · ADVERTISEMENTS
// ════════════════════════════════════════════════════════════════════════════

// @desc    List the vendor's ad placement campaigns
// @route   GET /api/vendor/advertisements
// @access  Private (vendor)
exports.getMyAdvertisements = async (req, res) => {
  try {
    const vendor = await resolveVendor(req.user.id);
    if (!vendor) {
      return res
        .status(404)
        .json({ message: "Vendor profile not found. Please complete onboarding." });
    }

    const ads = await Advertisement.find({ vendor: vendor._id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      data: ads.map(mapAdvertisement),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Submit an ad campaign; the budget is paid from the seller balance
// @route   POST /api/vendor/advertisements
// @access  Private (vendor)
exports.createAdvertisement = async (req, res) => {
  try {
    const vendor = await resolveVendor(req.user.id);
    if (!vendor) {
      return res
        .status(404)
        .json({ message: "Vendor profile not found. Please complete onboarding." });
    }

    const { placement, startDate, endDate, productId } = req.body;
    const budget = Number(req.body.budget);
    if (!productId || !orm.isValidObjectId(productId)) {
      return res.status(400).json({ message: "Choose one of your products to advertise." });
    }
    const product = await Product.findOne({ _id: productId, vendor: req.user.id });
    if (!product) return res.status(400).json({ message: "You can only advertise your own products." });
    if (product.status !== "ACTIVE" || !(product.stockQuantity > 0)) {
      return res.status(400).json({ message: `${product.name} must be active and in stock to advertise.` });
    }
    if (!Number.isInteger(budget) || budget < advertising.MIN_BUDGET) {
      return res.status(400).json({ message: `The minimum budget is ${advertising.MIN_BUDGET.toLocaleString("en-RW")} RWF (whole RWF).` });
    }
    const start = startDate ? new Date(startDate) : new Date();
    if (endDate && new Date(endDate) < start) {
      return res.status(400).json({ message: "The end date must be on or after the start date." });
    }
    if (endDate && new Date(endDate) < new Date(new Date().toDateString())) {
      return res.status(400).json({ message: "The end date can't be in the past." });
    }

    const ad = new Advertisement({
      vendor: vendor._id,
      product: product.name,
      productId: product._id,
      placement: normalizePlacement(placement),
      budget,
      startDate: start,
      endDate: endDate || null,
      status: "PENDING", // awaits MVEC admin approval
    });
    await ad.validate();
    // Make sure the publicId exists before charging against it.
    if (!ad.publicId) ad.publicId = `MVEC-AD-${require("crypto").randomBytes(4).toString("hex").toUpperCase()}`;

    const charged = await sellerFinance.chargeBalance(req.user.id, budget, {
      type: "ADVERTISING", reference: ad.publicId, description: `Ad budget · ${product.name} · ${AD_PLACEMENTS[ad.placement]}`,
    });
    if (!charged) {
      const balance = await VendorWallet.findOne({ vendor: req.user.id });
      return res.status(402).json({
        message: `The ${budget.toLocaleString("en-RW")} RWF budget is paid from your available balance (${Math.round(balance?.availableBalance || 0).toLocaleString("en-RW")} RWF). Lower the budget or wait for more sales to be released.`,
      });
    }
    try {
      await ad.save();
    } catch (err) {
      await sellerFinance.creditBalance(req.user.id, budget, { type: "ADVERTISING", reference: ad.publicId, description: "Ad budget refunded (campaign not created)" });
      throw err;
    }

    return res.status(201).json({
      message: `Campaign submitted. ${budget.toLocaleString("en-RW")} RWF was reserved from your balance; anything not spent on clicks comes back to you.`,
      advertisement: mapAdvertisement(ad),
      availableBalance: Number(charged.availableBalance || 0),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

const findOwnAd = async (req) => {
  const vendor = await resolveVendor(req.user.id);
  if (!vendor) return null;
  const adId = req.params.id;
  return Advertisement.findOne({
    ...(orm.isValidObjectId(adId) ? { _id: adId } : { publicId: adId }),
    vendor: vendor._id,
  });
};

// @desc    Vendor pauses / resumes a live campaign
// @route   PATCH /api/vendor/advertisements/:id/status
// @access  Private (vendor)
exports.updateMyAdvertisementStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["ACTIVE", "PAUSED"].includes(status)) {
      return res.status(400).json({ message: "status must be ACTIVE or PAUSED" });
    }
    const ad = await findOwnAd(req);
    if (!ad) return res.status(404).json({ message: "Advertisement campaign not found" });

    // Only approved campaigns can be paused or resumed; review stays with MVEC.
    const from = status === "PAUSED" ? "ACTIVE" : "PAUSED";
    if (ad.status === status) {
      return res.status(400).json({ message: status === "ACTIVE" ? "This campaign is already live." : "This campaign is already paused." });
    }
    if (ad.status !== from) {
      // Approving a campaign is MVEC's decision, so a pending one is forbidden (403).
      return res.status(ad.status === "PENDING" ? 403 : 400).json({
        message: ad.status === "PENDING" ? "This campaign is still being reviewed by MVEC." : `A ${AD_STATUS_LABEL[ad.status].toLowerCase()} campaign can't be ${status === "PAUSED" ? "paused" : "resumed"}.`,
      });
    }
    if (status === "ACTIVE" && ad.endDate && new Date(ad.endDate) < new Date(new Date().toDateString())) {
      return res.status(400).json({ message: "This campaign's end date has passed." });
    }
    // Vendors can pause and resume approved campaigns only. A pending or
    // rejected campaign goes live only after MVEC admin approval.
    if (!["ACTIVE", "PAUSED"].includes(ad.status)) {
      return res.status(403).json({ message: "This campaign is waiting for MVEC approval." });
    }

    ad.status = status;
    await ad.save();

    return res.status(200).json({
      message: `Campaign ${status === "PAUSED" ? "paused" : "resumed"}.`,
      advertisement: mapAdvertisement(ad),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Vendor ends a campaign (or withdraws one in review); unspent budget is returned
// @route   POST /api/vendor/advertisements/:id/end
// @access  Private (vendor)
exports.endMyAdvertisement = async (req, res) => {
  try {
    const ad = await findOwnAd(req);
    if (!ad) return res.status(404).json({ message: "Advertisement campaign not found" });
    if (!["PENDING", "ACTIVE", "PAUSED"].includes(ad.status)) {
      return res.status(400).json({ message: "This campaign has already ended." });
    }
    const returned = await advertising.finish(ad, "COMPLETED", { notify: false });
    return res.status(200).json({
      message: `Campaign ended. ${Math.round(returned).toLocaleString("en-RW")} RWF is back in your balance.`,
      advertisement: mapAdvertisement(ad),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// ADMIN · SUBSCRIPTIONS
// ════════════════════════════════════════════════════════════════════════════

// @desc    Admin list all vendor subscriptions
// @route   GET /api/admin/subscriptions
// @access  Private (super_admin)
exports.adminListSubscriptions = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (pageNum - 1) * limitNum;

    let [subscriptions, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("vendor", "Fullname email"),
      Subscription.countDocuments(filter),
    ]);

    if (search) {
      const term = new RegExp(search, "i");
      subscriptions = subscriptions.filter(
        (s) => term.test(s.vendor?.Fullname || "") || term.test(s.publicId || "")
      );
    }

    const rows = subscriptions.map((sub) =>
      mapSubscription(sub, sub.vendor?.Fullname || "—")
    );

    return res.status(200).json({ data: rows, meta: { page: pageNum, limit: limitNum, total } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Admin set a subscription status (cancel / reactivate / expire)
// @route   PATCH /api/admin/subscriptions/:id/status
// @access  Private (super_admin)
exports.adminUpdateSubscriptionStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["ACTIVE", "CANCELLED", "EXPIRED"].includes(status)) {
      return res.status(400).json({ message: "status must be ACTIVE, CANCELLED or EXPIRED" });
    }

    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    subscription.status = status;
    if (status === "CANCELLED" || status === "EXPIRED") subscription.autoRenew = false;
    await subscription.save();

    return res.status(200).json({
      message: `Subscription marked ${status.toLowerCase()}.`,
      subscription: mapSubscription(subscription),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// ADMIN · ADVERTISEMENTS
// ════════════════════════════════════════════════════════════════════════════

// @desc    Admin list all ad placement campaigns
// @route   GET /api/admin/advertisements
// @access  Private (super_admin)
exports.adminListAdvertisements = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status) filter.status = status.toUpperCase();

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (pageNum - 1) * limitNum;

    const [ads, total] = await Promise.all([
      Advertisement.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("vendor", "businessName"),
      Advertisement.countDocuments(filter),
    ]);

    const rows = ads.map((ad) => ({
      ...mapAdvertisement(ad),
      vendor: ad.vendor?.businessName || "—",
    }));

    return res.status(200).json({ data: rows, meta: { page: pageNum, limit: limitNum, total } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Admin approve / reject / pause an ad campaign
// @route   PATCH /api/admin/advertisements/:id/status
// @access  Private (super_admin)
exports.adminUpdateAdvertisementStatus = async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!["ACTIVE", "PAUSED", "REJECTED", "COMPLETED"].includes(status)) {
      return res.status(400).json({ message: "Invalid advertisement status" });
    }

    // Lists expose publicId as `id`; accept either identifier.
    const adId = String(req.params.id);
    const ad = await Advertisement.findOne(orm.isValidObjectId(adId) ? { _id: adId } : { publicId: adId });
    if (!ad) {
      return res.status(404).json({ message: "Advertisement campaign not found" });
    }

    const allowedFrom = { ACTIVE: ["PENDING", "PAUSED"], PAUSED: ["ACTIVE"], REJECTED: ["PENDING"], COMPLETED: ["ACTIVE", "PAUSED", "PENDING"] }[status];
    if (!allowedFrom.includes(ad.status)) {
      return res.status(400).json({ message: `A ${AD_STATUS_LABEL[ad.status].toLowerCase()} campaign can't be marked ${AD_STATUS_LABEL[status].toLowerCase()}.` });
    }

    if (status === "REJECTED" || status === "COMPLETED") {
      if (status === "REJECTED" && !String(reason || "").trim()) {
        return res.status(400).json({ message: "Give the seller a reason for rejecting the campaign." });
      }
      await advertising.finish(ad, status, { reason: String(reason || "").trim() });
    } else {
      const wasPending = ad.status === "PENDING";
      ad.status = status;
      await ad.save();
      if (wasPending) {
        const user = await advertising.sellerUserOf(ad);
        if (user) await sellerFinance.notify(user, "Ad campaign approved", `Your campaign for ${ad.product} is live. Each buyer click costs ${advertising.COST_PER_CLICK} RWF from its budget.`, ad.publicId, "SYSTEM");
      }
    }

    return res.status(200).json({
      message: `Campaign marked ${AD_STATUS_LABEL[status] || status.toLowerCase()}.`,
      advertisement: { ...mapAdvertisement(ad), vendor: ad.vendor },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Live, approved ads for one placement (e.g. the home page hero)
// @route   GET /api/advertisements?placement=HOMEPAGE_HERO
// @access  Public
// Only ACTIVE (admin-approved) campaigns inside their date range, linked to a
// live product that belongs to the advertising vendor, are returned.
exports.listLiveAdvertisements = async (req, res) => {
  try {
    const placement = String(req.query.placement || "HOMEPAGE_HERO");
    if (!AD_PLACEMENTS[placement]) {
      return res.status(400).json({ message: "Unknown placement" });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 12);
    const now = new Date();

    const ads = await Advertisement.find({
      placement,
      status: "ACTIVE",
      productId: { $ne: null },
      startDate: { $lte: now },
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    })
      .sort({ budget: -1, createdAt: -1 })
      .limit(limit * 3)
      .populate("vendor", "user businessName")
      .populate({
        path: "productId",
        match: { status: "ACTIVE" },
        select: "name price discountPrice media stockQuantity status vendor category averageRating reviewCount publicId",
        populate: [
          { path: "vendor", select: "Fullname companyName" },
          { path: "category", select: "name slug" },
        ],
      });

    const seen = new Set();
    const data = [];
    for (const ad of ads) {
      const product = ad.productId;
      if (!product || !ad.vendor) continue;
      const productVendor = String(product.vendor?._id || product.vendor);
      if (productVendor !== String(ad.vendor.user)) continue;
      if (seen.has(String(product._id))) continue;
      seen.add(String(product._id));
      data.push({ id: ad.publicId, placement, product });
      if (data.length >= limit) break;
    }

    return res.status(200).json({ data });
  } catch (error) {
    console.error("Error listing advertisements:", error);
    return res.status(500).json({ message: "Could not load promotions." });
  }
};
