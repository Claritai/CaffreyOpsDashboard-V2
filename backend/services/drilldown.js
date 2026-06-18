const { fetchInboxAndSent, INBOX_KEYS } = require('../graph');
const { matchClient } = require('./categoriser');

/**
 * Shared drilldown fetcher used by every /api/dashboard/<thing>/messages
 * endpoint. The route validates its own param, builds a filterFn + meta,
 * and delegates here. Returns the same shape across all callers so the
 * frontend modal can render any drilldown with one renderer.
 *
 * filterFn(msg, ctx) => boolean
 *   ctx: {
 *     inboxKey,
 *     receivedMs,
 *     latestSentMs,                // null if no sent in this conv
 *     sentTimestampsForConv,       // sorted asc
 *     firstSentAfterReceivedMs,    // null if none after received
 *   }
 */
async function getDrilldownMessages(session, {
  windowDays,
  filterFn,
  meta,
  limit = 100,
  dedupeByConversation = true,
}) {
  const now = Date.now();
  const sinceIso = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const folders = await Promise.all(
    INBOX_KEYS.map(k => fetchInboxAndSent(session, k, sinceIso))
  );

  const items = [];
  for (let i = 0; i < INBOX_KEYS.length; i++) {
    const inboxKey = INBOX_KEYS[i];
    const sent = folders[i].sent || [];

    const sentByConv = new Map();
    for (const m of sent) {
      const cid = m.conversationId;
      if (!cid) continue;
      const ts = new Date(m.sentDateTime || m.receivedDateTime || 0).getTime();
      if (!sentByConv.has(cid)) sentByConv.set(cid, []);
      sentByConv.get(cid).push(ts);
    }
    for (const arr of sentByConv.values()) arr.sort((a, b) => a - b);

    const seenConv = new Set();
    for (const m of (folders[i].inbox || [])) {
      const cid = m.conversationId || m.id;
      if (dedupeByConversation && seenConv.has(cid)) continue;
      const receivedIso = m.receivedDateTime;
      if (!receivedIso) continue;
      const receivedMs = new Date(receivedIso).getTime();
      const sentArr = sentByConv.get(m.conversationId) || [];
      const latestSentMs = sentArr.length ? sentArr[sentArr.length - 1] : null;
      const firstSentAfterReceivedMs = sentArr.find(ts => ts > receivedMs) ?? null;

      const ctx = {
        inboxKey, receivedMs, latestSentMs, sentTimestampsForConv: sentArr, firstSentAfterReceivedMs,
      };
      if (!filterFn(m, ctx)) continue;
      if (dedupeByConversation) seenConv.add(cid);

      const waitingHours = (now - receivedMs) / 3_600_000;
      const fromTopClient = !!matchClient(m);
      items.push({
        id: m.id,
        subject: m.subject || '(no subject)',
        senderName: m.from?.emailAddress?.name || null,
        senderAddress: m.from?.emailAddress?.address || null,
        inbox: inboxKey,
        receivedAt: receivedIso,
        ageHours: Math.round(waitingHours * 10) / 10,
        isUrgent: waitingHours > 4 || fromTopClient,
      });
    }
  }

  items.sort((a, b) => b.ageHours - a.ageHours);
  return { meta, items: items.slice(0, limit), totalCount: items.length };
}

module.exports = { getDrilldownMessages };
