// MySQL (DB_DRIVER=mysql): same API, backed by Sequelize. See src/database/mongoose-compat.
if (require("../database/driver").isMysql) {
  module.exports = require("../database/mongoose-compat").model("StaffActivity");
  return;
}

const mongoose = require("mongoose");

// What a staff member changed in their store (writes only), for the owner's
// Team page.
const staffActivitySchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    action: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    statusCode: { type: Number, default: 200 },
  },
  { timestamps: true }
);
staffActivitySchema.index({ vendor: 1, createdAt: -1 });

module.exports = mongoose.model("StaffActivity", staffActivitySchema);
