const mongoose = require("mongoose");
const WholesaleOrder = require("../models/WholesaleOrder");
const VendorWallet = require("../models/VendorWallet");
const Supplier = require("../models/Supplier");

class WholesaleService {
  /**
   * Validate MOQ and create B2B Wholesale Order
   */
  async createWholesaleOrder({ vendorId, supplierId, items }) {
    if (!mongoose.isValidObjectId(supplierId)) {
      throw new Error("Invalid supplier ID provided.");
    }

    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      throw new Error("Supplier profile not found.");
    }
    const supplierUserId = supplier.user;

    if (!mongoose.isValidObjectId(vendorId)) {
      throw new Error("Invalid vendor ID provided.");
    }

    let totalAmount = 0;
    const validatedItems = [];

    for (const item of items) {
      if (!item.productId || !mongoose.isValidObjectId(item.productId)) {
        throw new Error(
          `Invalid product ID for item '${item.productName}'. Only real catalog products can be ordered.`
        );
      }
      if (item.quantity < item.moq) {
        throw new Error(
          `MOQ Breach: Item '${item.productName}' requires a minimum quantity of ${item.moq}, but got ${item.quantity}.`
        );
      }
      totalAmount += item.unitPrice * item.quantity;
      validatedItems.push({
        product: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        moq: item.moq,
      });
    }

    const orderNumber = `WSO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const deliveryOtp = Math.floor(100000 + Math.random() * 900000).toString();

    const order = await WholesaleOrder.create({
      orderNumber,
      vendor: vendorId,
      supplier: supplierUserId,
      items: validatedItems,
      totalAmount,
      status: "PENDING_PAYMENT",
      deliveryOtp,
    });

    return order;
  }

  /**
   * Hold Vendor Funds in Escrow upon successful B2B Payment
   */
  async holdWholesaleEscrow(orderId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await WholesaleOrder.findById(orderId).session(session);
      if (!order) throw new Error("Wholesale order not found.");
      if (order.status !== "PENDING_PAYMENT") {
        throw new Error(`Invalid order status transition from ${order.status}`);
      }

      order.status = "ESCROW_HELD";
      await order.save({ session });

      await session.commitTransaction();
      session.endSession();
      return order;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Confirm Physical Receipt and Release Escrow Funds to Supplier
   */
  async confirmReceiptAndRelease(orderId, providedOtp = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await WholesaleOrder.findById(orderId).select("+deliveryOtp").session(session);
      if (!order) throw new Error("Wholesale order not found.");

      if (order.status !== "ESCROW_HELD" && order.status !== "SHIPPED" && order.status !== "DELIVERED") {
        throw new Error(`Cannot release escrow for order in status: ${order.status}`);
      }

      // If OTP is provided, verify it
      if (providedOtp && order.deliveryOtp !== providedOtp) {
        throw new Error("Invalid delivery confirmation OTP.");
      }

      // Update Supplier Wallet (Move to Available Balance)
      let supplierWallet = await VendorWallet.findOne({ vendor: order.supplier }).session(session);
      if (!supplierWallet) {
        supplierWallet = new VendorWallet({
          vendor: order.supplier,
          availableBalance: 0,
          pendingBalance: 0,
          totalEarned: 0,
        });
      }

      supplierWallet.availableBalance += order.totalAmount;
      supplierWallet.totalEarned += order.totalAmount;
      await supplierWallet.save({ session });

      // Update Order Status
      order.status = "CONFIRMED_RELEASED";
      order.confirmedAt = new Date();
      await order.save({ session });

      await session.commitTransaction();
      session.endSession();

      return { order, newSupplierBalance: supplierWallet.availableBalance };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}

module.exports = new WholesaleService();