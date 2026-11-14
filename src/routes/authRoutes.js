const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');

// POST /api/auth/send-otp
router.post('/send-otp', authController.sendOtp);

// POST /api/auth/verify-otp
router.post('/verify-otp', authController.verifyOtp);

// POST /api/auth/bootstrap  { phone } — upgrade old local sessions (while ALLOW_PHONE_AUTH)
router.post('/bootstrap', authController.bootstrap);

// POST /api/auth/refresh  { refreshToken } — new access token without OTP
router.post('/refresh', authController.refresh);

// GET /api/auth/profile — JWT / phone auth
router.get('/profile', requireAuth, authController.getProfile);

// Staff desk login (admin / marketing / boarding)
router.get('/staff-directory', authController.getStaffDirectory);
router.post('/staff-login', authController.staffLogin);

module.exports = router;
