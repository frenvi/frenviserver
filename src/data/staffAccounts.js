const crypto = require('crypto');

const PASSWORD_SALT = 'frenvi_staff_salt_v1';

function hashPassword(password) {
  return crypto.scryptSync(String(password), PASSWORD_SALT, 32).toString('hex');
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  const incoming = hashPassword(password);
  try {
    return crypto.timingSafeEqual(Buffer.from(incoming, 'hex'), Buffer.from(hash, 'hex'));
  } catch (_) {
    return incoming === hash;
  }
}

const STAFF_ACCOUNTS = [
  {
    username: 'admin',
    name: 'Arjun Mehta',
    email: 'admin@frenvi.com',
    phone: '9000000001',
    password: 'admin123',
    department: 'admin',
    role: 'admin',
    avatar: '👔',
    title: 'Main Admin'
  },
  {
    username: 'neha',
    name: 'Neha Kapoor',
    email: 'neha@frenvi.com',
    phone: '9000000002',
    password: 'neha123',
    department: 'marketing',
    role: 'marketing',
    avatar: '📣',
    title: 'Marketing Lead'
  },
  {
    username: 'rohan',
    name: 'Rohan Iyer',
    email: 'rohan@frenvi.com',
    phone: '9000000003',
    password: 'rohan123',
    department: 'marketing',
    role: 'marketing',
    avatar: '📊',
    title: 'Marketing Associate'
  },
  {
    username: 'priya',
    name: 'Priya Sharma',
    email: 'priya@frenvi.com',
    phone: '9000000004',
    password: 'priya123',
    department: 'boarding',
    role: 'boarding',
    avatar: '👩‍💼',
    title: 'Senior Evaluator'
  },
  {
    username: 'rajesh',
    name: 'Rajesh Verma',
    email: 'rajesh@frenvi.com',
    phone: '9000000005',
    password: 'rajesh123',
    department: 'boarding',
    role: 'boarding',
    avatar: '👨‍💼',
    title: 'Logistics & QSR Lead'
  },
  {
    username: 'anita',
    name: 'Anita Reddy',
    email: 'anita@frenvi.com',
    phone: '9000000006',
    password: 'anita123',
    department: 'boarding',
    role: 'boarding',
    avatar: '👩‍💻',
    title: 'Customer Experience Lead'
  }
];

function publicStaff(account) {
  return {
    username: account.username,
    name: account.name,
    email: account.email,
    department: account.department,
    role: account.role,
    avatar: account.avatar,
    title: account.title
  };
}

module.exports = {
  STAFF_ACCOUNTS,
  hashPassword,
  verifyPassword,
  publicStaff
};
