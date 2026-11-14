const User = require('../models/User');
const Shift = require('../models/Shift');
const { isConnected } = require('../config/db');
const { isConfirmedUnderage, normalizeAdultFlag } = require('../utils/ageFromDob');
const {
  createTopupOrder,
  isPgConfigured,
  getPgMode
} = require('../services/cashfreePg');
const { isDevWalletCreditAllowed } = require('../config/cashfreePg');
const {
  verifyAndCreditTopup,
  syncPendingTopupsForUser
} = require('../services/walletTopupCredit');
const {
  signAccessToken,
  issueTokenPair,
  normalizePhone: authNormalizePhone
} = require('../middleware/auth');

function normalizePhone(phone) {
  return authNormalizePhone(phone);
}

/** Prefer JWT phone from requireAuth; fall back to query/body during phone-auth rollout. */
function resolvePhone(req) {
  if (req.auth && req.auth.phone) return normalizePhone(req.auth.phone);
  return normalizePhone(
    (req.body && req.body.phone) || req.query.phone || ''
  );
}

function monthKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

async function findUser(phone) {
  if (!isConnected()) return null;
  return User.findOne({ phone });
}

function publicUser(user) {
  if (!user) return null;
  const u = user.toObject ? user.toObject() : { ...user };
  return {
    id: u._id,
    phone: u.phone,
    name: u.name,
    role: u.role,
    avatar: u.avatar || '👤',
    verified: !!u.verified,
    assessmentStatus: u.assessmentStatus || 'NEW',
    skillEvaluation: u.skillEvaluation || {},
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
    kycVerifiedAt: u.kycVerifiedAt || null,
    upiId: u.upiId || '',
    city: u.city || 'Hyderabad',
    locationLabel: u.locationLabel || '',
    lat: u.lat,
    lng: u.lng,
    workRadiusKm: Number(u.workRadiusKm) > 0 ? Number(u.workRadiusKm) : 6,
    preferredShiftTimes: u.preferredShiftTimes || 'Early morning, evenings',
    lang: u.lang || 'en',
    userTypeId: u.userTypeId || '',
    walletBalance: Number(u.walletBalance) || 0,
    taskFeePending: Number(u.taskFeePending) || 0,
    feeLimit: 100
  };
}

const userDataController = {
  async getMe(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      const user = await findUser(phone);
      if (!user) {
        console.log(`👤 [USER] me miss phone=${phone}`);
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      console.log(
        `👤 [USER] me phone=${phone} name=${user.name || ''} wallet=₹${Number(user.walletBalance) || 0} status=${user.assessmentStatus || 'NEW'}`
      );
      return res.json({ success: true, user: publicUser(user) });
    } catch (err) {
      console.error('getMe error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async updateMe(req, res) {
    try {
      const body = req.body || {};
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      // Prevent spoofing: if JWT present, ignore a different body.phone
      if (req.auth && req.auth.via === 'jwt' && body.phone) {
        const claimed = normalizePhone(body.phone);
        if (claimed.length === 10 && claimed !== phone) {
          return res.status(403).json({
            success: false,
            code: 'PHONE_MISMATCH',
            message: 'Phone does not match signed-in account'
          });
        }
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }

      const allowed = {};
      if (body.name != null) allowed.name = String(body.name).trim().slice(0, 80);
      if (body.upiId != null) allowed.upiId = String(body.upiId).trim().slice(0, 80);
      if (body.city != null) allowed.city = String(body.city).trim().slice(0, 80);
      if (body.locationLabel != null) allowed.locationLabel = String(body.locationLabel).trim().slice(0, 160);
      if (body.lang != null) allowed.lang = String(body.lang).trim().slice(0, 8);
      if (body.userTypeId != null) allowed.userTypeId = String(body.userTypeId).trim();
      if (body.lat != null && Number.isFinite(Number(body.lat))) allowed.lat = Number(body.lat);
      if (body.lng != null && Number.isFinite(Number(body.lng))) allowed.lng = Number(body.lng);
      if (body.workRadiusKm != null && Number.isFinite(Number(body.workRadiusKm))) {
        const km = Math.round(Number(body.workRadiusKm));
        if (km >= 1 && km <= 50) allowed.workRadiusKm = km;
      }
      if (body.preferredShiftTimes != null) {
        allowed.preferredShiftTimes = String(body.preferredShiftTimes).trim().slice(0, 120);
      }

      if (body.newPhone != null) {
        const newPhone = normalizePhone(body.newPhone);
        if (newPhone.length !== 10) {
          return res.status(400).json({ success: false, message: 'Valid 10-digit new phone required' });
        }
        if (newPhone !== phone) {
          const existing = await User.findOne({ phone: newPhone });
          if (existing) {
            return res.status(409).json({ success: false, message: 'Phone number already registered to another account' });
          }
          allowed.phone = newPhone;
        }
      }

      const user = await User.findOneAndUpdate(
        { phone },
        { $set: allowed },
        { new: true, upsert: false }
      );
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      if (allowed.phone && allowed.phone !== phone) {
        try {
          await Shift.updateMany({ acceptedBy: phone }, { $set: { acceptedBy: allowed.phone } });
          await Shift.updateMany({ postedBy: phone }, { $set: { postedBy: allowed.phone } });
        } catch (e) {
          console.warn('Shift phone migration note:', e.message);
        }
      }
      const payload = { success: true, user: publicUser(user) };
      // Phone change invalidates old JWT subject — issue a fresh token pair
      if (allowed.phone && allowed.phone !== phone) {
        try {
          const tokens = await issueTokenPair(user);
          payload.token = tokens.token;
          payload.refreshToken = tokens.refreshToken;
        } catch (e) {
          payload.token = signAccessToken(user);
        }
      }
      return res.json(payload);
    } catch (err) {
      console.error('updateMe error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async getWallet(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }

      const user = await findUser(phone);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const accepted = await Shift.find({
        acceptedBy: phone,
        status: { $in: ['FILLED', 'LIVE', 'SCHEDULED'] }
      })
        .sort({ acceptedAt: -1, updatedAt: -1 })
        .limit(100)
        .lean();

      const payouts = Array.isArray(user.payouts) ? user.payouts.slice().reverse() : [];
      const now = new Date();
      const thisMonth = monthKey(now);
      const startOfWeek = new Date(now);
      startOfWeek.setHours(0, 0, 0, 0);
      startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
      const startOfLastWeek = new Date(startOfWeek);
      startOfLastWeek.setDate(startOfWeek.getDate() - 7);

      let monthTotal = 0;
      let monthCount = 0;
      let weekTotal = 0;
      let weekCount = 0;
      let lastWeekTotal = 0;
      let allTime = Number(user.walletBalance) || 0;
      let allCount = payouts.length;
      const weekByDay = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun

      function accumulate(amount, when) {
        const amt = Number(amount) || 0;
        const d = when instanceof Date ? when : new Date(when || now);
        if (monthKey(d) === thisMonth) {
          monthTotal += amt;
          monthCount += 1;
        }
        if (d >= startOfWeek && d <= now) {
          weekTotal += amt;
          weekCount += 1;
          const idx = (d.getDay() + 6) % 7;
          weekByDay[idx] += amt;
        } else if (d >= startOfLastWeek && d < startOfWeek) {
          lastWeekTotal += amt;
        }
      }

      payouts.forEach((p) => accumulate(p.amount, p.paidAt || now));

      // Only real wallet ledger entries — no fake earnings from accepted shifts
      const recent = payouts.slice(0, 20);
      allTime = Number(user.walletBalance) || 0;
      allCount = payouts.filter((p) => Number(p.amount) > 0).length;

      const upcoming = accepted.find((s) => s.status === 'LIVE' || s.status === 'SCHEDULED' || s.status === 'FILLED');

      console.log(
        `💰 [WALLET] phone=${phone} balance=${Number(user.walletBalance) || 0} week=₹${weekTotal} month=₹${monthTotal} shifts=${allCount}`
      );

      const taskFeePending = Number(user.taskFeePending) || 0;
      return res.json({
        success: true,
        data: {
          balance: Number(user.walletBalance) || 0,
          monthTotal,
          monthCount,
          weekTotal,
          weekCount,
          lastWeekTotal,
          weekByDay,
          allTime: allTime || Number(user.walletBalance) || 0,
          allCount,
          upiId: user.upiId || '',
          taskFeePending,
          feeLimit: 100,
          feeBlocked: taskFeePending >= 100,
          payouts: recent,
          nextShift: upcoming
            ? {
                brand: upcoming.brand || '',
                role: upcoming.role || '',
                date: upcoming.date || '',
                startTime: upcoming.startTime || '',
                status: upcoming.status || ''
              }
            : null
        }
      });
    } catch (err) {
      console.error('getWallet error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /**
   * POST /api/users/wallet/settle-fees
   * Pay pending 5% task fees from wallet balance (required when pending >= ₹100).
   */
  async settleTaskFees(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const pending = Number(user.taskFeePending) || 0;
      if (pending <= 0) {
        return res.json({
          success: true,
          message: 'No pending task fees',
          data: { taskFeePending: 0, walletBalance: Number(user.walletBalance) || 0 }
        });
      }

      const wallet = Number(user.walletBalance) || 0;
      if (wallet < pending) {
        return res.status(402).json({
          success: false,
          code: 'INSUFFICIENT_WALLET',
          message: `Add ₹${pending - wallet} to wallet to pay pending task fees of ₹${pending}`,
          data: {
            taskFeePending: pending,
            walletBalance: wallet,
            shortfall: pending - wallet
          }
        });
      }

      user.walletBalance = wallet - pending;
      user.taskFeePending = 0;
      user.payouts = user.payouts || [];
      user.payouts.unshift({
        shiftId: '',
        brand: 'Frenvi',
        role: 'Task fee settlement',
        amount: -pending,
        hours: 0,
        paidAt: new Date(),
        note: `Settled pending 5% task fees ₹${pending}`
      });
      user.notifications = user.notifications || [];
      user.notifications.unshift({
        title: `₹${pending} task fees paid`,
        body: 'You can accept new tasks again.',
        type: 'pay',
        unread: true,
        createdAt: new Date()
      });
      await user.save();

      console.log(`💳 [FEES] settled phone=${phone} amount=₹${pending} wallet=₹${user.walletBalance}`);

      return res.json({
        success: true,
        message: `Paid ₹${pending} pending task fees`,
        data: {
          settled: pending,
          taskFeePending: 0,
          walletBalance: Number(user.walletBalance) || 0,
          feeLimit: 100
        }
      });
    } catch (err) {
      console.error('settleTaskFees error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /**
   * POST /api/users/wallet/topup
   * Starts Cashfree PG checkout (payment popup). Wallet is credited only after confirm.
   * Body: { phone, amount }
   */
  async topUpWallet(req, res) {
    try {
      const phone = resolvePhone(req);
      const raw = Number(req.body.amount);
      const amount = Number.isFinite(raw) ? Math.round(raw) : 0;
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!(amount > 0)) {
        return res.status(400).json({ success: false, message: 'Enter an amount greater than 0' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Cashfree PG checkout — wallet credited only after PAID confirm (or explicit DEV credit)
      if (!isPgConfigured()) {
        return res.status(503).json({
          success: false,
          code: 'PG_NOT_CONFIGURED',
          message: 'Cashfree Payment Gateway keys are missing. Set CASHFREE_PG_CLIENT_ID / CASHFREE_PG_CLIENT_SECRET.'
        });
      }

      const created = await createTopupOrder({
        phone,
        amount,
        customerName: user.name || 'Frenvi Worker'
      });

      if (!created.success || !created.paymentSessionId) {
        const cfMsg = created.message || 'Could not start Cashfree payment';
        const transactionsDisabled =
          created.status === 'PG_TRANSACTIONS_DISABLED' ||
          /transactions are not enabled/i.test(cfMsg);
        console.warn(`💳 [TOPUP] Cashfree PG failed phone=${phone}: ${cfMsg}`);

        // Explicit opt-in only — lets us test wallet UX while Cashfree PG go-live is pending
        if (transactionsDisabled && isDevWalletCreditAllowed()) {
          const credit = Math.min(amount, 5000);
          user.walletBalance = (Number(user.walletBalance) || 0) + credit;
          user.payouts = user.payouts || [];
          user.payouts.unshift({
            shiftId: '',
            brand: 'Frenvi',
            role: 'Wallet top-up (DEV)',
            amount: credit,
            hours: 0,
            paidAt: new Date(),
            note: 'DEV credit — Cashfree PG transactions not enabled'
          });
          await user.save();
          console.warn(
            `⚠️ [TOPUP] DEV credit phone=${phone} amount=₹${credit} (ALLOW_DEV_WALLET_CREDIT=true). Turn this OFF after Cashfree PG is live.`
          );
          return res.json({
            success: true,
            message: `₹${credit} added (dev mode — Cashfree live payments not enabled yet)`,
            data: {
              orderId: `dev_${Date.now()}`,
              paymentSessionId: null,
              amount: credit,
              mode: 'dev',
              walletBalance: Number(user.walletBalance) || 0,
              checkout: false,
              simulated: true
            }
          });
        }

        return res.status(400).json({
          success: false,
          code: transactionsDisabled ? 'PG_TRANSACTIONS_DISABLED' : 'PG_ORDER_FAILED',
          message: transactionsDisabled
            ? 'Cashfree Payments is not activated for live transactions yet. In Cashfree Merchant Dashboard → complete PG activation / go-live, enable UPI & cards. Or set ALLOW_DEV_WALLET_CREDIT=true for temporary test credits, or switch CASHFREE_PG_ENV=sandbox with TEST keys.'
            : cfMsg,
          cashfree: created.cashfree || null,
          help: transactionsDisabled
            ? {
                dashboard: 'https://merchant.cashfree.com/merchant/login',
                docs: 'https://www.cashfree.com/docs/help/account/account-activation',
                sandboxTip:
                  'Developers → API Keys → copy TEST keys, set CASHFREE_PG_ENV=sandbox and CASHFREE_PG_BASE_URL=https://sandbox.cashfree.com/pg'
              }
            : undefined
        });
      }

      user.pendingTopups = user.pendingTopups || [];
      user.pendingTopups.unshift({
        orderId: created.orderId,
        amount: created.orderAmount,
        status: 'PENDING',
        createdAt: new Date(),
        paidAt: null
      });
      user.pendingTopups = user.pendingTopups.slice(0, 20);
      await user.save();

      console.log(
        `💳 [TOPUP] order created phone=${phone} order=${created.orderId} amount=₹${created.orderAmount}`
      );

      return res.json({
        success: true,
        message: 'Open Cashfree to pay',
        data: {
          orderId: created.orderId,
          paymentSessionId: created.paymentSessionId,
          amount: created.orderAmount,
          mode: created.mode || getPgMode(),
          walletBalance: Number(user.walletBalance) || 0,
          checkout: true
        }
      });
    } catch (err) {
      console.error('topUpWallet error:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Server error starting payment'
      });
    }
  },

  /**
   * POST /api/users/wallet/topup/confirm
   * After Cashfree checkout success — verify order PAID then credit wallet once.
   * Body: { phone, orderId }
   */
  async confirmTopUp(req, res) {
    try {
      const phone = resolvePhone(req);
      const orderId = String(req.body.orderId || req.body.order_id || '').trim();
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!orderId) {
        return res.status(400).json({ success: false, message: 'orderId required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }

      const out = await verifyAndCreditTopup(orderId, phone);
      if (!out.success) {
        const status = out.code === 'PAYMENT_PENDING' ? 402 : 400;
        return res.status(status).json({
          success: false,
          code: out.code || 'CONFIRM_FAILED',
          message: out.message || 'Could not confirm payment',
          data: { orderId, orderStatus: out.orderStatus }
        });
      }

      return res.json({
        success: true,
        message: out.message,
        data: out.data
      });
    } catch (err) {
      console.error('confirmTopUp error:', err);
      return res.status(500).json({ success: false, message: 'Server error confirming payment' });
    }
  },

  /**
   * POST /api/users/wallet/topup/sync
   * Re-check PENDING Cashfree top-ups and credit any that are already PAID.
   * Recovers cases where UPI succeeded but the app never called confirm.
   */
  async syncTopUps(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const synced = await syncPendingTopupsForUser(user);
      const creditedAmount = (synced.credited || []).reduce(
        (sum, row) => sum + (row.credited ? Number(row.amount) || 0 : 0),
        0
      );

      return res.json({
        success: true,
        message: creditedAmount > 0
          ? `₹${creditedAmount} added to wallet`
          : 'Wallet up to date',
        data: {
          walletBalance: synced.walletBalance,
          credited: synced.credited,
          amount: creditedAmount
        }
      });
    } catch (err) {
      console.error('syncTopUps error:', err);
      return res.status(500).json({ success: false, message: 'Server error syncing payments' });
    }
  },

  /** Simple browser return page after Cashfree redirect (WebView / desktop) */
  async topUpReturn(req, res) {
    const orderId = String(req.query.order_id || req.query.orderId || '');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title>
<style>
  body{font-family:system-ui,sans-serif;padding:28px 20px;text-align:center;background:#0f172a;color:#fff;min-height:100vh;margin:0;box-sizing:border-box}
  h2{font-size:22px;margin:12px 0 8px}
  p{opacity:.75;font-size:14px;line-height:1.5}
  .amt{font-size:34px;font-weight:800;margin:18px 0 6px}
</style></head>
<body>
  <h2>Payment done</h2>
  <p>Updating your Frenvi wallet…</p>
  <p style="font-size:12px;opacity:.5">Order: ${orderId || '—'}</p>
  <script>
    (function(){
      var orderId = ${JSON.stringify(orderId)};
      try {
        if (window.Android && window.Android.onPaymentReturn) {
          window.Android.onPaymentReturn(orderId);
        }
      } catch (e) {}
      try {
        if (window.opener && window.opener.LiveData && window.opener.LiveData.onPaymentReturn) {
          window.opener.LiveData.onPaymentReturn(orderId);
        }
      } catch (e) {}
      try {
        window.parent && window.parent.postMessage({ type: 'FRENVI_TOPUP_RETURN', orderId: orderId }, '*');
      } catch (e) {}
      setTimeout(function(){ try { window.close(); } catch(e) {} }, 900);
    })();
  </script>
</body></html>`);
  },

  async getNotifications(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      const user = await findUser(phone);
      if (!user) {
        return res.json({ success: true, data: [] });
      }
      const list = (user.notifications || [])
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((n) => ({
          id: String(n._id),
          title: n.title,
          body: n.body,
          type: n.type,
          unread: !!n.unread,
          createdAt: n.createdAt
        }));
      return res.json({ success: true, data: list });
    } catch (err) {
      console.error('getNotifications error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async clearNotifications(req, res) {
    try {
      const phone = resolvePhone(req);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      await User.updateOne({ phone }, { $set: { notifications: [] } });
      return res.json({ success: true, message: 'Notifications cleared' });
    } catch (err) {
      console.error('clearNotifications error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async getMyAcceptedShifts(req, res) {
    try {
      const phone = resolvePhone(req);
      const tab = String(req.query.tab || 'upcoming');
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Valid phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline', data: [] });
      }

      let query = { acceptedBy: phone };
      if (tab === 'cancelled') query.status = 'CANCELLED';
      else if (tab === 'past') query.status = 'FILLED';
      else query.status = { $in: ['FILLED', 'LIVE', 'SCHEDULED'] };

      // upcoming = accepted but treat FILLED as past; LIVE/SCHEDULED/FILLED accepted recently as upcoming if not past tab
      if (tab === 'upcoming') {
        query = {
          acceptedBy: phone,
          status: { $in: ['LIVE', 'SCHEDULED', 'FILLED'] }
        };
      }

      let shifts = await Shift.find(query).sort({ acceptedAt: -1, createdAt: -1 }).limit(50).lean();
      if (tab === 'upcoming') {
        shifts = shifts.filter((s) => s.status !== 'FILLED' || s.date === 'Today' || s.date === 'Tomorrow');
      }
      if (tab === 'past') {
        shifts = await Shift.find({ acceptedBy: phone, status: 'FILLED' })
          .sort({ acceptedAt: -1 })
          .limit(50)
          .lean();
      }

      return res.json({
        success: true,
        data: shifts.map((s) => {
          const { startOtp, ...safe } = s;
          return {
            ...safe,
            id: String(s._id),
            photo: s.outletPhoto || s.logoUrl || '',
            logoUrl: s.logoUrl || s.outletPhoto || '',
            workStatus: s.workStatus || 'NONE',
            doerArrivedAt: s.doerArrivedAt || null,
            workStartedAt: s.workStartedAt || null,
            // OTP only returned from /arrive after geofence — never list it here
            canCheckIn:
              !!s.acceptedBy &&
              s.workStatus !== 'IN_PROGRESS' &&
              s.workStatus !== 'COMPLETED' &&
              ['LIVE', 'SCHEDULED', 'FILLED'].includes(s.status)
          };
        })
      });
    } catch (err) {
      console.error('getMyAcceptedShifts error:', err);
      return res.status(500).json({ success: false, message: 'Server error', data: [] });
    }
  }
};

module.exports = userDataController;
