const { matchClient, categorise, getCategoriesCfg } = require('./categoriser');
const { fetchInboxAndSent, INBOX_KEYS } = require('../graph');

/** Spec §4.2 — open emails per category, plus an "urgent" sub-count. */
async function getCategories(session) {
  const now = Date.now();
  const sinceIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const folders = await Promise.all(
    INBOX_KEYS.map(k => fetchInboxAndSent(session, k, sinceIso))
  );
  const byInbox = {};
  INBOX_KEYS.forEach((k, i) => { byInbox[k] = folders[i]; });

  const config = getCategoriesCfg();
  // Initialise accumulators
  const agg = {};
  for (const cat of config) {
    agg[cat.id] = {
      id: cat.id,
      label: cat.label,
      icon: cat.icon,
      color: cat.color,
      priority: cat.priority,
      open_count: 0,
      urgent_count: 0,
      oldest_ms: null,
    };
  }

  for (const inboxKey of INBOX_KEYS) {
    const sent = byInbox[inboxKey].sent || [];
    const latestSentByConv = new Map();
    for (const m of sent) {
      const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
      const cid = m.conversationId;
      if (!cid) continue;
      if (!latestSentByConv.has(cid) || ts > latestSentByConv.get(cid)) {
        latestSentByConv.set(cid, ts);
      }
    }

    // De-dup per conversation
    const seenConv = new Set();
    for (const m of (byInbox[inboxKey].inbox || [])) {
      const cid = m.conversationId || m.id;
      if (seenConv.has(cid)) continue;
      const receivedIso = m.receivedDateTime;
      if (!receivedIso) continue;
      const receivedMs = new Date(receivedIso).getTime();
      const latestSent = latestSentByConv.get(cid);
      if (latestSent && latestSent > receivedMs) continue;
      seenConv.add(cid);

      const cats = categorise(m);
      if (cats.length === 0) continue;

      const waitingHours = (now - receivedMs) / 3_600_000;
      const fromTopClient = !!matchClient(m);
      const isUrgent = waitingHours > 4 || fromTopClient;

      for (const id of cats) {
        const bucket = agg[id];
        if (!bucket) continue;
        bucket.open_count++;
        if (isUrgent) bucket.urgent_count++;
        if (bucket.oldest_ms === null || receivedMs < bucket.oldest_ms) {
          bucket.oldest_ms = receivedMs;
        }
      }
    }
  }

  const categories = Object.values(agg)
    .map(c => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      color: c.color,
      priority: c.priority,
      open_count: c.open_count,
      urgent_count: c.urgent_count,
      oldest_hours: c.oldest_ms === null ? 0 : Math.round(((now - c.oldest_ms) / 3_600_000) * 10) / 10,
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.open_count - a.open_count;
    });

  return { categories };
}

module.exports = { getCategories };
