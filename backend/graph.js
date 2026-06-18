const axios = require('axios');
const { acquireTokenSilent } = require('./auth');
const { ApiError, GraphError } = require('./middleware');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function getAccessToken(session) {
  if (!session.msalAccount) {
    throw new ApiError('Your session is missing a Microsoft account. Please sign in again.', {
      status: 401, code: 'no_msal_account',
    });
  }
  try {
    const result = await acquireTokenSilent(session.msalAccount);
    return result.accessToken;
  } catch (err) {
    throw new ApiError('Microsoft sign-in expired. Please sign in again.', {
      status: 401, code: 'token_acquire_failed', details: err.message,
    });
  }
}

// Map a few common Graph HTTP statuses to client-friendly summaries.
function summarizeStatus(status) {
  if (status === 401) return 'Microsoft sign-in expired. Please sign in again.';
  if (status === 403) return 'Microsoft 365 denied this action (permissions or licence).';
  if (status === 404) return 'Item not found in Microsoft 365.';
  if (status === 429) return 'Microsoft 365 throttled the request. Try again shortly.';
  if (status >= 500) return 'Microsoft 365 is currently unavailable.';
  return 'Microsoft 365 request failed.';
}

async function graphRequest(session, method, path, data = null) {
  const token = await getAccessToken(session);
  const config = {
    method,
    url: `${GRAPH_BASE}${path}`,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (data) config.data = data;
  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    // Network/timeout — no response from Graph at all.
    if (!err.response) {
      console.error(`[Graph] ${method} ${path} → network error: ${err.message}`);
      throw new GraphError('Could not reach Microsoft 365.', {
        status: 502,
        code: 'graph_unreachable',
        details: err.message,
      });
    }

    const { status, data: body, headers } = err.response;
    const graphRequestId = headers?.['request-id'] || headers?.['client-request-id'] || null;
    const graphCode = body?.error?.code || null;
    const graphMessage = body?.error?.message || null;

    console.error(
      `[Graph] ${method} ${path} → ${status} ${graphCode || ''} ${graphMessage || ''} ` +
      `(graphReqId=${graphRequestId || 'n/a'})`
    );

    // Always include Graph's machine-readable code in our error code so the
    // frontend can branch on it (e.g. ErrorItemNotFound vs MailboxNotEnabledForRESTAPI).
    const code = graphCode ? `graph.${graphCode}` : `graph.http_${status}`;
    const summary = summarizeStatus(status);
    const message = graphMessage ? `${summary} ${graphMessage}` : summary;

    throw new GraphError(message, {
      status,
      code,
      graphRequestId,
      details: graphMessage,
    });
  }
}

function getInboxEmail(inboxKey) {
  const map = {
    operations: process.env.INBOX_OPERATIONS,
    export: process.env.INBOX_EXPORT,
    ireland: process.env.INBOX_IRELAND,
    uk: process.env.INBOX_UK,
    eu: process.env.INBOX_EU,
    offers: process.env.INBOX_OFFERS,
  };
  return map[inboxKey] || null;
}

async function listMessages(session, inboxKey, params = {}) {
  const email = getInboxEmail(inboxKey);
  if (!email) throw new ApiError(`Unknown inbox: ${inboxKey}`, { status: 404, code: 'unknown_inbox' });

  const top = params.top || 50;
  const skip = params.skip || 0;
  const filter = params.filter ? `&$filter=${encodeURIComponent(params.filter)}` : '';
  const search = params.search ? `&$search="${encodeURIComponent(params.search)}"` : '';

  const fields = [
    'id', 'subject', 'from', 'receivedDateTime', 'isRead',
    'importance', 'hasAttachments', 'bodyPreview', 'flag',
  ].join(',');

  const path = `/users/${email}/messages?$top=${top}&$skip=${skip}&$select=${fields}&$orderby=receivedDateTime desc${filter}${search}`;
  return graphRequest(session, 'GET', path);
}

async function getMessage(session, inboxKey, messageId) {
  const email = getInboxEmail(inboxKey);
  if (!email) throw new ApiError(`Unknown inbox: ${inboxKey}`, { status: 404, code: 'unknown_inbox' });
  return graphRequest(session, 'GET', `/users/${email}/messages/${messageId}`);
}

async function sendMessage(session, inboxKey, messagePayload) {
  const email = getInboxEmail(inboxKey);
  if (!email) throw new ApiError(`Unknown inbox: ${inboxKey}`, { status: 404, code: 'unknown_inbox' });
  return graphRequest(session, 'POST', `/users/${email}/sendMail`, messagePayload);
}

async function patchMessage(session, inboxKey, messageId, patch) {
  const email = getInboxEmail(inboxKey);
  if (!email) throw new ApiError(`Unknown inbox: ${inboxKey}`, { status: 404, code: 'unknown_inbox' });
  return graphRequest(session, 'PATCH', `/users/${email}/messages/${messageId}`, patch);
}

async function getUnreadCount(session, inboxKey) {
  const email = getInboxEmail(inboxKey);
  if (!email) return 0;
  try {
    const data = await graphRequest(
      session, 'GET',
      `/users/${email}/mailFolders/Inbox?$select=unreadItemCount`
    );
    return data.unreadItemCount || 0;
  } catch {
    return 0;
  }
}

const INBOX_KEYS = ['operations', 'export', 'ireland', 'uk', 'eu', 'offers'];

// ── Overview metrics ──────────────────────────────────────────────────────────

const WAITING_THRESHOLD_HOURS = 4;
const BUSINESS_TZ = 'Europe/London';
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;

function isAfterHoursLondon(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TZ,
    weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  return hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR;
}

function londonDateKey(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function fetchFolder(session, email, folder, sinceIso) {
  const fields = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,conversationId,isRead';
  const dateField = folder === 'SentItems' ? 'sentDateTime' : 'receivedDateTime';
  const path = `/users/${email}/mailFolders/${folder}/messages` +
    `?$filter=${dateField} ge ${sinceIso}` +
    `&$select=${fields}&$top=500&$orderby=${dateField} desc`;
  try {
    const data = await graphRequest(session, 'GET', path);
    return data.value || [];
  } catch {
    return [];
  }
}

/**
 * Fetch a mailbox's Inbox + SentItems for the last `sinceIso` window in parallel.
 * Returns { inbox: [...], sent: [...] }. Used by overview, client-health, and
 * later by categories/hotlist services in Phase 2.
 */
async function fetchInboxAndSent(session, inboxKey, sinceIso) {
  const email = getInboxEmail(inboxKey);
  if (!email) return { inbox: [], sent: [] };
  const [inbox, sent] = await Promise.all([
    fetchFolder(session, email, 'Inbox', sinceIso),
    fetchFolder(session, email, 'SentItems', sinceIso),
  ]);
  return { inbox, sent };
}

async function getOverview(session) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const todayKey = londonDateKey(now.toISOString());

  const keyToEmail = Object.fromEntries(INBOX_KEYS.map(k => [k, getInboxEmail(k)]));
  const inboxJobs = INBOX_KEYS.flatMap(key => {
    const email = keyToEmail[key];
    if (!email) return [];
    return [
      fetchFolder(session, email, 'Inbox', sevenDaysAgo.toISOString()).then(v => ({ key, folder: 'Inbox', messages: v })),
      fetchFolder(session, email, 'SentItems', sevenDaysAgo.toISOString()).then(v => ({ key, folder: 'SentItems', messages: v })),
    ];
  });

  const results = await Promise.all(inboxJobs);

  const inboxByKey = {};
  const sentByKey = {};
  for (const r of results) {
    if (r.folder === 'Inbox') inboxByKey[r.key] = r.messages;
    else sentByKey[r.key] = r.messages;
  }

  // Latest sent timestamp per conversationId, per mailbox
  const latestSentByConv = {};
  for (const key of INBOX_KEYS) {
    const map = new Map();
    for (const m of (sentByKey[key] || [])) {
      const cid = m.conversationId;
      const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
      if (!map.has(cid) || ts > map.get(cid)) map.set(cid, ts);
    }
    latestSentByConv[key] = map;
  }

  let oldestUnanswered = null;
  let waitingOverCount = 0;
  const waitingByInbox = {};
  let afterHoursCount = 0;
  const afterHoursByInbox = {};
  let inboundToday = 0;
  let inboundLast7Days = 0;
  // Build the rolling 7-day window of London-time date keys (oldest first, today last).
  const dailySeries = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dailySeries.push({ date: londonDateKey(d.toISOString()), count: 0 });
  }
  const dailyIndex = Object.fromEntries(dailySeries.map((d, idx) => [d.date, idx]));

  const waitingThresholdMs = WAITING_THRESHOLD_HOURS * 60 * 60 * 1000;

  for (const key of INBOX_KEYS) {
    const msgs = inboxByKey[key] || [];
    waitingByInbox[key] = 0;
    afterHoursByInbox[key] = 0;
    const sentMap = latestSentByConv[key] || new Map();

    for (const m of msgs) {
      const receivedIso = m.receivedDateTime;
      if (!receivedIso) continue;
      const receivedMs = new Date(receivedIso).getTime();
      const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
      const fromName = m.from?.emailAddress?.name || fromAddr;

      // Skip messages we sent to ourselves (shared mailboxes can cross-message)
      const inboxAddr = (keyToEmail[key] || '').toLowerCase();
      if (fromAddr === inboxAddr) continue;

      // Inbound counts
      const dateKey = londonDateKey(receivedIso);
      if (dateKey === todayKey) inboundToday++;
      inboundLast7Days++;
      if (dateKey in dailyIndex) dailySeries[dailyIndex[dateKey]].count++;

      // After-hours (last 24h window only)
      if (receivedMs >= oneDayAgo.getTime() && isAfterHoursLondon(receivedIso)) {
        afterHoursCount++;
        afterHoursByInbox[key]++;
      }

      // Unanswered detection: any sent in same conversationId after received
      const latestSentMs = sentMap.get(m.conversationId);
      const answered = latestSentMs && latestSentMs > receivedMs;
      if (!answered) {
        const ageMs = now.getTime() - receivedMs;
        if (ageMs >= waitingThresholdMs) {
          waitingOverCount++;
          waitingByInbox[key]++;
        }
        if (!oldestUnanswered || receivedMs < new Date(oldestUnanswered.receivedAt).getTime()) {
          oldestUnanswered = {
            id: m.id,
            subject: m.subject || '(no subject)',
            senderName: fromName,
            senderAddress: fromAddr,
            inbox: key,
            receivedAt: receivedIso,
            ageHours: ageMs / 3_600_000,
          };
        }
      }
    }
  }

  // Inbound today vs 7-day average (the 7-day count includes today)
  const dailyAverage = inboundLast7Days / 7;
  const inboundDelta = inboundToday - dailyAverage;
  const inboundDeltaPct = dailyAverage > 0 ? (inboundDelta / dailyAverage) * 100 : null;

  return {
    generatedAt: now.toISOString(),
    oldestUnanswered,
    waiting: {
      thresholdHours: WAITING_THRESHOLD_HOURS,
      count: waitingOverCount,
      byInbox: waitingByInbox,
    },
    afterHours24h: {
      count: afterHoursCount,
      byInbox: afterHoursByInbox,
    },
    inbound: {
      today: inboundToday,
      dailyAverage7d: Math.round(dailyAverage * 10) / 10,
      delta: Math.round(inboundDelta * 10) / 10,
      deltaPct: inboundDeltaPct === null ? null : Math.round(inboundDeltaPct),
      daily: dailySeries,
    },
  };
}

async function getDashboardStats(session) {
  const keyToEmail = Object.fromEntries(INBOX_KEYS.map(k => [k, getInboxEmail(k)]));
  const uniqueEmails = [...new Set(Object.values(keyToEmail).filter(Boolean))];

  const emailCounts = {};
  const results = await Promise.allSettled(
    uniqueEmails.map(async (email) => {
      const data = await graphRequest(
        session, 'GET',
        `/users/${email}/mailFolders/Inbox?$select=unreadItemCount`
      );
      return { email, count: data.unreadItemCount || 0 };
    })
  );
  for (const r of results) {
    if (r.status === 'fulfilled') emailCounts[r.value.email] = r.value.count;
  }

  const unread = {};
  for (const key of INBOX_KEYS) {
    const email = keyToEmail[key];
    unread[key] = email ? (emailCounts[email] || 0) : 0;
  }
  const totalUnread = Object.values(emailCounts).reduce((a, b) => a + b, 0);
  return { unread, totalUnread };
}

module.exports = {
  listMessages, getMessage, sendMessage, patchMessage,
  getDashboardStats, getOverview, getInboxEmail, INBOX_KEYS,
  fetchInboxAndSent, londonDateKey,
};
