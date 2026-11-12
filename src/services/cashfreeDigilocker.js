const crypto = require('crypto');
const {
  isConfigured,
  getBaseUrl,
  getAuthHeaders,
  isSandbox
} = require('../config/cashfree');

const SUPPORTED_DOCUMENTS = ['AADHAAR', 'PAN', 'DRIVING_LICENSE'];
/** Prefer Aadhaar for age/identity, then PAN, then DL */
const DOC_PRIORITY = ['AADHAAR', 'PAN', 'DRIVING_LICENSE'];
const URL_TTL_MS = 10 * 60 * 1000;

function normalizeDocuments(list) {
  const requested = (Array.isArray(list) ? list : SUPPORTED_DOCUMENTS)
    .map((d) => String(d || '').toUpperCase().trim())
    .filter((d) => SUPPORTED_DOCUMENTS.includes(d));
  return [...new Set(requested.length ? requested : SUPPORTED_DOCUMENTS)];
}

function makeVerificationId(prefix = 'frenvi') {
  const raw = `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
}

async function cashfreeRequest(method, path, { body, query } = {}) {
  if (!isConfigured()) {
    const err = new Error('Cashfree credentials not configured');
    err.code = 'cashfree_not_configured';
    err.status = 503;
    throw err;
  }

  let url = `${getBaseUrl()}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v != null && v !== '') qs.set(k, String(v));
    });
    url += `?${qs.toString()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method,
      headers: getAuthHeaders(),
      body: body != null ? JSON.stringify(body) : undefined,
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
    if (err && err.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        json: { type: 'timeout_error', code: 'network_timeout', message: 'Cashfree request timed out' }
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

function mapDigilockerError(status, json) {
  const msg = String((json && json.message) || '');
  const code = String((json && json.code) || '');

  if (status === 403 || /ip not whitelisted|ip_validation_failed/i.test(msg)) {
    return {
      success: false,
      status: 'IP_BLOCKED',
      message: msg || 'Cashfree blocked this server IP. Whitelist it in Secure ID → IP whitelisting.'
    };
  }
  if (status === 401) {
    return {
      success: false,
      status: 'AUTH_FAILED',
      message: msg || 'Invalid Cashfree client id / secret'
    };
  }
  if (status === 429) {
    return {
      success: false,
      status: 'RATE_LIMITED',
      message: msg || 'Too many DigiLocker requests. Please wait and try again.'
    };
  }
  if (status === 422 || code === 'insufficient_balance') {
    return {
      success: false,
      status: 'INSUFFICIENT_BALANCE',
      message: msg || 'Cashfree verification wallet has insufficient balance.'
    };
  }
  if (status === 409) {
    return {
      success: false,
      status: 'DUPLICATE_VERIFICATION',
      message: msg || 'Verification id already exists. Please retry.'
    };
  }
  if (status === 502 || status === 503 || status === 504 || /temporarily unavailable/i.test(msg)) {
    return {
      success: false,
      status: 'TEMPORARILY_UNAVAILABLE',
      message: msg || 'DigiLocker service is temporarily unavailable. Please try again shortly.'
    };
  }
  return {
    success: false,
    status: code || 'FAILED',
    message: msg || 'DigiLocker request failed',
    cashfree: json
  };
}

/**
 * Optional: check if phone already has DigiLocker (separate verification_id from Create URL).
 */
async function verifyDigilockerAccount({ phone, verificationId }) {
  const id = verificationId || makeVerificationId('frenvi_va');
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) {
    return { success: false, status: 'INVALID', message: 'Valid mobile required' };
  }

  const { ok, status, json } = await cashfreeRequest('POST', '/digilocker/verify-account', {
    body: { verification_id: id, mobile_number: mobile }
  });

  console.log(
    `🪪 [CASHFREE-DL] verify-account status=${status} account=${json.status || ''} id=${id}`
  );

  if (!ok) return { ...mapDigilockerError(status, json), verificationId: id };

  return {
    success: true,
    verificationId: id,
    accountStatus: json.status || '',
    digilockerId: json.digilocker_id || '',
    userFlow: json.status === 'ACCOUNT_EXISTS' ? 'signin' : 'signup'
  };
}

/**
 * Create DigiLocker consent URL.
 * Docs: POST /digilocker — URL valid 10 minutes.
 */
async function createDigilockerUrl({
  verificationId,
  documents,
  redirectUrl,
  userFlow,
  purpose,
  companyName
}) {
  const id = verificationId || makeVerificationId('frenvi_dl');
  const document_requested = normalizeDocuments(documents);

  const body = {
    verification_id: id,
    document_requested
  };
  if (redirectUrl && /^https:\/\//i.test(redirectUrl)) {
    body.redirect_url = redirectUrl;
  }
  if (userFlow === 'signin' || userFlow === 'signup') {
    body.user_flow = userFlow;
  }
  if (purpose) body.purpose = String(purpose).slice(0, 50);
  if (companyName) body.company_name = String(companyName).slice(0, 50);

  const { ok, status, json } = await cashfreeRequest('POST', '/digilocker', { body });
  console.log(
    `🪪 [CASHFREE-DL] create-url status=${status} verificationId=${id} cfStatus=${json.status || ''}`
  );

  if (!ok || !json.url) {
    return { ...mapDigilockerError(status, json), verificationId: id };
  }

  return {
    success: true,
    verificationId: String(json.verification_id || id),
    referenceId: json.reference_id != null ? String(json.reference_id) : '',
    url: json.url,
    status: json.status || 'PENDING',
    documentRequested: json.document_requested || document_requested,
    userFlow: json.user_flow || userFlow || '',
    expiresInMs: URL_TTL_MS,
    redirectUrl: json.redirect_url || redirectUrl || null
  };
}

async function getDigilockerStatus({ verificationId, referenceId }) {
  if (!verificationId && !referenceId) {
    return { success: false, status: 'INVALID', message: 'verification_id or reference_id required' };
  }

  const query = {};
  if (verificationId) query.verification_id = verificationId;
  else query.reference_id = referenceId;

  const { ok, status, json } = await cashfreeRequest('GET', '/digilocker', { query });
  console.log(
    `🪪 [CASHFREE-DL] get-status http=${status} verificationId=${verificationId || ''} cf=${json.status || ''}`
  );

  if (!ok) return mapDigilockerError(status, json);

  return {
    success: true,
    cashfreeStatus: json.status || '',
    verificationId: String(json.verification_id || verificationId || ''),
    referenceId: json.reference_id != null ? String(json.reference_id) : String(referenceId || ''),
    documentRequested: json.document_requested || [],
    documentConsent: json.document_consent || [],
    documentConsentValidity: json.document_consent_validity || null,
    userDetails: json.user_details || {}
  };
}

async function getDigilockerDocument({ documentType, verificationId, referenceId }) {
  const type = String(documentType || '').toUpperCase();
  if (!SUPPORTED_DOCUMENTS.includes(type)) {
    return { success: false, status: 'INVALID', message: 'Invalid document type' };
  }

  const query = {};
  if (verificationId) query.verification_id = verificationId;
  else if (referenceId) query.reference_id = referenceId;
  else {
    return { success: false, status: 'INVALID', message: 'verification_id or reference_id required' };
  }

  const { ok, status, json } = await cashfreeRequest(
    'GET',
    `/digilocker/document/${type}`,
    { query }
  );

  console.log(
    `🪪 [CASHFREE-DL] get-document type=${type} http=${status} docStatus=${json.status || ''}`
  );

  // 202 = still processing
  if (status === 202) {
    return {
      success: false,
      status: 'DOCUMENT_PENDING',
      message: json.message || 'Document still processing. Try again shortly.',
      retryAfterMs: 5000
    };
  }

  if (!ok) return mapDigilockerError(status, json);

  const docStatus = String(json.status || '').toUpperCase();
  if (docStatus === 'AADHAAR_NOT_LINKED' || docStatus === 'FAILED') {
    return {
      success: false,
      status: docStatus || 'DOCUMENT_UNAVAILABLE',
      message: json.message || `${type} is not available in DigiLocker.`,
      raw: sanitizeDoc(json)
    };
  }

  return {
    success: true,
    documentType: type,
    status: docStatus || 'SUCCESS',
    data: normalizeDocument(type, json)
  };
}

function sanitizeDoc(json) {
  if (!json || typeof json !== 'object') return {};
  const clone = { ...json };
  if (clone.photo_link) clone.photo_link = '[omitted]';
  if (clone.xml_file) clone.xml_file = '[omitted]';
  if (clone.pan) clone.pan = maskId(clone.pan, 4);
  if (clone.uid) clone.uid = maskId(String(clone.uid).replace(/x/gi, ''), 4);
  if (clone.dl_number) clone.dl_number = maskId(clone.dl_number, 4);
  return clone;
}

function maskId(value, keep = 4) {
  const s = String(value || '').replace(/\s/g, '');
  if (!s) return '';
  if (s.length <= keep) return `****${s}`;
  return `${'*'.repeat(Math.max(4, s.length - keep))}${s.slice(-keep)}`;
}

function normalizeDocument(type, json) {
  if (type === 'AADHAAR') {
    const uid = String(json.uid || '').replace(/x/gi, '');
    return {
      name: json.name || '',
      dob: json.dob || '',
      yearOfBirth: json.year_of_birth || '',
      gender: json.gender || '',
      address: formatAddress(json.split_address) || '',
      careOf: json.care_of || '',
      documentLast4: uid.slice(-4) || '',
      maskedId: json.uid || (uid ? maskId(uid, 4) : '')
    };
  }
  if (type === 'PAN') {
    const pan = String(json.pan || '');
    return {
      name: json.name_pan_card || json.name || '',
      dob: json.dob || '',
      yearOfBirth: '',
      gender: json.gender || '',
      address: '',
      careOf: '',
      documentLast4: pan.slice(-4),
      maskedId: maskId(pan, 4)
    };
  }
  // DRIVING_LICENSE
  const dl = String(json.dl_number || '');
  return {
    name: json.name || '',
    dob: json.dob || '',
    yearOfBirth: '',
    gender: json.gender || '',
    address: json.present_address || json.permanent_address || '',
    careOf: json.care_of || '',
    documentLast4: dl.slice(-4),
    maskedId: maskId(dl, 4),
    issuer: json.issued_at || ''
  };
}

function formatAddress(split) {
  if (!split || typeof split !== 'object') return '';
  return [
    split.house,
    split.street,
    split.locality,
    split.landmark,
    split.vtc,
    split.dist,
    split.state,
    split.pincode,
    split.country
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * After AUTHENTICATED — fetch consented docs in priority order until one has usable identity+DOB.
 */
async function fetchPreferredDocument({ verificationId, referenceId, documentConsent }) {
  const consented = (documentConsent && documentConsent.length
    ? documentConsent
    : SUPPORTED_DOCUMENTS
  ).map((d) => String(d).toUpperCase());

  const order = DOC_PRIORITY.filter((d) => consented.includes(d));
  const attempts = [];

  for (const type of order) {
    const result = await getDigilockerDocument({ documentType: type, verificationId, referenceId });
    attempts.push({ type, status: result.status, success: result.success });
    if (result.success && result.data) {
      return { success: true, documentType: type, data: result.data, attempts };
    }
    if (result.status === 'DOCUMENT_PENDING') {
      return { ...result, attempts };
    }
  }

  return {
    success: false,
    status: 'DOCUMENT_UNAVAILABLE',
    message:
      'No usable document was available in DigiLocker. Link Aadhaar, PAN, or Driving Licence in DigiLocker and try again.',
    attempts
  };
}

function verifyWebhookSignature(rawBody, timestamp, signature) {
  const secret = process.env.CASHFREE_CLIENT_SECRET || '';
  if (!secret || !timestamp || !signature || rawBody == null) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(String(timestamp) + String(rawBody))
    .digest('base64');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function mapCashfreeStatusToInternal(cfStatus) {
  switch (String(cfStatus || '').toUpperCase()) {
    case 'PENDING':
      return 'PENDING';
    case 'AUTHENTICATED':
      return 'AUTHORIZED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CONSENT_DENIED':
      return 'CANCELLED';
    case 'FAILURE':
      return 'FAILED';
    default:
      return null;
  }
}

module.exports = {
  SUPPORTED_DOCUMENTS,
  DOC_PRIORITY,
  URL_TTL_MS,
  makeVerificationId,
  normalizeDocuments,
  verifyDigilockerAccount,
  createDigilockerUrl,
  getDigilockerStatus,
  getDigilockerDocument,
  fetchPreferredDocument,
  verifyWebhookSignature,
  mapCashfreeStatusToInternal,
  isConfigured,
  isSandbox
};
