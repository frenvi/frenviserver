const mongoose = require('mongoose');

const EvaluationSchema = new mongoose.Schema({
  assessmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assessment',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  assessorName: {
    type: String,
    default: 'Priya Sharma'
  },
  scores: {
    communication: { type: Number, min: 0, max: 25, default: 24 },
    scenarioHandling: { type: Number, min: 0, max: 25, default: 23 },
    hygieneSafety: { type: Number, min: 0, max: 25, default: 24 },
    reliability: { type: Number, min: 0, max: 25, default: 23 }
  },
  totalScore: {
    type: Number,
    min: 0,
    max: 100,
    required: true
  },
  grade: {
    type: String,
    enum: ['Grade A', 'Grade B', 'Grade C', 'Retake Required'],
    default: 'Grade A'
  },
  skillBadge: {
    type: String,
    default: 'Certified Store & Dining Specialist'
  },
  feedback: {
    type: String,
    default: 'Excellent candidate with confident verbal communication and strong situational protocols.'
  },
  passed: {
    type: Boolean,
    default: true
  },
  unlockedShifts: [{
    brand: String,
    role: String,
    pay: String,
    rating: String
  }],
  evaluatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Evaluation', EvaluationSchema);
