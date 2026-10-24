'use strict';

/* ================================================================= =
   GMDS MASTER SECURITY GATEWAY v4.1.0 (Production & Render Ready)

   Features Retained & Enhanced:
   - Fail-closed environment configuration
   - Helmet security headers & CSP
   - Strict JSON body limit with raw body verification
   - HMAC-SHA256 server-to-server authentication
   - Timestamp + atomic nonce replay protection
   - Firebase ID token verification
   - Advanced Rate Limiting & Sensitive endpoint throttling
   - Sanitized security event logging to Firebase
   - Added: Global unhandled exception & rejection catchers
   - Added: Render-compatible 0.0.0.0 port binding
   ================================================================= */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 5003;
const MASTER_SECURITY_KEY = process.env.MASTER_SECURITY_KEY || '';
const FIREBASE_SA_CORE = process.env.FIREBASE_SA_CORE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

const DATABASE_URL =
    'https://gmds-super-app-default-rtdb.asia-southeast1.firebasedatabase.app';

if (MASTER_SECURITY_KEY.length < 32) {
    console.error('FATAL: MASTER_SECURITY_KEY must be at least 32 characters.');
    process.exit(1);
}

if (!FIREBASE_SA_CORE) {
    console.error('FATAL: FIREBASE_SA_CORE is required.');
    process.exit(1);
}

if (!ALLOWED_ORIGINS.length) {
    console.error('FATAL: Configure ALLOWED_ORIGINS explicitly.');
    process.exit(1);
}

// ------------------------------------------------------------------
// FIREBASE ADMIN
// ------------------------------------------------------------------

let db;

try {
    const serviceAccount = FIREBASE_SA_CORE.trim().startsWith('{')
        ? JSON.parse(FIREBASE_SA_CORE)
        : JSON.parse(
            Buffer.from(FIREBASE_SA_CORE, 'base64').toString('utf8')
        );

    const firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: DATABASE_URL
    }, 'gmdsMasterSecurity');

    db = firebaseApp.database();
} catch (error) {
    console.error('FATAL: Firebase initialization failed:', error.message);
    process.exit(1);
}

// ------------------------------------------------------------------
// SECURITY HEADERS / CORS / BODY PARSING
// ------------------------------------------------------------------

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true
    }
}));

app.use(cors({
    origin(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed.'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Security-Signature',
        'X-Timestamp',
        'X-Request-Nonce'
    ],
    maxAge: 600
}));

app.use(express.json({
    limit: '20kb',
    strict: true,
    verify(req, res, buffer) {
        req.rawBody = Buffer.from(buffer);
    }
}));

// ------------------------------------------------------------------
// RATE LIMITING
// ------------------------------------------------------------------

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 150,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'Too many requests.'
    }
}));

const sensitiveLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        status: 'error',
        code: 'SENSITIVE_RATE_LIMITED',
        message: 'Too many sensitive requests.'
    }
});

// ------------------------------------------------------------------
// SAFE SECURITY EVENT LOGGING
// ------------------------------------------------------------------

async function logSecurityEvent(type, details = {}) {
    const event = {
        type,
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
        ...details
    };

    try {
        await db.ref('security_audit_events').push(event);
    } catch (error) {
        console.error('Security event log write failed:', error.message);
    }
}

function constantTimeStringEqual(received, expected) {
    if (typeof received !== 'string') return false;

    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------
// HMAC + TIMESTAMP + NONCE VERIFICATION
// ------------------------------------------------------------------

async function verifySignedServerRequest(req, res, next) {
    const signature = req.get('x-security-signature') || '';
    const timestamp = req.get('x-timestamp') || '';
    const nonce = req.get('x-request-nonce') || '';

    if (
        !/^\d{13}$/.test(timestamp) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
        !/^[a-f0-9]{64}$/i.test(signature)
    ) {
        await logSecurityEvent('invalid_signature_headers');
        return res.status(401).json({
            status: 'error',
            message: 'Invalid security headers.'
        });
    }

    const requestTime = Number(timestamp);
    const difference = Math.abs(Date.now() - requestTime);

    if (!Number.isSafeInteger(requestTime) || difference > 5 * 60 * 1000) {
        await logSecurityEvent('expired_signed_request');
        return res.status(401).json({
            status: 'error',
            message: 'Request timestamp expired.'
        });
    }

    const signedContent = Buffer.concat([
        Buffer.from(`${timestamp}.${nonce}.`, 'utf8'),
        req.rawBody || Buffer.alloc(0)
    ]);

    const expected = crypto
        .createHmac('sha256', MASTER_SECURITY_KEY)
        .update(signedContent)
        .digest('hex');

    if (!constantTimeStringEqual(signature.toLowerCase(), expected)) {
        await logSecurityEvent('invalid_hmac_signature');
        return res.status(401).json({
            status: 'error',
            message: 'Signature verification failed.'
        });
    }

    const nonceHash = crypto
        .createHash('sha256')
        .update(nonce)
        .digest('hex');

    const nonceRef = db.ref(`security_request_nonces/${nonceHash}`);
    const expiresAt = requestTime + 5 * 60 * 1000;

    try {
        const result = await nonceRef.transaction(current => {
            if (current && current.expiresAt > Date.now()) return;
            return {
                createdAt: Date.now(),
                expiresAt
            };
        });

        if (!result.committed) {
            await logSecurityEvent('replayed_signed_request');
            return res.status(409).json({
                status: 'error',
                message: 'Duplicate request rejected.'
            });
        }
    } catch (error) {
        console.error('Nonce verification unavailable:', error.message);
        return res.status(503).json({
            status: 'error',
            message: 'Security verification temporarily unavailable.'
        });
    }

    next();
}

// ------------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'GMDS Master Security Gateway',
        version: '4.1.0'
    });
});

// ------------------------------------------------------------------
// FIREBASE ID TOKEN VERIFICATION
// ------------------------------------------------------------------

app.post(
    '/api/security/verify-firebase-token',
    sensitiveLimiter,
    async (req, res) => {
        const authorization = req.get('authorization') || '';
        const match = authorization.match(/^Bearer (.+)$/);

        if (!match) {
            return res.status(401).json({
                status: 'error',
                message: 'Firebase ID token required.'
            });
        }

        try {
            const decoded = await admin.auth().verifyIdToken(match[1], true);

            return res.json({
                status: 'success',
                verified: true,
                uid: decoded.uid,
                authTime: decoded.auth_time
            });
        } catch (error) {
            await logSecurityEvent('firebase_token_rejected');

            return res.status(401).json({
                status: 'error',
                message: 'Invalid, expired, or revoked authentication token.'
            });
        }
    }
);

// ------------------------------------------------------------------
// SIGNED SERVER-TO-SERVER SECURITY EVENT
// ------------------------------------------------------------------

app.post(
    '/api/security/internal-event',
    sensitiveLimiter,
    verifySignedServerRequest,
    async (req, res) => {
        const { eventType, eventId } = req.body || {};

        const allowedTypes = new Set([
            'order_security_check',
            'payment_verification_result',
            'account_security_alert',
            'backup_replication_result'
        ]);

        if (
            typeof eventType !== 'string' ||
            !allowedTypes.has(eventType) ||
            typeof eventId !== 'string' ||
            !/^[A-Za-z0-9_-]{8,100}$/.test(eventId)
        ) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid security event.'
            });
        }

        await logSecurityEvent('trusted_backend_event', {
            eventType,
            eventId
        });

        return res.status(202).json({
            status: 'success',
            accepted: true
        });
    }
);

// ------------------------------------------------------------------
// ERROR HANDLING
// ------------------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Endpoint not found.'
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    const status = error.status === 400 ? 400 : 500;

    res.status(status).json({
        status: 'error',
        message: status === 400
            ? 'Invalid JSON request.'
            : status === 500 && error.message === 'Origin not allowed.'
                ? 'Origin not allowed.'
                : 'Internal security error.'
    });
});

// ------------------------------------------------------------------
// SERVER START & PORT BINDING (Render Compatible)
// ------------------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`GMDS Master Security Gateway listening on port ${PORT}`);
});

process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err.message || err);
});

process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err.message || err);
    server.close(() => process.exit(1));
});
