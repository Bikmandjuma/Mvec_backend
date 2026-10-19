require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const User = require("../../src/models/User");
const Order = require("../../src/models/Order");
const Product = require("../../src/models/Product");
const Category = require("../../src/models/Category");
const Settlement = require("../../src/models/Settlement");
const LedgerAccount = require("../../src/models/LedgerAccount");
const VendorWallet = require("../../src/models/VendorWallet");
const AdminWallet = require("../../src/models/AdminWallet");
const Advertisement = require("../../src/models/Advertisement");
const SellerCharge = require("../../src/models/SellerCharge");
const Vendor = require("../../src/models/Vendor");
const Dispute = require("../../src/models/Dispute");
const financial = require("../../src/services/financial.service");
const settings = require("../../src/services/platformSettings.service");
const plans = require("../../src/services/plans.service");
const advertising = require("../../src/services/advertising.service");
const sellerFinance = require("../../src/services/sellerFinance.service");
const orm = require("../../src/database/orm");

jest.setTimeout(60000);

const DAY = 24 * 60 * 60 * 1000;
const sum = (accounts, type) => accounts.filter((a) => a.accountType === type).reduce((n, a) => n + Number(a.balance), 0);
const books = async () => {
  const accounts = await LedgerAccount.find({});
  return { accounts, total: Math.round(accounts.reduce((n, a) => n + Number(a.balance), 0) * 100) / 100, of: (t) => sum(accounts, t) };
};

describe("Money flows: ledger, automatic release, disputes, ads and plans", () => {
  let admin, seller, buyer, category, product;

  beforeAll(async () => { await db.setup(); });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await db.reset();
    admin = await User.create({ Fullname: "Admin", email: "admin@mvec.test", phone: "0788100001", password: "password123", role: "super_admin" });
    seller = await User.create({ Fullname: "Seller", email: "seller@mvec.test", phone: "0788100002", password: "password123", role: "vendor", companyName: "Shop" });
    buyer = await User.create({ Fullname: "Buyer", email: "buyer@mvec.test", phone: "0788100003", password: "password123", role: "buyer" });
    category = await Category.create({ name: "Phones", slug: "phones" });
    product = await Product.create({ vendor: seller._id, category: category._id, name: "Phone", slug: "phone", sku: "PH-1", description: "A phone", price: 10000, stockQuantity: 10, media: { mainImage: "/uploads/x.jpg" }, status: "ACTIVE" });
    await settings.update({ autoReleaseDays: 1, subscriptionsEnabled: false });
  });

  const paidOrder = async (overrides = {}) => {
    const order = await Order.create({
      user: buyer._id, orderNumber: `ORD-${Math.random().toString(36).slice(2, 8)}`,
      items: [{ product: product._id, vendor: seller._id, category: category._id, name: "Phone", price: 10000, quantity: 1 }],
      shippingAddress: { street: "KN 1", city: "Kigali", state: "Kigali", country: "Rwanda" },
      totalAmount: 10000, paymentStatus: "PAID", orderStatus: "PROCESSING", deliveryOtp: "123456", ...overrides,
    });
    const session = await orm.startSession();
    session.startTransaction();
    await financial.lockPaymentInEscrow({
      orderId: order._id, vendorId: seller._id, grossAmount: 10000, session,
      split: { totalPlatformFee: 500, vendorNet: 9500, developerShare: 0, adminShare: 500, affiliateShare: 0, gatewayFee: 0 },
    });
    await session.commitTransaction();
    session.endSession();
    return order;
  };

  test("payment, then automatic release one day after shipping: everyone is paid and the books add up", async () => {
    const order = await paidOrder({ orderStatus: "OUT_FOR_DELIVERY", shippedAt: new Date(Date.now() - 2 * DAY) });
    let b = await books();
    expect(b.of("ESCROW_HOLDING")).toBe(10000);
    expect(b.of("BUYER_PAYMENTS")).toBe(-10000);
    expect(b.total).toBe(0);

    const { released } = await require("../../src/controllers/order.controller").autoReleaseDueDeliveries();
    expect(released).toBe(1);
    const fresh = await Order.findById(order._id);
    expect(fresh.orderStatus).toBe("DELIVERED");
    expect((await Settlement.findOne({ order: order._id })).status).toBe("RELEASED");

    b = await books();
    expect(b.of("ESCROW_HOLDING")).toBe(0);
    expect(b.of("VENDOR_PAYABLE")).toBe(9500);
    expect(b.of("PLATFORM_REVENUE")).toBe(500);
    expect(b.total).toBe(0);
    expect((await VendorWallet.findOne({ vendor: seller._id })).availableBalance).toBe(9500);
    expect((await AdminWallet.findOne({ adminUser: admin._id })).availableBalance).toBe(500);
  });

  test("automatic release waits for the delay, and never touches disputed or pickup orders", async () => {
    await paidOrder({ orderStatus: "OUT_FOR_DELIVERY", shippedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // 2 hours ago
    await paidOrder({ orderStatus: "OUT_FOR_DELIVERY", paymentStatus: "DISPUTED", shippedAt: new Date(Date.now() - 5 * DAY) });
    await paidOrder({ orderStatus: "READY_FOR_SHIPMENT", shippingMethod: "PICKUP", shippedAt: new Date(Date.now() - 5 * DAY) });
    const { released } = await require("../../src/controllers/order.controller").autoReleaseDueDeliveries();
    expect(released).toBe(0);
    await settings.update({ autoReleaseDays: 0 });
    await paidOrder({ orderStatus: "OUT_FOR_DELIVERY", shippedAt: new Date(Date.now() - 9 * DAY) });
    expect((await require("../../src/controllers/order.controller").autoReleaseDueDeliveries()).released).toBe(0);
  });

  test("refund returns the held money to the buyer and clears pending balances", async () => {
    const order = await paidOrder();
    const session = await orm.startSession();
    session.startTransaction();
    await financial.refundHeldEscrowForOrder({ orderId: order._id, session });
    await session.commitTransaction();
    session.endSession();
    const b = await books();
    expect(b.of("ESCROW_HOLDING")).toBe(0);
    expect(b.of("BUYER_REFUND_HOLD")).toBe(10000);
    expect(b.total).toBe(0);
    expect((await VendorWallet.findOne({ vendor: seller._id })).pendingBalance).toBe(0);
    expect((await AdminWallet.findOne({ adminUser: admin._id })).pendingBalance).toBe(0);
  });

  test("a split dispute pays each side once and closes the payment so delivery can't pay it again", async () => {
    const order = await paidOrder({ paymentStatus: "DISPUTED" });
    const session = await orm.startSession();
    session.startTransaction();
    await financial.splitHeldEscrowForOrder({ orderId: order._id, buyerRefund: 4000, sellerRelease: 5000, session, adminUserId: admin._id });
    await session.commitTransaction();
    session.endSession();
    const b = await books();
    expect(b.of("ESCROW_HOLDING")).toBe(0);
    expect(b.of("BUYER_REFUND_HOLD")).toBe(4000);
    expect(b.of("VENDOR_PAYABLE")).toBe(5000);
    expect(b.of("PLATFORM_REVENUE")).toBe(1000);
    expect(b.total).toBe(0);
    const s = await Settlement.findOne({ order: order._id });
    expect(s.status).toBe("RELEASED");
    let releasedAgain = null;
    try { await financial.releaseEscrowToVendor({ settlementId: s._id }); releasedAgain = true; } catch { releasedAgain = false; }
    expect(releasedAgain).toBe(false);
    const wallet = await VendorWallet.findOne({ vendor: seller._id });
    expect(wallet.pendingBalance).toBe(0);
    expect(wallet.availableBalance).toBe(5000);
  });

  test("ad clicks: one paid click per visitor, booked as MVEC income; only charged budget is returned", async () => {
    const vendor = await Vendor.create({ user: seller._id, businessName: "Shop", phone: "0788000001", email: "s@s.test", verificationStatus: "VERIFIED" });
    await VendorWallet.create({ vendor: seller._id, availableBalance: 20000 });
    const ad = await Advertisement.create({ vendor: vendor._id, productId: product._id, product: "Phone", placement: "FEATURED", budget: 5000, spent: 0, refunded: 0, status: "ACTIVE" });
    expect(await sellerFinance.chargeBalance(seller._id, 5000, { type: "ADVERTISING", reference: ad.publicId, description: "Ad budget" })).toBeTruthy();

    const first = await advertising.click(ad.publicId, "u:visitor-1");
    const again = await advertising.click(ad.publicId, "u:visitor-1");
    const other = await advertising.click(ad.publicId, "ip:10.0.0.2");
    expect(first.charged).toBe(100);
    expect(again.charged).toBe(0);
    expect(other.charged).toBe(100);

    let b = await books();
    expect(b.of("AD_BUDGETS")).toBe(4800);
    expect(b.of("PLATFORM_REVENUE")).toBe(200);
    expect(b.total).toBe(0);
    expect((await AdminWallet.findOne({ adminUser: admin._id })).availableBalance).toBe(200);

    const fresh = await Advertisement.findById(ad._id);
    const returned = await advertising.finish(fresh, "COMPLETED", { notify: false });
    expect(returned).toBe(4800);
    expect((await VendorWallet.findOne({ vendor: seller._id })).availableBalance).toBe(19800);

    // A campaign whose budget was never charged gives nothing back.
    const unpaid = await Advertisement.create({ vendor: vendor._id, productId: product._id, product: "Phone", placement: "FEATURED", budget: 5000, spent: 0, refunded: 0, status: "ACTIVE" });
    expect(await advertising.finish(unpaid, "COMPLETED", { notify: false })).toBe(0);
    expect((await SellerCharge.find({ reference: unpaid.publicId })).length).toBe(0);
    b = await books();
    expect(b.total).toBe(0);
  });

  test("plans: everything is open while off; when on, Free has the listing limit and Premium tools", async () => {
    let ent = await plans.entitlements(seller._id);
    expect(ent.plan).toBe("ALL_ACCESS");
    expect(ent.productLimit).toBe(null);
    await plans.assertCanList(seller._id, async () => 9999); // no limit while off

    await settings.update({ subscriptionsEnabled: true, freeProductLimit: 2 });
    ent = await plans.entitlements(seller._id);
    expect(ent.plan).toBe("FREE");
    expect(ent.features.promotions).toBe(false);
    await plans.assertCanList(seller._id, async () => 1);
    let limitMessage = "";
    try { await plans.assertCanList(seller._id, async () => 2); } catch (e) { limitMessage = e.message; }
    expect(limitMessage).toMatch(/Free plan/);

    const Subscription = require("../../src/models/Subscription");
    await Subscription.create({ vendor: seller._id, plan: "PREMIUM", status: "ACTIVE", price: 5000, billingCycle: "MONTHLY", autoRenew: true, renewalDate: new Date(Date.now() + 10 * DAY) });
    ent = await plans.entitlements(seller._id);
    expect(ent.plan).toBe("PREMIUM");
    expect(ent.productLimit).toBe(null);
    expect(ent.features.bulkUpload).toBe(true);
  });

  test("premium renewals are paused while the program is off", async () => {
    const Subscription = require("../../src/models/Subscription");
    await Subscription.create({ vendor: seller._id, plan: "PREMIUM", status: "ACTIVE", price: 5000, billingCycle: "MONTHLY", autoRenew: true, renewalDate: new Date(Date.now() - DAY) });
    const result = await require("../../src/services/subscriptionBilling.service").renewDueSubscriptions();
    expect(result.paused).toBe(true);
    expect((await Subscription.findOne({ vendor: seller._id })).plan).toBe("PREMIUM");
    expect(Dispute).toBeTruthy();
  });
});
