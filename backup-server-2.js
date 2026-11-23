```javascript
'use strict';

/* =========================================================================
   GMDS SECONDARY BACKUP, ZONE MANAGER & TELEGRAM BOT SERVER v3.2.0
   (Integrated with OneSignal Push + Full Polygon Zone Admin API)
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
// 1. CONFIGURATION & ENVIRONMENT VARIABLES
// -------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 5002;
const BACKUP_SYNC_KEY = process.env.BACKUP_SYNC_KEY || '';
const MANAGER_SECRET_TOKEN = process.env.MANAGER_SECRET_TOKEN || 'gmds_secure_manager_2026';

// Admin Key for Polygon Zone Manager Panel (Render Env: ADMIN_KEY, min 16 chars)
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const ADMIN_KEY_OK = ADMIN_KEY.length >= 16;
const ADMIN_KEY_DIGEST = crypto.createHash('sha256').update(ADMIN_KEY).digest();
if (!ADMIN_KEY_OK) {
    console.warn('⚠️ ADMIN_KEY is missing or shorter than 16 chars - /api/zone-admin/* routes are DISABLED.');
}

// OneSignal Credentials
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || '';

let ZONE_PINS = {};
try {
    if (process.env.ZONE_PINS) ZONE_PINS = JSON.parse(process.env.ZONE_PINS);
} catch (e) {
    console.warn('Invalid ZONE_PINS JSON, falling back to MANAGER_SECRET_TOKEN');
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PANEL_PUBLIC_URL = process.env.PANEL_PUBLIC_URL || 'https://gmds.app/manager-panel.html';

let TELEGRAM_ZONE_CHATS = {};
try {
    if (process.env.TELEGRAM_ZONE_CHATS) {
        TELEGRAM_ZONE_CHATS = JSON.parse(process.env.TELEGRAM_ZONE_CHATS);
    }
} catch (e) {
    console.warn('Invalid TELEGRAM_ZONE_CHATS JSON');
}

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

if (BACKUP_SYNC_KEY.length < 32) {
    console.error('FATAL: Set BACKUP_SYNC_KEY to a strong secret of at least 32 characters.');
    process.exit(1);
}

if (!FIREBASE_SA_CORE) {
    console.error('FATAL: FIREBASE_SA_CORE is required.');
    process.exit(1);
}

// -------------------------------------------------------------------------
// 2. SECURITY HEADERS, CORS AND REQUEST LIMITS
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
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-backup-signature', 'x-manager-token', 'x-manager-zone', 'x-admin-key']
}));

app.use(express.json({ limit: '100kb', strict: true }));

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', message: 'Request limit exceeded.' }
}));

// -------------------------------------------------------------------------
// 3. FIREBASE INITIALIZATION (CORE + OPTIONAL RIDER DB)
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
// 4. ONESIGNAL PUSH NOTIFICATION ENGINE (ORDER ID BASED)
// -------------------------------------------------------------------------

async function sendOneSignalPushByOrderId(targetPhoneOrId, title, message, orderId) {
    if (!ONESIGNAL_REST_API_KEY || !ONESIGNAL_APP_ID) {
        console.warn('⚠️ OneSignal credentials missing in environment variables.');
        return;
    }

    const payload = {
        app_id: ONESIGNAL_APP_ID,
        include_aliases: {
            external_id: [String(targetPhoneOrId)]
        },
        target_channel: 'push',
        headings: { en: title },
        contents: { en: message },
        data: { orderId: String(orderId) }
    };

    try {
        const response = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        console.log(`[ONESIGNAL PUSH] Order #${orderId} -> User ${targetPhoneOrId}:`, result);
    } catch (e) {
        console.error('OneSignal notification error:', e.message);
    }
}

// -------------------------------------------------------------------------
// 5. AUTHENTICATION & ZONE MATCHING HELPERS
// -------------------------------------------------------------------------

function safeSecretEqual(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyManagerToken(req, res, next) {
    const token = req.get('x-manager-token') || '';
    const requestedZone = String(req.query.zone || req.get('x-manager-zone') || (req.body && req.body.zone) || '').trim();

    const zoneSpecificPin = ZONE_PINS[requestedZone] || ZONE_PINS[requestedZone.toLowerCase()];
    const isMasterValid = safeSecretEqual(token, MANAGER_SECRET_TOKEN);
    const isZoneValid = zoneSpecificPin ? safeSecretEqual(token, String(zoneSpecificPin)) : false;

    if (!isMasterValid && !isZoneValid) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized Zone PIN/Token.' });
    }
    next();
}

function detectOrderZoneCode(order) {
    const d = order.details || {};
    const directZone = String(order.serviceZone || d.zone || '').trim();
    if (directZone) return directZone;

    const addressStr = String(order.address || d.pickup || '').toLowerCase();
    for (const [zoneCode, aliases] of Object.entries(ZONE_ALIASES)) {
        if (aliases.some(a => addressStr.includes(a))) {
            return zoneCode.charAt(0).toUpperCase() + zoneCode.slice(1);
        }
    }
    return 'Jon1';
}

function doesOrderMatchZone(order, requestedZone) {
    const reqKey = String(requestedZone || '').toLowerCase().trim();
    if (!reqKey || reqKey === 'all') return true;

    const d = order.details || {};
    const orderZone = String(order.serviceZone || d.zone || '').toLowerCase().trim();
    const addressStr = String(order.address || d.pickup || '').toLowerCase();

    if (orderZone && orderZone === reqKey) return true;

    const aliases = ZONE_ALIASES[reqKey] || [reqKey];
    for (const alias of aliases) {
        if (orderZone === alias || addressStr.includes(alias)) return true;
    }

    return false;
}

// -------------------------------------------------------------------------
// 6. TELEGRAM BOT NOTIFICATION ENGINE & AUTO ORDER WATCHER
// -------------------------------------------------------------------------

const notifiedOrders = new Set();

async function sendTelegramZoneAlert(order, fallbackId = '') {
    if (!TELEGRAM_BOT_TOKEN) return;

    const oId = String(order.orderId || order.id || fallbackId);
    if (!oId || notifiedOrders.has(oId)) return;
    notifiedOrders.add(oId);

    const d = order.details || {};
    const zoneName = detectOrderZoneCode(order);

    let chatId = TELEGRAM_ZONE_CHATS[zoneName] || TELEGRAM_ZONE_CHATS[zoneName.toLowerCase()];
    if (!chatId) {
        const matchedKey = Object.keys(TELEGRAM_ZONE_CHATS).find(k => k.toLowerCase() === zoneName.toLowerCase());
        if (matchedKey) chatId = TELEGRAM_ZONE_CHATS[matchedKey];
    }
    if (!chatId) chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
    if (!chatId) return;

    const total = order.grandTotal || d.totalFare || order.price || 0;
    const subtotal = order.subtotal !== undefined ? `₹${order.subtotal}` : 'N/A';
    const delFee = order.deliveryFee !== undefined ? `₹${order.deliveryFee}` : 'Included';
    const custName = order.user || order.customer || 'Customer';
    const custPhone = order.phone || 'N/A';
    const addr = order.address || d.pickup || order.service || 'N/A';

    let itemsSummary = '';
    if (Array.isArray(order.items) && order.items.length > 0) {
        itemsSummary = `🛒 *Items:* ` + order.items.map(i => `${i.name} (x${i.qty})`).join(', ') + `\n`;
    } else if (d.type) {
        itemsSummary = `🛵 *Booking:* ${d.type} (${d.distance || ''})\n🔴 *Drop:* ${d.drop || 'N/A'}\n`;
    }

    const panelLink = `${PANEL_PUBLIC_URL}?zone=${encodeURIComponent(zoneName)}&orderId=${encodeURIComponent(oId)}`;

    const text = `🚨 *NEW ORDER IN [${zoneName.toUpperCase()}]*\n` +
                 `━━━━━━━━━━━━━━━━━━━━\n` +
                 `🆔 *Order ID:* \`#${oId}\`\n` +
                 `👤 *Customer:* ${custName}\n` +
                 `📞 *Phone:* \`${custPhone}\`\n` +
                 `📍 *Address:* ${addr}\n` +
                 itemsSummary +
                 `💵 *Order Value:* ${subtotal} | 🛵 *Del. Charge:* ${delFee}\n` +
                 `💰 *GRAND TOTAL:* *₹${total}* (${order.payMode || 'COD'})\n` +
                 `━━━━━━━━━━━━━━━━━━━━`;

    const inlineKeyboard = {
        inline_keyboard: [
            [
                { text: '✅ Accept Order', callback_data: `status|${oId}|Accepted|${zoneName}` },
                { text: '🛵 Picked Up', callback_data: `status|${oId}|PickedUp|${zoneName}` }
            ],
            [
                { text: '🎉 Mark Delivered', callback_data: `status|${oId}|Delivered|${zoneName}` },
                { text: '🖥️ Open Zone Panel', url: panelLink }
            ]
        ]
    };

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown',
                reply_markup: inlineKeyboard
            })
        });
        console.log(`📲 [TELEGRAM SENT] Order #${oId} -> Zone ${zoneName} (${chatId})`);
    } catch (e) {
        console.error('Telegram notification error:', e.message);
    }
}

function startRealtimeOrderWatchers() {
    const bootTime = Date.now();

    if (backupDb) {
        backupDb.ref('all_orders').limitToLast(20).on('child_added', snap => {
            const o = snap.val();
            if (!o) return;
            const ts = Number(o.createdAt) || Number(snap.key) || 0;
            if (ts >= bootTime - 15000) {
                sendTelegramZoneAlert(o, snap.key).catch(() => {});
            } else {
                notifiedOrders.add(String(o.orderId || snap.key));
            }
        });
    }

    if (riderDb) {
        riderDb.ref('delivery_orders').limitToLast(20).on('child_added', snap => {
            const o = snap.val();
            if (!o) return;
            const ts = Number(o.createdAt) || 0;
            if (ts >= bootTime - 15000) {
                sendTelegramZoneAlert(o, snap.key).catch(() => {});
            } else {
                notifiedOrders.add(String(o.orderId || snap.key));
            }
        });
    }
}

app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const cb = req.body && req.body.callback_query;
        if (!cb || !cb.data) return res.sendStatus(200);

        const parts = String(cb.data).split('|');
        if (parts[0] === 'status' && parts.length >= 3) {
            const [, orderId, newStatus, zoneName] = parts;
            const isRide = String(orderId).startsWith('DEL_');
            const targetDb = (isRide && riderDb) ? riderDb : backupDb;
            const targetPath = isRide ? `delivery_orders/${orderId}` : `all_orders/${orderId}`;

            await targetDb.ref(targetPath).update({
                status: newStatus,
                riderStatus: newStatus,
                statusUpdatedAt: Date.now()
            });

            try {
                await targetDb.ref(`order_tracking/${orderId}`).update({
                    riderStatus: newStatus,
                    status: newStatus,
                    updatedAt: Date.now()
                });
            } catch (e) {}

            const snap = await targetDb.ref(targetPath).once('value');
            const orderData = snap.val();
            if (orderData && orderData.phone) {
                await sendOneSignalPushByOrderId(
                    orderData.phone,
                    'Order Status Update!',
                    `Your order #${orderId} status is now: ${newStatus}`,
                    orderId
                );
            }

            if (TELEGRAM_BOT_TOKEN) {
                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: cb.id,
                        text: `✅ Order #${orderId} updated to ${newStatus}!`
                    })
                });
            }
            console.log(`[TELEGRAM BOT] Order #${orderId} (${zoneName}) -> ${newStatus}`);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Telegram webhook error:', e.message);
        res.sendStatus(200);
    }
});

// -------------------------------------------------------------------------
// 7. POLYGON ZONE ADMIN API (/api/zone-admin/list | save | delete)
// -------------------------------------------------------------------------

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ZONE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SERVICE_KEYS = ['food', 'bike', 'toto', 'parcel', 'house', 'seba'];
const VEHICLE_KEYS = ['bike', 'toto', 'parcel'];
const DEFAULT_SLABS = [12, 15, 17, 20, 23, 25];
const DEFAULT_PER_KM = 1.30;
const MAX_RANGE_KM = Number(process.env.MAX_RANGE_KM) || 11.0;

const adminFailMap = new Map();
function checkAdminBruteForce(ip) {
    const now = Date.now();
    const arr = (adminFailMap.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
    adminFailMap.set(ip, arr);
    return arr.length >= 10;
}
function recordAdminFail(ip) {
    const arr = adminFailMap.get(ip) || [];
    arr.push(Date.now());
    adminFailMap.set(ip, arr);
}

function requireZoneAdmin(req, res, next) {
    if (!ADMIN_KEY_OK) {
        return res.status(503).json({ status: 'error', message: 'ADMIN_KEY is not configured on this server.' });
    }
    const ip = req.ip || 'unknown';
    if (checkAdminBruteForce(ip)) {
        return res.status(429).json({ status: 'error', message: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const given = crypto.createHash('sha256').update(String(req.get('x-admin-key') || '')).digest();
    if (!crypto.timingSafeEqual(given, ADMIN_KEY_DIGEST)) {
        recordAdminFail(ip);
        return res.status(401).json({ status: 'error', message: 'Invalid Admin Key.' });
    }
    next();
}

function cleanText(v, max = 60) {
    if (v === undefined || v === null || typeof v === 'object') return '';
    return String(v).replace(/[<>\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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
function strictNum(v, lo, hi, label) {
    const n = toNum(v);
    if (!Number.isFinite(n) || n < lo || n > hi) {
        const err = new Error(`${label}: enter a valid number between ${lo} and ${hi}.`);
        err.status = 400;
        throw err;
    }
    return Math.round(n * 100) / 100;
}
function strictBool(v, d) {
    if (v === undefined || v === null) return d;
    if (typeof v !== 'boolean') {
        const err = new Error('Invalid boolean toggle value.');
        err.status = 400;
        throw err;
    }
    return v;
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
function orient(a, b, c) { return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng); }
function segCross(a, b, c, d) {
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
            if (j === i + 1 || (i === 0 && j === n - 1)) continue;
            if (segCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
        }
    }
    return false;
}
function sameVertex(p, poly) { return poly.some(q => q.lat === p.lat && q.lng === p.lng); }
function polygonsOverlap(P, Q) {
    if (P.length === Q.length && P.every(p => sameVertex(p, Q))) return true;
    for (let i = 0; i < P.length; i++) {
        for (let j = 0; j < Q.length; j++) {
            if (segCross(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length])) return true;
        }
    }
    if (P.some(p => !sameVertex(p, Q) && pointInPolygon(p.lat, p.lng, Q))) return true;
    if (Q.some(q => !sameVertex(q, P) && pointInPolygon(q.lat, q.lng, P))) return true;
    return false;
}
function polygonEquals(A, B) {
    return Array.isArray(A) && Array.isArray(B) && A.length === B.length &&
        A.every((p, i) => p.lat === B[i].lat && p.lng === B[i].lng);
}

function sanitizePolygon(raw) {
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > 300) {
        const err = new Error('Zone must have between 3 and 300 boundary points.');
        err.status = 400;
        throw err;
    }
    const poly = raw.map(p => {
        const lat = toNum(p && p.lat), lng = toNum(p && p.lng);
        if (!(lat >= 5 && lat <= 38 && lng >= 67 && lng <= 98)) {
            const err = new Error('Invalid vertex coordinates in polygon.');
            err.status = 400;
            throw err;
        }
        return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    });
    if (polyArea(poly) < 1e-9) {
        const err = new Error('Zone area is zero; points cannot form a straight line.');
        err.status = 400;
        throw err;
    }
    if (selfIntersects(poly)) {
        const err = new Error('Zone boundary cannot intersect itself.');
        err.status = 400;
        throw err;
    }
    return poly;
}

function formatZoneForAdmin(id, z) {
    if (!z || typeof z !== 'object' || !z.polygon) return null;
    const rawPoly = Array.isArray(z.polygon) ? z.polygon : Object.values(z.polygon);
    const poly = rawPoly
        .map(p => Array.isArray(p)
            ? { lat: Number(p[0]), lng: Number(p[1]) }
            : { lat: Number(p && p.lat), lng: Number(p && p.lng) })
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (poly.length < 3) return null;

    const rawSlabs = Array.isArray(z.slabs) ? z.slabs : (z.slabs ? Object.values(z.slabs) : DEFAULT_SLABS);
    const slabs = (rawSlabs.length === 6 && rawSlabs.every(n => Number.isFinite(Number(n))))
        ? rawSlabs.map(Number)
        : DEFAULT_SLABS.slice();

    const sv = (z.services && typeof z.services === 'object') ? z.services : {};
    const services = {};
    SERVICE_KEYS.forEach(k => { services[k] = sv[k] !== false; });

    const vf = (z.vehicle_fees && typeof z.vehicle_fees === 'object') ? z.vehicle_fees : {};
    const vehicle_fees = {};
    VEHICLE_KEYS.forEach(k => {
        const v = (vf[k] && typeof vf[k] === 'object') ? vf[k] : {};
        vehicle_fees[k] = {
            extra: clampNum(v.extra, -50, 200, 0),
            per_km: clampNum(v.per_km, -5, 20, 0)
        };
    });

    const ft = (z.food_to && typeof z.food_to === 'object') ? z.food_to : {};
    const food_to = Array.isArray(ft)
        ? ft.map(String)
        : Object.keys(ft).filter(k => ft[k] === true);

    return {
        id: String(id),
        zone_name: cleanText(z.zone_name, 60) || 'Zone',
        active: z.active !== false,
        polygon: poly,
        extra_fee: clampNum(z.extra_fee, -50, 200, 0),
        per_km: clampNum(z.per_km, 0.1, 50, DEFAULT_PER_KM),
        slabs,
        services,
        food_rules: z.food_rules === true,
        food_to,
        vehicle_fees
    };
}

function buildZoneFromInput(b, ctx) {
    const name = cleanText(b.zone_name, 60);
    if (!name) {
        const err = new Error('Please enter a zone name.');
        err.status = 400;
        throw err;
    }

    const polygon = sanitizePolygon(b.polygon);
    if (!polygonEquals(polygon, ctx.existingPoly)) {
        for (const o of ctx.others) {
            if (polygonsOverlap(polygon, o.polygon)) {
                const err = new Error(`Zone boundary overlaps with active zone "${o.name}".`);
                err.status = 409;
                throw err;
            }
        }
    }

    const slabsIn = Array.isArray(b.slabs) ? b.slabs : null;
    if (!slabsIn || slabsIn.length !== 6) {
        const err = new Error('Slabs must contain exactly 6 distance tiers.');
        err.status = 400;
        throw err;
    }
    const slabs = [];
    slabsIn.forEach((v, i) => {
        const n = strictNum(v, 10, 500, `Slab ${i + 2}`);
        const prev = i === 0 ? 10 : slabs[i - 1];
        if (n < prev) {
            const err = new Error(`Slab ${i + 2} (₹${n}) cannot be less than previous tier (₹${prev}).`);
            err.status = 400;
            throw err;
        }
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
            extra: v.extra === undefined ? 0 : strictNum(v.extra, -50, 200, `${k} extra fee`),
            per_km: v.per_km === undefined ? 0 : strictNum(v.per_km, -5, 20, `${k} per km fee`)
        };
    });

    const food_rules = strictBool(b.food_rules, false);
    let food_to = null;
    if (food_rules) {
        const list = Array.isArray(b.food_to) ? b.food_to : [];
        const map = {};
        for (const rid of list) {
            const id = String(rid);
            if (!ZONE_ID_RE.test(id) || !ctx.knownIds.has(id)) {
                const err = new Error('Invalid target zone ID in food routing list.');
                err.status = 400;
                throw err;
            }
            if (id !== ctx.selfId) map[id] = true;
        }
        food_to = Object.keys(map).length ? map : null;
    }

    return JSON.parse(JSON.stringify({
        zone_name: name,
        polygon,
        active: strictBool(b.active, true),
        extra_fee: strictNum(b.extra_fee === undefined ? 0 : b.extra_fee, -50, 200, 'Extra fee'),
        per_km: strictNum(b.per_km === undefined ? DEFAULT_PER_KM : b.per_km, 0.1, 50, 'Per KM rate'),
        slabs,
        services,
        vehicle_fees,
        food_rules,
        food_to,
        updatedAt: Date.now()
    }));
}

app.post('/api/zone-admin/list', requireZoneAdmin, async (req, res) => {
    try {
        const raw = (await backupDb.ref('gmds_zones').once('value')).val() || {};
        const zones = Object.entries(raw)
            .map(([id, z]) => formatZoneForAdmin(id, z))
            .filter(Boolean);
        res.json({ status: 'success', zones, services: SERVICE_KEYS, maxRangeKm: MAX_RANGE_KM });
    } catch (err) {
        console.error('Zone admin list error:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to load zones from database.' });
    }
});

app.post('/api/zone-admin/save', requireZoneAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const raw = (await backupDb.ref('gmds_zones').once('value')).val() || {};

        let id = (b.id === undefined || b.id === null || b.id === '') ? null : String(b.id);
        if (id !== null) {
            if (!ZONE_ID_RE.test(id)) return res.status(400).json({ status: 'error', message: 'Invalid Zone ID.' });
            if (!hasOwn(raw, id)) return res.status(404).json({ status: 'error', message: 'Zone not found.' });
        }

        const views = Object.entries(raw).map(([zid, z]) => formatZoneForAdmin(zid, z)).filter(Boolean);
        const existing = id ? views.find(v => v.id === id) : null;
        const knownIds = new Set(Object.keys(raw));
        if (id === null) id = backupDb.ref('gmds_zones').push().key;

        const clean = buildZoneFromInput(b, {
            knownIds,
            selfId: id,
            others: views.filter(v => v.id !== id && v.active).map(v => ({ id: v.id, name: v.zone_name, polygon: v.polygon })),
            existingPoly: existing ? existing.polygon : null
        });

        await backupDb.ref('gmds_zones/' + id).update(clean);
        backupDb.ref('zone_audit').push({
            action: existing ? 'update' : 'create',
            zoneId: id,
            zoneName: clean.zone_name,
            at: Date.now(),
            source: 'backup-server-v3.2'
        }).catch(() => {});

        const saved = (await backupDb.ref('gmds_zones/' + id).once('value')).val();
        console.log(`🗺️ [ZONE ${existing ? 'UPDATE' : 'CREATE'}] ${id} "${clean.zone_name}"`);
        res.json({ status: 'success', zone: formatZoneForAdmin(id, saved) });
    } catch (err) {
        console.error('Zone admin save error:', err.message);
        res.status(err.status || 500).json({ status: 'error', message: err.message || 'Failed to save zone.' });
    }
});

app.post('/api/zone-admin/delete', requireZoneAdmin, async (req, res) => {
    try {
        const id = String((req.body && req.body.id) || '');
        if (!ZONE_ID_RE.test(id)) return res.status(400).json({ status: 'error', message: 'Invalid Zone ID.' });

        const raw = (await backupDb.ref('gmds_zones').once('value')).val() || {};
        if (!hasOwn(raw, id)) return res.status(404).json({ status: 'error', message: 'Zone not found.' });

        const updates = { ['gmds_zones/' + id]: null };
        Object.entries(raw).forEach(([zid, z]) => {
            if (zid !== id && z && z.food_to && z.food_to[id] !== undefined) {
                updates['gmds_zones/' + zid + '/food_to/' + id] = null;
            }
        });

        await backupDb.ref().update(updates);
        backupDb.ref('zone_audit').push({
            action: 'delete',
            zoneId: id,
            zoneName: (raw[id] && raw[id].zone_name) || '',
            at: Date.now(),
            source: 'backup-server-v3.2'
        }).catch(() => {});

        console.log(`🗑️ [ZONE DELETE] ${id}`);
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Zone admin delete error:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to delete zone.' });
    }
});

// -------------------------------------------------------------------------
// 8. ORDER MANAGER PANEL APIS (Existing Endpoints Preserved)
// -------------------------------------------------------------------------

app.get('/api/manager/zones', async (req, res) => {
    try {
        const snap = await backupDb.ref('gmds_zones').once('value');
        const val = snap.val() || {};
        const zones = [];

        Object.keys(val).forEach(k => {
            const z = val[k];
            if (z && z.active !== false) {
                const name = String(z.zone_name || k).trim();
                zones.push({ id: name, label: `${name} (Extra Fee: ₹${z.extra_fee || 0})` });
            }
        });

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

app.get('/api/manager/orders', verifyManagerToken, async (req, res) => {
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
                zoneOrders.push({ id: key, dbRefType: 'core', dbPath: 'all_orders', ...o });
            }
        });

        if (riderDb) {
            const riderSnap = await riderDb.ref('delivery_orders').limitToLast(250).once('value');
            const riderOrders = riderSnap.val() || {};
            Object.keys(riderOrders).forEach(key => {
                const o = riderOrders[key];
                if (o && typeof o === 'object' && doesOrderMatchZone(o, zone)) {
                    zoneOrders.push({ id: key, dbRefType: 'rider', dbPath: 'delivery_orders', ...o });
                }
            });
        }

        zoneOrders.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

        res.json({
            status: 'success',
            zone: zone,
            count: zoneOrders.length,
            orders: zoneOrders
        });
    } catch (err) {
        console.error('Manager orders fetch failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to fetch zone orders.' });
    }
});

app.post('/api/manager/update-status', verifyManagerToken, async (req, res) => {
    try {
        const { orderId, status, zone, dbRefType, dbPath, riderName, riderPhone, riderVehicle } = req.body || {};
        if (!orderId || !status) {
            return res.status(400).json({ status: 'error', message: 'Order ID and status are required.' });
        }

        const isRiderOrder = dbRefType === 'rider' || String(orderId).startsWith('DEL_');
        const targetDb = (isRiderOrder && riderDb) ? riderDb : backupDb;
        const folder = isRiderOrder ? 'delivery_orders' : (dbPath || 'all_orders');

        const orderRef = targetDb.ref(`${folder}/${orderId}`);
        const snap = await orderRef.once('value');

        if (!snap.exists()) {
            return res.status(404).json({ status: 'error', message: 'Order not found in database.' });
        }

        const orderData = snap.val();

        const updatePayload = {
            status: status,
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
                status: status,
                ...(riderName ? { riderName: updatePayload.riderName } : {}),
                ...(riderPhone ? { riderPhone: updatePayload.riderPhone } : {}),
                ...(riderVehicle ? { vehicle: updatePayload.riderVehicle } : {}),
                updatedAt: Date.now()
            });
        } catch (e) {}

        if (orderData && orderData.phone) {
            await sendOneSignalPushByOrderId(
                orderData.phone,
                'GMDS Order Update',
                `Your order #${orderId} is now: ${status}`,
                orderId
            );
        }

        console.log(`[ZONE ${zone || 'MGR'}] Order ${orderId} -> ${status}`);

        res.json({
            status: 'success',
            message: `Order #${orderId} updated to ${status}.`
        });
    } catch (err) {
        console.error('Status update failed:', err.message);
        res.status(500).json({ status: 'error', message: 'Failed to update order status.' });
    }
});

// -------------------------------------------------------------------------
// 9. HEALTH & START
// -------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: 'GMDS Secondary Recovery, Zone Manager & Telegram Server',
        version: '3.2.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/secondary-health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));

startRealtimeOrderWatchers();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GMDS Secondary Recovery & Zone Manager Server v3.2.0 listening on port ${PORT}`);
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message || err));
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err.message || err);
    server.close(() => process.exit(1));
});
```
