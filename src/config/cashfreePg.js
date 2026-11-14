/**
 * Cashfree Payment Gateway (wallet top-up checkout)
 */
function isPgConfigured() {
  const id = process.env.CASHFREE_PG_CLIENT_ID || process.env.CASHFREE_CLIENT_ID || '';
  const secret =
    process.env.CASHFREE_PG_CLIENT_SECRET || process.env.CASHFREE_CLIENT_SECRET || '';
  return Boolean(
    id &&
      secret &&
      id !== 'YOUR_CASHFREE_CLIENT_ID' &&
      secret !== 'YOUR_CASHFREE_CLIENT_SECRET'
  );
}

function getPgBaseUrl() {
  if (process.env.CASHFREE_PG_BASE_URL) {
    return String(process.env.CASHFREE_PG_BASE_URL).replace(/\/$/, '');
  }
  const env = String(process.env.CASHFREE_PG_ENV || process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
  if (env === 'production' || env === 'prod') {
    return 'https://api.cashfree.com/pg';
  }
  return 'https://sandbox.cashfree.com/pg';
}

function getPgMode() {
  const env = String(process.env.CASHFREE_PG_ENV || process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
  return env === 'production' || env === 'prod' ? 'production' : 'sandbox';
}

function getPgAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-version': process.env.CASHFREE_PG_API_VERSION || '2023-08-01',
    'x-client-id':
      process.env.CASHFREE_PG_CLIENT_ID || process.env.CASHFREE_CLIENT_ID || '',
    'x-client-secret':
      process.env.CASHFREE_PG_CLIENT_SECRET || process.env.CASHFREE_CLIENT_SECRET || ''
  };
}

/**
 * Temporary wallet credit when Cashfree PG live transactions are not enabled yet.
 * Must be explicitly enabled via ALLOW_DEV_WALLET_CREDIT=true.
 */
function isDevWalletCreditAllowed() {
  return String(process.env.ALLOW_DEV_WALLET_CREDIT || '').toLowerCase() === 'true';
}

function getPublicReturnUrl() {
  const raw = String(
    process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE || ''
  ).replace(/\/$/, '');
  if (/^https:\/\//i.test(raw)) {
    return `${raw}/api/users/wallet/topup/return?order_id={order_id}`;
  }
  // Cashfree requires https return_url. The Android WebView intercepts this path and
  // confirms the top-up in-app (does not need the domain to resolve publicly).
  const custom = String(process.env.CASHFREE_PG_RETURN_URL || '').trim();
  if (/^https:\/\//i.test(custom)) {
    return custom.includes('{order_id}')
      ? custom
      : `${custom.replace(/\/$/, '')}?order_id={order_id}`;
  }
  return 'https://frenvi.co/wallet-topup-return?order_id={order_id}';
}

module.exports = {
  isPgConfigured,
  getPgBaseUrl,
  getPgMode,
  getPgAuthHeaders,
  isDevWalletCreditAllowed,
  getPublicReturnUrl
};
