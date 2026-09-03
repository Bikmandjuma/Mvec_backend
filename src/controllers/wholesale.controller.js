const wholesaleService = require("../services/wholesale.service");

exports.createWholesaleOrder = async (req, res) => {
  try {
    const { supplierId, items } = req.body;
    const vendorId = req.user.id; // Extracted from Auth JWT

    const order = await wholesaleService.createWholesaleOrder({
      vendorId,
      supplierId,
      items,
    });

    return res.status(201).json({
      success: true,
      message: "Wholesale supply order created successfully.",
      data: order,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.holdEscrow = async (req, res) => {
  try {
    const { orderId } = req.params;
    const updatedOrder = await wholesaleService.holdWholesaleEscrow(orderId);

    return res.status(200).json({
      success: true,
      message: "Funds locked in escrow successfully.",
      data: updatedOrder,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.confirmReceipt = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { otp } = req.body;

    const result = await wholesaleService.confirmReceiptAndRelease(orderId, otp);

    return res.status(200).json({
      success: true,
      message: "Wholesale order confirmed and escrow funds released to supplier.",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};