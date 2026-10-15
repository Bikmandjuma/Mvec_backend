// Global search for the portal header (command palette). Results depend on
// who is searching: sellers search their own orders, products, customers,
// promotions, payouts and purchases (staff only what their permissions
// allow); admins search the whole platform; suppliers and affiliates their
// own records. Each item carries the portal link it opens.
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const Vendor = require("../models/Vendor");
const Promotion = require("../models/Promotion");
const Dispute = require("../models/Dispute");
const Supplier = require("../models/Supplier");
const WholesaleOrder = require("../models/WholesaleOrder");
const WholesaleProduct = require("../models/WholesaleProduct");
const AffiliateLink = require("../models/AffiliateLink");
const { Payout } = require("../models/Payout");

const PER_GROUP = 5;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const money = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB") : "");
const title = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const q = (path, query) => `${path}?q=${encodeURIComponent(query)}`;

// Phone searches match however the number was typed (0788…, +250788…, 788…).
function phoneRegex(term) {
  const digits = term.replace(/\D/g, "");
  if (digits.length < 4) return null;
  const local = digits.replace(/^250/, "").replace(/^0/, "");
  return { $regex: esc(local), $options: "i" };
}

async function vendorGroups(req, term, rx) {
  const vid = String(req.user._id);
  const perms = req.staffMember ? (req.staffMember.permissions?.toObject?.() || req.staffMember.permissions || {}) : null;
  const can = (...keys) => !perms || keys.some((k) => perms[k]);
  const phone = phoneRegex(term);
  const groups = [];

  if (can("canManageOrders")) {
    const buyers = await User.find({ $or: [{ Fullname: rx }, { email: rx }, ...(phone ? [{ phone }] : [])] }).select("_id").limit(30);
    const buyerIds = buyers.map((u) => u._id);
    const or = [{ orderNumber: rx }, { "customer.name": rx }, ...(phone ? [{ "customer.phone": phone }] : []), ...(buyerIds.length ? [{ user: { $in: buyerIds } }] : [])];
    const orders = await Order.find({ "items.vendor": vid, $or: or }).sort({ createdAt: -1 }).limit(40).populate("user", "Fullname email phone");
    groups.push({
      key: "orders", label: "Orders",
      items: orders.slice(0, PER_GROUP).map((o) => {
        const total = (o.items || []).filter((i) => String(i.vendor) === vid).reduce((t, i) => t + i.price * i.quantity - (i.discount || 0), 0);
        return { id: String(o._id), title: o.orderNumber, subtitle: `${o.user?.Fullname || o.customer?.name || "Customer"} · ${money(total)} · ${day(o.createdAt)}`, badge: title(o.orderStatus), href: `/vendor/orders/${o._id}`, icon: "cart" };
      }),
    });
    // Customers: distinct buyers among matching orders (by account, else phone).
    const seen = new Map();
    for (const o of orders) {
      const name = o.user?.Fullname || o.customer?.name;
      const contact = o.user?.phone || o.customer?.phone || o.user?.email || "";
      const key = o.user?._id ? String(o.user._id) : contact;
      if (!name || !key || seen.has(key)) continue;
      const nameHit = new RegExp(esc(term), "i").test(`${name} ${contact} ${o.user?.email || ""}`) || (phone && contact.replace(/\D/g, "").includes(term.replace(/\D/g, "").replace(/^250/, "").replace(/^0/, "")));
      if (!nameHit) continue;
      seen.set(key, { id: key, title: name, subtitle: [contact, o.user ? "Account" : "Guest"].filter(Boolean).join(" · "), href: q("/vendor/customers", name), icon: "users" });
    }
    groups.push({ key: "customers", label: "Customers", items: [...seen.values()].slice(0, PER_GROUP) });
  }

  if (can("canManageProducts", "canManageOrders", "canManageMarketing")) {
    const products = await Product.find({ vendor: vid, $or: [{ name: rx }, { sku: rx }, { brand: rx }] }).sort({ updatedAt: -1 }).limit(PER_GROUP);
    groups.push({
      key: "products", label: "Products",
      items: products.map((p) => ({
        id: String(p._id), title: p.name, subtitle: `${money(p.discountPrice || p.price)} · ${p.stockQuantity} in stock${p.sku ? ` · ${p.sku}` : ""}`,
        badge: p.status === "ACTIVE" ? (p.stockQuantity <= (p.lowStockThreshold || 5) ? "Low stock" : "Active") : title(p.status),
        href: q("/vendor/products", p.name), image: p.media?.mainImage || "", icon: "box",
      })),
    });
  }

  if (can("canManageMarketing")) {
    const promos = await Promotion.find({ vendor: vid, $or: [{ code: rx }, { name: rx }] }).limit(PER_GROUP);
    groups.push({
      key: "promotions", label: "Promotions",
      items: promos.map((p) => ({ id: String(p._id), title: p.code, subtitle: `${p.name} · ${p.type === "PERCENT" ? `${p.value}% off` : p.type === "FIXED" ? `${money(p.value)} off` : "Free delivery"}`, badge: title(p.status), href: q("/vendor/promotions", p.code), icon: "tag" })),
    });
  }

  if (can("canManagePayouts")) {
    const payouts = await Payout.find({ vendor: vid, payoutNumber: rx }).sort({ createdAt: -1 }).limit(PER_GROUP);
    groups.push({
      key: "payouts", label: "Payouts",
      items: payouts.map((p) => ({ id: String(p._id), title: p.payoutNumber, subtitle: `${money(p.amount)} · ${day(p.createdAt)}`, badge: title(p.status), href: q("/vendor/transactions", p.payoutNumber), icon: "wallet" })),
    });
  }

  if (can("canManageProducts")) {
    const purchases = await WholesaleOrder.find({ vendor: vid, orderNumber: rx }).sort({ createdAt: -1 }).limit(PER_GROUP);
    groups.push({
      key: "purchases", label: "Purchases",
      items: purchases.map((w) => ({ id: String(w._id), title: w.orderNumber, subtitle: `${money(w.totalAmount)} · ${day(w.createdAt)}`, badge: title(w.status), href: q("/vendor/purchases", w.orderNumber), icon: "receipt" })),
    });
  }
  return groups;
}

// Seller profiles and seller accounts, one row per seller.
function sellers(profiles, accounts) {
  const rows = new Map();
  for (const v of profiles) rows.set(String(v.user || v._id), { id: String(v._id), title: v.businessName, subtitle: [v.email, v.phone].filter(Boolean).join(" · "), badge: title(v.status), href: q("/admin/vendors", v.businessName), icon: "shop" });
  for (const u of accounts) {
    if (!rows.has(String(u._id))) rows.set(String(u._id), { id: String(u._id), title: u.companyName, subtitle: [u.Fullname, u.email, u.phone].filter(Boolean).join(" · "), badge: u.status === "ACTIVE" ? "" : title(u.status), href: q("/admin/vendors", u.companyName), icon: "shop" });
  }
  return [...rows.values()].slice(0, PER_GROUP);
}

async function adminGroups(term, rx) {
  const phone = phoneRegex(term);
  const [users, vendorProfiles, sellerAccounts, orders, products, disputes] = await Promise.all([
    User.find({ $or: [{ Fullname: rx }, { email: rx }, ...(phone ? [{ phone }] : [])] }).sort({ createdAt: -1 }).limit(PER_GROUP),
    Vendor.find({ $or: [{ businessName: rx }, { email: rx }, ...(phone ? [{ phone }] : [])] }).limit(PER_GROUP),
    // Sellers are also known by the business name on their account.
    User.find({ role: "vendor", companyName: rx }).limit(PER_GROUP),
    Order.find({ $or: [{ orderNumber: rx }, { "customer.name": rx }] }).sort({ createdAt: -1 }).limit(PER_GROUP).populate("user", "Fullname"),
    Product.find({ $or: [{ name: rx }, { sku: rx }] }).sort({ updatedAt: -1 }).limit(PER_GROUP),
    Dispute.find({ disputeNumber: rx }).sort({ createdAt: -1 }).limit(PER_GROUP),
  ]);
  return [
    { key: "users", label: "Users", items: users.map((u) => ({ id: String(u._id), title: u.Fullname, subtitle: [u.email, u.phone, title(u.role)].filter(Boolean).join(" · "), badge: u.status === "ACTIVE" ? "" : title(u.status), href: q("/admin/users", u.email || u.phone || u.Fullname), icon: "user" })) },
    { key: "vendors", label: "Sellers", items: sellers(vendorProfiles, sellerAccounts) },
    { key: "orders", label: "Orders", items: orders.map((o) => ({ id: String(o._id), title: o.orderNumber, subtitle: `${o.user?.Fullname || o.customer?.name || "Customer"} · ${money(o.totalAmount)} · ${day(o.createdAt)}`, badge: title(o.orderStatus), href: `/admin/orders/${o._id}`, icon: "cart" })) },
    { key: "products", label: "Products", items: products.map((p) => ({ id: String(p._id), title: p.name, subtitle: `${money(p.discountPrice || p.price)} · ${p.stockQuantity} in stock`, badge: title(p.status), href: q("/admin/products", p.name), image: p.media?.mainImage || "", icon: "box" })) },
    { key: "disputes", label: "Disputes", items: disputes.map((d) => ({ id: String(d._id), title: d.disputeNumber, subtitle: `${money(d.disputedAmount)} · ${day(d.createdAt)}`, badge: title(d.status), href: q("/admin/disputes", d.disputeNumber), icon: "bell" })) },
  ];
}

async function supplierGroups(req, rx) {
  const supplier = await Supplier.findOne({ user: req.user._id }).select("_id");
  if (!supplier) return [];
  const [products, orders] = await Promise.all([
    WholesaleProduct.find({ supplier: supplier._id, name: rx }).limit(PER_GROUP),
    WholesaleOrder.find({ supplier: supplier._id, orderNumber: rx }).sort({ createdAt: -1 }).limit(PER_GROUP),
  ]);
  return [
    { key: "products", label: "Wholesale products", items: products.map((p) => ({ id: String(p._id), title: p.name, subtitle: `${money(p.wholesalePrice)} · MOQ ${p.moq} · ${p.stockQuantity} in stock`, badge: title(p.status), href: q("/supplier/products", p.name), icon: "box" })) },
    { key: "orders", label: "Wholesale orders", items: orders.map((w) => ({ id: String(w._id), title: w.orderNumber, subtitle: `${money(w.totalAmount)} · ${day(w.createdAt)}`, badge: title(w.status), href: q("/supplier/orders", w.orderNumber), icon: "receipt" })) },
  ];
}

async function affiliateGroups(req, rx) {
  const [links, products] = await Promise.all([
    AffiliateLink.find({ affiliateUser: req.user._id, $or: [{ affiliateCode: rx }, { label: rx }] }).limit(PER_GROUP).populate("targetProduct", "name"),
    Product.find({ status: "ACTIVE", name: rx }).limit(PER_GROUP),
  ]);
  return [
    { key: "links", label: "My links", items: links.map((l) => ({ id: String(l._id), title: l.affiliateCode, subtitle: [l.targetProduct?.name || "Storewide", l.label, `${l.clickCount || 0} clicks`].filter(Boolean).join(" · "), href: q("/affiliate/links", l.affiliateCode), icon: "tag" })) },
    { key: "products", label: "Products to promote", items: products.map((p) => ({ id: String(p._id), title: p.name, subtitle: money(p.discountPrice || p.price), href: q("/affiliate/products", p.name), image: p.media?.mainImage || "", icon: "box" })) },
  ];
}

// @route GET /api/search/portal?q=
exports.portalSearch = async (req, res) => {
  try {
    const term = String(req.query.q || "").trim().slice(0, 80);
    if (term.length < 2) return res.status(200).json({ query: term, groups: [], total: 0 });
    const rx = { $regex: esc(term), $options: "i" };
    const role = req.user.role;
    let groups = [];
    if (role === "super_admin") groups = await adminGroups(term, rx);
    else if (role === "vendor") groups = await vendorGroups(req, term, rx);
    else if (role === "supplier") groups = await supplierGroups(req, rx);
    else if (role === "affiliate") groups = await affiliateGroups(req, rx);
    groups = groups.filter((g) => g.items.length);
    return res.status(200).json({ query: term, groups, total: groups.reduce((t, g) => t + g.items.length, 0) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
