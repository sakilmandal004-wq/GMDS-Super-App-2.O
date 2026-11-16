'use strict';

/* =========================================================================
   GMDS SECONDARY BACKUP, ZONE MANAGER & TELEGRAM BOT SERVER v3.1.0
   (Integrated with OneSignal Push Notification Engine)
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

// OneSignal Credentials (সম্পূর্ণরূপে Environment Variable থেকে রিড করবে)
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
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-backup-signature', 'x-manager-token', 'x-manager-zone']
}));

app.use(express.json({ limit: '50kb', strict: true }));

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
        target_channel: "push",
        headings: { en: title },
        contents: { en: message },
        data: { orderId: String(orderId) }
    };

    try {
        const response = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`
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

const ALLOWED_EVENTS = new Set([
    'order_created',
    'order_updated',
    'tracking_updated',
    'product_updated',
    'service_status_updated'
]);

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
                    `Order Status Update!`,
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
// 7. ZONE MANAGER PANEL APIS (With OneSignal Hook on Status Update)
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
                zones.push({ id: name, label: `${name} (Min Fare: ₹${z.min_fare || 0})` });
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
                `GMDS Order Update`,
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
// 8. HEALTH & IDEMPOTENT EVENT REPLICATION
// -------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: 'GMDS Secondary Recovery, Zone Manager & Telegram Server',
        version: '3.1.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/secondary-health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date().toISOString() });
});

// -------------------------------------------------------------------------
// 9. ERROR HANDLING & START
// -------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));

startRealtimeOrderWatchers();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GMDS Secondary Recovery & Zone Manager Server v3.1.0 listening on port ${PORT}`);
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message || err));
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err.message || err);
    server.close(() => process.exit(1));
});
