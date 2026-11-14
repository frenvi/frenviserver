/**
 * Seed MongoDB Atlas + Cloudinary with full FRENVI catalog and live shifts.
 * Usage: node scripts/seed-all.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { connectDB, isConnected } = require('../src/config/db');
const { UserType, Industry, Designation } = require('../src/models/Catalog');
const Shift = require('../src/models/Shift');
const User = require('../src/models/User');
const { STAFF_ACCOUNTS, hashPassword } = require('../src/data/staffAccounts');
const {
  uploadFile,
  deliveryUrl,
  logoPublicId,
  isConfigured: isCloudinaryConfigured,
  cloudName
} = require('../src/services/cloudinaryMedia');
const { cloudinary } = require('../src/config/cloudinary');

const ASSETS = path.join(__dirname, '../../app/src/main/assets');
const DESIGNATIONS_JS = path.join(ASSETS, 'js/designations-data.js');

const BRAND_POOL = [
  { brand: 'Burger King', logo: 'burger_king', loc: 'Moula Ali Bypass, Hyderabad', lat: 17.4702, lng: 78.5578 },
  { brand: 'WOW Momos', logo: 'wow_momos', loc: 'West Marredpally, Hyd', lat: 17.4496, lng: 78.5084 },
  { brand: 'Kattar Chai Wala', logo: 'kattar_chai', loc: 'Old Neredmet, Malkajgiri', lat: 17.4778, lng: 78.5352 },
  { brand: 'Waffle House', logo: 'waffle_house', loc: 'Malkajgiri, Hyderabad', lat: 17.4471, lng: 78.5324 },
  { brand: 'Starbucks', logo: 'starbucks', loc: 'Paradise Circle, Secunderabad', lat: 17.4418, lng: 78.4986 },
  { brand: "Domino's", logo: 'dominos', loc: 'Malkajgiri Main Rd', lat: 17.4554, lng: 78.5401 },
  { brand: 'Cafe Coffee Day', logo: 'frenvi_logo', loc: 'Begumpet, Hyd', lat: 17.4432, lng: 78.4678 },
  { brand: 'Local Tiffin Hub', logo: 'frenvi_logo', loc: 'Ameerpet, Hyd', lat: 17.4375, lng: 78.4482 },
  { brand: 'Fresh Juice Corner', logo: 'frenvi_logo', loc: 'Secunderabad Station', lat: 17.4399, lng: 78.4983 },
  { brand: 'City Bakery', logo: 'frenvi_logo', loc: 'Kompally, Hyd', lat: 17.542, lng: 78.485 }
];

const STARTS = ['8:00 AM', '9:00 AM', '11:00 AM', '2:00 PM', '3:00 PM', '5:00 PM', '6:00 PM'];
const ENDS = ['12:00 PM', '1:00 PM', '3:00 PM', '6:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'];

function loadCatalogFromApp() {
  const raw = fs.readFileSync(DESIGNATIONS_JS, 'utf8');
  const match = raw.match(/window\.FRENVI_DESIGNATIONS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('Could not parse designations-data.js');
  return JSON.parse(match[1]);
}

function localPhotoPath(rel) {
  if (!rel) return null;
  const cleaned = String(rel).replace(/^\/+/, '').replace(/^img\//, 'img/');
  const full = path.join(ASSETS, cleaned);
  return fs.existsSync(full) ? full : null;
}

function publicIdFromRel(rel) {
  // img/categories/chicken.png -> frenvi/categories/chicken
  // img/user-types/student.jpg -> frenvi/user-types/student
  // img/subcategories/idli.jpg -> frenvi/subcategories/idli
  const cleaned = String(rel || '')
    .replace(/^\/+/, '')
    .replace(/^img\//, '')
    .replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
  return `frenvi/${cleaned.replace(/\\/g, '/')}`;
}

const uploadedCache = new Map();

async function ensureCloudinaryPhoto(rel) {
  if (!rel) return '';
  if (/^https?:\/\//i.test(rel)) return rel;
  if (uploadedCache.has(rel)) return uploadedCache.get(rel);

  const publicIdFull = publicIdFromRel(rel);
  const folder = path.posix.dirname(publicIdFull);
  const base = path.posix.basename(publicIdFull);
  const url = deliveryUrl(publicIdFull, 'f_auto,q_auto,c_fill,w_640,h_480');

  if (!isCloudinaryConfigured()) {
    uploadedCache.set(rel, url);
    return url;
  }

  const filePath = localPhotoPath(rel);
  if (!filePath) {
    console.warn(`  ⚠️ missing local file for ${rel}`);
    uploadedCache.set(rel, url);
    return url;
  }

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder,
      public_id: base,
      overwrite: true,
      invalidate: true,
      resource_type: 'image'
    });
    const secure = result.secure_url || url;
    uploadedCache.set(rel, secure);
    process.stdout.write('.');
    return secure;
  } catch (err) {
    console.warn(`\n  ⚠️ upload failed ${rel}: ${err.message}`);
    uploadedCache.set(rel, url);
    return url;
  }
}

async function rewritePhotosDeep(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return Promise.all(node.map((item) => rewritePhotosDeep(item)));
  }
  const out = { ...node };
  for (const key of Object.keys(out)) {
    if ((key === 'photo' || key === 'fallbackPhoto') && out[key]) {
      out[key] = await ensureCloudinaryPhoto(out[key]);
    } else if (typeof out[key] === 'object' && out[key] !== null) {
      out[key] = await rewritePhotosDeep(out[key]);
    }
  }
  return out;
}

function industryLegacy(industryId) {
  const map = {
    'food-hospitality': 'dining',
    'retail-shopping': 'retail',
    'events-experiences': 'events',
    'marketing-brand-promotions': 'marketing',
    'photography-media': 'media'
  };
  return map[industryId] || 'dining';
}

function buildShifts(designations) {
  return designations.map((d, idx) => {
    const brand = BRAND_POOL[idx % BRAND_POOL.length];
    const start = STARTS[idx % STARTS.length];
    const end = ENDS[idx % ENDS.length];
    const hours = 3 + (idx % 5);
    const pay = 180 + (idx % 12) * 35 + (hours * 20);
    const cats = Array.isArray(d.categories) ? d.categories.slice(0, 3) : [];
    const photo = d.photo || deliveryUrl(logoPublicId(brand.logo), 'f_auto,q_auto,c_fill,w_640,h_480');
    const logo = deliveryUrl(logoPublicId(brand.logo), 'f_auto,q_auto,c_fill,w_240,h_240');
    return {
      brand: brand.brand,
      role: d.title,
      industryId: d.industryId,
      industryTitle: d.industry || d.desc || '',
      designationId: d.id,
      categoryIds: cats.map((c) => c.id),
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        desc: c.desc || ''
      })),
      category: industryLegacy(d.industryId),
      location: brand.loc,
      lat: brand.lat + ((idx % 7) - 3) * 0.004,
      lng: brand.lng + ((idx % 5) - 2) * 0.004,
      pay,
      durationHours: hours,
      startTime: start,
      endTime: end,
      date: idx % 4 === 0 ? 'Tomorrow' : 'Today',
      distanceKm: Number((0.8 + (idx % 10) * 0.35).toFixed(1)),
      logoUrl: logo,
      outletPhoto: photo,
      rating: `${(4.5 + (idx % 5) * 0.1).toFixed(1)} ★`,
      verifiedOnly: true,
      minScoreRequired: 30,
      posterPhone: 'system',
      posterName: 'FRENVI',
      status: 'LIVE',
      active: true,
      description: cats.map((c) => c.name).filter(Boolean).slice(0, 3).join(' · ') || d.desc || d.title
    };
  });
}

async function seedStaff() {
  let n = 0;
  for (const account of STAFF_ACCOUNTS) {
    const record = {
      phone: account.phone,
      username: account.username,
      email: account.email,
      name: account.name,
      role: account.role,
      department: account.department,
      title: account.title,
      avatar: account.avatar,
      passwordHash: hashPassword(account.password),
      assessmentStatus: 'COMPLETED',
      verified: true
    };
    await User.findOneAndUpdate(
      { $or: [{ username: account.username }, { phone: account.phone }] },
      { $set: record },
      { upsert: true, new: true }
    );
    n += 1;
  }
  return n;
}

async function seedDemoWorkers() {
  const workers = [
    { phone: '9876543210', name: 'Choula', role: 'worker' },
    { phone: '9988776655', name: 'Ravi Kumar', role: 'worker' },
    { phone: '9123456780', name: 'Sneha Reddy', role: 'worker' }
  ];
  for (const w of workers) {
    await User.findOneAndUpdate(
      { phone: w.phone },
      {
        $set: {
          phone: w.phone,
          name: w.name,
          role: w.role,
          department: 'none',
          assessmentStatus: 'NEW',
          verified: false
        }
      },
      { upsert: true }
    );
  }
  return workers.length;
}

async function main() {
  console.log('🌱 FRENVI full seed starting…');
  console.log(`   Cloudinary: ${isCloudinaryConfigured() ? cloudName() : 'NOT CONFIGURED'}`);

  await connectDB();
  if (!isConnected()) {
    console.error('❌ MongoDB not connected — check MONGODB_URI / Atlas IP whitelist');
    process.exit(1);
  }

  const catalog = loadCatalogFromApp();
  console.log(
    `📦 Catalog: ${catalog.userTypes.length} user types, ${catalog.industries.length} industries, ${catalog.designations.length} designations`
  );

  // 1) Upload brand logos first
  console.log('\n☁️  Uploading brand logos…');
  const logoDir = path.join(ASSETS, 'logos');
  const logoFiles = [
    'burger_king.png',
    'wow_momos.png',
    'kattar_chai.png',
    'waffle_house.png',
    'dominos.png',
    'starbucks.png',
    'frenvi_logo.png'
  ];
  for (const file of logoFiles) {
    const fp = fs.existsSync(path.join(logoDir, file))
      ? path.join(logoDir, file)
      : path.join(ASSETS, file);
    if (!fs.existsSync(fp)) continue;
    await uploadFile(fp, {
      folder: 'frenvi/logos',
      publicId: file.replace(/\.(png|jpe?g|webp)$/i, '')
    });
    process.stdout.write('.');
  }
  console.log(' done');

  // 2) Rewrite all catalog photos → Cloudinary
  console.log('\n☁️  Uploading catalog images (user-types / industries / designations)…');
  const userTypes = await rewritePhotosDeep(catalog.userTypes);
  const industries = await rewritePhotosDeep(catalog.industries);
  const designations = await rewritePhotosDeep(catalog.designations);
  console.log(`\n   uploaded/cached ${uploadedCache.size} image refs`);

  // Patch industry counts from designations
  const countByIndustry = designations.reduce((acc, d) => {
    acc[d.industryId] = (acc[d.industryId] || 0) + 1;
    return acc;
  }, {});
  industries.forEach((ind) => {
    ind.count = countByIndustry[ind.id] || ind.count || 0;
  });

  // 3) Upsert catalog collections
  console.log('\n🗄️  Seeding user types…');
  for (const u of userTypes) {
    await UserType.findOneAndUpdate({ id: u.id }, { $set: u }, { upsert: true });
  }
  console.log(`   ${userTypes.length} user types`);

  console.log('🗄️  Seeding industries…');
  for (const ind of industries) {
    await Industry.findOneAndUpdate({ id: ind.id }, { $set: ind }, { upsert: true });
  }
  console.log(`   ${industries.length} industries`);

  console.log('🗄️  Seeding designations…');
  for (const d of designations) {
    await Designation.findOneAndUpdate({ id: d.id }, { $set: d }, { upsert: true });
  }
  console.log(`   ${designations.length} designations`);

  // 4) Replace live system shifts with full designation-based catalog
  console.log('\n🗄️  Seeding live shifts…');
  const shifts = buildShifts(designations);
  await Shift.deleteMany({ posterPhone: 'system' });
  if (shifts.length) {
    await Shift.insertMany(shifts);
  }
  console.log(`   ${shifts.length} live shifts`);

  // 5) Staff + demo workers
  console.log('\n👤 Seeding staff + demo workers…');
  const staffN = await seedStaff();
  const workerN = await seedDemoWorkers();
  console.log(`   ${staffN} staff, ${workerN} demo workers`);

  const totals = {
    userTypes: await UserType.countDocuments(),
    industries: await Industry.countDocuments(),
    designations: await Designation.countDocuments(),
    shifts: await Shift.countDocuments(),
    users: await User.countDocuments()
  };

  console.log('\n✅ Seed complete');
  console.log(JSON.stringify(totals, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
