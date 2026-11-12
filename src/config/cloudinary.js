const { v2: cloudinary } = require('cloudinary');

function configureCloudinary() {
  const url = process.env.CLOUDINARY_URL;
  if (url) {
    cloudinary.config({ url, secure: true });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });
  }
  return cloudinary;
}

function isConfigured() {
  return Boolean(
    process.env.CLOUDINARY_URL ||
      (process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET)
  );
}

function cloudName() {
  return (
    process.env.CLOUDINARY_CLOUD_NAME ||
    (process.env.CLOUDINARY_URL || '').split('@').pop() ||
    ''
  );
}

/** Build a delivery URL for a public_id or passthrough absolute URLs. */
function deliveryUrl(publicIdOrUrl, transform = 'f_auto,q_auto') {
  if (!publicIdOrUrl) return '';
  const raw = String(publicIdOrUrl).trim();
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  const cloud = cloudName();
  if (!cloud) return raw;
  let id = raw.replace(/^\/+/, '').replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
  if (!id.includes('/')) id = `frenvi/logos/${id}`;
  const t = transform ? `${transform}/` : '';
  return `https://res.cloudinary.com/${cloud}/image/upload/${t}${id}`;
}

module.exports = {
  configureCloudinary,
  isConfigured,
  cloudName,
  deliveryUrl,
  cloudinary: configureCloudinary()
};
