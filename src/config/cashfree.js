/**
 * Cashfree Secure ID (Verification Suite) — sandbox / production config
 */
function isConfigured() {
  const id = process.env.CASHFREE_CLIENT_ID || '';
  const secret = process.env.CASHFREE_CLIENT_SECRET || '';
  return Boolean(
    id &&
      secret &&
      id !== 'YOUR_CASHFREE_CLIENT_ID' &&
      secret !== 'YOUR_CASHFREE_CLIENT_SECRET'
  );
}

function getBaseUrl() {
  if (process.env.CASHFREE_BASE_URL) return process.env.CASHFREE_BASE_URL.replace(/\/$/, '');
  const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
  if (env === 'production' || env === 'prod') {
    return 'https://api.cashfree.com/verification';
  }
  return 'https://sandbox.cashfree.com/verification';
}

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-client-id': process.env.CASHFREE_CLIENT_ID || '',
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET || ''
  };
}

function isSandbox() {
  return !String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase().match(/^(prod|production)$/);
}

/** Cashfree sandbox test Aadhaar numbers (OKYC legacy) */
const SANDBOX_VALID_AADHAAR = new Set(['655675523712', '655675523711']);
const SANDBOX_INVALID_AADHAAR = new Set(['655675523710', '655675523709']);
/** Standard OTP for Cashfree TEST OTP flows (legacy OKYC) */
const SANDBOX_OTP = '111000';

/** Minimum age for work eligibility (DigiLocker / KYC) */
function getMinAge() {
  const n = Number(process.env.KYC_MIN_AGE || 18);
  return Number.isFinite(n) && n > 0 ? n : 18;
}

/**
 * Public HTTPS origin for DigiLocker redirect_url + webhooks.
 * Example: https://api.yourdomain.com
 */
function getPublicApiOrigin() {
  const raw = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_URL || '').replace(
    /\/$/,
    ''
  );
  if (/^https:\/\//i.test(raw)) return raw;
  return '';
}

module.exports = {
  isConfigured,
  getBaseUrl,
  getAuthHeaders,
  isSandbox,
  getMinAge,
  getPublicApiOrigin,
  SANDBOX_VALID_AADHAAR,
  SANDBOX_INVALID_AADHAAR,
  SANDBOX_OTP
};
