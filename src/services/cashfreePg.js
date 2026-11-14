const {
  isPgConfigured,
  getPgBaseUrl,
  getPgMode,
  getPgAuthHeaders,
  getPublicReturnUrl
} = require('../config/cashfreePg');

async function pgFetch(path, { method = 'GET', body } = {}) {
  if (!isPgConfigured()) {
    const err = new Error('Cashfree Payment Gateway is not configured');
    err.code = 'pg_not_configured';
    err.status = 503;
    throw err;
  }
  const url = `${getPgBaseUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: getPgAuthHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  let json = {};
  try {
    json = await res.json();
  } catch (_) {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

function makeOrderId(phone) {
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  return `frenvi_${p}_${Date.now()}`;
}

/**
 * Create a Cashfree PG order for wallet top-up.
 */
async function createTopupOrder({ phone, amount, customerName, returnUrl }) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) {
    return { success: false, status: 'INVALID', message: 'Enter an amount greater than 0' };
  }
  const orderId = makeOrderId(phone);
  // Production Cashfree requires HTTPS return_url. Modal checkout confirms via API anyway.
  const httpsReturn = returnUrl || getPublicReturnUrl();

  const payload = {
    order_id: orderId,
    order_amount: amt,
    order_currency: 'INR',
    customer_details: {
      customer_id: `worker_${String(phone).replace(/\D/g, '').slice(-10)}`,
      customer_phone: String(phone).replace(/\D/g, '').slice(-10),
      customer_name: customerName || 'Frenvi Worker'
    },
    order_note: 'Frenvi wallet top-up',
    order_meta: {
      return_url: httpsReturn
    }
  };

  const { ok, status, json } = await pgFetch('/orders', { method: 'POST', body: payload });
  console.log(`💳 [CASHFREE-PG] create-order mode=${getPgMode()} status=${status} body=${JSON.stringify(json)}`);

  if (!ok || !json.payment_session_id) {
    const msg =
      (json && (json.message || (json.error && json.error.message))) ||
      'Could not start Cashfree payment';
    const transactionsDisabled = /transactions are not enabled/i.test(String(msg));
    return {
      success: false,
      status: transactionsDisabled ? 'PG_TRANSACTIONS_DISABLED' : 'FAILED',
      message: msg,
      cashfree: json
    };
  }

  return {
    success: true,
    status: 'ACTIVE',
    mode: getPgMode(),
    orderId: json.order_id || orderId,
    paymentSessionId: json.payment_session_id,
    orderAmount: Number(json.order_amount) || amt,
    orderCurrency: json.order_currency || 'INR',
    raw: json
  };
}

/**
 * Fetch order status from Cashfree PG.
 */
async function getOrder(orderId) {
  const id = encodeURIComponent(String(orderId || ''));
  const { ok, status, json } = await pgFetch(`/orders/${id}`, { method: 'GET' });
  console.log(`💳 [CASHFREE-PG] get-order ${orderId} status=${status} order_status=${json.order_status || ''}`);
  if (!ok) {
    return {
      success: false,
      message: (json && json.message) || 'Could not fetch payment status',
      cashfree: json
    };
  }
  return {
    success: true,
    orderId: json.order_id,
    orderStatus: json.order_status,
    orderAmount: Number(json.order_amount) || 0,
    paymentSessionId: json.payment_session_id,
    raw: json
  };
}

module.exports = {
  createTopupOrder,
  getOrder,
  isPgConfigured,
  getPgMode
};
