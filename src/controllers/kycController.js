const User = require('../models/User');
const { isConnected } = require('../config/db');
const { isConfigured, isSandbox, SANDBOX_OTP } = require('../config/cashfree');
const {
  sendAadhaarOtp,
  verifyAadhaarOtp,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS
} = require('../services/cashfreeAadhaar');
const {
  parseDob,
  ageFromDob,
  isAdultFromDob,
  isAdultFromYearOfBirth,
  isConfirmedUnderage,
  normalizeAdultFlag,
  MINOR_MESSAGE
} = require('../utils/ageFromDob');

// Pending OTP sessions (memory). Mongo also stores kycRefId for multi-restart recovery of the ref.
const pendingKyc = {};

/** Simple in-memory rate limits (per phone) */
const sendAttempts = {};
const verifyAttempts = {};
const MAX_SEND_PER_HOUR = 8;
const MAX_VERIFY_PER_SESSION = 6;
const HOUR_MS = 60 * 60 * 1000;

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function normalizeAadhaar(value) {
  return String(value || '').replace(/\D/g, '');
}

function pruneAttempts(bucket, key, windowMs) {
  const now = Date.now();
  const list = (bucket[key] || []).filter((t) => now - t < windowMs);
  bucket[key] = list;
  return list;
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
      underage: false
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
    // null/undefined = unknown (not verified yet) — never coerce to false
    isAdult: normalizeAdultFlag(u),
    kycRejectedReason: u.kycRejectedReason || '',
    underage: isConfirmedUnderage(u),
    kycGender: u.kycGender || '',
    kycAddress: u.kycAddress || '',
    kycVerifiedAt: u.kycVerifiedAt || null,
    kycSource: u.kycSource || ''
  };
}

async function ensureUser(phone, name) {
  if (!isConnected()) {
    return {
      phone,
      name: name || 'Worker',
      kycStatus: 'NEW'
    };
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

function getPendingSession(phone) {
  const pending = pendingKyc[phone];
  if (!pending || !pending.refId) return null;
  if (pending.expiresAt && Date.now() > pending.expiresAt) {
    delete pendingKyc[phone];
    return null;
  }
  return pending;
}

function storePendingSession(phone, { refId, aadhaar, name, source, expiresInMs }) {
  const now = Date.now();
  pendingKyc[phone] = {
    refId: String(refId),
    aadhaar: normalizeAadhaar(aadhaar),
    aadhaarLast4: normalizeAadhaar(aadhaar).slice(-4),
    name: name || 'Worker',
    createdAt: now,
    expiresAt: now + (expiresInMs || OTP_TTL_MS),
    source: source || 'cashfree',
    verifyCount: 0
  };
  return pendingKyc[phone];
}

function httpStatusForKycError(status) {
  switch (status) {
    case 'TEMPORARILY_UNAVAILABLE':
    case 'VERIFICATION_PENDING':
      return 503;
    case 'SESSION_EXPIRED':
    case 'OTP_EXPIRED':
      return 410;
    case 'IP_BLOCKED':
    case 'UNDERAGE':
      return 403;
    case 'RATE_LIMITED':
    case 'RESEND_COOLDOWN':
      return 429;
    case 'AUTH_FAILED':
      return 401;
    case 'ALREADY_VERIFIED':
      return 409;
    case 'INVALID_REF':
    case 'INVALID_OTP':
    case 'INVALID_AADHAAR':
    case 'MOBILE_NOT_LINKED':
    case 'DOB_MISSING':
    default:
      return 400;
  }
}

const kycController = {
  async getStatus(req, res) {
    try {
      const phone = normalizePhone(req.query.phone);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }

      let user = null;
      if (isConnected()) {
        user = await User.findOne({ phone });
      } else if (pendingKyc[phone] && pendingKyc[phone].verified) {
        user = pendingKyc[phone].userSnapshot;
      }

      return res.json({
        success: true,
        cashfreeConfigured: isConfigured(),
        sandbox: isSandbox(),
        testHint: isSandbox()
          ? {
              aadhaar: '655675523712',
              otp: SANDBOX_OTP,
              note: 'Use Cashfree sandbox test Aadhaar + OTP 111000'
            }
          : null,
        data: publicKyc(user)
      });
    } catch (err) {
      console.error('KYC status error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async sendOtp(req, res) {
    try {
      const phone = normalizePhone(req.body.phone);
      const name = String(req.body.name || '').trim();
      const aadhaar = normalizeAadhaar(req.body.aadhaar || req.body.aadhaarNumber);

      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }
      if (aadhaar.length !== 12) {
        return res.status(400).json({ success: false, message: 'Enter a valid 12-digit Aadhaar number' });
      }

      const recentSends = pruneAttempts(sendAttempts, phone, HOUR_MS);
      if (recentSends.length >= MAX_SEND_PER_HOUR) {
        return res.status(429).json({
          success: false,
          status: 'RATE_LIMITED',
          code: 'RATE_LIMITED',
          message: 'Too many OTP requests. Please wait before trying again.'
        });
      }

      // Local resend cooldown (mirrors Cashfree 30s same-Aadhaar rule)
      const existing = getPendingSession(phone);
      if (
        existing &&
        existing.aadhaar === aadhaar &&
        Date.now() - existing.createdAt < RESEND_COOLDOWN_MS
      ) {
        const waitMs = RESEND_COOLDOWN_MS - (Date.now() - existing.createdAt);
        return res.status(429).json({
          success: false,
          status: 'RESEND_COOLDOWN',
          code: 'RESEND_COOLDOWN',
          message: `OTP was just sent. Wait ${Math.ceil(waitMs / 1000)}s before requesting another.`,
          retryAfterMs: waitMs,
          data: {
            refId: existing.refId,
            aadhaarLast4: existing.aadhaarLast4
          }
        });
      }

      const user = await ensureUser(phone, name);

      if (isConnected() && user.kycStatus === 'VERIFIED' && user.isAdult === true) {
        return res.status(409).json({
          success: false,
          status: 'ALREADY_VERIFIED',
          code: 'ALREADY_VERIFIED',
          message: 'Aadhaar KYC is already verified for this account.',
          data: publicKyc(user)
        });
      }

      const result = await sendAadhaarOtp(aadhaar);

      if (!result.success) {
        console.warn(
          `🪪 [KYC] OTP failed phone=${phone} aadhaar=****${aadhaar.slice(-4)} status=${result.status}: ${result.message}`
        );
        return res.status(httpStatusForKycError(result.status)).json({
          success: false,
          message: result.message || 'Failed to send Aadhaar OTP',
          status: result.status,
          code: result.status,
          retryAfterMs: result.retryAfterMs
        });
      }

      sendAttempts[phone] = [...recentSends, Date.now()];

      // Replace any previous session for this phone with the new Cashfree ref_id
      const session = storePendingSession(phone, {
        refId: result.refId,
        aadhaar,
        name: name || (user.name || 'Worker'),
        source: result.source,
        expiresInMs: result.expiresInMs || OTP_TTL_MS
      });

      if (isConnected() && user.save) {
        // Fresh OTP attempt — clear any previous underage / failed KYC so retry works
        user.kycStatus = 'PENDING';
        user.kycRefId = String(result.refId);
        user.aadhaarLast4 = aadhaar.slice(-4);
        user.kycRejectedReason = '';
        user.isAdult = null;
        user.age = null;
        user.dateOfBirth = null;
        user.kycDob = '';
        user.kycVerifiedAt = null;
        if (name) user.name = name;
        await user.save();
      }

      console.log(
        `🪪 [KYC] OTP sent phone=${phone} ref=${result.refId} source=${result.source || 'cashfree'} expiresInMs=${session.expiresAt - Date.now()}`
      );

      return res.json({
        success: true,
        message: result.message,
        data: {
          refId: result.refId,
          aadhaarLast4: aadhaar.slice(-4),
          source: result.source || 'cashfree',
          expiresInMs: result.expiresInMs || OTP_TTL_MS,
          resendCooldownMs: RESEND_COOLDOWN_MS,
          testHint: result.testHint || (isSandbox() ? `Sandbox OTP is ${SANDBOX_OTP}` : null)
        }
      });
    } catch (err) {
      console.error('KYC send OTP error:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Server error sending Aadhaar OTP'
      });
    }
  },

  async verifyOtp(req, res) {
    try {
      const phone = normalizePhone(req.body.phone);
      const otp = String(req.body.otp || '').replace(/\D/g, '');
      const name = String(req.body.name || '').trim();
      let refId = String(req.body.refId || req.body.reference_id || '').trim();
      let aadhaar = normalizeAadhaar(req.body.aadhaar || req.body.aadhaarNumber);

      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
      }
      if (otp.length < 4) {
        return res.status(400).json({
          success: false,
          status: 'INVALID_OTP',
          code: 'INVALID_OTP',
          message: 'Valid OTP is required'
        });
      }

      let pending = getPendingSession(phone);

      // Recover ref from Mongo if memory session was lost (restart) — never trust a foreign ref alone
      if (!pending && isConnected()) {
        const user = await User.findOne({ phone });
        if (user && user.kycStatus === 'PENDING' && user.kycRefId) {
          pending = {
            refId: String(user.kycRefId),
            aadhaar: aadhaar || '',
            aadhaarLast4: user.aadhaarLast4 || '',
            name: user.name || name || 'Worker',
            createdAt: Date.now() - 60 * 1000,
            expiresAt: Date.now() + OTP_TTL_MS,
            source: 'cashfree',
            verifyCount: 0,
            recoveredFromDb: true
          };
          pendingKyc[phone] = pending;
        }
      }

      if (!refId && pending) refId = pending.refId;
      if (!aadhaar && pending) aadhaar = pending.aadhaar;

      if (!refId) {
        return res.status(400).json({
          success: false,
          status: 'INVALID_REF',
          code: 'INVALID_REF',
          message: 'No pending Aadhaar OTP. Tap Send OTP first.'
        });
      }

      // Bind verification to this phone's session — reject another user's / stale ref
      if (pending && pending.refId && String(pending.refId) !== String(refId)) {
        console.warn(
          `🪪 [KYC] Ref mismatch phone=${phone} clientRef=${refId} sessionRef=${pending.refId}`
        );
        return res.status(400).json({
          success: false,
          status: 'INVALID_REF',
          code: 'INVALID_REF',
          message:
            'This OTP belongs to an older session. Tap Send OTP again and enter the new code.'
        });
      }

      if (pending && pending.expiresAt && Date.now() > pending.expiresAt) {
        delete pendingKyc[phone];
        return res.status(410).json({
          success: false,
          status: 'SESSION_EXPIRED',
          code: 'SESSION_EXPIRED',
          message: 'OTP session expired. Tap Send OTP again and enter the new code.'
        });
      }

      const recentVerify = pruneAttempts(verifyAttempts, `${phone}:${refId}`, OTP_TTL_MS);
      if (recentVerify.length >= MAX_VERIFY_PER_SESSION) {
        return res.status(429).json({
          success: false,
          status: 'RATE_LIMITED',
          code: 'RATE_LIMITED',
          message: 'Too many incorrect OTP attempts. Request a new OTP.'
        });
      }
      verifyAttempts[`${phone}:${refId}`] = [...recentVerify, Date.now()];
      if (pending) pending.verifyCount = (pending.verifyCount || 0) + 1;

      const result = await verifyAadhaarOtp({ refId, otp, aadhaarNumber: aadhaar });
      if (!result.success) {
        console.warn(
          `🪪 [KYC] Verify failed phone=${phone} ref=${refId} status=${result.status || ''}: ${result.message}`
        );

        // Only drop session when Cashfree confirms it is dead
        if (result.status === 'SESSION_EXPIRED' || result.status === 'OTP_EXPIRED') {
          delete pendingKyc[phone];
        }
        // Keep pending session on TEMPORARILY_UNAVAILABLE / VERIFICATION_PENDING / INVALID_OTP
        // so the user can retry the same OTP without regenerating.

        return res.status(httpStatusForKycError(result.status)).json({
          success: false,
          message: result.message || 'OTP verification failed',
          status: result.status || 'FAILED',
          code: result.status || 'FAILED',
          retryAfterMs: result.retryAfterMs,
          // Hint UI: same OTP may still work after provider outage
          canRetrySameOtp:
            result.status === 'TEMPORARILY_UNAVAILABLE' ||
            result.status === 'VERIFICATION_PENDING' ||
            result.status === 'INVALID_OTP'
        });
      }

      const verifiedName = (result.data && result.data.name) || name || (pending && pending.name) || 'Worker';
      const last4 = (result.data && result.data.aadhaarLast4) || (aadhaar ? aadhaar.slice(-4) : '');
      const dobRaw = (result.data && result.data.dob) || '';
      const yobRaw = (result.data && result.data.yearOfBirth) || '';
      let adultCheck = isAdultFromDob(dobRaw, 18);
      let dobDate = parseDob(dobRaw);
      // Cashfree often returns year_of_birth when full DOB is blank
      if (adultCheck.reason === 'DOB_MISSING' && yobRaw) {
        adultCheck = isAdultFromYearOfBirth(yobRaw, 18);
        if (!dobDate && adultCheck.dateOfBirth) dobDate = adultCheck.dateOfBirth;
      }
      const age = adultCheck.age != null ? adultCheck.age : ageFromDob(dobRaw);

      // Under 18 → reject KYC, do not mark verified
      if (adultCheck.reason === 'UNDERAGE') {
        const rejectPayload = {
          kycStatus: 'FAILED',
          kycRefId: String((result.data && result.data.refId) || refId),
          aadhaarLast4: last4,
          kycName: verifiedName,
          kycDob: dobRaw,
          dateOfBirth: dobDate,
          age,
          isAdult: false,
          kycRejectedReason: 'UNDERAGE',
          kycGender: (result.data && result.data.gender) || '',
          kycAddress: (result.data && result.data.address) || '',
          kycVerifiedAt: null,
          kycSource: result.source || 'cashfree'
        };

        if (isConnected()) {
          const user = await ensureUser(phone, verifiedName);
          Object.assign(user, rejectPayload);
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

        delete pendingKyc[phone];
        delete verifyAttempts[`${phone}:${refId}`];
        console.warn(`🚫 [KYC] Underage phone=${phone} age=${age} dob=${dobRaw}`);

        return res.status(403).json({
          success: false,
          code: 'UNDERAGE',
          status: 'UNDERAGE',
          message: MINOR_MESSAGE,
          data: {
            age,
            dateOfBirth: dobDate,
            kycStatus: 'FAILED',
            isAdult: false,
            minAge: 18
          }
        });
      }

      if (adultCheck.reason === 'DOB_MISSING') {
        delete pendingKyc[phone];
        return res.status(400).json({
          success: false,
          code: 'DOB_MISSING',
          status: 'DOB_MISSING',
          message: 'Could not read date of birth from Aadhaar. Please retry KYC.'
        });
      }

      const kycPayload = {
        kycStatus: 'VERIFIED',
        kycRefId: String((result.data && result.data.refId) || refId),
        aadhaarLast4: last4,
        kycName: verifiedName,
        kycDob: dobRaw,
        dateOfBirth: dobDate,
        age,
        isAdult: true,
        kycRejectedReason: '',
        kycGender: (result.data && result.data.gender) || '',
        kycAddress: (result.data && result.data.address) || '',
        kycVerifiedAt: new Date(),
        kycSource: result.source || 'cashfree'
      };

      let user = null;
      if (isConnected()) {
        user = await ensureUser(phone, verifiedName);
        Object.assign(user, kycPayload);
        if (verifiedName && verifiedName !== 'Worker') user.name = verifiedName;
        user.notifications = user.notifications || [];
        user.notifications.unshift({
          title: 'Aadhaar KYC verified',
          body: `Identity verified (age ${age}). Continue to skill assessment to unlock shifts.`,
          type: 'system',
          unread: true,
          createdAt: new Date()
        });
        await user.save();
      } else {
        pendingKyc[phone] = {
          verified: true,
          userSnapshot: {
            phone,
            name: verifiedName,
            ...kycPayload
          }
        };
        user = pendingKyc[phone].userSnapshot;
      }

      delete pendingKyc[phone];
      delete verifyAttempts[`${phone}:${refId}`];

      console.log(`✅ [KYC] Verified phone=${phone} name=${verifiedName} age=${age} source=${result.source}`);

      return res.json({
        success: true,
        message: 'Aadhaar KYC verified successfully',
        data: {
          ...publicKyc(user),
          name: verifiedName,
          age,
          isAdult: true,
          nextStep: 'assessment'
        }
      });
    } catch (err) {
      console.error('KYC verify OTP error:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Server error verifying Aadhaar OTP'
      });
    }
  }
};

module.exports = kycController;
