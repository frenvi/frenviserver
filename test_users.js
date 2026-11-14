const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./src/models/User');

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/frenvi').then(async () => {
  const users = await User.find({});
  console.log('Total users:', users.length);
  users.forEach(u => {
    console.log('Phone:', u.phone, 'Name:', u.name, 'assessmentStatus:', u.assessmentStatus, 'verified:', u.verified, 'skillEvaluation:', JSON.stringify(u.skillEvaluation));
  });
  process.exit(0);
}).catch(err => {
  console.error('Mongo err:', err.message);
  process.exit(1);
});
