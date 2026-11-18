// Push notifications through Firebase Cloud Messaging (FCM HTTP v1), so a
// rider's offer or a buyer's "your parcel is on its way" reaches the phone
// even when the app is closed. Off until the Firebase keys are set:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// (from a Firebase service account). Every in-app notification is also pushed
// (notification.service), and a token Firebase says is gone is forgotten.
const jwt = require("jsonwebtoken");
const DeviceToken = require("../models/DeviceToken");

const idOf = (v) => String(v?._id || v?.id || v || "");
const config = () => ({
  projectId: process.env.FIREBASE_PROJECT_ID || "",
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
  privateKey: String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
});
const configured = () => {
  const c = config();
  return Boolean(c.projectId && c.clientEmail && c.privateKey.includes("PRIVATE KEY"));
};

let token = { value: null, until: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.until) return token.value;
  const c = config();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: c.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 },
    c.privateKey,
    { algorithm: "RS256" },
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Firebase sign-in failed (${res.status})`);
  const body = await res.json();
  token = { value: body.access_token, until: Date.now() + (Number(body.expires_in) - 300) * 1000 };
  return token.value;
}

/** Remembers a phone or browser for push (one token belongs to one account). */
async function register(user, { token: raw, platform = "ANDROID" } = {}) {
  const value = String(raw || "").trim();
  if (value.length < 20 || value.length > 500) throw Object.assign(new Error("That device token isn't valid."), { statusCode: 400 });
  const kind = ["ANDROID", "IOS", "WEB"].includes(String(platform).toUpperCase()) ? String(platform).toUpperCase() : "ANDROID";
  const existing = await DeviceToken.findOne({ token: value });
  if (existing) {
    Object.assign(existing, { user: idOf(user), platform: kind, lastSeenAt: new Date() });
    await existing.save();
  } else {
    await DeviceToken.create({ user: idOf(user), token: value, platform: kind, lastSeenAt: new Date() });
  }
  return { registered: true, pushEnabled: configured() };
}

async function unregister(user, raw) {
  await DeviceToken.deleteMany({ user: idOf(user), token: String(raw || "") });
  return { removed: true };
}

/** Pushes { title, body, link } to every device of the user. Never throws. */
async function sendToUser(userId, { title, body = "", link = "" } = {}) {
  if (!configured()) return 0;
  try {
    const devices = await DeviceToken.find({ user: idOf(userId) }).select("token").lean();
    if (!devices.length) return 0;
    const auth = await accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${config().projectId}/messages:send`;
    let sent = 0;
    for (const d of devices) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: d.token,
            notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 400) },
            data: { link: String(link || "") },
            android: { priority: "HIGH", notification: { channel_id: "ikiguzi", sound: "default" } },
          },
        }),
      });
      if (res.ok) sent += 1;
      else if ([400, 404].includes(res.status)) {
        const err = await res.json().catch(() => ({}));
        if (JSON.stringify(err).includes("UNREGISTERED") || res.status === 404) await DeviceToken.deleteOne({ token: d.token });
      }
    }
    return sent;
  } catch (error) {
    console.error("Push failed:", error.message);
    return 0;
  }
}

module.exports = { configured, register, unregister, sendToUser };
