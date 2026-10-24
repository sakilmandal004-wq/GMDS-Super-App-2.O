
'use strict';

/* =========================================================================
   GMDS SECONDARY BACKUP & MIRROR SERVER v2.0.0
   Compatible with GMDS Secure Backend v3.4.0

   Features:
   - Dedicated backup mirror (separate from primary application paths)
   - Authenticated server-to-server sync
   - Collection allowlist and input validation
   - Duplicate event protection
   - Stale update protection
   - Health and readiness endpoints
   - Rate limiting and safe error responses

   Required environment variables:
   SYNC_SECRET_KEY
   FIREBASE_SA_CORE
   ========================================================================= */

const express = require('express');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 5002;
const SYNC_SECRET_KEY = process.env.SYNC_SECRET_KEY || '';
const FIREBASE_SA_CORE = process.env.FIREBASE_SA_CORE || '';

if (SYNC_SECRET_KEY.length < 32) {
    console.error('FATAL: Set a strong SYNC_SECRET_KEY (at least 32 characters).');
    process.exit(1);
}

if (!FIREBASE_SA_CORE) {
    console.error('FATAL: FIREBASE_SA_CORE is required.');
    process.exit(1);
}

// Never use a permissive default secret in production.
function loadServiceAccount(raw) {
    const value = raw.trim();

    if (value.startsWith('{')) {
        return JSON.parse(value);
    }

    return JSON.parse(
        Buffer.from(value, 'base64').toString('utf8')
    );
}

let db;

try {
    const sa = loadServiceAccount(FIREBASE_SA_CORE);

    const backupApp = admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL:
            'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app'
    }, 'gmdsSecondaryBackup');

    db = backupApp.database();

    console.log('Firebase initialized for secondary backup.');
} catch (err) {
    console.error('FATAL: Firebase initialization failed:', err.message);
    process.exit(1);
}

// -------------------------------------------------------------------------
// Security headers
// -------------------------------------------------------------------------

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security',
        'max-age=15552000; includeSubDomains');
    next();
});

// No browser CORS is needed for server-to-server synchronization.
app.use(express.json({
    limit: '100kb',
    strict: true
}));

const syncLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Sync rate limit exceeded.'
    }
});

// -------------------------------------------------------------------------
// Sync policy
// Only explicitly permitted collections can be mirrored.
// Never accept an arbitrary Firebase path from a request.
// -------------------------------------------------------------------------

const ALLOWED_COLLECTIONS = new Set([
    'all_orders',
    'order_tracking',
    'products',
    'hotel_status'
]);

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_RE = /^[A-Za-z0-9_-]{16,100}$/;

function safeEqualString(a, b) {
    const crypto = require('crypto');
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));

    return x.length === y.length &&
        crypto.timingSafeEqual(x, y);
}

function verifySync(req, res, next) {
    const supplied = req.get('x-sync-secret') || '';

    if (!safeEqualString(supplied, SYNC_SECRET_KEY)) {
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized sync request.'
        });
    }

    next();
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value);
}

function hasValidJson(value, depth = 0) {
    if (depth > 20) return false;

    if (value === null) {
        return true;
    }

    if (typeof value === 'string' ||
        typeof value === 'boolean') {
        return true;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value);
    }

    if (Array.isArray(value)) {
        return value.length <= 2000 &&
            value.every(v => hasValidJson(v, depth + 1));
    }

    if (isPlainObject(value)) {
        const keys = Object.keys(value);

        return keys.length <= 500 &&
            keys.every(k =>
                k.length > 0 &&
                k.length <= 150 &&
                !/[.#$\/\[\]\u0000-\u001F\u007F]/.test(k) &&
                hasValidJson(value[k], depth + 1)
            );
    }

    return false;
}

// -------------------------------------------------------------------------
// Public health check
// This reports connectivity, not automatic failover readiness.
// -------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: 'GMDS Secondary Backup Server',
        version: '2.0.0',
        role: 'Secondary data mirror',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/backup/health', async (req, res) => {
    try {
        await db.ref('.info/connected').once('value');

        res.status(200).json({
            status: 'online',
            databaseConfigured: true,
            syncEndpoint: '/api/backup/sync-data',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Health check failed:', err.message);

        res.status(503).json({
            status: 'unavailable',
            databaseConfigured: true
        });
    }
});

// -------------------------------------------------------------------------
// Authenticated, idempotent mirror endpoint
//
// Request:
// {
//   "eventId": "unique-event-id-123456",
//   "collection": "all_orders",
//   "recordId": "123456789012",
//   "sourceUpdatedAt": 1790000000000,
//   "data": { ... }
// }
//
// Stored under:
// backup_mirror/<collection>/<recordId>
//
// This is a separate mirror format, not a complete Firebase clone.
// -------------------------------------------------------------------------

app.post(
    '/api/backup/sync-data',
    syncLimiter,
    verifySync,
    async (req, res) => {
        try {
            const body = req.body || {};
            const {
                eventId,
                collection,
                recordId,
                sourceUpdatedAt,
                data
            } = body;

            if (
                typeof eventId !== 'string' ||
                !EVENT_RE.test(eventId) ||
                typeof collection !== 'string' ||
                !ALLOWED_COLLECTIONS.has(collection) ||
                typeof recordId !== 'string' ||
                !ID_RE.test(recordId) ||
                !Number.isSafeInteger(sourceUpdatedAt) ||
                sourceUpdatedAt <= 0 ||
                !isPlainObject(data) ||
                !hasValidJson(data)
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid sync payload.'
                });
            }

            const ref = db.ref(
                `backup_mirror/${collection}/${recordId}`
            );

            const incoming = {
                eventId,
                sourceUpdatedAt,
                receivedAt: Date.now(),
                data
            };

            // Ignore a replay of the same event and older source versions.
            const result = await ref.transaction(current => {
                if (current !== null) {
                    if (current.eventId === eventId) {
                        return;
                    }

                    const oldVersion = Number(current.sourceUpdatedAt) || 0;

                    if (sourceUpdatedAt < oldVersion) {
                        return;
                    }

                    // Same-version updates with different event IDs are
                    // accepted; the source must send ordered versions
                    // if strict conflict resolution is required.
                }

                return incoming;
            });

            if (!result.committed) {
                const current = result.snapshot.val();

                if (current && current.eventId === eventId) {
                    return res.status(200).json({
                        status: 'success',
                        duplicate: true
                    });
                }

                return res.status(409).json({
                    status: 'conflict',
                    message: 'A newer backup record already exists.'
                });
            }

            console.log(
                `[MIRROR] ${collection}/${recordId} event=${eventId}`
            );

            return res.status(200).json({
                status: 'success',
                mirrored: true,
                collection,
                recordId
            });
        } catch (err) {
            console.error('Mirror sync failed:', err.message);

            return res.status(500).json({
                status: 'error',
                message: 'Backup synchronization failed.'
            });
        }
    }
);

// -------------------------------------------------------------------------
// Error handling
// -------------------------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Backup route not found.'
    });
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid JSON.'
        });
    }

    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({
            status: 'error',
            message: 'Request payload too large.'
        });
    }

    console.error('Backup server error:', err.message);

    return res.status(500).json({
        status: 'error',
        message: 'Internal backup server error.'
    });
});

const server = app.listen(PORT, () => {
    console.log('========================================');
    console.log('GMDS SECONDARY BACKUP SERVER v2.0.0');
    console.log(`Listening on port ${PORT}`);
    console.log('========================================');
});

process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err);
    server.close(() => process.exit(1));
});
