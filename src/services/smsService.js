const { isSmsConfigured, getSmsConfig, SMS_TEMPLATES } = require('../config/sms');

function normalizeMobile(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function fillTemplate(template, vars) {
  let i = 0;
  return String(template).replace(/\{#var#\}/g, () => {
    const v = vars[i++];
    return v == null ? '' : String(v);
  });
}

/** Exact DLT body for login OTP (template 1707175134658245813) */
function buildLoginOtpMessage(otp) {
  return (
    '<#> Hey there! Your Frenvi verification code is ' +
    String(otp) +
    '. This secret code is just for you, so keep it safe and don’t share it with anyone. Thanks for being awesome! FR0a1r5'
  );
}

function buildAssessmentPassMessage(percentage, resultLabel) {
  return fillTemplate(
    'Your assessment is done. You got {#var#} percentage. Result:{#var#}. Newbie (31–70): Start small, learn fast, grow strong. Skilled (71–100): Great work! Premium tasks unlocked. Open the Frenvi app to begin. Team Frenvi.',
    [percentage, resultLabel]
  );
}

function buildAssessmentFailMessage(percentage) {
  return fillTemplate(
    'Your assessment is done. You got {#var#} percentage. Result: Below 30.No problem—everyone starts somewhere. You can try again after 48 hours. We will message you when its time. Keep learning and improving! you.Team Frenvi.',
    [percentage]
  );
}

function buildBoonAcceptedMessage(boonName) {
  return fillTemplate(
    "Great news! You've accepted the boon {#var#}. Review details and use in-app navigation. Team Frenvi.",
    [boonName]
  );
}

function buildBoonReminderMessage(boonName, timeLabel) {
  return fillTemplate(
    'Reminder: Your boon {#var#} is about to start in {#var#} time. Make sure everything is ready. Use the in-app navigation for directions. Team Frenvi.',
    [boonName, timeLabel]
  );
}

function buildPaymentDoneMessage(amount, boonName) {
  return fillTemplate(
    'Your payment of ₹{#var#} for boon {#var#} has been processed successfully. Check your account for details. Team Frenvi.',
    [amount, boonName]
  );
}

function buildStartOtpMessage(otp) {
  return fillTemplate(
    '<#> Hey there! Share this START OTP {#var#} with Frenvi Doer to Start your boon. Thanks for being Awesome!',
    [otp]
  );
}

function buildTaskNearYouMessage(taskLabel) {
  return fillTemplate('{#var#} Task has Been Posted In Your Location. Team Frenvi.', [taskLabel]);
}

/**
 * Low-level send via smslogin.co HTTP API.
 * @returns {{ success: boolean, messageId?: string, raw?: string, message?: string, skipped?: boolean }}
 */
async function sendSms({ mobile, message, templateId }) {
  if (!isSmsConfigured()) {
    return {
      success: false,
      skipped: true,
      message: 'SMS gateway not configured (set SMS_USERNAME + SMS_API_KEY)'
    };
  }

  const phone = normalizeMobile(mobile);
  if (phone.length !== 10) {
    return { success: false, message: 'Valid 10-digit mobile required' };
  }
  if (!message || !templateId) {
    return { success: false, message: 'message and templateId required' };
  }

  const cfg = getSmsConfig();
  const url = new URL(cfg.baseUrl);
  url.searchParams.set('username', cfg.username);
  url.searchParams.set('apikey', cfg.apiKey);
  url.searchParams.set('senderid', cfg.senderId);
  url.searchParams.set('mobile', phone);
  url.searchParams.set('message', message);
  url.searchParams.set('templateid', String(templateId));

  try {
    const res = await fetch(url.toString(), { method: 'GET' });
    const raw = (await res.text()).trim();
    const lower = raw.toLowerCase();
    const failed =
      !res.ok ||
      /error|invalid|fail|denied|insufficient|unauthor/i.test(lower) ||
      lower === '0' ||
      lower === 'false';

    if (failed) {
      console.warn(`📱 [SMS] send failed phone=${phone} template=${templateId} raw=${raw.slice(0, 200)}`);
      return { success: false, message: raw || 'SMS send failed', raw };
    }

    console.log(`📱 [SMS] sent phone=${phone} template=${templateId} id=${raw.slice(0, 80)}`);
    return { success: true, messageId: raw, raw };
  } catch (err) {
    console.error('📱 [SMS] network error:', err.message);
    return { success: false, message: err.message || 'SMS network error' };
  }
}

async function sendLoginOtp(phone, otp) {
  return sendSms({
    mobile: phone,
    message: buildLoginOtpMessage(otp),
    templateId: SMS_TEMPLATES.LOGIN_OTP
  });
}

async function sendAssessmentResult(phone, percentage) {
  const pct = Math.round(Number(percentage) || 0);
  if (pct < 30) {
    return sendSms({
      mobile: phone,
      message: buildAssessmentFailMessage(pct),
      templateId: SMS_TEMPLATES.ASSESSMENT_FAIL
    });
  }
  const label = pct >= 71 ? 'Skilled' : 'Newbie';
  return sendSms({
    mobile: phone,
    message: buildAssessmentPassMessage(pct, label),
    templateId: SMS_TEMPLATES.ASSESSMENT_PASS
  });
}

async function sendBoonAccepted(phone, boonName) {
  return sendSms({
    mobile: phone,
    message: buildBoonAcceptedMessage(boonName || 'task'),
    templateId: SMS_TEMPLATES.BOON_ACCEPTED
  });
}

async function sendBoonReminder(phone, boonName, timeLabel) {
  return sendSms({
    mobile: phone,
    message: buildBoonReminderMessage(boonName || 'task', timeLabel || 'soon'),
    templateId: SMS_TEMPLATES.BOON_REMINDER
  });
}

async function sendPaymentDone(phone, amount, boonName) {
  return sendSms({
    mobile: phone,
    message: buildPaymentDoneMessage(amount, boonName || 'task'),
    templateId: SMS_TEMPLATES.PAYMENT_DONE
  });
}

async function sendStartOtp(phone, otp) {
  return sendSms({
    mobile: phone,
    message: buildStartOtpMessage(otp),
    templateId: SMS_TEMPLATES.START_OTP
  });
}

async function sendTaskNearYou(phone, taskLabel) {
  return sendSms({
    mobile: phone,
    message: buildTaskNearYouMessage(taskLabel || 'New'),
    templateId: SMS_TEMPLATES.TASK_NEAR_YOU
  });
}

async function getCreditBalance() {
  if (!isSmsConfigured()) {
    return { success: false, message: 'SMS not configured' };
  }
  const cfg = getSmsConfig();
  const url = new URL(cfg.baseUrl);
  url.searchParams.set('username', cfg.username);
  url.searchParams.set('apikey', cfg.apiKey);
  try {
    const res = await fetch(url.toString(), { method: 'GET' });
    const raw = (await res.text()).trim();
    return { success: res.ok, credits: raw, raw };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = {
  SMS_TEMPLATES,
  isSmsConfigured,
  sendSms,
  sendLoginOtp,
  sendAssessmentResult,
  sendBoonAccepted,
  sendBoonReminder,
  sendPaymentDone,
  sendStartOtp,
  sendTaskNearYou,
  getCreditBalance,
  buildLoginOtpMessage
};
