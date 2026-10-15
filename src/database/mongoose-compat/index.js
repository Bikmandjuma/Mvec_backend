// Mongoose-style models over MySQL (Sequelize). Each src/models/* file exports
// `model("Name")` from here, so controllers, services and workers keep the
// familiar find/populate/save API while all data lives in MySQL.
const { registry } = require("./registry");
const { model, registryRef } = require("./model");

registryRef.registry = registry;

module.exports = { model, registry };
