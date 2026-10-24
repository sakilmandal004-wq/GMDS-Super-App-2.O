'use strict';

/* =========================================================================
   GMDS SECONDARY BACKUP & RECOVERY SERVER v2.0.1 (Fixed & Render Ready)

   Purpose:
   - Main backend / first backup থেকে event replication
   - Duplicate event protection
   - Strict event allowlist and payload validation
   - Independent shared-secret authentication
   - Health and readiness endpoints
   ========================================================================= */

const express = require('express');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// -------------------------------------------------------------------------
// 1. CONFIGURATION
// -------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 5002;
const BACKUP_SYNC_KEY = process.env.BACKUP_SYNC_KEY || '';
const FIREBASE_SA_CORE = process.env.FIREBASE_SA_CORE || '';

const DATABASE_URL =
    'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app';

if (BACKUP_SYNC_KEY.length < 32) {
    console.error(
        'FATAL: Set BACKUP_SYNC_KEY to a strong secret of at least 32 characters.'
    );
    process.exit(1);
}

if (!FIREBASE_SA_CORE) {
    console.error('FATAL: FIREBASE_SA_CORE is required.');
    process.exit(1);
}

// -------------------------------------------------------------------------
// 2. SECURITY HEADERS AND REQUEST LIMITS
// -------------------------------------------------------------------------

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
});

// Server-to-server API: browser CORS is not enabled by default.
app.use(express.json({
    limit: '30kb',
    strict: true,
    type: 'application/json'
}));

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Backup request limit exceeded.'
    }
}));

// -------------------------------------------------------------------------
// 3. FIREBASE INITIALIZATION
// -------------------------------------------------------------------------

let backupDb = null;

try {
    const serviceAccount = FIREBASE_SA_CORE.trim().startsWith('{')
        ? JSON.parse(FIREBASE_SA_CORE)
        : JSON.parse(
            Buffer.from(FIREBASE_SA_CORE, 'base64').toString('utf8')
        );

    const secondaryApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: DATABASE_URL
    }, 'gmdsRecoveryReplica');

    backupDb = secondaryApp.database();

    console.log('Firebase Admin initialized for secondary replica.');
} catch (error) {
    console.error('Firebase initialization failed:', error.message);
    process.exit(1);
}

// -------------------------------------------------------------------------
// 4. EVENT POLICY
// -------------------------------------------------------------------------

const ALLOWED_EVENTS = new Set([
    'order_created',
    'order_updated',
    'tracking_updated',
    'product_updated',
    'service_status_updated'
]);

function isValidEventId(value) {
    return typeof value === 'string' &&
        /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

function isValidObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value);
}

function safeKey(value) {
    return typeof value === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function safeSecretEqual(received, expected) {
    if (typeof received !== 'string') return false;

    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    return a.length === b.length &&
        crypto.timingSafeEqual(a, b);
}

function verifyBackupSignature(req, res, next) {
    const suppliedKey = req.get('x-backup-signature');

    if (!safeSecretEqual(suppliedKey, BACKUP_SYNC_KEY)) {
        return res.status(401).json({
            status: 'error',
            message: 'Invalid backup credentials.'
        });
    }

    next();
}

// -------------------------------------------------------------------------
// 5. BASIC HEALTH AND READINESS
// -------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'success',
        server: 'GMDS Secondary Backup & Recovery Server',
        version: '2.0.1',
        role: 'event-replication-receiver',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/secondary-health', (req, res) => {
    res.status(200).json({
        status: 'online',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/secondary-ready', (req, res) => {
    const ready = Boolean(backupDb);

    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        firebaseAdminInitialized: ready,
        timestamp: new Date().toISOString()
    });
});

// -------------------------------------------------------------------------
// 6. IDEMPOTENT EVENT REPLICATION
// -------------------------------------------------------------------------

app.post(
    '/api/backup/replicate',
    verifyBackupSignature,
    async (req, res) => {
        if (!backupDb) {
            return res.status(503).json({
                status: 'error',
                message: 'Replica database is unavailable.'
            });
        }

        const { eventId, eventType, source, sourceUpdatedAt, payload } =
            req.body || {};

        if (
            !isValidEventId(eventId) ||
            !ALLOWED_EVENTS.has(eventType) ||
            !safeKey(source) ||
            !Number.isFinite(Date.parse(sourceUpdatedAt)) ||
            !isValidObject(payload)
        ) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid or unsupported replication event.'
            });
        }

        const eventRef = backupDb.ref(
            `secondary_replicas/${eventType}/${eventId}`
        );

        const record = {
            eventId,
            eventType,
            source,
            sourceUpdatedAt,
            receivedAt: new Date().toISOString(),
            payload
        };

        try {
            const result = await eventRef.transaction(current => {
                if (current !== null) return;
                return record;
            });

            if (!result.committed) {
                return res.status(200).json({
                    status: 'success',
                    duplicate: true,
                    message: 'This event was already recorded.'
                });
            }

            console.log(
                `[REPLICA] Stored ${eventType}; eventId=${eventId}`
            );

            return res.status(201).json({
                status: 'success',
                duplicate: false,
                message: 'Replication event stored.',
                eventId
            });
        } catch (error) {
            console.error('Replication write failed:', error.message);

            return res.status(500).json({
                status: 'error',
                message: 'Replication failed. Retry safely using the same eventId.'
            });
        }
    }
);

// -------------------------------------------------------------------------
// 7. ERROR HANDLING
// -------------------------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Route not found.'
    });
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const status = err.status === 400 ? 400 : 500;

    res.status(status).json({
        status: 'error',
        message: status === 400
            ? 'Invalid JSON request.'
            : 'Internal server error.'
    });
});

// -------------------------------------------------------------------------
// 8. START & RENDER PORT BINDING FIX
// -------------------------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GMDS Secondary Recovery Server listening on port ${PORT}`);
});

process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err.message || err);
});

process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err.message || err);
    server.close(() => process.exit(1));
});
