const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");
const socketService = require("./src/services/socket.service");


// Swagger setup
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const swaggerDocument = YAML.load("./swagger.yaml");

const { initBackgroundWorkers } = require("./src/workers/slaWorker");

dotenv.config();

// All data lives in MySQL (src/database). Run directly, the server refuses to
// start without a reachable, fully migrated database. Required by tests, it
// only exports the app (tests manage their own test database).
const { connectDatabase } = require("./src/database/startup");
const isMain = require.main === module;

const app = express();

// Over plain http (local dev), HSTS and upgrade-insecure-requests make browsers
// fetch assets via https, which breaks Swagger UI with a blank page.
const isProduction = process.env.NODE_ENV === "production";
app.use(helmet({
  contentSecurityPolicy: {
    directives: { upgradeInsecureRequests: isProduction ? [] : null },
  },
  strictTransportSecurity: isProduction,
  // The React app is served from its own origin (Vite on :5173 in dev, its own
  // host in production) while product images live on this API. helmet's default
  // `same-origin` Cross-Origin-Resource-Policy made the browser throw away
  // every cross-origin <img src="…/uploads/…"> even though the server returned
  // 200 OK, so the UI always fell back to the placeholder image.
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));
// Which websites may call this API from a browser. CORS_ORIGINS is a comma
// separated list (e.g. "https://mvec.rw,https://www.mvec.rw"). Production
// falls back to FRONTEND_URL only; development allows any origin so phones on
// the local network can test.
const allowedOrigins = (process.env.CORS_ORIGINS || (isProduction ? process.env.FRONTEND_URL || "" : ""))
  .split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : !isProduction,
  credentials: true,
}));
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
// Keep the raw body so webhook signatures (Paypack, Airtel) can be verified.
// The JSON limit is raised well above Express' 100kb default: product payloads
// (and any client that inlines image data) used to die with a 413 before the
// request ever reached a controller.
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(morgan("dev"));
// Plain-language errors with a support reference on every 5xx.
app.use(require("./src/middleware/friendlyErrors"));
// Every successful change an administrator makes goes to the audit log.
app.use(require("./src/middleware/adminAudit"));

// Uploaded product images are returned as public URLs for storefront display.
app.use("/uploads", express.static(require("path").resolve(__dirname, "uploads")));

  
app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/admin", require("./src/routes/admin.dashboard.routes"));
app.use("/api/admin", require("./src/routes/admin.ops.routes"));
app.use("/api/uploads", require("./src/routes/upload.routes"));
app.use("/api/search", require("./src/routes/search.routes"));
app.use("/api/products", require("./src/routes/product.routes"));
app.use("/api/categories", require("./src/routes/category.routes"));
app.use("/api/admin/suppliers", require("./src/routes/admin.supplier.routes"));
app.use("/api/suppliers", require("./src/routes/supplier.routes"));
app.use("/api/cart", require("./src/routes/cart.routes"));
app.use("/api/orders", require("./src/routes/order.routes"));
app.use("/api/stores", require("./src/routes/store.routes"));
app.use("/api/payouts", require("./src/routes/payout.routes"));
app.use("/api/staff", require("./src/routes/staff.routes"));
app.use("/api/vendor/staff", require("./src/routes/staff.routes"));
app.use("/api/payments", require("./src/routes/payment.routes"));
app.use("/api/admin", require("./src/routes/admin.financial.routes"));
app.use("/api/admin", require("./src/routes/admin.commission.routes"));
app.use("/api/wholesale", require("./src/routes/wholesale.routes"));
app.use("/api/quotes", require("./src/routes/quote.routes"));
app.use("/api/disputes", require("./src/routes/dispute.routes"));
app.use("/api/abuse-reports", require("./src/routes/abuseReport.routes"));
app.use("/api/conversations", require("./src/routes/conversation.routes"));
app.use("/api/support", require("./src/routes/support.routes"));
app.use("/api/languages", require("./src/routes/language.routes"));
app.use("/api/admin", require("./src/routes/adminTranslation.routes"));
app.use("/api/vendors", require("./src/routes/vendor.routes"));
app.use("/api/admin/vendors", require("./src/routes/admin.vendor.routes"));
app.use("/api/affiliates", require("./src/routes/affiliate.routes"));
app.use("/api/webhooks", require("./src/routes/webhook.routes"));
app.use("/api/vendor", require("./src/routes/vendor.service.routes"));
app.use("/api/buyer", require("./src/routes/buyer.service.routes"));
app.use("/api/admin", require("./src/routes/admin.monetization.routes"));
app.use("/api/admin/disbursements", require("./src/routes/admin.disbursement.routes"));
app.use("/api/admin/payouts", require("./src/routes/admin.payout.routes"));
app.use("/api/admin/vendor-payouts", require("./src/routes/vendorPayoutAdmin.routes"));
app.use("/api/developer/payouts", require("./src/routes/developer.payout.routes"));
app.use("/api/reviews", require("./src/routes/review.routes"));
app.use("/api/users", require("./src/routes/user.routes"));
app.use("/api/promotions", require("./src/routes/promotion.routes"));
app.use("/api/ads", require("./src/routes/ads.routes"));
app.use("/api/shipping", require("./src/routes/shipping.routes"));
app.use("/api/notifications", require("./src/routes/notification.routes"));
app.use("/api/reports", require("./src/routes/report.routes"));
app.use("/api/advertisements", require("./src/routes/advertisement.routes"));

// Real-time Server-Sent Events (SSE) stream for browsers
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ status: "connected", time: new Date() })}\n\n`);

  socketService.addSseClient(res);

  // Keep-alive heartbeat every 25 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      socketService.removeSseClient(res);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    socketService.removeSseClient(res);
  });
});

// Swagger documentation route
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Liveness/readiness probe for the hosting platform and uptime monitors.
app.get("/health", async (req, res) => {
  const dbUp = await require("./src/database").sequelize.authenticate().then(() => true, () => false);
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? "ok" : "degraded", db: dbUp ? "up" : "down", uptime: Math.round(process.uptime()) });
});

app.get("/", (req, res) => {
  res.json({
    message: "Multi-Vendor E-Commerce API is working!",
  });
});

// Error handling middleware

// 2. 404 Handler (Triggers when NO route above matches)
app.use((req, res, next) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// 3. Global Error Handling Middleware (MUST have 4 arguments: err, req, res, next)
// Express identifies this as an error handler strictly because it has 4 parameters.
app.use((err, req, res, next) => {
  // Requests the server could not read are the caller's problem, not ours.
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "The request could not be read. Refresh the page and try again." });
  if (err.type === "entity.too.large") return res.status(413).json({ message: "What you sent is too large. Use a smaller file or less text." });
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "That file is too large. Choose a smaller one and try again." });
  const statusCode = err.statusCode || err.status || 500;
  if (statusCode < 500) return res.status(statusCode).json({ message: err.message });
  console.error(err.stack || err);
  // friendlyErrors turns technical messages into plain ones and adds a reference.
  return res.status(statusCode).json({ message: err.message });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "0.0.0.0";

const httpServer = http.createServer(app);
socketService.init(httpServer);

// Tokens signed with a short or example secret can be forged by anyone who
// has read .env.example, so production refuses to start with one.
const weakJwtSecret = (secret) =>
  !secret || secret.length < 32 || /your_jwt_secret|change_me|secret_key_here/i.test(secret);
if (isMain && isProduction && weakJwtSecret(process.env.JWT_SECRET)) {
  console.error("\n[config] JWT_SECRET is missing, too short, or still the example value. Set a random secret of at least 32 characters.\n");
  process.exit(1);
}

if (isMain) {
  connectDatabase()
    .then((name) => {
      console.log(`Connected to MySQL database "${name}"`);
      initBackgroundWorkers();
      httpServer.listen(PORT, HOST, () => {
        console.log(`🚀 Server listening on ${HOST}:${PORT}`);
        console.log(`🏠 Local access: http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error(`\n[database] ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = app;
