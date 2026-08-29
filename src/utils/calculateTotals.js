// const roundCurrency = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

// const calculateTotals = (items = [], options = {}) => {
//   const taxRate = Number(options.taxRate || 0);
//   const shippingFee = Number(options.shippingFee || 0);
//   const discount = Number(options.discount || 0);
//   const platformFee = Number(options.platformFee || 0);

//   const subtotal = items.reduce((total, item) => {
//     const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
//     const quantity = Number(item.quantity || 0);
//     return total + unitPrice * quantity;
//   }, 0);

//   const tax = Math.max(0, (subtotal - discount) * taxRate);
//   const grandTotal = subtotal + tax + shippingFee + platformFee - discount;

//   return {
//     subtotal: roundCurrency(subtotal),
//     tax: roundCurrency(tax),
//     shippingFee: roundCurrency(shippingFee),
//     discount: roundCurrency(discount),
//     platformFee: roundCurrency(platformFee),
//     grandTotal: roundCurrency(Math.max(0, grandTotal)),
//   };
// };

// module.exports = calculateTotals;
// module.exports.calculateTotals = calculateTotals;
