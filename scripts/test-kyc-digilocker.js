/**
 * Unit tests for DigiLocker helpers (mocked fetch — no live Cashfree).
 * Usage: node scripts/test-kyc-digilocker.js
 */
process.env.CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || 'test_client_id';
process.env.CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || 'test_client_secret';
process.env.CASHFREE_ENV = 'sandbox';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const servicePath = path.join(__dirname, '../src/services/cashfreeDigilocker.js');
delete require.cache[require.resolve(servicePath)];
const {
  createDigilockerUrl,
  getDigilockerStatus,
  getDigilockerDocument,
  verifyWebhookSignature,
  mapCashfreeStatusToInternal,
  normalizeDocuments,
  makeVerificationId
} = require(servicePath);

const originalFetch = global.fetch;
let fetchCalls = [];

function mockFetch(handler) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    return handler(String(url), opts);
  };
}

function restore() {
  global.fetch = originalFetch;
}

async function testCreateUrl() {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      verification_id: 'frenvi_dl_test',
      reference_id: 99,
      url: 'https://verification-test.cashfree.com/dgl/abc',
      status: 'PENDING',
      document_requested: ['AADHAAR', 'PAN', 'DRIVING_LICENSE']
    })
  }));

  const result = await createDigilockerUrl({
    verificationId: 'frenvi_dl_test',
    documents: ['AADHAAR', 'PAN', 'DRIVING_LICENSE'],
    userFlow: 'signup'
  });
  assert.strictEqual(result.success, true);
  assert.ok(result.url.includes('dgl'));
  assert.strictEqual(fetchCalls[0].method, 'POST');
  console.log('✅ create DigiLocker URL');
}

async function testGetStatusAuthenticated() {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'AUTHENTICATED',
      verification_id: 'frenvi_dl_test',
      reference_id: 99,
      document_consent: ['AADHAAR'],
      user_details: { name: 'Test', dob: '01-01-1995' }
    })
  }));
  const result = await getDigilockerStatus({ verificationId: 'frenvi_dl_test' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.cashfreeStatus, 'AUTHENTICATED');
  assert.deepStrictEqual(result.documentConsent, ['AADHAAR']);
  console.log('✅ get DigiLocker status');
}

async function testGetAadhaarDoc() {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'SUCCESS',
      name: 'Test User',
      dob: '02-02-1995',
      gender: 'M',
      uid: 'xxxxxxxx1234',
      split_address: { dist: 'Hyd', state: 'TG', country: 'India' }
    })
  }));
  const result = await getDigilockerDocument({
    documentType: 'AADHAAR',
    verificationId: 'frenvi_dl_test'
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.name, 'Test User');
  assert.strictEqual(result.data.documentLast4, '1234');
  console.log('✅ get Aadhaar document');
}

function testWebhookSignature() {
  const raw = '{"event_type":"DIGILOCKER_VERIFICATION_SUCCESS"}';
  const ts = '1746427759733';
  const expected = crypto
    .createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
    .update(ts + raw)
    .digest('base64');
  assert.strictEqual(verifyWebhookSignature(raw, ts, expected), true);
  assert.strictEqual(verifyWebhookSignature(raw, ts, 'bad'), false);
  console.log('✅ webhook signature verify');
}

function testStatusMapping() {
  assert.strictEqual(mapCashfreeStatusToInternal('AUTHENTICATED'), 'AUTHORIZED');
  assert.strictEqual(mapCashfreeStatusToInternal('CONSENT_DENIED'), 'CANCELLED');
  assert.strictEqual(mapCashfreeStatusToInternal('EXPIRED'), 'EXPIRED');
  console.log('✅ status mapping');
}

function testNormalizeDocs() {
  assert.deepStrictEqual(normalizeDocuments(['aadhaar', 'PAN', 'FAKE']), ['AADHAAR', 'PAN']);
  assert.ok(makeVerificationId('frenvi_dl').startsWith('frenvi_dl'));
  console.log('✅ document normalize + verification id');
}

async function main() {
  try {
    await testCreateUrl();
    await testGetStatusAuthenticated();
    await testGetAadhaarDoc();
    testWebhookSignature();
    testStatusMapping();
    testNormalizeDocs();
    console.log('\nAll DigiLocker unit tests passed.');
  } catch (err) {
    console.error('\nTest failed:', err);
    process.exitCode = 1;
  } finally {
    restore();
  }
}

main();
