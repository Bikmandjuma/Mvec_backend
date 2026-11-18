"use strict";

// Buyers see a seller's products only once Ikiguzi has approved the seller
// (services/listingApproval.service.js). Live products of sellers not yet
// approved wait as PENDING_APPROVAL; approving the seller puts them back.
const NOT_APPROVED = `
  SELECT userId FROM vendors WHERE verificationStatus <> 'VERIFIED'
  UNION SELECT userId FROM suppliers WHERE verificationStatus <> 'VERIFIED'`;
const APPROVED = `
  SELECT userId FROM vendors WHERE verificationStatus = 'VERIFIED'
  UNION SELECT userId FROM suppliers WHERE verificationStatus = 'VERIFIED'`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE products SET status = 'PENDING_APPROVAL'
      WHERE status IN ('ACTIVE', 'OUT_OF_STOCK')
        AND vendorId IN (${NOT_APPROVED})
        AND vendorId NOT IN (${APPROVED})`);
  },

  // Nothing to undo safely: approving a seller puts their products live again.
  async down() {},
};
