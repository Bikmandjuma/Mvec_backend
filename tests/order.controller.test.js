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
  // The full checkout path (stock reservation, totals, cart clearing) runs
  // against a real in-memory database in tests/buyer.flow.test.js. These unit
  // tests cover the validation that happens before any stock is touched.
  describe("createCheckoutOrder()", () => {
    const validBody = {
      shippingAddress: { street: "KN 5 Rd", district: "Nyarugenge", province: "Kigali City" },
      recipient: { name: "Aline Uwase", phone: "0788123456" },
      deliveryMethod: "standard",
    };

    it("should reject checkout when the cart is empty or missing", async () => {
      const originalCartFindOne = Cart.findOne;
      for (const cart of [null, { items: [] }]) {
        Cart.findOne = async () => cart;
        try {
          const { req, res } = createMockReqRes({ body: validBody });
          await orderController.createCheckoutOrder(req, res);
          assert.equal(res.statusCode, 400);
          assert.equal(res.jsonData.message, "Your cart is empty.");
        } finally {
          Cart.findOne = originalCartFindOne;
        }
      }
    });

    it("should reject an incomplete address or an invalid recipient phone before touching stock", async () => {
      const productId = new mongoose.Types.ObjectId().toString();
      const originalCartFindOne = Cart.findOne;
      const originalFind = Product.find;
      let productLookups = 0;
      Cart.findOne = async () => ({ items: [{ product: productId, quantity: 1 }] });
      Product.find = async () => { productLookups += 1; return []; };
      try {
        const cases = [
          { ...validBody, shippingAddress: { street: "KN 5 Rd" } },
          { ...validBody, recipient: { name: "Aline", phone: "12345" } },
          { ...validBody, shippingAddress: { ...validBody.shippingAddress, district: "Atlantis", province: "Atlantis" } },
        ];
        for (const body of cases) {
          const { req, res } = createMockReqRes({ body });
          await orderController.createCheckoutOrder(req, res);
          assert.equal(res.statusCode, 400);
        }
        assert.equal(productLookups, 0);
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.find = originalFind;
      }
    });

    it("should reject checkout when a product is no longer ACTIVE", async () => {
      const productId = new mongoose.Types.ObjectId().toString();
      const originalCartFindOne = Cart.findOne;
      const originalFind = Product.find;
      Cart.findOne = async () => ({ items: [{ product: productId, quantity: 1 }] });
      Product.find = async () => [{ _id: productId, name: "Smart Watch", status: "INACTIVE", stockQuantity: 10, price: 1000 }];
      try {
        const { req, res } = createMockReqRes({ body: validBody });
        await orderController.createCheckoutOrder(req, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("no longer available"));
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.find = originalFind;
      }
    });

    it("should reject checkout when stock is insufficient", async () => {
      const productId = new mongoose.Types.ObjectId().toString();
      const originalCartFindOne = Cart.findOne;
      const originalFind = Product.find;
      Cart.findOne = async () => ({ items: [{ product: productId, quantity: 5 }] });
      Product.find = async () => [{ _id: productId, name: "Laptop", status: "ACTIVE", stockQuantity: 2, price: 1000 }];
      try {
        const { req, res } = createMockReqRes({ body: validBody });
        await orderController.createCheckoutOrder(req, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("Only 2"));
      } finally {
        Cart.findOne = originalCartFindOne;
        Product.find = originalFind;
      }
    });
  });

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
        deliveryOtp: "123456",
        items: [
          { vendor: { _id: vendorId, companyName: "TechStore" } },
          { vendor: { _id: new mongoose.Types.ObjectId(), companyName: "Other" } },
        ],
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
        // Vendors see only their own lines and never the buyer's delivery code.
        assert.equal(res.jsonData.order.deliveryOtp, undefined);
        assert.equal(res.jsonData.order.items.length, 1);
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
  // Sellers can only move a PAID order forward through fulfilment. Payment
  // status comes from the payment provider and DELIVERED only from delivery
  // confirmation with the buyer's code (see tests/automation.test.js).
  const statusOrder = (overrides = {}) => {
    const vendorId = new mongoose.Types.ObjectId();
    return {
      vendorId,
      order: {
        _id: new mongoose.Types.ObjectId(),
        orderNumber: "ORD-1",
        user: new mongoose.Types.ObjectId(),
        paymentStatus: "PAID",
        orderStatus: "CONFIRMED",
        items: [{ vendor: vendorId, price: 1000, quantity: 1 }],
        saved: 0,
        async save() { this.saved += 1; return this; },
        ...overrides,
      },
    };
  };

  describe("updateVendorOrderStatus()", () => {
    it("moves a paid order forward and records when it shipped", async () => {
      const { vendorId, order } = statusOrder();
      const original = Order.findById;
      Order.findById = async () => order;
      try {
        const { req, res } = createMockReqRes({ user: { id: vendorId.toString(), role: "vendor" }, body: { orderId: order._id.toString(), status: "SHIPPED" } });
        await orderController.updateVendorOrderStatus(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(order.orderStatus, "SHIPPED");
        assert.ok(order.shippedAt instanceof Date);
      } finally {
        Order.findById = original;
      }
    });

    it("refuses payment status changes, DELIVERED, going backwards and unpaid orders", async () => {
      const original = Order.findById;
      try {
        const cases = [
          [{}, { paymentStatus: "PAID" }],
          [{}, { status: "DELIVERED" }],
          [{ orderStatus: "SHIPPED" }, { status: "PROCESSING" }],
          [{ paymentStatus: "PENDING", orderStatus: "PENDING" }, { status: "PROCESSING" }],
        ];
        for (const [overrides, body] of cases) {
          const { vendorId, order } = statusOrder(overrides);
          Order.findById = async () => order;
          const { req, res } = createMockReqRes({ user: { id: vendorId.toString(), role: "vendor" }, body: { orderId: order._id.toString(), ...body } });
          await orderController.updateVendorOrderStatus(req, res);
          assert.equal(res.statusCode, 400, JSON.stringify(body));
          assert.equal(order.saved, 0);
        }
      } finally {
        Order.findById = original;
      }
    });

    it("rejects a vendor who does not own items in the order with 403", async () => {
      const { order } = statusOrder();
      const original = Order.findById;
      Order.findById = async () => order;
      try {
        const { req, res } = createMockReqRes({ user: { id: new mongoose.Types.ObjectId().toString(), role: "vendor" }, body: { orderId: order._id.toString(), status: "SHIPPED" } });
        await orderController.updateVendorOrderStatus(req, res);
        assert.equal(res.statusCode, 403);
      } finally {
        Order.findById = original;
      }
    });
  });

  describe("updateOrderStatus()", () => {
    it("lets an admin move an order forward but never to DELIVERED or COMPLETED", async () => {
      const original = Order.findById;
      try {
        let { order } = statusOrder({ orderStatus: "PROCESSING" });
        Order.findById = async () => order;
        let r = createMockReqRes({ user: { id: "admin", role: "super_admin" }, params: { id: order._id.toString() }, body: { status: "shipped" } });
        await orderController.updateOrderStatus(r.req, r.res);
        assert.equal(r.res.statusCode, 200);
        assert.equal(order.orderStatus, "SHIPPED");

        for (const status of ["DELIVERED", "COMPLETED", "NOT_A_STATUS"]) {
          ({ order } = statusOrder({ orderStatus: "SHIPPED" }));
          r = createMockReqRes({ user: { id: "admin", role: "super_admin" }, params: { id: order._id.toString() }, body: { status } });
          await orderController.updateOrderStatus(r.req, r.res);
          assert.equal(r.res.statusCode, 400, status);
        }
      } finally {
        Order.findById = original;
      }
    });
  });

  // ─── 7. directCheckout ─────────────────────────────────────────────────────
  describe("directCheckout()", () => {
    it("should refuse client-supplied items that do not reference a real product", async () => {
      // Prices and names must always come from the database, never the client.
      let created = false;
      const originalCreate = Order.create;
      Order.create = async () => { created = true; };
      try {
        const { req, res } = createMockReqRes({
          body: {
            items: [{ name: "Custom Product", price: 1, qty: 2 }],
            shippingAddress: { street: "KG 1 Ave", district: "Gasabo", province: "Kigali City" },
            recipient: { name: "Aline Uwase", phone: "0788123456" },
          },
        });
        await orderController.directCheckout(req, res);
        assert.equal(res.statusCode, 400);
        assert.equal(created, false);
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
