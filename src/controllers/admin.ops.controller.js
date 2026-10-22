// Admin operations built on the marketplace's own records: the "needs your
// attention" queue, payments, MVEC earnings, analytics, risk signals, seller
// trust scores, live platform settings and the audit log. Nothing here keeps
// its own copy of the data; every number is read from the source tables.
const User = require("../models/User");
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Settlement = require("../models/Settlement");
const PricingSnapshot = require("../models/PricingSnapshot");
const Dispute = require("../models/Dispute");
const Disbursement = require("../models/Disbursement");
const AffiliatePayout = require("../models/AffiliatePayout");
const ConversionAudit = require("../models/ConversionAudit");
const Advertisement = require("../models/Advertisement");
const SupportCase = require("../models/SupportCase");
const AbuseReport = require("../models/AbuseReport");
const { Payout } = require("../models/Payout");
const WholesaleOrder = require("../models/WholesaleOrder");
const Product = require("../models/Product");
const AuditLog = require("../models/AuditLog");

const DAY = 24 * 60 * 60 * 1000;
const idOf = (v) => String(v?._id || v || "");
const num = (v) => Number(v) || 0;
const round = (v) => Math.round(num(v) * 100) / 100;
const page = (q, max = 100) => {
  const p = Math.max(1, parseInt(q.page, 10) || 1);
  const size = Math.min(max, Math.max(1, parseInt(q.pageSize || q.limit, 10) || 25));
  return { page: p, pageSize: size, skip: (p - 1) * size };
};
const fail = (res, error, what) => {
  console.error(`Admin ${what} error:`, error);
  return res.status(500).json({ message: `Could not load ${what}. Please try again.` });
};
const nameOf = (u) => u?.companyName || u?.businessName || u?.Fullname || u?.email || "—";
const OPEN_DISPUTES = ["OPEN", "UNDER_REVIEW", "EVIDENCE_SUBMITTED"];

// ─── Needs your attention ──────────────────────────────────────────────────
// Everything waiting on an administrator, with where to handle it. Used by the
// overview queue and the sidebar badges.
exports.getAttention = async (_req, res) => {
  try {
    const supplierUsers = await Supplier.distinct("user");
    const [
      vendors, suppliers, disputes, manualRefunds, failedTransfers, affiliateWithdrawals,
      supplierPayouts, wholesaleDisputes, ads, support, abuse, staleShipments,
    ] = await Promise.all([
      Vendor.countDocuments({ verificationStatus: "PENDING" }),
      Supplier.countDocuments({ verificationStatus: "PENDING" }),
      Dispute.countDocuments({ status: { $in: OPEN_DISPUTES } }),
      Disbursement.countDocuments({ channel: "MANUAL", status: { $in: ["QUEUED", "FAILED"] } }),
      Disbursement.countDocuments({ channel: { $ne: "MANUAL" }, status: "FAILED" }),
      AffiliatePayout.countDocuments({ status: "PENDING" }),
      supplierUsers.length ? Payout.countDocuments({ vendor: { $in: supplierUsers }, status: { $in: ["PENDING", "PROCESSING"] }, payoutMethod: "BANK" }) : 0,
      WholesaleOrder.countDocuments({ status: "DISPUTED" }),
      Advertisement.countDocuments({ status: "PENDING" }),
      SupportCase.countDocuments({ status: { $in: ["OPEN", "IN_PROGRESS"] } }),
      AbuseReport.countDocuments({ status: { $in: ["PENDING", "INVESTIGATE"] } }),
      Order.countDocuments({ paymentStatus: "PAID", orderStatus: { $in: ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT"] }, paidAt: { $lte: new Date(Date.now() - 3 * DAY) } }),
    ]);
    const items = [
      { key: "vendors", label: "Sellers waiting for verification", count: vendors, link: "/admin/vendors", urgent: true, hint: "They cannot show as verified until you review them." },
      { key: "suppliers", label: "Suppliers waiting for verification", count: suppliers, link: "/admin/suppliers", urgent: true },
      { key: "disputes", label: "Open disputes", count: disputes, link: "/admin/disputes", urgent: true, hint: "The seller's payment stays on hold until you decide." },
      { key: "manualRefunds", label: "Refunds to send by hand (K-Pay card/SPENN)", count: manualRefunds, link: "/admin/transfers", urgent: true },
      { key: "failedTransfers", label: "Transfers that failed", count: failedTransfers, link: "/admin/transfers", urgent: true },
      { key: "affiliateWithdrawals", label: "Affiliate withdrawals to approve", count: affiliateWithdrawals, link: "/admin/transfers" },
      { key: "supplierPayouts", label: "Supplier bank payouts to send", count: supplierPayouts, link: "/admin/suppliers?tab=payouts" },
      { key: "wholesaleDisputes", label: "Wholesale orders with a reported problem", count: wholesaleDisputes, link: "/admin/suppliers?tab=wholesale", urgent: true, hint: "Pay the supplier or refund the vendor." },
      { key: "ads", label: "Advertisements to approve", count: ads, link: "/admin/advertising" },
      { key: "support", label: "Open support requests", count: support, link: "/admin/support" },
      { key: "abuse", label: "Abuse reports to investigate", count: abuse, link: "/admin/risk" },
      { key: "staleShipments", label: "Paid orders not shipped after 3 days", count: staleShipments, link: "/admin/deliveries", hint: "Remind the seller or cancel and refund." },
    ];
    // Sidebar badge per page = sum of the items that link there.
    const badges = {};
    for (const it of items) {
      const path = it.link.split("?")[0];
      badges[path] = (badges[path] || 0) + it.count;
    }
    return res.json({ items, total: items.reduce((s, it) => s + it.count, 0), badges });
  } catch (error) {
    return fail(res, error, "the attention queue");
  }
};

// ─── Payments ──────────────────────────────────────────────────────────────
exports.getPayments = async (req, res) => {
  try {
    const { page: p, pageSize, skip } = page(req.query);
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.gateway) filter.gateway = String(req.query.gateway).toUpperCase();
    if (req.query.purpose === "ORDER") filter.parentOrder = { $ne: null };
    const q = String(req.query.q || "").trim();
    if (q) {
      const orders = await Order.find({ orderNumber: { $regex: q, $options: "i" } }).select("_id").limit(50).lean();
      filter.$or = [{ transactionReference: { $regex: q, $options: "i" } }, { gatewayReference: { $regex: q, $options: "i" } }, { parentOrder: { $in: orders.map((o) => o._id) } }];
    }
    const since = new Date(Date.now() - num(req.query.days || 30) * DAY);
    const [rows, total, recent] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize)
        .populate("parentOrder", "orderNumber orderStatus").populate("user", "Fullname email phone").lean(),
      Payment.countDocuments(filter),
      Payment.find({ createdAt: { $gte: since } }).select("status amount gateway method gatewayFee").lean(),
    ]);
    const summary = { successful: 0, successfulCount: 0, pending: 0, pendingCount: 0, failedCount: 0, refunded: 0, fees: 0, byGateway: {} };
    for (const x of recent) {
      const amount = num(x.amount);
      if (x.status === "SUCCESS") {
        summary.successful += amount; summary.successfulCount += 1; summary.fees += num(x.gatewayFee);
        const g = x.gateway || "OTHER";
        summary.byGateway[g] = (summary.byGateway[g] || 0) + amount;
      } else if (["PENDING", "PROCESSING"].includes(x.status)) { summary.pending += amount; summary.pendingCount += 1; }
      else if (x.status === "FAILED") summary.failedCount += 1;
      else if (x.status === "REFUNDED") summary.refunded += amount;
    }
    return res.json({
      data: rows.map((x) => ({
        id: idOf(x), reference: x.transactionReference, gatewayReference: x.gatewayReference || "",
        order: x.parentOrder ? { id: idOf(x.parentOrder), orderNumber: x.parentOrder.orderNumber, status: x.parentOrder.orderStatus } : null,
        purpose: x.parentOrder ? "Order" : (x.purpose || "Other"),
        payer: x.user ? { id: idOf(x.user), name: x.user.Fullname, email: x.user.email } : null,
        amount: num(x.amount), fee: num(x.gatewayFee), method: x.method, gateway: x.gateway || "", phone: x.phoneNumber || "",
        status: x.status, paidAt: x.paidAt, createdAt: x.createdAt,
      })),
      meta: { page: p, pageSize, total },
      summary: { ...summary, days: num(req.query.days || 30) },
    });
  } catch (error) {
    return fail(res, error, "payments");
  }
};

// ─── MVEC earnings (per order line) ────────────────────────────────────────
exports.getEarnings = async (req, res) => {
  try {
    const { page: p, pageSize, skip } = page(req.query);
    const days = num(req.query.days || 30);
    const filter = { createdAt: { $gte: new Date(Date.now() - days * DAY) } };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [rows, total, all] = await Promise.all([
      Settlement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize)
        .populate("vendor", "Fullname companyName businessName").lean(),
      Settlement.countDocuments(filter),
      Settlement.find(filter).select("grossAmount commissionAmount developerShare adminShare affiliateShare vendorAffiliateShare gatewayFee netAmount status").lean(),
    ]);
    // A settlement belongs to a buyer order or to a wholesale (supplier → vendor) order.
    const orderIds = rows.map((r) => r.order).filter(Boolean);
    const [retail, wholesale] = await Promise.all([
      Order.find({ _id: { $in: orderIds } }).select("orderNumber").lean(),
      WholesaleOrder.find({ _id: { $in: orderIds } }).select("orderNumber").lean(),
    ]);
    const orderOf = new Map([...retail.map((o) => [idOf(o), { id: idOf(o), orderNumber: o.orderNumber, kind: "Retail" }]), ...wholesale.map((o) => [idOf(o), { id: idOf(o), orderNumber: o.orderNumber, kind: "Wholesale" }])]);
    const t = { gross: 0, platformFee: 0, developer: 0, affiliates: 0, affiliatesPaidBySellers: 0, gatewayFees: 0, mvecNet: 0, sellers: 0, held: 0, released: 0 };
    for (const s of all) {
      if (["REFUNDED", "CANCELLED"].includes(s.status)) continue;
      t.gross += num(s.grossAmount); t.platformFee += num(s.commissionAmount); t.developer += num(s.developerShare);
      t.affiliates += num(s.affiliateShare); t.affiliatesPaidBySellers += num(s.vendorAffiliateShare);
      // MVEC keeps the admin share and the developer share (the platform's).
      const keeps = num(s.adminShare) + num(s.developerShare);
      t.gatewayFees += num(s.gatewayFee); t.mvecNet += keeps; t.sellers += num(s.netAmount);
      if (s.status === "RELEASED") t.released += keeps; else t.held += keeps;
    }
    // Other MVEC income in the period: sponsored clicks and subscription fees.
    const LedgerEntry = require("../models/LedgerEntry");
    const extra = await LedgerEntry.find({ entryType: { $in: ["AD_CLICK_REVENUE", "SUBSCRIPTION_FEE"] }, createdAt: { $gte: new Date(Date.now() - days * DAY) } }).select("entryType amount").lean();
    t.adRevenue = extra.filter((e) => e.entryType === "AD_CLICK_REVENUE").reduce((n, e) => n + num(e.amount), 0);
    t.subscriptionRevenue = extra.filter((e) => e.entryType === "SUBSCRIPTION_FEE").reduce((n, e) => n + num(e.amount), 0);
    Object.keys(t).forEach((k) => { t[k] = round(t[k]); });
    return res.json({
      data: rows.map((s) => ({
        id: idOf(s), reference: s.settlementReference,
        order: orderOf.get(idOf(s.order)) || null,
        seller: nameOf(s.vendor), gross: num(s.grossAmount), platformFee: num(s.commissionAmount), rate: s.commissionRate ?? null, gatewayFeePayer: s.gatewayFeePayer,
        developer: num(s.developerShare), affiliate: num(s.affiliateShare), affiliatePaidBySeller: num(s.vendorAffiliateShare),
        gatewayFee: num(s.gatewayFee), mvecNet: num(s.adminShare) + num(s.developerShare), sellerNet: num(s.netAmount),
        status: s.status, createdAt: s.createdAt, releasedAt: s.releasedAt,
      })),
      meta: { page: p, pageSize, total },
      totals: { ...t, days },
    });
  } catch (error) {
    return fail(res, error, "earnings");
  }
};

// ─── Analytics ─────────────────────────────────────────────────────────────
const RECEIVED = ["PAID", "CONFIRMED", "DISPUTED"];
exports.getAnalytics = async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, num(req.query.days || 30)));
    const since = new Date(Date.now() - days * DAY);
    const prevSince = new Date(since.getTime() - days * DAY);
    const [orders, prevOrders, snapshots, settlements, users, payments, disputes] = await Promise.all([
      Order.find({ createdAt: { $gte: since } }).select("totalAmount paymentStatus orderStatus createdAt paymentMethod").limit(50000).lean(),
      Order.find({ createdAt: { $gte: prevSince, $lt: since }, paymentStatus: { $in: RECEIVED } }).select("totalAmount").limit(50000).lean(),
      PricingSnapshot.find({ createdAt: { $gte: since } }).select("product vendor grossTotal quantity order").limit(50000).lean(),
      Settlement.find({ createdAt: { $gte: since }, status: { $nin: ["REFUNDED", "CANCELLED"] } }).select("vendor grossAmount adminShare").limit(50000).lean(),
      User.find({ createdAt: { $gte: since } }).select("role createdAt").limit(50000).lean(),
      Payment.find({ createdAt: { $gte: since }, status: "SUCCESS" }).select("gateway method amount").limit(50000).lean(),
      Dispute.countDocuments({ createdAt: { $gte: since } }),
    ]);
    // Money was received for these orders. A disputed order was paid (MVEC is
    // holding the money), so it counts as a sale until it is refunded; the
    // seller breakdown, payment mix and MVEC Earnings use the same rule.
    const paid = orders.filter((o) => [...RECEIVED, "REFUNDED"].includes(o.paymentStatus));
    const kept = paid.filter((o) => o.paymentStatus !== "REFUNDED");
    const gmv = kept.reduce((s, o) => s + num(o.totalAmount), 0);
    const prevGmv = prevOrders.reduce((s, o) => s + num(o.totalAmount), 0);
    const refunded = paid.filter((o) => o.paymentStatus === "REFUNDED").length;
    const delivered = orders.filter((o) => ["DELIVERED", "COMPLETED"].includes(o.orderStatus)).length;

    // Daily series (Kigali day).
    const key = (d) => new Date(new Date(d).getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
    const series = new Map();
    for (let i = days - 1; i >= 0; i -= 1) series.set(key(Date.now() - i * DAY), { day: key(Date.now() - i * DAY), gmv: 0, orders: 0, users: 0 });
    for (const o of kept) { const r = series.get(key(o.createdAt)); if (r) { r.gmv += num(o.totalAmount); r.orders += 1; } }
    for (const u of users) { const r = series.get(key(u.createdAt)); if (r) r.users += 1; }

    const statusBreakdown = {};
    for (const o of orders) statusBreakdown[o.orderStatus] = (statusBreakdown[o.orderStatus] || 0) + 1;

    const byVendor = new Map();
    for (const s of settlements) {
      const v = byVendor.get(idOf(s.vendor)) || { sales: 0, mvec: 0, lines: 0 };
      v.sales += num(s.grossAmount); v.mvec += num(s.adminShare); v.lines += 1;
      byVendor.set(idOf(s.vendor), v);
    }
    const refundedOrders = new Set(paid.filter((o) => o.paymentStatus === "REFUNDED").map(idOf));
    const byProduct = new Map();
    for (const s of snapshots) {
      if (refundedOrders.has(idOf(s.order))) continue;
      const pr = byProduct.get(idOf(s.product)) || { sales: 0, units: 0 };
      pr.sales += num(s.grossTotal); pr.units += num(s.quantity);
      byProduct.set(idOf(s.product), pr);
    }
    const topVendorIds = [...byVendor.entries()].sort((a, b) => b[1].sales - a[1].sales).slice(0, 8);
    const topProductIds = [...byProduct.entries()].sort((a, b) => b[1].sales - a[1].sales).slice(0, 8);
    const [vendorProfiles, vendorUsers, products] = await Promise.all([
      Vendor.find({ user: { $in: topVendorIds.map(([id]) => id) } }).select("user businessName").lean(),
      User.find({ _id: { $in: topVendorIds.map(([id]) => id) } }).select("Fullname companyName").lean(),
      Product.find({ _id: { $in: topProductIds.map(([id]) => id) } }).select("name").lean(),
    ]);
    const vName = new Map([...vendorUsers.map((u) => [idOf(u), nameOf(u)]), ...vendorProfiles.map((v) => [idOf(v.user), v.businessName])]);
    const pName = new Map(products.map((x) => [idOf(x), x.name]));

    const paymentMix = {};
    for (const x of payments) {
      const label = x.gateway === "KPAY" ? `K-Pay ${x.method === "CARD" ? "card" : x.method === "SPENN" ? "SPENN" : "mobile money"}` : x.method === "CARD" ? "Card" : x.method === "AIRTEL" ? "Airtel Money" : "MTN MoMo";
      paymentMix[label] = (paymentMix[label] || 0) + num(x.amount);
    }
    const newUsers = {};
    for (const u of users) newUsers[u.role] = (newUsers[u.role] || 0) + 1;

    return res.json({
      days,
      totals: {
        gmv: round(gmv), gmvChange: prevGmv ? Math.round(((gmv - prevGmv) / prevGmv) * 1000) / 10 : null,
        orders: orders.length, paidOrders: kept.length, averageOrder: kept.length ? Math.round(gmv / kept.length) : 0,
        delivered, refundRate: paid.length ? Math.round((refunded / paid.length) * 1000) / 10 : 0,
        conversion: orders.length ? Math.round((paid.length / orders.length) * 1000) / 10 : 0,
        mvecEarned: round(settlements.reduce((s, x) => s + num(x.adminShare), 0)),
        newUsers: users.length, disputes,
      },
      series: [...series.values()],
      statusBreakdown,
      topSellers: topVendorIds.map(([id, v]) => ({ id, name: vName.get(id) || "Seller", sales: round(v.sales), mvec: round(v.mvec), lines: v.lines })),
      topProducts: topProductIds.map(([id, v]) => ({ id, name: pName.get(id) || "Removed product", sales: round(v.sales), units: v.units })),
      paymentMix,
      newUsers,
    });
  } catch (error) {
    return fail(res, error, "analytics");
  }
};

// ─── Risk signals ──────────────────────────────────────────────────────────
// Computed from what actually happened; nothing is stored, so the list is
// always current. Each signal links to where it can be handled.
exports.getRisk = async (_req, res) => {
  try {
    const d30 = new Date(Date.now() - 30 * DAY);
    const d1 = new Date(Date.now() - DAY);
    const [failedPayments, refundedOrders, disputes, reversals, abuse, held, stale, manual] = await Promise.all([
      Payment.find({ status: "FAILED", createdAt: { $gte: d1 } }).select("user").lean(),
      Order.find({ paymentStatus: "REFUNDED", updatedAt: { $gte: d30 } }).select("items.vendor").lean(),
      Dispute.find({ createdAt: { $gte: d30 } }).select("vendor status").lean(),
      ConversionAudit.find({ status: "REVERSED", updatedAt: { $gte: d30 } }).select("affiliateUser").lean(),
      AbuseReport.find({ status: { $in: ["PENDING", "INVESTIGATE"] } }).sort({ createdAt: -1 }).limit(50).populate("targetUser", "Fullname companyName email").lean(),
      Settlement.countDocuments({ status: "ADMIN_HOLD" }),
      Order.find({ paymentStatus: "PAID", orderStatus: { $in: ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT"] }, paidAt: { $lte: new Date(Date.now() - 3 * DAY) } }).select("items.vendor").lean(),
      Disbursement.find({ channel: "MANUAL", status: { $in: ["QUEUED", "FAILED"] }, createdAt: { $lte: new Date(Date.now() - 2 * DAY) } }).select("_id").lean(),
    ]);
    const [agingDisputes, uncollected, slaBreached, waitingOnBuyer, ops] = await Promise.all([
      Dispute.find({ status: { $in: ["OPEN", "EVIDENCE_SUBMITTED", "UNDER_REVIEW"] }, createdAt: { $lte: new Date(Date.now() - 3 * DAY) } }).select("vendor disputeNumber createdAt").lean(),
      Order.find({ paymentStatus: "PAID", shippingMethod: "PICKUP", orderStatus: "READY_FOR_SHIPMENT", updatedAt: { $lte: new Date(Date.now() - 7 * DAY) } }).select("items.vendor").lean(),
      Order.find({ paymentStatus: "PAID", orderStatus: { $in: ["CONFIRMED", "PROCESSING"] }, slaBreached: true }).select("items.vendor").lean(),
      Order.find({ paymentStatus: "PAID", orderStatus: { $in: ["SHIPPED", "OUT_FOR_DELIVERY"] }, updatedAt: { $lte: new Date(Date.now() - 3 * DAY) } }).select("_id").lean(),
      require("../services/platformSettings.service").get(),
    ]);
    const autoReleaseOn = Number(ops.autoReleaseDays) > 0;
    const count = (list, pick) => {
      const m = new Map();
      for (const x of list) for (const id of [].concat(pick(x))) if (id) m.set(id, (m.get(id) || 0) + 1);
      return m;
    };
    const signals = [];
    const ids = new Set();
    const add = (s) => { signals.push(s); if (s.partyId) ids.add(s.partyId); };

    for (const [id, n] of count(failedPayments, (x) => idOf(x.user))) if (n >= 3) add({ area: "Payments", partyId: id, signal: `${n} failed payments in the last 24 hours`, level: n >= 6 ? "High" : "Medium", link: "/admin/payments?status=FAILED" });
    for (const [id, n] of count(refundedOrders, (o) => [...new Set((o.items || []).map((i) => idOf(i.vendor)))])) if (n >= 3) add({ area: "Seller", partyId: id, signal: `${n} refunded orders in 30 days`, level: n >= 6 ? "High" : "Medium", link: "/admin/orders" });
    for (const [id, n] of count(disputes, (x) => idOf(x.vendor))) if (n >= 2) add({ area: "Seller", partyId: id, signal: `${n} disputes in 30 days`, level: n >= 4 ? "High" : "Medium", link: "/admin/disputes" });
    for (const [id, n] of count(stale, (o) => [...new Set((o.items || []).map((i) => idOf(i.vendor)))])) add({ area: "Seller", partyId: id, signal: `${n} paid order${n === 1 ? "" : "s"} not shipped after 3 days`, level: n >= 3 ? "High" : "Low", link: "/admin/deliveries" });
    for (const [id, n] of count(reversals, (x) => idOf(x.affiliateUser))) if (n >= 3) add({ area: "Affiliate", partyId: id, signal: `${n} commissions reversed in 30 days (refunded sales)`, level: n >= 6 ? "High" : "Medium", link: "/admin/affiliates" });
    for (const r of abuse) add({ area: "Abuse report", partyId: idOf(r.targetUser), partyName: nameOf(r.targetUser), signal: `${String(r.reasonCategory || "").toLowerCase().replaceAll("_", " ")}: ${String(r.description || "").slice(0, 120)}`, level: r.reasonCategory === "FRAUDULENT_ACTIVITY" ? "High" : "Medium", link: "", reportId: idOf(r), reportStatus: r.status });
    // Disputes waiting too long for a decision (the money is frozen meanwhile).
    for (const d of agingDisputes) {
      const days = Math.floor((Date.now() - new Date(d.createdAt).getTime()) / DAY);
      add({ area: "Dispute", partyId: idOf(d.vendor), signal: `Problem report ${d.disputeNumber} open for ${days} days`, level: days >= 7 ? "High" : "Medium", link: "/admin/disputes" });
    }
    // Pickup orders ready for a week but never collected.
    for (const [id, n] of count(uncollected, (o) => [...new Set((o.items || []).map((i) => idOf(i.vendor)))])) add({ area: "Seller", partyId: id, signal: `${n} pickup order${n === 1 ? "" : "s"} ready for over 7 days, not collected`, level: "Low", link: "/admin/deliveries" });
    // The 3-hour shipping promise was missed (flagged by the SLA job).
    for (const [id, n] of count(slaBreached, (o) => [...new Set((o.items || []).map((i) => idOf(i.vendor)))])) add({ area: "Seller", partyId: id, signal: `${n} paid order${n === 1 ? "" : "s"} missed the 3-hour dispatch promise`, level: n >= 3 ? "High" : "Low", link: "/admin/orders" });
    // Shipped orders waiting on the buyer while automatic release is switched off.
    if (!autoReleaseOn && waitingOnBuyer.length) add({ area: "Payments", signal: `${waitingOnBuyer.length} shipped order${waitingOnBuyer.length === 1 ? "" : "s"} waiting over 3 days for the buyer's code (automatic release is off)`, level: "Medium", link: "/admin/deliveries" });
    if (manual.length) add({ area: "Refunds", signal: `${manual.length} manual refund${manual.length === 1 ? "" : "s"} waiting more than 2 days`, level: "High", link: "/admin/transfers" });
    if (held) add({ area: "Payments", signal: `${held} seller payment${held === 1 ? "" : "s"} on hold by an admin`, level: "Low", link: "/admin/ledger" });

    const people = ids.size ? await User.find({ _id: { $in: [...ids] } }).select("Fullname companyName email role").lean() : [];
    const who = new Map(people.map((u) => [idOf(u), u]));
    const order = { High: 0, Medium: 1, Low: 2 };
    return res.json({
      signals: signals.map((s, i) => ({ id: `R${i + 1}`, ...s, partyName: s.partyName || (s.partyId ? nameOf(who.get(s.partyId)) : "MVEC"), partyRole: who.get(s.partyId)?.role || "" }))
        .sort((a, b) => order[a.level] - order[b.level]),
    });
  } catch (error) {
    return fail(res, error, "risk signals");
  }
};

// ─── Seller trust scores ───────────────────────────────────────────────────
// Score out of 100 from the last 90 days, counting only finished orders
// (delivered or refunded): delivered (50), not refunded (20), no disputes (20)
// and buyer rating (10). Fewer than 3 finished orders: "New".
exports.getTrust = async (_req, res) => {
  try {
    const since = new Date(Date.now() - 90 * DAY);
    const [vendors, settlements, disputes] = await Promise.all([
      Vendor.find({}).select("user businessName verificationStatus status ratingAvg").lean(),
      Settlement.find({ createdAt: { $gte: since } }).select("vendor order status").lean(),
      Dispute.find({ createdAt: { $gte: since } }).select("vendor order").lean(),
    ]);
    // A buyer cancelling (their right within 30 minutes of paying) is not the
    // seller's fault, so those orders don't count at all.
    const refundedIds = [...new Set(settlements.filter((x) => ["REFUNDED", "CANCELLED"].includes(x.status)).map((x) => idOf(x.order)))];
    const buyerCancelled = new Set(refundedIds.length
      ? (await Order.find({ _id: { $in: refundedIds } }).select("cancellationReason").lean())
        .filter((o) => /^Buyer cancelled/i.test(String(o.cancellationReason || ""))).map(idOf)
      : []);
    const stats = new Map();
    const get = (id) => { if (!stats.has(id)) stats.set(id, { orders: new Set(), released: new Set(), refunded: new Set(), disputed: new Set() }); return stats.get(id); };
    for (const s of settlements) {
      if (buyerCancelled.has(idOf(s.order))) continue;
      const v = get(idOf(s.vendor)); const o = idOf(s.order);
      v.orders.add(o);
      if (s.status === "RELEASED") v.released.add(o);
      if (["REFUNDED", "CANCELLED"].includes(s.status)) v.refunded.add(o);
    }
    for (const d of disputes) get(idOf(d.vendor)).disputed.add(idOf(d.order));
    const rows = vendors.map((v) => {
      const s = stats.get(idOf(v.user)) || get(idOf(v.user));
      const orders = s.orders.size;
      const finished = s.released.size + s.refunded.size;
      const completion = finished ? s.released.size / finished : 0;
      const refundRate = finished ? s.refunded.size / finished : 0;
      const disputeRate = orders ? s.disputed.size / orders : 0;
      const rating = num(v.ratingAvg);
      const score = finished < 3 ? null : Math.round(completion * 50 + (1 - refundRate) * 20 + (1 - Math.min(1, disputeRate * 5)) * 20 + (rating ? (rating / 5) * 10 : 5));
      return {
        id: idOf(v), userId: idOf(v.user), name: v.businessName, verification: v.verificationStatus, status: v.status,
        orders, finished, inProgress: orders - finished, completion: Math.round(completion * 100), refundRate: Math.round(refundRate * 100), disputeRate: Math.round(disputeRate * 100),
        rating, score, band: score === null ? "New" : score >= 80 ? "Trusted" : score >= 60 ? "Watch" : "At risk",
      };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return res.json({ data: rows });
  } catch (error) {
    return fail(res, error, "trust scores");
  }
};

// ─── Platform settings (live, read from the code and environment) ──────────
exports.getPlatform = async (_req, res) => {
  try {
    const commission = require("../services/commission.service");
    const { MAX_VENDOR_RATE } = require("../services/affiliateProgram.service");
    const messaging = require("../services/messaging.service");
    const kpay = require("../services/kpay.service");
    const flutterwave = require("../services/flutterwave.service");
    const paypack = require("../services/paypack.service");
    const CommissionRule = require("../models/CommissionRule");
    const ops = await require("../services/platformSettings.service").get();
    const [queued, failed, activeRules, cfg] = await Promise.all([
      Disbursement.countDocuments({ status: { $in: ["QUEUED", "SENT"] } }),
      Disbursement.countDocuments({ status: "FAILED" }),
      CommissionRule.countDocuments({ isActive: true }),
      commission.getSettings(),
    ]);
    const live = (sandbox) => (sandbox ? "Test mode" : "Live");
    return res.json({
      fees: [
        { label: "Default MVEC commission", value: `${cfg.defaultCommissionPercent}%`, detail: `Used when no category or seller rule matches. ${activeRules} active rule${activeRules === 1 ? "" : "s"}.` },
        { label: "Affiliate share paid by MVEC", value: `${cfg.affiliateSharePercent}% of the commission`, detail: "Only on sales from an affiliate link." },
        { label: "Affiliate rate a seller can add", value: `0–${MAX_VENDOR_RATE}% of the sale`, detail: "Paid by the seller on top, only if they joined the affiliate program." },
        { label: "Payment provider fees paid by", value: cfg.gatewayFeePayer === "SELLER" ? "The seller" : "MVEC", detail: cfg.gatewayFeePayer === "SELLER" ? "Deducted from the seller's share of each sale." : "Deducted from MVEC's commission." },
      ],
      rules: [
        { label: "Time to pay before an order is cancelled", value: "30 minutes" },
        { label: "Buyer can cancel for a full refund", value: "30 minutes after paying, before shipping" },
        { label: "Seller is paid", value: ops.autoReleaseDays > 0 ? `When the buyer gives the delivery code, or automatically ${ops.autoReleaseDays} day${ops.autoReleaseDays === 1 ? "" : "s"} after shipping if no problem is reported` : "When the buyer gives the 6-digit delivery code (automatic release is off)" },
        { label: "Subscription plans", value: ops.subscriptionsEnabled ? `On · Seller Premium ${Number(ops.sellerPremiumPrice).toLocaleString("en-RW")} RWF/month` : "Off · every tool is free for now" },
        { label: "Affiliate link remembers a visitor for", value: "30 days (last link clicked wins)" },
        { label: "Affiliate withdrawals sent automatically", value: `Mobile money up to ${num(process.env.AFFILIATE_AUTO_PAYOUT_MAX || 100000).toLocaleString("en-RW")} RWF; larger or bank: admin approval` },
        { label: "Minimum withdrawal", value: "Affiliates 10,000 RWF · Suppliers 50,000 RWF · Sellers 1,000 RWF" },
        { label: "Seller verification", value: "Manual: an admin reviews every new or updated profile" },
      ],
      integrations: [
        { label: "Mobile money (Paypack: MTN, Airtel)", status: live(paypack.isSandbox()), env: "PAYPACK_CLIENT_ID, PAYPACK_CLIENT_SECRET" },
        { label: "Cards (Flutterwave)", status: live(flutterwave.isSandbox()), env: "FLW_SECRET_KEY" },
        { label: "K-Pay (mobile money, card, SPENN)", status: live(kpay.isSandbox()), env: "KPAY_API_KEY, KPAY_USERNAME, KPAY_PASSWORD, KPAY_RETAILER_ID" },
        { label: "SMS", status: messaging.smsAvailable() ? "On" : "Off", env: "SMS provider keys" },
        { label: "Email", status: messaging.emailConfigured() ? "On" : "Off", env: "SMTP settings" },
      ],
      jobs: [
        { label: "Cancel unpaid orders", schedule: "Every minute" },
        { label: "Send and confirm refunds and withdrawals", schedule: "Every 5 minutes", detail: `${queued} in progress, ${failed} failed` },
        { label: "Delivery deadline checks", schedule: "Every 15 minutes" },
        { label: "Pay sellers when the buyer stays silent", schedule: "Every 15 minutes", detail: ops.autoReleaseDays > 0 ? `${ops.autoReleaseDays} day${ops.autoReleaseDays === 1 ? "" : "s"} after shipping` : "Off" },
        { label: "Pass unanswered problem reports to MVEC", schedule: "Every 30 minutes", detail: `After ${ops.disputeResponseDays} day${ops.disputeResponseDays === 1 ? "" : "s"} without an answer from the seller` },
        { label: "Premium renewals", schedule: "Hourly", detail: ops.subscriptionsEnabled ? "Plans on" : "Paused: plans are off" },
        { label: "End expired ad campaigns", schedule: "Hourly" },
      ],
      environment: process.env.NODE_ENV || "development",
      commissionRules: { active: activeRules, applied: true, note: "Manage rates under Money → Commission rules." },
    });
  } catch (error) {
    return fail(res, error, "platform settings");
  }
};

// ─── Audit log ─────────────────────────────────────────────────────────────
exports.getAuditLogs = async (req, res) => {
  try {
    const { page: p, pageSize, skip } = page(req.query);
    const filter = {};
    if (req.query.targetType) filter.targetType = String(req.query.targetType);
    if (req.query.targetId) filter.targetId = String(req.query.targetId);
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ action: { $regex: q, $options: "i" } }, { actorName: { $regex: q, $options: "i" } }, { targetId: q }];
    const [rows, total, types] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct("targetType"),
    ]);
    return res.json({
      data: rows.map((r) => ({ id: idOf(r), at: r.createdAt, actor: r.actorName, action: r.action, targetType: r.targetType, targetId: r.targetId, detail: r.detail, path: r.path, method: r.method })),
      meta: { page: p, pageSize, total },
      targetTypes: types.filter(Boolean).sort(),
    });
  } catch (error) {
    return fail(res, error, "the audit log");
  }
};
