const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { isConnected } = require('../config/db');
const { STAFF_ACCOUNTS, hashPassword, verifyPassword, publicStaff } = require('../data/staffAccounts');
const {
  signAccessToken,
  issueTokenPair,
  hashToken,
  allowPhoneFallback,
  normalizePhone
} = require('../middleware/auth');
const { isSmsConfigured, getSmsConfig } = require('../config/sms');
const { sendLoginOtp } = require('../services/smsService');

// In-memory fallback if MongoDB connection is pending
const fallbackUsers = {};
const fallbackStaff = {};
const otpStore = {};

function signStaffToken(user) {
  const jwtSecret = process.env.JWT_SECRET || 'frenvi_secret_2026';
  return jwt.sign(
    {
      userId: user._id,
      phone: user.phone,
      role: user.role,
      department: user.department,
      username: user.username
    },
    jwtSecret,
    { expiresIn: '12h' }
  );
}

function toStaffPayload(user) {
  return {
    id: user._id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    department: user.department,
    title: user.title || '',
    avatar: user.avatar || '👤'
  };
}

const authController = {
  // 1. Send OTP (via smslogin.co DLT when configured)
  async sendOtp(req, res) {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number required' });
      }

      const generatedOtp = String(Math.floor(1000 + Math.random() * 9000));
      otpStore[phone] = { otp: generatedOtp, expires: Date.now() + 5 * 60 * 1000 };

      const cfg = getSmsConfig();
      let smsSent = false;
      let smsError = null;

      const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

      if (isSmsConfigured()) {
        const sms = await sendLoginOtp(phone, generatedOtp);
        smsSent = !!sms.success;
        if (!sms.success) {
          smsError = sms.message || 'SMS gateway error';
          console.warn(`📱 [AUTH] SMS failed for +91 ${phone}: ${smsError}`);
          // Do not proceed with a "fake success" in production — user must get the SMS
          if (isProd) {
            delete otpStore[phone];
            return res.status(502).json({
              success: false,
              code: 'SMS_SEND_FAILED',
              message: 'Could not send OTP SMS. Please try again in a moment.'
            });
          }
        } else {
          console.log(`📱 [AUTH] OTP SMS sent to +91 ${phone}`);
        }
      } else if (isProd) {
        delete otpStore[phone];
        return res.status(503).json({
          success: false,
          code: 'SMS_NOT_CONFIGURED',
          message: 'SMS gateway is not configured on the server'
        });
      } else {
        console.warn(
          `📱 [AUTH] SMS not configured — OTP for +91 ${phone}: ${generatedOtp} (set SMS_API_KEY to enable)`
        );
      }

      const payload = {
        success: true,
        message: smsSent ? 'OTP sent to your mobile' : 'OTP generated',
        smsSent,
        channel: smsSent ? 'sms' : 'dev'
      };
      // Never echo OTP in production responses (user reads it from SMS)
      if (cfg.returnOtpInResponse) {
        payload.otp = generatedOtp;
      }
      if (smsError && cfg.returnOtpInResponse) {
        payload.smsWarning = smsError;
      }
      return res.json(payload);
    } catch (err) {
      console.error('Send OTP error:', err);
      return res.status(500).json({ success: false, message: 'Server error sending OTP' });
    }
  },

  // 2. Verify OTP & Authenticate
  async verifyOtp(req, res) {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      const name = req.body && req.body.name;
      const otp = req.body && req.body.otp;
      if (!phone || phone.length !== 10 || !otp) {
        return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
      }

      const pending = otpStore[phone];
      if (!pending || String(pending.otp) !== String(otp) || Date.now() > pending.expires) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      }
      delete otpStore[phone];

      let user = null;
      try {
        user = await User.findOne({ phone });
        if (!user) {
          user = await User.create({
            phone,
            name: name || 'Worker',
            role: 'worker',
            assessmentStatus: 'NEW',
            city: 'Hyderabad',
            walletBalance: 0,
            notifications: [
              {
                title: 'Welcome to Frenvi',
                body: 'Complete skill assessment to unlock shifts near you.',
                type: 'system',
                unread: true,
                createdAt: new Date()
              }
            ]
          });
        } else if (name && user.name !== name) {
          user.name = name;
          await user.save();
        }
      } catch (dbErr) {
        // Use resilient in-memory fallback if MongoDB is offline
        if (!fallbackUsers[phone]) {
          fallbackUsers[phone] = {
            _id: 'user_' + phone,
            phone,
            name: name || 'Worker',
            role: 'worker',
            assessmentStatus: 'NEW',
            verified: false,
            walletBalance: 0,
            city: 'Hyderabad'
          };
        }
        user = fallbackUsers[phone];
      }

      let tokens = { token: signAccessToken(user) };
      if (user && typeof user.save === 'function') {
        try {
          tokens = await issueTokenPair(user);
        } catch (e) {
          console.warn('[AUTH] issueTokenPair note:', e.message);
        }
      }

      return res.json({
        success: true,
        token: tokens.token,
        refreshToken: tokens.refreshToken || null,
        expiresIn: tokens.expiresIn || null,
        refreshExpiresAt: tokens.refreshExpiresAt || null,
        user: {
          id: user._id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          assessmentStatus: user.assessmentStatus,
          verified: user.verified,
          skillEvaluation: user.skillEvaluation || {},
          upiId: user.upiId || '',
          city: user.city || 'Hyderabad',
          locationLabel: user.locationLabel || '',
          lang: user.lang || 'en',
          userTypeId: user.userTypeId || '',
          walletBalance: Number(user.walletBalance) || 0
        }
      });
    } catch (err) {
      console.error('Verify OTP error:', err);
      return res.status(500).json({ success: false, message: 'Server error during verification' });
    }
  },

  /**
   * Upgrade old local sessions (phone, no JWT) → JWT + refresh.
   * Only available while ALLOW_PHONE_AUTH=true.
   */
  async bootstrap(req, res) {
    try {
      if (!allowPhoneFallback()) {
        return res.status(403).json({
          success: false,
          code: 'BOOTSTRAP_DISABLED',
          message: 'Phone bootstrap disabled — sign in with OTP'
        });
      }
      const phone = normalizePhone(req.body && req.body.phone);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }

      let user = null;
      try {
        user = await User.findOne({ phone });
      } catch (e) {
        user = fallbackUsers[phone] || null;
      }
      if (!user) {
        return res.status(404).json({
          success: false,
          code: 'USER_NOT_FOUND',
          message: 'No account for this phone — sign in with OTP'
        });
      }

      let tokens = { token: signAccessToken(user) };
      if (typeof user.save === 'function') {
        tokens = await issueTokenPair(user);
      }

      console.log(`🔄 [AUTH] bootstrap upgraded phone=${phone}`);
      return res.json({
        success: true,
        authUpgraded: true,
        token: tokens.token,
        refreshToken: tokens.refreshToken || null,
        expiresIn: tokens.expiresIn || null,
        refreshExpiresAt: tokens.refreshExpiresAt || null,
        user: {
          id: user._id,
          phone: user.phone,
          name: user.name,
          role: user.role
        }
      });
    } catch (err) {
      console.error('Bootstrap auth error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /** Exchange refreshToken for a new access (+ rotated refresh) token pair. */
  async refresh(req, res) {
    try {
      const raw = String((req.body && req.body.refreshToken) || '').trim();
      if (!raw || raw.length < 20) {
        return res.status(400).json({
          success: false,
          code: 'REFRESH_REQUIRED',
          message: 'refreshToken required'
        });
      }

      const hash = hashToken(raw);
      let user = null;
      try {
        user = await User.findOne({
          refreshTokenHash: hash,
          refreshTokenExpiresAt: { $gt: new Date() }
        });
      } catch (e) {
        user = null;
      }

      if (!user) {
        return res.status(401).json({
          success: false,
          code: 'REFRESH_INVALID',
          message: 'Refresh session expired — please sign in again'
        });
      }

      const tokens = await issueTokenPair(user);
      return res.json({
        success: true,
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        refreshExpiresAt: tokens.refreshExpiresAt
      });
    } catch (err) {
      console.error('Refresh auth error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 3. Get Authenticated User Profile
  async getProfile(req, res) {
    try {
      const phone = String((req.auth && req.auth.phone) || req.query.phone || '')
        .replace(/\D/g, '')
        .slice(-10);
      if (!phone) return res.status(400).json({ success: false, message: 'User identifier required' });

      let user = null;
      try {
        user = await User.findOne({ phone }).populate('activeBookingId');
      } catch (e) {
        user = fallbackUsers[phone];
      }

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      return res.json({ success: true, user });
    } catch (err) {
      console.error('Get profile error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async seedStaffAccounts() {
    for (const account of STAFF_ACCOUNTS) {
      const record = {
        phone: account.phone,
        username: account.username,
        email: account.email,
        name: account.name,
        role: account.role,
        department: account.department,
        title: account.title,
        avatar: account.avatar,
        passwordHash: hashPassword(account.password),
        assessmentStatus: 'COMPLETED',
        verified: true
      };

      fallbackStaff[account.username] = { ...record, _id: 'staff_' + account.username };

      if (!isConnected()) continue;

      try {
        const existing = await User.findOne({ $or: [{ username: account.username }, { phone: account.phone }] });
        if (!existing) {
          await User.create(record);
        } else {
          existing.username = account.username;
          existing.email = account.email;
          existing.role = account.role;
          existing.department = account.department;
          existing.title = account.title;
          existing.avatar = account.avatar;
          existing.passwordHash = hashPassword(account.password);
          existing.name = account.name;
          await existing.save();
        }
      } catch (_) {
        // Mongo unavailable — in-memory staff store is already filled
      }
    }

    console.log('👤 [AUTH] Staff logins ready: admin, neha, rohan, priya, rajesh, anita');
  },

  async getStaffDirectory(req, res) {
    const grouped = {
      admin: [],
      marketing: [],
      boarding: []
    };

    STAFF_ACCOUNTS.forEach((account) => {
      grouped[account.department].push(publicStaff(account));
    });

    return res.json({
      success: true,
      data: grouped,
      departments: [
        {
          id: 'admin',
          title: 'Main Admin',
          subtitle: 'Monitor completed vs remaining assessments across the desk.',
          icon: '👔'
        },
        {
          id: 'marketing',
          title: 'Marketing',
          subtitle: 'Track worker onboarding funnel and campaign-ready certified talent.',
          icon: '📣'
        },
        {
          id: 'boarding',
          title: 'Boarding Members',
          subtitle: 'Log in and run video assessments from the live worker queue.',
          icon: '👩‍💼'
        }
      ]
    });
  },

  async staffLogin(req, res) {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const department = String(req.body.department || '').trim().toLowerCase();

      if (!username || !password || !department) {
        return res.status(400).json({ success: false, message: 'Username, password and department are required' });
      }

      let user = fallbackStaff[username];
      if (isConnected()) {
        try {
          const dbUser = await User.findOne({ username });
          if (dbUser) user = dbUser;
        } catch (_) {
          // keep memory fallback
        }
      }

      if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
      }

      if (user.department !== department) {
        return res.status(403).json({
          success: false,
          message: `This login belongs to ${user.department}. Open that team card instead.`
        });
      }

      const token = signStaffToken(user);
      return res.json({
        success: true,
        token,
        user: toStaffPayload(user)
      });
    } catch (err) {
      console.error('Staff login error:', err);
      return res.status(500).json({ success: false, message: 'Server error during staff login' });
    }
  }
};

module.exports = authController;
