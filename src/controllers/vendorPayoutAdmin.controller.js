// MVEC finance: review and pay out seller withdrawal requests.
// PENDING -> PROCESSING (approved) -> PAID (transfer reference recorded)
// PENDING/PROCESSING -> REJECTED (amount returned to the seller's balance)
const orm = require("../database/orm");
const ledger = require("../services/ledger.service");
const { Payout } = require("../models/Payout");
const VendorWallet = require("../models/VendorWallet");
const User = require("../models/User");
const paypack = require("../services/paypack.service");
const { notify } = require("../services/sellerFinance.service");

const fmt = (n) => `${Number(n || 0).toLocaleString("en-RW")} RWF`;
const autoDisburse = () => process.env.PAYOUT_AUTO_DISBURSE === "true";

// Moves a payout between statuses only if it is still in one of `from`.
const transition = (id, from, set) =>
  Payout.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: set }, { new: true });

// @route GET /api/admin/vendor-payouts?status=&page=&pageSize=
exports.listVendorPayouts = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
    const filter = req.query.status ? { status: req.query.status } : {};
    const [data, total, all] = await Promise.all([
      Payout.find(filter).populate("vendor", "Fullname email phone companyName").sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize),
      Payout.countDocuments(filter),
      Payout.find({}).select("status amount"),
    ]);
    const vendorIds = [...new Set(data.map((p) => String(p.vendor?._id || p.vendor)))];
    const balances = await VendorWallet.find({ vendor: { $in: vendorIds } });
    const balanceBy = new Map(balances.map((b) => [String(b.vendor), Number(b.availableBalance || 0)]));
    const totals = ["PENDING", "PROCESSING", "PAID", "REJECTED", "CANCELLED", "FAILED"].reduce((o, s) => {
      const rows = all.filter((p) => p.status === s);
      o[s] = { count: rows.length, amount: rows.reduce((t, p) => t + Number(p.amount), 0) };
      return o;
    }, {});
    return res.status(200).json({
      data: data.map((p) => ({ ...p.toJSON(), sellerAvailableBalance: balanceBy.get(String(p.vendor?._id || p.vendor)) ?? 0 })),
      totals,
      autoDisburse: autoDisburse(),
      meta: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/admin/vendor-payouts/:id/approve
// With PAYOUT_AUTO_DISBURSE=true the money is sent through Paypack right away.
exports.approveVendorPayout = async (req, res) => {
  try {
    if (!orm.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Payout not found." });
    let payout = await transition(req.params.id, ["PENDING"], { status: "PROCESSING" });
    if (!payout) return res.status(400).json({ message: "Only pending requests can be approved." });

    if (autoDisburse()) {
      try {
        const result = await paypack.cashout({ amount: payout.amount, phone: payout.payoutDetails?.accountNumber });
        payout = await transition(payout._id, ["PROCESSING"], {
          transferReference: result.ref || null,
          ...(result.status === "SUCCESSFUL" ? { status: "PAID", processedAt: new Date() } : {}),
        });
        if (payout.status === "PAID") {
          await VendorWallet.updateOne({ vendor: payout.vendor }, { $inc: { totalWithdrawn: Number(payout.amount) } });
          await ledger.payoutSent({ fromType: "VENDOR_PAYABLE", ownerId: payout.vendor, amount: payout.amount, reference: payout.payoutNumber, description: `Withdrawal sent by Paypack (${payout.payoutNumber})` });
        }
      } catch (err) {
        payout = await transition(payout._id, ["PROCESSING"], { status: "PENDING" });
        return res.status(502).json({ message: `Approval undone: ${err.message}`, payout });
      }
    }
    await notify(payout.vendor, "Payout approved", `Your payout ${payout.payoutNumber} of ${fmt(payout.amount)} is being sent to ${payout.payoutDetails?.bankName || "mobile money"}.`, payout.payoutNumber);
    return res.status(200).json({ message: payout.status === "PAID" ? "Payout sent." : "Payout approved. Record the transfer reference once it's sent.", payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/admin/vendor-payouts/:id/mark-paid   { transferReference }
exports.markVendorPayoutPaid = async (req, res) => {
  try {
    const ref = String(req.body.transferReference || "").trim();
    if (!ref) return res.status(400).json({ message: "Enter the mobile money transaction reference." });
    if (!orm.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Payout not found." });
    const payout = await transition(req.params.id, ["PENDING", "PROCESSING"], { status: "PAID", transferReference: ref, processedAt: new Date() });
    if (!payout) return res.status(400).json({ message: "This payout was already completed, rejected or cancelled." });
    await VendorWallet.updateOne({ vendor: payout.vendor }, { $inc: { totalWithdrawn: Number(payout.amount) } });
    await ledger.payoutSent({ fromType: "VENDOR_PAYABLE", ownerId: payout.vendor, amount: payout.amount, reference: payout.payoutNumber, description: `Withdrawal sent (ref ${ref})` });
    await notify(payout.vendor, "Payout sent", `${fmt(payout.amount)} was sent to ${payout.payoutDetails?.accountNumber || "your mobile money"} (ref ${ref}).`, payout.payoutNumber);
    return res.status(200).json({ message: "Payout marked as paid.", payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/admin/vendor-payouts/:id/reject   { reason }
exports.rejectVendorPayout = async (req, res) => {
  try {
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "Tell the seller why the payout was rejected." });
    if (!orm.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Payout not found." });
    const payout = await transition(req.params.id, ["PENDING", "PROCESSING"], { status: "REJECTED", rejectionReason: reason, processedAt: new Date() });
    if (!payout) return res.status(400).json({ message: "This payout was already completed, rejected or cancelled." });
    await VendorWallet.updateOne({ vendor: payout.vendor }, { $inc: { availableBalance: Number(payout.amount) } });
    await notify(payout.vendor, "Payout rejected", `Your payout ${payout.payoutNumber} was rejected: ${reason}. ${fmt(payout.amount)} is back in your available balance.`, payout.payoutNumber);
    return res.status(200).json({ message: "Payout rejected and the amount returned to the seller.", payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
