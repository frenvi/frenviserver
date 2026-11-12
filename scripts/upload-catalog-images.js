/**
 * Upload all designations-data.js photos to Cloudinary.
 * Usage: node scripts/upload-catalog-images.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { cloudinary, isConfigured, cloudName } = require('../src/config/cloudinary');

const ASSETS = path.join(__dirname, '../../app/src/main/assets');
const DESIGNATIONS_JS = path.join(ASSETS, 'js/designations-data.js');

function loadCatalog() {
  const raw = fs.readFileSync(DESIGNATIONS_JS, 'utf8');
  const match = raw.match(/window\.FRENVI_DESIGNATIONS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('Could not parse designations-data.js');
  return JSON.parse(match[1]);
}

function collectPhotos(catalog) {
  const photos = new Set();
  for (const u of catalog.userTypes || []) if (u.photo) photos.add(u.photo);
  for (const i of catalog.industries || []) if (i.photo) photos.add(i.photo);
  for (const des of catalog.designations || []) {
    if (des.photo) photos.add(des.photo);
    if (des.fallbackPhoto) photos.add(des.fallbackPhoto);
    for (const c of des.categories || []) if (c.photo) photos.add(c.photo);
  }
  return [...photos];
}

async function main() {
  if (!isConfigured()) {
    console.error('Cloudinary not configured');
    process.exit(1);
  }
  const catalog = loadCatalog();
  const photos = collectPhotos(catalog);
  console.log(`Uploading ${photos.length} catalog images to ${cloudName()}…`);

  let ok = 0;
  let miss = 0;
  let fail = 0;

  for (const rel of photos) {
    const file = path.join(ASSETS, String(rel).replace(/^\/+/, ''));
    if (!fs.existsSync(file)) {
      miss += 1;
      console.log(`MISS ${rel}`);
      continue;
    }
    const cleaned = String(rel)
      .replace(/^img\//, '')
      .replace(/\.(png|jpe?g|webp|gif|svg)$/i, '')
      .replace(/\\/g, '/');
    const folder = `frenvi/${path.posix.dirname(cleaned)}`;
    const base = path.posix.basename(cleaned);
    try {
      await cloudinary.uploader.upload(file, {
        folder: folder === 'frenvi/.' ? 'frenvi' : folder,
        public_id: base,
        overwrite: true,
        invalidate: true,
        resource_type: 'image'
      });
      ok += 1;
      process.stdout.write('.');
    } catch (err) {
      fail += 1;
      console.log(`\nFAIL ${rel}: ${err.message}`);
    }
  }

  console.log(`\nDone ok=${ok} miss=${miss} fail=${fail}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
