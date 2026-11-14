const express = require('express');
const router = express.Router();
const userDataController = require('../controllers/userDataController');
const { requireAuth } = require('../middleware/auth');

// Cashfree browser return — no JWT (payment redirect)
router.get('/wallet/topup/return', userDataController.topUpReturn);

// All account data requires auth (JWT preferred; phone fallback while ALLOW_PHONE_AUTH=true)
router.get('/me', requireAuth, userDataController.getMe);
router.patch('/me', requireAuth, userDataController.updateMe);
router.get('/wallet', requireAuth, userDataController.getWallet);
router.post('/wallet/settle-fees', requireAuth, userDataController.settleTaskFees);
router.post('/wallet/topup', requireAuth, userDataController.topUpWallet);
router.post('/wallet/topup/confirm', requireAuth, userDataController.confirmTopUp);
router.post('/wallet/topup/sync', requireAuth, userDataController.syncTopUps);
router.get('/notifications', requireAuth, userDataController.getNotifications);
router.post('/notifications/clear', requireAuth, userDataController.clearNotifications);
router.get('/my-shifts', requireAuth, userDataController.getMyAcceptedShifts);

module.exports = router;
