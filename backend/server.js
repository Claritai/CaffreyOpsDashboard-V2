require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

const { getAuthCodeUrl, acquireTokenByCode } = require('./auth');
const { listMessages, getMessage, sendMessage, patchMessage, getDashboardStats, getOverview } = require('./graph');
const {
  requireAuth, authLimiter, apiLimiter, sendLimiter, errorHandler,
  requestId, requestLogger, ApiError,
} = require('./middleware');
const { withCache, TTL, invalidate } = require('./services/cache');
const { getClientHealth, getAllClientThreads } = require('./services/client-health');
const topclientsConfig = require('./services/topclients-config');
const categoriesConfig = require('./services/categories-config');
const replyTemplatesConfig = require('./services/reply-templates-config');
const cannedResponses = require('./services/canned-responses-store');
const { getCategories } = require('./services/hotlist');
const { getPerformance, getMissed, getStalled } = require('./services/performance');
const { getItAlerts } = require('./services/it-alerts');
const { getDrilldownMessages } = require('./services/drilldown');
const { categorise, getCategoriesCfg } = require('./services/categoriser');
const { londonDateKey } = require('./graph');
const demoData = require('./services/demo-data');
const hypercareStore = require('./services/hypercare-store');
const hypercareConfig = require('./services/hypercare-config');
const { notifyStatus, sendNotification } = require('./services/hypercare-notify');
const { buildSessionStore } = require('./services/session-store');
const auditLog = require('./services/audit-log');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

app.use(requestId);
app.use(requestLogger);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(process.env.SESSION_SECRET));

// Sessions persist in an encrypted SQLite store (backend/data/sessions.db,
// SQLCipher with DB_ENCRYPTION_KEY) — they survive backend restarts. Cookie
// has no maxAge so it dies when the browser closes; the 30-minute server-side
// idle timeout in middleware.js (`requireAuth`) still expires inactive
// sessions on the server side regardless.
app.use(session({
  store: buildSessionStore(session),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// ── CSRF (double-submit cookie via csrf-csrf) ────────────────────────────────
// Applied per-route on state-changing handlers below. NOT applied to the
// OAuth callback — that flow is protected by its own `state` parameter.
// NOT applied to POST /api/auth/login because that starts the OAuth flow
// before any authenticated session exists.
if (!process.env.CSRF_SECRET) {
  throw new Error('CSRF_SECRET not set — refusing to start');
}
const { generateCsrfToken, doubleCsrfProtection, invalidCsrfTokenError } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET,
  getSessionIdentifier: (req) => req.sessionID || '',
  cookieName: 'caffrey-csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
  size: 64,
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

// Wrap doubleCsrfProtection so a CSRF failure surfaces with our standard
// error shape (403, code=csrf_invalid) instead of csrf-csrf's bare error.
function csrfProtect(req, res, next) {
  doubleCsrfProtection(req, res, (err) => {
    if (err && (err === invalidCsrfTokenError || err.code === 'EBADCSRFTOKEN')) {
      return next(new ApiError('Invalid or missing CSRF token.', { status: 403, code: 'csrf_invalid' }));
    }
    next(err);
  });
}

// ── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = await getAuthCodeUrl(state);
    res.json({ redirectUrl: url });
  } catch (err) { next(err); }
});

app.get('/api/auth/callback', authLimiter, async (req, res, next) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      auditLog.record('login_failed', { ip: req.ip, detail: { reason: 'oauth_error', error: error_description || error } });
      return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
    }

    if (!state || state !== req.session.oauthState) {
      auditLog.record('login_failed', { ip: req.ip, detail: { reason: 'invalid_state' } });
      return res.redirect('/?error=Invalid+state+parameter');
    }

    const result = await acquireTokenByCode(code);
    const email = result.account.username.toLowerCase();

    const allowed = (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(u => u.trim().toLowerCase())
      .filter(Boolean);

    // Fail closed: an empty/missing allow-list denies everyone.
    if (allowed.length === 0) {
      console.error('[auth] ALLOWED_USERS is empty — denying access by default');
      auditLog.record('access_denied', { user: email, ip: req.ip, detail: { reason: 'allowlist_empty' } });
      return req.session.destroy(() => {
        res.redirect('/?error=Access+denied.+Allow-list+not+configured.');
      });
    }

    if (!allowed.includes(email)) {
      console.warn(`[auth] login denied — ${email} not in ALLOWED_USERS`);
      auditLog.record('access_denied', { user: email, ip: req.ip, detail: { reason: 'not_in_allowlist' } });
      return req.session.destroy(() => {
        res.redirect('/?error=Access+denied.+Your+account+is+not+authorised+for+this+system.');
      });
    }

    req.session.oauthState = null;
    req.session.user = {
      email,
      name: result.account.name,
    };
    // Persist only the MSAL account identifier (not the bearer token).
    // graph.js re-acquires a fresh access token via acquireTokenSilent on
    // every Graph call, so the raw token never has to live in session storage.
    req.session.msalAccount = result.account;
    req.session.lastActivity = Date.now();
    auditLog.record('login_ok', { user: email, ip: req.ip });

    res.redirect('/');
  } catch (err) { next(err); }
});

// Test-only login — bypasses Microsoft SSO so headless verification runs can
// reach an authed session. Triple-gated:
//   1. CAFFREY_TEST_LOGIN_TOKEN env var must be set + non-empty
//   2. Caller must send matching X-Test-Login-Token header
//   3. Request must originate from localhost (req.ip === '127.0.0.1' / '::1').
//      `trust proxy: 1` makes req.ip = the real client IP for any request that
//      came through Caddy, so external callers can never satisfy this.
// Any gate fail → 404 (don't reveal the endpoint exists). The created session
// has no msalAccount, so anything that hits Graph will fail; this is intended
// for demo-mode verification only.
app.post('/api/auth/test-login', (req, res) => {
  const expected = process.env.CAFFREY_TEST_LOGIN_TOKEN;
  const provided = req.get('X-Test-Login-Token');
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (!expected || !provided || provided !== expected || !isLocal) {
    return res.status(404).json({ error: 'Not found', code: 'not_found' });
  }
  const allowed = (process.env.ALLOWED_USERS || '')
    .split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
  const email = (req.body && req.body.email && String(req.body.email).toLowerCase()) || allowed[0];
  if (!email || !allowed.includes(email)) {
    return res.status(400).json({ error: 'email must be in ALLOWED_USERS', code: 'test_login.email_not_allowed' });
  }
  req.session.user = { email, name: 'Test Login' };
  req.session.lastActivity = Date.now();
  // The prod session cookie is `secure: true` (HTTPS only). The test-login is
  // hit over plain http://127.0.0.1, so the browser/curl would silently drop
  // the cookie. Relax `secure` on THIS session's cookie only so the verify
  // run can actually carry the session forward.
  req.session.cookie.secure = false;
  auditLog.record('test_login', { user: email, ip: req.ip });
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/auth/logout', csrfProtect, (req, res) => {
  const userEmail = req.session && req.session.user && req.session.user.email;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    if (userEmail) auditLog.record('logout', { user: userEmail, ip: req.ip });
    res.json({ ok: true });
  });
});

app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// CSRF token issuance — frontend fetches once after login and on 403 retries.
app.get('/api/csrf-token', requireAuth, (req, res) => {
  res.json({ csrfToken: generateCsrfToken(req, res) });
});

// ── Email routes ─────────────────────────────────────────────────────────────

app.get('/api/emails/:inbox', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const data = await listMessages(req.session, req.params.inbox, req.query);
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/emails/:inbox/:id', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const data = await getMessage(req.session, req.params.inbox, req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/emails/send', requireAuth, csrfProtect, sendLimiter, apiLimiter, async (req, res, next) => {
  try {
    const { inbox, message, queryType, jobNumber } = req.body;
    if (!inbox || !message) return res.status(400).json({ error: 'inbox and message are required' });
    await sendMessage(req.session, inbox, { message });
    // GDPR: logs sender inbox, recipients, and subject. Drop `subject` here
    // if Caffrey's DP advisor decides email content shouldn't be retained.
    const recipients = (message.toRecipients || [])
      .map(r => (r.emailAddress && r.emailAddress.address) || r)
      .filter(Boolean);
    auditLog.record('email_sent', {
      user: req.session.user && req.session.user.email,
      ip: req.ip,
      queryType: typeof queryType === 'string' ? queryType : null,
      jobNumber: typeof jobNumber === 'string' && jobNumber.trim() ? jobNumber.trim() : null,
      detail: { inbox, recipients, subject: message.subject || null, queryType: queryType || null, jobNumber: jobNumber || null },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Reply / canned responses (DB-backed, editable in the Canned Responses view)
app.get('/api/reply-templates', requireAuth, (req, res) => {
  res.json(cannedResponses.getConfig());
});

app.post('/api/reply-templates', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    const { name, body } = req.body;
    const config = cannedResponses.upsert(name, body);
    auditLog.record('canned_response_saved', { user: req.session.user && req.session.user.email, ip: req.ip, detail: { name } });
    res.json({ ok: true, config });
  } catch (err) { next(err); }
});

app.delete('/api/reply-templates/:name', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    const config = cannedResponses.remove(req.params.name);
    auditLog.record('canned_response_deleted', { user: req.session.user && req.session.user.email, ip: req.ip, detail: { name: req.params.name } });
    res.json({ ok: true, config });
  } catch (err) { next(err); }
});

// ── Support tickets (emailed to Claritai) ────────────────────────────────────
const SUPPORT_TO = 'info@claritai.ie';
const SUPPORT_FROM_INBOX = 'operations'; // shared mailbox the ticket is sent from

app.post('/api/support', requireAuth, csrfProtect, apiLimiter, async (req, res, next) => {
  try {
    const subject = (req.body.subject || '').trim();
    const messageText = (req.body.message || '').trim();
    const category = (req.body.category || 'General').toString().slice(0, 60);
    const priority = (req.body.priority || 'Normal').toString().slice(0, 20);
    if (!subject || !messageText) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }
    const user = req.session.user || {};
    const bodyText = [
      'Support ticket raised from the Caffrey Ops Dashboard.',
      '',
      `Raised by: ${user.name || 'Unknown'} <${user.email || 'unknown'}>`,
      `When: ${new Date().toISOString()}`,
      `Category: ${category}`,
      `Priority: ${priority}`,
      '',
      `Subject: ${subject}`,
      '',
      messageText,
    ].join('\n');

    const graphMessage = {
      subject: `[Caffrey Ops Support] ${subject}`,
      body: { contentType: 'Text', content: bodyText },
      toRecipients: [{ emailAddress: { address: SUPPORT_TO } }],
    };
    // CC the person who raised it so they get their own confirmation copy,
    // and set reply-to so Claritai's reply reaches them directly.
    if (user.email) {
      graphMessage.ccRecipients = [{ emailAddress: { address: user.email } }];
      graphMessage.replyTo = [{ emailAddress: { address: user.email } }];
    }

    auditLog.record('support_ticket', {
      user: user.email, ip: req.ip,
      detail: { subject, category, priority },
    });

    if (isDemoMode(req)) return res.json({ ok: true, demo: true });

    await sendMessage(req.session, SUPPORT_FROM_INBOX, { message: graphMessage });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Query-type reporting (read-only, for the Reports panel) ──────────────────
app.get('/api/reports/query-types', requireAuth, apiLimiter, (req, res, next) => {
  try {
    const { from, to, queryType, jobNumber } = req.query;
    res.json(auditLog.queryTypeReport({ from, to, queryType, jobNumber }));
  } catch (err) { next(err); }
});

app.get('/api/reports/query-types.csv', requireAuth, apiLimiter, (req, res, next) => {
  try {
    const { from, to, queryType, jobNumber } = req.query;
    const csv = auditLog.queryTypeReportCsv({ from, to, queryType, jobNumber });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="query-type-report.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

app.patch('/api/emails/:inbox/:id', requireAuth, csrfProtect, apiLimiter, async (req, res, next) => {
  try {
    const allowed = ['isRead', 'flag', 'importance'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    const data = await patchMessage(req.session, req.params.inbox, req.params.id, patch);
    res.json(data);
  } catch (err) { next(err); }
});

// ── Dashboard stats ──────────────────────────────────────────────────────────

app.get('/api/dashboard/stats', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) {
      return res.json({
        unread: { operations: 5, export: 2, ireland: 1, uk: 3, eu: 2, offers: 1 },
        totalUnread: 14,
      });
    }
    const stats = await getDashboardStats(req.session);
    res.json(stats);
  } catch (err) { next(err); }
});

app.get('/api/dashboard/overview', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.overview(), cachedAt: new Date().toISOString() });
    const overview = await getOverview(req.session);
    res.json(overview);
  } catch (err) { next(err); }
});

// Per-session cache key so one user's Graph fetch isn't served to another.
// Demo mode gets its own keyspace so live/demo caches don't bleed into each other.
function cacheKey(req, suffix) {
  const mode = req.session.demoMode ? 'demo' : 'live';
  return `${req.sessionID}:${suffix}:${mode}`;
}

function isDemoMode(req) { return req.session && req.session.demoMode === true; }

// ── Demo Mode toggle ─────────────────────────────────────────────────────────

app.post('/api/demo/on', requireAuth, csrfProtect, (req, res) => {
  req.session.demoMode = true;
  res.json({ demoMode: true });
});

app.post('/api/demo/off', requireAuth, csrfProtect, (req, res) => {
  req.session.demoMode = false;
  res.json({ demoMode: false });
});

app.get('/api/demo/status', requireAuth, (req, res) => {
  res.json({ demoMode: !!req.session.demoMode });
});

app.get('/api/dashboard/client-health', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.clientHealth(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'client-health'),
      TTL['client-health'],
      () => getClientHealth(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/categories', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.categories(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'categories'),
      TTL['categories'],
      () => getCategories(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/performance', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.performance(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'performance'),
      TTL['performance'],
      () => getPerformance(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/missed', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.missed(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'missed'),
      TTL['missed'],
      () => getMissed(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/stalled', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.stalled(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'stalled'),
      TTL['stalled'],
      () => getStalled(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/it-alerts', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) return res.json({ ...demoData.itAlerts(), cachedAt: new Date().toISOString() });
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'it-alerts'),
      TTL['it-alerts'],
      () => getItAlerts(req.session),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

// ── Drilldowns (Overview commit 2) ───────────────────────────────────────────
// Three dedicated routes; each validates its own param then delegates to the
// shared drilldown helper. Response shape: { meta, items[], totalCount }.

app.get('/api/dashboard/categories/:id/messages', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const id = req.params.id;
    const cat = getCategoriesCfg().find(c => c.id === id);
    if (!cat) {
      const err = new Error(`Unknown category: ${id}`);
      err.status = 404; err.expose = true; err.code = 'category.unknown';
      throw err;
    }
    if (isDemoMode(req)) {
      return res.json({ ...demoData.drilldown('category', id), cachedAt: new Date().toISOString() });
    }
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, `drilldown:category:${id}`),
      TTL['drilldown'],
      () => getDrilldownMessages(req.session, {
        windowDays: 7,
        filterFn: (m, ctx) => {
          if (ctx.latestSentMs && ctx.latestSentMs > ctx.receivedMs) return false;
          return categorise(m).includes(id);
        },
        meta: { kind: 'category', id: cat.id, label: cat.label, icon: cat.icon, color: cat.color },
      }),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/inbound/:date/messages', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error('Date must be YYYY-MM-DD');
      err.status = 400; err.expose = true; err.code = 'inbound.invalid_date';
      throw err;
    }
    // Bound: only the rolling 7-day window the Overview shows.
    const todayKey = londonDateKey(new Date().toISOString());
    const ageDays = Math.round((Date.parse(todayKey) - Date.parse(date)) / 86400000);
    if (ageDays < 0 || ageDays > 7) {
      const err = new Error('Date must be within the last 7 days');
      err.status = 400; err.expose = true; err.code = 'inbound.out_of_window';
      throw err;
    }
    if (isDemoMode(req)) {
      return res.json({ ...demoData.drilldown('inbound', date), cachedAt: new Date().toISOString() });
    }
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, `drilldown:inbound:${date}`),
      TTL['drilldown'],
      () => getDrilldownMessages(req.session, {
        windowDays: 8,
        dedupeByConversation: false,
        filterFn: (m) => londonDateKey(m.receivedDateTime) === date,
        meta: { kind: 'inbound', date, label: `Inbound on ${date}` },
      }),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/first-reply/:bucket/messages', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const bucket = req.params.bucket;
    if (bucket !== 'met' && bucket !== 'missed') {
      const err = new Error('Bucket must be "met" or "missed"');
      err.status = 400; err.expose = true; err.code = 'first_reply.invalid_bucket';
      throw err;
    }
    if (isDemoMode(req)) {
      return res.json({ ...demoData.drilldown('first-reply', bucket), cachedAt: new Date().toISOString() });
    }
    const slaHours = 4; // mirrors performance.js default_first_response_hours
    const todayKey = londonDateKey(new Date().toISOString());
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, `drilldown:first-reply:${bucket}`),
      TTL['drilldown'],
      () => getDrilldownMessages(req.session, {
        windowDays: 2,
        dedupeByConversation: false,
        filterFn: (m, ctx) => {
          if (londonDateKey(m.receivedDateTime) !== todayKey) return false;
          const first = ctx.firstSentAfterReceivedMs;
          const metSla = first != null && (first - ctx.receivedMs) / 3_600_000 <= slaHours;
          return bucket === 'met' ? metSla : !metSla;
        },
        meta: {
          kind: 'first-reply', bucket,
          label: bucket === 'met' ? `First reply within ${slaHours}h (today)` : `First reply > ${slaHours}h or pending (today)`,
        },
      }),
      { force }
    );
    res.json({ ...wrapped.value, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

// ── Top Clients ──────────────────────────────────────────────────────────────

// The roster is real config — returned verbatim in demo mode too, so a client
// added in either mode shows up immediately in the list.
app.get('/api/topclients', requireAuth, (req, res) => {
  res.json(topclientsConfig.getConfig());
});

// Add a top client. Validated + persisted to top-clients.json by the config
// service; categoriser.js reads the roster live, so matching / hotlist / health
// pick it up with no restart. Allowed in demo mode — the roster is global.
app.post('/api/topclients', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    const client = topclientsConfig.addClient(req.body || {});
    invalidate(cacheKey(req, 'client-threads-all'));
    invalidate(cacheKey(req, 'client-health'));
    auditLog.record('settings_changed', {
      user: req.session.user && req.session.user.email,
      ip: req.ip,
      detail: { scope: 'top_clients', op: 'add', name: client.name },
    });
    res.json({ ok: true, client, config: topclientsConfig.getConfig() });
  } catch (err) { next(err); }
});

app.delete('/api/topclients/:name', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    topclientsConfig.removeClient(req.params.name);
    invalidate(cacheKey(req, 'client-threads-all'));
    invalidate(cacheKey(req, 'client-health'));
    auditLog.record('settings_changed', {
      user: req.session.user && req.session.user.email,
      ip: req.ip,
      detail: { scope: 'top_clients', op: 'remove', name: req.params.name },
    });
    res.json({ ok: true, config: topclientsConfig.getConfig() });
  } catch (err) { next(err); }
});

// Open (unanswered) threads for one client, worst-first (overdue → healthy).
// The 12-call fan-out is computed for every client at once and cached, so
// drilling into a second client within the TTL costs nothing.
app.get('/api/dashboard/client-threads', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    const name = String(req.query.client || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'client query parameter is required', code: 'topclients.missing_client' });
    }
    if (isDemoMode(req)) {
      return res.json({ ...demoData.clientThreads(name), cachedAt: new Date().toISOString() });
    }
    const force = req.query.refresh === '1';
    const wrapped = await withCache(
      cacheKey(req, 'client-threads-all'),
      60,
      () => getAllClientThreads(req.session),
      { force }
    );
    const threads = (wrapped.value.threadsByClient || {})[name] || [];
    res.json({ client: name, threads, openCount: threads.length, cachedAt: wrapped.cachedAt });
  } catch (err) { next(err); }
});

// ── Categories ───────────────────────────────────────────────────────────────

// Raw rules — used by the Settings → Categories panel to populate the editor.
// (The Overview's Category row hits /api/dashboard/categories instead, which
// returns per-category open/urgent/oldest counts computed from Graph.)
app.get('/api/categories/config', requireAuth, (req, res) => {
  res.json(categoriesConfig.getConfig());
});

// Edit categories from the Settings panel. Validated + persisted to
// categories.json by categories-config.js. categoriser.js reads through that
// service so the next inbound email is matched against the new rules with no
// restart. The per-session `categories` cache is busted so the Overview row's
// counts re-compute on the editor's next poll; other sessions catch up at TTL.
app.patch('/api/categories/config', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    const updated = categoriesConfig.updateConfig(req.body || {});
    invalidate(cacheKey(req, 'categories'));
    auditLog.record('settings_changed', {
      user: req.session.user && req.session.user.email,
      ip: req.ip,
      detail: { scope: 'categories', fields: Object.keys(req.body || {}) },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── Hypercare ────────────────────────────────────────────────────────────────

app.get('/api/hypercare/config', requireAuth, (req, res) => {
  // notifyStatus() is non-secret (booleans only) — safe to expose to the SPA.
  res.json({ ...hypercareConfig.getConfig(), notifications: notifyStatus() });
});

// Edit Hypercare config from the Settings view (§12.5). The patch is validated
// and persisted to hypercare.json by hypercare-config.js — no restart needed,
// the next GET /api/hypercare/config reflects it immediately. Invalid fields
// throw a 400 and nothing is written. Allowed in demo mode too: the config is
// global, not session/demo data.
app.patch('/api/hypercare/config', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    const updated = hypercareConfig.updateConfig(req.body || {});
    auditLog.record('settings_changed', {
      user: req.session.user && req.session.user.email,
      ip: req.ip,
      detail: { scope: 'hypercare', fields: Object.keys(req.body || {}) },
    });
    res.json({ ...updated, notifications: notifyStatus() });
  } catch (err) { next(err); }
});

// In demo mode we wire two demo loads to real Graph messages so the Reply
// button can demonstrate the full navigation path. The link IDs are cached
// per-session for 5 minutes to avoid hammering Graph on every 30s poll.
const DEMO_LINK_TTL_MS = 5 * 60 * 1000;
async function getDemoEmailLinks(req) {
  const cached = req.session.demoEmailLinks;
  if (cached && (Date.now() - cached.fetchedAt) < DEMO_LINK_TTL_MS) return cached.links;
  const links = {};
  for (const inboxKey of ['operations', 'export']) {
    try {
      const data = await listMessages(req.session, inboxKey, { top: 1 });
      const id = data?.value?.[0]?.id;
      if (id) links[inboxKey] = id;
    } catch { /* leave inboxKey unset → Reply falls back to toast */ }
  }
  req.session.demoEmailLinks = { fetchedAt: Date.now(), links };
  return links;
}

app.get('/api/hypercare/loads', requireAuth, apiLimiter, async (req, res, next) => {
  try {
    if (isDemoMode(req)) {
      const payload = demoData.hypercareLoads();
      const links = await getDemoEmailLinks(req);
      // demo-hc-1 → operations@, demo-hc-4 → export@. If the Graph fetch
      // failed for either, those loads stay un-linked and Reply toasts.
      for (const load of payload.loads) {
        if (load.id === 'demo-hc-1' && links.operations) {
          load.inbox = 'operations'; load.messageId = links.operations;
        } else if (load.id === 'demo-hc-4' && links.export) {
          load.inbox = 'export'; load.messageId = links.export;
        }
      }
      return res.json({ ...payload, cachedAt: new Date().toISOString() });
    }
    res.json({ loads: hypercareStore.listLoads(), cachedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

app.get('/api/hypercare/activity', requireAuth, apiLimiter, (req, res, next) => {
  try {
    if (isDemoMode(req)) {
      return res.json({ ...demoData.hypercareActivity(), cachedAt: new Date().toISOString() });
    }
    res.json({ activity: hypercareStore.listActivityToday(), cachedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

// All mutations are no-ops in demo mode — UI updates optimistically and the
// next poll will re-render the stub set unchanged.
function rejectInDemo(req, res) {
  if (isDemoMode(req)) {
    res.json({ ok: true, demo: true });
    return true;
  }
  return false;
}

function actorName(req) {
  return req.session?.user?.name || req.session?.user?.email || 'unknown';
}

app.post('/api/hypercare/loads/:id/notes', requireAuth, csrfProtect, apiLimiter, (req, res, next) => {
  try {
    if (rejectInDemo(req, res)) return;
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Note text is required', code: 'hypercare.missing_text' });
    if (text.length > 2000) return res.status(400).json({ error: 'Note too long (max 2000 chars)', code: 'hypercare.note_too_long' });
    const load = hypercareStore.addNote(req.params.id, actorName(req), text);
    if (!load) return res.status(404).json({ error: 'Load not found', code: 'hypercare.not_found' });
    res.json({ load });
  } catch (err) { next(err); }
});

// Relay an overdue-load (or test) alert to Telegram/Teams. The dashboard fires
// 'overdue' when it detects a load crossing into red; the header pill fires
// 'test'. Automatic 'overdue' events are suppressed in demo mode so synthetic
// loads never page anyone; an explicit 'test' always goes through.
app.post('/api/hypercare/notify', requireAuth, csrfProtect, apiLimiter, async (req, res, next) => {
  try {
    const event = (req.body && req.body.event) || 'overdue';
    if (event !== 'test' && isDemoMode(req)) {
      return res.json({ ok: true, demo: true });
    }
    const status = notifyStatus();
    if (!status.enabled) {
      return res.json({ ok: false, code: 'notify_disabled', sent: [], failed: [] });
    }
    const load = (req.body && req.body.load) || {};
    const result = await sendNotification(event, load, actorName(req));
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Serve the frontend from this same process ───────────────────────────────
// On a single-VM deploy, Caddy serves frontend/ and reverse-proxies /api/* here,
// so this branch is simply never reached for static paths (set SERVE_FRONTEND=
// false there if you want to be explicit). On a single-service host like Render
// there is no Caddy, so Node must serve both the static dashboard and the API on
// one origin — which also keeps all /api fetches same-origin (no CORS).
if (process.env.SERVE_FRONTEND !== 'false') {
  const path = require('node:path');
  const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
  app.use(express.static(FRONTEND_DIR));
  // SPA fallback: any non-/api GET that didn't match a static file returns
  // index.html (mirrors Caddy's `try_files {path} /index.html`).
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
  console.log(`serving frontend from ${FRONTEND_DIR}`);
}

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 so the host's load balancer (e.g. Render, Fly, a container
// orchestrator) can reach the process. On a single-VM Caddy box this is still
// safe because Caddy is the only thing in front of it.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Caffrey Ops backend listening on ${HOST}:${PORT}`);
});
