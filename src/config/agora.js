const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

/**
 * Generates an Agora RTC Token for video calling.
 *
 * @param {string} channelName - Name of the assessment video room channel.
 * @param {number|string} uid - Unique user ID (0 generates an automatic UID).
 * @param {string} role - 'publisher' (camera+mic) or 'subscriber' (listen/view only).
 * @param {number} expireTimeInSeconds - Token validity in seconds (default: 3600 = 1 hour).
 * @returns {object} { token, channelName, uid, appId }
 */
function generateRtcToken(channelName, uid = 0, role = 'publisher', expireTimeInSeconds = 3600) {
  const appId = process.env.AGORA_APP_ID || 'TEST_AGORA_APP_ID';
  const appCertificate = process.env.AGORA_APP_CERTIFICATE || '';

  const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expireTimeInSeconds;

  let token = null;
  const numericUid = Number(uid) || 0;

  // If valid App Certificate is provided, generate cryptographic token
  if (appCertificate && appCertificate !== 'YOUR_AGORA_APP_CERTIFICATE') {
    try {
      token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        numericUid,
        rtcRole,
        privilegeExpiredTs
      );
    } catch (err) {
      console.error('Error generating Agora cryptographic token:', err);
      token = null;
    }
  }

  return {
    appId,
    token,
    channelName,
    uid: numericUid,
    role,
    expiresAt: privilegeExpiredTs
  };
}

module.exports = { generateRtcToken };
