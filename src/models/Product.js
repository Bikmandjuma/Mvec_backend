const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  brand: { type: String, required: true, index: true },
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  sku: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  shortDescription: String,
  price: { type: Number, required: true, index: true }, // e.g., 50000 RWF
  discountPrice: Number,
  stockQuantity: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'OUT_OF_STOCK'], default: 'DRAFT' },
  
  // Media Resources
  media: {
    mainImage: { type: String, required: true },
    gallery: [String],
    thumbnails: [String],
    videos: [String]
  },
  
  // Dynamic Attributes (Color, Size, Weight, Model, Capacity)
  attributes: {
    color: String,
    size: String,
    material: String,
    weight: String,
    capacity: String,
    model: String
  }
}, { timestamps: true });

// Text Search Index for Product Name, SKU, Brand, and Description
productSchema.index({ name: 'text', description: 'text', sku: 'text', brand: 'text' });
// Wildcard Index for Dynamic Attribute Filtering
productSchema.index({ "attributes.$**": 1 });

module.exports = mongoose.model('Product', productSchema);