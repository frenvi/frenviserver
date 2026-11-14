const User = require('../models/User');
const { getOrder } = require('./cashfreePg');

const PAID = new Set(['PAID', 'SUCCESS']);

function phoneFromOrderId(orderId) {
  const m = String(orderId || '').match(/^frenvi_(\d{10})_/);
  return m ? m[1] : '';
}

/**
 * Idempotently credit a user's wallet for a Cashfree-paid top-up order.
 */
async function creditPaidTopup({ user, orderId, amount }) {
  const id = String(orderId || '').trim();
  const amt = Math.round(Number(amount) || 0);
  if (!user || !id || !(amt > 0)) {
    return { credited: false, reason: 'invalid', walletBalance: Number(user && user.walletBalance) || 0 };
  }

  user.pendingTopups = user.pendingTopups || [];
  let pending = user.pendingTopups.find((t) => t.orderId === id);

  if (pending && pending.status === 'PAID') {
    return {
      credited: false,
      alreadyPaid: true,
      amount: pending.amount,
      walletBalance: Number(user.walletBalance) || 0,
      orderId: id
    };
  }

  // Extra safety: same order note already in payouts
  const note = `Cashfree · ${id}`;
  const alreadyInPayouts = (user.payouts || []).some((p) => String(p.note || '') === note);
  if (alreadyInPayouts) {
    if (pending) {
      pending.status = 'PAID';
      pending.paidAt = pending.paidAt || new Date();
      await user.save();
    }
    return {
      credited: false,
      alreadyPaid: true,
      amount: amt,
      walletBalance: Number(user.walletBalance) || 0,
      orderId: id
    };
  }

  user.walletBalance = (Number(user.walletBalance) || 0) + amt;
  user.payouts = user.payouts || [];
  user.payouts.unshift({
    shiftId: '',
    brand: 'Frenvi',
    role: 'Wallet top-up',
    amount: amt,
    hours: 0,
    paidAt: new Date(),
    note
  });

  if (pending) {
    pending.status = 'PAID';
    pending.paidAt = new Date();
    pending.amount = amt;
  } else {
    user.pendingTopups.unshift({
      orderId: id,
      amount: amt,
      status: 'PAID',
      createdAt: new Date(),
      paidAt: new Date()
    });
  }
  user.pendingTopups = user.pendingTopups.slice(0, 20);
  await user.save();

  console.log(`✅ [TOPUP] credited phone=${user.phone} order=${id} amount=₹${amt}`);
  return {
    credited: true,
    amount: amt,
    walletBalance: Number(user.walletBalance) || 0,
    orderId: id
  };
}

/**
 * Verify order with Cashfree and credit if PAID.
 * Finds user by phone arg, orderId phone segment, or pendingTopups lookup.
 */
async function verifyAndCreditTopup(orderId, phoneHint) {
  const id = String(orderId || '').trim();
  if (!id) return { success: false, message: 'orderId required' };

  const order = await getOrder(id);
  if (!order.success) {
    return { success: false, message: order.message || 'Could not verify payment', orderStatus: null };
  }

  const status = String(order.orderStatus || '').toUpperCase();
  if (!PAID.has(status)) {
    return {
      success: false,
      code: 'PAYMENT_PENDING',
      message: `Payment not completed yet (status: ${order.orderStatus || 'UNKNOWN'})`,
      orderStatus: order.orderStatus,
      orderId: id
    };
  }

  const amount = Math.round(Number(order.orderAmount) || 0);
  if (!(amount > 0)) {
    return { success: false, message: 'Invalid paid amount' };
  }

  let phone = String(phoneHint || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) phone = phoneFromOrderId(id);

  let user = phone.length === 10 ? await User.findOne({ phone }) : null;
  if (!user) {
    user = await User.findOne({ 'pendingTopups.orderId': id });
  }
  if (!user) {
    return { success: false, message: 'User not found for this order', orderId: id };
  }

  const result = await creditPaidTopup({ user, orderId: id, amount });
  return {
    success: true,
    message: result.credited
      ? `₹${result.amount} added to wallet`
      : 'Already credited',
    data: {
      walletBalance: result.walletBalance,
      amount: result.amount,
      orderId: id,
      credited: !!result.credited,
      alreadyPaid: !!result.alreadyPaid,
      taskFeePending: Number(user.taskFeePending) || 0
    }
  };
}

/**
 * Re-check all PENDING top-ups for a user (recovers payments that succeeded but never confirmed).
 */
async function syncPendingTopupsForUser(user) {
  if (!user) return { credited: [], walletBalance: 0 };
  const pending = (user.pendingTopups || []).filter((t) => t.status === 'PENDING');
  const credited = [];
  for (const item of pending) {
    const out = await verifyAndCreditTopup(item.orderId, user.phone);
    if (out.success && out.data && (out.data.credited || out.data.alreadyPaid)) {
      credited.push(out.data);
    }
  }
  const fresh = await User.findById(user._id).lean();
  return {
    credited,
    walletBalance: Number((fresh && fresh.walletBalance) || user.walletBalance) || 0
  };
}

module.exports = {
  phoneFromOrderId,
  creditPaidTopup,
  verifyAndCreditTopup,
  syncPendingTopupsForUser
};
