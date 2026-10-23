// Wholesale orders between a vendor (buyer) and a supplier (seller).
//
// Life of an order:
//   PENDING_PAYMENT  created from the supplier's catalog (stock is reserved) or
//                    from an accepted quote; unpaid orders expire after 48 hours
//   ESCROW_HELD      the vendor paid; MVEC holds the money (a held settlement
//                    with the wholesale commission frozen at payment time)
//   SHIPPED          the supplier sent the goods
//   CONFIRMED_RELEASED  the vendor confirmed receipt (or 7 days passed without
//                    a problem report): the supplier is paid, minus commission,
//                    and the goods are added to the vendor store chosen at
//                    ordering (see stock.service)
//   DISPUTED         the vendor reported a problem; an admin releases or refunds
//   CANCELLED        before shipping, by the vendor, the supplier or an admin
//                    (paid orders are refunded the way the vendor paid)
//
// The money uses the same escrow, ledger and wallets as retail orders.
const orm = require("../database/orm");
const WholesaleOrder = require("../models/WholesaleOrder");
const VendorWallet = require("../models/VendorWallet");
const Supplier = require("../models/Supplier");
const WholesaleProduct = require("../models/WholesaleProduct");
const Settlement = require("../models/Settlement");
const Payment = require("../models/Payment");
const stock = require("./stock.service");
const { resolveOwnedStore } = require("../utils/vendorStore.util");

const HOURS = 60 * 60 * 1000;
const UNPAID_EXPIRY_HOURS = 48;
const SHIP_WITHIN_DAYS = 7;
const AUTO_RELEASE_DAYS = 7;
const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const rwf = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const notifications = () => require("./notification.service");
const notify = (to, payload) => notifications().notify(to, payload).catch(() => {});

async function inTransaction(work) {
  const session = await orm.startSession();
  session.startTransaction();
  try {
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

class WholesaleService {
  /** Create an order from the supplier's catalog: validate MOQ, reserve stock. */
  async createWholesaleOrder({ vendorId, supplierId, items, storeId }) {
    if (!orm.isValidObjectId(supplierId)) throw httpError(400, "Invalid supplier ID provided.");
    if (!orm.isValidObjectId(vendorId)) throw httpError(400, "Invalid vendor ID provided.");
    const supplier = await Supplier.findOne({ _id: supplierId, status: "ACTIVE", verificationStatus: "VERIFIED" });
    if (!supplier) throw httpError(400, "Supplier is not active and verified.");
    if (String(supplier.user) === String(vendorId)) throw httpError(400, "You cannot order from yourself.");
    if (!Array.isArray(items) || items.length === 0) throw httpError(400, "At least one wholesale product is required.");
    // The store that receives the goods; none chosen = the primary store.
    let store = null;
    if (storeId) {
      store = await resolveOwnedStore(vendorId, storeId);
      if (!store) throw httpError(400, "Choose one of your own stores to receive the goods.");
    }

    const lines = [];
    for (const item of items) {
      if (!item.productId || !orm.isValidObjectId(item.productId)) {
        throw httpError(400, `Invalid product ID for item '${item.productName || ""}'. Only real catalog products can be ordered.`);
      }
      const quantity = Number(item.quantity);
      const product = await WholesaleProduct.findOne({ _id: item.productId, supplier: supplier._id, status: "ACTIVE" });
      if (!product) throw httpError(400, "A requested item is not an active product from this supplier.");
      if (!Number.isInteger(quantity) || quantity < product.moq) {
        throw httpError(400, `MOQ Breach: Item '${product.name}' requires a minimum quantity of ${product.moq}, but got ${quantity}.`);
      }
      if (quantity > product.stockQuantity) {
        throw httpError(400, `Insufficient stock for '${product.name}'. Available: ${product.stockQuantity}.`);
      }
      // Whole francs, so the order total always equals what the vendor pays.
      const unitPrice = Math.round(product.wholesalePrice * (1 - (Number(product.bulkDiscount) || 0) / 100));
      lines.push({ product, quantity, unitPrice });
    }

    // Reserve stock atomically; undo what was taken if any line runs out meanwhile.
    const taken = [];
    try {
      for (const line of lines) {
        const res = await WholesaleProduct.findOneAndUpdate(
          { _id: line.product._id, stockQuantity: { $gte: line.quantity } },
          { $inc: { stockQuantity: -line.quantity } },
          { new: true },
        );
        if (!res) throw httpError(409, `'${line.product.name}' just sold out. Please lower the quantity.`);
        taken.push(line);
        await stock.syncWholesaleStatus(res);
      }
    } catch (error) {
      for (const line of taken) {
        await WholesaleProduct.updateOne({ _id: line.product._id }, { $inc: { stockQuantity: line.quantity } });
        await stock.syncWholesaleStatus(line.product._id);
      }
      throw error;
    }

    const order = await WholesaleOrder.create({
      orderNumber: `WSO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
      vendor: vendorId,
      supplier: supplier.user,
      items: lines.map(({ product, quantity, unitPrice }) => ({ product: product._id, productName: product.name, unit: product.unit || "piece", unitPrice, quantity, moq: product.moq })),
      totalAmount: lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
      category: lines[0].product.category || "",
      stockReserved: true,
      store: store?._id || null,
      status: "PENDING_PAYMENT",
      deliveryOtp: Math.floor(100000 + Math.random() * 900000).toString(),
    });
    notify(supplier.user, {
      type: "ORDER", title: `New wholesale order ${order.orderNumber}`,
      message: `${rwf(order.totalAmount)}. The stock is reserved; you will be told when the vendor pays.`, link: "/supplier/orders",
    });
    return order;
  }

  /** Create an order from an accepted quote (no catalog products, no stock to reserve). */
  async createFromQuote({ quote, request }) {
    return WholesaleOrder.create({
      orderNumber: `WSO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
      vendor: request.vendor,
      supplier: quote.supplier,
      quote: quote._id,
      category: request.category,
      items: (quote.lines || []).map((l) => ({ product: null, productName: l.product, unit: l.unit || "piece", unitPrice: Math.round(Number(l.unitPrice)), quantity: Number(l.units), moq: 1 })),
      totalAmount: Math.round(Number(quote.totalAmount)),
      stockReserved: false,
      status: "PENDING_PAYMENT",
      deliveryOtp: Math.floor(100000 + Math.random() * 900000).toString(),
    });
  }

  async releaseStock(order) {
    if (!order.stockReserved) return;
    for (const item of order.items || []) {
      if (!item.product) continue;
      await WholesaleProduct.updateOne({ _id: item.product }, { $inc: { stockQuantity: Number(item.quantity) || 0 } });
      await stock.syncWholesaleStatus(item.product);
    }
    order.stockReserved = false;
  }

  async markWholesaleOrderShipped(orderId, supplierUserId) {
    const order = await WholesaleOrder.findOne({ _id: orderId, supplier: supplierUserId });
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (order.status !== "ESCROW_HELD") throw httpError(409, "Only paid orders can be marked as shipped.");
    order.status = "SHIPPED";
    order.shippedAt = new Date();
    await order.save();
    notify(order.vendor, {
      type: "DELIVERY", title: `${order.orderNumber} is on its way`,
      message: `Confirm receipt when the goods arrive, or report a problem. If you do neither, the supplier is paid automatically after ${AUTO_RELEASE_DAYS} days.`, link: "/vendor/purchases",
    });
    return order;
  }

  /** Commission split for the whole order, line by line (wholesale rules). */
  async splitForOrder(order, gatewayFee = 0) {
    const commission = require("./commission.service");
    const Category = require("../models/Category");
    const productIds = (order.items || []).map((i) => i.product).filter(Boolean);
    const products = productIds.length ? await WholesaleProduct.find({ _id: { $in: productIds } }).select("category").lean() : [];
    const catName = new Map(products.map((p) => [String(p._id), p.category]));
    const names = [...new Set([...(order.items || []).map((i) => catName.get(String(i.product)) || order.category).filter(Boolean)])];
    const cats = names.length ? await Category.find({ name: { $in: names } }).select("name").lean() : [];
    const catId = new Map(cats.map((c) => [c.name.toLowerCase(), c._id]));
    const gross = Number(order.totalAmount);
    const total = { totalPlatformFee: 0, developerShare: 0, adminShare: 0, vendorNet: 0, gatewayFee: 0 };
    let payer = "MVEC";
    for (const item of order.items || []) {
      const lineGross = Number(item.unitPrice) * Number(item.quantity);
      const name = catName.get(String(item.product)) || order.category || "";
      const split = await commission.splitFor({
        scope: "WHOLESALE", vendorId: order.supplier, categoryId: catId.get(name.toLowerCase()) || null,
        grossTotal: lineGross, hasAffiliate: false, gatewayFee: gross ? (Number(gatewayFee) * lineGross) / gross : 0,
      });
      for (const k of Object.keys(total)) total[k] += Number(split[k]) || 0;
      payer = split.gatewayFeePayer;
    }
    const round = (n) => Math.round(n * 100) / 100;
    Object.keys(total).forEach((k) => { total[k] = round(total[k]); });
    return { ...total, affiliateShare: 0, vendorAffiliateShare: 0, gatewayFeePayer: payer, commissionRate: gross ? round((total.totalPlatformFee / gross) * 100) : 0 };
  }

  /** Kept for the admin "paid outside MVEC" action. */
  async holdWholesaleEscrow(orderId) {
    const order = await WholesaleOrder.findById(orderId);
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (order.status !== "PENDING_PAYMENT") throw httpError(409, `Invalid order status transition from ${order.status}`);
    return this.lockInEscrow(order, 0);
  }

  async lockInEscrow(order, gatewayFee) {
    const financial = require("./financial.service");
    const split = await this.splitForOrder(order, gatewayFee);
    await inTransaction(async (session) => {
      await financial.lockPaymentInEscrow({
        orderId: order._id, vendorId: order.supplier, grossAmount: Number(order.totalAmount),
        commissionAmount: split.totalPlatformFee, split, session,
      });
      order.status = "ESCROW_HELD";
      order.paidAt = new Date();
      order.stockReserved = false; // the stock is now sold
      await order.save({ session });
    });
    return order;
  }

  /**
   * A confirmed payment for a wholesale order: check it covers the order,
   * hold the money in escrow and tell the supplier to ship. Safe to repeat.
   * A payment that arrives after the order expired is refunded.
   */
  async markWholesalePaid(orderId, payment) {
    const order = await WholesaleOrder.findById(orderId);
    if (!order) throw new Error(`Wholesale order ${orderId} not found for payment ${payment.transactionReference}.`);
    if (order.status === "CANCELLED") {
      await this.refundPayment(order, payment, "The order had already expired when the payment arrived.");
      return order;
    }
    if (order.status !== "PENDING_PAYMENT") return order;
    if (Math.round(Number(payment.amount)) !== Math.round(Number(order.totalAmount))) {
      throw new Error(`Wholesale payment ${payment.transactionReference} is ${payment.amount} RWF but the order is ${order.totalAmount} RWF.`);
    }
    await this.lockInEscrow(order, Number(payment.gatewayFee) || 0);
    notify(order.supplier, {
      type: "ORDER", title: `Wholesale order ${order.orderNumber} is paid`,
      message: `${rwf(order.totalAmount)} is held by MVEC. Ship within ${SHIP_WITHIN_DAYS} days; you are paid when the vendor confirms receipt.`,
      link: "/supplier/orders", sms: `MVEC: wholesale order ${order.orderNumber} is paid. Please ship it.`,
    });
    notify(order.vendor, { type: "PAYMENT", title: `Payment received for ${order.orderNumber}`, message: "MVEC holds the money until you confirm you received the goods.", link: "/vendor/purchases" });
    return order;
  }

  /** Pay the supplier: release the held settlement (minus commission), then stock the vendor's store. */
  async releaseToSupplier(order, how = "Vendor confirmed receipt") {
    const financial = require("./financial.service");
    let net = Number(order.totalAmount);
    await inTransaction(async (session) => {
      const settlement = await Settlement.findOne({ order: order._id, status: "HELD" }).session(session);
      if (settlement) {
        await financial.releaseEscrowToVendor({ settlementId: settlement._id, session });
        net = Number(settlement.netAmount);
      } else {
        // Orders paid before escrow settlements existed: credit the full amount.
        await VendorWallet.findOneAndUpdate({ vendor: order.supplier }, { $inc: { availableBalance: net, totalEarned: net } }, { upsert: true, session });
      }
      order.status = "CONFIRMED_RELEASED";
      order.confirmedAt = new Date();
      await order.save({ session });
    });
    notify(order.supplier, { type: "PAYOUT", title: `You were paid for ${order.orderNumber}`, message: `${how}. ${rwf(net)} is now in your balance.`, link: "/supplier/payments" });
    // The money is settled either way; a stocking failure is for MVEC to fix
    // (POST /wholesale/admin/orders/:id/restock), not a reason to undo it.
    let stocked = null;
    try {
      stocked = await stock.stockVendorStore(order);
      if (!stocked.skipped) order.stockedAt = new Date();
    } catch (error) {
      console.error(`Stocking ${order.orderNumber} failed:`, error.message);
      notifications().adminAlert({ title: `Stock ${order.orderNumber} by hand`, message: `The order completed but its goods could not be added to the vendor's store: ${error.message}`, link: "/admin/suppliers?tab=wholesale" }).catch(() => {});
    }
    return { order, net, stocked };
  }

  /** The vendor confirms the goods arrived. */
  async confirmReceiptAndRelease(orderId, vendorUserId) {
    const order = await WholesaleOrder.findOne({ _id: orderId, ...(vendorUserId ? { vendor: vendorUserId } : {}) });
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (!["ESCROW_HELD", "SHIPPED", "DELIVERED"].includes(order.status)) throw httpError(409, `Cannot confirm an order that is ${order.status.toLowerCase().replaceAll("_", " ")}.`);
    const { net, stocked } = await this.releaseToSupplier(order);
    return { order, supplierReceived: net, stocked: stocked?.stocked || [] };
  }

  /** Admin: add a completed order's goods to the vendor's store if that failed. */
  async restockCompletedOrder(orderId) {
    const order = await WholesaleOrder.findById(orderId);
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (order.status !== "CONFIRMED_RELEASED") throw httpError(409, "Only completed orders are added to the vendor's store.");
    if (order.stockedAt) throw httpError(409, "These goods are already in the vendor's store.");
    return stock.stockVendorStore(order);
  }

  /** Give the vendor's payment back the way they paid. */
  async refundPayment(order, payment, why) {
    const disbursement = require("./disbursement.service");
    const pay = payment || await Payment.findOne({ purpose: "WHOLESALE", status: "SUCCESS", transactionReference: { $regex: `^WHS-${order._id}-` } });
    if (!pay) {
      notifications().adminAlert({ title: `Refund ${order.orderNumber} by hand`, message: `${why} No online payment was found (it may have been paid outside MVEC). Refund ${rwf(order.totalAmount)} to the vendor.`, link: "/admin/suppliers?tab=wholesale" }).catch(() => {});
      return null;
    }
    const transfer = await disbursement.refundPayment({
      order: { _id: order._id, user: order.vendor, orderNumber: order.orderNumber, recipient: { phone: pay.phoneNumber } },
      payment: pay, amount: Number(pay.amount), idempotencyKey: `WHS-REFUND-${order._id}`,
    });
    await Payment.updateOne({ _id: pay._id }, { $set: { status: "REFUNDED" } });
    return transfer;
  }

  /**
   * Cancel before shipping. actor: { role: "vendor" | "supplier" | "admin" | "system", userId }.
   * Paid orders are refunded; reserved stock goes back to the supplier.
   */
  async cancelOrder(orderId, actor, reason = "") {
    const order = await WholesaleOrder.findById(orderId);
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (actor.role === "vendor" && String(order.vendor) !== String(actor.userId)) throw httpError(404, "Wholesale order not found.");
    if (actor.role === "supplier" && String(order.supplier) !== String(actor.userId)) throw httpError(404, "Wholesale order not found.");
    const cancellable = actor.role === "admin" ? ["PENDING_PAYMENT", "ESCROW_HELD", "DISPUTED", "SHIPPED"] : ["PENDING_PAYMENT", "ESCROW_HELD"];
    if (!cancellable.includes(order.status)) throw httpError(409, order.status === "SHIPPED" ? "The goods were already shipped. Report a problem instead." : "This order can no longer be cancelled.");
    const text = String(reason || "").trim().slice(0, 300);
    if (actor.role === "supplier" && text.length < 5) throw httpError(400, "Tell the vendor why you are cancelling.");

    const wasPaid = ["ESCROW_HELD", "DISPUTED", "SHIPPED"].includes(order.status);
    if (wasPaid) {
      const financial = require("./financial.service");
      await inTransaction((session) => financial.refundHeldEscrowForOrder({ orderId: order._id, session }));
    }
    await this.releaseStock(order);
    order.status = "CANCELLED";
    order.cancelledBy = actor.role.toUpperCase();
    order.cancelReason = text;
    await order.save();
    if (wasPaid) await this.refundPayment(order, null, `Cancelled by ${actor.role}.`);

    const who = { vendor: "The vendor", supplier: "The supplier", admin: "MVEC", system: "MVEC (automatically)" }[actor.role];
    const msg = `${who} cancelled ${order.orderNumber}${text ? `: ${text}` : "."}${wasPaid ? ` ${rwf(order.totalAmount)} is being refunded to the vendor.` : ""}`;
    if (actor.role !== "vendor") notify(order.vendor, { type: "ORDER", title: `${order.orderNumber} was cancelled`, message: msg, link: "/vendor/purchases" });
    if (actor.role !== "supplier") notify(order.supplier, { type: "ORDER", title: `${order.orderNumber} was cancelled`, message: msg, link: "/supplier/orders" });
    return order;
  }

  /** The vendor reports a problem with a paid order; the money stays held. */
  async openDispute(orderId, vendorUserId, reason) {
    const order = await WholesaleOrder.findOne({ _id: orderId, vendor: vendorUserId });
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (!["ESCROW_HELD", "SHIPPED", "DELIVERED"].includes(order.status)) throw httpError(409, "Only paid orders that have not been completed can be disputed.");
    const text = String(reason || "").trim();
    if (text.length < 10) throw httpError(400, "Describe the problem (at least 10 characters).");
    order.status = "DISPUTED";
    order.disputeReason = text.slice(0, 2000);
    await order.save();
    notify(order.supplier, { type: "ORDER", title: `Problem reported on ${order.orderNumber}`, message: `${text.slice(0, 160)} MVEC will review it; the payment stays on hold.`, link: "/supplier/orders" });
    notifications().adminAlert({ title: `Wholesale dispute: ${order.orderNumber}`, message: text.slice(0, 200), link: "/admin/suppliers?tab=wholesale" }).catch(() => {});
    return order;
  }

  /** Admin decision on a disputed order: pay the supplier, or refund the vendor. */
  async resolveDispute(orderId, decision, note = "") {
    const order = await WholesaleOrder.findById(orderId);
    if (!order) throw httpError(404, "Wholesale order not found.");
    if (order.status !== "DISPUTED") throw httpError(409, "This order is not disputed.");
    if (decision === "RELEASE") {
      await this.releaseToSupplier(order, `MVEC decided the dispute for the supplier${note ? `: ${note}` : ""}`);
      notify(order.vendor, { type: "ORDER", title: `Dispute on ${order.orderNumber} decided`, message: `MVEC released the payment to the supplier.${note ? ` ${note}` : ""}`, link: "/vendor/purchases" });
      return order;
    }
    if (decision === "REFUND") return this.cancelOrder(orderId, { role: "admin" }, note || "Dispute decided for the vendor.");
    throw httpError(400, "Choose to pay the supplier or refund the vendor.");
  }

  /**
   * Run by the background worker:
   *  - unpaid orders older than 48h expire (stock goes back)
   *  - paid orders not shipped within 7 days are cancelled and refunded
   *  - shipped orders not confirmed or disputed within 7 days pay the supplier
   */
  async runAutomations(now = new Date()) {
    const done = { expired: 0, cancelled: 0, released: 0 };
    const unpaid = await WholesaleOrder.find({ status: "PENDING_PAYMENT", createdAt: { $lte: new Date(now - UNPAID_EXPIRY_HOURS * HOURS) } }).limit(100);
    for (const o of unpaid) { try { await this.cancelOrder(o._id, { role: "system" }, `Not paid within ${UNPAID_EXPIRY_HOURS} hours.`); done.expired += 1; } catch (e) { console.error("Wholesale expiry failed:", e.message); } }
    const unshipped = await WholesaleOrder.find({ status: "ESCROW_HELD", paidAt: { $lte: new Date(now - SHIP_WITHIN_DAYS * 24 * HOURS) } }).limit(100);
    for (const o of unshipped) { try { await this.cancelOrder(o._id, { role: "admin" }, `Not shipped within ${SHIP_WITHIN_DAYS} days.`); done.cancelled += 1; } catch (e) { console.error("Wholesale ship deadline failed:", e.message); } }
    const shipped = await WholesaleOrder.find({ status: "SHIPPED", shippedAt: { $lte: new Date(now - AUTO_RELEASE_DAYS * 24 * HOURS) } }).limit(100);
    for (const o of shipped) {
      try {
        await this.releaseToSupplier(o, `${AUTO_RELEASE_DAYS} days passed with no problem reported`);
        notify(o.vendor, { type: "ORDER", title: `${o.orderNumber} completed`, message: `No problem was reported within ${AUTO_RELEASE_DAYS} days, so the supplier was paid.`, link: "/vendor/purchases" });
        done.released += 1;
      } catch (e) { console.error("Wholesale auto-release failed:", e.message); }
    }
    return done;
  }
}

const service = new WholesaleService();
service.UNPAID_EXPIRY_HOURS = UNPAID_EXPIRY_HOURS;
service.SHIP_WITHIN_DAYS = SHIP_WITHIN_DAYS;
service.AUTO_RELEASE_DAYS = AUTO_RELEASE_DAYS;
module.exports = service;
