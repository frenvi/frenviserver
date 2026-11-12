const mongoose = require('mongoose');

/**
 * Audit trail for Cashfree Secure ID DigiLocker sessions.
 * User.kycStatus remains the gate; this collection tracks DigiLocker lifecycle.
 */
const DigiLockerVerificationSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verificationId: { type: String, required: true, unique: true, index: true },
    referenceId: { type: String, default: '' },
    digilockerUrl: { type: String, default: '' },
    urlExpiresAt: { type: Date, default: null },
    userFlow: { type: String, enum: ['signin', 'signup', ''], default: '' },
    documentRequested: {
      type: [String],
      default: () => ['AADHAAR', 'PAN', 'DRIVING_LICENSE']
    },
    documentConsent: { type: [String], default: [] },
    documentConsentValidity: { type: Date, default: null },
    /** DigiLocker lifecycle (detailed) */
    status: {
      type: String,
      enum: [
        'NOT_STARTED',
        'INITIATED',
        'PENDING',
        'AUTHORIZED',
        'VERIFIED',
        'FAILED',
        'CANCELLED',
        'EXPIRED'
      ],
      default: 'NOT_STARTED',
      index: true
    },
    cashfreeStatus: { type: String, default: '' },
    selectedDocumentType: {
      type: String,
      enum: ['', 'AADHAAR', 'PAN', 'DRIVING_LICENSE'],
      default: ''
    },
    verifiedName: { type: String, default: '' },
    verifiedDob: { type: String, default: '' },
    dateOfBirth: { type: Date, default: null },
    age: { type: Number, default: null },
    isAdult: { type: Boolean, default: null },
    documentLast4: { type: String, default: '' },
    gender: { type: String, default: '' },
    address: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    processedWebhookKeys: { type: [String], default: [] },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

DigiLockerVerificationSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('DigiLockerVerification', DigiLockerVerificationSchema);
