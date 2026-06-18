const path = require('path');
const fs = require('fs');
const { fetchInboxAndSent, INBOX_KEYS } = require('../graph');
const { matchClient } = require('./categoriser');

const SLA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'sla.json'), 'utf8'));

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

/**
 * Shared 30-day fetch — performance, missed, and stalled all need the same
 * window. The route layer caches by endpoint with different TTLs, so each
 * endpoint pays a Graph fan-out on cache miss; deduplicating is a Session 4
 * optimisation if it ever matters.
 */
async function fetchAllMailboxes(session, days) {
  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();
  const folders = await Promise.all(
    INBOX_KEYS.map(k => fetchInboxAndSent(session, k, sinceIso))
  );
  const byInbox = {};
  INBOX_KEYS.forEach((k, i) => { byInbox[k] = folders[i]; });
  return byInbox;
}

/** Index sent items by conversationId → array of {sentMs, message}, sorted by sentMs ASC. */
function indexSentByConv(sent) {
  const map = new Map();
  for (const m of sent) {
    const cid = m.conversationId;
    if (!cid) continue;
    const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push({ ts, m });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts - b.ts);
  return map;
}

/**
 * Spec §4.4 — response time metrics. For each received message, look for the
 * earliest sent message in the same conversationId within the same mailbox
 * that's later than the received timestamp. response_minutes = (sent - received).
 *   today_minutes = average across messages received today
 *   seven_day_avg_minutes = average across messages received in the last 7 days
 *   thirty_day_avg_minutes = average across messages received in the last 30 days
 *   trend = improving/worsening/stable (10% threshold)
 *   first_response_rate.today_percent = % of today's inbound replied to within SLA
 */
async function getPerformance(session) {
  const now = Date.now();
  const byInbox = await fetchAllMailboxes(session, 30);

  const startOfTodayMs = startOfLondonDay(now);
  const sevenDayCutoff  = now - 7 * DAY_MS;
  const thirtyDayCutoff = now - 30 * DAY_MS;
  const slaMs = SLA.default_first_response_hours * HOUR_MS;

  // Per-inbox accumulators
  const perInbox = {};
  for (const k of INBOX_KEYS) {
    perInbox[k] = {
      total_responded: 0,
      total_response_ms: 0,
      today_received: 0,
      today_responded_in_sla: 0,
    };
  }

  // Global accumulators
  let todayResponses_count = 0, todayResponses_ms = 0;
  let weekResponses_count  = 0, weekResponses_ms  = 0;
  let monthResponses_count = 0, monthResponses_ms = 0;
  let todayReceived = 0, todayRespondedInSla = 0;

  for (const inboxKey of INBOX_KEYS) {
    const inbox = byInbox[inboxKey].inbox || [];
    const sent  = byInbox[inboxKey].sent  || [];
    const sentByConv = indexSentByConv(sent);

    for (const m of inbox) {
      const receivedIso = m.receivedDateTime;
      if (!receivedIso) continue;
      const receivedMs = new Date(receivedIso).getTime();

      // Skip self-sends across shared mailboxes
      const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
      // Find first sent reply with same convId after received
      const sentList = sentByConv.get(m.conversationId) || [];
      const firstReply = sentList.find(s => s.ts > receivedMs);

      const isToday   = receivedMs >= startOfTodayMs;
      const inWeek    = receivedMs >= sevenDayCutoff;
      const inMonth   = receivedMs >= thirtyDayCutoff;

      if (isToday) todayReceived++;

      if (firstReply) {
        const dMs = firstReply.ts - receivedMs;
        if (isToday)  { todayResponses_count++;  todayResponses_ms  += dMs; }
        if (inWeek)   { weekResponses_count++;   weekResponses_ms   += dMs; }
        if (inMonth)  { monthResponses_count++;  monthResponses_ms  += dMs; }

        perInbox[inboxKey].total_responded++;
        perInbox[inboxKey].total_response_ms += dMs;

        if (isToday && dMs <= slaMs) {
          todayRespondedInSla++;
          perInbox[inboxKey].today_responded_in_sla++;
        }
      }
      if (isToday) perInbox[inboxKey].today_received++;
    }
  }

  const avgMin = (total, count) => count > 0 ? Math.round((total / count / 60000) * 10) / 10 : null;
  const todayAvg    = avgMin(todayResponses_ms, todayResponses_count);
  const sevenDayAvg = avgMin(weekResponses_ms,  weekResponses_count);
  const thirtyAvg   = avgMin(monthResponses_ms, monthResponses_count);

  let trend = 'stable';
  if (todayAvg != null && sevenDayAvg != null && sevenDayAvg > 0) {
    const pctDelta = (todayAvg - sevenDayAvg) / sevenDayAvg;
    if (pctDelta < -0.1) trend = 'improving';
    else if (pctDelta > 0.1) trend = 'worsening';
  }

  // First response rate. Target = >50% of today's received messages replied within SLA.
  const targetPct = 50;
  const todayPct = todayReceived > 0
    ? Math.round((todayRespondedInSla / todayReceived) * 100)
    : null;
  const status = todayPct == null ? 'no_data'
               : todayPct >= targetPct ? 'above_target'
               : 'below_target';

  const byInboxOut = {};
  for (const k of INBOX_KEYS) {
    const p = perInbox[k];
    byInboxOut[k] = {
      avg_minutes: avgMin(p.total_response_ms, p.total_responded),
      first_response_percent: p.today_received > 0
        ? Math.round((p.today_responded_in_sla / p.today_received) * 100)
        : null,
    };
  }

  return {
    avg_response_time: {
      today_minutes: todayAvg,
      seven_day_avg_minutes: sevenDayAvg,
      thirty_day_avg_minutes: thirtyAvg,
      trend,
    },
    first_response_rate: {
      today_percent: todayPct,
      target_percent: targetPct,
      status,
    },
    by_inbox: byInboxOut,
  };
}

/** Spec §4.3 — unread inbound messages older than missed_threshold_hours. */
async function getMissed(session) {
  const now = Date.now();
  const cutoffMs = now - SLA.missed_threshold_hours * HOUR_MS;
  // Look back 14 days — anything older than that is unlikely to matter.
  const byInbox = await fetchAllMailboxes(session, 14);

  const byInboxOut = Object.fromEntries(INBOX_KEYS.map(k => [k, 0]));
  let total = 0;
  let oldest = null; // { receivedMs, subject, sender, inbox }

  for (const inboxKey of INBOX_KEYS) {
    for (const m of (byInbox[inboxKey].inbox || [])) {
      if (m.isRead) continue;
      const receivedIso = m.receivedDateTime;
      if (!receivedIso) continue;
      const receivedMs = new Date(receivedIso).getTime();
      if (receivedMs > cutoffMs) continue; // not old enough yet

      total++;
      byInboxOut[inboxKey]++;

      if (!oldest || receivedMs < oldest.receivedMs) {
        oldest = {
          receivedMs,
          subject: m.subject || '(no subject)',
          sender: m.from?.emailAddress?.address || m.from?.emailAddress?.name || 'Unknown',
          inbox: inboxKey,
          received: receivedIso,
          message_id: m.id,
        };
      }
    }
  }

  return {
    total_missed: total,
    by_inbox: byInboxOut,
    oldest: oldest ? {
      subject: oldest.subject,
      sender: oldest.sender,
      received: oldest.received,
      inbox: oldest.inbox,
      message_id: oldest.message_id,
    } : null,
  };
}

/** Spec §4.6 — we replied to a client but they haven't come back in stalled_threshold_hours. */
async function getStalled(session) {
  const now = Date.now();
  const stalledMs = SLA.stalled_threshold_hours * HOUR_MS;
  const byInbox = await fetchAllMailboxes(session, 30);

  const stalled = [];
  for (const inboxKey of INBOX_KEYS) {
    const inbox = byInbox[inboxKey].inbox || [];
    const sent  = byInbox[inboxKey].sent  || [];
    // Latest received timestamp per convId
    const latestReceivedByConv = new Map();
    for (const m of inbox) {
      const cid = m.conversationId;
      if (!cid) continue;
      const ts = new Date(m.receivedDateTime || 0).getTime();
      if (!latestReceivedByConv.has(cid) || ts > latestReceivedByConv.get(cid)) {
        latestReceivedByConv.set(cid, ts);
      }
    }

    // For each sent message: if no later received in same convId, and sent is older than stalled threshold → stalled
    const seenConv = new Set();
    for (const s of sent) {
      const cid = s.conversationId;
      if (!cid || seenConv.has(cid)) continue;
      seenConv.add(cid);
      const sentTs = new Date(s.sentDateTime || s.receivedDateTime || 0).getTime();
      const lastRcv = latestReceivedByConv.get(cid) || 0;
      if (lastRcv > sentTs) continue; // client replied, not stalled
      if (now - sentTs < stalledMs) continue; // not stalled long enough

      const to = (s.toRecipients || [])[0]?.emailAddress?.address || '';
      const client = matchClient({ from: { emailAddress: { address: to } } });
      stalled.push({
        subject: s.subject || '(no subject)',
        sent_to: to,
        sent_iso: s.sentDateTime || s.receivedDateTime,
        days_waiting: Math.round((now - sentTs) / DAY_MS * 10) / 10,
        client_name: client ? client.name : null,
        inbox: inboxKey,
        message_id: s.id,
      });
    }
  }

  stalled.sort((a, b) => b.days_waiting - a.days_waiting);
  return { stalled, total: stalled.length };
}

/** Start of the current London-time day, returned as ms-since-epoch. */
function startOfLondonDay(nowMs) {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs));
  // 'en-CA' yields YYYY-MM-DD; parse as local-zone midnight in London by appending T00:00:00
  // The resulting timestamp will be 00:00 London — exactly what we want.
  // Note: this is an approximation that's accurate except across the DST transition hour.
  return new Date(`${dateKey}T00:00:00Z`).getTime() - londonOffsetMs(nowMs);
}

function londonOffsetMs(nowMs) {
  // Approximation: read the current London offset by formatting and parsing.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', hour12: false,
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const tzn = parts.find(p => p.type === 'timeZoneName').value;
  // BST = UTC+1, GMT = UTC+0
  if (tzn === 'BST') return 1 * HOUR_MS;
  return 0;
}

module.exports = { getPerformance, getMissed, getStalled };
