// Delivery pricing used at checkout. The server is the source of truth: the
// frontend shows the same numbers (see Ikiguzi_frontend/src/utils/delivery.js),
// but the order total is always recomputed here before an order is created.

const PROVINCES = [
  "Kigali City",
  "Northern Province",
  "Southern Province",
  "Eastern Province",
  "Western Province",
];

const DELIVERY_METHODS = ["standard", "express"];

const FEES = {
  standardKigali: 0,
  standardProvince: 5000,
  express: 10000,
};

function computeShippingFee({ province, method }) {
  if (method === "express") return FEES.express;
  return province === "Kigali City" ? FEES.standardKigali : FEES.standardProvince;
}

module.exports = { PROVINCES, DELIVERY_METHODS, FEES, computeShippingFee };
