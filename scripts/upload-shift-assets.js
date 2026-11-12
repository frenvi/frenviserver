/**
 * Upload local brand logos to Cloudinary (frenvi/logos/*)
 * Usage: node scripts/upload-shift-assets.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { ensureBrandLogosUploaded, isConfigured, cloudName } = require('../src/services/cloudinaryMedia');

async function main() {
  if (!isConfigured()) {
    console.error('Cloudinary env missing. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET');
    process.exit(1);
  }
  console.log(`Uploading logos to cloud: ${cloudName()}`);
  const results = await ensureBrandLogosUploaded();
  console.log(`Done — ${results.length} assets uploaded.`);
  results.forEach((r) => console.log(`  ${r.publicId}\n    ${r.url}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
