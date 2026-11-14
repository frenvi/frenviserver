/**
 * Probe Cashfree Payment Gateway + optional Frenvi top-up API.
 *
 * Usage:
 *   node scripts/test-cashfree-pg.js
 *   node scripts/test-cashfree-pg.js --phone=7396514989 --amount=25
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const {
  isPgConfigured,
  getPgBaseUrl,
  getPgMode,
  isDevWalletCreditAllowed
} = require('../src/config/cashfreePg');
const { createTopupOrder } = require('../src/services/cashfreePg');

function arg(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function main() {
  console.log('=== Cashfree PG probe ===');
  console.log({
    configured: isPgConfigured(),
    mode: getPgMode(),
    base: getPgBaseUrl(),
    allowDevCredit: isDevWalletCreditAllowed(),
    clientIdPrefix: String(process.env.CASHFREE_PG_CLIENT_ID || '').slice(0, 10) + '…'
  });

  const phone = String(arg('phone', '9999999999')).replace(/\D/g, '').slice(-10);
  const amount = Number(arg('amount', '1')) || 1;

  console.log('\n--- createTopupOrder ---');
  const created = await createTopupOrder({
    phone,
    amount,
    customerName: 'PG Probe'
  });
  console.log(JSON.stringify(created, null, 2));

  if (created.success) {
    console.log('\n✅ PG order created — checkout popup can open with paymentSessionId.');
    process.exitCode = 0;
    return;
  }

  if (created.status === 'PG_TRANSACTIONS_DISABLED') {
    console.log('\n❌ Live PG transactions are NOT enabled on this Cashfree account.');
    console.log('Fix options:');
    console.log('  1) Cashfree Merchant Dashboard → activate Payment Gateway / go-live');
    console.log('  2) Use TEST keys + CASHFREE_PG_ENV=sandbox for sandbox checkout testing');
    console.log('  3) Set ALLOW_DEV_WALLET_CREDIT=true for temporary Frenvi wallet test credits');
    if (isDevWalletCreditAllowed()) {
      console.log('\nALLOW_DEV_WALLET_CREDIT=true → /api/users/wallet/topup will credit wallet in DEV mode.');
    }
    process.exitCode = 2;
    return;
  }

  console.log('\n❌ PG order failed:', created.message);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
