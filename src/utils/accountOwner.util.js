// Team members act for the account they belong to. These return the OWNER's
// user id: a supplier team member works on the supplier owner's orders and
// money; a seller staff member (resolved by checkStaffPermission into
// req.vendorId) on the seller's.
const Supplier = require("../models/Supplier");
const SupplierTeamMember = require("../models/SupplierTeamMember");

async function supplierOwnerOf(user) {
  const own = await Supplier.findOne({ user: user._id || user.id }).select("user businessName category").lean();
  if (own) return { userId: String(own.user), supplier: own, teamRole: "OWNER" };
  const membership = await SupplierTeamMember.findOne({ user: user._id || user.id, status: "ACTIVE" }).lean();
  if (!membership) return null;
  const supplier = await Supplier.findById(membership.supplier).select("user businessName category").lean();
  return supplier ? { userId: String(supplier.user), supplier, teamRole: membership.role } : null;
}

const vendorOwnerOf = (req) => String(req.vendorId || req.user._id || req.user.id);

module.exports = { supplierOwnerOf, vendorOwnerOf };
