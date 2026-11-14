const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function jwtSecret() {
  return process.env.JWT_SECRET || 'frenvi_secret_2026';
}

function accessExpires() {
  return process.env.JWT_EXPIRES || '7d';
}

function refreshDays() {
  const n = Number(process.env.JWT_REFRESH_DAYS || 90);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

function allowPhoneFallback() {
  const raw = String(process.env.ALLOW_PHONE_AUTH || '').toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  // Default ON during rollout — turn OFF after clients bootstrap JWT.
  return true;
}

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function attachAuth(req, payload, via) {
  const phone = normalizePhone(payload.phone);
  req.auth = {
    userId: payload.userId || payload.id || null,
    phone,
    role: payload.role || 'worker',
    via: via || 'jwt'
  };
  req.user = req.auth;
}

function signAccessToken(user) {
  return jwt.sign(
    {
      userId: user._id || user.id,
      phone: normalizePhone(user.phone),
      role: user.role || 'worker'
    },
    jwtSecret(),
    { expiresIn: accessExpires() }
  );
}

/** @deprecated use signAccessToken */
function signUserToken(user) {
  return signAccessToken(user);
}

function issueRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + refreshDays() * 24 * 60 * 60 * 1000);
  return { raw, hash: hashToken(raw), expiresAt };
}

async function persistRefreshToken(userDoc, refresh) {
  if (!userDoc || typeof userDoc.save !== 'function') return;
  userDoc.refreshTokenHash = refresh.hash;
  userDoc.refreshTokenExpiresAt = refresh.expiresAt;
  await userDoc.save();
}

async function issueTokenPair(userDoc) {
  const accessToken = signAccessToken(userDoc);
  const refresh = issueRefreshToken();
  try {
    await persistRefreshToken(userDoc, refresh);
  } catch (e) {
    console.warn('[AUTH] refresh persist failed:', e.message);
  }
  return {
    token: accessToken,
    refreshToken: refresh.raw,
    expiresIn: accessExpires(),
    refreshExpiresAt: refresh.expiresAt.toISOString()
  };
}

function injectUpgradeTokens(req, res) {
  if (!req.authUpgrade) return;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (!body.token) body.token = req.authUpgrade.token;
      if (!body.refreshToken && req.authUpgrade.refreshToken) {
        body.refreshToken = req.authUpgrade.refreshToken;
      }
      body.authUpgraded = true;
    }
    return originalJson(body);
  };
}

/**
 * Require a valid JWT. Optionally falls back to phone= when ALLOW_PHONE_AUTH=true,
 * and auto-mints JWT+refresh so the client upgrades without re-login.
 */
function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret());
      const phone = normalizePhone(payload.phone);
      if (phone.length !== 10) {
        return res.status(401).json({
          success: false,
          code: 'AUTH_INVALID',
          message: 'Invalid token subject'
        });
      }
      attachAuth(req, payload, 'jwt');
      return next();
    } catch (err) {
      const expired = err && err.name === 'TokenExpiredError';
      return res.status(401).json({
        success: false,
        code: expired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
        message: expired
          ? 'Session expired — refresh or sign in again'
          : 'Invalid session — please sign in again',
        canRefresh: expired
      });
    }
  }

  if (allowPhoneFallback()) {
    const phone = normalizePhone(
      (req.body && req.body.phone) || req.query.phone || (req.params && req.params.phone)
    );
    if (phone.length === 10) {
      console.warn(`⚠️  [AUTH] phone fallback → will upgrade JWT for ${req.method} ${req.originalUrl} phone=${phone}`);
      req.auth = { userId: null, phone, role: 'worker', via: 'phone' };
      req.user = req.auth;

      // Async mint upgrade tokens (non-blocking if User lookup fails)
      const User = require('../models/User');
      User.findOne({ phone })
        .then(async (user) => {
          if (!user) {
            attachAuth(req, { phone, role: 'worker' }, 'phone');
            return next();
          }
          req.auth.userId = user._id;
          req.auth.role = user.role || 'worker';
          try {
            req.authUpgrade = await issueTokenPair(user);
          } catch (e) {
            req.authUpgrade = {
              token: signAccessToken(user)
            };
          }
          injectUpgradeTokens(req, res);
          return next();
        })
        .catch(() => {
          injectUpgradeTokens(req, res);
          return next();
        });
      return;
    }
  }

  return res.status(401).json({
    success: false,
    code: 'AUTH_REQUIRED',
    message: 'Sign in required'
  });
}

/** Attach JWT user if present; never blocks. */
function optionalAuth(req, _res, next) {
  const token = extractBearer(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (normalizePhone(payload.phone).length === 10) attachAuth(req, payload, 'jwt');
  } catch (_) {
    /* ignore */
  }
  return next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  signUserToken,
  signAccessToken,
  issueTokenPair,
  issueRefreshToken,
  persistRefreshToken,
  hashToken,
  normalizePhone,
  allowPhoneFallback,
  jwtSecret,
  accessExpires,
  refreshDays
};
