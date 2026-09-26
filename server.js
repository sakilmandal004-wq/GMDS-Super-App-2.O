'use strict';
/* =========================================================================
   GMDS SECURE BACKEND  v3.0.0
   - All secrets come from environment variables (nothing hardcoded)
   - Orders are validated and written to Firebase by THIS server (Admin SDK)
   - Payments are verified with signature + Razorpay API before an order is accepted
   - Cancel / refund / order history / account deletion are handled here
   - Customer live-tracking data is mirrored to a safe "order_tracking" node
   ========================================================================= */

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

// =========================================================================
// 1. ENVIRONMENT
// =========================================================================
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    console.error('❌ RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables are required.');
    process.exit(1);
}
const razorpay = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET });

// Optional: comma separated list of allowed website origins. Empty = allow all.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        if (!ALLOWED_ORIGINS.length || !origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '100kb' }));

// =========================================================================
// 2. FIREBASE ADMIN (4 projects)
// =========================================================================
const FB_DEFS = {
    core:     { env: 'FIREBASE_SA_CORE',     url: 'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app' },
    house:    { env: 'FIREBASE_SA_HOUSE',    url: 'https://gmds-house-half-default-rtdb.firebaseio.com' },
    medicine: { env: 'FIREBASE_SA_MEDICINE', url: 'https://gmds-medicine-default-rtdb.firebaseio.com' },
    seba:     { env: 'FIREBASE_SA_SEBA',     url: 'https://dital-cd21f-default-rtdb.firebaseio.com' }
};
const dbs = {};

function loadServiceAccount(raw) {
    const v = String(raw).trim();
    if (v.startsWith('{')) return JSON.parse(v);                              // pasted JSON
    if (v.startsWith('/')) return JSON.parse(fs.readFileSync(v, 'utf8'));     // Render Secret File path
    return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));             // base64 JSON
}

for (const [name, def] of Object.entries(FB_DEFS)) {
    const raw = process.env[def.env];
    if (!raw) { console.warn(`⚠️ ${def.env} is not set. Firebase "${name}" features are DISABLED.`); continue; }
    try {
        const fbApp = admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount(raw)), databaseURL: def.url }, name);
        dbs[name] = fbApp.database();
        console.log(`✅ Firebase connected: ${name}`);
    } catch (e) {
        console.error(`❌ Firebase init failed for "${name}":`, e.message);
    }
}
if (!dbs.core) { console.error('❌ Core Firebase (FIREBASE_SA_CORE) is required.'); process.exit(1); }

// =========================================================================
// 3. OPTIONAL MONGODB (audit backup only - never blocks an order)
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
} else {
    console.warn('⚠️ MONGO_URI not set - MongoDB backup disabled (orders still saved to Firebase).');
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

// Removes < > and control characters, collapses spaces, limits length (blocks stored XSS)
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

// Small in-memory limiter keyed by phone (works behind shared mobile IPs)
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
// 5. RATE LIMITERS (per IP)
// =========================================================================
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 400,
    message: { status: 'error', message: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true, legacyHeaders: false
});
const orderLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 15,
    message: { status: 'error', message: 'Security Lock: You are placing orders too fast. Please wait a few minutes.' },
    standardHeaders: true, legacyHeaders: false
});
app.use('/api/', globalLimiter);

// =========================================================================
// 6. PAYMENT HELPERS
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

// Marks a verified payment as used by exactly one order (atomic).
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
// 7. ORDER STORAGE HELPERS
// =========================================================================
async function createRecord(dbName, path, orderId, record) {
    const ref = getDb(dbName).ref(`${path}/${orderId}`);
    const clean = stripUndefined(record);
    const result = await ref.transaction(cur => (cur === null ? clean : undefined));
    if (!result.committed) throw httpError(409, 'This order ID already exists.');
}

// Only these fields are ever exposed to the customer's live tracking screen.
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

// Keeps order_tracking in sync when the rider / admin app updates all_orders or delivery_orders.
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
            db.ref('order_tracking/' + snap.key).set({ ...t, updatedAt: Date.now() })
                .catch(e => console.error('Tracking mirror write failed:', e.message));
        } catch (e) { console.error('Tracking mirror error:', e.message); }
    };
    query.on('child_added', handler, e => console.error('Tracking listener cancelled:', e.message));
    query.on('child_changed', handler, e => console.error('Tracking listener cancelled:', e.message));
    console.log(`👀 Tracking mirror active: ${dbName}/${path}`);
}

// Product list cache (short) so each order does not re-download the menu
let productCache = { at: 0, list: [] };
async function getProducts() {
    if (Date.now() - productCache.at < 15000) return productCache.list;
    const snap = await getDb('core').ref('products').once('value');
    const list = Object.values(snap.val() || {}).filter(Boolean);
    productCache = { at: Date.now(), list };
    return list;
}

// Digital Seba: title -> price id (same titles as the app's sebaServicesDB)
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

// Fare floors (copied from the app's fare rules). If you change fares in the app, change them here too.
function parcelBase(d) {
    if (d <= 1.5) return 13; if (d <= 2.5) return 16; if (d <= 3.5) return 19; if (d <= 4.7) return 23;
    if (d <= 5.7) return 27; if (d <= 6.5) return 30; if (d <= 7.5) return 33;
    return 33 + (d - 7.5) * 1.5;
}
function buildDeliveryDetails(d) {
    if (!d || typeof d !== 'object') throw httpError(400, 'Invalid booking details.');
    const type = d.type === 'Parcel Delivery' ? 'Parcel Delivery' : (d.type === 'Ride Booking' ? 'Ride Booking' : null);
    if (!type) throw httpError(400, 'Invalid booking type.');

    const pLat = toNum(d.pickupLat), pLng = toNum(d.pickupLng), dLat = toNum(d.dropLat), dLng = toNum(d.dropLng);
    const latOk = v => v >= 5 && v <= 38, lngOk = v => v >= 67 && v <= 98;
    if (!(latOk(pLat) && latOk(dLat) && lngOk(pLng) && lngOk(dLng))) throw httpError(400, 'Invalid pick-up or drop-off location.');

    const straightKm = haversineKm(pLat, pLng, dLat, dLng);
    if (straightKm > 18.3) throw httpError(400, 'This route is outside our 18 KM service range.');
    const dFloor = Math.max(1.0, straightKm - 0.3);

    const fare = Math.round(toNum(d.totalFare));
    if (!(fare > 0 && fare <= 1500)) throw httpError(400, 'Invalid fare amount.');

    const pickup = cleanText(d.pickup, 250), drop = cleanText(d.drop, 250);
    if (!pickup || !drop) throw httpError(400, 'Pick-up and drop-off addresses are required.');

    const out = {
        type, nightChargeApplied: d.nightChargeApplied === true, totalFare: fare,
        distance: cleanText(d.distance, 20), pickup, drop,
        pickupLat: pLat, pickupLng: pLng, dropLat: dLat, dropLng: dLng
    };
    let floor;
    if (type === 'Parcel Delivery') {
        const size = ['Small', 'Medium', 'Large'].includes(d.size) ? d.size : null;
        const itemName = cleanText(d.itemName, 80);
        const receiverPhone = String(d.receiverPhone || '').replace(/[^0-9]/g, '');
        if (!size || !itemName || receiverPhone.length < 10 || receiverPhone.length > 13) throw httpError(400, 'Invalid parcel details.');
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
    if (fare < Math.floor(floor) - 2) throw httpError(400, 'Fare mismatch. Please recalculate the fare and try again.');
    return { details: out, fare };
}

// =========================================================================
// 8. ROUTES
// =========================================================================

// ---- Health check ----
app.get('/', (req, res) => {
    res.json({ status: 'success', message: 'GMDS Secure Backend is Live & Running! 🚀', version: '3.0.0' });
});

// ---- Activity log (saved to Firebase gmds_records by the server) ----
app.post('/api/log', asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = cleanText(b.phone, 10);
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
    if (!hit('log:' + phone, 40, 60 * 1000)) throw httpError(429, 'Too many requests.');
    await getDb('core').ref('gmds_records/' + phone).set({
        name: cleanText(b.name, 60), phone, service: cleanText(b.service, 120),
        location: mapsUrlOr(b.location, 'Waiting GPS'), address: cleanText(b.address, 300),
        timestamp: cleanText(b.timestamp, 60) || istNow(), updatedAt: Date.now()
    });
    res.json({ status: 'success', message: 'Data logged securely via Backend.' });
}));

// ---- Razorpay: create order ----
app.post('/api/payment/create', asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const amount = toNum(b.amount);
    const phone = cleanText(b.phone, 10);
