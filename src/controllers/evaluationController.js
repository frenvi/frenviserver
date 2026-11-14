const Evaluation = require('../models/Evaluation');
const Assessment = require('../models/Assessment');
const User = require('../models/User');
const Shift = require('../models/Shift');
const { isConnected } = require('../config/db');
const assessmentController = require('./assessmentController');
const { sendAssessmentResult } = require('../services/smsService');

// Fallback in-memory evaluations store
const fallbackEvaluations = {};

const UNLOCKED_SHIFTS_CATALOG = [
  { brand: 'Burger King', role: 'Counter & Kitchen Crew', pay: '₹850 / shift', rating: '4.8 ★' },
  { brand: 'Starbucks Coffee', role: 'Barista Specialist', pay: '₹1,150 / shift', rating: '4.9 ★' },
  { brand: 'Zara Fashion', role: 'Store Floor Associate', pay: '₹1,000 / shift', rating: '4.9 ★' },
  { brand: 'Blinkit Hub', role: 'Rapid Order Dispatcher', pay: '₹950 / shift', rating: '4.7 ★' },
  { brand: 'Domino\'s Pizza', role: 'Customer Host & Dispatch', pay: '₹820 / shift', rating: '4.8 ★' }
];

const evaluationController = {
  /**
   * POST /api/evaluations
   * Assessor submits candidate evaluation marks.
   */
  async submitEvaluation(req, res) {
    try {
      const {
        assessmentId,
        userPhone,
        userId,
        assessorName,
        scores, // { communication, scenarioHandling, hygieneSafety, reliability }
        feedback
      } = req.body;

      if (!scores) {
        return res.status(400).json({ success: false, message: 'Evaluation scores are required' });
      }

      const communication = Math.max(0, Math.min(25, Number(scores.communication || 0)));
      const scenarioHandling = Math.max(0, Math.min(25, Number(scores.scenarioHandling || 0)));
      const hygieneSafety = Math.max(0, Math.min(25, Number(scores.hygieneSafety || 0)));
      const reliability = Math.max(0, Math.min(25, Number(scores.reliability || 0)));

      const totalScore = communication + scenarioHandling + hygieneSafety + reliability;

      let grade = 'Grade B';
      let skillBadge = 'Certified Associate';
      let passed = true;

      if (totalScore >= 90) {
        grade = 'Grade A';
        skillBadge = 'Certified Senior Dining & Retail Specialist';
      } else if (totalScore >= 80) {
        grade = 'Grade A';
        skillBadge = 'Certified Store & Dining Specialist';
      } else if (totalScore >= 70) {
        grade = 'Grade B';
        skillBadge = 'Certified Associate Specialist';
      } else {
        grade = 'Grade C';
        skillBadge = 'Assessment Retake Required';
        passed = false;
      }

      const unlocked = passed ? UNLOCKED_SHIFTS_CATALOG : [];

      let evaluationRecord = null;
      let targetUser = null;
      let targetAssessment = null;

      const persistSkill = (phone, record) => {
        if (!phone || !record) return;
        fallbackEvaluations[phone] = record;
        const store = assessmentController.fallbackStore;
        if (store) {
          store.evaluations[phone] = {
            score: record.totalScore,
            totalScore: record.totalScore,
            grade: record.grade,
            skillBadge: record.skillBadge,
            evaluatedBy: record.assessorName,
            evaluatedAt: record.evaluatedAt
          };
          Object.values(store.bookings || {}).forEach((b) => {
            if (b.userPhone === phone) b.status = 'COMPLETED';
          });
        }
      };

      try {
        if (!isConnected()) {
          throw new Error('MongoDB not connected');
        }
        // Find User
        if (userId) {
          targetUser = await User.findById(userId);
        } else if (userPhone) {
          targetUser = await User.findOne({ phone: userPhone });
        }

        // Find Assessment
        if (assessmentId) {
          try {
            targetAssessment = await Assessment.findById(assessmentId);
          } catch (e) {
            // might be fallback id
          }
        }
        if (!targetAssessment && targetUser && targetUser.activeBookingId) {
          targetAssessment = await Assessment.findById(targetUser.activeBookingId);
        }

        // Create Evaluation in DB
        evaluationRecord = await Evaluation.create({
          assessmentId: targetAssessment ? targetAssessment._id : null,
          userId: targetUser ? targetUser._id : null,
          assessorName: assessorName || 'Priya Sharma (Senior Evaluator)',
          scores: {
            communication,
            scenarioHandling,
            hygieneSafety,
            reliability
          },
          totalScore,
          grade,
          skillBadge,
          feedback: feedback || (passed
            ? 'Candidate demonstrated outstanding customer composure, clear situational responses, and high grooming hygiene standards.'
            : 'Candidate needs additional practice on situational protocols before reassessment.'),
          passed,
          unlockedShifts: unlocked,
          evaluatedAt: new Date()
        });

        // Update User Profile
        if (targetUser) {
          targetUser.assessmentStatus = 'COMPLETED';
          targetUser.verified = passed;
          targetUser.skillEvaluation = {
            score: totalScore,
            grade,
            skillBadge,
            evaluatedBy: assessorName || 'Priya Sharma',
            evaluatedAt: new Date(),
            feedback: evaluationRecord.feedback
          };
          await targetUser.save();
        }

        // Update Assessment Record
        if (targetAssessment) {
          targetAssessment.status = 'COMPLETED';
          targetAssessment.evaluation = evaluationRecord._id;
          await targetAssessment.save();
        }
      } catch (dbErr) {
        console.warn('MongoDB evaluation write failed, using resilient fallback store:', dbErr.message);
        const evalId = 'eval_' + Date.now();
        evaluationRecord = {
          _id: evalId,
          id: evalId,
          assessmentId: assessmentId || 'bk_mock',
          userPhone: userPhone || (targetUser ? targetUser.phone : '9876543210'),
          assessorName: assessorName || 'Priya Sharma',
          scores: { communication, scenarioHandling, hygieneSafety, reliability },
          totalScore,
          grade,
          skillBadge,
          feedback: feedback || 'Candidate passed assessment with verified badge.',
          passed,
          unlockedShifts: unlocked,
          evaluatedAt: new Date()
        };
        fallbackEvaluations[evalId] = evaluationRecord;
        if (userPhone) {
          fallbackEvaluations[userPhone] = evaluationRecord;
        }
      }

      persistSkill(userPhone || (targetUser && targetUser.phone), evaluationRecord);

      // Emit Socket.io event if available so worker screen updates live
      const io = req.app.get('socketio');
      if (io) {
        const roomTarget = assessmentId || userPhone;
        io.emit(`evaluation_${roomTarget}`, evaluationRecord);
        io.emit('assessment_completed', {
          assessmentId,
          userPhone: targetUser ? targetUser.phone : userPhone,
          evaluation: evaluationRecord
        });
        console.log(`📡 [SOCKET] Dispatched evaluation for ${roomTarget}: ${totalScore}/100 (${grade})`);
      }

      // DLT SMS — assessment result (non-blocking)
      const smsPhone = String(
        (targetUser && targetUser.phone) || userPhone || ''
      ).replace(/\D/g, '').slice(-10);
      if (smsPhone.length === 10) {
        sendAssessmentResult(smsPhone, totalScore).catch((e) => {
          console.warn('📱 [SMS] assessment result failed:', e && e.message);
        });
      }

      return res.json({
        success: true,
        message: 'Candidate evaluation recorded and verified successfully',
        data: evaluationRecord
      });
    } catch (err) {
      console.error('Submit evaluation error:', err);
      return res.status(500).json({ success: false, message: 'Server error processing evaluation' });
    }
  },

  /**
   * GET /api/evaluations/user/:identifier
   * Identifier can be phone or userId
   */
  async getUserEvaluation(req, res) {
    try {
      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).json({ success: false, message: 'User identifier required' });
      }

      let evaluation = null;
      try {
        // Try as phone
        const user = await User.findOne({ phone: identifier });
        if (user) {
          evaluation = await Evaluation.findOne({ userId: user._id }).sort({ evaluatedAt: -1 });
        }
        if (!evaluation && identifier.match(/^[0-9a-fA-F]{24}$/)) {
          evaluation = await Evaluation.findOne({ userId: identifier }).sort({ evaluatedAt: -1 });
        }
      } catch (dbErr) {
        evaluation = fallbackEvaluations[identifier] || Object.values(fallbackEvaluations)[0];
      }

      if (!evaluation) {
        // Return latest fallback if available
        evaluation = fallbackEvaluations[identifier] || null;
      }

      return res.json({
        success: true,
        data: evaluation
      });
    } catch (err) {
      console.error('Get user evaluation error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /**
   * GET /api/evaluations/all
   * Assessor dashboard evaluation history
   */
  async getAllEvaluations(req, res) {
    try {
      let evaluations = [];
      try {
        evaluations = await Evaluation.find().populate('userId', 'name phone').sort({ evaluatedAt: -1 }).limit(50);
      } catch (e) {
        evaluations = Object.values(fallbackEvaluations);
      }

      return res.json({
        success: true,
        data: evaluations
      });
    } catch (err) {
      console.error('Get all evaluations error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  }
};

module.exports = evaluationController;
