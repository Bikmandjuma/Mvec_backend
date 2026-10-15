// Mongoose ClientSession over Sequelize transactions.
// Queries that run inside an active session join its transaction even when
// the session isn't passed explicitly (AsyncLocalStorage), so MySQL row locks
// taken by the transaction can't block the same request.
const { AsyncLocalStorage } = require("async_hooks");
const { sequelize } = require("..");

const als = new AsyncLocalStorage();

// A transaction left open (a code path that returns without commit/abort)
// would hold a pooled connection forever; it is rolled back after this long.
const ABANDONED_TX_MS = 2 * 60 * 1000;

class CompatSession {
  constructor() {
    this._active = false;
    this._txPromise = null;
    this._done = false;
    this.id = { id: Date.now() };
  }

  // The MySQL transaction (and its connection) is only opened by the first
  // query, so a request that bails out early holds no connection.
  startTransaction() {
    if (this._active && !this._done) return;
    this._active = true;
    this._done = false;
    this._txPromise = null;
    als.enterWith({ session: this });
  }

  _tx() {
    if (!this._active || this._done) return undefined;
    if (!this._txPromise) {
      this._txPromise = sequelize.transaction();
      this._txPromise.catch(() => {});
      this._txPromise.then((t) => {
        const timer = setTimeout(() => {
          if (this._done) return;
          console.error("[database] Rolling back a transaction that was never committed or aborted.");
          this._done = true;
          t.rollback().catch(() => {});
        }, ABANDONED_TX_MS);
        timer.unref();
        t.afterCommit(() => clearTimeout(timer));
      }).catch(() => {});
    }
    return this._txPromise;
  }

  inTransaction() { return this._active && !this._done; }

  async commitTransaction() {
    if (!this._active || this._done) return;
    this._done = true;
    if (!this._txPromise) return;
    const t = await this._txPromise;
    await t.commit();
  }

  async abortTransaction() {
    if (!this._active || this._done) return;
    this._done = true;
    if (!this._txPromise) return;
    const t = await this._txPromise;
    await t.rollback();
  }

  // Ending a session that is still in a transaction rolls it back (as MongoDB does).
  endSession() {
    if (this._active && !this._done) this.abortTransaction().catch(() => {});
  }

  async withTransaction(fn) {
    this.startTransaction();
    try {
      const result = await fn(this);
      await this.commitTransaction();
      return result;
    } catch (err) {
      await this.abortTransaction();
      throw err;
    }
  }
}

// Transaction for a query: explicit session first, then the active one.
async function resolveTx(session) {
  const s = session || als.getStore()?.session;
  if (s && typeof s._tx === "function") return s._tx();
  return undefined;
}

module.exports = { CompatSession, resolveTx, als };
