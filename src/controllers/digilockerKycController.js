const User = require('../models/User');
const DigiLockerVerification = require('../models/DigiLockerVerification');
const { isConnected } = require('../config/db');
const {
  isConfigured,
  isSandbox,
  getMinAge,
  getPublicApiOrigin
} = require('../config/cashfree');
const {
  makeVerificationId,
  normalizeDocuments,
  verifyDigilockerAccount,
  createDigilockerUrl,
  getDigilockerStatus,
  fetchPreferredDocument,
  verifyWebhookSignature,
  mapCashfreeStatusToInternal,
  URL_TTL_MS,
  SUPPORTED_DOCUMENTS
} = require('../services/cashfreeDigilocker');
const {
  parseDob,
  ageFromDob,
  isAdultFromDob,
  isAdultFromYearOfBirth,
  isConfirmedUnderage,
  normalizeAdultFlag,
  MINOR_MESSAGE
} = require('../utils/ageFromDob');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function publicKyc(user) {
  if (!user) {
    return {
      kycStatus: 'NEW',
      kycVerified: false,
      aadhaarLast4: '',
      kycName: '',
      kycVerifiedAt: null,
      age: null,
      isAdult: null,
      dateOfBirth: null,
      underage: false,
      kycDocumentType: '',
      kycSource: '',
      digilockerVerificationId: ''
    };
  }
  const u = user.toObject ? user.toObject() : user;
  return {
    kycStatus: u.kycStatus || 'NEW',
    kycVerified: u.kycStatus === 'VERIFIED',
    aadhaarLast4: u.aadhaarLast4 || '',
    kycName: u.kycName || '',
    kycDob: u.kycDob || '',
    dateOfBirth: u.dateOfBirth || null,
    age: u.age != null ? Number(u.age) : null,
    isAdult: normalizeAdultFlag(u),
    kycRejectedReason: u.kycRejectedReason || '',
    underage: isConfirmedUnderage(u),
    kycGender: u.kycGender || '',
    kycAddress: u.kycAddress || '',
    kycVerifiedAt: u.kycVerifiedAt || null,
    kycSource: u.kycSource || '',
    kycDocumentType: u.kycDocumentType || '',
    digilockerVerificationId: u.digilockerVerificationId || ''
  };
}

async function ensureUser(phone, name) {
  if (!isConnected()) {
    return { phone, name: name || 'Worker', kycStatus: 'NEW' };
  }
  let user = await User.findOne({ phone });
  if (!user) {
    user = await User.create({
      phone,
      name: name || 'Worker',
      role: 'worker',
      assessmentStatus: 'NEW',
      city: 'Hyderabad',
      kycStatus: 'NEW'
    });
  }
  return user;
}

function callbackHtml({ title, message, verificationId, ok }) {
  const safeTitle = String(title || 'DigiLocker');
  const safeMsg = String(message || '');
  const vid = String(verificationId || '');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{max-width:360px;background:#1e293b;border-radius:16px;padding:28px 22px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
h1{font-size:18px;margin:0 0 10px}
p{font-size:14px;line-height:1.45;color:#cbd5e1;margin:0 0 18px}
.ok{color:#4ade80}.bad{color:#f87171}
button{background:#E31837;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700;width:100%;cursor:pointer}
</style></head><body>
<div class="card">
  <h1 class="${ok ? 'ok' : 'bad'}">${safeTitle}</h1>
  <p>${safeMsg}</p>
  <p style="font-size:11px;color:#64748b">ID: ${vid}</p>
  <button type="button" onclick="try{window.close()}catch(e){};location.href='about:blank'">Close &amp; return to FRENVI</button>
</div>
<script>
try {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'FRENVI_DIGILOCKER_CALLBACK', verificationId: ${JSON.stringify(vid)}, ok: ${ok ? 'true' : 'false'} }, '*');
  }
} catch (e) {}
</script>
</body></html>`;
}

/**
 * Apply DigiLocker document result onto User + DigiLockerVerification.
 * Only trusts Cashfree document payload — never client-submitted identity fields.
 */
async function finalizeFromDocument(session, docResult) {
  const minAge = getMinAge();
  const data = docResult.data;
  const dobRaw = data.dob || '';
  const yobRaw = data.yearOfBirth || '';
  let adultCheck = isAdultFromDob(dobRaw, minAge);
  let dobDate = parseDob(dobRaw);
  if (adultCheck.reason === 'DOB_MISSING' && yobRaw) {
    adultCheck = isAdultFromYearOfBirth(yobRaw, minAge);
    if (!dobDate && adultCheck.dateOfBirth) dobDate = adultCheck.dateOfBirth;
  }
  const age = adultCheck.age != null ? adultCheck.age : ageFromDob(dobRaw);
  const verifiedName = data.name || session.verifiedName || 'Worker';

  session.selectedDocumentType = docResult.documentType;
  session.verifiedName = verifiedName;
  session.verifiedDob = dobRaw;
  session.dateOfBirth = dobDate;
  session.age = age;
  session.gender = data.gender || '';
  session.address = data.address || '';
  session.documentLast4 = data.documentLast4 || '';

  if (adultCheck.reason === 'DOB_MISSING') {
    session.status = 'FAILED';
    session.failureReason = 'DOB_MISSING';
    session.isAdult = null;
    session.completedAt = new Date();
    await session.save();
    return {
      success: false,
      code: 'DOB_MISSING',
      message: 'Could not read date of birth from DigiLocker document. Try another document.',
      data: { digilockerStatus: session.status }
    };
  }

  if (adultCheck.reason === 'UNDERAGE') {
    session.status = 'FAILED';
    session.failureReason = 'UNDERAGE';
    session.isAdult = false;
    session.completedAt = new Date();
    await session.save();

    if (isConnected()) {
      const user = await ensureUser(session.phone, verifiedName);
      Object.assign(user, {
        kycStatus: 'FAILED',
        digilockerVerificationId: session.verificationId,
        kycRefId: session.referenceId || session.verificationId,
        kycDocumentType: docResult.documentType,
        aadhaarLast4:
          docResult.documentType === 'AADHAAR' ? data.documentLast4 || '' : user.aadhaarLast4 || '',
        kycName: verifiedName,
        kycDob: dobRaw,
        dateOfBirth: dobDate,
        age,
        isAdult: false,
        kycRejectedReason: 'UNDERAGE',
        kycGender: data.gender || '',
        kycAddress: data.address || '',
        kycVerifiedAt: null,
        kycSource: 'cashfree_digilocker'
      });
      if (verifiedName && verifiedName !== 'Worker') user.name = verifiedName;
      user.notifications = user.notifications || [];
      user.notifications.unshift({
        title: 'KYC not approved — under 18',
        body: MINOR_MESSAGE,
        type: 'system',
        unread: true,
        createdAt: new Date()
      });
      await user.save();
    }

    return {
      success: false,
      code: 'UNDERAGE',
      message: MINOR_MESSAGE,
      data: {
        age,
        dateOfBirth: dobDate,
        kycStatus: 'FAILED',
        isAdult: false,
        minAge,
        digilockerStatus: session.status,
        kycDocumentType: docResult.documentType
      }
    };
  }

  // Eligible adult — mark verified
  session.status = 'VERIFIED';
  session.isAdult = true;
  session.failureReason = '';
  session.completedAt = new Date();
  await session.save();

  let user = null;
  if (isConnected()) {
    user = await ensureUser(session.phone, verifiedName);
    Object.assign(user, {
      kycStatus: 'VERIFIED',
      digilockerVerificationId: session.verificationId,
      kycRefId: session.referenceId || session.verificationId,
      kycDocumentType: docResult.documentType,
      aadhaarLast4:
        docResult.documentType === 'AADHAAR' ? data.documentLast4 || '' : user.aadhaarLast4 || '',
      kycName: verifiedName,
      kycDob: dobRaw,
      dateOfBirth: dobDate,
      age,
      isAdult: true,
      kycRejectedReason: '',
      kycGender: data.gender || '',
      kycAddress: data.address || '',
      kycVerifiedAt: new Date(),
      kycSource: 'cashfree_digilocker'
    });
    if (verifiedName && verifiedName !== 'Worker') user.name = verifiedName;
    user.notifications = user.notifications || [];
    user.notifications.unshift({
      title: 'Identity verified via DigiLocker',
      body: `Verified with ${docResult.documentType.replace('_', ' ')} (age ${age}). Continue to skill assessment.`,
      type: 'system',
      unread: true,
      createdAt: new Date()
    });
    await user.save();
  }

  console.log(
    `✅ [KYC-DL] Verified phone=${session.phone} doc=${docResult.documentType} age=${age}`
  );

  return {
    success: true,
    message: 'Identity verified via DigiLocker',
    data: {
      ...publicKyc(user),
      name: verifiedName,
      age,
      isAdult: true,
      digilockerStatus: 'VERIFIED',
      nextStep: 'assessment'
    }
  };
}

/**
 * Reconcile session with Cashfree status + document fetch.
 * Safe to call from poll, callback, or webhook.
 */
async function reconcileSession(session) {
  if (!session) {
    return { success: false, status: 'NOT_FOUND', message: 'Verification not found' };
  }
  if (session.status === 'VERIFIED' || session.status === 'FAILED') {
    const user = isConnected() ? await User.findOne({ phone: session.phone }) : null;
    return {
      success: session.status === 'VERIFIED',
      status: session.status,
      code: session.failureReason || session.status,
      message:
        session.status === 'VERIFIED'
          ? 'Already verified'
          : session.failureReason === 'UNDERAGE'
            ? MINOR_MESSAGE
            : session.failureReason || 'Verification ended',
      data: {
        ...publicKyc(user),
        digilockerStatus: session.status,
        verificationId: session.verificationId,
        kycDocumentType: session.selectedDocumentType
      }
    };
  }
  if (session.status === 'EXPIRED' || session.status === 'CANCELLED') {
    return {
      success: false,
      status: session.status,
      message:
        session.status === 'EXPIRED'
          ? 'DigiLocker link expired. Start verification again.'
          : 'Document consent was denied. You can try again.',
      data: { digilockerStatus: session.status, verificationId: session.verificationId }
    };
  }

  const statusResult = await getDigilockerStatus({
    verificationId: session.verificationId,
    referenceId: session.referenceId
  });

  if (!statusResult.success) {
    return {
      success: false,
      status: statusResult.status || 'TEMPORARILY_UNAVAILABLE',
      message: statusResult.message || 'Could not check DigiLocker status',
      data: { digilockerStatus: session.status, verificationId: session.verificationId }
    };
  }

  session.cashfreeStatus = statusResult.cashfreeStatus;
  if (statusResult.referenceId) session.referenceId = statusResult.referenceId;
  if (statusResult.documentConsent) session.documentConsent = statusResult.documentConsent;
  if (statusResult.documentConsentValidity) {
    session.documentConsentValidity = new Date(statusResult.documentConsentValidity);
  }

  const mapped = mapCashfreeStatusToInternal(statusResult.cashfreeStatus);
  if (mapped === 'EXPIRED' || mapped === 'CANCELLED' || mapped === 'FAILED') {
    session.status = mapped;
    session.failureReason = statusResult.cashfreeStatus;
    session.completedAt = new Date();
    await session.save();
    if (isConnected()) {
      const user = await User.findOne({ phone: session.phone });
      if (user && user.kycStatus === 'PENDING') {
        user.kycStatus = 'NEW';
        await user.save();
      }
    }
    return {
      success: false,
      status: mapped,
      message:
        mapped === 'EXPIRED'
          ? 'DigiLocker link expired. Start verification again.'
          : mapped === 'CANCELLED'
            ? 'You denied DigiLocker consent. Start again when ready.'
            : 'DigiLocker verification failed. Please try again.',
      data: { digilockerStatus: mapped, verificationId: session.verificationId }
    };
  }

  if (mapped === 'PENDING' || statusResult.cashfreeStatus === 'PENDING') {
    session.status = 'PENDING';
    await session.save();
    return {
      success: false,
      status: 'PENDING',
      message: 'Waiting for DigiLocker authorization…',
      data: {
        digilockerStatus: 'PENDING',
        verificationId: session.verificationId,
        phase: 'WAITING_AUTHORIZATION'
      }
    };
  }

  if (mapped !== 'AUTHORIZED' && statusResult.cashfreeStatus !== 'AUTHENTICATED') {
    await session.save();
    return {
      success: false,
      status: session.status,
      message: 'Verification still in progress',
      data: { digilockerStatus: session.status, verificationId: session.verificationId }
    };
  }

  session.status = 'AUTHORIZED';
  await session.save();

  const docResult = await fetchPreferredDocument({
    verificationId: session.verificationId,
    referenceId: session.referenceId,
    documentConsent: session.documentConsent
  });

  if (!docResult.success) {
    if (docResult.status === 'DOCUMENT_PENDING') {
      return {
        success: false,
        status: 'AUTHORIZED',
        message: docResult.message,
        data: {
          digilockerStatus: 'AUTHORIZED',
          verificationId: session.verificationId,
          phase: 'RETRIEVING_DOCUMENT',
          retryAfterMs: docResult.retryAfterMs || 5000
        }
      };
    }
    session.status = 'FAILED';
    session.failureReason = docResult.status || 'DOCUMENT_UNAVAILABLE';
    session.completedAt = new Date();
    await session.save();
    return {
      success: false,
      status: 'FAILED',
      message: docResult.message,
      data: { digilockerStatus: 'FAILED', verificationId: session.verificationId }
    };
  }

  return finalizeFromDocument(session, docResult);
}

const digilockerKycController = {
  async getStatus(req, res) {
    try {
      const phone = normalizePhone((req.auth && req.auth.phone) || req.query.phone);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }

      let user = null;
      let active = null;
      if (isConnected()) {
        user = await User.findOne({ phone });
        active = await DigiLockerVerification.findOne({ phone }).sort({ createdAt: -1 });
      }

      return res.json({
        success: true,
        cashfreeConfigured: isConfigured(),
        sandbox: isSandbox(),
        digilockerEnabled: true,
        minAge: getMinAge(),
        supportedDocuments: SUPPORTED_DOCUMENTS,
        data: {
          ...publicKyc(user),
          digilockerStatus: active ? active.status : 'NOT_STARTED',
          digilockerVerificationId: active ? active.verificationId : ''
        }
      });
    } catch (err) {
      console.error('KYC DigiLocker status error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async start(req, res) {
    try {
      if (!isConfigured()) {
        return res.status(503).json({
          success: false,
          status: 'NOT_CONFIGURED',
          message: 'Cashfree DigiLocker is not configured on the server.'
        });
      }
      if (!isConnected()) {
        return res.status(503).json({
          success: false,
          status: 'DB_UNAVAILABLE',
          message: 'Database is offline. DigiLocker KYC requires MongoDB.'
        });
      }

      const phone = normalizePhone((req.auth && req.auth.phone) || req.body.phone);
      const name = String(req.body.name || '').trim();
      const documents = normalizeDocuments(req.body.documents || req.body.document_requested);

      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }

      const user = await ensureUser(phone, name);
      if (isConnected() && user.kycStatus === 'VERIFIED' && user.isAdult === true) {
        return res.status(409).json({
          success: false,
          status: 'ALREADY_VERIFIED',
          code: 'ALREADY_VERIFIED',
          message: 'Identity is already verified for this account.',
          data: publicKyc(user)
        });
      }

      // Cancel stale open sessions for this phone
      if (isConnected()) {
        await DigiLockerVerification.updateMany(
          {
            phone,
            status: { $in: ['NOT_STARTED', 'INITIATED', 'PENDING', 'AUTHORIZED'] }
          },
          {
            $set: {
              status: 'EXPIRED',
              failureReason: 'SUPERSEDED',
              completedAt: new Date()
            }
          }
        );
      }

      let userFlow = 'signup';
      try {
        const account = await verifyDigilockerAccount({
          phone,
          verificationId: makeVerificationId('frenvi_va')
        });
        if (account.success && account.userFlow) userFlow = account.userFlow;
      } catch (e) {
        console.warn('🪪 [KYC-DL] verify-account skipped:', e.message);
      }

      const verificationId = makeVerificationId('frenvi_dl');
      const origin = getPublicApiOrigin();
      const redirectUrl = origin
        ? `${origin}/api/kyc/digilocker/callback?verification_id=${encodeURIComponent(verificationId)}&phone=${encodeURIComponent(phone)}`
        : '';

      const created = await createDigilockerUrl({
        verificationId,
        documents,
        redirectUrl: redirectUrl || undefined,
        userFlow,
        purpose: 'KYC Verification',
        companyName: process.env.DIGILOCKER_COMPANY_NAME || 'FRENVI'
      });

      if (!created.success) {
        return res.status(created.status === 'IP_BLOCKED' ? 403 : 400).json({
          success: false,
          status: created.status,
          code: created.status,
          message: created.message
        });
      }

      const session = await DigiLockerVerification.create({
        phone,
        userId: user._id || null,
        verificationId: created.verificationId,
        referenceId: created.referenceId,
        digilockerUrl: created.url,
        urlExpiresAt: new Date(Date.now() + (created.expiresInMs || URL_TTL_MS)),
        userFlow: created.userFlow || userFlow,
        documentRequested: created.documentRequested || documents,
        status: 'PENDING',
        cashfreeStatus: created.status || 'PENDING'
      });

      if (isConnected() && user.save) {
        user.kycStatus = 'PENDING';
        user.digilockerVerificationId = session.verificationId;
        user.kycRejectedReason = '';
        user.isAdult = null;
        user.age = null;
        user.dateOfBirth = null;
        user.kycDob = '';
        user.kycVerifiedAt = null;
        user.kycSource = 'cashfree_digilocker';
        if (name) user.name = name;
        await user.save();
      }

      console.log(
        `🪪 [KYC-DL] Started phone=${phone} verificationId=${session.verificationId} flow=${session.userFlow}`
      );

      return res.json({
        success: true,
        message: 'Open DigiLocker to authorize your documents',
        data: {
          verificationId: session.verificationId,
          referenceId: session.referenceId,
          url: session.digilockerUrl,
          expiresInMs: URL_TTL_MS,
          userFlow: session.userFlow,
          documentRequested: session.documentRequested,
          digilockerStatus: session.status,
          redirectConfigured: Boolean(redirectUrl),
          phase: 'REDIRECTING'
        }
      });
    } catch (err) {
      console.error('KYC DigiLocker start error:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Could not start DigiLocker verification'
      });
    }
  },

  async callback(req, res) {
    try {
      const verificationId = String(req.query.verification_id || req.query.verificationId || '');
      const phone = normalizePhone(req.query.phone);
      if (!verificationId) {
        return res
          .status(400)
          .send(callbackHtml({ title: 'Invalid callback', message: 'Missing verification id.', ok: false }));
      }

      let session = null;
      if (isConnected()) {
        session = await DigiLockerVerification.findOne({ verificationId });
      }
      if (!session) {
        return res.status(404).send(
          callbackHtml({
            title: 'Session not found',
            message: 'Start DigiLocker again from the FRENVI app.',
            verificationId,
            ok: false
          })
        );
      }
      if (phone && session.phone !== phone) {
        return res.status(403).send(
          callbackHtml({
            title: 'Access denied',
            message: 'This DigiLocker session belongs to another account.',
            verificationId,
            ok: false
          })
        );
      }

      // Callback is a UX resume signal only — reconcile with Cashfree server-side
      const result = await reconcileSession(session);
      const ok = !!(result.success || result.status === 'AUTHORIZED' || result.status === 'PENDING');
      return res.send(
        callbackHtml({
          title: result.success
            ? 'Verification complete'
            : result.status === 'PENDING' || result.status === 'AUTHORIZED'
              ? 'Almost done'
              : 'Verification update',
          message: result.message || 'Return to FRENVI to continue.',
          verificationId,
          ok: result.success || ok
        })
      );
    } catch (err) {
      console.error('KYC DigiLocker callback error:', err);
      return res.status(500).send(
        callbackHtml({
          title: 'Error',
          message: 'Something went wrong. Return to FRENVI and tap Check status.',
          ok: false
        })
      );
    }
  },

  async pollStatus(req, res) {
    try {
      const phone = normalizePhone(
        (req.auth && req.auth.phone) || req.query.phone || (req.body && req.body.phone)
      );
      const verificationId = String(
        req.query.verificationId || req.query.verification_id || req.body.verificationId || ''
      );

      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }
      if (!verificationId) {
        return res.status(400).json({
          success: false,
          status: 'INVALID_REF',
          message: 'verificationId is required'
        });
      }

      const session = await DigiLockerVerification.findOne({ verificationId });
      if (!session) {
        return res.status(404).json({
          success: false,
          status: 'NOT_FOUND',
          message: 'DigiLocker session not found'
        });
      }
      if (session.phone !== phone) {
        return res.status(403).json({
          success: false,
          status: 'FORBIDDEN',
          message: 'This verification does not belong to your account'
        });
      }

      const result = await reconcileSession(session);
      const http =
        result.success
          ? 200
          : result.code === 'UNDERAGE'
            ? 403
            : result.status === 'PENDING' || result.status === 'AUTHORIZED'
              ? 202
              : result.status === 'EXPIRED' || result.status === 'CANCELLED'
                ? 410
                : 400;

      return res.status(http).json({
        success: !!result.success,
        message: result.message,
        status: result.status || result.code,
        code: result.code || result.status,
        data: result.data || null
      });
    } catch (err) {
      console.error('KYC DigiLocker poll error:', err);
      return res.status(500).json({ success: false, message: 'Server error checking DigiLocker' });
    }
  },

  async webhook(req, res) {
    try {
      const rawBody =
        typeof req.rawBody === 'string'
          ? req.rawBody
          : Buffer.isBuffer(req.rawBody)
            ? req.rawBody.toString('utf8')
            : JSON.stringify(req.body || {});
      const signature = req.headers['x-webhook-signature'];
      const timestamp = req.headers['x-webhook-timestamp'];

      if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
        console.warn('🪪 [KYC-DL] Webhook signature invalid');
        return res.status(401).json({ success: false, message: 'Invalid signature' });
      }

      const eventType = String((req.body && req.body.event_type) || '');
      const data = (req.body && req.body.data) || {};
      const verificationId = String(data.verification_id || '');
      const eventKey = `${eventType}:${verificationId}:${req.body.event_time || timestamp || ''}`;

      console.log(`🪪 [KYC-DL] Webhook event=${eventType} verificationId=${verificationId}`);

      if (!verificationId) {
        return res.status(200).json({ success: true, ignored: true });
      }

      const session = await DigiLockerVerification.findOne({ verificationId });
      if (!session) {
        return res.status(200).json({ success: true, ignored: true, reason: 'unknown_session' });
      }

      if (session.processedWebhookKeys && session.processedWebhookKeys.includes(eventKey)) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      session.processedWebhookKeys = [...(session.processedWebhookKeys || []), eventKey].slice(-30);

      if (eventType === 'DIGILOCKER_VERIFICATION_LINK_EXPIRED') {
        if (!['VERIFIED', 'FAILED'].includes(session.status)) {
          session.status = 'EXPIRED';
          session.cashfreeStatus = 'EXPIRED';
          session.failureReason = 'LINK_EXPIRED';
          session.completedAt = new Date();
        }
        await session.save();
        return res.status(200).json({ success: true });
      }
      if (eventType === 'DIGILOCKER_VERIFICATION_CONSENT_DENIED') {
        if (!['VERIFIED', 'FAILED'].includes(session.status)) {
          session.status = 'CANCELLED';
          session.cashfreeStatus = 'CONSENT_DENIED';
          session.failureReason = 'CONSENT_DENIED';
          session.completedAt = new Date();
        }
        await session.save();
        return res.status(200).json({ success: true });
      }
      if (eventType === 'DIGILOCKER_VERIFICATION_FAILURE') {
        if (!['VERIFIED'].includes(session.status)) {
          session.status = 'FAILED';
          session.cashfreeStatus = 'FAILURE';
          session.failureReason = 'PROVIDER_FAILURE';
          session.completedAt = new Date();
        }
        await session.save();
        return res.status(200).json({ success: true });
      }

      // SUCCESS / CONSENT_EXPIRED — reconcile documents server-side
      if (
        eventType === 'DIGILOCKER_VERIFICATION_SUCCESS' ||
        eventType === 'DIGILOCKER_VERIFICATION_CONSENT_EXPIRED'
      ) {
        if (data.document_consent) session.documentConsent = data.document_consent;
        if (data.reference_id != null) session.referenceId = String(data.reference_id);
        session.cashfreeStatus = data.status || session.cashfreeStatus;
        await session.save();
        await reconcileSession(session);
        return res.status(200).json({ success: true });
      }

      await session.save();
      return res.status(200).json({ success: true, ignored: true });
    } catch (err) {
      console.error('KYC DigiLocker webhook error:', err);
      // Still 200 to reduce infinite Cashfree retries on our bugs; log for ops
      return res.status(200).json({ success: false, message: 'processed_with_error' });
    }
  }
};

module.exports = digilockerKycController;
