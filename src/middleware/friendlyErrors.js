const crypto = require("crypto");

/**
 * Every error a user sees should say what happened and whose move it is.
 *
 * Many handlers answer failures with `res.status(500).json({ message: error.message })`,
 * which shows database internals ("Cast to ObjectId failed…", "Transaction
 * numbers are only allowed…") or nothing useful at all. This middleware sits
 * in front of every route and rewrites such responses:
 *
 *  - input problems hidden in a 500 (bad id, failed validation, duplicate)
 *    become 4xx with a message the user can act on;
 *  - database outages become 503 "on our side, try again shortly";
 *  - other technical messages become a plain "on our side" message;
 *  - every 5xx carries a short `reference` that is also written to the log,
 *    so support can find the exact failure.
 *
 * Messages written for users (most 4xx, and 5xx messages that read as plain
 * sentences) pass through unchanged.
 */

const OUR_SIDE = "Something went wrong on our side, not yours. Please try again in a moment. If it keeps happening, contact MVEC support";
const DB_DOWN = "Our database is not responding right now. This is on our side; please try again in a minute.";

const TECHNICAL = /cast to|objectid|bson|validation failed|e11000|duplicate key|mongo|sequelize|ER_[A-Z_]+|transaction numbers|replica set|topology|buffering timed out|econn|etimedout|socket hang up|cannot read prop|cannot set prop|is not a function|is not defined|is not iterable|undefined|unexpected token|syntaxerror|typeerror|referenceerror|stack|\bnull\b/i;

function validationMessage(message) {
  const detail = String(message).split(/validation failed:\s*/i)[1] || "";
  const parts = detail
    .split(/,\s*(?=[\w.[\]]+:\s)/)
    .map((p) => p.replace(/^[\w.[\]]+:\s*/, "").replace(/^Path `([^`]+)` is required\.?$/, "$1 is required."))
    .filter(Boolean);
  return parts.length ? `Please check your details: ${parts.join(" ")}` : "Some of the details sent are not valid. Please check them and try again.";
}

// Map a technical message to { status, message }, or null to keep it.
function translate(message) {
  const text = String(message || "");
  if (!text) return { status: 500, message: OUR_SIDE };
  if (/cast to objectid|input must be a 24 character hex|bsonerror|invalid objectid/i.test(text)) {
    return { status: 400, message: "That link or ID is not valid. Check it and try again." };
  }
  if (/cast to (number|date|boolean)/i.test(text)) {
    return { status: 400, message: "One of the values sent has the wrong format. Please check numbers and dates and try again." };
  }
  if (/validation failed/i.test(text) || /^SequelizeValidationError/i.test(text)) {
    return { status: 400, message: validationMessage(text) };
  }
  if (/e11000|duplicate key|SequelizeUniqueConstraintError|ER_DUP_ENTRY/i.test(text)) {
    return { status: 409, message: "This already exists. Use a different value and try again." };
  }
  if (/buffering timed out|econnrefused|etimedout|server selection|topology|transaction numbers|replica set|SequelizeConnection|ER_ACCESS_DENIED|PROTOCOL_CONNECTION_LOST/i.test(text)) {
    return { status: 503, message: DB_DOWN };
  }
  if (TECHNICAL.test(text) || text.length > 240 || /^internal server error$|^server error$/i.test(text.trim())) {
    return { status: 500, message: OUR_SIDE };
  }
  return null;
}

function friendlyErrors(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500 || !body || typeof body !== "object" || Array.isArray(body)) return json(body);

    const reference = body.reference || crypto.randomBytes(4).toString("hex").toUpperCase();
    const original = body.message || body.error?.message || (typeof body.error === "string" ? body.error : "");
    const translated = translate(original);
    console.error(`[error ${reference}] ${req.method} ${req.originalUrl} -> ${res.statusCode}: ${original || "(no message)"}`);

    const out = { ...body, reference };
    delete out.error;
    delete out.stack;
    if (translated) {
      res.status(translated.status);
      out.message = translated.status >= 500 ? `${translated.message.replace(/\.$/, "")} (reference ${reference}).` : translated.message;
    } else {
      out.message = original;
    }
    return json(out);
  };
  next();
}

module.exports = friendlyErrors;
module.exports.translate = translate;
