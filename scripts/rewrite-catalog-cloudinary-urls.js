/**
 * Rewrite app designations-data.js photo paths to Cloudinary delivery URLs.
 * Usage: node scripts/rewrite-catalog-cloudinary-urls.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { cloudName, deliveryUrl } = require('../src/config/cloudinary');

const FILE = path.join(__dirname, '../../app/src/main/assets/js/designations-data.js');

function toCloudinary(rel) {
  if (!rel || typeof rel !== 'string') return rel;
  if (/^https?:\/\//i.test(rel)) return rel;
  const cleaned = rel
    .replace(/^\/+/, '')
    .replace(/^img\//, '')
    .replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
  return deliveryUrl(`frenvi/${cleaned}`, 'f_auto,q_auto,c_fill,w_640,h_480');
}

function walk(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(walk);
  const out = { ...node };
  for (const key of Object.keys(out)) {
    if (key === 'photo' || key === 'fallbackPhoto') out[key] = toCloudinary(out[key]);
    else if (typeof out[key] === 'object') out[key] = walk(out[key]);
  }
  return out;
}

function main() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const match = raw.match(/window\.FRENVI_DESIGNATIONS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('Could not parse designations-data.js');
  const catalog = JSON.parse(match[1]);
  const next = walk(catalog);
  const header = '/** Auto-generated — photos served from Cloudinary */\n';
  const body = `window.FRENVI_DESIGNATIONS = ${JSON.stringify(next, null, 2)};\n`;
  fs.writeFileSync(FILE, header + body, 'utf8');
  console.log(`Rewrote ${FILE}`);
  console.log(`Cloud: ${cloudName()}`);
  console.log(`userTypes=${next.userTypes.length} industries=${next.industries.length} designations=${next.designations.length}`);
}

main();
