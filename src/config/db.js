const mongoose = require('mongoose');

let isConnected = false;
let activeUriLabel = '';

async function tryConnect(uri, label) {
  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000
  });
  isConnected = true;
  activeUriLabel = label;
  console.log(`✅ MongoDB Connected (${label}): ${conn.connection.host}/${conn.connection.name}`);
  return conn;
}

const connectDB = async () => {
  if (isConnected) return;

  const primary = process.env.MONGODB_URI;
  const localFallback =
    process.env.MONGODB_URI_FALLBACK || 'mongodb://127.0.0.1:27017/frenvi';

  if (primary) {
    try {
      await tryConnect(primary, 'atlas/primary');
      return;
    } catch (error) {
      console.warn(`⚠️ Primary MongoDB unavailable: ${error.message}`);
      console.warn('ℹ️ Falling back to local MongoDB…');
      try {
        // Drop any half-open mongoose state before retry
        await mongoose.disconnect().catch(() => {});
      } catch (e) { /* ignore */ }
    }
  }

  try {
    await tryConnect(localFallback, 'local');
  } catch (error) {
    isConnected = false;
    activeUriLabel = '';
    console.warn(`⚠️ MongoDB Connection Warning: ${error.message}`);
    console.warn('ℹ️ Running without DB. Shift create will return 503 until MongoDB is reachable.');
  }
};

module.exports = {
  connectDB,
  isConnected: () => isConnected,
  getActiveUriLabel: () => activeUriLabel
};
