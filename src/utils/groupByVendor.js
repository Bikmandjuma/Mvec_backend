// const groupByVendor = (items = []) => {
//   return items.reduce((groups, item) => {
//     const vendorId = String(item.vendor?._id || item.vendor);

//     if (!vendorId || vendorId === "undefined") {
//       return groups;
//     }

//     if (!groups[vendorId]) {
//       groups[vendorId] = [];
//     }

//     const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
//     const quantity = Number(item.quantity || 0);

//     groups[vendorId].push({
//       ...item,
//       unitPrice,
//       quantity,
//       totalPrice: unitPrice * quantity,
//     });

//     return groups;
//   }, {});
// };

// module.exports = groupByVendor;
// module.exports.groupByVendor = groupByVendor;
