/**
 * Unit tests for Cashfree Aadhaar OTP verify retry semantics.
 * Mocks global fetch — no live Cashfree calls.
 *
 * Usage: node scripts/test-kyc-verify-retry.js
 */
const assert = require('assert');
const path = require('path');

// Ensure module can load without real credentials
process.env.CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || 'test_client_id';
process.env.CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || 'test_client_secret';
process.env.CASHFREE_ENV = 'sandbox';

// Fresh require each run
const servicePath = path.join(__dirname, '../src/services/cashfreeAadhaar.js');
delete require.cache[require.resolve(servicePath)];
const { verifyAadhaarOtp, sendAadhaarOtp, mapCashfreeError } = require(servicePath);

let fetchCalls = [];
const originalFetch = global.fetch;

function mockFetchSequence(responses) {
  fetchCalls = [];
  let i = 0;
  global.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    fetchCalls.push({ url: String(url), body });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json
    };
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function testNoAutoRetryOn502() {
  mockFetchSequence([
    {
      status: 502,
      json: {
        type: 'internal_error',
        code: 'verification_failed',
        message: 'Authorised source is temporarily unavailable, please try again shortly',
        error: { refId: '88556236' }
      }
    },
    // If code wrongly retries, this would be hit and return SESSION_EXPIRED
    {
      status: 400,
      json: {
        type: 'validation_error',
        code: 'verification_failed',
        message: 'Session expired, please generate a new OTP',
        error: { refId: '88556236' }
      }
    }
  ]);

  const result = await verifyAadhaarOtp({
    refId: '88556236',
    otp: '123456',
    aadhaarNumber: '655675523712'
  });

  assert.strictEqual(fetchCalls.length, 1, 'verify must NOT auto-retry after 502');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.status, 'TEMPORARILY_UNAVAILABLE');
  assert.strictEqual(result.uncertain, true);
  assert.ok(!/session expired/i.test(result.message));
  console.log('✅ no auto-retry on 502');
}

async function testInvalidOtpNoRetry() {
  mockFetchSequence([
    {
      status: 400,
      json: {
        type: 'validation_error',
        code: 'verification_failed',
        message: 'OTP entered is invalid',
        error: null,
        refId: 210
      }
    }
  ]);

  const result = await verifyAadhaarOtp({
    refId: '88556236',
    otp: '000000',
    aadhaarNumber: '655675523712'
  });

  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(result.status, 'INVALID_OTP');
  console.log('✅ invalid OTP mapped correctly');
}

async function testSessionExpired() {
  mockFetchSequence([
    {
      status: 400,
      json: {
        type: 'validation_error',
        code: 'verification_failed',
        message: 'Session expired, please generate a new OTP',
        error: { refId: '88556236' }
      }
    }
  ]);

  const result = await verifyAadhaarOtp({
    refId: '88556236',
    otp: '111000',
    aadhaarNumber: '655675523712'
  });

  assert.strictEqual(result.status, 'SESSION_EXPIRED');
  console.log('✅ session expired mapped correctly');
}

async function testVerifySuccess() {
  mockFetchSequence([
    {
      status: 200,
      json: {
        ref_id: '88556236',
        status: 'VALID',
        message: 'Aadhaar Card Exists',
        name: 'Test User',
        dob: '01-01-1995',
        gender: 'M',
        year_of_birth: 1995,
        address: 'Hyderabad'
      }
    }
  ]);

  const result = await verifyAadhaarOtp({
    refId: '88556236',
    otp: '111000',
    aadhaarNumber: '655675523712'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.name, 'Test User');
  assert.strictEqual(result.data.refId, '88556236');
  // OTP must be sent as string
  assert.strictEqual(typeof fetchCalls[0].body.otp, 'string');
  assert.strictEqual(typeof fetchCalls[0].body.ref_id, 'string');
  console.log('✅ successful verify payload/shape');
}

async function testVerificationPending409() {
  mockFetchSequence([
    {
      status: 409,
      json: {
        type: 'validation_error',
        code: 'verification_pending',
        message: 'Processing request, please try after 30 sec'
      }
    }
  ]);

  const result = await verifyAadhaarOtp({
    refId: '88556236',
    otp: '111000',
    aadhaarNumber: '655675523712'
  });

  assert.strictEqual(result.status, 'VERIFICATION_PENDING');
  assert.strictEqual(result.retryAfterMs, 30000);
  console.log('✅ verification_pending (409) mapped correctly');
}

async function testSendOtpSuccess() {
  mockFetchSequence([
    {
      status: 200,
      json: {
        status: 'SUCCESS',
        message: 'OTP sent successfully',
        ref_id: '88556236'
      }
    }
  ]);

  const result = await sendAadhaarOtp('655675523712');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.refId, '88556236');
  assert.ok(result.expiresInMs >= 10 * 60 * 1000);
  console.log('✅ send OTP success');
}

async function testSendOtpIpBlocked() {
  mockFetchSequence([
    {
      status: 403,
      json: {
        type: 'authentication_error',
        code: 'ip_validation_failed',
        message: 'IP not whitelisted your current ip is 1.2.3.4'
      }
    }
  ]);

  const result = await sendAadhaarOtp('655675523712');
  assert.strictEqual(result.status, 'IP_BLOCKED');
  console.log('✅ send OTP IP_BLOCKED (explains intermittent 403)');
}

function testMapDoesNotTreat502AsSessionExpired() {
  const mapped = mapCashfreeError(502, {
    type: 'internal_error',
    code: 'verification_failed',
    message: 'Authorised source is temporarily unavailable, please try again shortly',
    error: { refId: '88556236' }
  });
  assert.strictEqual(mapped.status, 'TEMPORARILY_UNAVAILABLE');
  console.log('✅ 502 maps to TEMPORARILY_UNAVAILABLE not SESSION_EXPIRED');
}

async function main() {
  try {
    await testNoAutoRetryOn502();
    await testInvalidOtpNoRetry();
    await testSessionExpired();
    await testVerifySuccess();
    await testVerificationPending409();
    await testSendOtpSuccess();
    await testSendOtpIpBlocked();
    testMapDoesNotTreat502AsSessionExpired();
    console.log('\nAll KYC verify-retry tests passed.');
  } catch (err) {
    console.error('\nTest failed:', err);
    process.exitCode = 1;
  } finally {
    restoreFetch();
  }
}

main();
