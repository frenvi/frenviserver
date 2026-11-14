const mongoose = require('mongoose');

const AssessmentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userPhone: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    default: 'Worker'
  },
  type: {
    type: String,
    enum: ['INSTANT', 'SCHEDULED'],
    default: 'INSTANT'
  },
  designationId: {
    type: String,
    required: true
  },
  designationTitle: {
    type: String,
    required: true
  },
  /** Optional multi-designation picks (primary stays in designationId/Title) */
  designationIds: [{
    type: String
  }],
  designationTitles: [{
    type: String
  }],
  categoryIds: [{
    type: String
  }],
  categoryNames: [{
    type: String
  }],
  language: {
    type: String,
    enum: ['English', 'Hindi', 'Telugu'],
    default: 'English'
  },
  // Scheduled Slot Details
  scheduledDate: {
    type: String, // YYYY-MM-DD
    default: null
  },
  scheduledDateFormatted: {
    type: String,
    default: null
  },
  slotId: {
    type: String,
    default: null
  },
  slotTime: {
    type: String,
    default: null
  },
  // Video Calling Channel & Room
  channelName: {
    type: String,
    required: true,
    unique: true
  },
  assessor: {
    id: { type: String, default: 'assessor_1' },
    name: { type: String, default: 'Priya Sharma' },
    title: { type: String, default: 'Lead Skill Evaluator' },
    avatar: { type: String, default: '👩‍💼' }
  },
  status: {
    type: String,
    enum: ['WAITING_QUEUE', 'CONFIRMED', 'CALL_ACTIVE', 'COMPLETED', 'CANCELLED', 'RESCHEDULED'],
    default: 'CONFIRMED'
  },
  evaluation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Evaluation',
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Composite index to prevent double bookings on the same slot
AssessmentSchema.index({ scheduledDate: 1, slotId: 1, status: 1 });

module.exports = mongoose.model('Assessment', AssessmentSchema);
