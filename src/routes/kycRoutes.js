const express = require('express');
const router = express.Router();
const digilockerKycController = require('../controllers/digilockerKycController');
const { requireAuth } = require('../middleware/auth');

// User-facing KYC (JWT)
router.get('/status', requireAuth, digilockerKycController.getStatus);
router.post('/digilocker/start', requireAuth, digilockerKycController.start);
router.get('/digilocker/status', requireAuth, digilockerKycController.pollStatus);

// External provider callbacks — must stay public
router.get('/digilocker/callback', digilockerKycController.callback);
router.post('/webhooks/digilocker', digilockerKycController.webhook);

module.exports = router;
