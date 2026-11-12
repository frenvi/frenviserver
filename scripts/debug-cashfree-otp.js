require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getBaseUrl, getAuthHeaders, isConfigured } = require('../src/config/cashfree');

async function main() {
  console.log('configured', isConfigured());
  console.log('base', getBaseUrl());
  console.log('env', process.env.CASHFREE_ENV);
  const res = await fetch(`${getBaseUrl()}/offline-aadhaar/otp`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ aadhaar_number: '655675523712' })
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log('body', text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
