const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const LedgerEntry = require("../src/models/LedgerEntry");
const Settlement = require("../src/models/Settlement");
const LedgerAccount = require("../src/models/LedgerAccount");
const VendorWallet = require("../src/models/VendorWallet");
const financialService = require("../src/services/financial.service");
const financialController = require("../src/controllers/financial.controller");

// Helper to construct mock Express req & res
function createMockReqRes(options = {}) {
  const req = {
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    headers: options.headers || {},
    user: options.user || { role: "super_admin" },
  };

  const res = {
    statusCode: 200,
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    },
  };

  return { req, res };
}

describe("Financial Controller & Service Unit & Performance Tests", () => {
  // ─── 1. FUNCTIONALITY TESTS: getLedgerEntries ──────────────────────────────
  describe("getLedgerEntries() Functionality", () => {
    it("should retrieve paginated ledger entries sorted with populated accounts and order", async () => {
      const mockEntries = [
        {
          _id: new mongoose.Types.ObjectId(),
          transactionReference: "MVEC-TXN-1001",
          amount: 50000,
          entryType: "PAYMENT_ESCROW_LOCK",
          debitAccount: { accountNumber: "ACC-ESCROW-001" },
          creditAccount: { accountNumber: "ACC-VENDOR-123" },
          relatedOrder: { _id: new mongoose.Types.ObjectId() },
          createdAt: new Date("2026-09-01T10:00:00Z"),
        },
      ];

      const originalFind = LedgerEntry.find;
      const originalCount = LedgerEntry.countDocuments;

      LedgerEntry.find = function () {
        return {
          populate: function () {
            return {
              sort: function () {
                return {
                  skip: function () {
                    return {
                      limit: function () {
                        return {
                          lean: async function () {
                            return mockEntries;
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      };

      LedgerEntry.countDocuments = async function () {
        return 1;
      };

      try {
        const { req, res } = createMockReqRes({
          query: { page: "1", limit: "10" },
        });
        await financialController.getLedgerEntries(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.success, true);
        assert.equal(res.jsonData.total, 1);
        assert.equal(res.jsonData.page, 1);
        assert.equal(res.jsonData.totalPages, 1);
        assert.equal(res.jsonData.count, 1);
        assert.equal(res.jsonData.entries.length, 1);
        assert.equal(res.jsonData.entries[0].transactionReference, "MVEC-TXN-1001");
      } finally {
        LedgerEntry.find = originalFind;
        LedgerEntry.countDocuments = originalCount;
      }
    });

    it("should return 500 if database query fails", async () => {
      const originalFind = LedgerEntry.find;
      LedgerEntry.find = function () {
        return {
          populate: function () {
            return {
              sort: function () {
                return {
                  skip: function () {
                    return {
                      limit: function () {
                        return {
                          lean: async function () {
                            throw new Error("Database connection failure");
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      };

      try {
        const { req, res } = createMockReqRes();
        await financialController.getLedgerEntries(req, res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.jsonData.message, "Database connection failure");
      } finally {
        LedgerEntry.find = originalFind;
      }
    });
  });

  // ─── 2. FUNCTIONALITY TESTS: placeAdminHold ────────────────────────────────
  describe("placeAdminHold() Functionality", () => {
    it("should place a HELD settlement on ADMIN_HOLD with reason", async () => {
      const settlementId = new mongoose.Types.ObjectId();
      const mockSettlement = {
        _id: settlementId,
        status: "HELD",
        adminHoldReason: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Settlement.findById;
      Settlement.findById = async (id) => {
        if (id.toString() === settlementId.toString()) return mockSettlement;
        return null;
      };

      try {
        const { req, res } = createMockReqRes({
          params: { id: settlementId.toString() },
          body: { reason: "Suspicious activity reported by buyer" },
        });

        await financialController.placeAdminHold(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.message, "Settlement placed on administrative hold.");
        assert.equal(mockSettlement.status, "ADMIN_HOLD");
        assert.equal(mockSettlement.adminHoldReason, "Suspicious activity reported by buyer");
      } finally {
        Settlement.findById = originalFindById;
      }
    });

    it("should reject invalid ObjectId format with 400 Bad Request", async () => {
      const { req, res } = createMockReqRes({
        params: { id: "invalid-id-123" },
        body: { reason: "test" },
      });

      await financialController.placeAdminHold(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.message, "Invalid settlement ID format.");
    });

    it("should use default reason if no reason is provided in request body", async () => {
      const settlementId = new mongoose.Types.ObjectId();
      const mockSettlement = {
        _id: settlementId,
        status: "HELD",
        adminHoldReason: null,
        save: async function () {
          return this;
        },
      };

      const originalFindById = Settlement.findById;
      Settlement.findById = async () => mockSettlement;

      try {
        const { req, res } = createMockReqRes({
          params: { id: settlementId.toString() },
          body: {},
        });

        await financialController.placeAdminHold(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(mockSettlement.status, "ADMIN_HOLD");
        assert.equal(mockSettlement.adminHoldReason, "Administrative investigation pending");
      } finally {
        Settlement.findById = originalFindById;
      }
    });

    it("should return 404 when settlement is not found", async () => {
      const originalFindById = Settlement.findById;
      Settlement.findById = async () => null;

      try {
        const validId = new mongoose.Types.ObjectId().toString();
        const { req, res } = createMockReqRes({
          params: { id: validId },
          body: { reason: "test" },
        });

        await financialController.placeAdminHold(req, res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.jsonData.message, "Settlement not found.");
      } finally {
        Settlement.findById = originalFindById;
      }
    });

    it("should return 400 when settlement is not in HELD status (e.g. already RELEASED)", async () => {
      const mockSettlement = {
        _id: new mongoose.Types.ObjectId(),
        status: "RELEASED",
        save: async function () {
          return this;
        },
      };

      const originalFindById = Settlement.findById;
      Settlement.findById = async () => mockSettlement;

      try {
        const { req, res } = createMockReqRes({
          params: { id: mockSettlement._id.toString() },
          body: { reason: "test" },
        });

        await financialController.placeAdminHold(req, res);

        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("Cannot hold settlement with status: RELEASED"));
      } finally {
        Settlement.findById = originalFindById;
      }
    });
  });

  // ─── 3. FUNCTIONALITY TESTS: manualEscrowRelease ───────────────────────────
  describe("manualEscrowRelease() Functionality", () => {
    it("should reject invalid ObjectId format with 400 Bad Request", async () => {
      const { req, res } = createMockReqRes({
        params: { id: "invalid-id-xyz" },
      });

      await financialController.manualEscrowRelease(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.message, "Invalid settlement ID format.");
    });

    it("should successfully release escrow funds for a HELD settlement and commit transaction", async () => {
      const settlementId = new mongoose.Types.ObjectId().toString();
      const mockReleasedSettlement = {
        _id: settlementId,
        status: "RELEASED",
        grossAmount: 100000,
        netAmount: 90000,
        commissionAmount: 10000,
      };

      let transactionCommitted = false;
      let sessionEnded = false;

      const originalStartSession = mongoose.startSession;
      mongoose.startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {
          transactionCommitted = true;
        },
        abortTransaction: async () => {},
        endSession: () => {
          sessionEnded = true;
        },
      });

      const originalRelease = financialService.releaseEscrowToVendor;
      financialService.releaseEscrowToVendor = async ({ settlementId: id }) => {
        if (id === settlementId) return mockReleasedSettlement;
        throw new Error("Settlement not found");
      };

      try {
        const { req, res } = createMockReqRes({
          params: { id: settlementId },
        });

        await financialController.manualEscrowRelease(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.message, "Escrow funds manually released to vendor.");
        assert.equal(res.jsonData.settlement.status, "RELEASED");
        assert.equal(transactionCommitted, true, "Transaction should be committed");
        assert.equal(sessionEnded, true, "Session should be ended");
      } finally {
        mongoose.startSession = originalStartSession;
        financialService.releaseEscrowToVendor = originalRelease;
      }
    });

    it("should successfully release escrow funds for an ADMIN_HOLD settlement (admin override resolved)", async () => {
      const settlementId = new mongoose.Types.ObjectId();
      const vendorId = new mongoose.Types.ObjectId();
      const orderId = new mongoose.Types.ObjectId();

      const mockSettlement = {
        _id: settlementId,
        settlementReference: "MVEC-SETTLE-HOLD-1",
        order: orderId,
        vendor: vendorId,
        grossAmount: 100000,
        netAmount: 90000,
        commissionAmount: 10000,
        status: "ADMIN_HOLD",
        releasedAt: null,
        save: async function () {
          return this;
        },
      };

      const mockEscrow = {
        accountType: "ESCROW_HOLDING",
        balance: 100000,
        save: async function () {
          return this;
        },
      };

      const mockVendor = {
        accountType: "VENDOR_PAYABLE",
        balance: 0,
        save: async function () {
          return this;
        },
      };

      const mockPlatform = {
        accountType: "PLATFORM_REVENUE",
        balance: 0,
        save: async function () {
          return this;
        },
      };

      const origSettlementFindById = Settlement.findById;
      const origLedgerAccountFindOne = LedgerAccount.findOne;
      const origLedgerEntryCreate = LedgerEntry.create;
      const origVendorWalletFindOneAndUpdate = VendorWallet.findOneAndUpdate;

      Settlement.findById = () => ({
        session: () => mockSettlement,
      });

      LedgerAccount.findOne = ({ accountType }) => ({
        session: () => {
          if (accountType === "ESCROW_HOLDING") return mockEscrow;
          if (accountType === "VENDOR_PAYABLE") return mockVendor;
          if (accountType === "PLATFORM_REVENUE") return mockPlatform;
          return null;
        },
      });

      LedgerEntry.create = async () => [];
      VendorWallet.findOneAndUpdate = async () => ({});

      try {
        const released = await financialService.releaseEscrowToVendor({
          settlementId: settlementId.toString(),
          session: {},
        });

        assert.equal(released.status, "RELEASED");
        assert.ok(released.releasedAt instanceof Date);
        assert.equal(mockEscrow.balance, 0, "Escrow balance should be reduced by grossAmount");
        assert.equal(mockVendor.balance, 90000, "Vendor balance should be credited netAmount");
        assert.equal(mockPlatform.balance, 10000, "Platform balance should be credited commissionAmount");
      } finally {
        Settlement.findById = origSettlementFindById;
        LedgerAccount.findOne = origLedgerAccountFindOne;
        LedgerEntry.create = origLedgerEntryCreate;
        VendorWallet.findOneAndUpdate = origVendorWalletFindOneAndUpdate;
      }
    });

    it("should abort transaction and return 400 when release service fails on business rule", async () => {
      let transactionAborted = false;
      let sessionEnded = false;

      const originalStartSession = mongoose.startSession;
      mongoose.startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {},
        abortTransaction: async () => {
          transactionAborted = true;
        },
        endSession: () => {
          sessionEnded = true;
        },
      });

      const originalRelease = financialService.releaseEscrowToVendor;
      financialService.releaseEscrowToVendor = async () => {
        throw new Error("Settlement is not eligible for release with status: CANCELLED");
      };

      try {
        const { req, res } = createMockReqRes({
          params: { id: new mongoose.Types.ObjectId().toString() },
        });

        await financialController.manualEscrowRelease(req, res);

        assert.equal(transactionAborted, true, "Transaction must be aborted on failure");
        assert.equal(sessionEnded, true, "Session must be ended");
        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("not eligible"));
      } finally {
        mongoose.startSession = originalStartSession;
        financialService.releaseEscrowToVendor = originalRelease;
      }
    });
  });

  // ─── 4. PERFORMANCE & BENCHMARK TESTS ─────────────────────────────────────
  describe("Performance & Load Benchmarking", () => {
    it("should benchmark getLedgerEntries handling 1,000 entries within 50ms", async () => {
      const mockEntries = Array.from({ length: 1000 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(),
        transactionReference: `MVEC-TXN-PERF-${i}`,
        debitAccount: { accountNumber: "ACC-ESCROW-001" },
        creditAccount: { accountNumber: `ACC-VENDOR-${i % 10}` },
        amount: (i + 1) * 1000,
        entryType: i % 2 === 0 ? "PAYMENT_ESCROW_LOCK" : "ESCROW_RELEASE_VENDOR",
        relatedOrder: { _id: new mongoose.Types.ObjectId() },
        createdAt: new Date(Date.now() - i * 60000),
      }));

      const originalFind = LedgerEntry.find;
      const originalCount = LedgerEntry.countDocuments;

      LedgerEntry.find = function () {
        return {
          populate: function () {
            return {
              sort: function () {
                return {
                  skip: function () {
                    return {
                      limit: function () {
                        return {
                          lean: async function () {
                            return mockEntries;
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      };

      LedgerEntry.countDocuments = async function () {
        return 1000;
      };

      try {
        const startTime = process.hrtime.bigint();
        const { req, res } = createMockReqRes();
        await financialController.getLedgerEntries(req, res);
        const endTime = process.hrtime.bigint();

        const durationMs = Number(endTime - startTime) / 1e6;

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonData.count, 1000);
        assert.ok(durationMs < 50, `getLedgerEntries took ${durationMs}ms (expected < 50ms)`);
      } finally {
        LedgerEntry.find = originalFind;
        LedgerEntry.countDocuments = originalCount;
      }
    });

    it("should handle high concurrent throughput for placeAdminHold (500 concurrent operations)", async () => {
      const originalFindById = Settlement.findById;
      Settlement.findById = async (id) => ({
        _id: id,
        status: "HELD",
        adminHoldReason: null,
        save: async function () {
          return this;
        },
      });

      try {
        const CONCURRENT_OPS = 500;
        const startTime = process.hrtime.bigint();

        const promises = Array.from({ length: CONCURRENT_OPS }, (_, i) => {
          const { req, res } = createMockReqRes({
            params: { id: new mongoose.Types.ObjectId().toString() },
            body: { reason: `Concurrent hold batch ${i}` },
          });
          return financialController.placeAdminHold(req, res);
        });

        await Promise.all(promises);
        const endTime = process.hrtime.bigint();

        const totalMs = Number(endTime - startTime) / 1e6;
        const opsPerSec = (CONCURRENT_OPS / totalMs) * 1000;

        assert.ok(totalMs < 500, `500 concurrent holds took ${totalMs}ms (expected < 500ms)`);
        assert.ok(opsPerSec > 1000, `Throughput was ${opsPerSec.toFixed(0)} ops/sec (expected > 1000 ops/sec)`);
      } finally {
        Settlement.findById = originalFindById;
      }
    });

    it("should handle high concurrent throughput for manualEscrowRelease (500 concurrent operations)", async () => {
      const originalStartSession = mongoose.startSession;
      mongoose.startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {},
        abortTransaction: async () => {},
        endSession: () => {},
      });

      const originalRelease = financialService.releaseEscrowToVendor;
      financialService.releaseEscrowToVendor = async ({ settlementId }) => ({
        _id: settlementId,
        status: "RELEASED",
      });

      try {
        const CONCURRENT_OPS = 500;
        const startTime = process.hrtime.bigint();

        const promises = Array.from({ length: CONCURRENT_OPS }, (_, i) => {
          const { req, res } = createMockReqRes({
            params: { id: new mongoose.Types.ObjectId().toString() },
          });
          return financialController.manualEscrowRelease(req, res);
        });

        await Promise.all(promises);
        const endTime = process.hrtime.bigint();

        const totalMs = Number(endTime - startTime) / 1e6;
        const opsPerSec = (CONCURRENT_OPS / totalMs) * 1000;

        assert.ok(totalMs < 500, `500 concurrent releases took ${totalMs}ms (expected < 500ms)`);
        assert.ok(opsPerSec > 1000, `Throughput was ${opsPerSec.toFixed(0)} ops/sec (expected > 1000 ops/sec)`);
      } finally {
        mongoose.startSession = originalStartSession;
        financialService.releaseEscrowToVendor = originalRelease;
      }
    });
  });
});
