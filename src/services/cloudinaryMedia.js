const path = require('path');
const fs = require('fs');
const { cloudinary, isConfigured, deliveryUrl, cloudName } = require('../config/cloudinary');

const LOGO_FOLDER = 'frenvi/logos';
const SHIFT_FOLDER = 'frenvi/shifts';

const KNOWN_LOGOS = {
  'burger king': 'burger_king',
  wow: 'wow_momos',
  momo: 'wow_momos',
  kattar: 'kattar_chai',
  chai: 'kattar_chai',
  waffle: 'waffle_house',
  domino: 'dominos',
  starbucks: 'starbucks',
  frenvi: 'frenvi_logo'
};

function stripExt(name) {
  return String(name || '').replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
}

function logoPublicId(filenameOrBrand) {
  const raw = String(filenameOrBrand || '').trim();
  if (!raw) return `${LOGO_FOLDER}/frenvi_logo`;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  if (raw.includes('/')) return stripExt(raw);
  const lower = raw.toLowerCase();
  for (const [needle, id] of Object.entries(KNOWN_LOGOS)) {
    if (lower.includes(needle)) return `${LOGO_FOLDER}/${id}`;
  }
  return `${LOGO_FOLDER}/${stripExt(raw) || 'frenvi_logo'}`;
}

function resolveShiftImage(shiftLike) {
  const s = shiftLike || {};
  if (s.outletPhoto && String(s.outletPhoto).trim()) {
    return deliveryUrl(s.outletPhoto, 'f_auto,q_auto,c_fill,w_640,h_480');
  }
  if (s.logoUrl && String(s.logoUrl).trim()) {
    return deliveryUrl(logoPublicId(s.logoUrl), 'f_auto,q_auto,c_fill,w_240,h_240');
  }
  return deliveryUrl(`${LOGO_FOLDER}/frenvi_logo`, 'f_auto,q_auto,c_fill,w_240,h_240');
}

async function uploadDataUri(dataUri, { folder = SHIFT_FOLDER, publicId } = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary is not configured');
  }
  if (!dataUri || typeof dataUri !== 'string') {
    throw new Error('Missing image payload');
  }
  const opts = {
    folder,
    resource_type: 'image',
    overwrite: true,
    invalidate: true
  };
  if (publicId) opts.public_id = publicId;
  const result = await cloudinary.uploader.upload(dataUri, opts);
  return {
    publicId: result.public_id,
    url: result.secure_url || result.url,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    format: result.format
  };
}

async function uploadFile(filePath, { folder = LOGO_FOLDER, publicId } = {}) {
  if (!isConfigured()) throw new Error('Cloudinary is not configured');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const opts = {
    folder,
    resource_type: 'image',
    overwrite: true,
    invalidate: true,
    use_filename: !publicId,
    unique_filename: false
  };
  if (publicId) opts.public_id = publicId;
  const result = await cloudinary.uploader.upload(filePath, opts);
  return {
    publicId: result.public_id,
    url: result.secure_url || result.url
  };
}

async function uploadOutletPhoto(dataUri, brandHint) {
  const safeBrand = String(brandHint || 'outlet')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'outlet';
  const stamp = Date.now().toString(36);
  return uploadDataUri(dataUri, {
    folder: SHIFT_FOLDER,
    publicId: `${safeBrand}-${stamp}`
  });
}

function defaultLogoAssetsDir() {
  return path.join(__dirname, '../../../app/src/main/assets');
}

async function ensureBrandLogosUploaded(assetsDir = defaultLogoAssetsDir()) {
  if (!isConfigured()) {
    console.warn('⚠️ Cloudinary not configured — skipping logo upload');
    return [];
  }
  const files = [
    'burger_king.png',
    'wow_momos.png',
    'kattar_chai.png',
    'waffle_house.png',
    'dominos.png',
    'starbucks.png',
    'frenvi_logo.png'
  ];
  const uploaded = [];
  for (const file of files) {
    const candidates = [
      path.join(assetsDir, 'logos', file),
      path.join(assetsDir, file)
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      console.warn(`ℹ️ Logo missing locally: ${file}`);
      continue;
    }
    const publicId = stripExt(file);
    const result = await uploadFile(found, { folder: LOGO_FOLDER, publicId });
    uploaded.push(result);
    console.log(`☁️ Uploaded ${file} → ${result.publicId}`);
  }
  return uploaded;
}

module.exports = {
  LOGO_FOLDER,
  SHIFT_FOLDER,
  logoPublicId,
  resolveShiftImage,
  uploadDataUri,
  uploadFile,
  uploadOutletPhoto,
  ensureBrandLogosUploaded,
  deliveryUrl,
  cloudName,
  isConfigured
};
