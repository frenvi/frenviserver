const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { requireAuth } = require('../middleware/auth');

// Public catalog / scheduling helpers
router.get('/designations', assessmentController.getDesignations);
router.get('/dates', assessmentController.getDates);
router.get('/slots', assessmentController.getSlots);

// User-bound assessment actions
router.get('/status', requireAuth, assessmentController.getStatus);
router.post('/book', requireAuth, assessmentController.createBooking);
router.post('/reschedule', requireAuth, assessmentController.rescheduleBooking);
router.post('/cancel', requireAuth, assessmentController.cancelBooking);
router.post('/instant', requireAuth, assessmentController.startInstant);

// Assessor / boarding (staff apps — still phone/body based for now)
router.post('/accept', assessmentController.acceptInstant);
router.get('/admin/dashboard', assessmentController.getAssessorDashboard);
router.get('/admin/monitor', assessmentController.getMonitorStats);

module.exports = router;
