'use strict';
/* =========================================================================
   GMDS SECURE BACKEND  v4.0.0  (FINAL MAIN SERVER)
   = v3.4.0 (login/device-token, payments, cancel/refund, delete, tracking,
             admin-routes, rider-routes)
   + BLUEPRINT:
       1. সর্বোচ্চ ১১ কিমি ডেলিভারি রেঞ্জ (সার্ভারে বাধ্যতামূলক)
       2. ৮.৫ কিমির বেশি হলে ডেলিভারি/ভাড়ার ওপর ৫০% রিটার্ন চার্জ
       3. অ্যাডমিন প্যানেলের gmds_zones পলিগন দিয়ে সার্ভার-সাইড জিওফেন্সিং
       4. /api/quote : অ্যাপকে সার্ভারের হিসাব করা চার্জ জানানো
       5. সব সিকিউর রাউটে ডিভাইস-টোকেন (ফোন নম্বর টোকেন থেকে)

   Render Environment Variables:
     RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET            (বাধ্যতামূলক)
     RAZORPAY_WEBHOOK_SECRET                         (webhook চালাতে)
     FIREBASE_SA_CORE / _HOUSE / _RIDER / _SEBA      (Service Account)
     ADMIN_KEY, RIDER_SECRET                         (admin-routes / rider-routes)
     ALLOWED_ORIGINS                                 (কমা দিয়ে)
     MONGO_URI                                       (ঐচ্ছিক ব্যাকআপ)
     REQUIRE_FIREBASE_OTP=true                       (ঐচ্ছিক)
     MAX_RANGE_KM (ডিফল্ট 11), RETURN_THRESHOLD_KM (ডিফল্ট 8.5),
     RETURN_CHARGE_RATE (ডিফল্ট 0.5)                 (ঐচ্ছিক)
   ========================================================================= */

try { require('dotenv').config(); } catch (e) { /* dotenv ঐচ্ছিক */ }

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
app.set('trust proxy', 1); // required on Render
app.disable('x-powered-by');

// =========================================================================
// 1. ENVIRONMENT & BLUEPRINT CONSTANTS
// =========================================================================
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RZ_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const REQUIRE_OTP = process.env.REQUIRE_FIREBASE_OTP === 'true';
const MAX_DEVICES = 5;

// ---- ব্লুপ্রিন্টের নিয়ম ----
const MAX_RANGE_KM = Number(process.env.MAX_RANGE_KM) || 11.0;
const RETURN_THRESHOLD_KM = Number(process.env.RETURN_THRESHOLD_KM) || 8.5;
const RETURN_CHARGE_RATE = Number(process.env.RETURN_CHARGE_RATE) || 0.5;
const ROAD_FACTOR = 1.64;        // অ্যাপের calculateDistance এর সাথে হুবহু এক (খাবারের জন্য)
const RANGE_TOLERANCE_KM = 0.15;

if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    console.error('❌ RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables are required.');
    process.exit(1);
}
const razorpay = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET });

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ALLOWED_ORIGINS.length) console.warn('⚠️ ALLOWED_ORIGINS is empty - any website origin is allowed. Set it in production.');
if (!RZ_WEBHOOK_SECRET) console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET is not set - webhook is DISABLED.');

// =========================================================================
// 2. FIREBASE ADMIN (4 projects)
// =========================================================================
// 'medicine' কী-টা শুধু ভেতরের লেবেল; আসল ডাটাবেস gmds-rider
const FB_DEFS = {
    core:     { env: 'FIREBASE_SA_CORE',  url: 'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app' },
    house:    { env: 'FIREBASE_SA_HOUSE', url: 'https://gmds-house-half-default-rtdb.firebaseio.com' },
    medicine: { env: 'FIREBASE_SA_RIDER', url: 'https://gmds-rider-default-rtdb.firebaseio.com' },
    seba:     { env: 'FIREBASE_SA_SEBA',  url: 'https://dital-cd21f-default-rtdb.firebaseio.com' }
};
const dbs = {};
const fbApps = {};

function loadServiceAccount(raw) {
    const v = String(raw).trim();
    if (v.startsWith('{')) return JSON.parse(v);
    if (v.startsWith('/')) return JSON.parse(fs.readFileSync(v, 'utf8'));
    return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
}

for (const [name, def] of Object.entries(FB_DEFS)) {
    const raw = process.env[def.env];
    if (!raw) { console.warn(`⚠️ ${def.env} is not set. Firebase "${name}" features are DISABLED.`); continue; }
    try {
        const fbApp = admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount(raw)), databaseURL: def.url }, name);
        fbApps[name] = fbApp;
        dbs[name] = fbApp.database();
        console.log(`✅ Firebase connected: ${name}`);
    } catch (e) {
        console.error(`❌ Firebase init failed for "${name}":`, e.message);
    }
}
if (!dbs.core) { console.error('❌ Core Firebase (FIREBASE_SA_CORE) is required.'); process.exit(1); }

// =========================================================================
// 3. OPTIONAL MONGODB (audit backup only)
// =========================================================================
let OrderBackup = null;
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ MongoDB connected (backup only)'))
        .catch(err => console.error('❌ MongoDB connection error:', err.message));
    const orderSchema = new mongoose.Schema({
        orderId: String, kind: String, customerName: String, phone: String,
        orderAmount: String, paymentMode: String, razorpayPaymentId: String,
        riderStatus: String, snapshot: mongoose.Schema.Types.Mixed,
        timestamp: { type: Date, default: Date.now }
    });
    OrderBackup = mongoose.model('Order', orderSchema);
}
function backupOrder(kind, record, amount) {
    if (!OrderBackup || mongoose.connection.readyState !== 1) return;
    try {
        new OrderBackup({
            orderId: String(record.orderId), kind,
            customerName: record.user || record.customer || 'Unknown',
            phone: record.phone, orderAmount: String(amount),
            paymentMode: record.payMode || 'COD',
            razorpayPaymentId: record.razorpayPaymentId || '',
            riderStatus: record.riderStatus || record.status || '',
            snapshot: record
        }).save().catch(e => console.error('Mongo backup failed:', e.message));
    } catch (e) { console.error('Mongo backup failed:', e.message); }
}

// =========================================================================
// 4. HELPERS
// =========================================================================
const PHONE_RE = /^[0-9]{10}$/;
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{8,30}$/;
const RZP_ORDER_ID_RE = /^order_[A-Za-z0-9]{8,30}$/;

function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function bodyOf(req) { return (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {}; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function stripUndefined(o) { return JSON.parse(JSON.stringify(o)); }
function istNow() { return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cleanText(v, max) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/[<>\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function toNum(v) {
    if (v === '' || v === null || v === undefined) return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}
function mapsUrlOr(v, fallback) {
    const s = cleanText(v, 300);
    return s.startsWith('https://www.google.com/maps') ? s : fallback;
}
function getDb(name) {
    const d = dbs[name];
    if (!d) throw httpError(503, 'This service is temporarily unavailable. Please try again later.');
    return d;
}
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function orderTs(o, key) {
    const c = Number(o.createdAt);
    if (c > 0) return c;
    const p = parseInt(String(o.orderId || key).replace(/^\D+/, ''), 10);
    return p > 0 ? p : Date.now();
}
// "https://www.google.com/maps?q=lat,lng" এবং ".../search/?api=1&query=lat,lng" দুটোই পড়ে
function parseGps(s) {
    const m = /[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(s || ''));
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return (lat >= 5 && lat <= 38 && lng >= 67 && lng <= 98) ? { lat, lng } : null;
}

// In-memory limiter keyed by phone / key
const hitStore = new Map();
function hit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hitStore.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hitStore.set(key, arr); return false; }
    arr.push(now); hitStore.set(key, arr);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hitStore) {
        const f = arr.filter(t => now - t < 24 * 3600 * 1000);
        if (f.length) hitStore.set(k, f); else hitStore.delete(k);
    }
}, 10 * 60 * 1000).unref();

// =========================================================================
// 5. MIDDLEWARE (webhook অবশ্যই express.json এর আগে)
// =========================================================================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
});

app.use(cors({
    origin: (origin, cb) => {
        if (!ALLOWED_ORIGINS.length || !origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }
}));

// ---- Razorpay Webhook: raw body + mandatory signature ----
app.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '200kb' }), asyncHandler(async (req, res) => {
    if (!RZ_WEBHOOK_SECRET) return res.status(503).json({ status: 'error', message: 'Webhook disabled.' });
    const sig = String(req.headers['x-razorpay-signature'] || '');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const expected = crypto.createHmac('sha256', RZ_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!sig || !safeEqual(expected, sig)) return res.status(400).json({ status: 'error', message: 'Invalid signature.' });

    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ status: 'error', message: 'Invalid JSON.' }); }

    if (event && event.event === 'payment.captured') {
        const pay = (((event.payload || {}).payment || {}).entity) || {};
        if (PAYMENT_ID_RE.test(String(pay.id)) && RZP_ORDER_ID_RE.test(String(pay.order_id))) {
            const created = (await getDb('core').ref('pay_orders/' + pay.order_id).once('value')).val();
            if (created && Number(created.amountPaise) === Number(pay.amount)) {
                await getDb('core').ref('payments/' + pay.id).transaction(cur => (cur === null ? {
                    razorpayOrderId: pay.order_id, amountPaise: Number(pay.amount),
                    phone: String(created.phone), verifiedAt: Date.now(), used: false, source: 'webhook'
                } : undefined));
                console.log(`🔔 [WEBHOOK] captured ${pay.id}`);
            }
        }
    }
    res.json({ status: 'ok' });
}));

app.use(express.json({ limit: '100kb' }));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 400,
    skip: (req) => req.originalUrl.startsWith('/api/admin/') || req.originalUrl.startsWith('/api/rider/'),
    message: { status: 'error', message: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true, legacyHeaders: false
});
const orderLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 15,
    message: { status: 'error', message: 'Security Lock: You are placing orders too fast. Please wait a few minutes.' },
    standardHeaders: true, legacyHeaders: false
});
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    message: { status: 'error', message: 'Too many login attempts. Please try again later.' },
    standardHeaders: true, legacyHeaders: false
});
app.use('/api/', globalLimiter);

// =========================================================================
// 6. DEVICE-TOKEN AUTH (টোকেন থেকেই ফোন নম্বর; body-র phone বিশ্বাস করা হয় না)
// =========================================================================
const tokenCache = new Map(); // hash -> { phone, exp }

const requireAuth = asyncHandler(async (req, res, next) => {
    let t = req.headers['x-device-token'] || '';
    const a = req.headers['authorization'];
    if (!t && typeof a === 'string' && a.startsWith('Bearer ')) t = a.slice(7);
    t = String(t).trim();
    const expired = () => httpError(401, 'Session expired. Please log in again.');
    if (!/^[a-f0-9]{64}$/.test(t)) throw expired();

    const h = sha256(t);
    const c = tokenCache.get(h);
    let phone;
    if (c && c.exp > Date.now()) {
        phone = c.phone;
    } else {
        const v = (await getDb('core').ref('device_tokens/' + h).once('value')).val();
        if (!v || !PHONE_RE.test(String(v.phone))) { tokenCache.delete(h); throw expired(); }
        phone = String(v.phone);
        if (tokenCache.size > 5000) tokenCache.clear();
        tokenCache.set(h, { phone, exp: Date.now() + 60 * 1000 });
    }
    req.userPhone = phone;
    req.tokenHash = h;
    next();
});

// =========================================================================
// 7. PAYMENT HELPERS
// =========================================================================
async function refundPaymentFully(paymentId, reason) {
    const pay = await razorpay.payments.fetch(paymentId);
    const refundable = (Number(pay.amount) || 0) - (Number(pay.amount_refunded) || 0);
    if (pay.status !== 'captured' || refundable <= 0) return { refundId: null, already: true };
    const r = await razorpay.payments.refund(paymentId, {
        amount: refundable, speed: 'optimum', notes: { reason: cleanText(reason, 200) }
    });
    return { refundId: r.id, amountPaise: refundable, already: false };
}

async function claimPayment(paymentId, phone, expectedPaise, orderKey) {
    const payRef = getDb('core').ref('payments/' + paymentId);
    const snap = await payRef.once('value');
    if (!snap.exists()) throw httpError(402, 'Payment not verified. Please complete the payment again.');
    const rec = snap.val();
    if (String(rec.phone) !== phone) throw httpError(403, 'This payment belongs to a different account.');
    if (rec.refundState) throw httpError(409, 'This payment has already been refunded.');

    if (Number(rec.amountPaise) !== expectedPaise) {
        let refunded = false;
        if (rec.used !== true) {
            try {
                const r = await refundPaymentFully(paymentId, 'Order total did not match the paid amount');
                await payRef.child('refundState').set({ refundId: r.refundId || null, at: Date.now(), reason: 'amount_mismatch' });
                refunded = true;
            } catch (e) { console.error('❌ Auto-refund failed for', paymentId, e.message); }
        }
        throw httpError(409, refunded
            ? 'Your order total changed, so the payment was refunded. Please review your basket and try again.'
            : 'Your order total did not match the payment. Please contact support with Payment ID: ' + paymentId);
    }

    const tx = await payRef.child('used').transaction(cur => (cur === true ? undefined : true));
    if (!tx.committed) throw httpError(409, 'This payment has already been used for another order.');
    await payRef.child('orderKey').set(String(orderKey));
}
async function releasePayment(paymentId) {
    try { await getDb('core').ref('payments/' + paymentId).update({ used: false, orderKey: null }); }
    catch (e) { console.error('❌ Could not release payment claim', paymentId, e.message); }
}

// =========================================================================
// 8. ORDER STORAGE & TRACKING HELPERS
// =========================================================================
async function createRecord(dbName, path, orderId, record) {
    const ref = getDb(dbName).ref(`${path}/${orderId}`);
    const clean = stripUndefined(record);
    const result = await ref.transaction(cur => (cur === null ? clean : undefined));
    if (!result.committed) throw httpError(409, 'This order ID already exists.');
}

function pickTracking(d) {
    return {
        riderStatus: d.riderStatus || d.status || 'Pending',
        status: d.status || null,
        riderName: d.riderName || null,
        riderPhone: d.riderPhone || null,
        vehicle: d.vehicle || (d.details && d.details.vehicle) || null,
        estTime: d.estTime || null,
        riderLat: d.riderLat || null,
        riderLng: d.riderLng || null
    };
}
async function writeTracking(dbName, orderId, record) {
    try { await getDb(dbName).ref('order_tracking/' + orderId).set({ ...pickTracking(record), updatedAt: Date.now() }); }
    catch (e) { console.error('Tracking write failed:', e.message); }
}

const trackingSig = new Map();
function mirrorTracking(dbName, path) {
    const db = dbs[dbName];
    if (!db) return;
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const query = db.ref(path).orderByChild('createdAt').startAt(cutoff);
    const handler = snap => {
        try {
            const d = snap.val();
            if (!d) return;
            const t = pickTracking(d);
            const cacheKey = dbName + ':' + snap.key;
            const sig = JSON.stringify(t);
            if (trackingSig.get(cacheKey) === sig) return;
            if (trackingSig.size > 5000) trackingSig.clear();
            trackingSig.set(cacheKey, sig);
            if (!d.riderLat) { delete t.riderLat; delete t.riderLng; }
            if (!d.estTime) delete t.estTime;
            db.ref('order_tracking/' + snap.key).update({ ...t, updatedAt: Date.now() })
                .catch(e => console.error('Tracking mirror write failed:', e.message));
        } catch (e) { console.error('Tracking mirror error:', e.message); }
    };
    query.on('child_added', handler, e => console.error('Tracking listener cancelled:', e.message));
    query.on('child_changed', handler, e => console.error('Tracking listener cancelled:', e.message));
    console.log(`👀 Tracking mirror active: ${dbName}/${path}`);
}

let productCache = { at: 0, list: [] };
async function getProducts() {
    if (Date.now() - productCache.at < 15000) return productCache.list;
    const snap = await getDb('core').ref('products').once('value');
    const list = Object.values(snap.val() || {}).filter(Boolean);
    productCache = { at: Date.now(), list };
    return list;
}

// ---- হোটেল খোলা আছে কি (সার্ভারের IST ঘড়ি) ----
function hotelIsOpen(node) {
    if (!node || typeof node !== 'object') return false;
    if (String(node.status || '').toUpperCase() === 'CLOSED') return false;
    if (!node.openTime || !node.closeTime) return true;
    const ist = new Date(Date.now() + 330 * 60000);
    const cur = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const [oH, oM] = String(node.openTime).split(':').map(Number);
    const [cH, cM] = String(node.closeTime).split(':').map(Number);
    if ([oH, oM, cH, cM].some(Number.isNaN)) return true;
    const o = oH * 60 + oM, c = cH * 60 + cM;
    let left;
    if (c < o) {
        if (cur >= o) left = 1440 - cur + c; else if (cur < c) left = c - cur; else return false;
    } else {
        if (cur >= o && cur < c) left = c - cur; else return false;
    }
    return left > 2;
}

// =========================================================================
// 8A. BLUEPRINT ENGINE: ZONE GEOFENCING + RANGE + RETURN CHARGE
// =========================================================================
function pointInPolygon(lat, lng, poly) {
    if (!Array.isArray(poly) || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i].lat, xi = poly[i].lng;
        const yj = poly[j].lat, xj = poly[j].lng;
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-10) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// অ্যাডমিন প্যানেলের gmds_zones (zone_name, polygon[{lat,lng}], active) — ১৫ সেকেন্ড ক্যাশ
let zoneCache = { at: 0, list: [] };
async function getZones() {
    if (Date.now() - zoneCache.at < 15000) return zoneCache.list;
    const snap = await getDb('core').ref('gmds_zones').once('value');
    const list = [];
    Object.values(snap.val() || {}).forEach(z => {
        if (!z || z.active === false || !z.polygon) return;
        const raw = Array.isArray(z.polygon) ? z.polygon : Object.values(z.polygon);
        const poly = raw
            .map(p => ({ lat: Number(p && p.lat), lng: Number(p && p.lng) }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (poly.length >= 3) list.push({ name: cleanText(z.zone_name, 60) || 'Zone', poly });
    });
    zoneCache = { at: Date.now(), list };
    return list;
}
// কোনো জোন আঁকা না থাকলে জোন-সীমাবদ্ধতা নেই (শুধু রেঞ্জ চলবে)
async function checkZone(lat, lng) {
    const zones = await getZones();
    if (!zones.length) return { ok: true, zone: null };
    const hitZone = zones.find(z => pointInPolygon(lat, lng, z.poly));
    return hitZone ? { ok: true, zone: hitZone.name } : { ok: false, zone: null };
}
const ZONE_MSG = 'দুঃখিত! আপনার এলাকাটি আমাদের সার্ভিস জোনের অন্তর্ভুক্ত নয়। (Sorry, your area is outside our service zone.)';
const RANGE_MSG = `দুঃখিত! এই লোকেশনটি আমাদের সর্বোচ্চ ${MAX_RANGE_KM} কিমি ডেলিভারি রেঞ্জের বাইরে। (Out of ${MAX_RANGE_KM} km delivery range.)`;

// রিটার্ন চার্জ: দূরত্ব > ৮.৫ কিমি হলে মূল ভাড়ার ওপর ৫০% যোগ
function withReturnCharge(baseFee, distanceKm) {
    const returnCharge = distanceKm > RETURN_THRESHOLD_KM ? Math.round(baseFee * RETURN_CHARGE_RATE) : 0;
    return { baseFee, returnCharge, finalFee: baseFee + returnCharge };
}

// ---- ডেলিভারি চার্জের মূল নিয়ম (অ্যাপের getDeliveryCharge এর হুবহু) ----
function slabFee(d) {
    if (d <= 1.5) return 10; if (d <= 2.5) return 12; if (d <= 3.5) return 15; if (d <= 4.7) return 17;
    if (d <= 5.7) return 20; if (d <= 6.5) return 23; if (d <= 7.5) return 25;
    return 25 + (d - 7.5) * 1.30;
}
function baseDeliveryFee(hotelNodes, gps, addrLower) {
    const pts = hotelNodes.filter(n => n && n.lat && n.lng);
    let base = 10;
    if (gps && pts.length) {
        const maxD = Math.max(...pts.map(n => haversineKm(gps.lat, gps.lng, Number(n.lat), Number(n.lng)) * ROAD_FACTOR));
        base = slabFee(maxD);
    }
    let multi = 0;
    if (pts.length > 1) {
        const d = haversineKm(Number(pts[0].lat), Number(pts[0].lng), Number(pts[1].lat), Number(pts[1].lng)) * ROAD_FACTOR;
        multi = d <= 3.0 ? 2 : 4;
    }
    let zone = 0;
    if (/fazilnagar|fazilnagore|ফাজিলনগর|ফাজিন\s*নগর|farazipara|ফারাজীপাড়া|ফরাজী\s*পাড়া|pakhi\s*para|পাখি\s*পাড়া/.test(addrLower)) zone = 27;
    else if (/gopalpur|গোপালপুর/.test(addrLower)) zone = 25;
    else if (/thanapara|thanar\s*para|থানাপাড়া|থানারপাড়া|থানার\s*পাড়া|পুরাতন\s*পাড়া/.test(addrLower)) zone = 15;
    else if (/char|চর|moktarpur|muktarpur|মুক্তারপুর|navingenj|nabinganj|নবীনগঞ্জ/.test(addrLower)) zone = 22;
    return Math.round(Math.max(base, zone) + multi);
}

// খাবারের অর্ডারের পূর্ণ হিসাব: রেঞ্জ + জোন + রিটার্ন চার্জ
async function computeFoodFee(hotelNodes, gps, addrLower) {
    if (!gps) throw httpError(400, 'অবৈধ জিপিএস লোকেশন। Please enable GPS and try again.');
    const pts = hotelNodes.filter(n => n && n.lat && n.lng);
    if (!pts.length) throw httpError(400, 'Restaurant location is not available. Please try again later.');

    const distanceKm = Math.max(...pts.map(n => haversineKm(gps.lat, gps.lng, Number(n.lat), Number(n.lng)) * ROAD_FACTOR));
    if (distanceKm > MAX_RANGE_KM + RANGE_TOLERANCE_KM) throw httpError(409, RANGE_MSG);

    const z = await checkZone(gps.lat, gps.lng);
    if (!z.ok) throw httpError(409, ZONE_MSG);

    const base = baseDeliveryFee(hotelNodes, gps, addrLower);
    return { distanceKm, zone: z.zone, ...withReturnCharge(base, distanceKm) };
}

// ঝুড়ি যাচাই: দাম, স্টক, হোটেল খোলা — সবই ডাটাবেস থেকে
async function resolveFoodBasket(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) throw httpError(400, 'Your basket is empty or invalid.');
    const wanted = new Map();
    for (const it of rawItems) {
        const id = cleanText(it && it.id, 60);
        const qty = Math.floor(toNum(it && it.qty));
        if (!id || !(qty >= 1) || qty > 50) throw httpError(400, 'Invalid item in basket.');
        wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    const products = await getProducts();
    const hotelNodes = new Map();
    const items = [];
    let subtotal = 0;
    for (const [id, qty] of wanted) {
        const p = products.find(x => x && String(x.id) === id);
        if (!p) throw httpError(400, 'An item in your basket is no longer available. Please refresh the menu.');
        const price = toNum(p.price);
        if (!(price > 0)) throw httpError(400, 'An item in your basket has an invalid price.');
        const stock = parseInt(p.stock_count, 10) || 0;
        if (stock < qty) throw httpError(409, `${cleanText(p.name, 60) || 'An item'} is out of stock.`);

        const hotelId = String(p.hotel || '').replace(/[^A-Za-z0-9]/g, '');
        if (!hotelId) throw httpError(400, 'An item in your basket has no restaurant assigned.');
        if (!hotelNodes.has(hotelId)) {
            hotelNodes.set(hotelId, (await getDb('core').ref('hotel_status/' + hotelId).once('value')).val());
        }
        if (!hotelIsOpen(hotelNodes.get(hotelId))) throw httpError(409, `${cleanText(p.hotel, 60)} is closed right now.`);

        subtotal += price * qty;
        items.push({ ...p, qty });
    }
    return { items, subtotal, hotels: [...hotelNodes.values()] };
}

// ---- Digital Seba: title -> price id ----
const SEBA_TITLE_TO_ID = {
    'Apply New e-PAN & Physical Card': 'new_pan',
    'PAN Card Correction / Update': 'correct_pan',
    'Lost PAN Card Recovery': 'lost_pan',
    'PAN to Aadhaar Card Link': 'link_pan_aadhaar',
    'PAN to Mobile Number Link': 'link_pan_mobile',
    'Premium PVC PAN Card Print': 'pvc_pan',
    'New Voter ID Registration': 'new_voter',
    'Voter ID Mobile Number Link': 'voter_mobile',
    'Voter ID Aadhaar Card Link': 'voter_aadhaar',
    'Voter ID Data Correction': 'correct_voter',
    'Premium PVC Voter Card Print': 'pvc_voter',
    'New Digital Ration Card Application': 'new_ration',
    'Ration Card Details Correction': 'correct_ration',
    'Premium PVC Ration Card Print': 'pvc_ration',
    'Ration Card Aadhaar Card Link': 'ration_aadhaar',
    'Ration Card Mobile Number Link': 'ration_mobile',
    'Family Member Separation / Split': 'split_ration'
};
async function sebaExpectedPrice(title) {
    const id = SEBA_TITLE_TO_ID[title];
    if (!id) return null;
    const snap = await getDb('seba').ref('seba_prices/' + id).once('value');
    const n = toNum(snap.val());
    return n > 0 ? n : null;
}

// ---- Delivery / Ride: রেঞ্জ + জোন + রিটার্ন চার্জসহ ন্যূনতম ভাড়া ----
function parcelBase(d) {
    if (d <= 1.5) return 13; if (d <= 2.5) return 16; if (d <= 3.5) return 19; if (d <= 4.7) return 23;
    if (d <= 5.7) return 27; if (d <= 6.5) return 30; if (d <= 7.5) return 33;
    return 33 + (d - 7.5) * 1.5;
}
// সার্ভারে শুধু সরলরেখার দূরত্ব আছে (সড়কপথ ≥ সরলরেখা); তাই দূরত্ব কম-করে ধরা হয়, গ্রাহক কখনো অতিরিক্ত কাটে না।
// quoteOnly=true হলে ভাড়া/ঠিকানা যাচাই বাদ, শুধু ন্যূনতম ভাড়া ফেরত দেয়।
async function buildDeliveryDetails(d, quoteOnly) {
    if (!d || typeof d !== 'object') throw httpError(400, 'Invalid booking details.');
    const type = d.type === 'Parcel Delivery' ? 'Parcel Delivery' : (d.type === 'Ride Booking' ? 'Ride Booking' : null);
    if (!type) throw httpError(400, 'Invalid booking type.');

    const pLat = toNum(d.pickupLat), pLng = toNum(d.pickupLng), dLat = toNum(d.dropLat), dLng = toNum(d.dropLng);
    const latOk = v => v >= 5 && v <= 38, lngOk = v => v >= 67 && v <= 98;
    if (!(latOk(pLat) && latOk(dLat) && lngOk(pLng) && lngOk(dLng))) throw httpError(400, 'অবৈধ জিপিএস লোকেশন। Invalid pick-up or drop-off location.');

    const straightKm = haversineKm(pLat, pLng, dLat, dLng);
    const dFloor = Math.max(1.0, straightKm - 0.3);
    if (dFloor > MAX_RANGE_KM) throw httpError(409, RANGE_MSG);

    // জিওফেন্সিং: পিক-আপ পয়েন্ট অনুমোদিত জোনের ভেতরে হতে হবে
    const z = await checkZone(pLat, pLng);
    if (!z.ok) throw httpError(409, ZONE_MSG);

    let fare = 0, pickup = '', drop = '';
    if (!quoteOnly) {
        fare = Math.round(toNum(d.totalFare));
        if (!(fare > 0 && fare <= 2000)) throw httpError(400, 'Invalid fare amount.');
        pickup = cleanText(d.pickup, 250); drop = cleanText(d.drop, 250);
        if (!pickup || !drop) throw httpError(400, 'Pick-up and drop-off addresses are required.');
    }

    const out = {
        type, nightChargeApplied: d.nightChargeApplied === true, totalFare: fare,
        distance: cleanText(d.distance, 20), pickup, drop,
        pickupLat: pLat, pickupLng: pLng, dropLat: dLat, dropLng: dLng
    };
    let floor;
    if (type === 'Parcel Delivery') {
        const size = ['Small', 'Medium', 'Large'].includes(d.size) ? d.size : (quoteOnly ? 'Small' : null);
        const itemName = cleanText(d.itemName, 80) || (quoteOnly ? 'Parcel' : '');
        const receiverPhone = String(d.receiverPhone || '').replace(/[^0-9]/g, '');
        if (!quoteOnly && (!size || !itemName || receiverPhone.length < 10 || receiverPhone.length > 13)) throw httpError(400, 'Invalid parcel details.');
        out.itemName = itemName; out.receiverPhone = receiverPhone; out.size = size;
        floor = parcelBase(dFloor) + (size === 'Small' ? 5 : size === 'Medium' ? 8 : 12);
    } else {
        const vehicle = ['Bike', 'E-Rickshaw (Toto)'].includes(d.vehicle) ? d.vehicle : null;
        if (!vehicle) throw httpError(400, 'Invalid vehicle type.');
        let passengers = Math.floor(toNum(d.passengers));
        if (vehicle === 'Bike') passengers = 1;
        if (!(passengers >= 1 && passengers <= 6)) throw httpError(400, 'Invalid passenger count.');
        out.vehicle = vehicle; out.passengers = passengers;
        if (vehicle === 'Bike') {
            floor = dFloor <= 2.3 ? 25 : 25 + (dFloor - 2.3) * 8;
        } else {
            const rate = passengers === 1 ? 18 : (passengers === 2 ? 16 : 14);
            floor = rate * passengers + (dFloor > 3 ? (dFloor - 3) * 2 * passengers : 0);
        }
    }
    // ৮.৫ কিমির বেশি হলে ৫০% রিটার্ন চার্জসহ ন্যূনতম ভাড়া
    const rc = withReturnCharge(Math.floor(floor), dFloor);
    if (!quoteOnly && fare < rc.finalFee - 2) throw httpError(409, 'Fare mismatch. Please recalculate the fare and try again.');

    out.returnChargeApplied = rc.returnCharge > 0;
    out.zone = z.zone || null;
    return { details: out, fare, minFare: rc.finalFee, distanceKm: dFloor, returnCharge: rc.returnCharge };
}

// =========================================================================
// 9. ROUTES
// =========================================================================
app.get('/', (req, res) => {
    res.json({
        status: 'success', message: 'GMDS Secure Backend is Live & Running! 🚀', version: '4.0.0',
        rules: { maxRangeKm: MAX_RANGE_KM, returnThresholdKm: RETURN_THRESHOLD_KM, returnChargeRate: RETURN_CHARGE_RATE }
    });
});

// ---- Login: device token তৈরি ----
app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = cleanText(b.phone, 10);
    const name = cleanText(b.name, 60) || 'User';
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
    if (!hit('login:' + phone, 5, 10 * 60 * 1000)) throw httpError(429, 'Too many login attempts for this number. Please wait.');

    if (REQUIRE_OTP) {
        const idToken = String(b.idToken || '').slice(0, 4000);
        if (!idToken || !fbApps.core) throw httpError(401, 'Phone OTP verification is required.');
        let dec;
        try { dec = await fbApps.core.auth().verifyIdToken(idToken); }
        catch (e) { throw httpError(401, 'OTP verification failed. Please try again.'); }
        if (dec.phone_number !== '+91' + phone) throw httpError(401, 'Verified phone number does not match.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const h = sha256(token);
    const now = Date.now();
    const db = getDb('core');

    const devices = (await db.ref('users/' + phone + '/devices').once('value')).val() || {};
    const keys = Object.keys(devices).sort((x, y) => devices[x] - devices[y]);
    const evict = keys.slice(0, Math.max(0, keys.length - (MAX_DEVICES - 1)));

    const updates = {};
    evict.forEach(k => { updates['device_tokens/' + k] = null; updates['users/' + phone + '/devices/' + k] = null; tokenCache.delete(k); });
    updates['device_tokens/' + h] = { phone, createdAt: now };
    updates['users/' + phone + '/devices/' + h] = now;
    updates['users/' + phone + '/name'] = name;
    updates['users/' + phone + '/lastLogin'] = now;
    const loginGps = parseGps(b.gpsLocation);
    if (loginGps) updates['users/' + phone + '/lastGps'] = loginGps;
    await db.ref().update(updates);

    console.log(`🔐 [LOGIN] device bound for ${phone.slice(0, 2)}******${phone.slice(-2)}`);
    res.json({ status: 'success', deviceToken: token, phone });
}));

// ---- Logout ----
app.post('/api/logout', requireAuth, asyncHandler(async (req, res) => {
    await getDb('core').ref().update({
        ['device_tokens/' + req.tokenHash]: null,
        ['users/' + req.userPhone + '/devices/' + req.tokenHash]: null
    });
    tokenCache.delete(req.tokenHash);
    res.json({ status: 'success' });
}));

// ---- Activity log ----
app.post('/api/log', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = req.userPhone;
    if (!hit('log:' + phone, 40, 60 * 1000)) throw httpError(429, 'Too many requests.');
    await getDb('core').ref('gmds_records/' + phone).set({
        name: cleanText(b.name, 60), phone, service: cleanText(b.service, 120),
        location: mapsUrlOr(b.location, 'Waiting GPS'), address: cleanText(b.address, 300),
        timestamp: cleanText(b.timestamp, 60) || istNow(), updatedAt: Date.now()
    });
    res.json({ status: 'success', message: 'Data logged securely via Backend.' });
}));

// ---- QUOTE: সার্ভারের হিসাব করা চার্জ (রেঞ্জ + জোন + রিটার্ন চার্জসহ) ----
app.post('/api/quote', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    if (!hit('quote:' + req.userPhone, 40, 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a moment.');

    const kind = cleanText(b.type, 20);
    if (kind === 'FoodOrder') {
        const basket = await resolveFoodBasket(b.items);
        const q = await computeFoodFee(basket.hotels, parseGps(b.gpsLocation), cleanText(b.address, 300).toLowerCase());
        return res.json({
            status: 'success', subtotal: basket.subtotal,
            distanceKm: Number(q.distanceKm.toFixed(2)), zone: q.zone,
            baseFee: q.baseFee, returnCharge: q.returnCharge, deliveryFee: q.finalFee,
            total: basket.subtotal + q.finalFee
        });
    }
    if (kind === 'DeliveryRide') {
        const r = await buildDeliveryDetails(b.details, true);
        return res.json({
            status: 'success', minFare: r.minFare, returnCharge: r.returnCharge,
            distanceKmLowerBound: Number(r.distanceKm.toFixed(2))
        });
    }
    throw httpError(400, 'Unknown quote type.');
}));

// ---- Razorpay: create order ----
app.post('/api/payment/create', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const amount = toNum(b.amount);
    const phone = req.userPhone;
    const ref = cleanText(b.orderId, 30);
    if (!(amount >= 1 && amount <= 10000)) throw httpError(400, 'Invalid payment amount specified.');
    if (ref && !/^[A-Za-z0-9_-]+$/.test(ref)) throw httpError(400, 'Invalid order reference.');
    if (!hit('paycreate:' + phone, 10, 10 * 60 * 1000)) throw httpError(429, 'Too many payment attempts. Please wait a few minutes.');

    const amountPaise = Math.round(amount * 100);
    const rzpOrder = await razorpay.orders.create({
        amount: amountPaise, currency: 'INR', receipt: ('rcpt_' + (ref || Date.now())).slice(0, 40), payment_capture: 1
    });
    await getDb('core').ref('pay_orders/' + rzpOrder.id).set({ amountPaise, phone, receipt: rzpOrder.receipt, createdAt: Date.now() });
    console.log(`💳 [PAYMENT CREATE] ${rzpOrder.id} ₹${amount}`);
    res.json({ status: 'success', key: RZP_KEY_ID, order_id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency });
}));

// ---- Razorpay: verify ----
app.post('/api/payment/verify', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const paymentId = cleanText(b.razorpayPaymentId, 40);
    const rzpOrderId = cleanText(b.razorpayOrderId, 40);
    const signature = cleanText(b.razorpaySignature, 100);
    if (!PAYMENT_ID_RE.test(paymentId) || !RZP_ORDER_ID_RE.test(rzpOrderId) || !signature) {
        throw httpError(400, 'Missing or invalid payment reference.');
    }

    const expected = crypto.createHmac('sha256', RZP_KEY_SECRET).update(rzpOrderId + '|' + paymentId).digest('hex');
    if (!safeEqual(expected, signature)) {
        console.warn('⚠️ [SECURITY] Invalid payment signature for', rzpOrderId);
        throw httpError(400, 'Payment signature verification failed.');
    }

    const created = (await getDb('core').ref('pay_orders/' + rzpOrderId).once('value')).val();
    if (!created) throw httpError(400, 'Unknown payment order.');
    if (String(created.phone) !== req.userPhone) throw httpError(403, 'This payment belongs to a different account.');

    let pay = null;
    for (let i = 0; i < 4; i++) {
        pay = await razorpay.payments.fetch(paymentId);
        if (pay.status === 'captured') break;
        if (pay.status === 'authorized' || pay.status === 'created') await sleep(1200); else break;
    }
    if (!pay || pay.status !== 'captured') throw httpError(400, 'Payment not captured yet or transaction failed.');
    if (pay.order_id !== rzpOrderId) throw httpError(400, 'Payment does not match this order.');
    if (Number(pay.amount) !== Number(created.amountPaise)) throw httpError(400, 'Payment amount mismatch.');

    await getDb('core').ref('payments/' + paymentId).transaction(cur => (cur === null ? {
        razorpayOrderId: rzpOrderId, amountPaise: Number(created.amountPaise),
        phone: String(created.phone), verifiedAt: Date.now(), used: false
    } : undefined));

    console.log(`✅ [PAYMENT VERIFIED] ${paymentId}`);
    res.json({ status: 'success', message: 'Payment verified successfully!' });
}));

// ---- Place order (Food / House / Seba / Delivery) ----
async function placeFoodOrder(b, phone) {
    const orderId = cleanText(b.orderId, 20);
    if (!/^[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid order ID.');
    const name = cleanText(b.user || b.customer || b.name, 60) || 'Customer';
    const address = cleanText(b.address, 300);
    if (!address) throw httpError(400, 'Delivery address is required.');
    const payMode = b.payMode === 'ONLINE' ? 'ONLINE' : 'COD';
    const remote = b.remoteOrder === true;
    let receiverPhone = 'N/A';
    if (remote) {
        receiverPhone = String(b.receiverPhone || '').replace(/[^0-9]/g, '');
        if (receiverPhone.length < 10 || receiverPhone.length > 13) throw httpError(400, 'Invalid receiver phone number.');
    }

    const basket = await resolveFoodBasket(b.items);
    const { items, subtotal } = basket;

    // 🗺️ ব্লুপ্রিন্ট: ১১ কিমি রেঞ্জ + জোন জিওফেন্সিং + ৮.৫ কিমির পর ৫০% রিটার্ন চার্জ
    const quote = await computeFoodFee(basket.hotels, parseGps(b.gpsLocation), address.toLowerCase());

    const fee = Math.round(toNum(b.deliveryFee));
    if (!(fee >= 10 && fee <= 250)) throw httpError(400, 'Invalid delivery charge.');
    if (fee < quote.finalFee - 3) throw httpError(409, 'Delivery charge has changed. Please refresh your basket and try again.');

    const total = Math.round((subtotal + fee) * 100) / 100;
    const amountPaise = Math.round(total * 100);

    let paymentId = '';
    if (payMode === 'ONLINE') {
        paymentId = cleanText(b.razorpayPaymentId, 40);
        if (!PAYMENT_ID_RE.test(paymentId)) throw httpError(402, 'Online payment is not verified.');
        await claimPayment(paymentId, phone, amountPaise, orderId);
    }

    const status = payMode === 'ONLINE' ? 'Confirmed' : 'Pending';
    const record = {
        orderId: Number(orderId), user: name, phone, address,
        gpsLocation: mapsUrlOr(b.gpsLocation, 'Waiting Sync'),
        items, subtotal, deliveryFee: fee, grandTotal: total, payMode,
        calculatedDistance: Number(quote.distanceKm.toFixed(2)),
        returnChargeApplied: quote.returnCharge, serviceZone: quote.zone || null,
        razorpayPaymentId: paymentId, remoteOrder: remote, receiverPhone,
        time: istNow(), riderStatus: status, status, createdAt: Date.now(),
        serverVerifiedAt: new Date().toISOString(), source: 'server'
    };
    try { await createRecord('core', 'all_orders', orderId, record); }
    catch (e) { if (paymentId) await releasePayment(paymentId); throw e; }

    await writeTracking('core', orderId, record);
    backupOrder('food', record, total);
    console.log(`🛒 [FOOD ORDER] ${orderId} ₹${total} ${payMode} dist=${quote.distanceKm.toFixed(1)}km return=${quote.returnCharge}`);
    return { orderId: record.orderId };
}

async function placeHouseOrder(b, phone) {
    const orderId = cleanText(b.orderId, 30);
    if (!/^HS_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const service = cleanText(b.service, 80);
    if (!service) throw httpError(400, 'Service name is required.');
    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone, service,
        professional: cleanText(b.professional, 120) || 'GMDS Certified Expert',
        problem: cleanText(b.problem, 500) || 'N/A',
        appointmentTime: cleanText(b.appointmentTime, 60), location: mapsUrlOr(b.location, 'Not Found'),
        timestamp: istNow(), status: 'Confirmed', payMode: 'COD', createdAt: Date.now(), source: 'server'
    };
    await createRecord('house', 'house_bookings', orderId, record);
    backupOrder('house', record, 'N/A');
    console.log(`🔧 [HOUSE BOOKING] ${orderId}`);
    return { orderId };
}

async function placeSebaOrder(b, phone) {
    const orderId = cleanText(b.orderId, 30);
    if (!/^SEBA_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const service = cleanText(b.service, 120);
    if (!service) throw httpError(400, 'Service name is required.');
    const payMode = b.payMode === 'ONLINE' ? 'ONLINE' : 'COD';

    const expected = await sebaExpectedPrice(service);
    const priceStr = expected ? '₹' + expected : 'Variable';

    let paymentId = '';
    if (payMode === 'ONLINE') {
        if (!expected) throw httpError(400, 'Online payment is not available for this service.');
        paymentId = cleanText(b.razorpayPaymentId, 40);
        if (!PAYMENT_ID_RE.test(paymentId)) throw httpError(402, 'Online payment is not verified.');
        await claimPayment(paymentId, phone, Math.round(expected * 100), orderId);
    }
    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone, service,
        category: cleanText(b.category, 20), price: priceStr, payMode, razorpayPaymentId: paymentId,
        location: mapsUrlOr(b.location, 'Not Shared'), timestamp: istNow(),
        status: 'Confirmed', createdAt: Date.now(), source: 'server'
    };
    try { await createRecord('seba', 'seba_orders', orderId, record); }
    catch (e) { if (paymentId) await releasePayment(paymentId); throw e; }
    backupOrder('seba', record, priceStr);
    console.log(`💻 [SEBA ORDER] ${orderId}`);
    return { orderId };
}

async function placeDeliveryOrder(b, phone) {
    const orderId = cleanText(b.orderId, 30);
    if (!/^DEL_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const payMode = b.payMode === 'ONLINE' ? 'ONLINE' : 'COD';
    const { details, fare } = await buildDeliveryDetails(b.details, false);

    let paymentId = '';
    if (payMode === 'ONLINE') {
        paymentId = cleanText(b.razorpayPaymentId, 40);
        if (!PAYMENT_ID_RE.test(paymentId)) throw httpError(402, 'Online payment is not verified.');
        await claimPayment(paymentId, phone, fare * 100, orderId);
    }
    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone,
        price: fare, payMode, razorpayPaymentId: paymentId, details, timestamp: istNow(),
        riderStatus: 'Confirmed', status: 'Confirmed', createdAt: Date.now(),
        serverVerifiedAt: new Date().toISOString(), source: 'server'
    };
    try { await createRecord('medicine', 'delivery_orders', orderId, record); }
    catch (e) { if (paymentId) await releasePayment(paymentId); throw e; }

    await writeTracking('medicine', orderId, record);
    backupOrder('delivery', record, fare);
    console.log(`🛵 [DELIVERY] ${orderId} ₹${fare} ${payMode}`);
    return { orderId };
}

app.post('/api/place-order', requireAuth, orderLimiter, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = req.userPhone;
    if (!hit('order:' + phone, 5, 5 * 60 * 1000)) throw httpError(429, 'Security Lock: You are placing orders too fast. Please wait a few minutes.');

    let result;
    switch (cleanText(b.type, 20)) {
        case 'FoodOrder':    result = await placeFoodOrder(b, phone); break;
        case 'HouseService': result = await placeHouseOrder(b, phone); break;
        case 'DigitalSeba':  result = await placeSebaOrder(b, phone); break;
        case 'DeliveryRide': result = await placeDeliveryOrder(b, phone); break;
        default: throw httpError(400, 'Unknown order type.');
    }
    res.json({ status: 'success', message: 'Order verified and saved successfully.', orderId: result.orderId });
}));

// =========================================================================
// 10. ORDER HISTORY, CANCEL/REFUND, ACCOUNT DELETE
// =========================================================================
const CANCELLABLE = ['Pending', 'Confirmed'];
const TERMINAL = ['Delivered', 'Completed', 'Done', 'Cancelled', 'Cancelled & Refunded'];

const SERVICE_MAP = {
    food: {
        db: 'core', path: 'all_orders', idRe: /^[0-9]{10,16}$/, win: 300, statusKey: 'riderStatus', both: true,
        nameKey: 'user', wipe: ['address', 'gpsLocation', 'receiverPhone'], nullify: [],
        shape: (o, key) => ({
            type: 'food', serviceType: 'food', dbPath: 'all_orders',
            rawId: o.orderId || key, orderId: o.orderId || key, time: o.time || 'N/A', rawTimestamp: orderTs(o, key),
            items: Array.isArray(o.items) ? o.items : (o.items ? Object.values(o.items) : []),
            subtotal: o.subtotal || 0, deliveryFee: o.deliveryFee || 0, grandTotal: o.grandTotal || 0,
            payMode: o.payMode || 'COD', razorpayPaymentId: o.razorpayPaymentId || '',
            status: o.riderStatus || o.status || 'Pending'
        })
    },
    delivery: {
        db: 'medicine', path: 'delivery_orders', idRe: /^DEL_[0-9]{10,16}$/, win: 300, statusKey: 'riderStatus', both: true,
        nameKey: 'customer', wipe: ['details/pickup', 'details/drop', 'details/receiverPhone'],
        nullify: ['details/pickupLat', 'details/pickupLng', 'details/dropLat', 'details/dropLng'],
        shape: (o, key) => {
            const d = o.details || {};
            const isRide = d.type === 'Ride Booking';
            return {
                type: 'delivery', serviceType: 'delivery', dbPath: 'delivery_orders',
                rawId: o.orderId || key, rawTimestamp: orderTs(o, key), orderId: o.orderId || key,
                title: isRide ? `Ride Booking (${d.vehicle || 'Bike'})` : `Parcel Delivery (${d.itemName || 'Item'})`,
                pickup: d.pickup || 'N/A', drop: d.drop || 'N/A', distance: d.distance || 'N/A',
                time: o.timestamp || 'N/A', price: '₹' + (d.totalFare || 0),
                payMode: o.payMode || 'COD', razorpayPaymentId: o.razorpayPaymentId || '',
                status: o.riderStatus || o.status || 'Pending', details: d,
                icon: isRide ? 'fa-motorcycle' : 'fa-box-open', iconColor: 'text-blue-600', iconBg: 'bg-blue-50'
            };
        }
    },
    house: {
        db: 'house', path: 'house_bookings', idRe: /^HS_[0-9]{10,16}$/, win: 900, statusKey: 'status', both: false,
        nameKey: 'customer', wipe: ['location', 'problem'], nullify: [],
        shape: (o, key) => ({
            type: 'house', serviceType: 'house', dbPath: 'house_bookings',
            rawId: o.orderId || key, rawTimestamp: orderTs(o, key), orderId: o.orderId || key,
            title: o.service || 'House Help Service',
            details: o.problem && o.problem !== 'N/A' ? o.problem : '',
            professional: o.professional || 'GMDS Expert', time: o.appointmentTime || o.timestamp || 'N/A',
            price: 'Expert: ' + (o.professional || 'GMDS Expert'),
            payMode: o.payMode || 'COD', razorpayPaymentId: o.razorpayPaymentId || '',
            status: o.status || 'Confirmed',
            icon: 'fa-tools', iconColor: 'text-orange-600', iconBg: 'bg-orange-50'
        })
    },
    seba: {
        db: 'seba', path: 'seba_orders', idRe: /^SEBA_[0-9]{10,16}$/, win: 300, statusKey: 'status', both: false,
        nameKey: 'customer', wipe: ['location'], nullify: [],
        shape: (o, key) => ({
            type: 'seba', serviceType: 'seba', dbPath: 'seba_orders',
            rawId: o.orderId || key, rawTimestamp: orderTs(o, key), orderId: o.orderId || key,
            title: o.service || 'Digital Seba Portal', time: o.timestamp || 'N/A',
            price: 'Charge: ' + (o.price || 'Variable'),
            payMode: o.payMode || 'COD', razorpayPaymentId: o.razorpayPaymentId || '',
            status: o.status || 'Pending',
            icon: 'fa-laptop-code', iconColor: 'text-purple-600', iconBg: 'bg-purple-50'
        })
    }
};

// ---- My orders ----
app.post('/api/my-orders', requireAuth, asyncHandler(async (req, res) => {
    const phone = req.userPhone;
    if (!hit('orders:' + phone, 20, 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a moment.');

    const jobs = Object.entries(SERVICE_MAP).map(async ([kind, cfg]) => {
        const db = dbs[cfg.db];
        if (!db) return [];
        const snap = await db.ref(cfg.path).orderByChild('phone').equalTo(phone).limitToLast(50).once('value');
        const out = [];
        snap.forEach(child => {
            try { out.push(cfg.shape(child.val() || {}, child.key)); } catch (e) { console.error('Shape error', kind, e.message); }
        });
        return out;
    });
    const results = await Promise.all(jobs.map(p => p.catch(e => { console.error('History query failed:', e.message); return []; })));
    const orders = [].concat(...results).sort((a, b) => b.rawTimestamp - a.rawTimestamp);
    res.json({ status: 'success', orders });
}));

// ---- Cancel (+ অনলাইন পেমেন্টে স্বয়ংক্রিয় রিফান্ড) ----
app.post('/api/order/cancel', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const cfg = SERVICE_MAP[cleanText(b.serviceType, 10)];
    if (!cfg) throw httpError(400, 'Invalid service type.');
    const orderId = cleanText(b.orderId, 30);
    if (!cfg.idRe.test(orderId)) throw httpError(400, 'Invalid order ID.');
    const phone = req.userPhone;
    if (!hit('cancel:' + phone, 10, 10 * 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a few minutes.');

    const orderRef = getDb(cfg.db).ref(`${cfg.path}/${orderId}`);
    const snap = await orderRef.once('value');
    if (!snap.exists()) throw httpError(404, 'Order not found.');
    const order = snap.val();
    if (String(order.phone) !== phone) throw httpError(403, 'This order does not belong to your account.');

    const createdAt = orderTs(order, orderId);
    if (Date.now() - createdAt > (cfg.win + 10) * 1000) throw httpError(400, 'The cancellation time window for this order has closed.');

    let prevStatus = 'Confirmed';
    const tx = await orderRef.transaction(cur => {
        if (cur === null) return cur;
        if (String(cur.phone) !== phone) return;
        const eff = cur[cfg.statusKey] || cur.status || cur.riderStatus || 'Confirmed';
        if (!CANCELLABLE.includes(eff)) return;
        prevStatus = eff;
        cur[cfg.statusKey] = 'Cancelling';
        return cur;
    });
    if (!tx.committed || !tx.snapshot.exists()) throw httpError(409, 'This order can no longer be cancelled (it is already being processed).');

    const paymentId = order.razorpayPaymentId;
    const online = order.payMode === 'ONLINE' && paymentId;
    let refundId = null;
    try {
        if (online) {
            const r = await refundPaymentFully(paymentId, 'Customer cancelled order ' + orderId);
            refundId = r.refundId;
            try { await getDb('core').ref('payments/' + paymentId + '/refundState').set({ refundId, at: Date.now(), reason: 'customer_cancel' }); } catch (e) { /* non-critical */ }
        }
    } catch (e) {
        console.error('❌ Refund failed for', orderId, e.error ? JSON.stringify(e.error) : e.message);
        try { await orderRef.update({ [cfg.statusKey]: prevStatus }); } catch (e2) { console.error('❌ Could not restore status for', orderId); }
        throw httpError(502, 'The refund could not be processed right now. Your order is unchanged. Please try again or contact support.');
    }

    const finalStatus = online ? 'Cancelled & Refunded' : 'Cancelled';
    const upd = { status: finalStatus, cancelledAt: Date.now(), cancelReason: 'Customer cancelled', cancelledBy: 'customer' };
    if (cfg.both) upd.riderStatus = finalStatus;
    if (refundId) upd.refundId = refundId;
    try { await orderRef.update(upd); }
    catch (e) { await sleep(500); await orderRef.update(upd); }

    if (OrderBackup && mongoose.connection.readyState === 1) {
        OrderBackup.updateOne({ orderId: String(orderId) }, { riderStatus: finalStatus }).catch(() => {});
    }
    console.log(`🚫 [CANCELLED] ${orderId} -> ${finalStatus}`);
    res.json({ status: 'success', refunded: !!online, refundId, message: 'Order cancelled successfully.' });
}));

// ---- Delete account ----
app.post('/api/account/delete', requireAuth, asyncHandler(async (req, res) => {
    const phone = req.userPhone;
    if (!hit('delete:' + phone, 3, 24 * 3600 * 1000)) throw httpError(429, 'Too many requests. Please try again tomorrow.');

    let anonymised = 0, keptActive = 0;
    for (const cfg of Object.values(SERVICE_MAP)) {
        const db = dbs[cfg.db];
        if (!db) continue;
        const snap = await db.ref(cfg.path).orderByChild('phone').equalTo(phone).once('value');
        const updates = {};
        snap.forEach(child => {
            const o = child.val() || {};
            const eff = o.riderStatus || o.status || '';
            if (!TERMINAL.includes(eff)) { keptActive++; return; }
            const k = child.key;
            updates[k + '/' + cfg.nameKey] = 'Deleted User';
            updates[k + '/phone'] = 'DELETED';
            cfg.wipe.forEach(f => { updates[k + '/' + f] = 'DELETED'; });
            cfg.nullify.forEach(f => { updates[k + '/' + f] = null; });
            anonymised++;
        });
        if (Object.keys(updates).length) await db.ref(cfg.path).update(updates);
    }

    const core = getDb('core');
    const devices = (await core.ref('users/' + phone + '/devices').once('value')).val() || {};
    const rm = { ['users/' + phone]: null, ['gmds_records/' + phone]: null };
    Object.keys(devices).forEach(h => { rm['device_tokens/' + h] = null; tokenCache.delete(h); });
    rm['device_tokens/' + req.tokenHash] = null;
    await core.ref().update(rm);
    tokenCache.delete(req.tokenHash);

    if (dbs.seba) await dbs.seba.ref('fcm_tokens/' + phone).remove();
    if (OrderBackup && mongoose.connection.readyState === 1) {
        OrderBackup.updateMany({ phone }, { customerName: 'Deleted User', phone: 'DELETED' }).catch(() => {});
    }
    console.log(`🗑️ [ACCOUNT DELETE] anonymised=${anonymised} keptActive=${keptActive}`);
    res.json({ status: 'success', message: 'Your personal data has been deleted.', anonymisedOrders: anonymised, activeOrdersKept: keptActive });
}));

// =========================================================================
// 11. ADMIN PANEL + RIDER APP ROUTES (404 হ্যান্ডলারের আগে)
// =========================================================================
function loadOptionalRoutes(file) {
    try {
        require(file)(app, dbs);
        console.log(`✅ Routes loaded: ${file}`);
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(file.replace('./', ''))) {
            console.warn(`⚠️ ${file} not found - those routes are DISABLED.`);
        } else {
            console.error(`❌ Failed to load ${file}:`, e);
            process.exit(1);
        }
    }
}
loadOptionalRoutes('./admin-routes');
loadOptionalRoutes('./rider-routes');

// =========================================================================
// 12. ERROR HANDLING & START
// =========================================================================
app.use((req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ status: 'error', message: 'Invalid JSON.' });
    if (err && err.message === 'Not allowed by CORS') return res.status(403).json({ status: 'error', message: 'Origin not allowed.' });
    const status = (err && err.status >= 400 && err.status < 600) ? err.status : 500;
    if (status >= 500) console.error('❌', err);
    res.status(status).json({ status: 'error', message: (status < 500 || (err && err.expose)) ? err.message : 'Internal server error.' });
});

process.on('unhandledRejection', r => console.error('⚠️ Unhandled rejection:', r));
process.on('uncaughtException', e => { console.error('💥 Uncaught exception:', e); process.exit(1); });

mirrorTracking('core', 'all_orders');
mirrorTracking('medicine', 'delivery_orders');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log('=================================');
    console.log(`✅ GMDS Secure Backend v4.0.0 running on port ${PORT}`);
    console.log(`   Range ≤ ${MAX_RANGE_KM} km | Return charge > ${RETURN_THRESHOLD_KM} km (+${RETURN_CHARGE_RATE * 100}%)`);
    console.log('=================================');
});
