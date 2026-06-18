/**
 * Hypercare overdue-load notifications — Telegram + Teams (§12.4).
 *
 * Credentials come from environment variables, never from hypercare.json
 * (which is served verbatim to the browser). All three are optional — a
 * channel is simply inactive when its variables are absent, so the dashboard
 * degrades gracefully to "Alerts off" until they are filled in.
 *
 *   TELEGRAM_BOT_TOKEN   bot token from @BotFather
 *   TELEGRAM_CHAT_ID     numeric chat id, or @channelusername
 *   TEAMS_WEBHOOK_URL    Incoming Webhook / Power Automate workflow URL
 */

const axios = require('axios');

const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID || '';
const TEAMS_URL = process.env.TEAMS_WEBHOOK_URL || '';

const REQUEST_TIMEOUT_MS = 5000;

const telegramConfigured = () => Boolean(TG_TOKEN && TG_CHAT);
const teamsConfigured    = () => Boolean(TEAMS_URL);

// Non-secret status — safe to merge into the /api/hypercare/config response.
function notifyStatus() {
  return {
    enabled: telegramConfigured() || teamsConfigured(),
    channels: { telegram: telegramConfigured(), teams: teamsConfigured() },
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build a channel-agnostic message ({ title, lines[] }) for an event.
function composeMessage(event, load, actor) {
  if (event === 'test') {
    return {
      title: '✅ Caffrey Ops — Hypercare test alert',
      lines: [
        'This confirms the overdue-load notification channel is working.',
        actor ? `Triggered by ${actor}.` : '',
      ].filter(Boolean),
    };
  }
  // 'overdue'
  const route = (load.route && (load.route.origin || load.route.destination))
    ? `${load.route.origin || ''} → ${load.route.destination || ''}` : '';
  const value = (load.cargoValue != null)
    ? `€${Number(load.cargoValue).toLocaleString('en-IE')}` : '';
  return {
    title: `🔴 Hypercare: load overdue — ${load.client || 'VIP client'}`,
    lines: [
      load.bookingRef ? `Booking: ${load.bookingRef}` : '',
      load.subject ? `Subject: "${load.subject}"` : '',
      route ? `Route: ${route}` : '',
      value ? `Cargo value: ${value}` : '',
      load.sla ? `SLA: ${load.sla} min — now breached` : '',
      'Open the Hypercare dashboard to action this load.',
    ].filter(Boolean),
  };
}

async function sendTelegram(msg) {
  const text = `<b>${escapeHtml(msg.title)}</b>\n` + msg.lines.map(escapeHtml).join('\n');
  await axios.post(
    `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    { chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true },
    { timeout: REQUEST_TIMEOUT_MS },
  );
}

async function sendTeams(msg) {
  // Classic MessageCard — accepted by Incoming Webhook connectors and by most
  // Power Automate "Teams webhook request" workflows. Adjust the shape here if
  // a specific workflow expects an Adaptive Card instead.
  const card = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: 'E24B4A',
    summary: msg.title,
    title: msg.title,
    text: msg.lines.join('  \n'),
  };
  await axios.post(TEAMS_URL, card, { timeout: REQUEST_TIMEOUT_MS });
}

function logFail(channel, err) {
  const detail = err.response ? `HTTP ${err.response.status}` : (err.code || err.message);
  console.error(`[hypercare-notify] ${channel} send failed: ${detail}`);
}

// Fan out to every configured channel. One channel failing never blocks the
// other; the caller gets { sent[], failed[] } so the UI can report honestly.
async function sendNotification(event, load, actor) {
  const msg = composeMessage(event, load || {}, actor);
  const sent = [], failed = [];
  const tasks = [];
  if (telegramConfigured()) {
    tasks.push(sendTelegram(msg).then(
      () => sent.push('Telegram'),
      (err) => { failed.push('Telegram'); logFail('Telegram', err); }));
  }
  if (teamsConfigured()) {
    tasks.push(sendTeams(msg).then(
      () => sent.push('Teams'),
      (err) => { failed.push('Teams'); logFail('Teams', err); }));
  }
  await Promise.all(tasks);
  return { sent, failed };
}

module.exports = { notifyStatus, sendNotification };
