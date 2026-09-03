const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Order = require("../../src/models/Order");
const Product = require("../../src/models/Product");
const Payment = require("../../src/models/Payment");
const { cancelExpiredUnpaidOrders } = require("../../src/workers/slaWorker");

let mongoServer;

describe("30-Minute Unpaid Order Cancellation Worker", () => {
  let mockProduct, mockOrder, mockPayment;

  beforeAll(async () => {
    // 1. Initialize In-Memory MongoDB Server with Replica Set for Transactions support
    mongoServer = await MongoMemoryServer.create({
      instance: { dbName: "mvec_worker_test" },
      binary: { version: "6.0.5" },
    });
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Enable fake timers without blocking database event loops
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });

    // Clean DB collections before each test run
    await Order.deleteMany({});
    await Product.deleteMany({});
    await Payment.deleteMany({});

    // Seed test Product with 10 items in stock
    mockProduct = await Product.create({
      name: "Rwandan Coffee Beans 1kg",
      price: 15000,
      stockQuantity: 10,
    });

    // Seed test Order in UNPAID / PENDING_PAYMENT state
    mockOrder = await Order.create({
      customer: new mongoose.Types.ObjectId(),
      vendor: new mongoose.Types.ObjectId(),
      items: [
        {
          product: mockProduct._id,
          quantity: 2, // 2 items reserved
          price: 15000,
        },
      ],
      totalAmount: 30000,
      paymentStatus: "UNPAID",
      orderStatus: "PENDING_PAYMENT",
    });

    // Deduct stock to simulate checkout reservation (10 - 2 = 8 remaining)
    await Product.findByIdAndUpdate(mockProduct._id, { $inc: { stockQuantity: -2 } });

    // Seed corresponding Payment record in PENDING state
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

    // Verify Order remains UNPAID and PENDING_PAYMENT
    const updatedOrder = await Order.findById(mockOrder._id);
    expect(updatedOrder.orderStatus).toBe("PENDING_PAYMENT");
    expect(updatedOrder.paymentStatus).toBe("UNPAID");

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