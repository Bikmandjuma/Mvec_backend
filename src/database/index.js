// Sequelize instance + models. MySQL is the application's only database.
const { Sequelize } = require("sequelize");
const env = process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development";
const config = require("./config")[env];

const sequelize = new Sequelize(config.database, config.username, config.password, config);

// Values are written/read as UTC; make DB-side NOW()/CURRENT_TIMESTAMP agree.
sequelize.addHook("afterConnect", async (connection) => {
  await new Promise((resolve, reject) => connection.query("SET time_zone = '+00:00'", (err) => (err ? reject(err) : resolve())));
});

const models = {
  User: require("./models/User")(sequelize),
  UserAddress: require("./models/UserAddress")(sequelize),
  UserWishlistItem: require("./models/UserWishlistItem")(sequelize),
  Otp: require("./models/Otp")(sequelize),
  Vendor: require("./models/Vendor")(sequelize),
  Store: require("./models/Store")(sequelize),
  Staff: require("./models/Staff")(sequelize),
  Category: require("./models/Category")(sequelize),
  Product: require("./models/Product")(sequelize),
  StockMovement: require("./models/StockMovement")(sequelize),
};

// Phase 3–4 tables are declared as specs (see spec/define.js).
const { defineModel, associate } = require("./spec/define");
const specs = [...require("./spec/commerce"), ...require("./spec/platform")];
for (const spec of specs) {
  const Model = defineModel(sequelize, spec);
  models[spec.model] = Model;
  Object.values(Model.children).forEach((Child) => { models[Child.name] = Child; });
}

Object.values(models).forEach((model) => model.associate && model.associate(models));

// MariaDB (e.g. XAMPP) keeps JSON columns as LONGTEXT and returns strings;
// parse them so every model sees the same objects as on MySQL.
for (const Model of Object.values(models)) {
  for (const [name, attr] of Object.entries(Model.rawAttributes)) {
    if (!(attr.type instanceof Sequelize.JSON)) continue;
    const own = attr.get;
    attr.get = function () {
      const v = own ? own.call(this) : this.getDataValue(name);
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return v; }
    };
  }
  Model.refreshAttributes();
}

// Millisecond dates everywhere (columns are DATETIME(3), like MongoDB's Date).
for (const Model of Object.values(models)) {
  let changed = false;
  for (const attr of Object.values(Model.rawAttributes)) {
    if (attr.type instanceof Sequelize.DATE && !attr.type._length) { attr.type = Sequelize.DATE(3); changed = true; }
  }
  if (changed) Model.refreshAttributes();
}

const tableToModel = Object.fromEntries(Object.entries(models).map(([name, M]) => [M.tableName, name]));
associate(models, tableToModel);

module.exports = { sequelize, Sequelize, models, specs };
