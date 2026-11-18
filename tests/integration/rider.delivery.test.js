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
  const acceptedParcel = async () => {
    await goOnline("riderA", NEAR_STORE);
    const id = await paidOrder();
    await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" });
    const [offer] = (await request(app).get("/api/rider/deliveries/available").set(as("riderA"))).body.deliveries;
    expect((await request(app).post(`/api/rider/deliveries/${offer.id}/accept`).set(as("riderA"))).status).toBe(200);
    return { id, deliveryId: offer.id };
  };

  test("the buyer and the seller follow the rider live; others can't", async () => {
    const { id, deliveryId } = await acceptedParcel();
    await request(app).patch("/api/rider/location").set(as("riderA")).send({ ...NEAR_STORE, heading: 90, speedMps: 8, accuracyM: 12 });

    const live = await request(app).get(`/api/orders/${id}/live`).set(as("buyer"));
    expect(live.status).toBe(200);
    const [parcel] = live.body.parcels;
    expect([parcel.active, parcel.phase, parcel.target]).toEqual([true, "to_store", "store"]);
    expect(parcel.rider.name).toBe("Rider Alpha");
    expect(parcel.rider.plateNumber).toBe("RAB123A");
    expect(parcel.rider.location.heading).toBe(90);
    expect(parcel.route.distanceM).toBeGreaterThan(0);
    expect(new Date(parcel.route.etaAt).getTime()).toBeGreaterThan(Date.now());
    expect(parcel.route.steps).toBeUndefined();

    expect((await request(app).get(`/api/orders/${id}/live`).set(as("vendor"))).body.parcels).toHaveLength(1);
    expect((await request(app).get(`/api/orders/${id}/live`).set(as("riderB"))).status).toBe(403);

    // The rider's own view has turn-by-turn steps; after pickup it leads to the buyer.
    const nav = await request(app).get(`/api/rider/deliveries/${deliveryId}/navigation`).set(as("riderA"));
    expect(nav.body.route.steps.length).toBeGreaterThan(0);
    expect((await request(app).get(`/api/rider/deliveries/${deliveryId}/navigation`).set(as("riderB"))).status).toBe(404);
    await request(app).patch(`/api/rider/deliveries/${deliveryId}/status`).set(as("riderA")).send({ status: "PICKED_UP" });
    const after = (await request(app).get(`/api/orders/${id}/live`).set(as("buyer"))).body.parcels[0];
    expect([after.phase, after.target]).toEqual(["to_buyer", "buyer"]);
  });

  test("a parcel not collected in time: reminder, then late, then another rider gets it", async () => {
    const { deliveryId } = await acceptedParcel();
    const assignedAt = new Date((await Delivery.findById(deliveryId)).assignedAt).getTime();
    const at = (minutes) => new Date(assignedAt + minutes * 60 * 1000);

    expect(await deliveryService.checkLatePickups(at(10))).toEqual({ warned: 0, flagged: 0, reassigned: 0 });
    expect(await deliveryService.checkLatePickups(at(26))).toEqual({ warned: 1, flagged: 0, reassigned: 0 });
    expect(await deliveryService.checkLatePickups(at(27))).toEqual({ warned: 0, flagged: 0, reassigned: 0 });
    expect(await deliveryService.checkLatePickups(at(31))).toEqual({ warned: 0, flagged: 1, reassigned: 0 });
    expect((await Delivery.findById(deliveryId)).lateAt).toBeTruthy();
    expect(await deliveryService.checkLatePickups(at(46))).toEqual({ warned: 0, flagged: 0, reassigned: 1 });

    const back = await Delivery.findById(deliveryId);
    expect([back.status, back.rider]).toEqual(["READY_FOR_PICKUP", null]);
    expect(back.rejectedBy.map(String)).toContain(String(riderA._id));
  });

  test("an admin sees parcels on the way and can hand one back before pickup", async () => {
    const { deliveryId } = await acceptedParcel();
    const list = await request(app).get("/api/admin/deliveries").set(as("admin"));
    expect(list.status).toBe(200);
    expect(list.body.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId]);
    expect(list.body.deliveries[0].rider.location).toBeTruthy();

    expect((await request(app).post(`/api/admin/deliveries/${deliveryId}/release`).set(as("admin")).send({ note: "Rider unreachable" })).status).toBe(200);
    expect((await Delivery.findById(deliveryId)).status).toBe("READY_FOR_PICKUP");
    expect((await request(app).post(`/api/admin/deliveries/${deliveryId}/release`).set(as("admin"))).status).toBe(409);
    expect((await request(app).post(`/api/admin/deliveries/${deliveryId}/release`).set(as("riderA"))).status).toBe(403);
  });

  test("a rider withdraws what they earned to mobile money", async () => {
    const { id, deliveryId } = await acceptedParcel();
    for (const status of ["PICKED_UP", "OUT_FOR_DELIVERY"]) await request(app).patch(`/api/rider/deliveries/${deliveryId}/status`).set(as("riderA")).send({ status });
    const { deliveryOtp } = await Order.findById(id);
    const earned = (await request(app).post(`/api/rider/deliveries/${deliveryId}/confirm`).set(as("riderA")).send({ code: deliveryOtp })).body.earned;
    expect(earned).toBeGreaterThanOrEqual(1000);

    const tooMuch = await request(app).post("/api/rider/wallet/withdrawals").set(as("riderA")).send({ amount: earned + 1, payoutDetails: { accountName: "Rider Alpha", accountNumber: "0788000603" } });
    expect(tooMuch.status).toBe(400);
    const paid = await request(app).post("/api/rider/wallet/withdrawals").set(as("riderA")).send({ amount: 1000, payoutDetails: { accountName: "Rider Alpha", accountNumber: "0788000603" } });
    expect(paid.status).toBeLessThan(300);
    const { wallet } = (await request(app).get("/api/rider/wallet").set(as("riderA"))).body;
    expect(wallet.available).toBe(earned - 1000);
    expect((await request(app).get("/api/rider/wallet/withdrawals").set(as("riderA"))).body.payouts).toHaveLength(1);
  });
  test("early dispatch: offered once paid, the rider follows the seller's steps and collects only once ready", async () => {
    const Notification = require("../../src/models/Notification");
    const titlesFor = async (user) => (await Notification.find({ recipient: user._id }).lean()).map((n) => n.title);
    expect((await goOnline("riderA", NEAR_STORE)).status).toBe(200);
    const id = await paidOrder();

    // Offered as soon as the buyer pays, saying the seller is still preparing it.
    const offers = (await request(app).get("/api/rider/deliveries/available").set(as("riderA"))).body.deliveries;
    expect(offers).toHaveLength(1);
    expect([offers[0].ready, offers[0].waitingForSeller]).toEqual([false, true]);
    const accepted = await request(app).post(`/api/rider/deliveries/${offers[0].id}/accept`).set(as("riderA"));
    expect(accepted.status).toBe(200);
    expect(accepted.body.message).toMatch(/still preparing/);
    expect(accepted.body.delivery.allowedNextStatuses).toEqual([]);
    const steps = accepted.body.delivery.progress.map((p) => [p.key, p.done]);
    expect(steps.slice(0, 4)).toEqual([["PLACED", true], ["CONFIRMED", true], ["PROCESSING", true], ["READY_FOR_SHIPMENT", false]]);

    // No pickup, and no late-pickup clock, before the seller has it ready.
    const early = await request(app).patch(`/api/rider/deliveries/${offers[0].id}/status`).set(as("riderA")).send({ status: "PICKED_UP" });
    expect([early.status, early.body.code]).toEqual([409, "PARCEL_NOT_READY"]);
    expect((await deliveryService.checkLatePickups(new Date(Date.now() + 3 * 3600 * 1000))).reassigned).toBe(0);

    // The seller's steps reach the rider; ready tells them to collect it.
    expect((await request(app).patch("/api/orders/vendor/status").set(as("vendor")).send({ orderId: id, status: "READY_FOR_SHIPMENT" })).status).toBe(200);
    expect(await titlesFor(riderA)).toContain("Parcel ready: collect it now");
    const trip = (await request(app).get("/api/rider/deliveries/active").set(as("riderA"))).body.delivery;
    expect([trip.ready, trip.allowedNextStatuses]).toEqual([true, ["PICKED_UP"]]);
    expect(trip.progress.find((p) => p.key === "READY_FOR_SHIPMENT").done).toBe(true);
    // The buyer's live view sees the rider heading to the store.
    const live = (await request(app).get(`/api/orders/${id}/live`).set(as("buyer"))).body.parcels[0];
    expect([live.active, live.ready, live.phase]).toEqual([true, true, "to_store"]);
    expect((await request(app).patch(`/api/rider/deliveries/${offers[0].id}/status`).set(as("riderA")).send({ status: "PICKED_UP" })).status).toBe(200);
  });

  test("a rider who accepted early can hand the parcel back before pickup", async () => {
    expect((await goOnline("riderA", NEAR_STORE)).status).toBe(200);
    await paidOrder();
    const [offer] = (await request(app).get("/api/rider/deliveries/available").set(as("riderA"))).body.deliveries;
    await request(app).post(`/api/rider/deliveries/${offer.id}/accept`).set(as("riderA"));
    expect((await request(app).post(`/api/rider/deliveries/${offer.id}/release`).set(as("riderA"))).status).toBe(200);
    const back = await Delivery.findById(offer.id);
    expect([back.status, back.rider]).toEqual(["READY_FOR_PICKUP", null]);
    // Never offered to that rider again.
    expect((await request(app).get("/api/rider/deliveries/available").set(as("riderA"))).body.deliveries).toHaveLength(0);
    expect((await request(app).post(`/api/rider/deliveries/${offer.id}/release`).set(as("riderA"))).status).toBe(404);
  });
});
