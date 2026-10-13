const mongoose = require("mongoose");

/**
 * Money flows (payment, cancellation and refund, delivery release, payouts) run
 * inside MongoDB transactions. Transactions only exist on a replica set; on a
 * standalone mongod every one of them fails with "Transaction numbers are only
 * allowed on a replica set member or mongos", so buyers saw "We could not
 * cancel this order" with nothing they could do about it.
 *
 * When the server cannot run transactions, sessions keep working but the
 * transaction calls become no-ops, so each step still runs, just without
 * all-or-nothing rollback. Run MongoDB as a replica set in any shared or
 * production environment:
 *   mongod --dbpath <data dir> --replSet rs0
 *   mongosh --eval 'rs.initiate()'      (once)
 */
let transactionsSupported = null;

function makeNonTransactional(session) {
  session.startTransaction = () => {};
  session.commitTransaction = async () => {};
  session.abortTransaction = async () => {};
  session.inTransaction = () => false;
  session.withTransaction = async (fn) => fn(session);
  return session;
}

async function ensureTransactionSupport(connection = mongoose.connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  transactionsSupported = Boolean(hello.setName) || hello.msg === "isdbgrid";
  if (transactionsSupported) return true;

  const original = connection.startSession.bind(connection);
  connection.startSession = async (...args) => makeNonTransactional(await original(...args));

  const warning = "MongoDB is running standalone, so transactions are off: payments, refunds and payouts are not rolled back if a step fails. "
    + "Start mongod with --replSet rs0, then run `mongosh --eval 'rs.initiate()'` once.";
  if (process.env.NODE_ENV === "production") console.error(`[DATABASE] ${warning}`);
  else console.warn(`[database] ${warning}`);
  return false;
}

module.exports = {
  ensureTransactionSupport,
  get transactionsSupported() { return transactionsSupported; },
};
