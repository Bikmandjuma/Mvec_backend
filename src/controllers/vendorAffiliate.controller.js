// Seller view of affiliate marketing: orders referred by affiliates for this
// seller's products, the affiliates and products driving them, and link
// clicks. Affiliate commission comes out of MVEC's platform fee, so referred
// sales cost the seller nothing extra.
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const AffiliateLink = require("../models/AffiliateLink");
const { AFFILIATE_PERCENT } = require("../config/revenueSplit");

const CLOSED = ["CANCELLED", "FAILED", "REFUNDED", "RETURNED"];

exports.getVendorAffiliateSummary = async (req, res) => {
  try {
    const vid = String(req.user.id);
    const [orders, products] = await Promise.all([
      Order.find({ "items.vendor": vid, affiliateUser: { $ne: null } }).sort({ createdAt: -1 }),
      Product.find({ vendor: vid }).select("name status media"),
    ]);
    const productIds = products.map((p) => p._id);
    const links = productIds.length ? await AffiliateLink.find({ targetProduct: { $in: productIds } }) : [];
    const affiliateIds = [...new Set([...orders.map((o) => String(o.affiliateUser)), ...links.map((l) => String(l.affiliateUser))])];
    const users = affiliateIds.length ? await User.find({ _id: { $in: affiliateIds } }).select("Fullname email") : [];
    const nameOf = new Map(users.map((u) => [String(u._id), u.Fullname || u.email || "Affiliate"]));
    const productName = new Map(products.map((p) => [String(p._id), p.name]));

    const byAffiliate = new Map();
    const byProduct = new Map();
    const touch = (map, key, init) => map.get(key) || map.set(key, init()).get(key);
    const recent = [];
    let sales = 0, paidOrders = 0, counted = 0;

    for (const o of orders) {
      const items = (o.items || []).filter((i) => String(i.vendor) === vid);
      const value = items.reduce((t, i) => t + Number(i.price) * Number(i.quantity) - Number(i.discount || 0), 0);
      const live = !CLOSED.includes(o.orderStatus);
      const aff = String(o.affiliateUser);
      if (live) {
        counted += 1;
        sales += value;
        if (o.paymentStatus === "PAID") paidOrders += 1;
        const a = touch(byAffiliate, aff, () => ({ affiliateId: aff, name: nameOf.get(aff) || "Affiliate", orders: 0, sales: 0, clicks: 0, links: 0, lastOrderAt: null }));
        a.orders += 1; a.sales += value; a.lastOrderAt = a.lastOrderAt || o.createdAt;
        for (const i of items) {
          const k = String(i.product);
          const p = touch(byProduct, k, () => ({ productId: k, name: productName.get(k) || i.name, orders: 0, units: 0, sales: 0, clicks: 0, links: 0 }));
          p.orders += 1; p.units += Number(i.quantity); p.sales += Number(i.price) * Number(i.quantity) - Number(i.discount || 0);
        }
      }
      if (recent.length < 20) {
        recent.push({
          orderId: o._id, orderNumber: o.orderNumber, date: o.createdAt, affiliate: nameOf.get(aff) || "Affiliate",
          code: o.affiliateCode, sales: Math.round(value), orderStatus: o.orderStatus, paymentStatus: o.paymentStatus,
        });
      }
    }
    for (const l of links) {
      const aff = String(l.affiliateUser);
      const a = touch(byAffiliate, aff, () => ({ affiliateId: aff, name: nameOf.get(aff) || "Affiliate", orders: 0, sales: 0, clicks: 0, links: 0, lastOrderAt: null }));
      a.links += 1; a.clicks += Number(l.clickCount || 0);
      const k = String(l.targetProduct);
      const p = touch(byProduct, k, () => ({ productId: k, name: productName.get(k) || "Product", orders: 0, units: 0, sales: 0, clicks: 0, links: 0 }));
      p.links += 1; p.clicks += Number(l.clickCount || 0);
    }

    const clicks = links.reduce((t, l) => t + Number(l.clickCount || 0), 0);
    const round = (rows) => rows.map((r) => ({ ...r, sales: Math.round(r.sales) }));
    return res.status(200).json({
      totals: {
        orders: counted, paidOrders, sales: Math.round(sales), affiliates: byAffiliate.size,
        links: links.length, clicks, conversionRate: clicks ? +((counted / clicks) * 100).toFixed(1) : null,
      },
      affiliates: round([...byAffiliate.values()].sort((a, b) => b.sales - a.sales || b.clicks - a.clicks)),
      products: round([...byProduct.values()].sort((a, b) => b.sales - a.sales || b.clicks - a.clicks)),
      recent,
      commissionPercent: AFFILIATE_PERCENT,
      commissionPaidBy: "MVEC",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
