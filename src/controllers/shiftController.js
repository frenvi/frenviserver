const Shift = require('../models/Shift');
const User = require('../models/User');
const { isConnected } = require('../config/db');
const { isConfirmedUnderage, MINOR_MESSAGE } = require('../utils/ageFromDob');
const {
  uploadOutletPhoto,
  resolveShiftImage,
  logoPublicId,
  deliveryUrl,
  isConfigured: isCloudinaryConfigured
} = require('../services/cloudinaryMedia');
const { sendBoonAccepted } = require('../services/smsService');

const SEED_SHIFTS = [
  {
    brand: 'Burger King',
    role: 'Counter & Kitchen Crew',
    industryId: 'food-hospitality',
    industryTitle: 'Food & Hospitality',
    designationId: 'counter-service-store-care-associate',
    categoryIds: ['counter-service'],
    categories: [{ id: 'counter-service', name: 'Counter Service', desc: 'Take orders and serve' }],
    category: 'dining',
    location: 'Moula Ali Bypass, Hyderabad',
    lat: 17.4702,
    lng: 78.5578,
    pay: 301,
    durationHours: 5,
    startTime: '3:00 PM',
    endTime: '8:00 PM',
    date: 'Today',
    distanceKm: 1.2,
    logoUrl: deliveryUrl(logoPublicId('burger_king'), 'f_auto,q_auto,c_fill,w_240,h_240'),
    rating: '4.8 ★',
    verifiedOnly: true,
    minScoreRequired: 30,
    posterPhone: 'system',
    posterName: 'FRENVI',
    status: 'LIVE',
    active: true
  },
  {
    brand: 'WOW Momos',
    role: 'Momos Stall Helper',
    industryId: 'food-hospitality',
    industryTitle: 'Food & Hospitality',
    designationId: 'momos-stall-helper',
    categoryIds: ['stall-support'],
    categories: [{ id: 'stall-support', name: 'Stall Support', desc: 'Prep and serve momos' }],
    category: 'dining',
    location: 'West Marredpally, Hyd',
    lat: 17.4496,
    lng: 78.5084,
    pay: 212,
    durationHours: 3,
    startTime: '6:00 PM',
    endTime: '9:00 PM',
    date: 'Today',
    distanceKm: 2.8,
    logoUrl: deliveryUrl(logoPublicId('wow_momos'), 'f_auto,q_auto,c_fill,w_240,h_240'),
    rating: '4.7 ★',
    verifiedOnly: true,
    minScoreRequired: 30,
    posterPhone: 'system',
    posterName: 'FRENVI',
    status: 'LIVE',
    active: true
  }
];

function industryToLegacyCategory(industryId) {
  const map = {
    'food-hospitality': 'dining',
    'retail-shopping': 'retail',
    'events-experiences': 'events',
    'marketing-brand-promotions': 'marketing',
    'photography-media': 'media'
  };
  return map[industryId] || 'dining';
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/** Distance in meters between two WGS84 points */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function startOtpRadiusM() {
  const n = Number(process.env.START_OTP_RADIUS_M || 200);
  return Number.isFinite(n) && n > 30 ? n : 200;
}

async function promoteScheduledShifts() {
  try {
    if (!isConnected()) return;
    await Shift.updateMany(
      { status: 'SCHEDULED', scheduledAt: { $lte: new Date() } },
      { $set: { status: 'LIVE', active: true } }
    );
  } catch (e) { /* ignore */ }
}

function validateCreatePayload(body) {
  const errors = [];
  if (!body.brand || String(body.brand).trim().length < 2) errors.push('Business name is required');
  if (!body.role || String(body.role).trim().length < 2) errors.push('Designation / role is required');
  if (!body.industryId) errors.push('Industry is required');
  if (!body.designationId) errors.push('Designation is required');
  if (!body.location || String(body.location).trim().length < 3) errors.push('Location is required');
  if (!body.startTime) errors.push('Start time is required');
  if (!body.endTime) errors.push('End time is required');
  const pay = Number(body.pay);
  if (!Number.isFinite(pay) || pay < 50) errors.push('Pay must be at least ₹50');
  const phone = normalizePhone(body.posterPhone || body.phone);
  if (phone.length !== 10) errors.push('Valid poster phone is required');
  return { errors, phone, pay };
}

const shiftController = {
  async seedIfEmpty() {
    try {
      const count = await Shift.countDocuments();
      if (count === 0) {
        await Shift.insertMany(SEED_SHIFTS);
        console.log('✅ [DATABASE] Seeded initial live shifts');
      }
    } catch (e) {
      console.log('ℹ️ [DATABASE] Using memory-cached shifts catalog');
    }
  },

  /**
   * GET /api/shifts
   */
  async getShifts(req, res) {
    try {
      await promoteScheduledShifts();
      const { category, industryId, designationId, phone, status } = req.query;

      let workerScore = 0;
      let isVerified = false;

      if (phone) {
        try {
          const user = await User.findOne({ phone: normalizePhone(phone) });
          if (user) {
            isVerified = user.verified || false;
            workerScore = (user.skillEvaluation && user.skillEvaluation.score) || 0;
          }
        } catch (e) { /* ignore */ }
      }

      let shifts = [];
      try {
        const query = { active: true, status: status || 'LIVE' };
        if (industryId) query.industryId = industryId;
        if (designationId) query.designationId = designationId;
        if (category && category !== 'all') query.category = category;

        shifts = await Shift.find(query).sort({ createdAt: -1, pay: -1 }).limit(100);
      } catch (dbErr) {
        console.warn('getShifts DB error:', dbErr && dbErr.message);
        shifts = [];
      }

      const enriched = shifts.map((shift) => {
        const s = shift.toObject ? shift.toObject() : { ...shift };
        const eligible = isVerified
          ? workerScore >= (s.minScoreRequired || 30)
          : !s.verifiedOnly;
        const photo = resolveShiftImage(s);
        const logoUrl = deliveryUrl(
          logoPublicId(s.logoUrl || s.brand || 'frenvi_logo'),
          'f_auto,q_auto,c_fill,w_240,h_240'
        );
        return {
          ...s,
          id: String(s._id || s.id || ''),
          _id: s._id ? String(s._id) : s._id,
          logoUrl,
          photo,
          outletPhoto: s.outletPhoto && String(s.outletPhoto).startsWith('data:')
            ? photo
            : (s.outletPhoto || ''),
          eligible,
          lockedReason: eligible
            ? null
            : (isVerified
              ? `Requires Assessment score of ${s.minScoreRequired}+ (Your score: ${workerScore})`
              : 'Requires FRENVI Skill Verification')
        };
      });

      return res.json({
        success: true,
        data: enriched,
        workerMeta: { isVerified, workerScore }
      });
    } catch (err) {
      console.error('Get shifts error:', err);
      return res.status(500).json({ success: false, message: 'Server error loading shifts' });
    }
  },

  /**
   * POST /api/shifts
   * Create a live shift in MongoDB
   */
  async createShift(req, res) {
    try {
      const body = Object.assign({}, req.body || {});
      if (req.auth && req.auth.phone) {
        body.phone = req.auth.phone;
        body.posterPhone = req.auth.phone;
      }
      const { errors, phone, pay } = validateCreatePayload(body);
      if (errors.length) {
        return res.status(400).json({ success: false, message: errors[0], errors });
      }

      const durationHours = Math.max(1, Math.min(16, Number(body.durationHours) || 6));
      const categories = Array.isArray(body.categories)
        ? body.categories.map((c) => ({
            id: String(c.id || c),
            name: String(c.name || c.id || c),
            desc: String(c.desc || '')
          }))
        : [];
      const categoryIds = Array.isArray(body.categoryIds) && body.categoryIds.length
        ? body.categoryIds.map(String)
        : categories.map((c) => c.id);

      // Publish requests go to PENDING_REVIEW until admin approves → LIVE
      let status = 'PENDING_REVIEW';
      if (body.status === 'DRAFT') status = 'DRAFT';
      else if (body.status === 'SCHEDULED') status = 'SCHEDULED';
      else if (body.status === 'PENDING_REVIEW' || body.status === 'LIVE') status = 'PENDING_REVIEW';

      let scheduledAt = null;
      if (status === 'SCHEDULED') {
        const when = body.scheduledAt ? new Date(body.scheduledAt) : null;
        if (!when || Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 60 * 1000) {
          return res.status(400).json({
            success: false,
            message: 'Pick a future date & time to schedule this shift'
          });
        }
        scheduledAt = when;
      }

      let outletPhoto = String(body.outletPhoto || '').trim();
      if (status !== 'DRAFT' && (!outletPhoto || outletPhoto.length < 32)) {
        return res.status(400).json({
          success: false,
          message: 'Outlet photo is required'
        });
      }

      const brandName = String(body.brand).trim();
      let logoUrl = String(body.logoUrl || '').trim();
      if (!logoUrl || logoUrl === 'frenvi_logo.png' || !/^https?:\/\//i.test(logoUrl)) {
        logoUrl = deliveryUrl(logoPublicId(logoUrl || brandName), 'f_auto,q_auto,c_fill,w_240,h_240');
      }

      // Prefer Cloudinary URL in Mongo — never persist giant data-URIs when Cloudinary is up
      if (outletPhoto.startsWith('data:') && isCloudinaryConfigured()) {
        try {
          const uploaded = await uploadOutletPhoto(outletPhoto, brandName);
          outletPhoto = uploaded.url;
          logoUrl = uploaded.url;
        } catch (uploadErr) {
          console.error('Cloudinary outlet upload failed:', uploadErr.message);
          return res.status(502).json({
            success: false,
            message: 'Could not upload outlet photo to Cloudinary',
            detail: uploadErr.message
          });
        }
      } else if (outletPhoto.startsWith('data:')) {
        outletPhoto = outletPhoto.slice(0, 900000);
      }

      const doc = {
        brand: brandName,
        role: String(body.role).trim(),
        industryId: String(body.industryId).trim(),
        industryTitle: String(body.industryTitle || '').trim(),
        designationId: String(body.designationId).trim(),
        categoryIds,
        categories,
        category: body.category || industryToLegacyCategory(body.industryId),
        location: String(body.location).trim(),
        lat: Number.isFinite(Number(body.lat)) ? Number(body.lat) : 17.4326,
        lng: Number.isFinite(Number(body.lng)) ? Number(body.lng) : 78.4071,
        pay,
        durationHours,
        startTime: String(body.startTime).trim(),
        endTime: String(body.endTime).trim(),
        date: String(body.date || 'Today').trim(),
        shiftDateIso: String(body.shiftDateIso || '').trim(),
        description: String(body.description || '').trim().slice(0, 500),
        workPhone: String(body.workPhone || phone).trim(),
        posterPhone: phone,
        posterName: String(body.posterName || body.brand).trim(),
        distanceKm: Number.isFinite(Number(body.distanceKm)) ? Number(body.distanceKm) : 1.5,
        logoUrl,
        outletPhoto,
        verifiedOnly: body.verifiedOnly !== false,
        minScoreRequired: Number.isFinite(Number(body.minScoreRequired))
          ? Number(body.minScoreRequired)
          : 30,
        status,
        scheduledAt,
        active: status === 'LIVE',
        reviewedAt: null,
        reviewedBy: '',
        rejectReason: ''
      };

      if (!isConnected()) {
        return res.status(503).json({
          success: false,
          message: 'Database offline — cannot post shift. Start MongoDB / check MONGODB_URI.'
        });
      }

      let saved;
      try {
        saved = await Shift.create(doc);
      } catch (dbErr) {
        console.error('Mongo create shift failed:', dbErr.message);
        return res.status(503).json({
          success: false,
          message: 'Could not save shift to MongoDB',
          detail: dbErr.message
        });
      }

      // Soft-link poster on User if present
      try {
        await User.findOneAndUpdate(
          { phone },
          {
            $setOnInsert: { phone, name: doc.posterName },
            $set: { updatedAt: new Date() }
          },
          { upsert: false }
        );
      } catch (e) { /* optional */ }

      const data = saved.toObject ? saved.toObject() : saved;
      console.log(
        `📝 [SHIFT] created id=${data._id} status=${status} brand=${doc.brand} pay=₹${pay} poster=${phone}`
      );

      if (status === 'PENDING_REVIEW') {
        try {
          const io = req.app.get('socketio');
          if (io) {
            io.emit('new_boon_pending', {
              id: String(data._id || data.id),
              brand: doc.brand,
              role: doc.role,
              posterPhone: phone
            });
          }
        } catch (e) { /* optional */ }
      }

      const msg =
        doc.status === 'DRAFT'
          ? 'Draft saved'
          : doc.status === 'SCHEDULED'
            ? 'Shift scheduled'
            : 'Boon submitted for Frenvi review';
      return res.status(201).json({
        success: true,
        message: msg,
        data: { ...data, id: data._id || data.id }
      });
    } catch (err) {
      console.error('Create shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error creating shift' });
    }
  },

  /**
   * GET /api/shifts/admin/pending — boons awaiting Frenvi approval
   */
  async getPendingReview(req, res) {
    try {
      await promoteScheduledShifts();
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const shifts = await Shift.find({ status: 'PENDING_REVIEW' })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      const data = shifts.map((s) => ({
        ...s,
        id: String(s._id),
        photo: resolveShiftImage(s)
      }));
      return res.json({ success: true, data, count: data.length });
    } catch (err) {
      console.error('Get pending boons error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /**
   * POST /api/shifts/admin/:id/approve — make boon LIVE for doers
   */
  async approveShift(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const reviewer = String((req.body && req.body.reviewedBy) || 'Frenvi Admin').trim();
      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Boon not found' });
      }
      if (shift.status !== 'PENDING_REVIEW' && shift.status !== 'SCHEDULED') {
        return res.status(400).json({
          success: false,
          message: `Cannot approve a boon with status ${shift.status}`
        });
      }
      shift.status = 'LIVE';
      shift.active = true;
      shift.reviewedAt = new Date();
      shift.reviewedBy = reviewer;
      shift.rejectReason = '';
      shift.adminFeedback = '';
      shift.feedbackAt = null;
      await shift.save();

      try {
        const poster = await User.findOne({ phone: shift.posterPhone });
        if (poster) {
          poster.notifications = poster.notifications || [];
          poster.notifications.unshift({
            title: 'Your boon is live',
            body: `${shift.role || 'Boon'} at ${shift.brand || 'your outlet'} is now live on FRENVI.`,
            type: 'shift',
            unread: true,
            createdAt: new Date()
          });
          if (poster.notifications.length > 50) poster.notifications = poster.notifications.slice(0, 50);
          await poster.save();
        }
      } catch (e) { /* optional */ }

      console.log(`✅ [BOON APPROVE] id=${shift._id} by=${reviewer}`);
      const data = shift.toObject ? shift.toObject() : shift;
      return res.json({
        success: true,
        message: 'Boon approved — now live',
        data: { ...data, id: String(shift._id) }
      });
    } catch (err) {
      console.error('Approve shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error approving boon' });
    }
  },

  /**
   * POST /api/shifts/admin/:id/reject
   */
  async rejectShift(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const reviewer = String((req.body && req.body.reviewedBy) || 'Frenvi Admin').trim();
      const reason = String((req.body && req.body.reason) || 'Does not meet Frenvi guidelines').trim();
      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Boon not found' });
      }
      if (shift.status !== 'PENDING_REVIEW') {
        return res.status(400).json({
          success: false,
          message: `Cannot reject a boon with status ${shift.status}`
        });
      }
      shift.status = 'REJECTED';
      shift.active = false;
      shift.reviewedAt = new Date();
      shift.reviewedBy = reviewer;
      shift.rejectReason = reason;
      shift.adminFeedback = reason;
      shift.feedbackAt = new Date();
      await shift.save();

      try {
        const poster = await User.findOne({ phone: shift.posterPhone });
        if (poster) {
          poster.notifications = poster.notifications || [];
          poster.notifications.unshift({
            title: 'Boon not approved',
            body: `${shift.role || 'Your boon'} was rejected. ${reason}`,
            type: 'shift',
            unread: true,
            createdAt: new Date()
          });
          if (poster.notifications.length > 50) poster.notifications = poster.notifications.slice(0, 50);
          await poster.save();
        }
      } catch (e) { /* optional */ }

      console.log(`⛔ [BOON REJECT] id=${shift._id} by=${reviewer}`);
      const data = shift.toObject ? shift.toObject() : shift;
      return res.json({
        success: true,
        message: 'Boon rejected',
        data: { ...data, id: String(shift._id) }
      });
    } catch (err) {
      console.error('Reject shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error rejecting boon' });
    }
  },

  /**
   * PUT /api/shifts/admin/:id — staff can edit boon details before approve
   */
  async adminUpdateShift(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const body = req.body || {};
      const reviewer = String(body.reviewedBy || 'Frenvi Admin').trim();
      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Boon not found' });
      }
      if (!['PENDING_REVIEW', 'NEEDS_CHANGES', 'SCHEDULED', 'DRAFT'].includes(shift.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot edit a boon with status ${shift.status}`
        });
      }

      const textFields = [
        'brand',
        'role',
        'location',
        'startTime',
        'endTime',
        'date',
        'shiftDateIso',
        'description',
        'posterName',
        'workPhone'
      ];
      textFields.forEach((key) => {
        if (body[key] != null) shift[key] = String(body[key]).trim();
      });
      if (body.pay != null) {
        const pay = Number(body.pay);
        if (!Number.isFinite(pay) || pay < 50) {
          return res.status(400).json({ success: false, message: 'Pay must be at least ₹50' });
        }
        shift.pay = pay;
      }
      if (body.durationHours != null) {
        shift.durationHours = Math.max(1, Math.min(16, Number(body.durationHours) || shift.durationHours));
      }
      if (body.lat != null && Number.isFinite(Number(body.lat))) shift.lat = Number(body.lat);
      if (body.lng != null && Number.isFinite(Number(body.lng))) shift.lng = Number(body.lng);
      shift.reviewedBy = reviewer;
      shift.reviewedAt = new Date();
      await shift.save();

      console.log(`✏️ [BOON EDIT] id=${shift._id} by=${reviewer}`);
      const data = shift.toObject ? shift.toObject() : shift;
      return res.json({
        success: true,
        message: 'Boon updated',
        data: { ...data, id: String(shift._id), photo: resolveShiftImage(data) }
      });
    } catch (err) {
      console.error('Admin update shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error updating boon' });
    }
  },

  /**
   * POST /api/shifts/admin/:id/feedback — ask poster to fix & resubmit
   */
  async sendBoonFeedback(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const body = req.body || {};
      const reviewer = String(body.reviewedBy || 'Frenvi Admin').trim();
      const feedback = String(body.feedback || body.reason || '').trim();
      if (!feedback || feedback.length < 4) {
        return res.status(400).json({ success: false, message: 'Write clear feedback for the poster' });
      }
      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Boon not found' });
      }
      if (!['PENDING_REVIEW', 'NEEDS_CHANGES', 'SCHEDULED'].includes(shift.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot send feedback for status ${shift.status}`
        });
      }

      // Optional: apply edits in the same request
      ['brand', 'role', 'location', 'startTime', 'endTime', 'date', 'description'].forEach((key) => {
        if (body[key] != null) shift[key] = String(body[key]).trim();
      });
      if (body.pay != null && Number.isFinite(Number(body.pay))) {
        shift.pay = Math.max(50, Number(body.pay));
      }

      shift.status = 'NEEDS_CHANGES';
      shift.active = false;
      shift.adminFeedback = feedback.slice(0, 1000);
      shift.feedbackAt = new Date();
      shift.reviewedAt = new Date();
      shift.reviewedBy = reviewer;
      shift.rejectReason = feedback.slice(0, 500);
      await shift.save();

      try {
        const poster = await User.findOne({ phone: shift.posterPhone });
        if (poster) {
          poster.notifications = poster.notifications || [];
          poster.notifications.unshift({
            title: 'Frenvi feedback on your boon',
            body: feedback.slice(0, 180),
            type: 'shift',
            unread: true,
            createdAt: new Date()
          });
          if (poster.notifications.length > 50) poster.notifications = poster.notifications.slice(0, 50);
          await poster.save();
        }
      } catch (e) { /* optional */ }

      console.log(`💬 [BOON FEEDBACK] id=${shift._id} by=${reviewer}`);
      const data = shift.toObject ? shift.toObject() : shift;

      try {
        const io = req.app.get('socketio');
        if (io) {
          io.emit('boon_feedback_sent', {
            id: String(shift._id),
            posterPhone: shift.posterPhone,
            feedback: feedback.slice(0, 180),
            brand: shift.brand,
            role: shift.role
          });
        }
      } catch (e) { /* optional */ }

      return res.json({
        success: true,
        message: 'Feedback sent to poster',
        data: { ...data, id: String(shift._id) }
      });
    } catch (err) {
      console.error('Boon feedback error:', err);
      return res.status(500).json({ success: false, message: 'Server error sending feedback' });
    }
  },

  /**
   * PUT /api/shifts/:id — poster edits & resubmits after feedback
   */
  async updateMyShift(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const body = req.body || {};
      const phone = normalizePhone((req.auth && req.auth.phone) || body.phone || body.posterPhone);
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Auth phone required' });
      }
      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Boon not found' });
      }
      if (normalizePhone(shift.posterPhone) !== phone) {
        return res.status(403).json({ success: false, message: 'Not your boon' });
      }
      if (!['NEEDS_CHANGES', 'REJECTED', 'DRAFT', 'PENDING_REVIEW'].includes(shift.status)) {
        return res.status(400).json({
          success: false,
          message: 'This boon can no longer be edited'
        });
      }

      const textFields = [
        'brand',
        'role',
        'location',
        'startTime',
        'endTime',
        'date',
        'shiftDateIso',
        'description',
        'workPhone',
        'posterName'
      ];
      textFields.forEach((key) => {
        if (body[key] != null) shift[key] = String(body[key]).trim();
      });
      if (body.pay != null) {
        const pay = Number(body.pay);
        if (!Number.isFinite(pay) || pay < 50) {
          return res.status(400).json({ success: false, message: 'Pay must be at least ₹50' });
        }
        shift.pay = pay;
      }
      if (body.durationHours != null) {
        shift.durationHours = Math.max(1, Math.min(16, Number(body.durationHours) || shift.durationHours));
      }
      if (body.lat != null && Number.isFinite(Number(body.lat))) shift.lat = Number(body.lat);
      if (body.lng != null && Number.isFinite(Number(body.lng))) shift.lng = Number(body.lng);

      const resubmit = body.resubmit !== false;
      if (resubmit) {
        shift.status = 'PENDING_REVIEW';
        shift.active = false;
        // Keep last feedback visible until next review cycle clears it
      }
      await shift.save();

      if (resubmit) {
        try {
          const io = req.app.get('socketio');
          if (io) {
            io.emit('new_boon_pending', {
              id: String(shift._id),
              brand: shift.brand,
              role: shift.role,
              posterPhone: shift.posterPhone,
              resubmitted: true
            });
          }
        } catch (e) { /* optional */ }
      }

      const data = shift.toObject ? shift.toObject() : shift;
      return res.json({
        success: true,
        message: resubmit ? 'Boon resubmitted for review' : 'Boon updated',
        data: { ...data, id: String(shift._id), photo: resolveShiftImage(data) }
      });
    } catch (err) {
      console.error('Update my shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error updating boon' });
    }
  },

  /**
   * GET /api/shifts/mine?phone=
   */
  async getMyShifts(req, res) {
    try {
      await promoteScheduledShifts();
      const phone = normalizePhone((req.auth && req.auth.phone) || req.query.phone);
      if (!phone) {
        return res.status(400).json({ success: false, message: 'phone is required' });
      }

      let shifts = [];
      try {
        shifts = await Shift.find({ posterPhone: phone }).sort({ createdAt: -1 }).limit(50).lean();
      } catch (e) {
        console.warn('getMyPostedShifts DB error:', e && e.message);
        shifts = [];
      }

      const acceptorPhones = [
        ...new Set(shifts.map((s) => normalizePhone(s.acceptedBy)).filter((p) => p.length === 10))
      ];
      const usersByPhone = {};
      if (acceptorPhones.length) {
        try {
          const users = await User.find({ phone: { $in: acceptorPhones } })
            .select('phone name skillEvaluation')
            .lean();
          users.forEach((u) => {
            usersByPhone[u.phone] = u;
          });
        } catch (e) { /* optional */ }
      }

      const data = shifts.map((s) => {
        const photo = resolveShiftImage(s);
        const accPhone = normalizePhone(s.acceptedBy);
        const u = usersByPhone[accPhone];
        const acceptor = accPhone
          ? {
              phone: accPhone,
              name: s.acceptedByName || (u && u.name) || 'Doer',
              score: (u && u.skillEvaluation && u.skillEvaluation.score) || null,
              grade: (u && u.skillEvaluation && u.skillEvaluation.grade) || ''
            }
          : null;
        // Never expose startOtp to poster list — they must hear it from the doer
        const { startOtp, ...safe } = s;
        return {
          ...safe,
          id: String(s._id),
          photo,
          logoUrl: deliveryUrl(
            logoPublicId(s.logoUrl || s.brand || 'frenvi_logo'),
            'f_auto,q_auto,c_fill,w_240,h_240'
          ),
          acceptor,
          workStatus: s.workStatus || 'NONE',
          doerArrivedAt: s.doerArrivedAt || null,
          workStartedAt: s.workStartedAt || null,
          awaitingStartCode: s.workStatus === 'AWAITING_START'
        };
      });

      console.log(`📋 [POSTER] mine phone=${phone} posts=${data.length} filled=${data.filter((s) => s.acceptedBy).length}`);

      return res.json({ success: true, data });
    } catch (err) {
      console.error('Get my shifts error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  /**
   * POST /api/shifts/accept
   * Requires Aadhaar KYC + skill assessment. Charges 5% task fee into pending wallet fees.
   * If pending fees already reached ₹100, worker must settle before accepting more.
   */
  async acceptShift(req, res) {
    try {
      const { shiftId, phone } = req.body || {};
      if (!shiftId) {
        return res.status(400).json({ success: false, message: 'Shift ID required' });
      }

      const workerPhone = normalizePhone((req.auth && req.auth.phone) || phone);
      if (!workerPhone) {
        return res.status(400).json({ success: false, message: 'Shift ID and phone required' });
      }
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }

      const user = await User.findOne({ phone: workerPhone });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found. Please login again.' });
      }

      if (user.kycStatus !== 'VERIFIED') {
        return res.status(403).json({
          success: false,
          code: 'KYC_REQUIRED',
          message: 'Complete Aadhaar KYC before accepting tasks'
        });
      }

      if (isConfirmedUnderage(user)) {
        return res.status(403).json({
          success: false,
          code: 'UNDERAGE',
          message: MINOR_MESSAGE,
          data: { age: user.age, minAge: 18 }
        });
      }

      const skillScore = Number(
        (user.skillEvaluation && (user.skillEvaluation.score || user.skillEvaluation.totalScore)) || 0
      );
      const skillPassed = user.verified === true || skillScore > 30;
      if (!skillPassed) {
        return res.status(403).json({
          success: false,
          code: 'ASSESSMENT_REQUIRED',
          message: 'Complete your skill assessment before accepting tasks'
        });
      }

      const FEE_LIMIT = 100;
      const pendingFees = Number(user.taskFeePending) || 0;
      if (pendingFees >= FEE_LIMIT) {
        return res.status(402).json({
          success: false,
          code: 'FEE_LIMIT_REACHED',
          message: `Pay ₹${pendingFees} pending task fees in wallet before accepting more tasks`,
          data: {
            taskFeePending: pendingFees,
            feeLimit: FEE_LIMIT,
            walletBalance: Number(user.walletBalance) || 0
          }
        });
      }

      let shift = null;
      try {
        shift = await Shift.findById(shiftId);
      } catch (e) {
        shift = null;
      }
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Shift not found' });
      }
      if (shift.status === 'FILLED') {
        return res.status(409).json({ success: false, message: 'Shift already filled' });
      }

      const pay = Number(shift.pay) || 0;
      const fee = Math.max(1, Math.round(pay * 0.05));
      if (pendingFees + fee > FEE_LIMIT) {
        return res.status(402).json({
          success: false,
          code: 'FEE_LIMIT_REACHED',
          message: `This task fee (₹${fee}) would exceed the ₹${FEE_LIMIT} pending limit. Pay ₹${pendingFees} in wallet first.`,
          data: {
            taskFeePending: pendingFees,
            nextFee: fee,
            feeLimit: FEE_LIMIT,
            walletBalance: Number(user.walletBalance) || 0
          }
        });
      }

      shift.status = 'FILLED';
      shift.acceptedBy = workerPhone;
      shift.acceptedByName = user.name || 'Doer';
      shift.acceptedAt = new Date();
      await shift.save();

      const wallet = Number(user.walletBalance) || 0;
      let paidFromWallet = 0;
      let addedToPending = fee;
      if (wallet >= fee) {
        user.walletBalance = wallet - fee;
        paidFromWallet = fee;
        addedToPending = 0;
        user.payouts = user.payouts || [];
        user.payouts.unshift({
          shiftId: String(shift._id || ''),
          brand: shift.brand || '',
          role: shift.role || '',
          amount: -fee,
          hours: 0,
          paidAt: new Date(),
          note: `5% acceptance fee for ${shift.brand || 'task'} (₹${pay})`
        });
      } else {
        user.taskFeePending = pendingFees + fee;
        user.payouts = user.payouts || [];
        user.payouts.unshift({
          shiftId: String(shift._id || ''),
          brand: shift.brand || '',
          role: shift.role || '',
          amount: -fee,
          hours: 0,
          paidAt: new Date(),
          note: `5% acceptance fee pending (₹${fee}) for ${shift.brand || 'task'}`
        });
      }

      user.notifications = user.notifications || [];
      user.notifications.unshift({
        title: `Task confirmed — ${shift.brand || 'Outlet'}`,
        body: `${shift.role || 'Shift'} · ₹${pay} · fee ₹${fee} (5%)${paidFromWallet ? ' paid from wallet' : ' added to pending fees'}`,
        type: 'shift',
        unread: true,
        createdAt: new Date()
      });
      if (user.notifications.length > 50) user.notifications = user.notifications.slice(0, 50);
      await user.save();

      console.log(
        `✅ [ACCEPT] shift=${shift._id} doer=${workerPhone} pay=₹${pay} fee=₹${fee} pending=₹${user.taskFeePending}`
      );

      // DLT SMS — boon accepted (non-blocking)
      const boonLabel = [shift.brand, shift.role].filter(Boolean).join(' · ') || 'task';
      sendBoonAccepted(workerPhone, boonLabel).catch((e) => {
        console.warn('📱 [SMS] boon accepted failed:', e && e.message);
      });

      return res.json({
        success: true,
        message: paidFromWallet
          ? `Task accepted. ₹${fee} (5%) fee deducted from wallet.`
          : `Task accepted. ₹${fee} (5%) fee added to pending (pay by ₹${FEE_LIMIT} limit).`,
        data: {
          shift: shift.toObject ? shift.toObject() : shift,
          acceptedAt: new Date(),
          status: 'CONFIRMED',
          fee,
          feePercent: 5,
          feePaidFromWallet: paidFromWallet,
          feeAddedToPending: addedToPending,
          taskFeePending: Number(user.taskFeePending) || 0,
          feeLimit: FEE_LIMIT,
          walletBalance: Number(user.walletBalance) || 0
        }
      });
    } catch (err) {
      console.error('Accept shift error:', err);
      return res.status(500).json({ success: false, message: 'Server error accepting shift' });
    }
  },

  /**
   * POST /api/shifts/:id/arrive
   * Doer checks in at the outlet. Only when within radius is START OTP revealed
   * (doer tells this code to the boon poster).
   */
  async arriveAtShift(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const phone = normalizePhone((req.auth && req.auth.phone) || (req.body && req.body.phone));
      const lat = Number(req.body && req.body.lat);
      const lng = Number(req.body && req.body.lng);
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Auth phone required' });
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({
          success: false,
          code: 'LOCATION_REQUIRED',
          message: 'Turn on location to confirm you reached the outlet'
        });
      }

      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Shift not found' });
      }
      if (normalizePhone(shift.acceptedBy) !== phone) {
        return res.status(403).json({ success: false, message: 'Only the accepted doer can check in' });
      }
      if (shift.workStatus === 'IN_PROGRESS' || shift.workStatus === 'COMPLETED') {
        return res.json({
          success: true,
          message: 'Work already started',
          data: {
            workStatus: shift.workStatus,
            workStartedAt: shift.workStartedAt,
            alreadyStarted: true
          }
        });
      }

      const outletLat = Number(shift.lat);
      const outletLng = Number(shift.lng);
      if (!Number.isFinite(outletLat) || !Number.isFinite(outletLng)) {
        return res.status(400).json({
          success: false,
          message: 'This boon has no map pin — ask the poster to update the location'
        });
      }

      const distM = Math.round(haversineMeters(lat, lng, outletLat, outletLng));
      const radiusM = startOtpRadiusM();
      if (distM > radiusM) {
        return res.status(403).json({
          success: false,
          code: 'TOO_FAR',
          message: `You are about ${distM} m away. Get within ${radiusM} m of the outlet to unlock the start code.`,
          data: { distanceM: distM, radiusM }
        });
      }

      // Reuse unexpired OTP if doer taps again
      let otp = String(shift.startOtp || '');
      const stillValid =
        otp &&
        shift.startOtpExpires &&
        new Date(shift.startOtpExpires).getTime() > Date.now();
      if (!stillValid) {
        otp = String(Math.floor(1000 + Math.random() * 9000));
        shift.startOtp = otp;
        shift.startOtpExpires = new Date(Date.now() + 30 * 60 * 1000);
      }
      shift.workStatus = 'AWAITING_START';
      shift.doerArrivedAt = new Date();
      shift.doerArriveLat = lat;
      shift.doerArriveLng = lng;
      await shift.save();

      // Notify poster — they must enter the code the doer tells them
      try {
        const poster = await User.findOne({ phone: normalizePhone(shift.posterPhone) });
        if (poster) {
          poster.notifications = poster.notifications || [];
          poster.notifications.unshift({
            title: 'Doer arrived on site',
            body: `${shift.acceptedByName || 'Doer'} is at ${shift.brand || 'your outlet'}. Ask them for the 4-digit start code and enter it in Responses to begin.`,
            type: 'shift',
            unread: true,
            createdAt: new Date()
          });
          if (poster.notifications.length > 50) poster.notifications = poster.notifications.slice(0, 50);
          await poster.save();
        }
      } catch (e) { /* optional */ }

      console.log(
        `📍 [ARRIVE] shift=${shift._id} doer=${phone} dist=${distM}m otp=****`
      );

      return res.json({
        success: true,
        message: 'You are at the outlet. Tell this code to the boon poster to start.',
        data: {
          shiftId: String(shift._id),
          workStatus: shift.workStatus,
          distanceM: distM,
          radiusM,
          startOtp: otp,
          startOtpExpires: shift.startOtpExpires,
          tellPoster: true
        }
      });
    } catch (err) {
      console.error('arriveAtShift error:', err);
      return res.status(500).json({ success: false, message: 'Server error checking arrival' });
    }
  },

  /**
   * POST /api/shifts/:id/confirm-start
   * Boon poster enters the start OTP (told by doer after geofence unlock).
   */
  async confirmStart(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline' });
      }
      const id = req.params.id;
      const phone = normalizePhone((req.auth && req.auth.phone) || (req.body && req.body.phone));
      const otp = String((req.body && (req.body.otp || req.body.startOtp)) || '').trim();
      if (phone.length !== 10) {
        return res.status(400).json({ success: false, message: 'Auth phone required' });
      }
      if (!/^\d{4}$/.test(otp)) {
        return res.status(400).json({ success: false, message: 'Enter the 4-digit start code' });
      }

      const shift = await Shift.findById(id);
      if (!shift) {
        return res.status(404).json({ success: false, message: 'Shift not found' });
      }
      if (normalizePhone(shift.posterPhone) !== phone) {
        return res.status(403).json({
          success: false,
          message: 'Only the boon poster can confirm start'
        });
      }
      if (shift.workStatus === 'IN_PROGRESS' || shift.workStatus === 'COMPLETED') {
        return res.json({
          success: true,
          message: 'Work already started',
          data: { workStatus: shift.workStatus, workStartedAt: shift.workStartedAt }
        });
      }
      if (shift.workStatus !== 'AWAITING_START' || !shift.doerArrivedAt) {
        return res.status(400).json({
          success: false,
          code: 'DOER_NOT_ARRIVED',
          message: 'Wait until the doer reaches the outlet and unlocks the start code'
        });
      }
      if (
        !shift.startOtp ||
        !shift.startOtpExpires ||
        new Date(shift.startOtpExpires).getTime() < Date.now()
      ) {
        return res.status(400).json({
          success: false,
          code: 'OTP_EXPIRED',
          message: 'Start code expired. Ask the doer to tap “I’ve arrived” again.'
        });
      }
      if (String(shift.startOtp) !== otp) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_OTP',
          message: 'Incorrect start code. Ask the doer again.'
        });
      }

      shift.workStatus = 'IN_PROGRESS';
      shift.workStartedAt = new Date();
      shift.startOtp = '';
      shift.startOtpExpires = null;
      await shift.save();

      try {
        const doer = await User.findOne({ phone: normalizePhone(shift.acceptedBy) });
        if (doer) {
          doer.notifications = doer.notifications || [];
          doer.notifications.unshift({
            title: 'Work started',
            body: `${shift.posterName || 'Poster'} confirmed your start at ${shift.brand || 'the outlet'}. Good luck!`,
            type: 'shift',
            unread: true,
            createdAt: new Date()
          });
          if (doer.notifications.length > 50) doer.notifications = doer.notifications.slice(0, 50);
          await doer.save();
        }
      } catch (e) { /* optional */ }

      console.log(`▶️ [START] shift=${shift._id} poster=${phone}`);

      return res.json({
        success: true,
        message: 'Boon started — work is in progress',
        data: {
          shiftId: String(shift._id),
          workStatus: shift.workStatus,
          workStartedAt: shift.workStartedAt
        }
      });
    } catch (err) {
      console.error('confirmStart error:', err);
      return res.status(500).json({ success: false, message: 'Server error confirming start' });
    }
  }
};

module.exports = shiftController;
