const orm = require("../database/orm");
const WholesaleOrder = require("../models/WholesaleOrder");
const VendorWallet = require("../models/VendorWallet");
const Supplier = require("../models/Supplier");
const WholesaleProduct = require("../models/WholesaleProduct");
const Settlement = require("../models/Settlement");
const Payment = require("../models/Payment");
const stock = require("./stock.service");
const { resolveOwnedStore } = require("../utils/vendorStore.util");

const HOURS = 60 * 60 * 1000;
const UNPAID_EXPIRY_HOURS = 48;
const SHIP_WITHIN_DAYS = 7;
const AUTO_RELEASE_DAYS = 7;
const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const rwf = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const notifications = () => require("./notification.service");
const notify = async (to, payload) => {
  try {
    await notifications().notify(to, payload);
  } catch (error) {
    console.error("Wholesale notification failed:", error.message);
  }
};

async function inTransaction(work) {
