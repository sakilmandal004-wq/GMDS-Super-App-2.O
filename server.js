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
        riderName: d.riderName || d.name || null, // রাইডারের নাম নিশ্চিত করার জন্য
        riderPhone: d.riderPhone || d.phone || null, // রাইডারের ফোন
        vehicle: d.vehicle || (d.details && d.details.vehicle) || null,
        estTime: d.estTime || null,
        riderLat: toNum(d.riderLat) || null,
        riderLng: toNum(d.riderLng) || null
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
    const ref = cleanText(b.orderId, 40);
    if (!(amount >= 1 && amount <= 10000)) throw httpError(400, 'Invalid payment amount specified.');
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
    if (ref && !/^[A-Za-z0-9_-]+$/.test(ref)) throw httpError(400, 'Invalid order reference.');
    if (!hit('paycreate:' + phone, 10, 10 * 60 * 1000)) throw httpError(429, 'Too many payment attempts. Please wait a few minutes.');

    const amountPaise = Math.round(amount * 100);
    const rzpOrder = await razorpay.orders.create({
        amount: amountPaise, currency: 'INR', receipt: 'rcpt_' + (ref || Date.now()), payment_capture: 1
    });
    await getDb('core').ref('pay_orders/' + rzpOrder.id).set({ amountPaise, phone, receipt: rzpOrder.receipt, createdAt: Date.now() });
    console.log(`💳 [PAYMENT CREATE] ${rzpOrder.id} ₹${amount}`);
    res.json({ status: 'success', key: RZP_KEY_ID, order_id: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency });
}));

// ---- Razorpay: verify (signature is mandatory) ----
app.post('/api/payment/verify', asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const paymentId = cleanText(b.razorpayPaymentId, 40);
    const rzpOrderId = cleanText(b.razorpayOrderId, 40);
    const signature = cleanText(b.razorpaySignature, 100);
    if (!PAYMENT_ID_RE.test(paymentId) || !RZP_ORDER_ID_RE.test(rzpOrderId) || !signature) {
        throw httpError(400, 'Missing or invalid payment reference.');
    }

    const expected = crypto.createHmac('sha256', RZP_KEY_SECRET).update(rzpOrderId + '|' + paymentId).digest('hex');
    const a = Buffer.from(expected, 'utf8'), s = Buffer.from(signature, 'utf8');
    if (a.length !== s.length || !crypto.timingSafeEqual(a, s)) {
        console.warn('⚠️ [SECURITY] Invalid payment signature for', rzpOrderId);
        throw httpError(400, 'Payment signature verification failed.');
    }

    const created = (await getDb('core').ref('pay_orders/' + rzpOrderId).once('value')).val();
    if (!created) throw httpError(400, 'Unknown payment order.');

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

    // Prices always come from the database, never from the app
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) throw httpError(400, 'Your basket is empty or invalid.');
    const wanted = new Map();
    for (const it of b.items) {
        const id = cleanText(it && it.id, 60);
        const qty = Math.floor(toNum(it && it.qty));
        if (!id || !(qty >= 1) || qty > 50) throw httpError(400, 'Invalid item in basket.');
        wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    const products = await getProducts();
    const items = [];
    let subtotal = 0;
    for (const [id, qty] of wanted) {
        const p = products.find(x => x && String(x.id) === id);
        if (!p) throw httpError(400, 'An item in your basket is no longer available. Please refresh the menu.');
        const price = toNum(p.price);
        if (!(price > 0)) throw httpError(400, 'An item in your basket has an invalid price.');
        const stock = parseInt(p.stock_count, 10) || 0;
        if (stock < qty) throw httpError(409, `${cleanText(p.name, 60) || 'An item'} is out of stock.`);
        subtotal += price * qty;
        items.push({ ...p, qty });
    }
    const fee = Math.round(toNum(b.deliveryFee));
    if (!(fee >= 10 && fee <= 100)) throw httpError(400, 'Invalid delivery charge.');
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
        razorpayPaymentId: paymentId, remoteOrder: remote, receiverPhone,
        time: istNow(), riderStatus: status, status, createdAt: Date.now(), source: 'server'
    };
    try { await createRecord('core', 'all_orders', orderId, record); }
    catch (e) { if (paymentId) await releasePayment(paymentId); throw e; }

    await writeTracking('core', orderId, record);
    backupOrder('food', record, total);
    console.log(`🛒 [FOOD ORDER] ${orderId} ₹${total} ${payMode}`);
    return { orderId: record.orderId };
}

async function placeHouseOrder(b, phone) {
    const orderId = cleanText(b.orderId, 30);
    if (!/^HS_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const service = cleanText(b.service, 80);
    if (!service) throw httpError(400, 'Service name is required.');
    const problem = cleanText(b.problem, 500) || 'N/A';
    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone, service,
        professional: cleanText(b.professional, 120) || 'GMDS Certified Expert', problem,
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
    const { details, fare } = buildDeliveryDetails(b.details);

    let paymentId = '';
    if (payMode === 'ONLINE') {
        paymentId = cleanText(b.razorpayPaymentId, 40);
        if (!PAYMENT_ID_RE.test(paymentId)) throw httpError(402, 'Online payment is not verified.');
        await claimPayment(paymentId, phone, fare * 100, orderId);
    }
    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone,
        price: fare, payMode, razorpayPaymentId: paymentId, details, timestamp: istNow(),
        riderStatus: 'Confirmed', status: 'Confirmed', createdAt: Date.now(), source: 'server'
    };
    try { await createRecord('medicine', 'delivery_orders', orderId, record); }
    catch (e) { if (paymentId) await releasePayment(paymentId); throw e; }

    await writeTracking('medicine', orderId, record);
    backupOrder('delivery', record, fare);
    console.log(`🛵 [DELIVERY] ${orderId} ₹${fare} ${payMode}`);
    return { orderId };
}

app.post('/api/place-order', orderLimiter, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = cleanText(b.phone, 10);
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
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
// 9. ORDER HISTORY, CANCEL/REFUND, ACCOUNT DELETE
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
app.post('/api/my-orders', asyncHandler(async (req, res) => {
    const phone = cleanText(bodyOf(req).phone, 10);
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
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

// ---- Cancel (+ automatic refund for online payments) ----
app.post('/api/order/cancel', asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const cfg = SERVICE_MAP[cleanText(b.serviceType, 10)];
    if (!cfg) throw httpError(400, 'Invalid service type.');
    const orderId = cleanText(b.orderId, 30);
    if (!cfg.idRe.test(orderId)) throw httpError(400, 'Invalid order ID.');
    const phone = cleanText(b.phone, 10);
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
    if (!hit('cancel:' + phone, 10, 10 * 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a few minutes.');

    const orderRef = getDb(cfg.db).ref(`${cfg.path}/${orderId}`);
    const snap = await orderRef.once('value');
    if (!snap.exists()) throw httpError(404, 'Order not found.');
    const order = snap.val();
    if (String(order.phone) !== phone) throw httpError(403, 'This order does not belong to your account.');

    const createdAt = orderTs(order, orderId);
    if (Date.now() - createdAt > (cfg.win + 10) * 1000) throw httpError(400, 'The cancellation time window for this order has closed.');

    // Atomically claim the cancellation (blocks a race with the rider accepting the order)
    let prevStatus = 'Confirmed';
    const tx = await orderRef.transaction(cur => {
        if (cur === null) return cur; // retried by Firebase with the real data
        if (String(cur.phone) !== phone) return; // abort
        const eff = cur[cfg.statusKey] || cur.status || cur.riderStatus || 'Confirmed';
        if (!CANCELLABLE.includes(eff)) return; // abort
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
    const upd = { status: finalStatus, cancelledAt: Date.now() };
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

// ---- Delete account: personal data is wiped; finished orders are anonymised (accounting records stay) ----
app.post('/api/account/delete', asyncHandler(async (req, res) => {
    const phone = cleanText(bodyOf(req).phone, 10);
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
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
    await getDb('core').ref('gmds_records/' + phone).remove();
    if (dbs.seba) await dbs.seba.ref('fcm_tokens/' + phone).remove();
    if (OrderBackup && mongoose.connection.readyState === 1) {
        OrderBackup.updateMany({ phone }, { customerName: 'Deleted User', phone: 'DELETED' }).catch(() => {});
    }
    console.log(`🗑️ [ACCOUNT DELETE] anonymised=${anonymised} keptActive=${keptActive}`);
    res.json({ status: 'success', message: 'Your personal data has been deleted.', anonymisedOrders: anonymised, activeOrdersKept: keptActive });
}));

// =========================================================================
// 10. ERROR HANDLING & START
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
process.on('uncaughtException', e => console.error('⚠️ Uncaught exception:', e));

mirrorTracking('core', 'all_orders');
mirrorTracking('medicine', 'delivery_orders');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log('=================================');
    console.log(`✅ GMDS Secure Backend v3.0.0 running on port ${PORT}`);
    console.log('=================================');
});
