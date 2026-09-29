// admin-routes.js — GMDS Admin API (server.js এ: require('./admin-routes')(app, dbs))
// Render Environment এ ADMIN_KEY সেট করুন (কমপক্ষে 32 অক্ষরের র‍্যান্ডম)।
const crypto = require('crypto');

// ⚠️ এখানে আপনার আসল Firebase path গুলো মিলিয়ে নিন (dbs = firebase-admin database instances)
const SOURCES = (dbs) => [
  { svc: 'food',     db: dbs.core,  path: 'all_orders' },
  { svc: 'delivery', db: dbs.med,   path: 'delivery_orders' },
  { svc: 'house',    db: dbs.house, path: 'house_orders' },
  { svc: 'seba',     db: dbs.seba,  path: 'seba_orders' },
];

const fails = new Map(); // ip -> {n, t} : ভুল key দিলে ব্লক
function authed(req, res) {
  const ip = req.ip, f = fails.get(ip) || { n: 0, t: Date.now() };
  if (f.n >= 8 && Date.now() - f.t < 15 * 60000) { res.status(429).json({ status: 'error', message: 'Too many attempts' }); return false; }
  const a = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const b = Buffer.from(process.env.ADMIN_KEY || '');
  const ok = b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { fails.set(ip, { n: f.n + 1, t: f.n ? f.t : Date.now() }); res.status(401).json({ status: 'error', message: 'Unauthorized' }); return false; }
  fails.delete(ip); return true;
}

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };
function createdAt(o, key) {
  if (o.rawTimestamp) return +o.rawTimestamp;
  if (o.createdAt) return +o.createdAt;
  const id = String(o.orderId || key), m = id.match(/(\d{12,})/);
  if (m) return +m[1];
  const p = Date.parse(o.time || o.timestamp || ''); return isNaN(p) ? 0 : p;
}

function normalize(svc, key, o) {
  const d = o.details || {};
  const amount = svc === 'food' ? num(o.grandTotal) : svc === 'delivery' ? num(o.price ?? d.totalFare) : num(o.price);
  return {
    orderId: o.orderId || key, service: svc,
    customer: o.user || o.customer || '', phone: o.phone || '',
    address: o.address || d.pickup || '', location: o.gpsLocation || o.location || '',
    title: svc === 'food' ? 'Food Order' : svc === 'delivery' ? (d.type || 'Delivery/Ride') : (o.service || o.serviceName || svc),
    status: o.status || o.riderStatus || 'Pending',
    payMode: o.payMode || 'COD', razorpayPaymentId: o.razorpayPaymentId || '',
    amount, priceText: svc === 'seba' ? String(o.price || '') : '',
    items: svc === 'food' ? (o.items || []).map(i => ({ name: i.name, hotel: i.hotel, qty: i.qty, price: i.price })) : [],
    details: svc === 'delivery' ? d : svc === 'house' ? { professional: o.professional, problem: o.problem, appointment: o.appointmentTime } : svc === 'seba' ? { category: o.category } : {},
    subtotal: num(o.subtotal), deliveryFee: num(o.deliveryFee),
    createdAt: createdAt(o, key),
    cancelledAt: o.cancelledAt || 0, cancelReason: o.cancelReason || '', refunded: !!o.refunded,
    riderName: o.riderName || '', riderPhone: o.riderPhone || '',
  };
}

let cache = { t: 0, data: [] };
module.exports = function (app, dbs) {
  app.get('/api/admin/orders', async (req, res) => {
    if (!authed(req, res)) return;
    try {
      if (Date.now() - cache.t > 3000) {
        const all = [];
        await Promise.all(SOURCES(dbs).map(async (s) => {
          if (!s.db) return;
          const snap = await s.db.ref(s.path).orderByKey().limitToLast(3000).once('value');
          snap.forEach((c) => { const v = c.val(); if (v && typeof v === 'object') all.push(normalize(s.svc, c.key, v)); });
        }));
        all.sort((a, b) => b.createdAt - a.createdAt);
        cache = { t: Date.now(), data: all };
      }
      res.json({ status: 'success', serverTime: Date.now(), orders: cache.data });
    } catch (e) { console.error('admin/orders', e); res.status(500).json({ status: 'error', message: 'Server error' }); }
  });
};
