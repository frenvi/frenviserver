require("dotenv").config();
const mongoose = require("mongoose");
const Shift = require("./src/models/Shift");

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const shifts = await Shift.find({ status: { $in: ['LIVE', 'SCHEDULED', 'OPEN'] } }).select("brand role date shiftDate distanceKm lat lng").limit(15);
  console.log("Total matched shifts:", shifts.length);
  shifts.forEach(s => console.log(s.brand, "| role:", s.role, "| date:", s.date, "| shiftDate:", s.shiftDate, "| dist:", s.distanceKm, "| lat:", s.lat, "lng:", s.lng));
  process.exit(0);
}).catch(e => {
  console.log("err:", e.message);
  process.exit(1);
});
