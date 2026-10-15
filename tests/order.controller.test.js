const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Order = require("../src/models/Order");
const Cart = require("../src/models/Cart");
const Product = require("../src/models/Product");
const payoutController = require("../src/controllers/payout.controller");
const orderController = require("../src/controllers/order.controller");
const shippingService = require("../src/services/shipping.service");

// Stand-in for the zone-based quote (the real one queries the database).
const stubQuote = (fee, deliverable = true) => async ({ lines, address }) => ({
  address: { province: address.state, district: address.city },
  method: "STANDARD",
  deliverable,
  shippingFee: deliverable ? fee : 0,
  groups: [{
    vendor: String(lines[0].product.vendor), store: null, storeName: "Test Store", zone: null,
    zoneName: "Test zone", method: "STANDARD", fee: deliverable ? fee : 0, eta: "1 day", deliverable,
    message: deliverable ? null : "Test Store doesn't deliver to Kigali yet.",
  }],
});

// Helper to construct mock Express req & res
function createMockReqRes(options = {}) {
  const req = {
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    headers: options.headers || {},
    user: options.user || {
      id: new mongoose.Types.ObjectId().toString(),
      role: "buyer",
    },
  };

  const res = {
    statusCode: 200,
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    },
  };

  return { req, res };
}

describe("Order Controller Unit Tests", () => {
  // ─── 1. createCheckoutOrder ────────────────────────────────────────────────
  describe("createCheckoutOrder()", () => {
    it("should successfully place order, deduct stock, mark out-of-stock, and clear cart", async () => {
      const buyerId = new mongoose.Types.ObjectId().toString();
      const vendorId = new mongoose.Types.ObjectId().toString();
      const productId = new mongoose.Types.ObjectId().toString();

      const mockProduct = {
        _id: productId,
        name: "Wireless Earbuds",
        vendor: vendorId,
        price: 30000,
        discountPrice: 25000,
        stockQuantity: 2,
        status: "ACTIVE",
        save: async function () {
          return this;
        },
      };

      const mockCart = {
        user: buyerId,
        items: [
          {
            product: { _id: productId, name: "Wireless Earbuds" },
            quantity: 2,
          },
        ],
        totalAmount: 50000,
        save: async function () {
          return this;
        },
      };

      const originalCartFindOne = Cart.findOne;
      Cart.findOne = () => ({
        populate: async () => mockCart,
      });

      const originalProductFindById = Product.findById;
      Product.findById = async (id) => {
        if (id.toString() === productId.toString()) return mockProduct;
        return null;
      };

      let createdOrderDoc = null;
      const originalOrderCreate = Order.create;
      Order.create = async (orderData) => {
        createdOrderDoc = { ...orderData, _id: new mongoose.Types.ObjectId() };
        return createdOrderDoc;
      };
      const originalQuote = shippingService.quoteShipping;
      shippingService.quoteShipping = stubQuote(0);

      try {
        const { req, res } = createMockReqRes({
          user: { id: buyerId, role: "buyer" },
          body: {
            shippingAddress: {
              street: "KN 5 Rd",
              city: "Kigali",
              state: "Kigali City",
              country: "Rwanda",
            },
            paymentMethod: "MOMO",
          },
        });

        await orderController.createCheckoutOrder(req, res);

        assert.equal(res.statusCode, 201);
        assert.equal(res.jsonData.message, "Order placed successfully");
        assert.ok(res.jsonData.order);
        assert.equal(res.jsonData.order.totalAmount, 50000);
        assert.equal(res.jsonData.order.items.length, 1);
        assert.equal(res.jsonData.order.items[0].price, 25000);

        // Verify stock deducted to 0 and status updated
        assert.equal(mockProduct.stockQuantity, 0);
        assert.equal(mockProduct.status, "OUT_OF_STOCK");

        // Verify cart cleared
        assert.equal(mockCart.items.length, 0);
        assert.equal(mockCart.totalAmount, 0);
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.findById = originalProductFindById;
        Order.create = originalOrderCreate;
        shippingService.quoteShipping = originalQuote;
      }
    });

    const checkoutWithQuote = async (quote) => {
      const productId = new mongoose.Types.ObjectId().toString();
      const product = {
        _id: productId, name: "Lamp", vendor: new mongoose.Types.ObjectId().toString(),
        price: 10000, discountPrice: null, stockQuantity: 5, status: "ACTIVE", save: async function () { return this; },
      };
      const cart = { items: [{ product: { _id: productId }, quantity: 2 }], save: async function () { return this; } };
      const originals = { cart: Cart.findOne, product: Product.findById, create: Order.create, quote: shippingService.quoteShipping };
      Cart.findOne = () => ({ populate: async () => cart });
      Product.findById = async () => product;
      Order.create = async (data) => ({ ...data, _id: new mongoose.Types.ObjectId() });
      shippingService.quoteShipping = quote;
      try {
        const { req, res } = createMockReqRes({
          body: { shippingAddress: { street: "KN 5 Rd", city: "Gasabo", state: "Kigali City", country: "Rwanda" }, paymentMethod: "MOMO" },
        });
        await orderController.createCheckoutOrder(req, res);
        return { res, product };
      } finally {
        Cart.findOne = originals.cart;
        Product.findById = originals.product;
        Order.create = originals.create;
        shippingService.quoteShipping = originals.quote;
      }
    };

    it("should add the zone delivery fee to the order total", async () => {
      const { res } = await checkoutWithQuote(stubQuote(3000));
      assert.equal(res.statusCode, 201);
      assert.equal(res.jsonData.order.subtotal, 20000);
      assert.equal(res.jsonData.order.shippingFee, 3000);
      assert.equal(res.jsonData.order.totalAmount, 23000);
      assert.equal(res.jsonData.order.shippingBreakdown[0].fee, 3000);
    });

    it("should reject checkout when a seller doesn't deliver to the address", async () => {
      const { res, product } = await checkoutWithQuote(stubQuote(0, false));
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /doesn't deliver/);
      assert.equal(product.stockQuantity, 5, "stock must not be deducted");
    });

    it("should reject checkout when shippingAddress is missing or incomplete", async () => {
      const { req, res } = createMockReqRes({
        body: { shippingAddress: { street: "KN 5 Rd" } }, // missing city
      });

      await orderController.createCheckoutOrder(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(
        res.jsonData.message,
        "Complete shipping address is required.",
      );
    });

    it("should reject checkout when cart is empty or null", async () => {
      const originalCartFindOne = Cart.findOne;
      Cart.findOne = () => ({
        populate: async () => ({ items: [] }),
      });

      try {
        const { req, res } = createMockReqRes({
          body: {
            shippingAddress: { street: "KG 10 St", city: "Kigali" },
          },
        });

        await orderController.createCheckoutOrder(req, res);

        assert.equal(res.statusCode, 400);
        assert.equal(res.jsonData.message, "Your cart is empty.");
      } finally {
        Cart.findOne = originalCartFindOne;
      }
    });

    it("should reject checkout when product is INACTIVE", async () => {
      const productId = new mongoose.Types.ObjectId().toString();
      const mockCart = {
        items: [
          { product: { _id: productId, name: "Smart Watch" }, quantity: 1 },
        ],
      };

      const originalCartFindOne = Cart.findOne;
      Cart.findOne = () => ({
        populate: async () => mockCart,
      });

      const originalProductFindById = Product.findById;
      Product.findById = async () => ({
        _id: productId,
        name: "Smart Watch",
        status: "INACTIVE",
        stockQuantity: 10,
      });

      try {
        const { req, res } = createMockReqRes({
          body: {
            shippingAddress: { street: "KG 10 St", city: "Kigali" },
          },
        });

        await orderController.createCheckoutOrder(req, res);

        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("no longer available"));
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.findById = originalProductFindById;
      }
    });

    it("should reject checkout when stock is insufficient", async () => {
      const productId = new mongoose.Types.ObjectId().toString();
      const mockCart = {
        items: [{ product: { _id: productId, name: "Laptop" }, quantity: 5 }],
      };

      const originalCartFindOne = Cart.findOne;
      Cart.findOne = () => ({
        populate: async () => mockCart,
      });

      const originalProductFindById = Product.findById;
      Product.findById = async () => ({
        _id: productId,
        name: "Laptop",
        status: "ACTIVE",
        stockQuantity: 2, // only 2 available, requested 5
      });

      try {
        const { req, res } = createMockReqRes({
          body: {
            shippingAddress: { street: "KG 10 St", city: "Kigali" },
          },
        });

        await orderController.createCheckoutOrder(req, res);

        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("Insufficient stock"));
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.findById = originalProductFindById;
      }
    });
  });

  // ─── 2. getMyOrders ────────────────────────────────────────────────────────
  describe("getMyOrders()", () => {
    it("should return orders for logged-in buyer sorted by createdAt descending", async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const mockOrders = [
        {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-1",
          totalAmount: 10000,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-2",
          totalAmount: 20000,
        },
      ];

      const originalOrderFind = Order.find;
      Order.find = (query) => {
        assert.equal(query.user, userId);
        return {
          sort: async () => mockOrders,
        };
      };

      try {
        const { req, res } = createMockReqRes({
          user: { id: userId, role: "buyer" },
        });

        await orderController.getMyOrders(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.orders.length, 2);
        assert.equal(res.jsonData.orders[0].orderNumber, "ORD-1");
      } finally {
        Order.find = originalOrderFind;
      }
    });

    it("should return 500 if database query fails", async () => {
      const originalOrderFind = Order.find;
      Order.find = () => ({
        sort: async () => {
          throw new Error("DB Connection Error");
        },
      });

      try {
        const { req, res } = createMockReqRes();
        await orderController.getMyOrders(req, res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.jsonData.message, "DB Connection Error");
      } finally {
        Order.find = originalOrderFind;
      }
    });
  });

  // ─── 3. getOrderById ───────────────────────────────────────────────────────
  describe("getOrderById()", () => {
    it("should allow buyer who owns the order to view it", async () => {
      const buyerId = new mongoose.Types.ObjectId();
      const orderId = new mongoose.Types.ObjectId().toString();

      const mockOrder = {
        _id: orderId,
        user: { _id: buyerId, Fullname: "John Doe", email: "john@example.com" },
        items: [{ vendor: { _id: new mongoose.Types.ObjectId() } }],
      };

      const originalFindById = Order.findById;
      Order.findById = () => ({
        populate: () => ({
          populate: async () => mockOrder,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: { id: buyerId.toString(), role: "buyer" },
          params: { id: orderId },
        });

        await orderController.getOrderById(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.order._id, orderId);
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should allow vendor who owns items in the order to view it", async () => {
      const buyerId = new mongoose.Types.ObjectId();
      const vendorId = new mongoose.Types.ObjectId();
      const orderId = new mongoose.Types.ObjectId().toString();

      const mockOrder = {
        _id: orderId,
        user: { _id: buyerId },
        items: [{ vendor: { _id: vendorId, companyName: "TechStore" } }],
      };

      const originalFindById = Order.findById;
      Order.findById = () => ({
        populate: () => ({
          populate: async () => mockOrder,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: { id: vendorId.toString(), role: "vendor" },
          params: { id: orderId },
        });

        await orderController.getOrderById(req, res);

        assert.equal(res.statusCode, 200);
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should allow super_admin to view any order", async () => {
      const orderId = new mongoose.Types.ObjectId().toString();
      const mockOrder = {
        _id: orderId,
        user: { _id: new mongoose.Types.ObjectId() },
        items: [{ vendor: { _id: new mongoose.Types.ObjectId() } }],
      };

      const originalFindById = Order.findById;
      Order.findById = () => ({
        populate: () => ({
          populate: async () => mockOrder,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: {
            id: new mongoose.Types.ObjectId().toString(),
            role: "super_admin",
          },
          params: { id: orderId },
        });

        await orderController.getOrderById(req, res);

        assert.equal(res.statusCode, 200);
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should reject unauthorized user with 403 Access Denied", async () => {
      const buyerId = new mongoose.Types.ObjectId();
      const vendorId = new mongoose.Types.ObjectId();
      const unrelatedUserId = new mongoose.Types.ObjectId();

      const mockOrder = {
        _id: new mongoose.Types.ObjectId().toString(),
        user: { _id: buyerId },
        items: [{ vendor: { _id: vendorId } }],
      };

      const originalFindById = Order.findById;
      Order.findById = () => ({
        populate: () => ({
          populate: async () => mockOrder,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: { id: unrelatedUserId.toString(), role: "buyer" },
          params: { id: mockOrder._id },
        });

        await orderController.getOrderById(req, res);

        assert.equal(res.statusCode, 403);
        assert.equal(res.jsonData.message, "Access denied.");
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should return 404 when order is not found", async () => {
      const originalFindById = Order.findById;
      Order.findById = () => ({
        populate: () => ({
          populate: async () => null,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          params: { id: new mongoose.Types.ObjectId().toString() },
        });

        await orderController.getOrderById(req, res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.jsonData.message, "Order not found");
      } finally {
        Order.findById = originalFindById;
      }
    });
  });

  // ─── 4. getVendorOrders ────────────────────────────────────────────────────
  describe("getVendorOrders()", () => {
    it("should return vendor orders filtered to vendor items and calculate vendorSubtotal", async () => {
      const vendorId = new mongoose.Types.ObjectId();
      const otherVendorId = new mongoose.Types.ObjectId();

      const mockOrders = [
        {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-V1",
          user: { Fullname: "Alice" },
          shippingAddress: { city: "Kigali" },
          paymentStatus: "PAID",
          orderStatus: "PROCESSING",
          createdAt: new Date(),
          items: [
            { vendor: vendorId, price: 10000, quantity: 2 },
            { vendor: otherVendorId, price: 50000, quantity: 1 }, // Other vendor's item
          ],
        },
      ];

      const originalFind = Order.find;
      Order.find = () => ({
        populate: () => ({
          sort: async () => mockOrders,
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: { id: vendorId.toString(), role: "vendor" },
        });

        await orderController.getVendorOrders(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.orders.length, 1);
        // Only 1 item belongs to this vendor
        assert.equal(res.jsonData.orders[0].items.length, 1);
        // Subtotal: 10000 * 2 = 20000
        assert.equal(res.jsonData.orders[0].vendorSubtotal, 20000);
      } finally {
        Order.find = originalFind;
      }
    });
  });

  // ─── 5. updateVendorOrderStatus ────────────────────────────────────────────
  describe("updateVendorOrderStatus()", () => {
    it("should let the seller deliver a manual order they collected payment for, and release earnings", async () => {
      const vendorId = new mongoose.Types.ObjectId();
      const orderId = new mongoose.Types.ObjectId().toString();

      let payoutReleased = false;
      const originalRelease = payoutController.releaseOrderEarnings;
      payoutController.releaseOrderEarnings = async (oId, vId) => {
        if (
          oId.toString() === orderId &&
          vId.toString() === vendorId.toString()
        ) {
          payoutReleased = true;
        }
      };

      const mockOrder = {
        _id: orderId,
        orderStatus: "SHIPPED",
        paymentStatus: "PAID",
        source: "MANUAL",
        paidOffline: true,
        items: [{ vendor: vendorId }],
        save: async function () {
          return this;
        },
      };

      const originalFindById = Order.findById;
      Order.findById = async () => mockOrder;

      try {
        const { req, res } = createMockReqRes({
          user: { id: vendorId.toString(), role: "vendor" },
          body: {
            orderId,
            status: "DELIVERED",
          },
        });

        await orderController.updateVendorOrderStatus(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(mockOrder.orderStatus, "DELIVERED");
        assert.equal(
          payoutReleased,
          true,
          "releaseOrderEarnings must be triggered for DELIVERED",
        );
      } finally {
        payoutController.releaseOrderEarnings = originalRelease;
        Order.findById = originalFindById;
      }
    });

    const sellerUpdate = async (order, body) => {
      const vendorId = order.items[0].vendor;
      const originalFindById = Order.findById;
      Order.findById = async () => order;
      try {
        const { req, res } = createMockReqRes({ user: { id: vendorId.toString(), role: "vendor" }, body: { orderId: order._id, ...body } });
        await orderController.updateVendorOrderStatus(req, res);
        return res;
      } finally {
        Order.findById = originalFindById;
      }
    };
    const onlineOrder = (status) => ({
      _id: new mongoose.Types.ObjectId().toString(), orderStatus: status, paymentStatus: "PAID", source: "ONLINE",
      items: [{ vendor: new mongoose.Types.ObjectId() }], save: async function () { return this; },
    });

    it("should block a seller from marking an MVEC-paid order DELIVERED (needs the buyer's OTP)", async () => {
      const order = onlineOrder("SHIPPED");
      const res = await sellerUpdate(order, { status: "DELIVERED" });
      assert.equal(res.statusCode, 400);
      assert.equal(order.orderStatus, "SHIPPED");
    });

    it("should block a seller from changing payment status on an online order", async () => {
      const order = { ...onlineOrder("PROCESSING"), paymentStatus: "PENDING" };
      const res = await sellerUpdate(order, { paymentStatus: "PAID" });
      assert.equal(res.statusCode, 403);
      assert.equal(order.paymentStatus, "PENDING");
    });

    it("should block skipping steps (PENDING -> SHIPPED)", async () => {
      const order = onlineOrder("PENDING");
      const res = await sellerUpdate(order, { status: "SHIPPED" });
      assert.equal(res.statusCode, 400);
    });

    it("should reject invalid order status with 400", async () => {
      const { req, res } = createMockReqRes({
        body: {
          orderId: new mongoose.Types.ObjectId().toString(),
          status: "INVALID_STATUS",
        },
      });

      const originalFindById = Order.findById;
      Order.findById = async () => ({
        items: [{ vendor: req.user.id }],
      });

      try {
        await orderController.updateVendorOrderStatus(req, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("Invalid order status"));
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should reject vendor who does not own items in the order with 403", async () => {
      const orderId = new mongoose.Types.ObjectId().toString();
      const otherVendorId = new mongoose.Types.ObjectId();

      const mockOrder = {
        _id: orderId,
        items: [{ vendor: otherVendorId }],
      };

      const originalFindById = Order.findById;
      Order.findById = async () => mockOrder;

      try {
        const { req, res } = createMockReqRes({
          user: {
            id: new mongoose.Types.ObjectId().toString(),
            role: "vendor",
          },
          body: { orderId, status: "SHIPPED" },
        });

        await orderController.updateVendorOrderStatus(req, res);

        assert.equal(res.statusCode, 403);
        assert.ok(res.jsonData.message.includes("Access denied"));
      } finally {
        Order.findById = originalFindById;
      }
    });
  });

  // ─── 6. updateOrderStatus ──────────────────────────────────────────────────
  describe("updateOrderStatus()", () => {
    it("should successfully update order status from PROCESSING to SHIPPED", async () => {
      const orderId = new mongoose.Types.ObjectId().toString();
      const mockOrder = {
        _id: orderId,
        orderStatus: "PROCESSING",
        items: [{ vendor: new mongoose.Types.ObjectId() }],
        save: async function () {
          return this;
        },
      };

      const originalFindById = Order.findById;
      Order.findById = async () => mockOrder;

      try {
        const { req, res } = createMockReqRes({
          params: { id: orderId },
          body: { status: "SHIPPED" },
        });

        await orderController.updateOrderStatus(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(mockOrder.orderStatus, "SHIPPED");
        assert.ok(
          res.jsonData.message.includes("successfully updated to SHIPPED"),
        );
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should update order status to DELIVERED, set deliveredAt, and release earnings for all unique vendors", async () => {
      const orderId = new mongoose.Types.ObjectId().toString();
      const vendor1 = new mongoose.Types.ObjectId();
      const vendor2 = new mongoose.Types.ObjectId();

      const releasedVendors = [];
      const originalRelease = payoutController.releaseOrderEarnings;
      payoutController.releaseOrderEarnings = async (oId, vId) => {
        releasedVendors.push(vId.toString());
      };

      const mockOrder = {
        _id: orderId,
        orderStatus: "SHIPPED",
        items: [
          { vendor: vendor1 },
          { vendor: vendor1 }, // Duplicate vendor item
          { vendor: vendor2 },
        ],
        save: async function () {
          return this;
        },
      };

      const originalFindById = Order.findById;
      Order.findById = async () => mockOrder;

      try {
        const { req, res } = createMockReqRes({
          params: { id: orderId },
          body: { status: "DELIVERED" },
        });

        await orderController.updateOrderStatus(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(mockOrder.orderStatus, "DELIVERED");
        assert.equal(mockOrder.isDelivered, true);
        assert.ok(mockOrder.deliveredAt instanceof Date);

        // Verify earnings released for both unique vendors
        assert.equal(releasedVendors.length, 2);
        assert.ok(releasedVendors.includes(vendor1.toString()));
        assert.ok(releasedVendors.includes(vendor2.toString()));
      } finally {
        payoutController.releaseOrderEarnings = originalRelease;
        Order.findById = originalFindById;
      }
    });

    it("should reject updating an order that is already DELIVERED with 400", async () => {
      const mockOrder = {
        orderStatus: "DELIVERED",
      };

      const originalFindById = Order.findById;
      Order.findById = async () => mockOrder;

      try {
        const { req, res } = createMockReqRes({
          params: { id: new mongoose.Types.ObjectId().toString() },
          body: { status: "CANCELLED" },
        });

        await orderController.updateOrderStatus(req, res);

        assert.equal(res.statusCode, 400);
        assert.equal(
          res.jsonData.message,
          "Order has already been marked as DELIVERED.",
        );
      } finally {
        Order.findById = originalFindById;
      }
    });

    it("should reject invalid order status with 400", async () => {
      const { req, res } = createMockReqRes({
        params: { id: new mongoose.Types.ObjectId().toString() },
        body: { status: "UNKNOWN_STATUS" },
      });

      await orderController.updateOrderStatus(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.message, "Invalid order status provided.");
    });
  });

  // ─── 7. directCheckout ─────────────────────────────────────────────────────
  describe("directCheckout()", () => {
    it("should create order with dynamic items, preserved image and PENDING status", async () => {
      const buyerId = new mongoose.Types.ObjectId().toString();
      let createdData = null;
      const originalCreate = Order.create;
      Order.create = async (data) => {
        createdData = { ...data, _id: new mongoose.Types.ObjectId() };
        return createdData;
      };

      try {
        const { req, res } = createMockReqRes({
          user: { id: buyerId, role: "buyer" },
          body: {
            items: [
              {
                name: "Custom Product",
                price: 15000,
                qty: 2,
                image: "https://example.com/item.png",
              },
            ],
            shippingAddress: {
              street: "KG 1 Ave",
              city: "Kigali",
              state: "Kigali City",
              country: "Rwanda",
            },
          },
        });

        await orderController.directCheckout(req, res);

        assert.equal(res.statusCode, 201);
        assert.equal(res.jsonData.message, "Order placed successfully");
        assert.ok(createdData);
        assert.equal(createdData.orderStatus, "PENDING");
        assert.equal(createdData.paymentStatus, "PENDING");
        assert.equal(createdData.items[0].name, "Custom Product");
        assert.equal(createdData.items[0].image, "https://example.com/item.png");
        assert.equal(createdData.totalAmount, 30000);
      } finally {
        Order.create = originalCreate;
      }
    });
  });

  // ─── 8. getAllOrders ───────────────────────────────────────────────────────
  describe("getAllOrders()", () => {
    it("should return all orders across marketplace sorted by createdAt desc", async () => {
      const mockOrders = [
        { _id: new mongoose.Types.ObjectId(), orderNumber: "ORD-ALL-1" },
        { _id: new mongoose.Types.ObjectId(), orderNumber: "ORD-ALL-2" },
      ];

      const originalFind = Order.find;
      Order.find = () => ({
        populate: () => ({
          populate: () => ({
            sort: async () => mockOrders,
          }),
        }),
      });

      try {
        const { req, res } = createMockReqRes({
          user: { id: new mongoose.Types.ObjectId().toString(), role: "super_admin" },
        });

        await orderController.getAllOrders(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.orders.length, 2);
      } finally {
        Order.find = originalFind;
      }
    });
  });
});
