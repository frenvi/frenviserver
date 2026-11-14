/**
 * Smoke-test Cashfree Aadhaar OKYC via Frenvi KYC routes (or direct service).
 * Usage: node scripts/test-kyc-cashfree.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { sendAadhaarOtp, verifyAadhaarOtp, SANDBOX_OTP } = require('../src/services/cashfreeAadhaar');
const { isConfigured, getBaseUrl } = require('../src/config/cashfree');

async function main() {
  console.log('Cashfree configured:', isConfigured());
  console.log('Base URL:', getBaseUrl());
  console.log('--- Send OTP (test Aadhaar 655675523712) ---');
  const sent = await sendAadhaarOtp('655675523712');
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.success) {
    process.exitCode = 1;
    return;
  }
  console.log('--- Verify OTP ---');
  const verified = await verifyAadhaarOtp({
    refId: sent.refId,
    otp: SANDBOX_OTP,
    aadhaarNumber: '655675523712'
  });
  console.log(JSON.stringify(verified, null, 2));
  process.exitCode = verified.success ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
