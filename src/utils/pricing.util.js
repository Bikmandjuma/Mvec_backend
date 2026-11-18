// The price a buyer actually pays for a product.
//
// A flash deal wins while it is on (between its start and end, with units
// left). Otherwise a discount applies only when it is a positive number below
// the regular price; a stale or mistyped discountPrice that is higher than the
// price must never raise what we charge.

/** Whether the product's flash deal is on at `now`. */
const dealOn = (product, now = new Date()) => {
  const price = Number(product?.price) || 0;
  const deal = Number(product?.dealPrice) || 0;
  if (!(deal > 0 && deal < price) || !product.dealStartsAt || !product.dealEndsAt) return false;
  const t = now.getTime();
  if (t < new Date(product.dealStartsAt).getTime() || t >= new Date(product.dealEndsAt).getTime()) return false;
  const cap = product.dealQuantity;
  return cap === null || cap === undefined || (Number(product.dealSold) || 0) < Number(cap);
};

exports.dealOn = dealOn;

exports.effectivePrice = (product, now = new Date()) => {
  const price = Number(product?.price) || 0;
  if (dealOn(product, now)) return Number(product.dealPrice);
  const discount = Number(product?.discountPrice) || 0;
  return discount > 0 && discount < price ? discount : price;
};

/**
 * The deal as buyers see it: { price, startsAt, endsAt, live, left, percentOff },
 * or null when there is none, it has ended, or it sold out.
 */
exports.dealView = (product, now = new Date()) => {
  const price = Number(product?.price) || 0;
  const deal = Number(product?.dealPrice) || 0;
  if (!(deal > 0 && deal < price) || !product.dealStartsAt || !product.dealEndsAt) return null;
  if (now >= new Date(product.dealEndsAt)) return null;
  const cap = product.dealQuantity;
  const left = cap === null || cap === undefined ? null : Math.max(0, Number(cap) - (Number(product.dealSold) || 0));
  if (left === 0) return null;
  return {
    price: deal,
    startsAt: product.dealStartsAt,
    endsAt: product.dealEndsAt,
    live: dealOn(product, now),
    left,
    percentOff: Math.round((1 - deal / price) * 100),
  };
};

// Fields a price needs: select these wherever effectivePrice is used.
exports.PRICE_FIELDS = "price discountPrice dealPrice dealStartsAt dealEndsAt dealQuantity dealSold";
