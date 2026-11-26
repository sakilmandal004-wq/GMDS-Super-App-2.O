'use strict';

/* =========================================================================
   GMDS SECONDARY BACKUP, ZONE ADMIN, ZONE MANAGER, OFFER ADMIN & NTFY/TELEGRAM SERVER v3.4.0
   - Zone Admin API   (/api/zone-admin/list | save | delete)  <- Zone Manager panel
   - Offer Admin API  (/api/offer-admin/list | save-offer | save-combo | delete-combo)  <- Offer & Combo Manager panel   [NEW]
   - Public Offer API (GET /api/offers/active, POST /api/offers/quote)                  [NEW]
   - Zone Manager API (/api/manager/*)                         <- Manager panel
   - ntfy.sh instant push alerts (24/7, no customer phone numbers in alerts)
   - Telegram bot alerts + webhook, OneSignal customer push

   REQUIRED ENV : FIREBASE_SA_CORE, ADMIN_KEY (16+ chars)
   RECOMMENDED  : NTFY_TOPIC (16+ random chars), MANAGER_SECRET_TOKEN (16+),
                  TELEGRAM_WEBHOOK_SECRET (if Telegram is used)
   OPTIONAL     : NTFY_SERVER, NTFY_TOKEN, ZONE_PINS, FIREBASE_SA_RIDER,
                  TELEGRAM_BOT_TOKEN, TELEGRAM_ZONE_CHATS, TELEGRAM_DEFAULT_CHAT_ID,
                  ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY, PANEL_PUBLIC_URL,
                  ALLOWED_ORIGINS, MAX_RANGE_KM,
                  PRODUCTS_PATH (Firebase path of your products, default "products")   [NEW]
   ========================================================================= */

const express = require('express');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// -------------------------------------------------------------------------
// 1. CONFIGURATION
// -------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 5002;
const VERSION = '3.4.0';

// Zone Manager panel + Offer Manager panel key — must match the key typed in the panel
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_RANGE_KM = Number(process.env.MAX_RANGE_KM) || 11;

// Manager panel master token (zone PINs work without it)
const MANAGER_SECRET_TOKEN = process.env.MANAGER_SECRET_TOKEN || '';

// ntfy.sh — topic MUST come from env (anyone who knows the topic can read/post to it)
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const NTFY_TOKEN = process.env.NTFY_TOKEN || ''; // optional: for protected/self-hosted topics
const NTFY_ENABLED = /^[A-Za-z0-9_-]{16,64}$/.test(NTFY_TOPIC);

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PANEL_PUBLIC_URL = process.env.PANEL_PUBLIC_URL || 'https://gmds.app/manager-panel.html';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Where your products (and combos) live in the CORE Firebase Realtime Database
const PRODUCTS_PATH = (() => {
    const p = String(process.env.PRODUCTS_PATH || 'products').trim().replace(/^\/+|\/+$/g, '');
    return /^[A-Za-z0-9_\-\/]{1,100}$/.test(p) ? p : 'products';
})();

function parseJsonEnv(name) {
    try {
        return process.env[name] ? JSON.parse(process.env[name]) : {};
    } catch (e) {
        console.warn(`Invalid ${name} JSON — ignored`);
        return {};
    }
}

const ZONE_PINS = parseJsonEnv('ZONE_PINS');
const TELEGRAM_ZONE_CHATS = parseJsonEnv('TELEGRAM_ZONE_CHATS');

const ZONE_ALIASES = {
    'jon1': ['jon1', 'zone1', 'zone 1'],
    'jon2': ['jon2', 'zone2', 'zone 2', 'nazirpur'],
    'jon3': ['jon3', 'zone3', 'zone 3', 'mohishabathan'],
    'jon4': ['jon4', 'zone4', 'zone 4', 'thanapara', 'char'],
    'jon5': ['jon5', 'zone5', 'zone 5', 'karimpur'],
    'fazilnagar': ['fazilnagar', 'fazilnagore', 'farazipara']
};

const FIREBASE_SA_CORE = process.env.FIREBASE_SA_CORE || '';
const FIREBASE_SA_RIDER = process.env.FIREBASE_SA_RIDER || '';

const CORE_DB_URL = 'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app';
const RIDER_DB_URL = 'https://gmds-rider-default-rtdb.firebaseio.com';

if (!FIREBASE_SA_CORE) {
    console.error('FATAL: FIREBASE_SA_CORE is required.');
    process.exit(1);
}
if (ADMIN_KEY.length < 16) {
    console.warn('⚠️ ADMIN_KEY missing or shorter than 16 chars — /api/zone-admin/*, /api/offer-admin/* and /api/test-ntfy are DISABLED.');
}
if (MANAGER_SECRET_TOKEN.length < 16) {
    console.warn('⚠️ MANAGER_SECRET_TOKEN missing/short — master manager token disabled (zone PINs still work).');
}
if (!NTFY_ENABLED) {
    console.warn('⚠️ NTFY_TOPIC missing or invalid (need 16-64 chars: letters, digits, _ or -) — ntfy alerts DISABLED.');
}
if (TELEGRAM_BOT_TOKEN && !TELEGRAM_WEBHOOK_SECRET) {
    console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET not set — Telegram webhook is NOT authenticated.');
}

// Outbound HTTP helper with timeout so a slow third party can never hang the server
function timedFetch(url, options = {}, ms = 8000) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// -------------------------------------------------------------------------
// 2. SECURITY HEADERS, CORS, LIMITS
// -------------------------------------------------------------------------

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
});

app.use(cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'x-admin-key',
        'x-manager-token',
        'x-manager-zone',
        'x-backup-signature'
    ],
    maxAge: 600
}));

app.use(express.json({ limit: '100kb', strict: true }));

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ status: 'error', message: 'Invalid JSON body.' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ status: 'error', message: 'Request too large.' });
    }
    next(err);
});

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', message: 'Request limit exceeded.' }
}));

// Brute-force guard: only FAILED auth attempts count
const failedAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many failed attempts. Try again later.' }
});

// Cap on test notifications (phone-spam protection even for the admin)
const testNtfyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many test notifications. Try again later.' }
});

// -------------------------------------------------------------------------
// 3. FIREBASE
// -------------------------------------------------------------------------

function parseSA(raw) {
    const t = raw.trim();
    return t.startsWith('{') ? JSON.parse(t) : JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
}

let backupDb = null;
let riderDb = null;

try {
    const coreApp = admin.initializeApp({
        credential: admin.credential.cert(parseSA(FIREBASE_SA_CORE)),
        databaseURL: CORE_DB_URL
    }, 'gmdsRecoveryReplica');
    backupDb = coreApp.database();
    console.log('✅ Core Firebase initialized.');

    if (FIREBASE_SA_RIDER) {
        const rApp = admin.initializeApp({
            credential: admin.credential.cert(parseSA(FIREBASE_SA_RIDER)),
            databaseURL: RIDER_DB_URL
        }, 'gmdsRiderReplica');
        riderDb = rApp.database();
        console.log('✅ Rider Firebase initialized.');
    }
} catch (error) {
    console.error('Firebase initialization failed:', error.message);
    process.exit(1);
}

// -------------------------------------------------------------------------
// 4. ZONE MODEL (shared by Zone Admin + order matching)
// -------------------------------------------------------------------------

const ZONES_PATH = 'gmds_zones';
const SERVICE_KEYS = ['food', 'bike', 'toto', 'parcel', 'house', 'seba'];
const VEHICLE_KEYS = ['bike', 'toto', 'parcel'];
const DEFAULT_SLABS = [12, 15, 17, 20, 23, 25];

function asArray(v) {
    if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined);
    if (v && typeof v === 'object') return Object.values(v);
    return [];
}

function normalizeZone(id, z) {
    if (!z || typeof z !== 'object') return null;
    const polygon = asArray(z.polygon)
        .map(p => ({ lat: Number(p && p.lat), lng: Number(p && p.lng) }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    const slabsRaw = asArray(z.slabs).map(Number);
    const slabs = slabsRaw.length === 6 && slabsRaw.every(Number.isFinite) ? slabsRaw : DEFAULT_SLABS.slice();

    const sv = z.services || {};
    const services = {};
    SERVICE_KEYS.forEach(k => { services[k] = sv[k] !== false; });

    const vf = z.vehicle_fees || {};
    const vehicle_fees = {};
    VEHICLE_KEYS.forEach(k => {
        const x = vf[k] || {};
        vehicle_fees[k] = {
            extra: Number.isFinite(Number(x.extra)) ? Number(x.extra) : 0,
            per_km: Number.isFinite(Number(x.per_km)) ? Number(x.per_km) : 0
        };
    });

    return {
        id: String(id),
        zone_name: String(z.zone_name || id),
        active: z.active !== false,
        polygon,
        extra_fee: Number.isFinite(Number(z.extra_fee)) ? Number(z.extra_fee) : 0,
        per_km: Number.isFinite(Number(z.per_km)) ? Number(z.per_km) : 1.3,
        slabs,
        services,
        vehicle_fees,
        food_rules: z.food_rules === true,
        food_to: asArray(z.food_to).map(String),
        createdAt: Number(z.createdAt) || 0,
        updatedAt: Number(z.updatedAt) || 0
    };
}

function normalizeZonesMap(val) {
    const out = [];
    Object.keys(val || {}).forEach(k => {
        const z = normalizeZone(k, val[k]);
        if (z) out.push(z);
    });
    out.sort((a, b) => (a.createdAt - b.createdAt) || a.zone_name.localeCompare(b.zone_name));
    return out;
}

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

function polygonArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        a += (poly[j].lng * poly[i].lat) - (poly[i].lng * poly[j].lat);
    }
    return Math.abs(a / 2);
}

// Live in-memory cache (used for order -> zone detection)
let zonesCache = [];
backupDb.ref(ZONES_PATH).on('value', snap => {
    zonesCache = normalizeZonesMap(snap.val());
}, err => console.error('Zones listener error:', err.message));

function num(v, min, max, label) {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) {
        throw new Error(`${label} must be a valid number.`);
    }
    if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    return Math.round(n * 100) / 100;
}

function validateZonePayload(body, existing, selfId) {
    const b = body || {};

    const zone_name = String(b.zone_name || '').trim().replace(/\s+/g, ' ');
    if (!zone_name) throw new Error('Zone name is required.');
    if (zone_name.length > 60) throw new Error('Zone name is too long (max 60).');
    const dup = existing.find(z => z.id !== selfId && z.zone_name.toLowerCase() === zone_name.toLowerCase());
    if (dup) throw new Error(`A zone named "${zone_name}" already exists.`);

    let polygon = asArray(b.polygon).map(p => ({
        lat: Number(p && p.lat), lng: Number(p && p.lng)
    }));
    if (polygon.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) ||
        Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)) {
        throw new Error('Polygon has invalid coordinates.');
    }
    polygon = polygon.map(p => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) }));
    if (polygon.length > 1) {
        const f = polygon[0], l = polygon[polygon.length - 1];
        if (f.lat === l.lat && f.lng === l.lng) polygon.pop();
    }
    if (polygon.length < 3) throw new Error('Polygon must have at least 3 vertices.');
    if (polygon.length > 200) throw new Error('Polygon has too many vertices (max 200).');
    if (polygonArea(polygon) < 1e-9) throw new Error('Polygon area is too small / degenerate.');

    const extra_fee = num(b.extra_fee, -50, 200, 'Food extra fee');
    const per_km = num(b.per_km, 0, 50, 'Food per-km rate');

    const slabsIn = asArray(b.slabs);
    if (slabsIn.length !== 6) throw new Error('Exactly 6 distance slabs are required.');
    const slabs = slabsIn.map((s, i) => num(s, 10, 500, `Slab ${i + 1}`));
    for (let i = 1; i < slabs.length; i++) {
        if (slabs[i] < slabs[i - 1]) throw new Error('Slabs must be non-decreasing.');
    }

    const sv = b.services || {};
    const services = {};
    SERVICE_KEYS.forEach(k => { services[k] = sv[k] !== false; });

    const vf = b.vehicle_fees || {};
    const vehicle_fees = {};
    VEHICLE_KEYS.forEach(k => {
        const x = vf[k] || {};
        vehicle_fees[k] = {
            extra: num(x.extra === undefined ? 0 : x.extra, -50, 200, `${k} extra fee`),
            per_km: num(x.per_km === undefined ? 0 : x.per_km, 0, 50, `${k} per-km rate`)
        };
    });

    const food_rules = b.food_rules === true;
    let food_to = [];
    if (food_rules) {
        const valid = new Set(existing.filter(z => z.id !== selfId).map(z => z.id));
        food_to = [...new Set(asArray(b.food_to).map(String))].filter(id => valid.has(id));
    }

    return {
        zone_name,
        active: b.active !== false,
        polygon,
        extra_fee,
        per_km,
        slabs,
        services,
        vehicle_fees,
        food_rules,
        food_to,
        min_fare: 10 // legacy field read by /api/manager/zones
    };
}

// Serialize admin writes (prevents lost updates between simultaneous saves)
let adminQueue = Promise.resolve();
function withAdminLock(fn) {
    const run = adminQueue.then(fn, fn);
    adminQueue = run.catch(() => {});
    return run;
}

// -------------------------------------------------------------------------
// 5. ONESIGNAL (customer push)
// -------------------------------------------------------------------------

async function sendOneSignalPushByOrderId(targetPhoneOrId, title, message, orderId) {
    if (!ONESIGNAL_REST_API_KEY || !ONESIGNAL_APP_ID) return;

    const payload = {
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [String(targetPhoneOrId)] },
        target_channel: 'push',
        headings: { en: title },
        contents: { en: message },
        data: { orderId: String(orderId) }
    };
    try {
        const response = await timedFetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        console.log(`[ONESIGNAL PUSH] Order #${orderId}:`, JSON.stringify(result));
    } catch (e) {
        console.error('OneSignal notification error:', e.message);
    }
}

// -------------------------------------------------------------------------
// 6. AUTH + ORDER/ZONE MATCHING
// -------------------------------------------------------------------------

function safeSecretEqual(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
    const a = crypto.createHash('sha256').update(received).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

// Zone Manager panel + Offer Manager panel -> x-admin-key
function verifyAdminKey(req, res, next) {
    if (ADMIN_KEY.length < 16) {
        return res.status(503).json({ status: 'error', message: 'Admin is not configured on the server (ADMIN_KEY).' });
    }
    if (!safeSecretEqual(req.get('x-admin-key') || '', ADMIN_KEY)) {
        return res.status(401).json({ status: 'error', message: 'Invalid admin key.' });
    }
    next();
}

// Manager panel -> x-manager-token (+ zone)
function resolveManagerAuth(req) {
    const token = req.get('x-manager-token') || '';
    const requestedZone = String(req.query.zone || req.get('x-manager-zone') || (req.body && req.body.zone) || '').trim();
    const zonePin = ZONE_PINS[requestedZone] || ZONE_PINS[requestedZone.toLowerCase()];
    const isMaster = MANAGER_SECRET_TOKEN.length >= 16 && safeSecretEqual(token, MANAGER_SECRET_TOKEN);
    const isZone = zonePin ? safeSecretEqual(token, String(zonePin)) : false;
    return { ok: isMaster || isZone, isMaster, zone: requestedZone };
}

function verifyManagerToken(req, res, next) {
    const auth = resolveManagerAuth(req);
    if (!auth.ok) return res.status(401).json({ status: 'error', message: 'Unauthorized Zone PIN/Token.' });
    req.managerAuth = auth;
    next();
}

function getOrderCoords(o) {
    const d = o.details || {};
    const loc = o.location || {};
    const pairs = [
        [o.lat, o.lng], [o.latitude, o.longitude],
        [loc.lat, loc.lng], [loc.latitude, loc.longitude],
        [d.pickupLat, d.pickupLng], [d.lat, d.lng]
    ];
    for (const [la, ln] of pairs) {
        if (la !== undefined && la !== null && ln !== undefined && ln !== null &&
            Number.isFinite(Number(la)) && Number.isFinite(Number(ln))) {
            return { lat: Number(la), lng: Number(ln) };
        }
    }
    return null;
}

function findZoneByPoint(lat, lng) {
    return zonesCache.find(z => z.active && pointInPolygon(lat, lng, z.polygon)) || null;
}

function detectOrderZoneCode(order) {
    const d = order.details || {};
    const directZone = String(order.serviceZone || d.zone || '').trim();
    if (directZone) return directZone;

    const c = getOrderCoords(order);
    if (c) {
        const z = findZoneByPoint(c.lat, c.lng);
        if (z) return z.zone_name;
    }

    const addressStr = String(order.address || d.pickup || '').toLowerCase();
    for (const [zoneCode, aliases] of Object.entries(ZONE_ALIASES)) {
        if (aliases.some(a => addressStr.includes(a))) {
            return zoneCode.charAt(0).toUpperCase() + zoneCode.slice(1);
        }
    }
    return 'Unassigned';
}

function doesOrderMatchZone(order, requestedZone) {
    const reqKey = String(requestedZone || '').toLowerCase().trim();
    if (!reqKey || reqKey === 'all') return true;

    const d = order.details || {};
    const orderZone = String(order.serviceZone || d.zone || '').toLowerCase().trim();
    const addressStr = String(order.address || d.pickup || '').toLowerCase();

    // The requested key may be a zone id OR a zone name
    const zoneDef = zonesCache.find(z => z.id.toLowerCase() === reqKey || z.zone_name.toLowerCase() === reqKey);
    const keys = new Set([reqKey]);
    if (zoneDef) { keys.add(zoneDef.id.toLowerCase()); keys.add(zoneDef.zone_name.toLowerCase()); }

    if (orderZone && keys.has(orderZone)) return true;

    if (zoneDef && zoneDef.polygon.length >= 3) {
        const c = getOrderCoords(order);
        if (c && pointInPolygon(c.lat, c.lng, zoneDef.polygon)) return true;
    }

    const aliasSet = new Set();
    keys.forEach(k => (ZONE_ALIASES[k] || [k]).forEach(a => aliasSet.add(a)));
    for (const alias of aliasSet) {
        if (orderZone === alias) return true;
        if (!orderZone && alias.length >= 4 && addressStr.includes(alias)) return true;
    }
    return false;
}

// -------------------------------------------------------------------------
// 7. ZONE ADMIN API (used by the Zone Manager panel)
// -------------------------------------------------------------------------

const zoneAdminRouter = express.Router();
zoneAdminRouter.use(failedAuthLimiter, verifyAdminKey);

zoneAdminRouter.post('/list', async (req, res) => {
    try {
        const snap = await backupDb.ref(ZONES_PATH).once('value');
        res.json({
            status: 'success',
            maxRangeKm: MAX_RANGE_KM,
            zones: normalizeZonesMap(snap.val())
        });
    } catch (err) {
        console.error('Zone list failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to load zones.' });
    }
});

zoneAdminRouter.post('/save', (req, res) => {
    withAdminLock(async () => {
        const snap = await backupDb.ref(ZONES_PATH).once('value');
        const existing = normalizeZonesMap(snap.val());

        const incomingId = req.body && req.body.id ? String(req.body.id) : null;
        if (incomingId && !/^[A-Za-z0-9_-]{1,64}$/.test(incomingId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid zone id.' });
        }
        const current = incomingId ? existing.find(z => z.id === incomingId) : null;
        if (incomingId && !current) {
            return res.status(404).json({ status: 'error', message: 'Zone not found. Sync zones and try again.' });
        }

        let clean;
        try {
            clean = validateZonePayload(req.body, existing, incomingId);
        } catch (e) {
            return res.status(400).json({ status: 'error', message: e.message });
        }

        const id = incomingId || backupDb.ref(ZONES_PATH).push().key;
        const now = Date.now();
        const record = {
            ...clean,
            createdAt: current && current.createdAt ? current.createdAt : now,
            updatedAt: now
        };
        if (!record.food_to.length) delete record.food_to; // RTDB cannot store empty arrays

        await backupDb.ref(`${ZONES_PATH}/${id}`).set(record);

        const verify = await backupDb.ref(`${ZONES_PATH}/${id}`).once('value');
        if (!verify.exists()) throw new Error('Write verification failed.');

        console.log(`[ZONE ADMIN] ${incomingId ? 'Updated' : 'Created'} zone ${id} "${clean.zone_name}"`);
        res.json({ status: 'success', id, message: 'Zone saved.', zone: normalizeZone(id, verify.val()) });
    }).catch(err => {
        console.error('Zone save failed:', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Failed to save zone.' });
    });
});

zoneAdminRouter.post('/delete', (req, res) => {
    withAdminLock(async () => {
        const id = req.body && req.body.id ? String(req.body.id) : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            return res.status(400).json({ status: 'error', message: 'Valid zone id is required.' });
        }

        const snap = await backupDb.ref(ZONES_PATH).once('value');
        const all = snap.val() || {};
        if (!all[id]) {
            return res.status(404).json({ status: 'error', message: 'Zone not found.' });
        }

        // Atomic: delete zone + scrub it from other zones' food_to
        const updates = { [`${ZONES_PATH}/${id}`]: null };
        Object.keys(all).forEach(otherId => {
            if (otherId === id) return;
            const targets = asArray(all[otherId] && all[otherId].food_to).map(String);
            if (targets.includes(id)) {
                const left = targets.filter(t => t !== id);
                updates[`${ZONES_PATH}/${otherId}/food_to`] = left.length ? left : null;
            }
        });
        await backupDb.ref().update(updates);

        console.log(`[ZONE ADMIN] Deleted zone ${id}`);
        res.json({ status: 'success', message: 'Zone deleted.' });
    }).catch(err => {
        console.error('Zone delete failed:', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Failed to delete zone.' });
    });
});

app.use('/api/zone-admin', zoneAdminRouter);

// Public, read-only: is this point inside an active zone? (customer apps)
app.get('/api/zone-check', (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ status: 'error', message: 'Valid lat & lng are required.' });
    }
    const z = findZoneByPoint(lat, lng);
    if (!z) return res.json({ status: 'success', inZone: false });
    res.json({
        status: 'success',
        inZone: true,
        zone: { id: z.id, zone_name: z.zone_name, extra_fee: z.extra_fee, services: z.services }
    });
});

// -------------------------------------------------------------------------
// 7B. OFFER & COMBO ADMIN API (used by the Offer & Combo Manager panel)   [NEW]
//
//  Product record (in PRODUCTS_PATH/<id>) — fields read tolerantly:
//    name | title | item_name        hotel | hotelName | restaurant | shop | shopName | vendor
//    price | sellingPrice            stock | qty         image | img | imageUrl
//    description | desc              is_combo, mrp, combo_items [{id, qty}]
//    offer { active, tiers:[{minCart, price}], maxQty, start, end, terms }
// -------------------------------------------------------------------------

function pickStr(...vals) {
    for (const v of vals) {
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}

function pickNum(def, ...vals) {
    for (const v of vals) {
        if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return def;
}

function normalizeOffer(o) {
    if (!o || typeof o !== 'object') return null;
    const tiers = asArray(o.tiers)
        .map(t => ({ minCart: Number(t && t.minCart), price: Number(t && t.price) }))
        .filter(t => Number.isFinite(t.minCart) && Number.isFinite(t.price))
        .sort((a, b) => a.minCart - b.minCart);
    if (!tiers.length) return null;
    const mq = Number(o.maxQty);
    return {
        active: o.active !== false,
        tiers,
        maxQty: Number.isInteger(mq) && mq >= 1 && mq <= 99 ? mq : 99,
        start: Number(o.start) > 0 ? Number(o.start) : null,
        end: Number(o.end) > 0 ? Number(o.end) : null,
        terms: String(o.terms || '').slice(0, 200)
    };
}

function normalizeProduct(id, p) {
    if (!p || typeof p !== 'object') return null;
    const name = pickStr(p.name, p.title, p.item_name);
    if (!name) return null;
    const isCombo = p.is_combo === true;
    const price = pickNum(0, p.price, p.sellingPrice, p.sale_price);
    return {
        id: String(id),
        name,
        hotel: pickStr(p.hotel, p.hotelName, p.hotel_name, p.restaurant, p.shop, p.shopName, p.vendor),
        price,
        stock: pickNum(99, p.stock, p.qty),
        image: pickStr(p.image, p.img, p.imageUrl),
        description: pickStr(p.description, p.desc),
        is_combo: isCombo,
        mrp: isCombo ? pickNum(price, p.mrp) : price,
        combo_items: isCombo
            ? asArray(p.combo_items)
                .map(ci => ({ id: String((ci && ci.id) || ''), qty: Number(ci && ci.qty) || 1 }))
                .filter(ci => ci.id)
            : [],
        offer: normalizeOffer(p.offer)
    };
}

function normalizeProductsMap(val) {
    const out = [];
    Object.keys(val || {}).forEach(k => {
        const p = normalizeProduct(k, val[k]);
        if (p) out.push(p);
    });
    out.sort((a, b) => a.hotel.localeCompare(b.hotel) || a.name.localeCompare(b.name));
    return out;
}

async function loadProducts() {
    const snap = await backupDb.ref(PRODUCTS_PATH).once('value');
    return normalizeProductsMap(snap.val());
}

function isOfferLive(o, now = Date.now()) {
    if (!o || !o.active) return false;
    if (o.start && o.start > now) return false;
    if (o.end && o.end <= now) return false;
    return true;
}

function offerPriceFor(offer, base, cart) {
    let best = base;
    offer.tiers.forEach(t => { if (cart >= t.minCart && t.price < best) best = t.price; });
    return best;
}

const PRODUCT_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

// Same rules as the panel, enforced again on the server (never trust the browser)
function validateOfferPayload(offer, base) {
    if (!offer || typeof offer !== 'object') throw new Error('Offer data is required.');
    const raw = asArray(offer.tiers);
    if (!raw.length) throw new Error('At least 1 tier is required.');
    if (raw.length > 6) throw new Error('Maximum 6 tiers allowed.');

    const seen = new Set();
    const tiers = raw.map((t, i) => {
        const minCart = num(t && t.minCart, 0, 5000, `Tier ${i + 1} minimum order`);
        const price = num(t && t.price, 1, 100000, `Tier ${i + 1} offer price`);
        if (price >= base) throw new Error(`Tier ${i + 1}: offer price (${price}) must be lower than the original price (${base}).`);
        const m = Math.round(minCart);
        if (seen.has(m)) throw new Error('Two tiers have the same minimum order.');
        seen.add(m);
        return { minCart: m, price };
    }).sort((a, b) => a.minCart - b.minCart);

    for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].price > tiers[i - 1].price) {
            throw new Error('A higher-order tier cannot have a higher price than a lower tier.');
        }
    }

    let maxQty = 99;
    if (offer.maxQty !== undefined && offer.maxQty !== null && offer.maxQty !== '') {
        maxQty = Number(offer.maxQty);
        if (!Number.isInteger(maxQty) || maxQty < 1 || maxQty > 99) throw new Error('Max quantity must be 1 to 99.');
    }

    const start = offer.start === null || offer.start === undefined || offer.start === '' ? null : Number(offer.start);
    const end = offer.end === null || offer.end === undefined || offer.end === '' ? null : Number(offer.end);
    if (start !== null && (!Number.isFinite(start) || start <= 0)) throw new Error('Invalid start time.');
    if (end !== null && (!Number.isFinite(end) || end <= 0)) throw new Error('Invalid end time.');
    if (start !== null && end !== null && end <= start) throw new Error('End time must be after start time.');

    const terms = String(offer.terms || '').trim();
    if (terms.length > 200) throw new Error('Terms are too long (max 200).');

    const clean = { active: offer.active !== false, tiers, maxQty, terms, updatedAt: Date.now() };
    if (start !== null) clean.start = start;
    if (end !== null) clean.end = end;
    return clean;
}

function isHttpsUrl(u) {
    try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
}

function validateComboPayload(body, all, existingCombo) {
    const b = body || {};

    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Combo name is required.');
    if (name.length > 80) throw new Error('Combo name is too long (max 80).');

    const rawItems = asArray(b.items);
    if (!rawItems.length) throw new Error('Select at least 1 item.');
    if (rawItems.length > 20) throw new Error('Too many items in a combo (max 20).');

    const byId = new Map(all.map(p => [p.id, p]));
    const seen = new Set();
    const items = [];
    let mrp = 0;
    let hotel = null;
    let firstImage = '';

    rawItems.forEach(it => {
        const id = String((it && it.id) || '');
        if (!PRODUCT_ID_RE.test(id)) throw new Error('Invalid item id in combo.');
        if (seen.has(id)) throw new Error('The same item appears twice in the combo.');
        seen.add(id);

        const qty = Number(it && it.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new Error('Item quantity must be 1 to 10.');

        const p = byId.get(id);
        if (!p) throw new Error('A selected item no longer exists. Refresh and try again.');
        if (p.is_combo) throw new Error('A combo cannot contain another combo.');
        if (!p.hotel) throw new Error(`Item "${p.name}" has no hotel set.`);
        if (hotel === null) hotel = p.hotel;
        else if (hotel !== p.hotel) throw new Error('All combo items must be from the same hotel.');
        if (!firstImage && p.image) firstImage = p.image;

        mrp += p.price * qty;
        items.push({ id, qty });
    });

    if (existingCombo && existingCombo.hotel && existingCombo.hotel !== hotel) {
        throw new Error('A combo cannot be moved to a different hotel.');
    }

    mrp = Math.round(mrp * 100) / 100;
    const price = num(b.price, 1, 100000, 'Combo price');
    if (price >= mrp) throw new Error(`Combo price (${price}) must be lower than total price (${mrp}).`);

    const stockN = Number(b.stock);
    if (!Number.isInteger(stockN) || stockN < 0 || stockN > 999) throw new Error('Stock must be a whole number from 0 to 999.');

    let image = String(b.image || '').trim();
    if (image) {
        if (image.length > 500 || !isHttpsUrl(image)) throw new Error('Image link must be a valid https:// URL.');
    } else {
        image = firstImage;
    }

    const description = String(b.description || '').trim();
    if (description.length > 200) throw new Error('Description is too long (max 200).');

    return {
        name, hotel, price, mrp, stock: stockN, image, description,
        is_combo: true, combo_items: items
    };
}

const offerAdminRouter = express.Router();
offerAdminRouter.use(failedAuthLimiter, verifyAdminKey);

offerAdminRouter.post('/list', async (req, res) => {
    try {
        res.json({ status: 'success', products: await loadProducts() });
    } catch (err) {
        console.error('Offer list failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to load products.' });
    }
});

offerAdminRouter.post('/save-offer', (req, res) => {
    withAdminLock(async () => {
        const id = String((req.body && req.body.id) || '');
        if (!PRODUCT_ID_RE.test(id)) {
            return res.status(400).json({ status: 'error', message: 'Valid product id is required.' });
        }

        const ref = backupDb.ref(`${PRODUCTS_PATH}/${id}`);
        const snap = await ref.once('value');
        const product = normalizeProduct(id, snap.val());
        if (!product) {
            return res.status(404).json({ status: 'error', message: 'Product not found. Refresh and try again.' });
        }

        // offer === null  ->  remove the offer
        if (req.body.offer === null) {
            await ref.child('offer').remove();
            console.log(`[OFFER ADMIN] Removed offer from ${id} "${product.name}"`);
            return res.json({ status: 'success', message: 'Offer removed.' });
        }

        let clean;
        try {
            clean = validateOfferPayload(req.body.offer, product.price);
        } catch (e) {
            return res.status(400).json({ status: 'error', message: e.message });
        }

        await ref.child('offer').set(clean);
        const verify = await ref.child('offer').once('value');
        if (!verify.exists()) throw new Error('Write verification failed.');

        console.log(`[OFFER ADMIN] Saved offer on ${id} "${product.name}"`);
        res.json({ status: 'success', message: 'Offer saved.', offer: normalizeOffer(verify.val()) });
    }).catch(err => {
        console.error('Offer save failed:', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Failed to save offer.' });
    });
});

offerAdminRouter.post('/save-combo', (req, res) => {
    withAdminLock(async () => {
        const incomingId = req.body && req.body.id ? String(req.body.id) : null;
        if (incomingId && !PRODUCT_ID_RE.test(incomingId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid combo id.' });
        }

        const all = await loadProducts();
        const current = incomingId ? all.find(p => p.id === incomingId) : null;
        if (incomingId && (!current || !current.is_combo)) {
            return res.status(404).json({ status: 'error', message: 'Combo not found. Refresh and try again.' });
        }

        let clean;
        try {
            clean = validateComboPayload(req.body, all, current);
        } catch (e) {
            return res.status(400).json({ status: 'error', message: e.message });
        }

        const now = Date.now();
        let id = incomingId;
        if (incomingId) {
            // update only combo fields; keep any existing offer and other custom fields
            await backupDb.ref(`${PRODUCTS_PATH}/${incomingId}`).update({ ...clean, updatedAt: now });
        } else {
            id = backupDb.ref(PRODUCTS_PATH).push().key;
            await backupDb.ref(`${PRODUCTS_PATH}/${id}`).set({ ...clean, createdAt: now, updatedAt: now });
        }

        const verify = await backupDb.ref(`${PRODUCTS_PATH}/${id}`).once('value');
        if (!verify.exists()) throw new Error('Write verification failed.');

        console.log(`[OFFER ADMIN] ${incomingId ? 'Updated' : 'Created'} combo ${id} "${clean.name}"`);
        res.json({ status: 'success', id, message: 'Combo saved.', product: normalizeProduct(id, verify.val()) });
    }).catch(err => {
        console.error('Combo save failed:', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Failed to save combo.' });
    });
});

offerAdminRouter.post('/delete-combo', (req, res) => {
    withAdminLock(async () => {
        const id = String((req.body && req.body.id) || '');
        if (!PRODUCT_ID_RE.test(id)) {
            return res.status(400).json({ status: 'error', message: 'Valid combo id is required.' });
        }
        const ref = backupDb.ref(`${PRODUCTS_PATH}/${id}`);
        const snap = await ref.once('value');
        const product = normalizeProduct(id, snap.val());
        if (!product) return res.status(404).json({ status: 'error', message: 'Combo not found.' });
        if (!product.is_combo) {
            return res.status(400).json({ status: 'error', message: 'Only combos can be deleted from here.' });
        }
        await ref.remove();
        console.log(`[OFFER ADMIN] Deleted combo ${id} "${product.name}"`);
        res.json({ status: 'success', message: 'Combo deleted.' });
    }).catch(err => {
        console.error('Combo delete failed:', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Failed to delete combo.' });
    });
});

app.use('/api/offer-admin', offerAdminRouter);

// ---- Public, read-only offer endpoints (customer apps) ----

// All products that currently have a LIVE offer
app.get('/api/offers/active', async (req, res) => {
    try {
        const now = Date.now();
        const products = (await loadProducts())
            .filter(p => isOfferLive(p.offer, now) && p.stock > 0)
            .map(p => ({
                id: p.id, name: p.name, hotel: p.hotel, price: p.price, image: p.image,
                is_combo: p.is_combo, mrp: p.mrp, offer: p.offer
            }));
        res.json({ status: 'success', count: products.length, products });
    } catch (err) {
        console.error('Active offers failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to load offers.' });
    }
});

// Server-side price calculation for a cart: { items: [{ id, qty }] }
// Cart value for tiers = total of items WITHOUT a live offer (delivery fee not counted).
// Offer price applies to the first `maxQty` units; extra units are charged at the original price.
app.post('/api/offers/quote', async (req, res) => {
    try {
        const rawItems = asArray(req.body && req.body.items);
        if (!rawItems.length || rawItems.length > 50) {
            return res.status(400).json({ status: 'error', message: 'Cart must have 1 to 50 items.' });
        }

        const merged = new Map();
        for (const it of rawItems) {
            const id = String((it && it.id) || '');
            const qty = Number(it && it.qty);
            if (!PRODUCT_ID_RE.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 99) {
                return res.status(400).json({ status: 'error', message: 'Invalid item or quantity.' });
            }
            merged.set(id, Math.min(99, (merged.get(id) || 0) + qty));
        }

        const ids = [...merged.keys()];
        const snaps = await Promise.all(ids.map(id => backupDb.ref(`${PRODUCTS_PATH}/${id}`).once('value')));
        const now = Date.now();

        const lines = [];
        for (let i = 0; i < ids.length; i++) {
            const p = normalizeProduct(ids[i], snaps[i].val());
            if (!p) {
                return res.status(404).json({ status: 'error', message: `Item ${ids[i]} not found.` });
            }
            lines.push({ p, qty: merged.get(ids[i]), live: isOfferLive(p.offer, now) });
        }

        const cartBase = lines.filter(l => !l.live).reduce((s, l) => s + l.p.price * l.qty, 0);

        let subtotal = 0;
        const out = lines.map(l => {
            const base = l.p.price;
            let unit = base, offerQty = 0;
            if (l.live) {
                unit = offerPriceFor(l.p.offer, base, cartBase);
                if (unit < base) offerQty = Math.min(l.qty, l.p.offer.maxQty);
            }
            const total = Math.round((unit * offerQty + base * (l.qty - offerQty)) * 100) / 100;
            subtotal += total;
            return {
                id: l.p.id, name: l.p.name, qty: l.qty,
                originalPrice: base, offerPrice: offerQty ? unit : null, offerQty,
                lineTotal: total, inStock: l.p.stock >= l.qty
            };
        });

        res.json({
            status: 'success',
            cartBase: Math.round(cartBase * 100) / 100,
            subtotal: Math.round(subtotal * 100) / 100,
            lines: out
        });
    } catch (err) {
        console.error('Quote failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to calculate price.' });
    }
});

// -------------------------------------------------------------------------
// 8. NTFY.SH + TELEGRAM (24/7 ORDER ALERTS)
// -------------------------------------------------------------------------

const notifiedOrders = new Set();
function markNotified(id) {
    notifiedOrders.add(id);
    if (notifiedOrders.size > 5000) {
        const it = notifiedOrders.values();
        for (let i = 0; i < 1000; i++) notifiedOrders.delete(it.next().value);
    }
}

function esc(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_CODES = { A: 'Accepted', P: 'PickedUp', D: 'Delivered' };
const STATUS_RE = /^[A-Za-z][A-Za-z ]{1,29}$/;

function chatForZone(zoneName) {
    let chatId = TELEGRAM_ZONE_CHATS[zoneName] || TELEGRAM_ZONE_CHATS[String(zoneName).toLowerCase()];
    if (!chatId) {
        const k = Object.keys(TELEGRAM_ZONE_CHATS).find(x => x.toLowerCase() === String(zoneName).toLowerCase());
        if (k) chatId = TELEGRAM_ZONE_CHATS[k];
    }
    return chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID || '';
}

// HTTP header values must be plain ASCII/one line
function headerSafe(s, max = 80) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/[^\x20-\x7E]/g, '').replace(/[\r\n]/g, ' ').slice(0, max).trim();
}

// ntfy phone alert. Customer phone number is intentionally NOT included
// (ntfy.sh is a third-party server) — open the panel for full details.
async function sendNtfyOrderAlert(order, fallbackId = '') {
    if (!NTFY_ENABLED) return false;

    const oId = String(order.orderId || order.id || fallbackId);
    const d = order.details || {};
    const zoneName = detectOrderZoneCode(order);
    const total = order.grandTotal || d.totalFare || order.price || 0;
    const serviceType = d.type || order.type || order.service || 'Order';
    const payMode = order.payMode || 'COD';

    const message =
        `জোন: ${String(zoneName).toUpperCase()} | সার্ভিস: ${serviceType}\n` +
        `মোট বিল: ₹${total} (${payMode})\n` +
        `বিস্তারিত দেখতে ম্যানেজার প্যানেল খুলুন।`;

    const headers = {
        'Title': `New GMDS Order ${headerSafe(oId, 40)}`,
        'Priority': 'high',
        'Tags': 'shopping_cart,loudspeaker',
        'Click': headerSafe(`${PANEL_PUBLIC_URL}?zone=${encodeURIComponent(zoneName)}&orderId=${encodeURIComponent(oId)}`, 400)
    };
    if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;

    try {
        const r = await timedFetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
            method: 'POST',
            headers,
            body: message
        });
        if (r.ok) {
            console.log(`🔔 [NTFY SENT] Order #${oId}`);
            return true;
        }
        console.error('ntfy push failed:', r.status);
    } catch (e) {
        console.error('ntfy notification error:', e.message);
    }
    return false;
}

async function sendTelegramZoneAlert(order, fallbackId = '') {
    if (!TELEGRAM_BOT_TOKEN) return;

    const oId = String(order.orderId || order.id || fallbackId);
    const d = order.details || {};
    const zoneName = detectOrderZoneCode(order);
    const chatId = chatForZone(zoneName);
    if (!chatId) return;

    const total = order.grandTotal || d.totalFare || order.price || 0;
    const subtotal = order.subtotal !== undefined ? `₹${order.subtotal}` : 'N/A';
    const delFee = order.deliveryFee !== undefined ? `₹${order.deliveryFee}` : 'Included';
    const custName = order.user || order.customer || 'Customer';
    const custPhone = order.phone || 'N/A';
    const addr = order.address || d.pickup || order.service || 'N/A';

    let itemsSummary = '';
    if (Array.isArray(order.items) && order.items.length > 0) {
        itemsSummary = `🛒 <b>Items:</b> ${order.items.map(i => `${esc(i.name)} (x${esc(i.qty)})`).join(', ')}\n`;
    } else if (d.type) {
        itemsSummary = `🛵 <b>Booking:</b> ${esc(d.type)} (${esc(d.distance || '')})\n🔴 <b>Drop:</b> ${esc(d.drop || 'N/A')}\n`;
    }

    const panelLink = `${PANEL_PUBLIC_URL}?zone=${encodeURIComponent(zoneName)}&orderId=${encodeURIComponent(oId)}`;

    const text =
        `🚨 <b>NEW ORDER IN [${esc(String(zoneName).toUpperCase())}]</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 <b>Order ID:</b> <code>#${esc(oId)}</code>\n` +
        `👤 <b>Customer:</b> ${esc(custName)}\n` +
        `📞 <b>Phone:</b> <code>${esc(custPhone)}</code>\n` +
        `📍 <b>Address:</b> ${esc(addr)}\n` +
        itemsSummary +
        `💵 <b>Order Value:</b> ${esc(subtotal)} | 🛵 <b>Del. Charge:</b> ${esc(delFee)}\n` +
        `💰 <b>GRAND TOTAL:</b> <b>₹${esc(total)}</b> (${esc(order.payMode || 'COD')})\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

    // callback_data max 64 bytes -> short codes
    const inlineKeyboard = {
        inline_keyboard: [
            [
                { text: '✅ Accept Order', callback_data: `st|${oId}|A` },
                { text: '🛵 Picked Up', callback_data: `st|${oId}|P` }
            ],
            [
                { text: '🎉 Mark Delivered', callback_data: `st|${oId}|D` },
                { text: '🖥️ Open Zone Panel', url: panelLink }
            ]
        ]
    };

    try {
        const r = await timedFetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: inlineKeyboard })
        });
        if (!r.ok) console.error('Telegram sendMessage failed:', r.status);
        else console.log(`📲 [TELEGRAM SENT] Order #${oId} -> Zone ${zoneName}`);
    } catch (e) {
        console.error('Telegram notification error:', e.message);
    }
}

// Reliable order watcher: initial catch-up scan + realtime listener + 60s polling fallback.
// Same order is never alerted twice (notifiedOrders), restarts never spam old orders.
function startRealtimeOrderWatchers() {
    const FRESH_MS = 10 * 60 * 1000;   // orders newer than this are "missed while asleep" -> alert on boot
    const POLL_MS = 60 * 1000;         // fallback poll interval

    const sources = [];
    if (backupDb) sources.push({ db: backupDb, path: 'all_orders', label: 'core' });
    if (riderDb) sources.push({ db: riderDb, path: 'delivery_orders', label: 'rider' });

    // returns true if an alert was fired
    const consider = (o, key, { seedOnly = false } = {}) => {
        if (!o || typeof o !== 'object') return false;
        const oId = String(o.orderId || o.id || key);
        if (!oId || notifiedOrders.has(oId)) return false;
        markNotified(oId);

        const created = Number(o.createdAt) || 0;
        const tooOld = created > 0 && created < Date.now() - FRESH_MS;
        if (seedOnly && (created === 0 || tooOld)) return false;   // existing history: just remember it
        if (tooOld) return false;

        sendNtfyOrderAlert(o, key).catch(() => {});
        sendTelegramZoneAlert(o, key).catch(() => {});
        return true;
    };

    sources.forEach(async ({ db, path, label }) => {
        const ref = db.ref(path);

        // 1) Catch-up scan (also seeds history so restarts don't spam)
        try {
            const snap = await ref.limitToLast(100).once('value');
            let alerted = 0;
            snap.forEach(c => { if (consider(c.val(), c.key, { seedOnly: true })) alerted++; });
            console.log(`🔎 [${label}] initial scan done (${alerted} missed order alert(s))`);
        } catch (e) {
            console.error(`Initial scan failed (${path}):`, e.message);
        }

        // 2) Realtime listener
        ref.limitToLast(20).on('child_added', snap => { consider(snap.val(), snap.key); },
            err => console.error(`Listener error (${path}):`, err.message));

        // 3) Polling fallback (in case a listener silently drops)
        setInterval(async () => {
            try {
                const snap = await ref.limitToLast(30).once('value');
                snap.forEach(c => { consider(c.val(), c.key); });
            } catch (e) {
                console.error(`Poll failed (${path}):`, e.message);
            }
        }, POLL_MS);
    });

    console.log(`👀 Order watchers active (ntfy ${NTFY_ENABLED ? 'ON' : 'OFF'}, telegram ${TELEGRAM_BOT_TOKEN ? 'ON' : 'OFF'})`);
}

async function answerCallback(callbackId, text) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        await timedFetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackId, text })
        });
    } catch (e) { /* ignore */ }
}

app.post('/api/telegram/webhook', async (req, res) => {
    try {
        if (TELEGRAM_WEBHOOK_SECRET &&
            !safeSecretEqual(req.get('x-telegram-bot-api-secret-token') || '', TELEGRAM_WEBHOOK_SECRET)) {
            return res.sendStatus(401);
        }

        const cb = req.body && req.body.callback_query;
        if (!cb || !cb.data) return res.sendStatus(200);

        // Only accept presses from the configured zone/default chats
        const allowedChats = new Set(
            [...Object.values(TELEGRAM_ZONE_CHATS), process.env.TELEGRAM_DEFAULT_CHAT_ID]
                .filter(Boolean).map(String)
        );
        const fromChat = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
        if (allowedChats.size && !allowedChats.has(fromChat)) return res.sendStatus(200);

        const parts = String(cb.data).split('|');
        let orderId, newStatus;
        if (parts[0] === 'st' && parts.length >= 3) {
            orderId = parts[1];
            newStatus = STATUS_CODES[parts[2]];
        } else if (parts[0] === 'status' && parts.length >= 3) { // legacy buttons
            orderId = parts[1];
            newStatus = parts[2];
        }
        if (!orderId || !newStatus || !STATUS_RE.test(newStatus) || !/^[A-Za-z0-9_\-]{1,80}$/.test(orderId)) {
            return res.sendStatus(200);
        }

        const isRide = orderId.startsWith('DEL_');
        const targetDb = (isRide && riderDb) ? riderDb : backupDb;
        const targetPath = isRide ? `delivery_orders/${orderId}` : `all_orders/${orderId}`;

        const orderRef = targetDb.ref(targetPath);
        const before = await orderRef.once('value');
        if (!before.exists()) {
            await answerCallback(cb.id, `❌ Order #${orderId} not found`);
            return res.sendStatus(200);
        }

        await orderRef.update({
            status: newStatus,
            riderStatus: newStatus,
            isCancelled: newStatus === 'Cancelled',
            statusUpdatedAt: Date.now()
        });

        try {
            await targetDb.ref(`order_tracking/${orderId}`).update({
                riderStatus: newStatus, status: newStatus, updatedAt: Date.now()
            });
        } catch (e) { /* tracking node is optional */ }

        const orderData = before.val();
        if (orderData && orderData.phone) {
            await sendOneSignalPushByOrderId(
                orderData.phone, 'Order Status Update!',
                `Your order #${orderId} status is now: ${newStatus}`, orderId
            );
        }

        await answerCallback(cb.id, `✅ Order #${orderId} updated to ${newStatus}!`);
        console.log(`[TELEGRAM BOT] Order #${orderId} -> ${newStatus}`);
        res.sendStatus(200);
    } catch (e) {
        console.error('Telegram webhook error:', e.message);
        res.sendStatus(200);
    }
});

// -------------------------------------------------------------------------
// 9. ZONE MANAGER (ORDERS) APIS
// -------------------------------------------------------------------------

app.get('/api/manager/zones', async (req, res) => {
    try {
        const snap = await backupDb.ref(ZONES_PATH).once('value');
        const zones = normalizeZonesMap(snap.val())
            .filter(z => z.active)
            .map(z => ({ id: z.zone_name, label: `${z.zone_name} (Min Fare: ₹10)` }));

        if (zones.length === 0) {
            ['Jon1', 'Jon2', 'Jon3', 'Jon4', 'Jon5', 'Jon6'].forEach(j => {
                zones.push({ id: j, label: `Zone (${j})` });
            });
        }
        res.json({ status: 'success', zones });
    } catch (e) {
        res.json({ status: 'success', zones: [] });
    }
});

app.get('/api/manager/orders', failedAuthLimiter, verifyManagerToken, async (req, res) => {
    try {
        const zone = String(req.query.zone || '').trim();
        if (!zone) {
            return res.status(400).json({ status: 'error', message: 'Zone ID (e.g. Jon1) is required.' });
        }

        const zoneOrders = [];

        const coreSnap = await backupDb.ref('all_orders').limitToLast(250).once('value');
        const coreOrders = coreSnap.val() || {};
        Object.keys(coreOrders).forEach(key => {
            const o = coreOrders[key];
            if (o && typeof o === 'object' && doesOrderMatchZone(o, zone)) {
                zoneOrders.push({ ...o, id: key, dbRefType: 'core', dbPath: 'all_orders' });
            }
        });

        if (riderDb) {
            const riderSnap = await riderDb.ref('delivery_orders').limitToLast(250).once('value');
            const riderOrders = riderSnap.val() || {};
            Object.keys(riderOrders).forEach(key => {
                const o = riderOrders[key];
                if (o && typeof o === 'object' && doesOrderMatchZone(o, zone)) {
                    zoneOrders.push({ ...o, id: key, dbRefType: 'rider', dbPath: 'delivery_orders' });
                }
            });
        }

        zoneOrders.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

        res.json({ status: 'success', zone, count: zoneOrders.length, orders: zoneOrders });
    } catch (err) {
        console.error('Manager orders fetch failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to fetch zone orders.' });
    }
});

app.post('/api/manager/update-status', failedAuthLimiter, verifyManagerToken, async (req, res) => {
    try {
        const { orderId, status, zone, dbRefType, riderName, riderPhone, riderVehicle } = req.body || {};
        if (!orderId || !status) {
            return res.status(400).json({ status: 'error', message: 'Order ID and status are required.' });
        }
        if (!/^[A-Za-z0-9_\-]{1,80}$/.test(String(orderId))) {
            return res.status(400).json({ status: 'error', message: 'Invalid order ID.' });
        }
        if (!STATUS_RE.test(String(status))) {
            return res.status(400).json({ status: 'error', message: 'Invalid status value.' });
        }

        const isRiderOrder = dbRefType === 'rider' || String(orderId).startsWith('DEL_');
        const targetDb = (isRiderOrder && riderDb) ? riderDb : backupDb;
        const folder = isRiderOrder ? 'delivery_orders' : 'all_orders'; // fixed paths only

        const orderRef = targetDb.ref(`${folder}/${orderId}`);
        const snap = await orderRef.once('value');
        if (!snap.exists()) {
            return res.status(404).json({ status: 'error', message: 'Order not found in database.' });
        }
        const orderData = snap.val();

        // A zone-PIN manager may only touch orders of their own zone
        if (!req.managerAuth.isMaster && !doesOrderMatchZone(orderData, req.managerAuth.zone)) {
            return res.status(403).json({ status: 'error', message: 'This order does not belong to your zone.' });
        }

        const updatePayload = {
            status,
            riderStatus: status,
            isCancelled: status === 'Cancelled',
            statusUpdatedAt: Date.now()
        };
        if (riderName) updatePayload.riderName = String(riderName).slice(0, 60);
        if (riderPhone) updatePayload.riderPhone = String(riderPhone).replace(/\D/g, '').slice(-10);
        if (riderVehicle) updatePayload.riderVehicle = String(riderVehicle).slice(0, 30);

        await orderRef.update(updatePayload);

        try {
            await targetDb.ref(`order_tracking/${orderId}`).update({
                riderStatus: status,
                status,
                ...(riderName ? { riderName: updatePayload.riderName } : {}),
                ...(riderPhone ? { riderPhone: updatePayload.riderPhone } : {}),
                ...(riderVehicle ? { vehicle: updatePayload.riderVehicle } : {}),
                updatedAt: Date.now()
            });
        } catch (e) { /* tracking node is optional */ }

        if (orderData && orderData.phone) {
            await sendOneSignalPushByOrderId(
                orderData.phone, 'GMDS Order Update',
                `Your order #${orderId} is now: ${status}`, orderId
            );
        }

        console.log(`[ZONE ${zone || 'MGR'}] Order ${orderId} -> ${status}`);
        res.json({ status: 'success', message: `Order #${orderId} updated to ${status}.` });
    } catch (err) {
        console.error('Status update failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to update order status.' });
    }
});

// -------------------------------------------------------------------------
// 10. HEALTH + PROTECTED NTFY TEST
// -------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: 'GMDS Secondary Recovery, Zone Admin, Offer Admin, Zone Manager & ntfy Server',
        version: VERSION,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/secondary-health', (req, res) => {
    res.status(200).json({
        status: 'online',
        zones: zonesCache.length,
        zoneAdminEnabled: ADMIN_KEY.length >= 16,
        offerAdminEnabled: ADMIN_KEY.length >= 16,
        productsPath: PRODUCTS_PATH,
        ntfyConfigured: NTFY_ENABLED,
        telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN),
        timestamp: new Date().toISOString()
    });
});

// Admin-only (POST + x-admin-key). Sends one test alert to the phone.
//   curl -X POST https://<service>.onrender.com/api/test-ntfy -H "x-admin-key: <ADMIN_KEY>"
app.post('/api/test-ntfy', failedAuthLimiter, verifyAdminKey, testNtfyLimiter, async (req, res) => {
    if (!NTFY_ENABLED) {
        return res.status(503).json({ status: 'error', message: 'ntfy is not configured (NTFY_TOPIC).' });
    }
    const ok = await sendNtfyOrderAlert({
        orderId: 'TEST_' + Math.floor(1000 + Math.random() * 9000),
        grandTotal: 250,
        payMode: 'ONLINE',
        details: { type: 'Server Test Alert', zone: 'Jon1' }
    });
    if (!ok) return res.status(502).json({ status: 'error', message: 'ntfy delivery failed. Check server logs.' });
    res.json({ status: 'success', message: 'Test notification sent to your ntfy topic.' });
});

// -------------------------------------------------------------------------
// 11. ERROR HANDLING & START
// -------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));

app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err && err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ status: 'error', message: 'Internal server error.' });
});

startRealtimeOrderWatchers();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GMDS Secondary Recovery, Zone Admin, Offer Admin & Manager Server v${VERSION} listening on port ${PORT} (products path: "${PRODUCTS_PATH}")`);
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', (err && err.message) || err));
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', (err && err.message) || err);
    server.close(() => process.exit(1));
});
