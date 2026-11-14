const {
  isConfigured,
  getBaseUrl,
  getAuthHeaders,
  isSandbox,
  SANDBOX_OTP
} = require('../config/cashfree');

/** Official Cashfree Offline Aadhaar OTP lifetime */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Cashfree send-OTP cooldown for the same Aadhaar (409) */
const RESEND_COOLDOWN_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST to Cashfree Verification Suite.
 * Never logs request body (may contain OTP / Aadhaar).
 */
async function cashfreeFetch(path, body, { timeoutMs = 25000 } = {}) {
  if (!isConfigured()) {
    const err = new Error('Cashfree credentials not configured');
    err.code = 'cashfree_not_configured';
    err.status = 503;
    throw err;
  }

  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    let json = {};
    try {
      json = await res.json();
    } catch (_) {
      json = {};
    }

    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
      return {
        ok: false,
        status: 504,
        json: {
          type: 'timeout_error',
          code: 'network_timeout',
          message: 'Cashfree request timed out'
        }
      };
    }
    return {
      ok: false,
      status: 503,
      json: {
        type: 'network_error',
        code: 'network_error',
        message: err.message || 'Network error talking to Cashfree'
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Safe log payload — strip OTP and full Aadhaar */
function safeCashfreeBody(json) {
  if (!json || typeof json !== 'object') return json;
  const clone = { ...json };
  if (clone.otp != null) clone.otp = '[redacted]';
  if (clone.aadhaar_number != null) {
    const digits = String(clone.aadhaar_number).replace(/\D/g, '');
    clone.aadhaar_number = digits.length >= 4 ? `****${digits.slice(-4)}` : '[redacted]';
  }
  if (clone.photo_link) clone.photo_link = '[omitted]';
  if (clone.xml_file) clone.xml_file = '[omitted]';
  return clone;
}

function mapCashfreeError(status, json, { operation = 'verify' } = {}) {
  const msg = String((json && json.message) || '');
  const code = String((json && json.code) || '');
  const type = String((json && json.type) || '');

  if (status === 403 || /ip not whitelisted|ip_validation_failed/i.test(msg) || code === 'ip_validation_failed') {
    return {
      success: false,
      status: 'IP_BLOCKED',
      message:
        msg ||
        'Cashfree blocked this server IP. Whitelist the server IP in Cashfree Secure ID → IP whitelisting.',
      cashfree: json
    };
  }
  if (status === 401 || code === 'authentication_failed') {
    return {
      success: false,
      status: 'AUTH_FAILED',
      message: msg || 'Invalid Cashfree client id / secret',
      cashfree: json
    };
  }
  if (status === 429 || /rate_limit|too_many_requests/i.test(type) || /rate limit/i.test(msg)) {
    return {
      success: false,
      status: 'RATE_LIMITED',
      message: msg || 'Too many KYC requests. Please wait a minute and try again.',
      cashfree: json,
      retryAfterMs: 60 * 1000
    };
  }
  if (status === 422 || code === 'insufficient_balance') {
    return {
      success: false,
      status: 'INSUFFICIENT_BALANCE',
      message: msg || 'Cashfree verification wallet has insufficient balance.',
      cashfree: json
    };
  }
  // 409 semantics differ by operation (Cashfree docs)
  if (status === 409 || code === 'verification_pending') {
    if (
      operation === 'send' ||
      /otp generated for this aadhaar/i.test(msg)
    ) {
      return {
        success: false,
        status: 'RESEND_COOLDOWN',
        message: msg || 'OTP was just sent for this Aadhaar. Wait about 30 seconds before requesting another.',
        cashfree: json,
        retryAfterMs: RESEND_COOLDOWN_MS
      };
    }
    // Verify: still processing a prior attempt — keep same OTP/ref
    return {
      success: false,
      status: 'VERIFICATION_PENDING',
      message: msg || 'Verification is still processing. Wait about 30 seconds, then tap Verify again with the same OTP.',
      cashfree: json,
      retryAfterMs: 30 * 1000
    };
  }
  if (/processing request|try after 30/i.test(msg)) {
    return {
      success: false,
      status: 'VERIFICATION_PENDING',
      message: msg || 'Verification is still processing. Wait about 30 seconds, then tap Verify again with the same OTP.',
      cashfree: json,
      retryAfterMs: 30 * 1000
    };
  }
  if (/otp expired/i.test(msg)) {
    return {
      success: false,
      status: 'OTP_EXPIRED',
      message: 'OTP expired. Tap Send OTP again and enter the new code.',
      cashfree: json
    };
  }
  if (/session expired|generate a new otp|invalid reference/i.test(msg)) {
    return {
      success: false,
      status: 'SESSION_EXPIRED',
      message: 'OTP session expired. Tap Send OTP again and enter the new code.',
      cashfree: json
    };
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /temporarily unavailable|authorised source|try again shortly|unable to validate|please retry later|network_timeout|network_error/i.test(
      msg
    ) ||
    /internal_error/i.test(type) ||
    (code === 'verification_failed' && /unavailable|retry later|shortly/i.test(msg)) ||
    code === 'network_timeout' ||
    code === 'network_error' ||
    code === 'api_error'
  ) {
    return {
      success: false,
      status: 'TEMPORARILY_UNAVAILABLE',
      message:
        'Aadhaar verification service is temporarily unavailable. Wait a few seconds, then tap Verify again with the same OTP. Do not request a new OTP unless Verify keeps failing.',
      cashfree: json,
      // Outcome uncertain — client may retry the same ref_id + OTP
      uncertain: true
    };
  }
  if (/invalid otp|incorrect otp|wrong otp|otp entered is invalid/i.test(msg) || code === 'otp_invalid') {
    return {
      success: false,
      status: 'INVALID_OTP',
      message: msg || 'Incorrect OTP. Check the SMS and try again.',
      cashfree: json
    };
  }
  if (/aadhaar not linked to mobile/i.test(msg)) {
    return {
      success: false,
      status: 'MOBILE_NOT_LINKED',
      message: msg || 'This Aadhaar is not linked to a mobile number.',
      cashfree: json
    };
  }
  if (/invalid aadhaar/i.test(msg) || code === 'aadhaar_invalid') {
    return {
      success: false,
      status: 'INVALID_AADHAAR',
      message: msg || 'Invalid Aadhaar number.',
      cashfree: json
    };
  }
  if (status === 404 || /something went wrong/i.test(msg)) {
    return {
      success: false,
      status: 'UNAVAILABLE',
      message: isSandbox()
        ? (msg || 'Cashfree Aadhaar OTP failed. Check sandbox keys + IP whitelist.')
        : (msg || 'Cashfree Aadhaar verification is unavailable right now. Please try again.'),
      cashfree: json
    };
  }
  return {
    success: false,
    status: (json && json.status) || code || 'FAILED',
    message: msg || (operation === 'send' ? 'Failed to send Aadhaar OTP' : 'Aadhaar OTP verification failed'),
    cashfree: json
  };
}

/**
 * Generate OTP for Aadhaar OKYC via Cashfree (no local mock).
 * Sandbox test Aadhaar: 655675523712 / 655675523711, OTP: 111000
 * OTP validity: 10 minutes (Cashfree docs).
 */
async function sendAadhaarOtp(aadhaarNumber) {
  const aadhaar = String(aadhaarNumber || '').replace(/\D/g, '');
  if (aadhaar.length !== 12) {
    return {
      success: false,
      status: 'INVALID',
      message: 'Aadhaar number must be 12 digits'
    };
  }

  const { ok, status, json } = await cashfreeFetch('/offline-aadhaar/otp', {
    aadhaar_number: aadhaar
  });

  console.log(
    `🪪 [CASHFREE] send-otp status=${status} body=${JSON.stringify(safeCashfreeBody(json))}`
  );

  // Cashfree can return HTTP 200 with status INVALID / mobile-not-linked
  if (ok && String(json.status || '').toUpperCase() === 'INVALID') {
    return mapCashfreeError(400, json, { operation: 'send' });
  }
  if (ok && /aadhaar not linked to mobile/i.test(String(json.message || ''))) {
    return {
      success: false,
      status: 'MOBILE_NOT_LINKED',
      message: json.message || 'Aadhaar not linked to mobile number',
      cashfree: json
    };
  }

  if (ok && (json.status === 'SUCCESS' || json.ref_id || json.reference_id)) {
    const refId = String(json.ref_id || json.reference_id || '');
    if (!refId) {
      return {
        success: false,
        status: 'INVALID_REF',
        message: 'Cashfree did not return a reference id for this OTP session.'
      };
    }
    return {
      success: true,
      status: 'SUCCESS',
      message: json.message || 'OTP sent successfully',
      refId,
      expiresInMs: OTP_TTL_MS,
      source: 'cashfree',
      testHint: isSandbox() ? `Sandbox OTP is ${SANDBOX_OTP}` : null
    };
  }

  return mapCashfreeError(status, json, { operation: 'send' });
}

function isVerifySuccess(json) {
  return !!(
    json &&
    (json.status === 'VALID' ||
      json.status === 'SUCCESS' ||
      json.message === 'Aadhaar Card Exists' ||
      json.name ||
      json.care_of ||
      json.full_name)
  );
}

/**
 * Verify OTP against Cashfree Offline Aadhaar API.
 *
 * IMPORTANT: Do NOT auto-retry verify after 502/503.
 * Cashfree OTP verify is not safely idempotent — a blind retry after
 * "Authorised source temporarily unavailable" often returns SESSION_EXPIRED
 * and burns the user's OTP session. Return TEMPORARILY_UNAVAILABLE so the
 * client can retry the same OTP + ref_id after a short wait.
 */
async function verifyAadhaarOtp({ refId, otp, aadhaarNumber }) {
  const cleanOtp = String(otp || '').replace(/\D/g, '');
  const reference = String(refId || '').trim();
  const aadhaar = String(aadhaarNumber || '').replace(/\D/g, '');

  if (!reference) {
    return { success: false, status: 'INVALID_REF', message: 'reference_id / ref_id is required' };
  }
  if (cleanOtp.length < 4) {
    return { success: false, status: 'INVALID_OTP', message: 'Valid OTP is required' };
  }

  // Cashfree schema requires BOTH as strings — numeric ref_id returns "Bad request"
  const body = {
    otp: String(cleanOtp),
    ref_id: String(reference)
  };

  const { ok, status, json } = await cashfreeFetch('/offline-aadhaar/verify', body);
  // Never log OTP — only status + safe response fields
  console.log(
    `🪪 [CASHFREE] verify-otp ref=${reference} status=${status} body=${JSON.stringify(safeCashfreeBody(json))}`
  );

  if (ok && isVerifySuccess(json)) {
    return {
      success: true,
      status: 'VALID',
      message: json.message || 'Aadhaar verified successfully',
      source: 'cashfree',
      data: {
        refId: String(json.ref_id || json.reference_id || reference),
        aadhaarLast4: aadhaar.slice(-4) || String(json.aadhaar_number || '').slice(-4),
        name: json.name || json.full_name || '',
        dob: json.dob || json.date_of_birth || json.DOB || json.Dob || '',
        yearOfBirth: json.year_of_birth || json.yob || json.yearOfBirth || '',
        gender: json.gender || '',
        address: json.address || (json.split_address && json.split_address.address) || '',
        careOf: json.care_of || json.careOf || '',
        photo: ''
      }
    };
  }

  return mapCashfreeError(status, json, { operation: 'verify' });
}

module.exports = {
  sendAadhaarOtp,
  verifyAadhaarOtp,
  mapCashfreeError,
  safeCashfreeBody,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  SANDBOX_OTP,
  // exported for unit tests
  _internals: { cashfreeFetch, isVerifySuccess, sleep }
};
