const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    desc: { type: String, default: '' }
  },
  { _id: false }
);

const ShiftSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    industryId: { type: String, required: true, index: true },
    industryTitle: { type: String, default: '' },
    designationId: { type: String, required: true, index: true },
    categoryIds: { type: [String], default: [] },
    categories: { type: [CategorySchema], default: [] },
    /** legacy coarse bucket kept for older clients */
    category: {
      type: String,
      enum: ['dining', 'retail', 'logistics', 'warehouse', 'events', 'marketing', 'media', 'all'],
      default: 'dining',
      index: true
    },
    location: { type: String, required: true, trim: true },
    lat: { type: Number, default: 17.4326 },
    lng: { type: Number, default: 78.4071 },
    pay: { type: Number, required: true, min: 50 },
    durationHours: { type: Number, default: 6, min: 1, max: 16 },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    date: { type: String, default: 'Today' },
    shiftDateIso: { type: String, default: '' },
    description: { type: String, default: '', maxlength: 500 },
    workPhone: { type: String, default: '' },
    posterPhone: { type: String, required: true, index: true },
    posterName: { type: String, default: '' },
    distanceKm: { type: Number, default: 1.5 },
    logoUrl: { type: String, default: 'frenvi_logo.png' },
    outletPhoto: { type: String, default: '' },
    rating: { type: String, default: 'New ★' },
    verifiedOnly: { type: Boolean, default: true },
    minScoreRequired: { type: Number, default: 30 },
    status: {
      type: String,
      enum: [
        'DRAFT',
        'PENDING_REVIEW',
        'NEEDS_CHANGES',
        'SCHEDULED',
        'LIVE',
        'FILLED',
        'CANCELLED',
        'EXPIRED',
        'REJECTED'
      ],
      default: 'PENDING_REVIEW',
      index: true
    },
    /** When status is SCHEDULED — auto-promotes to LIVE at this time */
    scheduledAt: { type: Date, default: null, index: true },
    active: { type: Boolean, default: false, index: true },
    acceptedBy: { type: String, default: null },
    acceptedByName: { type: String, default: '' },
    acceptedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: '' },
    rejectReason: { type: String, default: '' },
    /** Feedback from Frenvi team — shown to poster so they can fix & resubmit */
    adminFeedback: { type: String, default: '', maxlength: 1000 },
    feedbackAt: { type: Date, default: null },
    /**
     * Geofenced start-work flow:
     * doer arrives on-site → OTP shown to doer → poster enters OTP to start.
     */
    workStatus: {
      type: String,
      enum: ['NONE', 'AWAITING_START', 'IN_PROGRESS', 'COMPLETED'],
      default: 'NONE',
      index: true
    },
    doerArrivedAt: { type: Date, default: null },
    doerArriveLat: { type: Number, default: null },
    doerArriveLng: { type: Number, default: null },
    startOtp: { type: String, default: '' },
    startOtpExpires: { type: Date, default: null },
    workStartedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

ShiftSchema.index({ active: 1, status: 1, pay: -1 });
ShiftSchema.index({ industryId: 1, designationId: 1, active: 1 });

module.exports = mongoose.model('Shift', ShiftSchema);
