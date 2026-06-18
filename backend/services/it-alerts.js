const { fetchInboxAndSent, INBOX_KEYS } = require('../graph');

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

/**
 * System-health detection — independent of categories.json so changing the
 * "IT / Server Loads" category (which is for freight) doesn't affect this banner.
 *
 * Matches:
 *   - postmaster / mailer-daemon senders
 *   - common monitoring / no-reply sender local-parts
 *   - subject patterns commonly used by monitoring tools
 */
const ALERT_SENDER_RE = /^(postmaster|mailer-daemon|noreply|no-reply|monitoring|alerts?|nagios|pagerduty|grafana|zabbix|prometheus|cloudwatch|datadog|sentry|uptime|statuscake|pingdom)@/i;

const ALERT_SUBJECT_RE = /\b(undeliverable|delivery (status|failure)|failure notice|returned mail|alert|outage|degraded|incident|monitoring|down(time)?|recovered|status:|critical|warning|threshold)\b/i;

const DEFAULT_THRESHOLD = 10; // alerts in last hour

function isAlert(msg) {
  const subject = msg.subject || '';
  const fromAddr = msg.from?.emailAddress?.address || '';
  return ALERT_SENDER_RE.test(fromAddr) || ALERT_SUBJECT_RE.test(subject);
}

/** Spec §4.7 — IT/server-alert counts in last 24h, plus a recent-sample list. */
async function getItAlerts(session, { threshold = DEFAULT_THRESHOLD } = {}) {
  const now = Date.now();
  const sinceIso = new Date(now - DAY_MS).toISOString();

  // We only need Inbox here — alerts arrive, they don't depart.
  const folders = await Promise.all(
    INBOX_KEYS.map(k => fetchInboxAndSent(session, k, sinceIso))
  );

  const matches = [];
  for (let i = 0; i < INBOX_KEYS.length; i++) {
    const inboxKey = INBOX_KEYS[i];
    for (const m of (folders[i].inbox || [])) {
      if (!isAlert(m)) continue;
      matches.push({
        subject: m.subject || '(no subject)',
        sender: m.from?.emailAddress?.address || 'unknown',
        received_iso: m.receivedDateTime,
        received_ms: new Date(m.receivedDateTime || 0).getTime(),
        inbox: inboxKey,
        message_id: m.id,
      });
    }
  }

  // 24h total and 1h spike count (spike count drives the banner threshold)
  const oneHourCutoff = now - HOUR_MS;
  const alerts24h = matches.length;
  const alerts1h  = matches.filter(a => a.received_ms >= oneHourCutoff).length;

  const status = alerts1h >= threshold ? 'alert' : 'ok';

  // 5 most recent for the banner detail view
  matches.sort((a, b) => b.received_ms - a.received_ms);
  const recent = matches.slice(0, 5).map(a => ({
    subject: a.subject,
    sender: a.sender,
    received_iso: a.received_iso,
    inbox: a.inbox,
    message_id: a.message_id,
  }));

  return {
    alerts_24h: alerts24h,
    alerts_1h: alerts1h,
    threshold,
    status,
    recent_alerts: recent,
  };
}

module.exports = { getItAlerts };
