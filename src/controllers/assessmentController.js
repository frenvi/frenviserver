const Assessment = require('../models/Assessment');
const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const { isConnected } = require('../config/db');

const DESIGNATIONS = [
  {
    id: 'tiffin',
    title: 'Tiffin Master',
    icon: '🍛',
    photo: 'waffle_house.png',
    desc: 'Prepare idly, dosa, vada etc.',
    categories: [
      { id: 'idly', name: 'Idly', desc: 'Steamed and savoury varieties' },
      { id: 'dosa', name: 'Dosa', desc: 'Plain, masala, ghee dosa' },
      { id: 'vada', name: 'Vada', desc: 'Medu, masala vada' },
      { id: 'puri', name: 'Puri', desc: 'Puri, bhat, combination' }
    ]
  },
  {
    id: 'coffee',
    title: 'Coffee Master',
    icon: '☕',
    photo: 'kattar_chai.png',
    desc: 'Filter coffee, tea, beverages',
    categories: [
      { id: 'filter_coffee', name: 'Filter Coffee', desc: 'Decoction and milk brew' },
      { id: 'tea_master', name: 'Tea', desc: 'Chai, cutting, masala tea' },
      { id: 'cold_bev', name: 'Cold beverages', desc: 'Iced coffee and coolers' }
    ]
  },
  {
    id: 'juice',
    title: 'Juice Vendor',
    icon: '🧃',
    photo: 'wow_momos.png',
    desc: 'Fresh juices and beverages',
    categories: [
      { id: 'fresh_juice', name: 'Fresh juice', desc: 'Mosambi, orange, mixed' },
      { id: 'shakes', name: 'Shakes', desc: 'Fruit and milk shakes' },
      { id: 'sugarcane', name: 'Sugarcane', desc: 'Fresh crushed cane juice' }
    ]
  },
  {
    id: 'kitchen',
    title: 'Kitchen Helper',
    icon: '🔪',
    photo: 'burger_king.png',
    desc: 'Assist in food preparation',
    categories: [
      { id: 'prep', name: 'Prep station', desc: 'Chop, portion, mise en place' },
      { id: 'wash', name: 'Wash & clean', desc: 'Utensils and station hygiene' },
      { id: 'support', name: 'Line support', desc: 'Pass plates and refill' }
    ]
  },
  {
    id: 'bakery',
    title: 'Bakery Assistant',
    icon: '🥐',
    photo: 'starbucks.png',
    desc: 'Baking and packing',
    categories: [
      { id: 'oven', name: 'Oven & bake', desc: 'Breads, puffs, cookies' },
      { id: 'pack', name: 'Packing', desc: 'Tray packing and labels' },
      { id: 'counter', name: 'Counter', desc: 'Display and billing' }
    ]
  },
  {
    id: 'allrounder',
    title: 'All Rounder',
    icon: '⭐',
    photo: 'dominos.png',
    desc: 'Multiple F&B tasks',
    categories: [
      { id: 'multi_tiffin', name: 'Tiffin + counter', desc: 'Cook and serve' },
      { id: 'multi_bev', name: 'Beverages + packing', desc: 'Drinks and dispatch' },
      { id: 'multi_floor', name: 'Floor + hygiene', desc: 'Service and clean-up' }
    ]
  }
];

const ASSESSORS = [
  { id: 'assessor_1', name: 'Priya Sharma', title: 'Senior Retail Evaluator', avatar: '👩‍💼', rating: '4.95' },
  { id: 'assessor_2', name: 'Rajesh Verma', title: 'Logistics & QSR Lead', avatar: '👨‍💼', rating: '4.92' },
  { id: 'assessor_3', name: 'Anita Reddy', title: 'Customer Experience Lead', avatar: '👩‍💻', rating: '4.97' }
];

// In-memory fallback cache
const fallbackStore = {
  bookings: {},
  bookedSlots: {}, // "date:slotId" -> bookingId
  evaluations: {}
};

const assessmentController = {
  // 1. Get current user assessment status
  async getStatus(req, res) {
    try {
      const phone =
        (req.auth && req.auth.phone) ||
        req.query.phone ||
        (req.user && req.user.phone);
      if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });

      let user = null;
      let activeBooking = null;

      if (isConnected()) {
        try {
          user = await User.findOne({ phone }).populate('activeBookingId');
          if (user && user.activeBookingId) {
            activeBooking = user.activeBookingId;
          }
        } catch (dbErr) {
          user = null;
        }
      }

      if (!activeBooking) {
        const b = Object.values(fallbackStore.bookings).find(
          (item) => item.userPhone === phone && item.status !== 'CANCELLED'
        );
        if (b) activeBooking = b;
      }

      let status = 'NEW';
      if (user && user.assessmentStatus) {
        status = user.assessmentStatus;
      } else if (activeBooking) {
        if (activeBooking.status === 'WAITING_QUEUE') status = 'WAITING_QUEUE';
        else if (activeBooking.status === 'CALL_ACTIVE') status = 'IN_PROGRESS';
        else if (activeBooking.status === 'COMPLETED') status = 'COMPLETED';
        else status = 'BOOKED';
      }

      const rawSkill = (user && user.skillEvaluation)
        || fallbackStore.evaluations?.[phone]
        || null;
      const skillEvaluation = (rawSkill && (rawSkill.evaluatedAt || rawSkill.grade))
        ? rawSkill
        : null;

      return res.json({
        success: true,
        data: {
          phone,
          status: skillEvaluation ? status : (status === 'COMPLETED' ? 'NEW' : status),
          verified: !!(skillEvaluation && (user ? user.verified : (skillEvaluation.score || 0) > 30)),
          booking: activeBooking,
          skillEvaluation
        }
      });
    } catch (err) {
      console.error('Get status error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 2. Get Designations & Categories (prefer seeded Mongo catalog)
  async getDesignations(req, res) {
    try {
      if (isConnected()) {
        const { Designation, UserType, Industry } = require('../models/Catalog');
        const [designations, userTypes, industries] = await Promise.all([
          Designation.find().sort({ title: 1 }).lean(),
          UserType.find().sort({ title: 1 }).lean(),
          Industry.find().sort({ title: 1 }).lean()
        ]);
        if (designations.length) {
          return res.json({
            success: true,
            data: designations,
            catalog: { userTypes, industries, designations }
          });
        }
      }
    } catch (e) {
      console.warn('Designation DB read failed, using built-in list:', e.message);
    }
    return res.json({ success: true, data: DESIGNATIONS });
  },

  // 3. Get Available Dates (next 7 days)
  async getDates(req, res) {
    const dates = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso = d.toISOString().split('T')[0];
      const weekday = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' });
      const formatted = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      dates.push({
        iso,
        label: `${weekday}, ${formatted}`,
        shortLabel: formatted,
        weekday,
        isToday: i === 0,
        isTomorrow: i === 1
      });
    }
    return res.json({ success: true, data: dates });
  },

  // 4. Get Available Time Slots for Date with conflict checking
  async getSlots(req, res) {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ success: false, message: 'Date required' });

      const allSlots = [
        { id: 'slot_0900', time: '09:00 AM', period: 'Morning' },
        { id: 'slot_0930', time: '09:30 AM', period: 'Morning' },
        { id: 'slot_1000', time: '10:00 AM', period: 'Morning' },
        { id: 'slot_1030', time: '10:30 AM', period: 'Morning' },
        { id: 'slot_1100', time: '11:00 AM', period: 'Morning' },
        { id: 'slot_1130', time: '11:30 AM', period: 'Morning' },
        { id: 'slot_1400', time: '02:00 PM', period: 'Afternoon' },
        { id: 'slot_1430', time: '02:30 PM', period: 'Afternoon' },
        { id: 'slot_1500', time: '03:00 PM', period: 'Afternoon' },
        { id: 'slot_1530', time: '03:30 PM', period: 'Afternoon' },
        { id: 'slot_1600', time: '04:00 PM', period: 'Afternoon' },
        { id: 'slot_1700', time: '05:00 PM', period: 'Evening' },
        { id: 'slot_1730', time: '05:30 PM', period: 'Evening' }
      ];

      // Query database for booked slots
      let bookedSlotIds = [];
      try {
        const bookings = await Assessment.find({
          scheduledDate: date,
          status: { $in: ['CONFIRMED', 'CALL_ACTIVE'] }
        });
        bookedSlotIds = bookings.map(b => b.slotId);
      } catch (e) {
        // Fallback store
        bookedSlotIds = Object.keys(fallbackStore.bookedSlots)
          .filter(k => k.startsWith(date + ':'))
          .map(k => k.split(':')[1]);
      }

      const slotsWithAvailability = allSlots.map(s => ({
        ...s,
        duration: '15 mins (+ 15 min buffer)',
        available: !bookedSlotIds.includes(s.id)
      }));

      return res.json({ success: true, date, data: slotsWithAvailability });
    } catch (err) {
      console.error('Get slots error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 5. Create Booking with atomic conflict detection
  async createBooking(req, res) {
    try {
      const {
        phone: bodyPhone,
        userName,
        designationId,
        designationTitle,
        designationIds,
        designationTitles,
        categoryIds,
        categoryNames,
        language,
        date,
        dateFormatted,
        slotId,
        slotTime
      } = req.body || {};
      const phone = (req.auth && req.auth.phone) || bodyPhone;
      const desigIds = Array.isArray(designationIds) && designationIds.length
        ? designationIds.map(String)
        : (designationId ? [String(designationId)] : []);
      const desigTitles = Array.isArray(designationTitles) && designationTitles.length
        ? designationTitles.map(String)
        : (designationTitle ? [String(designationTitle)] : []);
      const primaryDesigId = desigIds[0] || designationId;
      const primaryDesigTitle = desigTitles.join(', ') || designationTitle || 'Retail & Store Associate';

      if (!phone || !date || !slotId) {
        return res.status(400).json({ success: false, message: 'Missing required booking fields' });
      }

      const slotKey = `${date}:${slotId}`;

      // One active booking per user — reschedule instead of creating another
      try {
        const userActive = await Assessment.findOne({
          userPhone: phone,
          status: { $in: ['CONFIRMED', 'CALL_ACTIVE', 'WAITING_QUEUE'] }
        }).sort({ updatedAt: -1 });
        if (userActive) {
          return res.status(409).json({
            success: false,
            code: 'ALREADY_BOOKED',
            message: 'You already have a scheduled assessment. Please reschedule that booking instead.',
            data: { bookingId: userActive._id }
          });
        }
      } catch (e) {
        const fallbackActive = Object.values(fallbackStore.bookings || {}).find(
          (b) => b.userPhone === phone && ['CONFIRMED', 'CALL_ACTIVE', 'WAITING_QUEUE'].includes(b.status)
        );
        if (fallbackActive) {
          return res.status(409).json({
            success: false,
            code: 'ALREADY_BOOKED',
            message: 'You already have a scheduled assessment. Please reschedule that booking instead.',
            data: { bookingId: fallbackActive._id || fallbackActive.id }
          });
        }
      }

      // Check slot conflict
      try {
        const existing = await Assessment.findOne({
          scheduledDate: date,
          slotId: slotId,
          status: { $in: ['CONFIRMED', 'CALL_ACTIVE'] }
        });
        if (existing) {
          return res.status(409).json({ success: false, message: 'This slot is already booked. Please choose another.' });
        }
      } catch (e) {
        if (fallbackStore.bookedSlots[slotKey]) {
          return res.status(409).json({ success: false, message: 'This slot is already booked.' });
        }
      }

      const assessor = ASSESSORS[Math.floor(Math.random() * ASSESSORS.length)];
      const channelName = `frenvi_room_${Date.now()}_${Math.floor(Math.random()*1000)}`;

      let newBooking = null;
      try {
        let user = await User.findOne({ phone });
        if (!user) user = await User.create({ phone, name: userName || 'Worker' });

        newBooking = await Assessment.create({
          userId: user._id,
          userPhone: phone,
          userName: userName || user.name,
          type: 'SCHEDULED',
          designationId: primaryDesigId || designationId,
          designationTitle: primaryDesigTitle,
          designationIds: desigIds,
          designationTitles: desigTitles,
          categoryIds: categoryIds || [],
          categoryNames: Array.isArray(categoryNames) ? categoryNames : [],
          language: language || 'English',
          scheduledDate: date,
          scheduledDateFormatted: dateFormatted || date,
          slotId,
          slotTime,
          channelName,
          assessor,
          status: 'CONFIRMED'
        });

        user.assessmentStatus = 'BOOKED';
        user.activeBookingId = newBooking._id;
        await user.save();
      } catch (dbErr) {
        // Fallback
        const bId = 'bk_' + Date.now();
        newBooking = {
          _id: bId,
          id: bId,
          userPhone: phone,
          userName: userName || 'Worker',
          type: 'SCHEDULED',
          designationId: primaryDesigId || designationId,
          designationTitle: primaryDesigTitle,
          designationIds: desigIds,
          designationTitles: desigTitles,
          categoryIds: categoryIds || [],
          categoryNames: Array.isArray(categoryNames) ? categoryNames : [],
          language,
          scheduledDate: date,
          scheduledDateFormatted: dateFormatted,
          slotId,
          slotTime,
          channelName,
          assessor,
          status: 'CONFIRMED'
        };
        fallbackStore.bookings[bId] = newBooking;
        fallbackStore.bookedSlots[slotKey] = bId;
      }

      // Realtime notification to Assessor Admin Portal
      const io = req.app.get('socketio');
      if (io) {
        io.emit('new_scheduled_booking', newBooking);
        console.log(`📡 [SOCKET] Dispatched new_scheduled_booking for ${userName || phone}`);
      }

      return res.json({
        success: true,
        message: 'Assessment booked successfully',
        data: newBooking
      });
    } catch (err) {
      console.error('Create booking error:', err);
      return res.status(500).json({ success: false, message: 'Server error booking slot' });
    }
  },

  // 6. Reschedule Booking
  async rescheduleBooking(req, res) {
    try {
      const { bookingId, newDate, newDateFormatted, newSlotId, newSlotTime } = req.body;
      if (!bookingId || !newDate || !newSlotId) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
      }

      let booking = null;
      try {
        booking = await Assessment.findById(bookingId);
        if (booking) {
          booking.scheduledDate = newDate;
          booking.scheduledDateFormatted = newDateFormatted;
          booking.slotId = newSlotId;
          booking.slotTime = newSlotTime;
          booking.status = 'CONFIRMED';
          await booking.save();
        }
      } catch (e) {
        booking = fallbackStore.bookings[bookingId];
        if (booking) {
          delete fallbackStore.bookedSlots[`${booking.scheduledDate}:${booking.slotId}`];
          booking.scheduledDate = newDate;
          booking.scheduledDateFormatted = newDateFormatted;
          booking.slotId = newSlotId;
          booking.slotTime = newSlotTime;
          fallbackStore.bookedSlots[`${newDate}:${newSlotId}`] = bookingId;
        }
      }

      // Notify admin portal of updated slot
      const io = req.app.get('socketio');
      if (io && booking) {
        io.emit('booking_rescheduled', booking);
        console.log(`📡 [SOCKET] Dispatched booking_rescheduled for ${bookingId}`);
      }

      return res.json({ success: true, message: 'Booking rescheduled successfully', data: booking });
    } catch (err) {
      console.error('Reschedule error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 7. Cancel Booking
  async cancelBooking(req, res) {
    try {
      const { bookingId, phone } = req.body;
      try {
        const b = await Assessment.findById(bookingId);
        if (b) {
          b.status = 'CANCELLED';
          await b.save();
        }
        if (phone) {
          await User.findOneAndUpdate({ phone }, { assessmentStatus: 'NEW', activeBookingId: null });
        }
      } catch (e) {
        if (fallbackStore.bookings[bookingId]) {
          const b = fallbackStore.bookings[bookingId];
          delete fallbackStore.bookedSlots[`${b.scheduledDate}:${b.slotId}`];
          b.status = 'CANCELLED';
        }
      }
      return res.json({ success: true, message: 'Booking cancelled' });
    } catch (err) {
      console.error('Cancel booking error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 8. Instant Assessment Matchmaking
  async startInstant(req, res) {
    try {
      const {
        phone: bodyPhone,
        userName,
        designationId,
        designationTitle,
        designationIds,
        designationTitles,
        categoryIds,
        categoryNames,
        language
      } = req.body || {};
      const phone = (req.auth && req.auth.phone) || bodyPhone;
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone required' });
      }
      const desigIds = Array.isArray(designationIds) && designationIds.length
        ? designationIds.map(String)
        : (designationId ? [String(designationId)] : []);
      const desigTitles = Array.isArray(designationTitles) && designationTitles.length
        ? designationTitles.map(String)
        : (designationTitle ? [String(designationTitle)] : []);
      const primaryDesigId = desigIds[0] || designationId || 'general';
      const primaryDesigTitle = desigTitles.join(', ') || designationTitle || 'Retail & Store Associate';
      const channelName = `frenvi_instant_${Date.now()}_${Math.floor(Math.random()*1000)}`;
      const assessor = ASSESSORS[Math.floor(Math.random() * ASSESSORS.length)];

      let record = null;
      if (isConnected()) {
        try {
          let user = await User.findOne({ phone });
          if (!user) user = await User.create({ phone, name: userName || 'Worker' });

          record = await Assessment.create({
            userId: user._id,
            userPhone: phone,
            userName: userName || user.name,
            type: 'INSTANT',
            designationId: primaryDesigId,
            designationTitle: primaryDesigTitle,
            designationIds: desigIds,
            designationTitles: desigTitles,
            categoryIds: categoryIds || [],
            categoryNames: Array.isArray(categoryNames) ? categoryNames : [],
            language: language || 'English',
            channelName,
            assessor,
            status: 'WAITING_QUEUE'
          });

          user.assessmentStatus = 'IN_PROGRESS';
          user.activeBookingId = record._id;
          await user.save();
        } catch (e) {
          record = null;
        }
      }

      if (!record) {
        const bId = 'inst_' + Date.now();
        record = {
          _id: bId,
          id: bId,
          userPhone: phone,
          userName: userName || 'Worker',
          type: 'INSTANT',
          designationId: primaryDesigId,
          designationTitle: primaryDesigTitle,
          designationIds: desigIds,
          designationTitles: desigTitles,
          categoryIds: categoryIds || [],
          categoryNames: Array.isArray(categoryNames) ? categoryNames : [],
          language: language || 'English',
          channelName,
          assessor,
          status: 'WAITING_QUEUE',
          createdAt: new Date()
        };
      }

      fallbackStore.bookings[String(record._id)] = record;

      // Realtime notification to Assessor Admin Portal
      const io = req.app.get('socketio');
      if (io) {
        io.emit('new_instant_assessment', record);
        console.log(`⚡ [SOCKET] Dispatched new_instant_assessment for ${userName || phone}`);
      }

      return res.json({
        success: true,
        data: {
          channelName,
          assessor,
          assessmentId: record._id
        }
      });
    } catch (err) {
      console.error('Start instant error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async acceptInstant(req, res) {
    try {
      const { assessmentId, assessorName } = req.body;
      if (!assessmentId) {
        return res.status(400).json({ success: false, message: 'assessmentId required' });
      }

      let record = fallbackStore.bookings[String(assessmentId)] || null;

      if (isConnected()) {
        try {
          const dbRecord = await Assessment.findById(assessmentId);
          if (dbRecord) {
            dbRecord.status = 'CALL_ACTIVE';
            if (assessorName) dbRecord.assessor = { ...dbRecord.assessor, name: assessorName };
            await dbRecord.save();
            record = dbRecord;
          }
        } catch (_) { /* use fallback */ }
      }

      if (!record) {
        return res.status(404).json({ success: false, message: 'Assessment not found in queue' });
      }

      record.status = 'CALL_ACTIVE';
      if (assessorName && record.assessor) record.assessor.name = assessorName;
      fallbackStore.bookings[String(record._id || assessmentId)] = record;

      const io = req.app.get('socketio');
      if (io) {
        const channel = record.channelName;
        io.emit('assessment_accepted', record);
        if (channel) io.to(channel).emit('assessment_accepted', record);
        console.log(`✅ [SOCKET] Assessor accepted ${record.userName || record.userPhone}`);
      }

      return res.json({ success: true, data: record });
    } catch (err) {
      console.error('Accept instant error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  // 9. Admin/Assessor Queue Dashboard Data
  async getAssessorDashboard(req, res) {
    try {
      let instantQueue = [];
      let scheduledBookings = [];
      const memoryInstant = Object.values(fallbackStore.bookings).filter(
        (b) => b.type === 'INSTANT' && ['WAITING_QUEUE', 'CALL_ACTIVE'].includes(b.status)
      );
      const memoryScheduled = Object.values(fallbackStore.bookings).filter(
        (b) => b.type === 'SCHEDULED' && b.status === 'CONFIRMED'
      );

      if (isConnected()) {
        try {
          instantQueue = await Assessment.find({
            type: 'INSTANT',
            status: { $in: ['WAITING_QUEUE', 'CALL_ACTIVE'] }
          }).sort({ createdAt: -1 });

          scheduledBookings = await Assessment.find({
            type: 'SCHEDULED',
            status: 'CONFIRMED'
          }).sort({ scheduledDate: 1, slotId: 1 });
        } catch (e) {
          instantQueue = memoryInstant;
          scheduledBookings = memoryScheduled;
        }
      } else {
        instantQueue = memoryInstant;
        scheduledBookings = memoryScheduled;
      }

      const byId = new Map();
      [...instantQueue, ...memoryInstant].forEach((item) => {
        byId.set(String(item._id || item.id), item);
      });
      instantQueue = Array.from(byId.values());

      const schedById = new Map();
      [...scheduledBookings, ...memoryScheduled].forEach((item) => {
        schedById.set(String(item._id || item.id), item);
      });
      scheduledBookings = Array.from(schedById.values());

      return res.json({
        success: true,
        data: {
          instantQueue,
          scheduledBookings,
          stats: {
            activeQueueCount: instantQueue.length,
            scheduledCount: scheduledBookings.length,
            completedToday: 18
          }
        }
      });
    } catch (err) {
      console.error('Get assessor dashboard error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  },

  async getMonitorStats(req, res) {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      let instantQueue = [];
      let scheduledBookings = [];
      let inProgress = [];
      let completed = [];
      let completedToday = [];
      let evaluations = [];
      let workers = { NEW: 0, BOOKED: 0, IN_PROGRESS: 0, COMPLETED: 0 };

      try {
        instantQueue = await Assessment.find({
          type: 'INSTANT',
          status: { $in: ['WAITING_QUEUE', 'CALL_ACTIVE'] }
        }).sort({ createdAt: -1 }).lean();

        scheduledBookings = await Assessment.find({
          type: 'SCHEDULED',
          status: 'CONFIRMED'
        }).sort({ scheduledDate: 1, slotId: 1 }).lean();

        inProgress = await Assessment.find({ status: 'CALL_ACTIVE' }).lean();
        completed = await Assessment.find({ status: 'COMPLETED' }).sort({ createdAt: -1 }).lean();
        completedToday = await Evaluation.find({ evaluatedAt: { $gte: startOfDay } }).lean();
        evaluations = await Evaluation.find().sort({ evaluatedAt: -1 }).limit(40).lean();

        const workerCounts = await User.aggregate([
          { $match: { role: 'worker' } },
          { $group: { _id: '$assessmentStatus', count: { $sum: 1 } } }
        ]);
        workerCounts.forEach((row) => {
          if (row._id && workers[row._id] !== undefined) workers[row._id] = row.count;
        });
      } catch (e) {
        const all = Object.values(fallbackStore.bookings || {});
        instantQueue = all.filter((b) => b.type === 'INSTANT' && ['WAITING_QUEUE', 'CALL_ACTIVE'].includes(b.status));
        scheduledBookings = all.filter((b) => b.type === 'SCHEDULED' && b.status === 'CONFIRMED');
        inProgress = all.filter((b) => b.status === 'CALL_ACTIVE');
        completed = all.filter((b) => b.status === 'COMPLETED');
      }

      const remaining = instantQueue.length + scheduledBookings.length;
      const done = completed.length;
      const passCount = evaluations.filter((ev) => ev.passed !== false && (ev.totalScore || 0) >= 70).length;
      const passRate = evaluations.length ? Math.round((passCount / evaluations.length) * 100) : 0;

      const byAssessor = {};
      evaluations.forEach((ev) => {
        const key = ev.assessorName || 'Unassigned';
        if (!byAssessor[key]) byAssessor[key] = { name: key, done: 0, avgScore: 0, _sum: 0 };
        byAssessor[key].done += 1;
        byAssessor[key]._sum += Number(ev.totalScore || 0);
        byAssessor[key].avgScore = Math.round(byAssessor[key]._sum / byAssessor[key].done);
      });

      return res.json({
        success: true,
        data: {
          remaining,
          done,
          inProgress: inProgress.length,
          completedToday: completedToday.length,
          passRate,
          workers,
          instantQueue,
          scheduledBookings,
          recentCompleted: evaluations.slice(0, 12),
          team: Object.values(byAssessor)
        }
      });
    } catch (err) {
      console.error('Get monitor stats error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  }
};

assessmentController.fallbackStore = fallbackStore;
module.exports = assessmentController;
