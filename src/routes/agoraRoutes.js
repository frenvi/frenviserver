const express = require('express');
const router = express.Router();
const agoraController = require('../controllers/agoraController');

// GET /api/agora/token?channelName=...&uid=...&role=publisher
router.get('/token', agoraController.getRtcToken);

// POST /api/agora/token
router.post('/token', agoraController.getRtcToken);

module.exports = router;
