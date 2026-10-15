require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const orm = require("../../src/database/orm");
const Order = require("../../src/models/Order");
const Product = require("../../src/models/Product");
const Payment = require("../../src/models/Payment");
const User = require("../../src/models/User");
const Category = require("../../src/models/Category");
const { cancelExpiredUnpaidOrders } = require("../../src/workers/slaWorker");


describe("30-Minute Unpaid Order Cancellation Worker", () => {
  let mockProduct, mockOrder, mockPayment;

  beforeAll(async () => {
    await db.setup();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Fake Date/timers so "30 minutes later" happens instantly.
    jest.useFakeTimers();
    await db.reset();

    const vendor = await User.create({ Fullname: "Coffee Co", password: "x", phone: "0788000101", role: "vendor", companyName: "Coffee Co" });
    const buyer = await User.create({ Fullname: "Buyer", password: "x", phone: "0788000102", role: "buyer" });
    const category = await Category.create({ name: "Food", slug: "food" });

    // 10 in stock, 2 reserved by the unpaid order below.
    mockProduct = await Product.create({
      name: "Rwandan Coffee Beans 1kg", price: 15000, stockQuantity: 8, status: "ACTIVE",
      vendor: vendor._id, category: category._id, description: "Coffee", media: { mainImage: "/c.jpg" },
    });
    mockOrder = await Order.create({
      user: buyer._id,
      orderNumber: `ORD-SLA-${Date.now()}`,
      items: [{ product: mockProduct._id, vendor: vendor._id, name: mockProduct.name, quantity: 2, price: 15000 }],
      shippingAddress: { street: "KG 1", city: "Gasabo", district: "Gasabo", province: "Kigali City", country: "Rwanda" },
      totalAmount: 30000,
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
    });
    mockPayment = await Payment.create({
      parentOrder: mockOrder._id,
      transactionReference: `ORD-${mockOrder._id}-TEST`,
      method: "MOMO",
      provider: "MTN",
      amount: 30000,
      status: "PENDING",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("1. Should IGNORE orders created less than 30 minutes ago", async () => {
    // Fast forward time by 20 minutes (20 * 60 * 1000 ms)
    jest.advanceTimersByTime(20 * 60 * 1000);

    // Run cancellation worker sweep
    await cancelExpiredUnpaidOrders();

    // Verify the order is still waiting for payment
    const updatedOrder = await Order.findById(mockOrder._id);
    expect(updatedOrder.orderStatus).toBe("PENDING");
    expect(updatedOrder.paymentStatus).toBe("PENDING");

    // Verify stock remains untouched (8 remaining)
    const product = await Product.findById(mockProduct._id);
    expect(product.stockQuantity).toBe(8);
  });

  test("2. Should AUTO-CANCEL order and RESTORE stock after 31 minutes", async () => {
    // Fast forward time past the 30-minute threshold (31 minutes)
    const thirtyOneMinutes = 31 * 60 * 1000;
    jest.advanceTimersByTime(thirtyOneMinutes);

    // Run cancellation worker sweep
    await cancelExpiredUnpaidOrders();

    // Verify Order state transitioned to CANCELLED with timeout reason
    const cancelledOrder = await Order.findById(mockOrder._id);
    expect(cancelledOrder.orderStatus).toBe("CANCELLED");
    expect(cancelledOrder.cancellationReason).toBe("PAYMENT_TIMEOUT_EXPIRED_30_MIN");

    // Verify associated Payment document marked CANCELLED
    const cancelledPayment = await Payment.findById(mockPayment._id);
    expect(cancelledPayment.status).toBe("CANCELLED");

    // Verify reserved stock was restored back to 10 (8 + 2)
    const restoredProduct = await Product.findById(mockProduct._id);
    expect(restoredProduct.stockQuantity).toBe(10);
  });

  test("3. Should NOT cancel an order if payment was completed right before 30 mins", async () => {
    // Advance time to 29 minutes
    jest.advanceTimersByTime(29 * 60 * 1000);

    // Simulate buyer completing payment at minute 29
    mockOrder.paymentStatus = "PAID";
    mockOrder.orderStatus = "PROCESSING";
    await mockOrder.save();

    // Advance time past the 30-minute mark (to 35 minutes)
    jest.advanceTimersByTime(6 * 60 * 1000);

    // Run cancellation worker sweep
    await cancelExpiredUnpaidOrders();

    // Verify Order remains PROCESSING and PAID
    const paidOrder = await Order.findById(mockOrder._id);
    expect(paidOrder.orderStatus).toBe("PROCESSING");
    expect(paidOrder.paymentStatus).toBe("PAID");

    // Stock should stay allocated (8)
    const product = await Product.findById(mockProduct._id);
    expect(product.stockQuantity).toBe(8);
  });
});