require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Store = require("../../src/models/Store");
const Product = require("../../src/models/Product");
const Order = require("../../src/models/Order");
const Rider = require("../../src/models/Rider");
const Delivery = require("../../src/models/Delivery");
const VendorWallet = require("../../src/models/VendorWallet");
const Category = require("../../src/models/Category");
const commission = require("../../src/services/commission.service");
const deliveryService = require("../../src/services/delivery.service");

jest.setTimeout(90000);

// Kigali: the store in Kimihurura, the buyer in Remera (about 3 km).
const STORE = { lat: -1.9536, lng: 30.0936 };
const BUYER = { lat: -1.9578, lng: 30.1127 };
const NEAR_STORE = { lat: -1.955, lng: 30.095 };
const FAR_AWAY = { lat: -2.6, lng: 29.74 }; // Huye

describe("Ikiguzi riders deliver sellers' parcels", () => {
  let app;
  let vendor, buyer, riderA, riderB, product;
  const tokens = {};
  const secret = "rider_delivery_secret";
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const order = {
    shippingAddress: { street: "KG 11 Ave 18", district: "Gasabo", sector: "Remera", province: "Kigali City", ...BUYER },
    recipient: { name: "Aline Uwase", phone: "0788123456" },
    deliveryMethod: "standard",
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox payments
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/orders", require("../../src/routes/order.routes"));
    app.use("/api/payments", require("../../src/routes/payment.routes"));
    app.use("/api/rider", require("../../src/routes/rider.routes"));
    app.use("/api/admin", require("../../src/routes/admin.ops.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880006${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    vendor = await make("Kigali Gadgets", "vendor", 1);
    buyer = await make("Aline Buyer", "buyer", 2);
    riderA = await make("Rider Alpha", "delivery", 3);
    riderB = await make("Rider Beta", "delivery", 4);
    const admin = await make("Admin", "super_admin", 5);
    const store = await Store.create({ vendor: vendor._id, isPrimary: true, storeName: "Kigali Gadgets", slug: "kigali-gadgets", contactEmail: "shop@example.com", contactPhone: "0788000601", status: "ACTIVE", pickupLat: STORE.lat, pickupLng: STORE.lng, riderDelivery: true, businessAddress: "KG 7 Ave" });
    const category = await Category.create({ name: "Electronics", slug: "electronics" });
    product = await Product.create({ vendor: vendor._id, store: store._id, category: category._id, name: "Headphones", description: "Wireless headphones.", sku: "HP-1", price: 20000, stockQuantity: 5, status: "ACTIVE", media: { mainImage: "/h.png", gallery: [] } });
    await deliveryService.register(riderA, { vehicleType: "MOTORBIKE", plateNumber: "RAB123A", approved: true });
    await deliveryService.register(riderB, { vehicleType: "MOTORBIKE", plateNumber: "RAB456B" });
    for (const [k, u] of Object.entries({ vendor, buyer, riderA, riderB, admin })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const paidOrder = async () => {
    const bought = await request(app).post("/api/orders/direct-checkout").set(as("buyer")).send({ ...order, items: [{ productId: String(product._id), quantity: 1 }] });
    expect(bought.status).toBe(201);
    const id = bought.body.order.id;
    expect((await request(app).post("/api/payments/pay").set(as("buyer")).send({ orderId: id, phoneNumber: "0788123456" })).body.status).toBe("SUCCESS");
    return id;
  };
  const goOnline = async (who, at) => {
    expect((await request(app).patch("/api/rider/location").set(as(who)).send(at)).status).toBe(200);
    return request(app).patch("/api/rider/availability").set(as(who)).send({ isOnline: true });
  };

  test("checkout prices a rider parcel by distance from the store pin to the buyer's pin", async () => {
    const id = await paidOrder();
    const saved = await Order.findById(id);
    const [parcel] = saved.shippingBreakdown;
    expect(parcel.method).toBe("RIDER");
    // ~2.2 km straight × 1.3 road factor ≈ 2.8 km → 500 + 200 × km
    expect(parcel.fee).toBeGreaterThan(800);
    expect(parcel.fee).toBeLessThan(1600);
    expect(Math.abs(saved.shippingAddress.lat - BUYER.lat) < 1e-6).toBe(true);
  });

  test("ready → offered to the nearest rider → picked up → delivered with the buyer's code; seller and rider are paid", async () => {
    expect((await goOnline("riderA", NEAR_STORE)).status).toBe(200);
    const id = await paidOrder();
    const fee = (await Order.findById(id)).shippingBreakdown[0].fee;

    // The seller can't ship a rider parcel itself.
    expect((await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "SHIPPED" })).status).toBe(400);
    expect((await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" })).status).toBe(200);

    const offers = await request(app).get("/api/rider/deliveries/available").set(as("riderA"));
    expect(offers.status).toBe(200);
    expect(offers.body.deliveries).toHaveLength(1);
    const offer = offers.body.deliveries[0];
    expect(offer.fee).toBe(fee);
    // Before accepting, the buyer's details stay hidden.
    expect(offer.customer).toBeNull();
    expect(offer.dropoff.lat).toBeNull();

    const accepted = await request(app).post(`/api/rider/deliveries/${offer.id}/accept`).set(as("riderA"));
    expect(accepted.status).toBe(200);
    expect(accepted.body.delivery.customer.phone).toBe("+250788123456");
    expect(accepted.body.delivery.allowedNextStatuses).toEqual(["PICKED_UP"]);

    // Steps only go forward, one at a time.
    expect((await request(app).patch(`/api/rider/deliveries/${offer.id}/status`).set(as("riderA")).send({ status: "OUT_FOR_DELIVERY" })).status).toBe(409);
    expect((await request(app).patch(`/api/rider/deliveries/${offer.id}/status`).set(as("riderA")).send({ status: "PICKED_UP" })).status).toBe(200);
    expect((await Order.findById(id)).orderStatus).toBe("SHIPPED");
    expect((await request(app).patch(`/api/rider/deliveries/${offer.id}/status`).set(as("riderA")).send({ status: "OUT_FOR_DELIVERY" })).status).toBe(200);
    expect((await Order.findById(id)).orderStatus).toBe("OUT_FOR_DELIVERY");

    const wrong = await request(app).post(`/api/rider/deliveries/${offer.id}/confirm`).set(as("riderA")).send({ code: "000000" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/4 attempts left/);

    const { deliveryOtp } = await Order.findById(id);
    const done = await request(app).post(`/api/rider/deliveries/${offer.id}/confirm`).set(as("riderA")).send({ code: deliveryOtp });
    expect(done.status).toBe(200);
    expect(done.body.earned).toBe(fee);

    const after = await Order.findById(id);
    expect(after.orderStatus).toBe("DELIVERED");
    const riderWallet = await VendorWallet.findOne({ vendor: riderA._id });
    expect(riderWallet.availableBalance).toBe(fee);
    const sellerWallet = await VendorWallet.findOne({ vendor: vendor._id });
    expect(sellerWallet.pendingBalance).toBe(0);
    expect(sellerWallet.availableBalance).toBeGreaterThan(0);

    const wallet = await request(app).get("/api/rider/wallet").set(as("riderA"));
    expect(wallet.body.wallet.available).toBe(fee);
    const stats = await request(app).get("/api/rider/stats").set(as("riderA"));
    expect([stats.body.todayDeliveries, stats.body.todayEarnings]).toEqual([1, fee]);
  });

  test("first rider to accept wins; a declined parcel is never offered to that rider again", async () => {
    await goOnline("riderA", NEAR_STORE);
    await Rider.updateOne({ user: riderB._id }, { $set: { status: "APPROVED" } });
    await goOnline("riderB", NEAR_STORE);
    const id = await paidOrder();
    await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" });
    const [job] = await Delivery.find({ order: id });
    expect(job.offers.map((o) => String(o.rider)).sort()).toEqual([String(riderA._id), String(riderB._id)].sort());

    expect((await request(app).post(`/api/rider/deliveries/${job._id}/reject`).set(as("riderB"))).status).toBe(200);
    expect((await request(app).get("/api/rider/deliveries/available").set(as("riderB"))).body.deliveries).toHaveLength(0);
    expect((await request(app).post(`/api/rider/deliveries/${job._id}/accept`).set(as("riderA"))).status).toBe(200);
    expect((await request(app).post(`/api/rider/deliveries/${job._id}/accept`).set(as("riderB"))).status).toBe(409);
  });

  test("riders far away get no offer; going offline before pickup hands the parcel back", async () => {
    await goOnline("riderA", FAR_AWAY);
    const id = await paidOrder();
    await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" });
    const [job] = await Delivery.find({ order: id });
    expect(job.offers).toHaveLength(0);
    expect((await request(app).post(`/api/rider/deliveries/${job._id}/accept`).set(as("riderA"))).status).toBe(403);

    await request(app).patch("/api/rider/location").set(as("riderA")).send(NEAR_STORE);
    expect((await request(app).post(`/api/rider/deliveries/${job._id}/accept`).set(as("riderA"))).status).toBe(200);
    const off = await request(app).patch("/api/rider/availability").set(as("riderA")).send({ isOnline: false });
    expect(off.body.handedBack).toBe(1);
    expect((await Delivery.findById(job._id)).status).toBe("READY_FOR_PICKUP");
  });

  test("a rider signs up with a verified phone and waits for approval", async () => {
    const phoneToken = (role) => jwt.sign({ phone: "+250788555777", purpose: "registration", role }, secret, { expiresIn: "15m" });
    const details = { fullName: "Rider Gamma", vehicleType: "MOTORBIKE", plateNumber: "RAC 777 C" };
    expect((await request(app).post("/api/rider/register").send({ ...details, verificationToken: phoneToken("buyer") })).status).toBe(400);

    const res = await request(app).post("/api/rider/register").send({ ...details, verificationToken: phoneToken("delivery") });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe("delivery");
    expect((await Rider.findOne({ user: res.body.user._id || res.body.user.id })).status).toBe("PENDING");
  });

  test("a rider waits for approval; an admin approves", async () => {
    const pending = await request(app).get("/api/rider/deliveries/available").set(as("riderB"));
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe("RIDER_PENDING");
    const list = await request(app).get("/api/admin/riders?status=PENDING").set(as("admin"));
    expect(list.body.riders.map((r) => r.name)).toEqual(["Rider Beta"]);
    expect((await request(app).patch(`/api/admin/riders/${list.body.riders[0].id}`).set(as("admin")).send({ status: "REJECTED" })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/riders/${list.body.riders[0].id}`).set(as("admin")).send({ status: "APPROVED" })).status).toBe(200);
    expect((await request(app).get("/api/rider/deliveries/available").set(as("riderB"))).status).toBe(200);
  });

  test("cancelling the order withdraws its parcel from riders", async () => {
    await goOnline("riderA", NEAR_STORE);
    const id = await paidOrder();
    await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" });
    expect((await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "CANCELLED" })).status).toBe(200);
    expect((await Delivery.findOne({ order: id })).status).toBe("CANCELLED");
  });
});
