/**
 * smslogin.co (DLT) SMS gateway config
 */
function isSmsConfigured() {
  const user = process.env.SMS_USERNAME || '';
  const key = process.env.SMS_API_KEY || '';
  return Boolean(user && key && key !== 'YOUR_SMS_API_KEY');
}

function getSmsConfig() {
  return {
    username: process.env.SMS_USERNAME || 'FRENVI',
    apiKey: process.env.SMS_API_KEY || '',
    senderId: process.env.SMS_SENDER_ID || 'FRENVI',
    baseUrl: (process.env.SMS_API_BASE_URL || 'https://smslogin.co/v3/api.php').replace(/\/$/, ''),
    // When true, /auth/send-otp also returns otp in JSON (local/dev only)
    returnOtpInResponse:
      String(process.env.SMS_RETURN_OTP || '').toLowerCase() === 'true' ||
      String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
  };
}

/** Approved DLT template IDs from smslogin (download_templates.csv) */
const SMS_TEMPLATES = {
  LOGIN_OTP: process.env.SMS_TEMPLATE_LOGIN_OTP || '1707175134658245813',
  ASSESSMENT_PASS: process.env.SMS_TEMPLATE_ASSESSMENT_PASS || '1707174740300251188',
  ASSESSMENT_FAIL: process.env.SMS_TEMPLATE_ASSESSMENT_FAIL || '1707174860567860796',
  BOON_ACCEPTED: process.env.SMS_TEMPLATE_BOON_ACCEPTED || '1707172544770793415',
  BOON_REMINDER: process.env.SMS_TEMPLATE_BOON_REMINDER || '1707172544255738725',
  PAYMENT_DONE: process.env.SMS_TEMPLATE_PAYMENT_DONE || '1707172544248402828',
  START_OTP: process.env.SMS_TEMPLATE_START_OTP || '1707175698863506722',
  TASK_NEAR_YOU: process.env.SMS_TEMPLATE_TASK_NEAR_YOU || '1707173873682040270'
};

module.exports = {
  isSmsConfigured,
  getSmsConfig,
  SMS_TEMPLATES
};
