const ShippingZone = require("../models/ShippingZone");
const Store = require("../models/Store");

function mapZone(z) {
  return {
    id: z.publicId || z._id,
    name: z.name,
    zone: z.name,
    fee: z.fee,
    freeOverAmount: z.freeOverAmount,
    eta: z.eta,
    delivery: z.eta,
    methods: z.methods,
    method: z.methods.join(" / "),
    countries: z.countries,
    provinces: z.provinces,
    districts: z.districts,
    status: z.status,
    store: z.store,
    vendor: z.vendor,
    createdAt: z.createdAt,
  };
}

const allowedStatus = ["ACTIVE", "PAUSED"];

// @desc    Create a shipping zone (vendor for own store, or admin global)
// @route   POST /api/shipping/zones
// @access  Private (vendor or super_admin)
exports.createZone = async (req, res) => {
  try {
    const { name, fee, freeOverAmount, eta, methods, countries, provinces, districts } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Zone name is required" });
    }

    const isVendor = req.user.role === "vendor";
    let store = null;
    if (isVendor) {
      store = await Store.findOne({ vendor: req.user._id });
      if (!store) {
        return res.status(400).json({ message: "Create a store before adding shipping zones" });
      }
    }

    const zone = await ShippingZone.create({
      name: name.trim(),
      vendor: isVendor ? req.user._id : null,
      store: isVendor ? store._id : null,
      fee: fee || 0,
      freeOverAmount: freeOverAmount || 0,
      eta: eta || "1–3 days",
      methods: Array.isArray(methods) && methods.length ? methods : ["STANDARD"],
      countries: Array.isArray(countries) && countries.length ? countries : ["Rwanda"],
      provinces: provinces || [],
      districts: districts || [],
    });

    return res.status(201).json({
      message: "Shipping zone created",
      zone: mapZone(zone.toObject()),
    });
  } catch (error) {
    console.error("Error creating shipping zone:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List shipping zones (vendor sees own; admin sees all; public sees active)
// @route   GET /api/shipping/zones
// @access  Public (active only) / Private for scoped lists
exports.listZones = async (req, res) => {
  try {
    const query = {};
    if (req.user) {
      if (req.user.role === "vendor") query.vendor = req.user._id;
      if (req.user.role === "buyer") {
        query.$or = [{ vendor: null }, { store: null }];
        query.status = "ACTIVE";
      }
    } else {
      query.status = "ACTIVE";
    }

    const zones = await ShippingZone.find(query).sort({ createdAt: -1 });
    return res.status(200).json({
      data: zones.map((z) => mapZone(z.toObject())),
      meta: { total: zones.length },
    });
  } catch (error) {
    console.error("Error listing shipping zones:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update a shipping zone
// @route   PATCH /api/shipping/zones/:id
// @access  Private (vendor owner or super_admin)
exports.updateZone = async (req, res) => {
  try {
    const { id } = req.params;
    const zone = await ShippingZone.findById(id);
    if (!zone) {
      return res.status(404).json({ message: "Shipping zone not found" });
    }

    const isOwner = req.user.role === "vendor" && String(zone.vendor) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to update this zone" });
    }

    const { name, fee, freeOverAmount, eta, methods, countries, provinces, districts, status } =
      req.body;

    if (name !== undefined && name.trim()) zone.name = name.trim();
    if (fee !== undefined) zone.fee = fee;
    if (freeOverAmount !== undefined) zone.freeOverAmount = freeOverAmount;
    if (eta !== undefined) zone.eta = eta;
    if (methods !== undefined) zone.methods = Array.isArray(methods) ? methods : [methods];
    if (countries !== undefined) zone.countries = countries;
    if (provinces !== undefined) zone.provinces = provinces;
    if (districts !== undefined) zone.districts = districts;
    if (status !== undefined) {
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({ message: "Invalid zone status" });
      }
      zone.status = status;
    }

    await zone.save();
    return res.status(200).json({
      message: "Shipping zone updated",
      zone: mapZone(zone.toObject()),
    });
  } catch (error) {
    console.error("Error updating shipping zone:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Delete a shipping zone
// @route   DELETE /api/shipping/zones/:id
// @access  Private (vendor owner or super_admin)
exports.deleteZone = async (req, res) => {
  try {
    const { id } = req.params;
    const zone = await ShippingZone.findById(id);
    if (!zone) {
      return res.status(404).json({ message: "Shipping zone not found" });
    }

    const isOwner = req.user.role === "vendor" && String(zone.vendor) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to delete this zone" });
    }

    await ShippingZone.deleteOne({ _id: id });
    return res.status(200).json({ message: "Shipping zone deleted" });
  } catch (error) {
    console.error("Error deleting shipping zone:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
