const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Errors that should have their message surfaced to the client. Anything else
 * (a thrown TypeError, an unhandled axios error, etc.) is treated as an
 * internal bug and gets a generic message in production.
 */
class ApiError extends Error {
  constructor(message, { status = 500, code = null, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

/** Microsoft Graph upstream error, surfaced with its Graph-side code + request id. */
class GraphError extends ApiError {
  constructor(message, { status, code, graphRequestId, details } = {}) {
    super(message, { status, code, details });
    this.name = 'GraphError';
    this.graphRequestId = graphRequestId || null;
  }
}

function shortId() {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars, easy to read aloud
}

function requestId(req, res, next) {
  req.id = shortId();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Skip noisy auth/status polls unless they error
    if (req.path === '/api/auth/status' && res.statusCode < 400) return;
    console.log(`[${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity → forced re-login

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized', requestId: req.id });
  }
  const now = Date.now();
  const last = req.session.lastActivity || now;
  if (now - last > IDLE_TIMEOUT_MS) {
    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.status(401).json({
        error: 'Session expired after 30 minutes of inactivity. Please sign in again.',
        code: 'session_idle_timeout',
        requestId: req.id,
      });
    });
  }
  req.session.lastActivity = now;
  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again in 15 minutes.', code: 'rate_limited' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded.', code: 'rate_limited' },
});

// Stricter, per-authenticated-user limiter for outbound email send. The
// general apiLimiter (per-IP, 100/min) is too loose — a single compromised
// session could push 100 sends/min from the shared mailboxes. This keys on
// the signed-in user's email so colleagues sharing an office IP each get
// their own counter. Falls back to IP if somehow no session is attached
// (requireAuth runs first on /api/emails/send, so this is just a safety net).
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.user && req.session.user.email) || req.ip,
  message: {
    error: 'Send limit reached (5 emails per minute). Please wait a moment and try again.',
    code: 'rate_limited_send',
  },
});

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const exposed = err.expose === true || (status >= 400 && status < 500);

  // Log everything — full stack for unexpected errors, one line for expected ones.
  const tag = `[${req.id}] ${req.method} ${req.originalUrl} → ${status}`;
  if (exposed) {
    const extras = [
      err.code ? `code=${err.code}` : '',
      err.graphRequestId ? `graphReqId=${err.graphRequestId}` : '',
    ].filter(Boolean).join(' ');
    console.warn(`${tag} ${err.message} ${extras}`.trim());
  } else {
    console.error(tag);
    console.error(err.stack || err.message || err);
  }

  const payload = {
    requestId: req.id,
  };
  if (exposed) {
    payload.error = err.message || 'Request failed.';
    if (err.code) payload.code = err.code;
    if (err.graphRequestId) payload.graphRequestId = err.graphRequestId;
    if (err.details && !IS_PROD) payload.details = err.details;
  } else {
    payload.error = 'Internal server error';
    payload.code = 'internal_error';
    if (!IS_PROD) {
      payload.devMessage = err.message;
      payload.stack = err.stack;
    }
  }

  res.status(status).json(payload);
}

module.exports = {
  ApiError,
  GraphError,
  requestId,
  requestLogger,
  requireAuth,
  authLimiter,
  apiLimiter,
  sendLimiter,
  errorHandler,
};
