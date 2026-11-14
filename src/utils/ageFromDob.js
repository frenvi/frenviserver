/**
 * Parse Aadhaar / Cashfree DOB strings and compute age.
 * Supports: YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD,
 *           DD-MMM-YYYY, DD MMM YYYY, and year-only (YOB).
 */

const MONTH_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

function parseDob(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  }

  const s = String(raw).trim();
  if (!s) return null;

  let y;
  let m;
  let d;

  // YYYY-MM-DD or YYYY/MM/DD
  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  }

  // DD-MM-YYYY or DD/MM/YYYY
  if (!y) {
    match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (match) {
      d = Number(match[1]);
      m = Number(match[2]);
      y = Number(match[3]);
    }
  }

  // DD-MMM-YYYY / DD MMM YYYY / DD-Mmm-YY
  if (!y) {
    match = s.match(/^(\d{1,2})[-\s/.]+([A-Za-z]{3,9})[-\s/.]+(\d{4}|\d{2})$/);
    if (match) {
      d = Number(match[1]);
      m = MONTH_MAP[String(match[2]).toLowerCase()] || 0;
      y = Number(match[3]);
      if (y < 100) y += y >= 50 ? 1900 : 2000;
    }
  }

  // Year-only is handled by isAdultFromYearOfBirth — do not invent a day/month here.
  if (!y || !m || !d) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

function ageFromDob(raw, now = new Date()) {
  const dob = parseDob(raw);
  if (!dob) return null;

  let age = now.getFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getMonth() - dob.getUTCMonth();
  const dayDiff = now.getDate() - dob.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
  return age;
}

/**
 * True only when we have confirmed the person is under 18.
 * Unknown / not-yet-KYC must NOT be treated as underage.
 */
function isConfirmedUnderage(userLike) {
  if (!userLike) return false;
  if (userLike.kycRejectedReason === 'UNDERAGE') return true;
  const status = userLike.kycStatus || '';
  // Age only counts after a KYC attempt that stored it
  if (
    userLike.age != null &&
    Number(userLike.age) < 18 &&
    (status === 'FAILED' || status === 'VERIFIED' || userLike.kycRejectedReason)
  ) {
    return true;
  }
  if (userLike.isAdult === false && (status === 'FAILED' || status === 'VERIFIED')) {
    return true;
  }
  return false;
}

/** Normalize legacy isAdult:false on NEW/PENDING users (old default). */
function normalizeAdultFlag(userLike) {
  if (!userLike) return null;
  const status = userLike.kycStatus || 'NEW';
  if ((status === 'NEW' || status === 'PENDING') && userLike.kycRejectedReason !== 'UNDERAGE') {
    return null;
  }
  if (userLike.isAdult == null) return null;
  return !!userLike.isAdult;
}

function isAdultFromDob(raw, minAge = 18) {
  const age = ageFromDob(raw);
  if (age == null) return { ok: false, age: null, reason: 'DOB_MISSING' };
  if (age < minAge) return { ok: false, age, reason: 'UNDERAGE' };
  return { ok: true, age, reason: null };
}

/**
 * When Cashfree only returns year_of_birth:
 * - definitely adult if even the youngest person born that year is >= minAge
 * - definitely underage if even the oldest is < minAge
 * - otherwise ask for retry (ambiguous birthday)
 */
function isAdultFromYearOfBirth(yob, minAge = 18) {
  const y = Number(String(yob || '').replace(/\D/g, '').slice(0, 4));
  if (!y || y < 1900 || y > 2100) {
    return { ok: false, age: null, reason: 'DOB_MISSING' };
  }
  const oldest = ageFromDob(`${y}-01-01`);
  const youngest = ageFromDob(`${y}-12-31`);
  if (youngest != null && youngest >= minAge) {
    return { ok: true, age: youngest, reason: null, dateOfBirth: parseDob(`${y}-12-31`) };
  }
  if (oldest != null && oldest < minAge) {
    return { ok: false, age: oldest, reason: 'UNDERAGE', dateOfBirth: parseDob(`${y}-01-01`) };
  }
  return { ok: false, age: null, reason: 'DOB_MISSING' };
}

const MINOR_MESSAGE =
  'Your age is not supported to work for jobs. Please apply when you turn 18+.';

module.exports = {
  parseDob,
  ageFromDob,
  isAdultFromDob,
  isAdultFromYearOfBirth,
  isConfirmedUnderage,
  normalizeAdultFlag,
  MINOR_MESSAGE
};
