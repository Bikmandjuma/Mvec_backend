const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const User = require("../../src/models/User");
const Product = require("../../src/models/Product");
const Category = require("../../src/models/Category");
const Cart = require("../../src/models/Cart");

jest.setTimeout(60000);

let mongoServer;
let app;
const JWT_SECRET = "test_cart_secret_key";

function createTestApp() {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors());
  testApp.use(express.json());
  testApp.use("/api/cart", require("../../src/routes/cart.routes"));
  return testApp;
}

describe("Cart: add / update quantity / remove", () => {
  let vendorUser, buyerUser;
  let buyerToken;
  let product;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;
    mongoServer = await MongoMemoryServer.create({
      binary: { version: "7.0.0" },
      replSet: { count: 1 },
    });
    await mongoose.connect(mongoServer.getUri());
    app = createTestApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Product.deleteMany({}), Category.deleteMany({}), Cart.deleteMany({})]);

    vendorUser = await User.create({
      Fullname: "Kigali Tech Store",
      email: "vendor@cart.rw",
      password: "password123",
      phone: "0788000002",
      gender: "female",
      role: "vendor",
      companyName: "Kigali Electronics Ltd",
    });
    buyerUser = await User.create({
      Fullname: "Jean Paul",
      email: "jeanpaul@cart.rw",
      password: "password123",
      phone: "0788123456",
      gender: "male",
      role: "buyer",
    });
    buyerToken = jwt.sign({ userId: buyerUser._id, role: buyerUser.role }, JWT_SECRET);

    const category = await Category.create({ name: "Electronics", slug: "electronics" });
    product = await Product.create({
      vendor: vendorUser._id,
      category: category._id,
      name: "Wireless Headphones",
      price: 68000,
      stockQuantity: 20,
      description: "Great noise cancelling headphones",
      media: { mainImage: "https://img.example/h.png", gallery: ["https://img.example/a.png", "https://img.example/b.png"] },
      status: "ACTIVE",
    });
  });

  const addToCart = () =>
    request(app)
      .post("/api/cart")
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ productId: product._id.toString(), quantity: 1 });

  test("Add to cart returns a populated cart with quantity 1", async () => {
    const res = await addToCart();
    expect(res.status).toBe(200);
    const item = res.body.cart.items[0];
    expect(item.quantity).toBe(1);
    expect(item.product).toBeTruthy();
    expect(typeof item.product).toBe("object");
    expect(item.product.name).toBe("Wireless Headphones");
  });

  test("Update quantity returns a populated cart so qty/id survive re-render (regression)", async () => {
    await addToCart();

    const res = await request(app)
      .put(`/api/cart/items/${product._id.toString()}`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    const item = res.body.cart.items[0];
    expect(item.quantity).toBe(3);
    // The returned item.product must be populated (an object), not a bare ObjectId string.
    expect(item.product).toBeTruthy();
    expect(typeof item.product).toBe("object");
    expect(item.product._id.toString()).toBe(product._id.toString());
  });

  test("Increment then decrement reflects correct quantities", async () => {
    await addToCart();

    await request(app)
      .put(`/api/cart/items/${product._id.toString()}`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ quantity: 2 });

    const res = await request(app)
      .put(`/api/cart/items/${product._id.toString()}`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ quantity: 1 });

    expect(res.status).toBe(200);
    expect(res.body.cart.items[0].quantity).toBe(1);
    expect(typeof res.body.cart.items[0].product).toBe("object");
  });

  test("Remove item from cart returns an updated populated cart", async () => {
    await addToCart();

    const res = await request(app)
      .delete(`/api/cart/items/${product._id.toString()}`)
      .set("Authorization", `Bearer ${buyerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.cart.items).toHaveLength(0);
  });

  test("Vendor cannot add their own product to cart", async () => {
    const vendorToken = jwt.sign({ userId: vendorUser._id, role: vendorUser.role }, JWT_SECRET);
    const res = await request(app)
      .post("/api/cart")
      .set("Authorization", `Bearer ${vendorToken}`)
      .send({ productId: product._id.toString(), quantity: 1 });
    expect(res.status).toBe(403);
  });
});
