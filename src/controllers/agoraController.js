const { generateRtcToken } = require('../config/agora');

const agoraController = {
  /**
   * GET /api/agora/token
   * Query params:
   *  - channelName (required): e.g. frenvi_assessment_room_123
   *  - role: 'publisher' | 'subscriber' (default: 'publisher')
   *  - uid: numeric user ID or 0
   */
  async getRtcToken(req, res) {
    try {
      const channelName = req.query.channelName || req.body.channelName;
      if (!channelName) {
        return res.status(400).json({ success: false, message: 'channelName is required' });
      }

      const role = req.query.role || req.body.role || 'publisher';
      const uid = req.query.uid || req.body.uid || Math.floor(100000 + Math.random() * 900000);

      const tokenData = generateRtcToken(channelName, uid, role, 3600);

      return res.json({
        success: true,
        data: tokenData
      });
    } catch (err) {
      console.error('Error generating Agora token:', err);
      return res.status(500).json({ success: false, message: 'Failed to generate video call token' });
    }
  }
};

module.exports = agoraController;
