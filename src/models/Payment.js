import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  parentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentOrder', required: true },
  transactionReference: { type: String, unique: true },
  method: { 
    type: String, 
    enum: ['MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'GATEWAY', 'CASH_ON_DELIVERY'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELLED'], 
    default: 'PENDING' 
  },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'RWF' },
  gatewayResponse: { type: Object },
  paidAt: Date
}, { timestamps: true });

export const Payment = mongoose.model('Payment', paymentSchema);