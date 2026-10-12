// The price a buyer actually pays for a product. A discount only applies when
// it is a positive number below the regular price; a stale or mistyped
// discountPrice that is higher than the price must never raise what we charge.
exports.effectivePrice = (product) => {
  const price = Number(product?.price) || 0;
  const discount = Number(product?.discountPrice) || 0;
  return discount > 0 && discount < price ? discount : price;
};
