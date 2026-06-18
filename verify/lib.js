// Verification bootstrap for the Caffrey Ops Dashboard.
//
// Three pieces, composed by smoke tests in this dir:
//
//   1. testLogin()              — POST to local test-login, return session id.
//   2. enableDemo(sessionId)    — flip the session into demo mode (avoids
//                                 hitting Microsoft Graph, since the test
//                                 session has no msalAccount).
//   3. launchWithSession(opts)  — open a chromium context with the connect.sid
//                                 cookie pre-set for the target host.
//
// The test-login/csrf/demo HTTP calls always go to 127.0.0.1:3000 directly so
// the test-login's localhost-only gate is satisfied. The browser then loads
// BASE_URL carrying the same session id.
//
// Targets are env-driven so the same harness runs locally and against prod:
//   VERIFY_BASE_URL   browser origin (default http://localhost:3000)
//                     prod on the box:  https://caffreyops.com
//   VERIFY_ENV_PATH   path to the .env holding CAFFREY_TEST_LOGIN_TOKEN
//                     (auto-detected if unset — see candidates below)

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BACKEND = process.env.VERIFY_BACKEND_URL || 'http://127.0.0.1:3000';
const BASE_URL = (process.env.VERIFY_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TARGET = new URL(BASE_URL);
const PUBLIC_HOST = TARGET.hostname;          // back-compat export
const COOKIE_SECURE = TARGET.protocol === 'https:';

// Locate the .env that holds CAFFREY_TEST_LOGIN_TOKEN. Explicit override wins;
// otherwise prefer a local .env.local, then a local .env, then the box path.
function resolveEnvPath() {
  if (process.env.VERIFY_ENV_PATH) return process.env.VERIFY_ENV_PATH;
  const repoRoot = path.resolve(__dirname, '..');
  const candidates = [
    path.join(repoRoot, 'backend', '.env.local'),
    path.join(repoRoot, 'backend', '.env'),
    '/var/www/caffrey-ops/backend/.env',
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    throw new Error(`No env file found. Set VERIFY_ENV_PATH or create one of:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

function readToken() {
  const envPath = resolveEnvPath();
  const envText = fs.readFileSync(envPath, 'utf8');
  const m = envText.match(/^CAFFREY_TEST_LOGIN_TOKEN=(.+)$/m);
  if (!m) throw new Error(`CAFFREY_TEST_LOGIN_TOKEN not set in ${envPath}`);
  return m[1].trim();
}

function parseSetCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  // Node fetch joins multiple Set-Cookie with comma — handle either single or multi.
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const part of parts) {
    const m = part.match(new RegExp(`(?:^|, )${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function testLogin() {
  const token = readToken();
  const res = await fetch(`${BACKEND}/api/auth/test-login`, {
    method: 'POST',
    headers: { 'X-Test-Login-Token': token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`test-login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie?.() || res.headers.get('set-cookie');
  const sessionId = parseSetCookie(setCookie, 'connect.sid');
  if (!sessionId) throw new Error('test-login returned no connect.sid cookie');
  return sessionId;
}

async function fetchCsrf(sessionId) {
  const res = await fetch(`${BACKEND}/api/csrf-token`, {
    headers: { Cookie: `connect.sid=${encodeURIComponent(sessionId)}` },
  });
  if (!res.ok) throw new Error(`csrf-token fetch failed: ${res.status}`);
  const { csrfToken } = await res.json();
  // The csrf-csrf double-submit pattern also sets a paired cookie we need to carry.
  const setCookie = res.headers.getSetCookie?.() || res.headers.get('set-cookie');
  const csrfCookie = parseSetCookie(setCookie, 'x-csrf-token') ||
                     parseSetCookie(setCookie, 'csrf-token') ||
                     parseSetCookie(setCookie, '__Host-psifi.x-csrf-token');
  return { csrfToken, csrfCookie, csrfCookieRaw: setCookie };
}

async function enableDemo(sessionId) {
  const { csrfToken, csrfCookieRaw } = await fetchCsrf(sessionId);
  // Forward every cookie set by the csrf-token call back on the demo-on POST.
  const cookieHeader = buildCookieHeader(sessionId, csrfCookieRaw);
  const res = await fetch(`${BACKEND}/api/demo/on`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken, Cookie: cookieHeader },
  });
  if (!res.ok) throw new Error(`demo/on failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function buildCookieHeader(sessionId, setCookieHeader) {
  const cookies = [`connect.sid=${encodeURIComponent(sessionId)}`];
  if (setCookieHeader) {
    const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const p of parts) {
      const first = p.split(';')[0];
      if (first && !first.startsWith('connect.sid=')) cookies.push(first);
    }
  }
  return cookies.join('; ');
}

async function launchWithSession(sessionId, { headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
  });
  await context.addCookies([{
    name: 'connect.sid',
    value: encodeURIComponent(sessionId),
    domain: PUBLIC_HOST,
    path: '/',
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'Lax',
  }]);
  return { browser, context };
}

module.exports = { testLogin, enableDemo, launchWithSession, BASE_URL, PUBLIC_HOST };
