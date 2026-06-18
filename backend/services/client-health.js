const { getClients, matchClient } = require('./categoriser');
const { fetchInboxAndSent, INBOX_KEYS } = require('../graph');

/**
 * Scan every shared mailbox's Inbox + SentItems for the last 7 days and produce
 * the client-health response shape (§4.1 of CAFFREY-OPS-PHASE-2.md).
 *
 * For each top-client domain we:
 *   - find received messages where the sender's domain matches the client
 *   - mark a thread "open" if no reply (matching conversationId, later timestamp)
 *     exists in that mailbox's SentItems
 *   - oldest_waiting_hours = max age across that client's open threads
 *   - status = green | amber | red based on the client's SLA (2× SLA = red)
 */
async function getClientHealth(session) {
  const clients = getClients();
  const now = Date.now();
  const sinceIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fan out: per-inbox Inbox + SentItems. Reuses the same Graph plumbing
  // that powers /api/dashboard/overview so the load profile is identical.
  const folderResults = await Promise.all(
    INBOX_KEYS.map(key => fetchInboxAndSent(session, key, sinceIso))
  );
  // Map { inboxKey: { inbox: [...], sent: [...] } }
  const byInbox = {};
  INBOX_KEYS.forEach((k, i) => { byInbox[k] = folderResults[i]; });

  // Build per-inbox conversationId -> latest reply timestamp (ms)
  const latestSentByConv = {};
  for (const key of INBOX_KEYS) {
    const map = new Map();
    for (const m of (byInbox[key].sent || [])) {
      const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
      const cid = m.conversationId;
      if (!cid) continue;
      if (!map.has(cid) || ts > map.get(cid)) map.set(cid, ts);
    }
    latestSentByConv[key] = map;
  }

  // For each client, collect open threads across all inboxes
  const perClient = clients.map(client => {
    const openByConv = new Map(); // conversationId -> { receivedMs, subject, inbox, messageId }

    for (const key of INBOX_KEYS) {
      const sentMap = latestSentByConv[key] || new Map();
      for (const m of (byInbox[key].inbox || [])) {
        if (!matchClient(m) || matchClient(m).name !== client.name) continue;
        const receivedIso = m.receivedDateTime;
        if (!receivedIso) continue;
        const receivedMs = new Date(receivedIso).getTime();
        const cid = m.conversationId || m.id;
        const latestSent = sentMap.get(cid);
        const answered = latestSent && latestSent > receivedMs;
        if (answered) continue;

        // Keep the most recent message per conversation as the thread's representative
        const existing = openByConv.get(cid);
        if (!existing || receivedMs > existing.receivedMs) {
          openByConv.set(cid, {
            receivedMs,
            subject: m.subject || '(no subject)',
            inbox: key,
            messageId: m.id,
          });
        }
      }
    }

    const openThreads = [...openByConv.values()].sort((a, b) => a.receivedMs - b.receivedMs);
    const oldestMs = openThreads.length ? openThreads[0].receivedMs : null;
    const oldestWaitingHours = oldestMs ? (now - oldestMs) / 3_600_000 : 0;

    let status = 'green';
    if (openThreads.length > 0) {
      if (oldestWaitingHours >= 2 * client.sla_hours) status = 'red';
      else if (oldestWaitingHours >= client.sla_hours) status = 'amber';
    }

    // Newest thread = the one to show as "latest_subject"; provide a jump target too
    const latest = openThreads.length
      ? openThreads.reduce((a, b) => (a.receivedMs > b.receivedMs ? a : b))
      : null;

    return {
      name: client.name,
      status,
      open_threads: openThreads.length,
      oldest_waiting_hours: Math.round(oldestWaitingHours * 10) / 10,
      revenue_at_risk_eur: status === 'red' ? client.annual_value_eur : 0,
      sla_hours: client.sla_hours,
      latest_subject: latest ? latest.subject : null,
      // Jump target for click-through: which inbox + message ID to open
      jump: latest ? { inbox: latest.inbox, message_id: latest.messageId } : null,
    };
  });

  // Sort: red → amber → green; within status, oldest waiting first
  const statusRank = { red: 0, amber: 1, green: 2 };
  perClient.sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    return b.oldest_waiting_hours - a.oldest_waiting_hours;
  });

  const summary = {
    total_clients: clients.length,
    green: perClient.filter(c => c.status === 'green').length,
    amber: perClient.filter(c => c.status === 'amber').length,
    red:   perClient.filter(c => c.status === 'red').length,
    total_revenue_at_risk_eur: perClient
      .filter(c => c.status === 'red')
      .reduce((s, c) => s + (c.revenue_at_risk_eur || 0), 0),
  };

  return { clients: perClient, summary };
}

/**
 * Like getClientHealth, but returns the *full* list of open (unanswered)
 * threads for every client — each tagged with its own status — sorted
 * worst-first (red → amber → green, longest-waiting first within a status).
 * Powers the Top Clients view's per-client email drill-down.
 *
 * Returns { threadsByClient: { [clientName]: [ { subject, inbox, messageId,
 * receivedAt, waitingHours, status } ] } } — a bucket for every roster client,
 * an empty array when nothing is open.
 */
async function getAllClientThreads(session) {
  const clients = getClients();
  const now = Date.now();
  const sinceIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const folderResults = await Promise.all(
    INBOX_KEYS.map(key => fetchInboxAndSent(session, key, sinceIso))
  );
  const byInbox = {};
  INBOX_KEYS.forEach((k, i) => { byInbox[k] = folderResults[i]; });

  // Per-inbox conversationId -> latest reply timestamp (ms)
  const latestSentByConv = {};
  for (const key of INBOX_KEYS) {
    const map = new Map();
    for (const m of (byInbox[key].sent || [])) {
      const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
      const cid = m.conversationId;
      if (!cid) continue;
      if (!map.has(cid) || ts > map.get(cid)) map.set(cid, ts);
    }
    latestSentByConv[key] = map;
  }

  const statusRank = { red: 0, amber: 1, green: 2 };
  const threadsByClient = {};

  for (const client of clients) {
    const openByConv = new Map();
    for (const key of INBOX_KEYS) {
      const sentMap = latestSentByConv[key] || new Map();
      for (const m of (byInbox[key].inbox || [])) {
        const matched = matchClient(m);
        if (!matched || matched.name !== client.name) continue;
        if (!m.receivedDateTime) continue;
        const receivedMs = new Date(m.receivedDateTime).getTime();
        const cid = m.conversationId || m.id;
        const latestSent = sentMap.get(cid);
        if (latestSent && latestSent > receivedMs) continue;   // answered
        const existing = openByConv.get(cid);
        if (!existing || receivedMs > existing.receivedMs) {
          openByConv.set(cid, { receivedMs, subject: m.subject || '(no subject)', inbox: key, messageId: m.id });
        }
      }
    }

    const threads = [...openByConv.values()].map(t => {
      const waitingHours = (now - t.receivedMs) / 3_600_000;
      let status = 'green';
      if (waitingHours >= 2 * client.sla_hours) status = 'red';
      else if (waitingHours >= client.sla_hours) status = 'amber';
      return {
        subject: t.subject,
        inbox: t.inbox,
        messageId: t.messageId,
        receivedAt: new Date(t.receivedMs).toISOString(),
        waitingHours: Math.round(waitingHours * 10) / 10,
        status,
      };
    });
    threads.sort((a, b) => {
      if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
      return b.waitingHours - a.waitingHours;
    });
    threadsByClient[client.name] = threads;
  }

  return { threadsByClient };
}

module.exports = { getClientHealth, getAllClientThreads };
