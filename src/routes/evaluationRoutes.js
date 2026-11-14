const express = require('express');
const router = express.Router();
const evaluationController = require('../controllers/evaluationController');

// POST /api/evaluations
router.post('/', evaluationController.submitEvaluation);

// GET /api/evaluations/user/:identifier
router.get('/user/:identifier', evaluationController.getUserEvaluation);

// GET /api/evaluations/all
router.get('/all', evaluationController.getAllEvaluations);

module.exports = router;
