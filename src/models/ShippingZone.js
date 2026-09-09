const mongoose = require("mongoose");
const crypto = require("crypto");

const shippingZoneSchema = new mongoose.Schema(
  {
    publicId: { type: String, unique: true, index: true },

    // Zone can be global (admin-set delivery rules) or vendor-specific.
    store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    name: { type: String, required: true }, // e.g. "Kigali City", "Northern Province"

    countries: { type: [String], default: ["Rwanda"] },
    provinces: { type: [String], default: [] },
    districts: { type: [String], default: [] },
    postalCodes: { type: [String], default: [] },

    fee: { type: Number, default: 0 }, // flat delivery fee in RWF
    freeOverAmount: { type: Number, default: 0 }, // free delivery above this order total

    eta: { type: String, default: "1–3 days" }, // estimated delivery window text
    methods: {
      type: [String],
      enum: ["STANDARD", "EXPRESS", "PICKUP"],
      default: ["STANDARD"],
    },

    status: {
      type: String,
      enum: ["ACTIVE", "PAUSED"],
      default: "ACTIVE",
    },
  },
  { timestamps: true }
);

shippingZoneSchema.pre("save", async function () {
  if (!this.publicId) {
    this.publicId = `MVEC-ZONE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  }
});

module.exports = mongoose.model("ShippingZone", shippingZoneSchema);
