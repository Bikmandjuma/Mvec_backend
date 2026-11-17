require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const User = require("../../src/models/User");

jest.setTimeout(60000);

const JWT_SECRET = "test_upload_secret_key";
const uploadDir = path.resolve(__dirname, "../../uploads");
let app, token, user;
const saved = [];

const photoWithGps = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "S", GPSLatitude: "1/1 57/1 0/1" } })
    .toBuffer();

describe("Uploads", () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await db.setup();
    app = express();
    app.use("/api/uploads", require("../../src/routes/upload.routes"));
  });

  afterAll(async () => {
    await Promise.all(saved.map((name) => fs.rm(path.join(uploadDir, name), { force: true })));
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    user = await User.create({ Fullname: "Aline", email: "aline@upload.rw", password: "password123", phone: "0788111222", gender: "female", role: "buyer" });
    token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET);
  });

  it("a profile photo is saved without its GPS location", async () => {
    const res = await request(app)
      .post("/api/uploads/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", await photoWithGps(), { filename: "me.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    const name = res.body.avatarUrl.split("/uploads/")[1];
    saved.push(name);
    const meta = await sharp(await fs.readFile(path.join(uploadDir, name))).metadata();
    expect(meta.exif).toBeUndefined();
    expect((await User.findById(user._id)).avatarUrl).toBe(res.body.avatarUrl);
  });

  it("a file renamed to .jpg is refused", async () => {
    const res = await request(app)
      .post("/api/uploads/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("avatar", Buffer.from("<script>alert(1)</script>"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("product images need a seller account", async () => {
    const res = await request(app)
      .post("/api/uploads/images")
      .set("Authorization", `Bearer ${token}`)
      .attach("images", await photoWithGps(), { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(403);
  });
});
