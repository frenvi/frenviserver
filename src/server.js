const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { connectDB, isConnected, getActiveUriLabel } = require('./config/db');
const { isConfigured: isCloudinaryConfigured, cloudName } = require('./config/cloudinary');
const shiftController = require('./controllers/shiftController');

// Routes
const authController = require('./controllers/authController');
const authRoutes = require('./routes/authRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const agoraRoutes = require('./routes/agoraRoutes');
const evaluationRoutes = require('./routes/evaluationRoutes');
const shiftRoutes = require('./routes/shiftRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const userRoutes = require('./routes/userRoutes');
const kycRoutes = require('./routes/kycRoutes');
const {
  isConfigured: isCashfreeConfigured,
  getBaseUrl: cashfreeBaseUrl,
  getPublicApiOrigin,
  getMinAge
} = require('./config/cashfree');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.set('socketio', io);

// Global Middleware (10mb so outlet photo data-URIs can reach Cloudinary upload)
app.use(cors());
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      // Cashfree DigiLocker webhooks need the exact raw body for HMAC signature checks
      if (req.originalUrl && req.originalUrl.includes('/api/kyc/webhooks/')) {
        req.rawBody = buf.toString('utf8');
      }
    }
  })
);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request / session logger (every /api call)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  // Avoid WebView/proxy serving stale wallet/KYC/profile JSON
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const started = Date.now();
  const phone =
    (req.body && (req.body.phone || req.body.posterPhone)) ||
    req.query.phone ||
    '';
  const sessionBit = phone ? ` session=${String(phone).replace(/\D/g, '').slice(-10)}` : '';
  console.log(`➡️  [API] ${req.method} ${req.originalUrl}${sessionBit}`);
  res.on('finish', () => {
    const ms = Date.now() - started;
    const mark = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️' : '✅';
    console.log(`${mark} [API] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)${sessionBit}`);
  });
  next();
});

// Serve Static files for Assessor Admin App (React build prioritized)
const fs = require('fs');
const reactAdminDist = path.join(__dirname, '../../admin/dist');
if (fs.existsSync(reactAdminDist)) {
  app.use('/admin', express.static(reactAdminDist));
}
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use(express.static(path.join(__dirname, '../public')));

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/agora', agoraRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/users', userRoutes);
app.use('/api/kyc', kycRoutes);

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'FRENVI Production API',
    timestamp: new Date().toISOString(),
    agoraConfigured: Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_ID !== 'YOUR_AGORA_APP_ID'),
    mongoConfigured: Boolean(process.env.MONGODB_URI || process.env.MONGODB_URI_FALLBACK),
    mongoConnected: isConnected(),
    mongoTarget: getActiveUriLabel() || null,
    cloudinaryConfigured: isCloudinaryConfigured(),
    cloudinaryCloud: cloudName() || null,
    cashfreeConfigured: isCashfreeConfigured(),
    cashfreeBase: isCashfreeConfigured() ? cashfreeBaseUrl() : null,
    digilockerEnabled: true,
    digilockerRedirectConfigured: Boolean(getPublicApiOrigin()),
    kycMinAge: getMinAge()
  });
});

// Admin redirect
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Real-time Socket.io signaling & live assessment synchronization
io.on('connection', (socket) => {
  console.log(`⚡ [SOCKET] Client connected: ${socket.id}`);

  // Assessor or candidate joins an assessment room
  socket.on('join_assessment', (roomId) => {
    socket.join(roomId);
    console.log(`👥 [SOCKET] ${socket.id} joined assessment room: ${roomId}`);
    socket.to(roomId).emit('peer_joined', { socketId: socket.id });
  });

  // Assessor updates evaluation draft
  socket.on('update_draft_score', ({ roomId, scores, totalScore }) => {
    socket.to(roomId).emit('draft_score_updated', { scores, totalScore });
  });

  // Candidate finishes assessment or assessor ends session
  socket.on('finish_assessment', ({ roomId, evaluation }) => {
    io.to(roomId).emit('assessment_completed', { evaluation });
    io.emit('assessment_completed', { evaluation });
  });

  socket.on('assessment_accepted', (payload) => {
    io.emit('assessment_accepted', payload);
    if (payload && payload.channelName) {
      io.to(payload.channelName).emit('assessment_accepted', payload);
    }
  });

  socket.on('call_ended', (payload) => {
    io.emit('call_ended', payload);
    if (payload && payload.channelName) {
      io.to(payload.channelName).emit('call_ended', payload);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 [SOCKET] Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;

// Connect Database & Start Server
async function startServer() {
  await connectDB();
  await shiftController.seedIfEmpty();
  await authController.seedStaffAccounts();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 FRENVI PRODUCTION BACKEND RUNNING ON PORT ${PORT}`);
    console.log(`🌐 Base URL:            http://localhost:${PORT}`);
    console.log(`👑 Assessor Web Portal: http://localhost:${PORT}/admin`);
    console.log(`📡 Health Check:        http://localhost:${PORT}/api/health`);
    console.log(`🪪 Cashfree KYC:        ${isCashfreeConfigured() ? cashfreeBaseUrl() : 'NOT CONFIGURED'}`);
    console.log(`=======================================================`);
  });
}

startServer();
