// A seller's identity and business papers, sent with onboarding or the profile
// for Ikiguzi's review. Files are private uploads (routes/upload.routes.js,
// /api/uploads/private/<owner>-<id>); only the owner and admins can open them.
const KINDS = { NATIONAL_ID: "National ID or passport", BUSINESS_REGISTRATION: "RDB business registration", TIN: "TIN certificate", OTHER: "Other document" };

/** Clean [{ kind, url, name }] for `userId`, or throw a 400 naming what's wrong. */
function clean(raw, userId) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw Object.assign(new Error("Send the documents as a list."), { statusCode: 400 });
  if (raw.length > 10) throw Object.assign(new Error("Attach at most 10 documents."), { statusCode: 400 });
  const own = new RegExp(`^/api/uploads/private/${String(userId)}-[0-9a-f-]{36}\\.(jpg|png|webp|pdf)$`);
  return raw.map((d, i) => {
    const kind = String(d?.kind || "").toUpperCase();
    if (!KINDS[kind]) throw Object.assign(new Error(`Document ${i + 1}: choose what it is (ID, business registration, TIN or other).`), { statusCode: 400 });
    const url = String(d?.url || "");
    if (!own.test(url)) throw Object.assign(new Error(`Document ${i + 1}: upload the file again from this page.`), { statusCode: 400 });
    return { kind, label: KINDS[kind], url, name: String(d?.name || "").slice(0, 120), uploadedAt: d?.uploadedAt || new Date() };
  });
}

module.exports = { clean, KINDS };
