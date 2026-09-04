const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");

// Swagger setup
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const swaggerDocument = YAML.load("./swagger.yaml");

// Load all models into mongoose entry
const routes = require("./src/routes/auth.routes");
const User = require("./src/models/User");
const Category = require("./src/models/Category");
const Product = require("./src/models/Product");
const { initBackgroundWorkers } = require("./src/workers/slaWorker");

dotenv.config();

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB:", error);
  });

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/products", require("./src/routes/product.routes"));
app.use("/api/categories", require("./src/routes/category.routes"));
app.use("/api/admin/suppliers", require("./src/routes/admin.supplier.routes"));
app.use("/api/suppliers", require("./src/routes/supplier.routes"));
app.use("/api/cart", require("./src/routes/cart.routes"));
app.use("/api/orders", require("./src/routes/order.routes"));
app.use("/api/stores", require("./src/routes/store.routes"));
app.use("/api/payouts", require("./src/routes/payout.routes"));
app.use("/api/staff", require("./src/routes/staff.routes"));
app.use("/api/payments", require("./src/routes/payment.routes"));
app.use("/api/admin", require("./src/routes/admin.financial.routes"));
app.use("/api/admin", require("./src/routes/admin.commission.routes"));
app.use("/api/wholesale", require("./src/routes/wholesale.routes"));
app.use("/api/disputes", require("./src/routes/dispute.routes"));


// Initialize background cron tasks once DB connection is established
mongoose.connection.once("open", () => {
  console.log("Connected to MongoDB.");
  initBackgroundWorkers();
});

// Swagger documentation route
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get("/", (req, res) => {
  res.json({
    message: "Multi-Vendor E-Commerce API is working!",
  });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
