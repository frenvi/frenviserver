const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema(
  {
    shiftId: { type: String, default: '' },
    brand: { type: String, default: '' },
    role: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    hours: { type: Number, default: 0 },
    paidAt: { type: Date, default: Date.now },
    note: { type: String, default: '' }
  },
  { _id: true }
);

const NotificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: { type: String, default: '' },
    type: {
      type: String,
      enum: ['shift', 'pay', 'system', 'review', 'otp'],
      default: 'system'
    },
    unread: { type: Boolean, default: true },
    meta: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const UserSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  username: {
    type: String,
    trim: true,
    lowercase: true,
    default: null
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: null
  },
  passwordHash: {
    type: String,
    default: null
  },
  department: {
    type: String,
    enum: ['none', 'admin', 'marketing', 'boarding'],
    default: 'none'
  },
  title: {
    type: String,
    default: ''
  },
  avatar: {
    type: String,
    default: '👤'
  },
  name: {
    type: String,
    default: 'Worker',
    trim: true
  },
  role: {
    type: String,
    enum: ['worker', 'assessor', 'admin', 'marketing', 'boarding'],
    default: 'worker'
  },
  assessmentStatus: {
    type: String,
    enum: ['NEW', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'REASSESSMENT_PENDING'],
    default: 'NEW'
  },
  activeBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assessment',
    default: null
  },
  skillEvaluation: {
    score: { type: Number },
    grade: { type: String, default: '' },
    skillBadge: { type: String, default: '' },
    evaluatedBy: { type: String, default: '' },
    evaluatedAt: { type: Date, default: null },
    feedback: { type: String, default: '' }
  },
  verified: {
    type: Boolean,
    default: false
  },
  /** Identity KYC via Cashfree Secure ID (DigiLocker primary; legacy OKYC preserved) */
  kycStatus: {
    type: String,
    enum: ['NEW', 'PENDING', 'VERIFIED', 'FAILED'],
    default: 'NEW',
    index: true
  },
  kycRefId: { type: String, default: '' },
  /** DigiLocker verification_id currently in progress / last completed */
  digilockerVerificationId: { type: String, default: '' },
  /** AADHAAR | PAN | DRIVING_LICENSE (DigiLocker); empty for legacy OKYC */
  kycDocumentType: { type: String, default: '' },
  aadhaarLast4: { type: String, default: '' },
  kycName: { type: String, default: '' },
  kycDob: { type: String, default: '' },
  dateOfBirth: { type: Date, default: null },
  age: { type: Number, default: null },
  /** null = unknown (not KYC'd yet); true/false only after verified DOB */
  isAdult: { type: Boolean, default: null },
  kycRejectedReason: { type: String, default: '' },
  kycGender: { type: String, default: '' },
  kycAddress: { type: String, default: '' },
  kycVerifiedAt: { type: Date, default: null },
  /** cashfree (legacy OKYC) | cashfree_digilocker */
  kycSource: { type: String, default: '' },
  upiId: { type: String, default: '' },
  city: { type: String, default: 'Hyderabad' },
  locationLabel: { type: String, default: '' },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  workRadiusKm: { type: Number, default: 6, min: 1, max: 50 },
  preferredShiftTimes: { type: String, default: 'Early morning, evenings' },
  lang: { type: String, default: 'en' },
  userTypeId: { type: String, default: '' },
  walletBalance: { type: Number, default: 0 },
  /** Sum of 5% task-acceptance fees not yet settled (block new accepts at ₹100) */
  taskFeePending: { type: Number, default: 0, min: 0 },
  /** Pending Cashfree PG wallet top-ups (credited after payment success) */
  pendingTopups: {
    type: [
      {
        orderId: { type: String, required: true },
        amount: { type: Number, required: true },
        status: {
          type: String,
          enum: ['PENDING', 'PAID', 'FAILED', 'EXPIRED'],
          default: 'PENDING'
        },
        createdAt: { type: Date, default: Date.now },
        paidAt: { type: Date, default: null }
      }
    ],
    default: []
  },
  payouts: { type: [PayoutSchema], default: [] },
  notifications: { type: [NotificationSchema], default: [] },
  /** Sliding refresh session (hashed). Access JWT is short-lived; this renews it. */
  refreshTokenHash: { type: String, default: '' },
  refreshTokenExpiresAt: { type: Date, default: null },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', UserSchema);
