const express = require('express');
const router = express.Router();
const shiftController = require('../controllers/shiftController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

// Public browse — optional JWT so personalized filters can use auth phone later
router.get('/', optionalAuth, shiftController.getShifts);

// Admin boon review (staff panel)
router.get('/admin/pending', shiftController.getPendingReview);
router.put('/admin/:id', shiftController.adminUpdateShift);
router.post('/admin/:id/approve', shiftController.approveShift);
router.post('/admin/:id/reject', shiftController.rejectShift);
router.post('/admin/:id/feedback', shiftController.sendBoonFeedback);

// Account-bound shift actions
router.get('/mine', requireAuth, shiftController.getMyShifts);
router.put('/:id', requireAuth, shiftController.updateMyShift);
router.post('/', requireAuth, shiftController.createShift);
router.post('/accept', requireAuth, shiftController.acceptShift);
router.post('/:id/arrive', requireAuth, shiftController.arriveAtShift);
router.post('/:id/confirm-start', requireAuth, shiftController.confirmStart);

module.exports = router;
