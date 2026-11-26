'use strict';
/* =========================================================================
   GMDS SECURE BACKEND  v4.7.0  (COD ONLY)

   v4.8.0 এ নতুন: OFFER ADMIN API (/api/offer-admin/list | save-offer | save-combo | delete-combo)
   - অফার ও কম্বো প্যানেল আর সরাসরি Firebase-এ লেখে না; সব সেভ এই সার্ভারের মধ্য দিয়ে যায়
     (ADMIN_KEY লাগে, প্রতিটি মান যাচাই হয়, অডিট লগ offer_audit-এ জমে)
   - যাচাই: অফার দাম > 0 এবং আসল দামের কম, ধাপ ডুপ্লিকেট নয়, maxQty ১-৯৯, end > start;
     কম্বোর সব আইটেম একই হোটেলের, কম্বোর ভেতরে কম্বো নয়, কম্বোর MRP সার্ভার নিজে হিসাব করে

   v4.7.0 এ নতুন: OFFER + COMBO সিস্টেম
   - অফার প্রতিটি product-এর ভেতরে (products/<id>/offer):
       offer: { active, tiers:[{minCart, price}], maxQty, start, end, terms }
   - কম্বোও একটি product: is_combo:true, combo_items:[{id,qty}], mrp (কাটা দাম), price (কম্বোর দাম)
   - দাম বসায় সার্ভার নিজে (resolveFoodBasket-এ দুই পাসে):
       পাস ১: "সাধারণ মোট" = কম্বো ও আনলক-আইটেম বাদে বাকি খাবারের টাকা
       পাস ২: প্রতিটি লাইনের দাম = সবচেয়ে বেশি মেলা tier (minCart <= সাধারণ মোট), নইলে আসল দাম
   - অফারের start/end সার্ভারের ঘড়িতে যাচাই হয় (ফোনের ঘড়ি বদলে লাভ নেই)
   - maxQty সার্ভারেও চাপানো হয়
   - কম্বোর ভেতরের সব আইটেম একই হোটেলের, বিদ্যমান ও স্টকে আছে কি না যাচাই হয়
   - অর্ডারের প্রতিটি আইটেমে mrp, offerApplied (এবং কম্বোর বিবরণ) সেভ হয়; অর্ডারে savings সেভ হয়
   - /api/quote এখন savings-ও ফেরত দেয়

   v4.6.0 এ নতুন:
   - বাইক / টোটো / কুরিয়ারের পুরো ভাড়া এখন সার্ভারে হিসাব হয় (অ্যাপ শুধু সড়কপথের দূরত্ব roadKm পাঠায়,
     সার্ভার সেটা সরলরেখার সাথে মিলিয়ে সীমাবদ্ধ করে)। জোনের এক্সট্রা/প্রতি-কিমি চার্জ, রাত্রির চার্জ
     (সার্ভারের IST ঘড়ি) ও রিটার্ন চার্জ সব এখানে; /api/quote → fare ফেরত দেয়, অর্ডারে মিলতে হয়।

   v4.5.0 এ নতুন:
   - ZONE ADMIN API (/api/zone-admin/list | save | delete): জোন ম্যানেজার প্যানেল আর সরাসরি
     Firebase-এ লেখে না; সব সেভ এই সার্ভারের মধ্য দিয়ে যায়, ADMIN_KEY লাগে, এবং সার্ভার
     প্রতিটি মান যাচাই করে (স্ল্যাব, চার্জ, সার্ভিস, A→B নিয়ম, পলিগন, ওভারল্যাপ) —
     ভুল বা অস্বাভাবিক মান সেভই হয় না। প্রতিটি বদলের অডিট লগ (zone_audit)।
   - ব্যর্থ কী-চেষ্টা সীমা (প্রতি IP ১৫ মিনিটে ১০ বার), constant-time কী মেলানো।
   - হোটেল জোনের বাইরে হলে আলাদা, স্পষ্ট বার্তা।

   v4.4.0 এ নতুন:
   A) ZONE-ভিত্তিক নিয়ন্ত্রণ (জোন ম্যানেজার প্যানেল থেকে, gmds_zones/<id>):
        - খাবারের নিজস্ব স্ল্যাব টেবিল (slabs), ৭.৫ কিমির পর প্রতি কিমি রেট (per_km),
          এক্সট্রা চার্জ (extra_fee, মাইনাসও চলে)
        - সার্ভিস চালু/বন্ধ (services: food, bike, toto, parcel, house, seba)
        - খাবারের দিকনির্দেশিত নিয়ম A→B (food_rules + food_to)
        - বাইক / টোটো / কুরিয়ারের এক্সট্রা ও প্রতি-কিমি চার্জ (vehicle_fees)
        - কোনো ফিল্ড না থাকলে আগের আচরণই চলে (পুরোনো জোন ভাঙে না)
   B) নিরাপত্তা শক্ত করা:
        - SERVICE_MAP / SEBA map-এ prototype key ("constructor", "__proto__") দিয়ে আক্রমণ বন্ধ
        - ডিভাইস টোকেনের মেয়াদ (TOKEN_MAX_DAYS, ডিফল্ট ১৮০ দিন)
        - ডেলিভারি চার্জ দুদিক থেকেই যাচাই (কম বা অস্বাভাবিক বেশি দুটোই আটকায়)
        - অতিরিক্ত নিরাপত্তা হেডার, সার্ভার টাইমআউট, দৈনিক অর্ডার সীমা
        - zone-check-এ রেট লিমিট, হোটেলের জোন মেনুতে (zoneId)
        - নিচে "SECURITY NOTES" দেখুন

   Render Environment Variables:
     FIREBASE_SA_CORE / _HOUSE / _RIDER / _SEBA      (Service Account)
     ADMIN_KEY, RIDER_SECRET                         (admin-routes / rider-routes)
     ALLOWED_ORIGINS                                 (কমা দিয়ে)
     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (মেনুর ব্যাকআপ কপি; ঐচ্ছিক)
     MONGO_URI                                       (ঐচ্ছিক ব্যাকআপ)
     REQUIRE_FIREBASE_OTP=true                       (প্রোডাকশনে অবশ্যই চালু করুন)
     MAX_RANGE_KM (ডিফল্ট 11), RETURN_THRESHOLD_KM (ডিফল্ট 8.5),
     RETURN_CHARGE_RATE (ডিফল্ট 0.5), FEE_TOLERANCE (ডিফল্ট 1),
     TOKEN_MAX_DAYS (ডিফল্ট 180)                     (ঐচ্ছিক)

   Firebase Rules-এ আবশ্যক index:
     core:  "all_orders": { ".indexOn": ["phone"] }
     rider: "delivery_orders": { ".indexOn": ["phone"] }
     house: "house_bookings": { ".indexOn": ["phone"] }
     seba:  "seba_orders": { ".indexOn": ["phone"] }

   SECURITY NOTES (সার্ভারের বাইরে যা করতে হবে):
     1) REQUIRE_FIREBASE_OTP=true না থাকলে যে কেউ যেকোনো ফোন নম্বরে লগইন করে
        সেই নম্বরের অর্ডার/তথ্য দেখতে পারে। এটাই সবচেয়ে বড় ফাঁক।
     2) Firebase Rules-এ gmds_zones, products, hotel_status, all_orders ইত্যাদির
        লেখা শুধু অ্যাডমিনের জন্য বন্ধ করুন; ক্লায়েন্ট থেকে সরাসরি লেখা চললে
        সার্ভারের সব নিয়ম এড়িয়ে চার্জ বদলানো যায় (অফারের দামও)।
     3) ALLOWED_ORIGINS সেট করুন।
   ========================================================================= */

try { require('dotenv').config(); } catch (e) { /* dotenv ঐচ্ছিক */ }

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');
const { Redis } = require('@upstash/redis');

const app = express();
app.set('trust proxy', 1); // required on Render
app.disable('x-powered-by');

const VERSION = '4.8.0';
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// =========================================================================
// 1. ENVIRONMENT & CONSTANTS
// =========================================================================
function clampTol(v, d) { const n = Number(v); return (v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 && n <= 10) ? n : d; }
const REQUIRE_OTP = process.env.REQUIRE_FIREBASE_OTP === 'true';
const MAX_DEVICES = 5;
const TOKEN_MAX_AGE_MS = (Number(process.env.TOKEN_MAX_DAYS) || 180) * 24 * 3600 * 1000;

const MAX_RANGE_KM = Number(process.env.MAX_RANGE_KM) || 11.0;
const RETURN_THRESHOLD_KM = Number(process.env.RETURN_THRESHOLD_KM) || 8.5;
const RETURN_CHARGE_RATE = Number(process.env.RETURN_CHARGE_RATE) || 0.5;
const FEE_TOLERANCE = clampTol(process.env.FEE_TOLERANCE, 1);
const ROAD_FACTOR = 1.64;        // অ্যাপের calculateDistance এর সাথে হুবহু এক (খাবারের জন্য)
const RANGE_TOLERANCE_KM = 0.15;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ALLOWED_ORIGINS.length) console.warn('⚠️ ALLOWED_ORIGINS is empty - any website origin is allowed. Set it in production.');
if (!REQUIRE_OTP) console.warn('⚠️ REQUIRE_FIREBASE_OTP is not "true" - anyone can log in with any phone number. Enable OTP in production.');

// ---- Upstash Redis (মেনুর ব্যাকআপ কপি) ----
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
    console.log('✅ Upstash Redis configured (menu backup)');
} else {
    console.warn('⚠️ UPSTASH_REDIS_REST_URL / TOKEN not set - Redis backup disabled.');
}

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
        orderAmount: String, paymentMode: String,
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
            riderStatus: record.riderStatus || record.status || '',
            snapshot: record
        }).save().catch(e => console.error('Mongo backup failed:', e.message));
    } catch (e) { console.error('Mongo backup failed:', e.message); }
}

// =========================================================================
// 4. HELPERS
// =========================================================================
const PHONE_RE = /^[0-9]{10}$/;

function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function bodyOf(req) { return (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {}; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function stripUndefined(o) { return JSON.parse(JSON.stringify(o)); }
function istNow() { return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function cleanText(v, max) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return '';                       // অবজেক্ট/অ্যারে কখনো টেক্সট নয়
    return String(v).replace(/[<>\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function toNum(v) {
    if (v === '' || v === null || v === undefined || typeof v === 'object' || typeof v === 'boolean') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}
function clampNum(v, lo, hi, d) {
    const n = toNum(v);
    return (Number.isFinite(n) && n >= lo && n <= hi) ? n : d;
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
    if (typeof s !== 'string') return null;
    const m = /[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s.slice(0, 400));
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return (lat >= 5 && lat <= 38 && lng >= 67 && lng <= 98) ? { lat, lng } : null;
}

// In-memory limiter keyed by phone / key
const hitStore = new Map();
function hit(key, max, windowMs) {
    const now = Date.now();
    if (hitStore.size > 200000) hitStore.clear();               // মেমরি ফুলে ওঠা আটকানো
    const arr = (hitStore.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hitStore.set(key, arr); return false; }
    arr.push(now); hitStore.set(key, arr);
    return true;
}
function hitCount(key, windowMs) {                             // গণনা না বাড়িয়ে শুধু দেখা
    const now = Date.now();
    return (hitStore.get(key) || []).filter(t => now - t < windowMs).length;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hitStore) {
        const f = arr.filter(t => now - t < 24 * 3600 * 1000);
        if (f.length) hitStore.set(k, f); else hitStore.delete(k);
    }
}, 10 * 60 * 1000).unref();

// =========================================================================
// 5. MIDDLEWARE
// =========================================================================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    next();
});

app.use(cors({
    origin: (origin, cb) => {
        if (!ALLOWED_ORIGINS.length || !origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }
}));

app.use(express.json({ limit: '100kb', strict: true }));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 400,
    skip: (req) => req.originalUrl.startsWith('/api/admin/') || req.originalUrl.startsWith('/api/rider/') || req.originalUrl.startsWith('/api/order/track') || req.originalUrl.startsWith('/api/menu'),
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

const trackLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 300,
    message: { status: 'error', message: 'Too many tracking requests. Please wait.' },
    standardHeaders: true, legacyHeaders: false
});
app.use('/api/order/track', trackLimiter);

// মেনু পোলিংয়ের জন্য আলাদা, উদার সীমা (প্রতি IP: ৫ মিনিটে ৬০০)
const menuLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, max: 600,
    message: { status: 'error', message: 'Too many menu requests. Please wait.' },
    standardHeaders: true, legacyHeaders: false
});
app.use('/api/menu', menuLimiter);

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
        // টোকেনের মেয়াদ শেষ হলে মুছে দিয়ে আবার লগইন করানো
        if (Number(v.createdAt) > 0 && Date.now() - Number(v.createdAt) > TOKEN_MAX_AGE_MS) {
            tokenCache.delete(h);
            getDb('core').ref().update({
                ['device_tokens/' + h]: null,
                ['users/' + phone + '/devices/' + h]: null
            }).catch(() => {});
            throw expired();
        }
        if (tokenCache.size > 5000) tokenCache.clear();
        tokenCache.set(h, { phone, exp: Date.now() + 5 * 60 * 1000 });
    }
    req.userPhone = phone;
    req.tokenHash = h;
    next();
});

// =========================================================================
// 7. ORDER STORAGE & TRACKING HELPERS
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
// 7A. ZONE STORE (জোন পলিগন + চার্জ + সার্ভিস + রুট নিয়ম; লিসেনার, তাই বদলালে সঙ্গে সঙ্গে প্রযোজ্য)
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

// খাবারের স্ল্যাব: ১.৫ কিমি পর্যন্ত ₹১০ (ফিক্সড), তারপর এই ৬টি ধাপ, ৭.৫ কিমির পর প্রতি কিমি রেট
const SLAB_LIMITS = [2.5, 3.5, 4.7, 5.7, 6.5, 7.5];
const DEFAULT_SLABS = [12, 15, 17, 20, 23, 25];
const DEFAULT_PER_KM = 1.30;
const ZONE_DEFAULTS = { slabs: DEFAULT_SLABS, perKm: DEFAULT_PER_KM, extraFee: 0 };
const SERVICE_KEYS = ['food', 'bike', 'toto', 'parcel', 'house', 'seba'];
const VEHICLE_KEYS = ['bike', 'toto', 'parcel'];

// স্ল্যাব: ঠিক ৬টি সংখ্যা, আগের ধাপের চেয়ে কম নয়, ৫০০-এর বেশি নয়; নইলে পুরো স্ল্যাব ডিফল্ট
function parseSlabs(raw, name) {
    if (!raw || typeof raw !== 'object') return DEFAULT_SLABS.slice();
    const arr = (Array.isArray(raw) ? raw : Object.values(raw)).map(Number);
    let ok = arr.length === 6 && arr.every(Number.isFinite);
    for (let i = 0; ok && i < 6; i++) {
        const prev = i === 0 ? 10 : arr[i - 1];
        if (arr[i] < prev || arr[i] > 500) ok = false;
    }
    if (!ok) { console.warn(`⚠️ Zone "${name}": invalid slabs - using defaults.`); return DEFAULT_SLABS.slice(); }
    return arr;
}

// অ্যাডমিন প্যানেলের gmds_zones/<id>: { zone_name, polygon:[{lat,lng}], active, extra_fee, slabs, per_km,
//   services, food_rules, food_to, vehicle_fees }
function parseZones(val) {
    const list = [];
    Object.entries(val || {}).forEach(([id, z]) => {
        if (!z || typeof z !== 'object' || z.active === false || !z.polygon) return;
        const raw = Array.isArray(z.polygon) ? z.polygon : Object.values(z.polygon);
        const poly = raw
            .map(p => Array.isArray(p)
                ? { lat: Number(p[0]), lng: Number(p[1]) }
                : { lat: Number(p && p.lat), lng: Number(p && p.lng) })
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (poly.length < 3) return;

        const name = cleanText(z.zone_name, 60) || 'Zone';
        const sv = (z.services && typeof z.services === 'object') ? z.services : {};
        const services = {};
        SERVICE_KEYS.forEach(k => { services[k] = sv[k] !== false; });          // ফিল্ড না থাকলে চালু

        const vf = (z.vehicle_fees && typeof z.vehicle_fees === 'object') ? z.vehicle_fees : {};
        const vehicle = {};
        VEHICLE_KEYS.forEach(k => {
            const v = (vf[k] && typeof vf[k] === 'object') ? vf[k] : {};
            vehicle[k] = { extra: clampNum(v.extra, -50, 200, 0), perKm: clampNum(v.per_km, -5, 20, 0) };
        });

        const ft = (z.food_to && typeof z.food_to === 'object') ? z.food_to : {};
        list.push({
            id: String(id), name, poly, services, vehicle,
            slabs: parseSlabs(z.slabs, name),
            perKm: clampNum(z.per_km, 0.1, 50, DEFAULT_PER_KM),
            extraFee: clampNum(z.extra_fee, -50, 200, 0),
            foodRules: z.food_rules === true,
            foodTo: new Set(Object.keys(ft).filter(k => ft[k] === true))
        });
    });
    return list;
}

const zoneStore = { list: [], ready: false };
function startZoneListener() {
    getDb('core').ref('gmds_zones').on('value', snap => {
        zoneStore.list = parseZones(snap.val());
        zoneStore.ready = true;
        // হোটেলের zoneId নতুন করে হিসাব করে মেনুর ভার্সন বাড়ানো
        if (menuStore.gotH) menuStore.hotels = mapHotels(menuStore.rawHotels);
        bumpMenuVersion();
    }, err => console.error('gmds_zones listener:', err.message));
}

async function getZones() {
    if (zoneStore.ready) return zoneStore.list;
    const snap = await getDb('core').ref('gmds_zones').once('value');   // লিসেনার তৈরির আগের ফলব্যাক
    return parseZones(snap.val());
}

// 🛡️ কঠোর জোন চেক: লোকেশন পলিগনের ভেতরে না থাকলে ব্লক। কোনো বাফার নেই।
// অ্যাডমিন প্যানেলে কোনো সক্রিয় জোন না থাকলে সবকিছুই ব্লক (fail-closed)।
// ফলাফল: { ok, zone (নাম), info (জোনের পুরো তথ্য) }
async function checkZone(lat, lng) {
    const zones = await getZones();
    if (!zones.length) {
        console.error('❌ No active zones. Blocking (fail-closed).');
        return { ok: false, zone: null, info: null };
    }
    for (const z of zones) {
        if (pointInPolygon(lat, lng, z.poly)) return { ok: true, zone: z.name, info: z };
    }
    console.warn(`ZONE REJECTED: lat=${lat} lng=${lng} is outside all service zone polygons.`);
    return { ok: false, zone: null, info: null };
}

const ZONE_MSG = 'দুঃখিত! আপনার লোকেশনটি আমাদের সার্ভিস জোন বা ম্যাপ পলিগণের বাইরে। জোনের বাইরে থেকে অর্ডার বা রাইড বুক করা সম্পূর্ণ নিষিদ্ধ। (Outside service zone polygon)';
const RANGE_MSG = `দুঃখিত! এই লোকেশনটি আমাদের সর্বোচ্চ ${MAX_RANGE_KM} কিমি ডেলিভারি রেঞ্জের বাইরে। (Out of ${MAX_RANGE_KM} km delivery range.)`;
const HOTEL_ZONE_MSG = 'দুঃখিত! ঝুড়ির একটি হোটেল আমাদের সার্ভিস জোনের বাইরে, তাই এর খাবার ডেলিভারি করা যাচ্ছে না। (Restaurant outside service zone)';
const SERVICE_MSG = 'দুঃখিত! এই এলাকায় এই সার্ভিসটি এখনো চালু নেই। (Service not available in this zone)';
const ROUTE_MSG = 'দুঃখিত! এই হোটেল থেকে আপনার এলাকায় খাবার ডেলিভারি করা হয় না। (Delivery route not allowed)';

async function requireZone(gps) {
    if (!gps) throw httpError(400, 'অবৈধ জিপিএস লোকেশন। Please enable GPS and try again.');
    const z = await checkZone(Number(gps.lat), Number(gps.lng));
    if (!z.ok) throw httpError(409, ZONE_MSG);
    return z;
}
// জোনে সার্ভিস বন্ধ থাকলে ব্লক
function requireService(info, key) {
    if (!info || !info.services || info.services[key] === false) throw httpError(409, SERVICE_MSG);
}
// খাবারের A→B নিয়ম: হোটেলের জোন থেকে কাস্টমারের জোনে যাওয়া অনুমোদিত কি না
function requireFoodRoute(hotelInfo, customerInfo) {
    if (hotelInfo.id === customerInfo.id) return;      // নিজের জোনে সবসময় যাবে
    if (!hotelInfo.foodRules) return;                  // নিয়ম সেট না থাকলে সব জোনে
    if (!hotelInfo.foodTo.has(customerInfo.id)) throw httpError(409, ROUTE_MSG);
}

// =========================================================================
// 7B. LIVE MENU STORE (Firebase লিসেনার → RAM, প্রতি বদলে ভার্সন বাড়ে)
// =========================================================================
const MENU_REDIS_KEY = 'gmds_menu_v3';
const menuStore = { products: [], hotels: {}, rawHotels: {}, version: 0, gotP: false, gotH: false };
let menuBumpTimer = null;
let menuReadyResolve;
const menuReady = new Promise(r => { menuReadyResolve = r; });

function zoneIdAt(lat, lng) {
    const la = Number(lat), ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    for (const z of zoneStore.list) if (pointInPolygon(la, ln, z.poly)) return z.id;
    return null;
}

function mapHotels(raw) {
    const hotels = Object.create(null);
    Object.keys(raw || {}).forEach(k => {
        const h = raw[k];
        if (h === 'CLOSED') { hotels[k] = 'CLOSED'; return; }
        if (h && typeof h === 'object') {
            hotels[k] = {
                lat: h.lat, lng: h.lng,
                openTime: h.openTime || null, closeTime: h.closeTime || null,
                status: h.status || null,
                zoneId: zoneIdAt(h.lat, h.lng)
            };
        }
    });
    return hotels;
}

function bumpMenuVersion() {
    clearTimeout(menuBumpTimer);
    menuBumpTimer = setTimeout(() => {          // একসাথে অনেক বদল হলে একবারই ভার্সন বাড়ে
        menuStore.version = Date.now();
        if (redis && menuStore.gotP && menuStore.gotH) {   // রিস্টার্টের জন্য ব্যাকআপ কপি
            redis.set(MENU_REDIS_KEY, JSON.stringify({ products: menuStore.products, hotels: menuStore.hotels }), { ex: 86400 })
                .catch(e => console.error('Redis save error:', e.message));
        }
    }, 300);
}

function startMenuListeners() {
    const core = getDb('core');
    core.ref('products').on('value', snap => {
        menuStore.products = Object.values(snap.val() || {}).filter(Boolean);
        menuStore.gotP = true;
        if (menuStore.gotH) menuReadyResolve();
        bumpMenuVersion();
    }, err => console.error('products listener:', err.message));
    core.ref('hotel_status').on('value', snap => {
        menuStore.rawHotels = snap.val() || {};
        menuStore.hotels = mapHotels(menuStore.rawHotels);
        menuStore.gotH = true;
        if (menuStore.gotP) menuReadyResolve();
        bumpMenuVersion();
    }, err => console.error('hotel_status listener:', err.message));
}

async function buildMenuPayload() {
    const [pSnap, hSnap] = await Promise.all([
        getDb('core').ref('products').once('value'),
        getDb('core').ref('hotel_status').once('value')
    ]);
    return {
        products: Object.values(pSnap.val() || {}).filter(Boolean),
        hotels: mapHotels(hSnap.val())
    };
}

async function getMenuData() {
    if (menuStore.gotP && menuStore.gotH) return { products: menuStore.products, hotels: menuStore.hotels };
    await Promise.race([menuReady, sleep(6000)]);   // সার্ভার সবে চালু হলে লিসেনারের জন্য একটু অপেক্ষা
    if (menuStore.gotP && menuStore.gotH) return { products: menuStore.products, hotels: menuStore.hotels };
    if (redis) {                                     // ফলব্যাক ১: Redis ব্যাকআপ
        try {
            const c = await redis.get(MENU_REDIS_KEY);
            const d = c && (typeof c === 'string' ? JSON.parse(c) : c);
            if (d && Array.isArray(d.products) && d.products.length) return d;
        } catch (e) { console.error('Redis fetch error:', e.message); }
    }
    return buildMenuPayload();                       // ফলব্যাক ২: সরাসরি Firebase
}

async function getProducts() { return (await getMenuData()).products; }

async function invalidateMenuCache() {              // admin-routes.js এটা ডাকতে পারে
    bumpMenuVersion();
}
app.locals.invalidateMenuCache = invalidateMenuCache;

// =========================================================================
// 7C. FARE ENGINE: রেঞ্জ + জোন + জোনভিত্তিক চার্জ + রিটার্ন চার্জ
// =========================================================================
// রিটার্ন চার্জ: দূরত্ব > ৮.৫ কিমি হলে (জোনের এক্সট্রাসহ) মোট ভাড়ার ওপর ৫০% যোগ
function withReturnCharge(baseFee, distanceKm) {
    const returnCharge = distanceKm > RETURN_THRESHOLD_KM ? Math.round(baseFee * RETURN_CHARGE_RATE) : 0;
    return { baseFee, returnCharge, finalFee: baseFee + returnCharge };
}

// ---- খাবারের ডেলিভারি চার্জ: জোনের স্ল্যাব টেবিল (ফিক্সড বেসিক ১.৫ কিমি = ₹১০) ----
function slabFee(d, zc) {
    const z = zc || ZONE_DEFAULTS;
    if (d <= 1.5) return 10;
    for (let i = 0; i < SLAB_LIMITS.length; i++) {
        if (d <= SLAB_LIMITS[i]) return z.slabs[i];
    }
    return z.slabs[5] + (d - 7.5) * z.perKm;
}
function baseDeliveryFee(hotelNodes, gps, addrLower, zc) {
    const pts = hotelNodes.filter(n => n && n.lat && n.lng);
    let base = 10;
    if (gps && pts.length) {
        const maxD = Math.max(...pts.map(n => haversineKm(gps.lat, gps.lng, Number(n.lat), Number(n.lng)) * ROAD_FACTOR));
        base = slabFee(maxD, zc);
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
    // জোনের এক্সট্রা চার্জ সবসময় শেষে যোগ হয় (এলাকার নামের ন্যূনতম চার্জের পরেও)
    return Math.max(5, Math.round(Math.max(base, zone) + multi + (zc ? zc.extraFee : 0)));
}

// খাবারের অর্ডারের পূর্ণ হিসাব: রেঞ্জ + জোন (কাস্টমার ও প্রতিটি হোটেল ভেতরে) + সার্ভিস + A→B রুট + রিটার্ন চার্জ
async function computeFoodFee(hotelNodes, gps, addrLower) {
    if (!gps) throw httpError(400, 'অবৈধ জিপিএস লোকেশন। Please enable GPS and try again.');
    const pts = hotelNodes.filter(n => n && n.lat && n.lng);
    if (!pts.length) throw httpError(400, 'Restaurant location is not available. Please try again later.');
    if (pts.length !== hotelNodes.length) throw httpError(400, 'A restaurant in your basket has no location set. Please contact support.');

    const distanceKm = Math.max(...pts.map(n => haversineKm(gps.lat, gps.lng, Number(n.lat), Number(n.lng)) * ROAD_FACTOR));
    if (distanceKm > MAX_RANGE_KM + RANGE_TOLERANCE_KM) {
        console.warn(`RANGE REJECT lat=${gps.lat} lng=${gps.lng} dist=${distanceKm.toFixed(2)}km`);
        throw httpError(409, RANGE_MSG);
    }

    const cz = await requireZone(gps);                                  // কাস্টমার ভেতরে
    requireService(cz.info, 'food');                                    // কাস্টমারের জোনে খাবার চালু
    const hotelZoneIds = [];
    for (const n of pts) {                                              // প্রতিটি হোটেল ভেতরে
        let hz;
        try { hz = await requireZone({ lat: Number(n.lat), lng: Number(n.lng) }); }
        catch (e) { if (e && e.status === 409) throw httpError(409, HOTEL_ZONE_MSG); throw e; }
        requireService(hz.info, 'food');                                // হোটেলের জোনেও খাবার চালু
        requireFoodRoute(hz.info, cz.info);                             // A→B নিয়ম
        hotelZoneIds.push(hz.info.id);
    }

    const base = baseDeliveryFee(hotelNodes, gps, addrLower, cz.info);  // কাস্টমার জোনের স্ল্যাব + এক্সট্রা
    return {
        distanceKm, zone: cz.zone, customerZoneId: cz.info.id, hotelZoneIds,
        extraFee: cz.info.extraFee, ...withReturnCharge(base, distanceKm)
    };
}

// =========================================================================
// 7D. OFFER ENGINE (server) — অ্যাপের offer ইঞ্জিনের সাথে হুবহু এক নিয়ম
//   offer: { active, tiers:[{minCart, price}], maxQty, start, end, terms }
//   - দাম বসে "সাধারণ মোট"-এর ওপর (কম্বো ও আনলক-আইটেম বাদে বাকি খাবার)
//   - ডেলিভারি চার্জ হিসাবে ধরা হয় না
//   - শর্ত না মিললে আইটেম আসল দামেই বিক্রি হয় (কোনো এরর নয়)
// =========================================================================
function toArrS(x) { return Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []); }

function parseOfferS(p) {
    const o = p && p.offer;
    if (!o || typeof o !== 'object' || o.active !== true) return null;
    const now = Date.now();                                   // সার্ভারের ঘড়ি, কাস্টমারের ফোনের নয়
    const st = toNum(o.start), en = toNum(o.end);
    if (st > 0 && now < st) return null;
    if (en > 0 && now > en) return null;
    const base = toNum(p.price);
    if (!(base > 0)) return null;
    const tiers = toArrS(o.tiers)
        .map(t => ({ minCart: Math.max(0, toNum(t && t.minCart) || 0), price: toNum(t && t.price) }))
        .filter(t => Number.isFinite(t.price) && t.price > 0 && t.price < base)
        .sort((a, b) => a.minCart - b.minCart);
    if (!tiers.length) return null;
    const mq = Math.floor(toNum(o.maxQty));
    return { tiers, maxQty: mq >= 1 ? mq : 99 };
}

// যে আইটেমের কোনো tier-এ minCart > 0 সেটা "আনলক" আইটেম (সাধারণ মোটে গোনা হয় না)
function isUnlockS(p) { const o = parseOfferS(p); return !!(o && o.tiers.some(t => t.minCart > 0)); }

// ঝুড়ির সাধারণ মোট অনুযায়ী প্রোডাক্টের দাম
function priceAtS(p, regularTotal) {
    const o = parseOfferS(p);
    let best = toNum(p.price);
    if (o) o.tiers.forEach(t => { if (regularTotal >= t.minCart && t.price < best) best = t.price; });
    return best;
}

// কম্বো: প্রতিটি উপাদান বিদ্যমান, একই হোটেলের এবং স্টকে থাকতে হবে
function checkComboS(p, qty, products) {
    const parts = toArrS(p.combo_items);
    if (!parts.length || parts.length > 12) throw httpError(400, 'This combo is not set up correctly.');
    for (const ci of parts) {
        const comp = products.find(x => x && String(x.id) === String(ci && ci.id));
        const need = (Math.floor(toNum(ci && ci.qty)) || 1) * qty;
        if (!comp || String(comp.hotel) !== String(p.hotel)) throw httpError(400, 'This combo is not available right now.');
        if ((parseInt(comp.stock_count, 10) || 0) < need) throw httpError(409, `${cleanText(comp.name, 60) || 'A combo item'} is out of stock.`);
    }
}

function comboTextS(p, products) {
    return toArrS(p.combo_items).map(ci => {
        const q = products.find(x => x && String(x.id) === String(ci && ci.id));
        return cleanText(q ? q.name : '?', 60) + ' x' + (Math.floor(toNum(ci && ci.qty)) || 1);
    }).join(' + ').slice(0, 300);
}

// অর্ডারে শুধু দরকারি ফিল্ড রাখা হয় (পুরো product কপি করলে ডাটাবেস ফুলে যায়)
// price = আসলে যে দামে বিক্রি হলো; mrp = কাটা দাম; offerApplied = অফার/কম্বোর ছাড় পেয়েছে কি না
function slimItem(p, qty, price, mrp, offerApplied, comboText) {
    const imgs = Array.isArray(p.images) ? p.images : (p.images ? Object.values(p.images) : []);
    const item = {
        id: p.id, name: p.name, price, mrp, hotel: p.hotel || '',
        category: p.category || '', qty,
        images: imgs.length ? [imgs[0]] : [],
        offerApplied: !!offerApplied
    };
    if (p.is_combo === true) { item.isCombo = true; item.combo = comboText || ''; }
    return item;
}

// ঝুড়ি যাচাই: দাম, স্টক, হোটেল খোলা, অফার, কম্বো — সবই RAM-এর সর্বশেষ মেনু থেকে
async function resolveFoodBasket(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) throw httpError(400, 'Your basket is empty or invalid.');
    const wanted = new Map();
    for (const it of rawItems) {
        const id = cleanText(it && it.id, 60);
        const qty = Math.floor(toNum(it && it.qty));
        if (!id || !(qty >= 1) || qty > 50) throw httpError(400, 'Invalid item in basket.');
        wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    const menu = await getMenuData();
    const products = menu.products;
    const hotelNodes = new Map();

    // ---- পাস ১: যাচাই + সাধারণ মোট (কম্বো ও আনলক-আইটেম বাদে) ----
    const lines = [];
    let regularTotal = 0;
    for (const [id, qty] of wanted) {
        const p = products.find(x => x && String(x.id) === id);
        if (!p) throw httpError(400, 'An item in your basket is no longer available. Please refresh the menu.');
        const base = toNum(p.price);
        if (!(base > 0)) throw httpError(400, 'An item in your basket has an invalid price.');
        const stock = parseInt(p.stock_count, 10) || 0;
        if (stock < qty) throw httpError(409, `${cleanText(p.name, 60) || 'An item'} is out of stock.`);

        const hotelId = String(p.hotel || '').replace(/[^A-Za-z0-9]/g, '');
        if (!hotelId) throw httpError(400, 'An item in your basket has no restaurant assigned.');
        if (!hotelNodes.has(hotelId)) hotelNodes.set(hotelId, has(menu.hotels, hotelId) ? menu.hotels[hotelId] : undefined);
        if (!hotelIsOpen(hotelNodes.get(hotelId))) throw httpError(409, `${cleanText(p.hotel, 60)} is closed right now.`);

        const isCombo = p.is_combo === true;
        if (isCombo) checkComboS(p, qty, products);

        const offer = parseOfferS(p);
        if (offer && qty > offer.maxQty) {
            throw httpError(409, `Maximum ${offer.maxQty} per order for the offer on ${cleanText(p.name, 60) || 'this item'}.`);
        }

        if (!isCombo && !isUnlockS(p)) regularTotal += priceAtS(p, 0) * qty;
        lines.push({ p, qty, isCombo });
    }

    // ---- পাস ২: প্রতিটি লাইনের চূড়ান্ত দাম ----
    const items = [];
    let subtotal = 0, savings = 0;
    for (const { p, qty, isCombo } of lines) {
        const listPrice = toNum(p.price);
        const price = priceAtS(p, regularTotal);
        const mrpRaw = toNum(p.mrp);
        const mrp = mrpRaw > price ? mrpRaw : listPrice;
        const applied = price < listPrice || mrp > price;
        subtotal += price * qty;
        savings += Math.max(0, mrp - price) * qty;
        items.push(slimItem(p, qty, price, mrp, applied, isCombo ? comboTextS(p, products) : ''));
    }
    subtotal = Math.round(subtotal * 100) / 100;
    savings = Math.round(savings * 100) / 100;
    return { items, subtotal, savings, regularTotal, hotels: [...hotelNodes.values()] };
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
    if (!has(SEBA_TITLE_TO_ID, title)) return null;            // "constructor" ইত্যাদি কী আটকানো
    const id = SEBA_TITLE_TO_ID[title];
    const snap = await getDb('seba').ref('seba_prices/' + id).once('value');
    const n = toNum(snap.val());
    return n > 0 ? n : null;
}

// ---- Delivery / Ride / Courier: সম্পূর্ণ ভাড়া সার্ভারে হিসাব হয় ----
//      (রেঞ্জ + জোন + সার্ভিস + জোনের এক্সট্রা/প্রতি-কিমি + রাত্রির চার্জ + রিটার্ন চার্জ)
function isNightIST(nowMs) {
    const ist = new Date((nowMs === undefined ? Date.now() : nowMs) + 330 * 60000);
    const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return m >= 1350 || m < 300;                          // রাত ৯:৩০ থেকে ভোর ৫:০০ (IST, সার্ভারের ঘড়ি)
}
function parcelBase(d, night) {
    if (d <= 1.5) return 13; if (d <= 2.5) return 16; if (d <= 3.5) return 19; if (d <= 4.7) return 23;
    if (d <= 5.7) return 27; if (d <= 6.5) return 30; if (d <= 7.5) return 33;
    return 33 + (d - 7.5) * (night ? 2.0 : 1.5);
}
// অ্যাপ শুধু d.roadKm (সড়কপথের দূরত্ব) পাঠায়; সার্ভার সেটা সরলরেখার সাথে মিলিয়ে সীমাবদ্ধ করে নিজেই পুরো ভাড়া হিসাব করে।
// quoteOnly=true হলে ঠিকানা/ফোন/মিলানো বাদ, শুধু ভাড়া ফেরত দেয়।
async function buildDeliveryDetails(d, quoteOnly) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw httpError(400, 'Invalid booking details.');
    const type = d.type === 'Parcel Delivery' ? 'Parcel Delivery' : (d.type === 'Ride Booking' ? 'Ride Booking' : null);
    if (!type) throw httpError(400, 'Invalid booking type.');

    const pLat = toNum(d.pickupLat), pLng = toNum(d.pickupLng), dLat = toNum(d.dropLat), dLng = toNum(d.dropLng);
    const latOk = v => v >= 5 && v <= 38, lngOk = v => v >= 67 && v <= 98;
    if (!(latOk(pLat) && latOk(dLat) && lngOk(pLng) && lngOk(dLng))) throw httpError(400, 'অবৈধ জিপিএস লোকেশন। Invalid pick-up or drop-off location.');

    // দূরত্ব: সড়কপথের দূরত্ব ≥ সরলরেখা; কম দেখিয়ে ফাঁকি বা অস্বাভাবিক বাড়ানো — দুটোই সীমার মধ্যে টেনে আনা হয়
    const straightKm = haversineKm(pLat, pLng, dLat, dLng);
    const dMin = Math.max(1.0, straightKm - 0.3);
    const dMax = Math.max(dMin, straightKm * 1.8 + 1.0);
    const claimed = toNum(d.roadKm);
    const km = Math.min(Math.max(Number.isFinite(claimed) ? claimed : straightKm * 1.35, dMin), dMax);
    if (km > MAX_RANGE_KM + RANGE_TOLERANCE_KM) {
        console.warn(`RANGE REJECT (delivery) pickup=${pLat},${pLng} drop=${dLat},${dLng} dist=${km.toFixed(2)}km`);
        throw httpError(409, RANGE_MSG);
    }

    // জিওফেন্সিং: পিক-আপ ও ড্রপ দুটোই অনুমোদিত জোনের ভেতরে হতে হবে
    const z = await requireZone({ lat: pLat, lng: pLng });   // পিকআপ ভেতরে (এই জোনের রেট ও সার্ভিস প্রযোজ্য)
    await requireZone({ lat: dLat, lng: dLng });             // ড্রপ ভেতরে

    let reqFare = 0, pickup = '', drop = '';
    if (!quoteOnly) {
        reqFare = Math.round(toNum(d.totalFare));
        if (!(reqFare > 0 && reqFare <= 2000)) throw httpError(400, 'Invalid fare amount.');
        pickup = cleanText(d.pickup, 250); drop = cleanText(d.drop, 250);
        if (!pickup || !drop) throw httpError(400, 'Pick-up and drop-off addresses are required.');
    }

    const night = isNightIST();
    const out = {
        type, nightChargeApplied: night, totalFare: 0,
        distance: km.toFixed(1) + ' KM', roadKm: Number(km.toFixed(3)), pickup, drop,
        pickupLat: pLat, pickupLng: pLng, dropLat: dLat, dropLng: dLng
    };

    let base;
    if (type === 'Parcel Delivery') {
        requireService(z.info, 'parcel');                    // কুরিয়ার এই জোনে চালু কি না
        const size = ['Small', 'Medium', 'Large'].includes(d.size) ? d.size : (quoteOnly ? 'Small' : null);
        const itemName = cleanText(d.itemName, 80) || (quoteOnly ? 'Parcel' : '');
        const receiverPhone = String(d.receiverPhone || '').replace(/[^0-9]/g, '');
        if (!quoteOnly && (!size || !itemName || receiverPhone.length < 10 || receiverPhone.length > 13)) throw httpError(400, 'Invalid parcel details.');
        out.itemName = itemName; out.receiverPhone = receiverPhone; out.size = size;
        base = parcelBase(km, night) + (size === 'Small' ? 5 : size === 'Medium' ? 8 : 12);
        const pv = z.info.vehicle.parcel;                    // জোনের কুরিয়ার এক্সট্রা + প্রতি কিমি
        base += pv.extra + pv.perKm * km;
    } else {
        const vehicle = ['Bike', 'E-Rickshaw (Toto)'].includes(d.vehicle) ? d.vehicle : null;
        if (!vehicle) throw httpError(400, 'Invalid vehicle type.');
        const vKey = vehicle === 'Bike' ? 'bike' : 'toto';
        requireService(z.info, vKey);                        // বাইক/টোটো এই জোনে চালু কি না
        let passengers = Math.floor(toNum(d.passengers));
        if (vehicle === 'Bike') passengers = 1;
        if (!(passengers >= 1 && passengers <= 6)) throw httpError(400, 'Invalid passenger count.');
        out.vehicle = vehicle; out.passengers = passengers;
        if (vehicle === 'Bike') {
            base = km <= 2.3 ? 25 : 25 + (km - 2.3) * 8;
            if (night) base += 15;
        } else {
            const rate = passengers === 1 ? 18 : (passengers === 2 ? 16 : 14);
            base = rate * passengers + (km > 3 ? (km - 3) * 2 * passengers : 0);
            if (night) base += passengers <= 3 ? 20 : 15;
        }
        const rv = z.info.vehicle[vKey];                     // জোনের এক্সট্রা + প্রতি কিমি (টোটোতে যাত্রী দিয়ে গুণ হয় না)
        base += rv.extra + rv.perKm * km;
    }
    base = Math.max(5, Math.round(base));
    const rc = withReturnCharge(base, km);                   // ৮.৫ কিমির বেশি হলে ৫০% রিটার্ন চার্জ
    const fare = rc.finalFee;
    if (!quoteOnly && Math.abs(reqFare - fare) > FEE_TOLERANCE) throw httpError(409, 'Fare has changed. Please check the new fare and try again.');

    out.totalFare = fare;
    out.returnChargeApplied = rc.returnCharge > 0;
    out.zone = z.zone || null;
    out.zoneId = z.info.id;
    return { details: out, fare, minFare: fare, distanceKm: km, returnCharge: rc.returnCharge, night };
}

// =========================================================================
// 8. ROUTES
// =========================================================================
app.get('/', (req, res) => {
    res.json({ status: 'success', message: 'GMDS Secure Backend is Live & Running! 🚀', version: VERSION });
});

// ---- MENU: RAM থেকে, ?v=ভার্সন মিললে কয়েক বাইটের জবাব ----
app.get('/api/menu', asyncHandler(async (req, res) => {
    const d = await getMenuData();
    const v = String(menuStore.version || 0);
    if (req.query.v && String(req.query.v) === v) {
        return res.json({ status: 'success', unchanged: true, version: v });
    }
    res.json({ status: 'success', products: d.products, hotels: d.hotels, version: v });
}));

// ---- Login: device token তৈরি ----
app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = cleanText(b.phone, 10);
    const name = cleanText(b.name, 60) || 'User';
    if (!PHONE_RE.test(phone)) throw httpError(400, 'Invalid phone number.');
    if (!hit('login:' + phone, 5, 10 * 60 * 1000)) throw httpError(429, 'Too many login attempts for this number. Please wait.');

    if (REQUIRE_OTP) {
        const idToken = typeof b.idToken === 'string' ? b.idToken.slice(0, 4000) : '';
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

// ---- QUOTE: সার্ভারের হিসাব করা চার্জ (রেঞ্জ + জোন + সার্ভিস + জোনের চার্জ + রিটার্ন চার্জসহ) ----
app.post('/api/quote', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    if (!hit('quote:' + req.userPhone, 40, 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a moment.');

    const kind = cleanText(b.type, 20);
    if (kind === 'FoodOrder') {
        const basket = await resolveFoodBasket(b.items);
        const q = await computeFoodFee(basket.hotels, parseGps(b.gpsLocation), cleanText(b.address, 300).toLowerCase());
        return res.json({
            status: 'success', subtotal: basket.subtotal, savings: basket.savings,
            distanceKm: Number(q.distanceKm.toFixed(2)), zone: q.zone, zoneId: q.customerZoneId,
            baseFee: q.baseFee, extraFee: q.extraFee, returnCharge: q.returnCharge, deliveryFee: q.finalFee,
            total: basket.subtotal + q.finalFee
        });
    }
    if (kind === 'DeliveryRide') {
        const r = await buildDeliveryDetails(b.details, true);
        return res.json({
            status: 'success', fare: r.fare, minFare: r.fare, returnCharge: r.returnCharge,
            night: r.night, distanceKm: Number(r.distanceKm.toFixed(2))
        });
    }
    throw httpError(400, 'Unknown quote type.');
}));

// ---- ZONE CHECK: জোনের সার্ভিস, এক্সট্রা চার্জ ও কোন জোনের হোটেল থেকে খাবার আসতে পারে ----
app.post('/api/zone-check', requireAuth, asyncHandler(async (req, res) => {
    if (!hit('zone:' + req.userPhone, 60, 60 * 1000)) throw httpError(429, 'Too many requests. Please wait a moment.');
    const g = parseGps(bodyOf(req).gpsLocation);
    if (!g) throw httpError(400, 'Invalid GPS');
    const z = await checkZone(g.lat, g.lng);
    let foodAllowedFromZoneIds = [];
    if (z.ok) {
        const zones = await getZones();
        foodAllowedFromZoneIds = zones
            .filter(h => h.services.food && (h.id === z.info.id || !h.foodRules || h.foodTo.has(z.info.id)))
            .map(h => h.id);
    }
    res.json({
        status: 'success', inZone: z.ok, zone: z.zone,
        zoneId: z.info ? z.info.id : null,
        services: z.info ? z.info.services : null,
        extraFee: z.info ? z.info.extraFee : 0,
        foodAllowedFromZoneIds
    });
}));

// =========================================================================
// 8A. ZONE ADMIN API — জোন ম্যানেজার প্যানেলের জন্য (সব যাচাই সার্ভারে; ক্লায়েন্টে কিছু নেই)
//   POST /api/zone-admin/list    → সব জোন (বন্ধগুলোসহ), ডিফল্ট-ভরা মানসহ
//   POST /api/zone-admin/save    → নতুন (id ছাড়া) বা বিদ্যমান জোন সেভ
//   POST /api/zone-admin/delete  → জোন মোছা + অন্য জোনের food_to থেকে সরানো
//   হেডার: x-admin-key: <ADMIN_KEY>   (Render env, কমপক্ষে ১৬ অক্ষর)
// =========================================================================
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const ADMIN_KEY_OK = ADMIN_KEY.length >= 16;
const ADMIN_KEY_DIGEST = crypto.createHash('sha256').update(ADMIN_KEY).digest();
if (!ADMIN_KEY_OK) console.warn('⚠️ ADMIN_KEY is missing or shorter than 16 characters - zone admin API is DISABLED.');

const ZONE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ADMIN_FAIL_MAX = 10, ADMIN_FAIL_WINDOW = 15 * 60 * 1000;

const zoneAdminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 120,
    message: { status: 'error', message: 'Too many admin requests. Please wait.' },
    standardHeaders: true, legacyHeaders: false
});
app.use('/api/zone-admin/', zoneAdminLimiter);

function requireZoneAdmin(req, res, next) {
    if (!ADMIN_KEY_OK) return next(httpError(503, 'Zone admin is not configured on the server.'));
    const failKey = 'zadmin-fail:' + (req.ip || 'unknown');
    if (hitCount(failKey, ADMIN_FAIL_WINDOW) >= ADMIN_FAIL_MAX) return next(httpError(429, 'Too many failed attempts. Try again later.'));
    const given = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest();
    if (!crypto.timingSafeEqual(given, ADMIN_KEY_DIGEST)) {
        hit(failKey, 1000, ADMIN_FAIL_WINDOW);                 // ব্যর্থ চেষ্টা গোনা
        return next(httpError(401, 'Invalid admin key.'));
    }
    next();
}

// ---- কঠোর যাচাই সহায়ক (ভুল মান চুপচাপ ডিফল্ট না হয়ে সরাসরি ত্রুটি দেয়) ----
function strictNum(v, lo, hi, label) {
    const n = toNum(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw httpError(400, `${label}: ${lo} থেকে ${hi}-এর মধ্যে একটি সংখ্যা দিন।`);
    return Math.round(n * 100) / 100;
}
function strictBool(v, d) {
    if (v === undefined || v === null) return d;
    if (typeof v !== 'boolean') throw httpError(400, 'টিক-বক্সের মান অবৈধ।');
    return v;
}
function orient(a, b, c) { return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng); }
function segCross(a, b, c, d) {                               // ঠিক কেটে যাওয়া (ছোঁয়া নয়)
    return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}
function polyArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].lng + poly[i].lng) * (poly[j].lat - poly[i].lat);
    return Math.abs(a / 2);
}
function selfIntersects(poly) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // পাশাপাশি বাহু বাদ
            if (segCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
        }
    }
    return false;
}
function sameVertex(p, poly) { return poly.some(q => q.lat === p.lat && q.lng === p.lng); }
function polygonsOverlap(P, Q) {
    if (P.length === Q.length && P.every(p => sameVertex(p, Q))) return true;     // হুবহু এক
    for (let i = 0; i < P.length; i++) {
        for (let j = 0; j < Q.length; j++) {
            if (segCross(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length])) return true;
        }
    }
    if (P.some(p => !sameVertex(p, Q) && pointInPolygon(p.lat, p.lng, Q))) return true;   // একটা আরেকটার ভেতরে
    if (Q.some(q => !sameVertex(q, P) && pointInPolygon(q.lat, q.lng, P))) return true;
    return false;
}
function polygonEquals(A, B) {
    return Array.isArray(A) && Array.isArray(B) && A.length === B.length &&
        A.every((p, i) => p.lat === B[i].lat && p.lng === B[i].lng);
}

function sanitizePolygon(raw) {
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > 300) throw httpError(400, 'জোনে ৩ থেকে ৩০০টি কোণা থাকতে হবে।');
    const poly = raw.map(p => {
        const lat = toNum(p && p.lat), lng = toNum(p && p.lng);
        if (!(lat >= 5 && lat <= 38 && lng >= 67 && lng <= 98)) throw httpError(400, 'জোনের কোনো কোণার লোকেশন অবৈধ।');
        return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    });
    if (polyArea(poly) < 1e-9) throw httpError(400, 'জোনের এলাকা শূন্য; কোণাগুলো এক সরলরেখায়।');
    if (selfIntersects(poly)) throw httpError(400, 'জোনের সীমানা নিজেকেই কেটেছে (আটের মতো প্যাঁচ)। কোণাগুলো ঠিক করুন।');
    return poly;
}

// ইনপুট → Firebase-এ লেখার মতো পরিষ্কার অবজেক্ট। ctx: { knownIds:Set, selfId, others:[{id,name,polygon}], existingPoly }
function buildZoneFromInput(b, ctx) {
    const name = cleanText(b.zone_name, 60);
    if (!name) throw httpError(400, 'জোনের নাম দিন।');

    const polygon = sanitizePolygon(b.polygon);
    if (!polygonEquals(polygon, ctx.existingPoly)) {              // সীমানা বদলালে বা নতুন হলেই ওভারল্যাপ দেখা
        for (const o of ctx.others) {
            if (polygonsOverlap(polygon, o.polygon)) {
                throw httpError(409, `এই জোনের সীমানা "${o.name}" জোনের সাথে মিলে গেছে। ওভারল্যাপ থাকলে চার্জ অনির্দিষ্ট হয়; সীমানা সরান।`);
            }
        }
    }

    const slabsIn = Array.isArray(b.slabs) ? b.slabs : null;
    if (!slabsIn || slabsIn.length !== 6) throw httpError(400, 'স্ল্যাবে ঠিক ৬টি ধাপের টাকা দিন।');
    const slabs = [];
    slabsIn.forEach((v, i) => {
        const n = strictNum(v, 10, 500, `স্ল্যাব ${i + 2}`);
        const prev = i === 0 ? 10 : slabs[i - 1];
        if (n < prev) throw httpError(400, `স্ল্যাব ${i + 2} (₹${n}) আগের ধাপের (₹${prev}) চেয়ে কম হতে পারবে না।`);
        slabs.push(n);
    });

    const sv = (b.services && typeof b.services === 'object' && !Array.isArray(b.services)) ? b.services : {};
    const services = {};
    SERVICE_KEYS.forEach(k => { services[k] = strictBool(sv[k], true); });

    const vf = (b.vehicle_fees && typeof b.vehicle_fees === 'object' && !Array.isArray(b.vehicle_fees)) ? b.vehicle_fees : {};
    const vehicle_fees = {};
    VEHICLE_KEYS.forEach(k => {
        const v = (vf[k] && typeof vf[k] === 'object') ? vf[k] : {};
        vehicle_fees[k] = {
            extra: v.extra === undefined ? 0 : strictNum(v.extra, -50, 200, `${k} এক্সট্রা চার্জ`),
            per_km: v.per_km === undefined ? 0 : strictNum(v.per_km, -5, 20, `${k} প্রতি কিমি চার্জ`)
        };
    });

    const food_rules = strictBool(b.food_rules, false);
    let food_to = null;
    if (food_rules) {
        const list = Array.isArray(b.food_to) ? b.food_to : [];
        if (list.length > 200) throw httpError(400, 'খাবারের তালিকা অস্বাভাবিক বড়।');
        const map = {};
        for (const rid of list) {
            const id = String(rid);
            if (!ZONE_ID_RE.test(id) || !ctx.knownIds.has(id)) throw httpError(400, 'খাবারের তালিকায় অজানা জোন আছে।');
            if (id !== ctx.selfId) map[id] = true;                // নিজের জোনে সবসময় যায়, রাখার দরকার নেই
        }
        food_to = Object.keys(map).length ? map : null;
    }

    return {
        zone_name: name, polygon,
        active: strictBool(b.active, true),
        extra_fee: strictNum(b.extra_fee === undefined ? 0 : b.extra_fee, -50, 200, 'এক্সট্রা চার্জ'),
        per_km: strictNum(b.per_km === undefined ? DEFAULT_PER_KM : b.per_km, 0.1, 50, '৭.৫ কিমির পর প্রতি কিমি রেট'),
        slabs, services, vehicle_fees, food_rules, food_to,
        updatedAt: Date.now()
    };
}

// প্যানেলকে দেখানোর রূপ: ডিফল্টসহ পূর্ণ মান (parseZones-এর যুক্তিই ব্যবহার, তাই কাস্টমারের সাথে হুবহু মিলবে)
function adminView(id, z) {
    const p = parseZones({ [id]: { ...z, active: true } })[0];
    if (!p) return null;
    const vehicle_fees = {};
    VEHICLE_KEYS.forEach(k => { vehicle_fees[k] = { extra: p.vehicle[k].extra, per_km: p.vehicle[k].perKm }; });
    return {
        id, zone_name: p.name, active: z.active !== false, polygon: p.poly,
        extra_fee: p.extraFee, per_km: p.perKm, slabs: p.slabs, services: p.services,
        food_rules: p.foodRules, food_to: [...p.foodTo], vehicle_fees
    };
}

function auditZone(action, id, name, req) {
    getDb('core').ref('zone_audit').push({
        action, zoneId: id, zoneName: name || '', at: Date.now(), ip: String(req.ip || '').slice(0, 64)
    }).catch(e => console.error('Zone audit failed:', e.message));
}

app.post('/api/zone-admin/list', requireZoneAdmin, asyncHandler(async (req, res) => {
    const raw = (await getDb('core').ref('gmds_zones').once('value')).val() || {};
    const zones = Object.entries(raw).map(([id, z]) => (z && typeof z === 'object') ? adminView(id, z) : null).filter(Boolean);
    res.json({ status: 'success', zones, services: SERVICE_KEYS, maxRangeKm: MAX_RANGE_KM });
}));

app.post('/api/zone-admin/save', requireZoneAdmin, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const db = getDb('core');
    const raw = (await db.ref('gmds_zones').once('value')).val() || {};

    let id = (b.id === undefined || b.id === null || b.id === '') ? null : String(b.id);
    if (id !== null) {
        if (!ZONE_ID_RE.test(id)) throw httpError(400, 'অবৈধ জোন আইডি।');
        if (!has(raw, id)) throw httpError(404, 'এই জোনটি পাওয়া যায়নি।');
    }
    const views = Object.entries(raw).map(([zid, z]) => (z && typeof z === 'object') ? adminView(zid, z) : null).filter(Boolean);
    const existing = id ? views.find(v => v.id === id) : null;
    const knownIds = new Set(Object.keys(raw));
    if (id === null) id = db.ref('gmds_zones').push().key;

    const clean = buildZoneFromInput(b, {
        knownIds, selfId: id,
        others: views.filter(v => v.id !== id && v.active).map(v => ({ id: v.id, name: v.zone_name, polygon: v.polygon })),
        existingPoly: existing ? existing.polygon : null
    });

    await db.ref('gmds_zones/' + id).update(stripUndefined(clean));   // update: অন্য ফিল্ড মুছে যায় না
    auditZone(existing ? 'update' : 'create', id, clean.zone_name, req);

    const saved = (await db.ref('gmds_zones/' + id).once('value')).val();
    console.log(`🗺️ [ZONE ${existing ? 'UPDATE' : 'CREATE'}] ${id} "${clean.zone_name}"`);
    res.json({ status: 'success', zone: adminView(id, saved) });
}));

app.post('/api/zone-admin/delete', requireZoneAdmin, asyncHandler(async (req, res) => {
    const id = String(bodyOf(req).id || '');
    if (!ZONE_ID_RE.test(id)) throw httpError(400, 'অবৈধ জোন আইডি।');
    const db = getDb('core');
    const raw = (await db.ref('gmds_zones').once('value')).val() || {};
    if (!has(raw, id)) throw httpError(404, 'এই জোনটি পাওয়া যায়নি।');

    const updates = { ['gmds_zones/' + id]: null };
    Object.entries(raw).forEach(([zid, z]) => {                  // অন্য জোনের খাবার-তালিকা থেকে এই জোন সরানো
        if (zid !== id && z && z.food_to && z.food_to[id] !== undefined) updates['gmds_zones/' + zid + '/food_to/' + id] = null;
    });
    await db.ref().update(updates);
    auditZone('delete', id, raw[id] && raw[id].zone_name, req);
    console.log(`🗑️ [ZONE DELETE] ${id}`);
    res.json({ status: 'success' });
}));

// =========================================================================
// 8B. OFFER ADMIN API — অফার ও কম্বো প্যানেলের জন্য (ADMIN_KEY লাগে; সব যাচাই সার্ভারে)
//   POST /api/offer-admin/list          → সব প্রোডাক্ট (অফার/কম্বোসহ)
//   POST /api/offer-admin/save-offer    → { id, offer:{...} } সেভ, বা offer:null দিলে অফার মোছা
//   POST /api/offer-admin/save-combo    → { id?, name, items:[{id,qty}], price, stock, image, description }
//   POST /api/offer-admin/delete-combo  → { id }
// =========================================================================
app.use('/api/offer-admin/', zoneAdminLimiter);

async function loadProductsRaw() {
    const raw = (await getDb('core').ref('products').once('value')).val() || {};
    const map = new Map();
    Object.entries(raw).forEach(([k, v]) => { if (v && typeof v === 'object') map.set(k, v); });
    return map;
}
function findProductKey(map, id) {
    const want = String(id);
    for (const [k, v] of map) if (String(v.id) === want || k === want) return k;
    return null;
}
function rawOfferView(o) {
    if (!o || typeof o !== 'object') return null;
    return {
        active: o.active === true,
        tiers: toArrS(o.tiers).map(t => ({ minCart: toNum(t && t.minCart) || 0, price: toNum(t && t.price) || 0 }))
            .sort((a, b) => a.minCart - b.minCart),
        maxQty: Math.floor(toNum(o.maxQty)) || 99,
        start: toNum(o.start) > 0 ? toNum(o.start) : null,
        end: toNum(o.end) > 0 ? toNum(o.end) : null,
        terms: cleanText(o.terms, 200)
    };
}
function offerProductView(k, p) {
    const imgs = Array.isArray(p.images) ? p.images : (p.images ? Object.values(p.images) : []);
    return {
        id: String(p.id !== undefined ? p.id : k),
        name: cleanText(p.name, 80), hotel: cleanText(p.hotel, 80), category: cleanText(p.category, 40),
        price: toNum(p.price) || 0, mrp: toNum(p.mrp) || 0, stock: parseInt(p.stock_count, 10) || 0,
        image: (typeof imgs[0] === 'string') ? imgs[0] : '',
        description: cleanText(p.description, 200),
        is_combo: p.is_combo === true,
        combo_items: toArrS(p.combo_items).map(ci => ({ id: String(ci && ci.id), qty: Math.floor(toNum(ci && ci.qty)) || 1 })),
        offer: rawOfferView(p.offer)
    };
}
function auditOffer(action, id, name, req) {
    getDb('core').ref('offer_audit').push({
        action, productId: String(id), name: name || '', at: Date.now(), ip: String(req.ip || '').slice(0, 64)
    }).catch(e => console.error('Offer audit failed:', e.message));
}

app.post('/api/offer-admin/list', requireZoneAdmin, asyncHandler(async (req, res) => {
    const map = await loadProductsRaw();
    const products = [];
    for (const [k, p] of map) { if (products.length >= 2000) break; products.push(offerProductView(k, p)); }
    res.json({ status: 'success', products });
}));

app.post('/api/offer-admin/save-offer', requireZoneAdmin, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const map = await loadProductsRaw();
    const key = findProductKey(map, cleanText(b.id, 60));
    if (!key) throw httpError(404, 'প্রোডাক্টটি পাওয়া যায়নি।');
    const p = map.get(key);
    const base = toNum(p.price);
    if (!(base > 0)) throw httpError(400, 'এই প্রোডাক্টের আসল দাম ঠিক নেই।');
    const ref = getDb('core').ref('products/' + key + '/offer');

    if (b.offer === null) {                                         // অফার মুছে ফেলা
        await ref.remove();
        auditOffer('offer-remove', p.id, p.name, req);
        console.log(`🏷️ [OFFER REMOVE] ${key}`);
        return res.json({ status: 'success', removed: true });
    }
    const o = b.offer;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw httpError(400, 'অফারের তথ্য অবৈধ।');

    const tiersIn = Array.isArray(o.tiers) ? o.tiers : [];
    if (tiersIn.length < 1 || tiersIn.length > 6) throw httpError(400, 'অফারে ১ থেকে ৬টি ধাপ দিন।');
    const seen = new Set();
    const tiers = tiersIn.map((t, i) => {
        const minCart = Math.round(strictNum(t && t.minCart, 0, 5000, `ধাপ ${i + 1}: ন্যূনতম অর্ডার`));
        const price = strictNum(t && t.price, 1, 100000, `ধাপ ${i + 1}: অফার দাম`);
        if (price >= base) throw httpError(400, `ধাপ ${i + 1}: অফার দাম (₹${price}) আসল দামের (₹${base}) চেয়ে কম হতে হবে।`);
        if (seen.has(minCart)) throw httpError(400, `দুটি ধাপে একই ন্যূনতম অর্ডার (₹${minCart}) আছে।`);
        seen.add(minCart);
        return { minCart, price };
    }).sort((a, b2) => a.minCart - b2.minCart);
    // বেশি অর্ডারে দাম কমই হওয়া উচিত, বাড়া নয়
    for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].price > tiers[i - 1].price) throw httpError(400, `বেশি অর্ডারের ধাপে (₹${tiers[i].minCart}) দাম আগের ধাপের চেয়ে বেশি হতে পারবে না।`);
    }

    const maxQty = Math.floor(strictNum(o.maxQty === undefined || o.maxQty === null || o.maxQty === '' ? 99 : o.maxQty, 1, 99, 'সর্বোচ্চ সংখ্যা'));
    const st = (o.start === undefined || o.start === null || o.start === '') ? null : toNum(o.start);
    const en = (o.end === undefined || o.end === null || o.end === '') ? null : toNum(o.end);
    if ((st !== null && !(st > 1e12)) || (en !== null && !(en > 1e12))) throw httpError(400, 'শুরু/শেষের সময় অবৈধ।');
    if (st !== null && en !== null && en <= st) throw httpError(400, 'শেষের সময় শুরুর পরে হতে হবে।');

    const clean = {
        active: strictBool(o.active, true), tiers, maxQty,
        start: st, end: en, terms: cleanText(o.terms, 200), updatedAt: Date.now()
    };
    await ref.set(stripUndefined(clean));
    auditOffer('offer-save', p.id, p.name, req);
    console.log(`🏷️ [OFFER SAVE] ${key} tiers=${tiers.length}`);
    res.json({ status: 'success', offer: rawOfferView(clean) });
}));

app.post('/api/offer-admin/save-combo', requireZoneAdmin, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const db = getDb('core');
    const map = await loadProductsRaw();

    let key = null, existing = null;
    if (b.id !== undefined && b.id !== null && b.id !== '') {
        key = findProductKey(map, cleanText(b.id, 60));
        if (!key || map.get(key).is_combo !== true) throw httpError(404, 'এই কম্বোটি পাওয়া যায়নি।');
        existing = map.get(key);
    }

    const name = cleanText(b.name, 80);
    if (!name) throw httpError(400, 'কম্বোর নাম দিন।');
    const itemsIn = Array.isArray(b.items) ? b.items : [];
    if (itemsIn.length < 1 || itemsIn.length > 12) throw httpError(400, 'কম্বোতে ১ থেকে ১২টি আইটেম দিন।');

    const merged = new Map();
    for (const it of itemsIn) {
        const id = cleanText(it && it.id, 60);
        const qty = Math.floor(toNum(it && it.qty));
        if (!id || !(qty >= 1 && qty <= 10)) throw httpError(400, 'কম্বোর আইটেম বা সংখ্যা অবৈধ (১-১০)।');
        merged.set(id, (merged.get(id) || 0) + qty);
    }
    let hotel = null, sum = 0, firstImg = '';
    const comboItems = [];
    for (const [id, qty] of merged) {
        if (qty > 10) throw httpError(400, 'একই আইটেম কম্বোতে ১০টির বেশি দেওয়া যাবে না।');
        const ck = findProductKey(map, id);
        if (!ck) throw httpError(400, 'কম্বোর একটি আইটেম পাওয়া যায়নি।');
        const cp = map.get(ck);
        if (cp.is_combo === true) throw httpError(400, 'কম্বোর ভেতরে আরেকটি কম্বো দেওয়া যায় না।');
        const h = String(cp.hotel || '');
        if (!h) throw httpError(400, `"${cleanText(cp.name, 60)}"-এর হোটেল ঠিক নেই।`);
        if (hotel === null) hotel = h;
        else if (h !== hotel) throw httpError(400, 'কম্বোর সব আইটেম একই হোটেলের হতে হবে।');
        const pr = toNum(cp.price);
        if (!(pr > 0)) throw httpError(400, `"${cleanText(cp.name, 60)}"-এর দাম ঠিক নেই।`);
        sum += pr * qty;
        comboItems.push({ id: String(cp.id !== undefined ? cp.id : ck), qty });
        if (!firstImg) { const im = Array.isArray(cp.images) ? cp.images : (cp.images ? Object.values(cp.images) : []); if (typeof im[0] === 'string') firstImg = im[0]; }
    }
    const mrp = Math.round(sum * 100) / 100;                       // কাটা দাম সার্ভার নিজে হিসাব করে (ভুয়া MRP নয়)
    const price = strictNum(b.price, 1, 100000, 'কম্বোর দাম');
    if (price >= mrp) throw httpError(400, `কম্বোর দাম (₹${price}) আইটেমগুলোর মোট দামের (₹${mrp}) চেয়ে কম হতে হবে।`);
    const stock = Math.floor(strictNum(b.stock === undefined ? 99 : b.stock, 0, 999, 'স্টক'));

    let image = cleanText(b.image, 500);
    if (image && !/^https:\/\//i.test(image)) throw httpError(400, 'ছবির লিংক https:// দিয়ে শুরু হতে হবে।');
    if (!image) image = firstImg;

    const fields = {
        name, hotel, price, mrp, category: cleanText(b.category, 40) || 'Combo',
        stock_count: stock, images: image ? [image] : [],
        description: cleanText(b.description, 200), is_combo: true, combo_items: comboItems, updatedAt: Date.now()
    };
    if (!key) {
        key = 'combo_' + Date.now();
        fields.id = key; fields.review = '4.5'; fields.review_count = 1;
    }
    await db.ref('products/' + key).update(stripUndefined(fields));
    auditOffer(existing ? 'combo-update' : 'combo-create', key, name, req);
    console.log(`🍱 [COMBO ${existing ? 'UPDATE' : 'CREATE'}] ${key} ₹${price} (mrp ${mrp})`);
    res.json({ status: 'success', id: key, mrp });
}));

app.post('/api/offer-admin/delete-combo', requireZoneAdmin, asyncHandler(async (req, res) => {
    const map = await loadProductsRaw();
    const key = findProductKey(map, cleanText(bodyOf(req).id, 60));
    if (!key || map.get(key).is_combo !== true) throw httpError(404, 'এই কম্বোটি পাওয়া যায়নি।');
    await getDb('core').ref('products/' + key).remove();
    auditOffer('combo-delete', key, map.get(key).name, req);
    console.log(`🗑️ [COMBO DELETE] ${key}`);
    res.json({ status: 'success' });
}));

// ---- Place order (Food / House / Seba / Delivery) — শুধু COD ----
function requireCod(b) {
    if (b.payMode !== undefined && b.payMode !== null && String(b.payMode).toUpperCase() !== 'COD') {
        throw httpError(400, 'Online payment is not available. Please choose Cash on Delivery.');
    }
}

async function placeFoodOrder(b, phone) {
    requireCod(b);
    const orderId = cleanText(b.orderId, 20);
    if (!/^[0-9]{10,15}$/.test(orderId)) throw httpError(400, 'Invalid order ID.');
    const name = cleanText(b.user || b.customer || b.name, 60) || 'Customer';
    const address = cleanText(b.address, 300);
    if (!address) throw httpError(400, 'Delivery address is required.');
    const remote = b.remoteOrder === true;
    let receiverPhone = 'N/A';
    if (remote) {
        receiverPhone = String(b.receiverPhone || '').replace(/[^0-9]/g, '');
        if (receiverPhone.length < 10 || receiverPhone.length > 13) throw httpError(400, 'Invalid receiver phone number.');
    }

    // 🎁 অফার/কম্বো সহ দাম সার্ভারই বসায়; ক্লায়েন্টের পাঠানো কোনো দাম বিশ্বাস করা হয় না
    const basket = await resolveFoodBasket(b.items);
    const { items, subtotal, savings } = basket;

    // 🗺️ রেঞ্জ + জোন জিওফেন্সিং + সার্ভিস + A→B নিয়ম + জোনের স্ল্যাব/এক্সট্রা + ৮.৫ কিমির পর ৫০% রিটার্ন চার্জ
    const quote = await computeFoodFee(basket.hotels, parseGps(b.gpsLocation), address.toLowerCase());

    const fee = Math.round(toNum(b.deliveryFee));
    if (!(fee >= 5 && fee <= 1000)) throw httpError(400, 'Invalid delivery charge.');
    // সার্ভারের হিসাবের সঙ্গে মিলতে হবে: কম হলে ফাঁকি, অস্বাভাবিক বেশি হলে ভুল দেখানো চার্জ — দুটোই আটকায়
    if (Math.abs(fee - quote.finalFee) > FEE_TOLERANCE) throw httpError(409, 'Delivery charge has changed. Please refresh your basket and try again.');

    const total = Math.round((subtotal + fee) * 100) / 100;

    const record = {
        orderId: Number(orderId), user: name, phone, address,
        gpsLocation: mapsUrlOr(b.gpsLocation, 'Waiting Sync'),
        items, subtotal, savings, deliveryFee: fee, grandTotal: total, payMode: 'COD',
        calculatedDistance: Number(quote.distanceKm.toFixed(2)),
        returnChargeApplied: quote.returnCharge, serviceZone: quote.zone || null,
        customerZoneId: quote.customerZoneId, hotelZoneIds: quote.hotelZoneIds, extraFeeApplied: quote.extraFee,
        remoteOrder: remote, receiverPhone,
        time: istNow(), riderStatus: 'Pending', status: 'Pending', createdAt: Date.now(),
        serverVerifiedAt: new Date().toISOString(), source: 'server'
    };
    await createRecord('core', 'all_orders', orderId, record);

    await writeTracking('core', orderId, record);
    backupOrder('food', record, total);
    console.log(`🛒 [FOOD ORDER] ${orderId} ₹${total} COD dist=${quote.distanceKm.toFixed(1)}km return=${quote.returnCharge} extra=${quote.extraFee} saved=${savings}`);
    return { orderId: record.orderId };
}

const DEFAULT_PRO = 'GMDS Certified Expert';

async function placeHouseOrder(b, phone) {
    requireCod(b);
    const zoneInfo = await requireZone(parseGps(b.location));          // কাস্টমার ভেতরে
    requireService(zoneInfo.info, 'house');                            // হাউস হেল্প এই জোনে চালু কি না
    const orderId = cleanText(b.orderId, 30);
    if (!/^HS_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const service = cleanText(b.service, 80);
    if (!service) throw httpError(400, 'Service name is required.');

    // সেলুন বুকিং: সেলুনের নিজের লোকেশনও জোনের ভেতরে হতে হবে
    const professional = cleanText(b.professional, 120) || DEFAULT_PRO;
    const salonId = cleanText(b.salonId, 60);
    let salonZone = null;
    if (salonId || professional !== DEFAULT_PRO) {
        if (!/^[A-Za-z0-9_-]{1,60}$/.test(salonId)) throw httpError(400, 'Salon information is missing. Please update the app and try again.');
        const salon = (await getDb('house').ref('salons/' + salonId).once('value')).val();
        if (!salon) throw httpError(404, 'This salon is not available.');
        if (String(salon.status || '').toUpperCase() === 'CLOSED') throw httpError(409, 'This salon is currently closed.');
        const sLat = toNum(salon.lat), sLng = toNum(salon.lng);
        if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) throw httpError(400, 'This salon has no location set. Please contact support.');
        const sz = await requireZone({ lat: sLat, lng: sLng });
        requireService(sz.info, 'house');                              // সেলুনের জোনেও চালু থাকতে হবে
        salonZone = sz.zone;
    }

    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone, service,
        professional,
        problem: cleanText(b.problem, 500) || 'N/A',
        appointmentTime: cleanText(b.appointmentTime, 60), location: mapsUrlOr(b.location, 'Not Found'),
        serviceZone: zoneInfo.zone || null,
        salonId: salonId || null, salonZone,
        timestamp: istNow(), status: 'Confirmed', payMode: 'COD', createdAt: Date.now(), source: 'server'
    };
    await createRecord('house', 'house_bookings', orderId, record);
    backupOrder('house', record, 'N/A');
    console.log(`🔧 [HOUSE BOOKING] ${orderId}`);
    return { orderId };
}

async function placeSebaOrder(b, phone) {
    requireCod(b);
    const zoneInfo = await requireZone(parseGps(b.location));          // কাস্টমার ভেতরে
    requireService(zoneInfo.info, 'seba');                             // ডিজিটাল সেবা এই জোনে চালু কি না
    const orderId = cleanText(b.orderId, 30);
    if (!/^SEBA_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const service = cleanText(b.service, 120);
    if (!service) throw httpError(400, 'Service name is required.');

    const expected = await sebaExpectedPrice(service);
    const priceStr = expected ? '₹' + expected : 'Variable';

    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone, service,
        category: cleanText(b.category, 20), price: priceStr, payMode: 'COD',
        serviceZone: zoneInfo.zone || null,
        location: mapsUrlOr(b.location, 'Not Shared'), timestamp: istNow(),
        status: 'Confirmed', createdAt: Date.now(), source: 'server'
    };
    await createRecord('seba', 'seba_orders', orderId, record);
    backupOrder('seba', record, priceStr);
    console.log(`💻 [SEBA ORDER] ${orderId}`);
    return { orderId };
}

async function placeDeliveryOrder(b, phone) {
    requireCod(b);
    const orderId = cleanText(b.orderId, 30);
    if (!/^DEL_[0-9]{10,16}$/.test(orderId)) throw httpError(400, 'Invalid booking ID.');
    const { details, fare } = await buildDeliveryDetails(b.details, false);

    const record = {
        orderId, customer: cleanText(b.customer || b.user || b.name, 60) || 'Customer', phone,
        price: fare, payMode: 'COD', details, timestamp: istNow(),
        riderStatus: 'Confirmed', status: 'Confirmed', createdAt: Date.now(),
        serverVerifiedAt: new Date().toISOString(), source: 'server'
    };
    await createRecord('medicine', 'delivery_orders', orderId, record);

    await writeTracking('medicine', orderId, record);
    backupOrder('delivery', record, fare);
    console.log(`🛵 [DELIVERY] ${orderId} ₹${fare} COD`);
    return { orderId };
}

app.post('/api/place-order', requireAuth, orderLimiter, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = req.userPhone;
    if (!hit('order:' + phone, 5, 5 * 60 * 1000)) throw httpError(429, 'Security Lock: You are placing orders too fast. Please wait a few minutes.');
    if (!hit('orderday:' + phone, 60, 24 * 3600 * 1000)) throw httpError(429, 'Daily order limit reached. Please contact support.');

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
// 9. ORDER HISTORY, CANCEL, ACCOUNT DELETE
// =========================================================================
const CANCELLABLE = ['Pending', 'Confirmed'];
const TERMINAL = ['Delivered', 'Completed', 'Done', 'Cancelled', 'Cancelled & Refunded'];

const SERVICE_MAP = {
    food: {
        db: 'core', path: 'all_orders', idRe: /^[0-9]{10,15}$/, win: 300, statusKey: 'riderStatus', both: true,
        nameKey: 'user', wipe: ['address', 'gpsLocation', 'receiverPhone'], nullify: [],
        shape: (o, key) => ({
            type: 'food', serviceType: 'food', dbPath: 'all_orders',
            rawId: o.orderId || key, orderId: o.orderId || key, time: o.time || 'N/A', rawTimestamp: orderTs(o, key),
            items: Array.isArray(o.items) ? o.items : (o.items ? Object.values(o.items) : []),
            subtotal: o.subtotal || 0, savings: o.savings || 0, deliveryFee: o.deliveryFee || 0, grandTotal: o.grandTotal || 0,
            payMode: o.payMode || 'COD',
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
                payMode: o.payMode || 'COD',
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
            payMode: o.payMode || 'COD',
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
            payMode: o.payMode || 'COD',
            status: o.status || 'Pending',
            icon: 'fa-laptop-code', iconColor: 'text-purple-600', iconBg: 'bg-purple-50'
        })
    }
};
// শুধু নিজস্ব কী গ্রহণযোগ্য ("constructor", "__proto__" ইত্যাদি দিয়ে আক্রমণ বন্ধ)
function getServiceCfg(kind) { return has(SERVICE_MAP, kind) ? SERVICE_MAP[kind] : null; }

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

// ---- Cancel (শুধু COD অর্ডার; রিফান্ডের প্রয়োজন নেই) ----
app.post('/api/order/cancel', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const cfg = getServiceCfg(cleanText(b.serviceType, 10));
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
    if (order.payMode === 'ONLINE') throw httpError(400, 'This order was paid online earlier. Please contact support to cancel it.');

    const createdAt = orderTs(order, orderId);
    if (Date.now() - createdAt > (cfg.win + 10) * 1000) throw httpError(400, 'The cancellation time window for this order has closed.');

    const finalStatus = 'Cancelled';
    const tx = await orderRef.transaction(cur => {
        if (cur === null) return cur;
        if (String(cur.phone) !== phone) return;
        const eff = cur[cfg.statusKey] || cur.status || cur.riderStatus || 'Confirmed';
        if (!CANCELLABLE.includes(eff)) return;
        cur.status = finalStatus;
        if (cfg.both) cur.riderStatus = finalStatus; else cur[cfg.statusKey] = finalStatus;
        cur.cancelledAt = Date.now();
        cur.cancelReason = 'Customer cancelled';
        cur.cancelledBy = 'customer';
        return cur;
    });
    if (!tx.committed || !tx.snapshot.exists()) throw httpError(409, 'This order can no longer be cancelled (it is already being processed).');

    if (OrderBackup && mongoose.connection.readyState === 1) {
        OrderBackup.updateOne({ orderId: String(orderId) }, { riderStatus: finalStatus }).catch(() => {});
    }
    console.log(`🚫 [CANCELLED] ${orderId}`);
    res.json({ status: 'success', refunded: false, refundId: null, message: 'Order cancelled successfully.' });
}));

// ---- Live tracking: শুধু অর্ডারের মালিক রাইডারের তথ্য পাবে ----
app.post('/api/order/track', requireAuth, asyncHandler(async (req, res) => {
    const b = bodyOf(req);
    const phone = req.userPhone;
    if (!hit('track:' + phone, 30, 60 * 1000)) throw httpError(429, 'Too many requests.');

    const kind = cleanText(b.serviceType, 10);
    const cfg = (kind === 'food' || kind === 'delivery') ? SERVICE_MAP[kind] : null;
    if (!cfg) throw httpError(400, 'Invalid service type.');
    const orderId = cleanText(b.orderId, 30);
    if (!cfg.idRe.test(orderId)) throw httpError(400, 'Invalid order ID.');

    const o = (await getDb(cfg.db).ref(`${cfg.path}/${orderId}`).once('value')).val();
    if (!o) throw httpError(404, 'Order not found.');
    if (String(o.phone) !== phone) throw httpError(403, 'This order does not belong to your account.');

    const st = String(o.riderStatus || o.status || 'Pending');
    const assigned = (st === 'Accepted' || st === 'PickedUp');
    const d = o.details || {};
    const riderPhone = assigned ? String(o.riderPhone || '').replace(/[^0-9]/g, '').slice(-10) : '';

    res.json({
        status: 'success',
        riderStatus: st,
        riderName: assigned ? cleanText(o.riderName, 60) || null : null,
        riderPhone: PHONE_RE.test(riderPhone) ? riderPhone : null,
        vehicle: assigned ? (cleanText(o.riderVehicle || d.vehicle, 30) || 'Bike') : null,
        riderLat: assigned && o.riderLat ? Number(o.riderLat) : null,
        riderLng: assigned && o.riderLng ? Number(o.riderLng) : null,
        pickupLat: d.pickupLat || null, pickupLng: d.pickupLng || null,
        dropLat: d.dropLat || null, dropLng: d.dropLng || null
    });
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
// 10. ADMIN PANEL + RIDER APP ROUTES (404 হ্যান্ডলারের আগে)
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
// 11. ERROR HANDLING & START
// =========================================================================
app.use((req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ status: 'error', message: 'Invalid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ status: 'error', message: 'Request too large.' });
    if (err && err.message === 'Not allowed by CORS') return res.status(403).json({ status: 'error', message: 'Origin not allowed.' });
    const status = (err && err.status >= 400 && err.status < 600) ? err.status : 500;
    if (status >= 500) console.error('❌', err);
    res.status(status).json({ status: 'error', message: (status < 500 || (err && err.expose)) ? err.message : 'Internal server error.' });
});

process.on('unhandledRejection', r => console.error('⚠️ Unhandled rejection:', r));
process.on('uncaughtException', e => { console.error('💥 Uncaught exception:', e); process.exit(1); });

// লিসেনার চালু (Firebase কানেকশন তৈরির পর)
startZoneListener();
startMenuListeners();

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
    console.log('=================================');
    console.log(`✅ GMDS Secure Backend v${VERSION} running on port ${PORT} (COD only)`);
    console.log(`   Range ≤ ${MAX_RANGE_KM} km | Return charge > ${RETURN_THRESHOLD_KM} km (+${RETURN_CHARGE_RATE * 100}%)`);
    console.log(`   Zone-based slabs/extra/services/food-routes: ON | Fee tolerance ±${FEE_TOLERANCE}`);
    console.log(`   Offer + Combo pricing: ON (server-side) | Offer admin API: ${ADMIN_KEY_OK ? 'ON' : 'OFF (no ADMIN_KEY)'}`);
    console.log(`   Menu: live listener + RAM${redis ? ' + Redis backup' : ''}`);
    console.log('=================================');
});
// ধীর/ঝুলে থাকা কানেকশন দিয়ে সার্ভার আটকে দেওয়া (slowloris) বন্ধ
server.headersTimeout = 20 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 65 * 1000;
