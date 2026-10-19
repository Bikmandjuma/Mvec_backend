require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const User = require("../../src/models/User");
const Order = require("../../src/models/Order");
const Product = require("../../src/models/Product");
const Category = require("../../src/models/Category");
const Settlement = require("../../src/models/Settlement");
const LedgerAccount = require("../../src/models/LedgerAccount");
const VendorWallet = require("../../src/models/VendorWallet");
const Dispute = require("../../src/models/Dispute");
const Notification = require("../../src/models/Notification");
const financial = require("../../src/services/financial.service");
const disputes = require("../../src/services/dispute.service");
const cases = require("../../src/services/disputeCase.service");
const settings = require("../../src/services/platformSettings.service");
const orm = require("../../src/database/orm");

jest.setTimeout(60000);
const DAY = 24 * 60 * 60 * 1000;
const balanceOf = async (type) => (await LedgerAccount.find({ accountType: type })).reduce((n, a) => n + Number(a.balance), 0);
const booksTotal = async () => Math.round((await LedgerAccount.find({})).reduce((n, a) => n + Number(a.balance), 0) * 100) / 100;
const fails = async (fn) => { try { await fn(); return ""; } catch (e) { return e.message || "error"; } };

describe("Problem reports: buyer, seller and MVEC resolve a case", () => {
  let admin, seller, buyer, stranger, category, product;
  const as = (u) => ({ id: String(u._id), _id: u._id, role: u.role });

  beforeAll(async () => { await db.setup(); });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await db.reset();
    admin = await User.create({ Fullname: "Admin", email: "admin@case.test", phone: "0788200001", password: "password123", role: "super_admin" });
    seller = await User.create({ Fullname: "Seller", email: "seller@case.test", phone: "0788200002", password: "password123", role: "vendor", companyName: "Shop" });
    buyer = await User.create({ Fullname: "Buyer", email: "buyer@case.test", phone: "0788200003", password: "password123", role: "buyer" });
    stranger = await User.create({ Fullname: "Other", email: "other@case.test", phone: "0788200004", password: "password123", role: "buyer" });
    category = await Category.create({ name: "Phones", slug: "phones" });
    product = await Product.create({ vendor: seller._id, category: category._id, name: "Phone", slug: "phone", sku: "PH-1", description: "A phone", price: 10000, stockQuantity: 10, media: { mainImage: "/uploads/x.jpg" }, status: "ACTIVE" });
    await settings.update({ disputeResponseDays: 3, autoReleaseDays: 1 });
  });

  // A paid 10,000 RWF order (seller share 9,500, MVEC 500) with a problem reported.
  const reported = async () => {
    const order = await Order.create({
      user: buyer._id, orderNumber: `ORD-${Math.random().toString(36).slice(2, 8)}`,
      items: [{ product: product._id, vendor: seller._id, category: category._id, name: "Phone", price: 10000, quantity: 1 }],
      shippingAddress: { street: "KN 1", city: "Kigali", state: "Kigali", country: "Rwanda" },
      totalAmount: 10000, paymentStatus: "PAID", orderStatus: "OUT_FOR_DELIVERY", deliveryOtp: "123456",
    });
    const session = await orm.startSession();
    session.startTransaction();
    await financial.lockPaymentInEscrow({ orderId: order._id, vendorId: seller._id, grossAmount: 10000, session, split: { totalPlatformFee: 500, vendorNet: 9500, developerShare: 0, adminShare: 500, affiliateShare: 0, gatewayFee: 0 } });
    await session.commitTransaction();
    session.endSession();
    const dispute = await disputes.openDispute({ orderId: order._id, raisedById: buyer._id, reason: "DAMAGED_GOODS", description: "The screen arrived cracked.", disputedAmount: 10000 });
    return { order, dispute };
  };

  test("opening a case freezes the payment, sets the seller's deadline and only the parties can see it", async () => {
    const { order, dispute } = await reported();
    expect((await Order.findById(order._id)).paymentStatus).toBe("DISPUTED");
    const due = new Date(dispute.respondBy).getTime() - Date.now();
    expect(due > 2.9 * DAY && due <= 3 * DAY).toBe(true);

    const asSeller = await cases.getCase(dispute._id, as(seller));
    expect(asSeller.you).toBe("seller");
    expect(asSeller.actions.fullRefund).toBe(true);
    expect(asSeller.actions.offer).toBe(true);
    expect(asSeller.actions.decide).toBe(false);
    expect(asSeller.timeline[0].role).toBe("system");
    expect(asSeller.case.held.gross).toBe(10000);

    const asBuyer = await cases.getCase(dispute._id, as(buyer));
    expect(asBuyer.actions.withdraw).toBe(true);
    expect(asBuyer.actions.fullRefund).toBe(false);
    expect((await cases.getCase(dispute._id, as(admin))).actions.decide).toBe(true);
    expect(await fails(() => cases.getCase(dispute._id, as(stranger)))).toMatch(/not found/i);

    // Seller and admins were told, with links to their own case views.
    const sellerNote = await Notification.findOne({ recipient: seller._id });
    expect(sellerNote.link).toBe(`/vendor/refunds?case=${dispute._id}`);
  });

  test("seller offers a partial refund, buyer accepts: money splits once and the books add up", async () => {
    const { order, dispute } = await reported();
    await cases.sellerOffer(dispute._id, as(seller), { amount: 3000, note: "Keep it with 3,000 back" });
    expect((await cases.getCase(dispute._id, as(buyer))).actions.acceptOffer).toBe(true);
    expect(await fails(() => cases.sellerOffer(dispute._id, as(seller), { amount: 2000 }))).toMatch(/hasn't answered/);

    await cases.buyerRespondOffer(dispute._id, as(buyer), true);
    const closed = await Dispute.findById(dispute._id);
    expect(closed.status).toBe("RESOLVED_SPLIT");
    expect(closed.offerStatus).toBe("ACCEPTED");
    expect(await balanceOf("ESCROW_HOLDING")).toBe(0);
    expect(await balanceOf("BUYER_REFUND_HOLD")).toBe(3000);
    expect(await balanceOf("VENDOR_PAYABLE")).toBe(6650); // seller's usual 95% of the 7,000 not refunded
    expect(await balanceOf("PLATFORM_REVENUE")).toBe(350);
    expect(await booksTotal()).toBe(0);
    expect((await VendorWallet.findOne({ vendor: seller._id })).availableBalance).toBe(6650);
    expect((await Settlement.findOne({ order: order._id })).status).toBe("RELEASED");
    const buyerNote = await Notification.findOne({ recipient: buyer._id, title: { $regex: "resolved" } });
    expect(Boolean(buyerNote)).toBe(true);
  });

  test("seller refunds in full", async () => {
    const { order, dispute } = await reported();
    await cases.sellerFullRefund(dispute._id, as(seller));
    expect((await Dispute.findById(dispute._id)).status).toBe("RESOLVED_BUYER_REFUNDED");
    expect(await balanceOf("BUYER_REFUND_HOLD")).toBe(10000);
    expect(await balanceOf("ESCROW_HOLDING")).toBe(0);
    expect((await Order.findById(order._id)).paymentStatus).toBe("REFUNDED");
    expect(await fails(() => cases.sellerFullRefund(dispute._id, as(seller)))).toMatch(/closed/);
  });

  test("buyer declines the offer, MVEC reviews and decides to pay the seller", async () => {
    const { dispute } = await reported();
    await cases.sellerOffer(dispute._id, as(seller), { amount: 1000 });
    await cases.buyerRespondOffer(dispute._id, as(buyer), false);
    let d = await Dispute.findById(dispute._id);
    expect(d.status).toBe("UNDER_REVIEW");
    expect(d.offerStatus).toBe("DECLINED");
    expect(await fails(() => cases.decide(dispute._id, as(admin), { decision: "RELEASE_TO_VENDOR", notes: "" }))).toMatch(/Explain/);
    await cases.decide(dispute._id, as(admin), { decision: "RELEASE_TO_VENDOR", notes: "Delivery photo shows the phone intact." });
    d = await Dispute.findById(dispute._id);
    expect(d.status).toBe("RESOLVED_VENDOR_RELEASED");
    expect(await balanceOf("VENDOR_PAYABLE")).toBe(9500);
    expect(await booksTotal()).toBe(0);
    const timeline = (await cases.getCase(dispute._id, as(buyer))).timeline.map((e) => e.message).join(" | ");
    expect(timeline).toMatch(/MVEC decided to pay the seller/);
  });

  test("buyer withdraws once the problem is solved: the order carries on as normal", async () => {
    const { order, dispute } = await reported();
    await cases.withdraw(dispute._id, as(buyer), "Seller replaced it");
    expect((await Dispute.findById(dispute._id)).status).toBe("WITHDRAWN");
    expect((await Order.findById(order._id)).paymentStatus).toBe("PAID");
    expect((await Settlement.findOne({ order: order._id })).status).toBe("HELD");
    expect(await fails(() => cases.withdraw(dispute._id, as(seller)))).toMatch(/Only the buyer/);
  });

  test("MVEC steps in automatically when the seller doesn't respond in time", async () => {
    const { dispute } = await reported();
    expect((await cases.escalateOverdue()).escalated).toBe(0);
    await Dispute.updateOne({ _id: dispute._id }, { $set: { respondBy: new Date(Date.now() - 1000) } });
    expect((await cases.escalateOverdue()).escalated).toBe(1);
    const d = await Dispute.findById(dispute._id);
    expect(d.status).toBe("UNDER_REVIEW");
    expect(d.escalationReason).toMatch(/didn't respond/);
    // A seller who replied before the deadline is not escalated, even once it passes;
    // a buyer adding detail alone doesn't count as the seller responding.
    const second = await reported();
    await disputes.submitEvidence({ disputeId: second.dispute._id, userId: buyer._id, userRole: "buyer", message: "More photos attached" });
    expect((await Dispute.findById(second.dispute._id)).status).toBe("OPEN");
    await disputes.submitEvidence({ disputeId: second.dispute._id, userId: seller._id, userRole: "vendor", message: "It was packed with foam; here is the courier photo." });
    await Dispute.updateOne({ _id: second.dispute._id }, { $set: { respondBy: new Date(Date.now() - 1000) } });
    await cases.escalateOverdue();
    expect((await Dispute.findById(second.dispute._id)).status).toBe("EVIDENCE_SUBMITTED");
  });
});
