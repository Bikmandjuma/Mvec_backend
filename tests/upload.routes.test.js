const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { stripImageMetadata } = require("../src/utils/imageMetadata");

describe("uploaded photos", () => {
  it("lose their hidden metadata, including GPS", async () => {
    const withExif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#884422" } })
      .jpeg()
      .withExif({ IFD0: { Make: "PhoneCo" }, IFD3: { GPSLatitudeRef: "S", GPSLatitude: "1/1 57/1 0/1" } })
      .toBuffer();
    assert.ok((await sharp(withExif).metadata()).exif, "the test photo starts with EXIF");

    const clean = await stripImageMetadata(withExif, "image/jpeg");
    const meta = await sharp(clean).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.format, "jpeg");
  });

  it("a damaged image is refused", async () => {
    await assert.rejects(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), "image/jpeg"));
  });
});
