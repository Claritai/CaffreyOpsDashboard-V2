/* global fetch, URLSearchParams */
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

const PRIORITY_DOMAINS = [
  'maersk.com', 'dhl.com', 'kuehne-nagel.com', 'lidl.ie', 'tesco.com', 'dfds.com',
];

const INBOX_LABELS = {
  operations: 'Operations',
  export: 'Export',
  ireland: 'Ireland',
  uk: 'UK',
  eu: 'EU',
  offers: 'Offers',
};

const REFRESH_INTERVAL_MS = 120_000;

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
  view: 'overview',         // 'overview' | 'inbox' | 'hypercare' | 'settings' | 'topclients'
  activeInbox: 'operations',
  emails: [],
  selectedEmailId: null,
  searchQuery: '',
  refreshTimer: null,
  overviewAnimated: false,  // count-up plays only on the first render
  // Hypercare-specific state
  hypercare: {
    config: null,
    loads: [],
    activity: [],
    statusFilter: null,       // 'red' | 'amber' | 'green' | null
    previouslyRedIds: new Set(),
    redBaselineSet: false,    // first detect pass seeds the baseline, no alerts
    audioEnabled: localStorage.getItem('hypercareAudio') !== 'off',
    audioUnlocked: false,
    audio: null,
    refreshTimer: null,
    countdownInterval: null,
    nextRefreshAt: null,
    demoOverlay: {},          // demo-mode optimistic mutations, keyed by load.id
    tab: 'queue',             // 'queue' (action queue) | 'handover' (shift snapshot)
  },
  settings: {
    panel: 'hypercare',       // active Settings sub-nav panel
  },
  categories: {
    config: null,             // { categories: [...] } from /api/categories/config
  },
  topclients: {
    config: null,             // { clients } from /api/topclients
    expanded: null,           // name of the currently-expanded client, or null
    threadCache: {},          // client name -> threads[] (per-session, drops on refresh)
  },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const loginScreen    = $('login-screen');
const app            = $('app');
const loginBtn       = $('login-btn');
const loginError     = $('login-error');
const logoutBtn      = $('logout-btn');
const userNameEl    = $('user-name');
const emailList     = $('email-list');
const paneTitle     = $('pane-title');
const searchInput   = $('search-input');
const detailEmpty   = $('detail-empty');
const detailContent = $('detail-content');
const detailSubject = $('detail-subject');
const detailFrom    = $('detail-from');
const detailTo      = $('detail-to');
const detailTime    = $('detail-time');
const detailBody    = $('detail-body');
const replyBtn      = $('reply-btn');
const markReadBtn   = $('mark-read-btn');
const backBtn       = $('back-btn');
const composeBtn    = $('compose-btn');
const composeModal  = $('compose-modal');
const modalClose    = $('modal-close');
const modalCancel   = $('modal-cancel');
const modalSend     = $('modal-send');
const modalTitle    = $('modal-title');
const drilldownModal = $('drilldown-modal');
const drilldownTitle = $('drilldown-title');
const drilldownBody  = $('drilldown-body');
const drilldownClose = $('drilldown-close');
const reportsModal   = $('reports-modal');
const reportsFrom    = $('reports-from');
const reportsTo      = $('reports-to');
const reportsType    = $('reports-type');
const reportsJob     = $('reports-job');
const reportsRun     = $('reports-run');
const reportsClose   = $('reports-close');
const reportsCancel  = $('reports-cancel');
const reportsDownload = $('reports-download');
const reportsSummary = $('reports-summary');
const cannedModal    = $('canned-modal');
const cannedClose    = $('canned-close');
const cannedList     = $('canned-list');
const cannedName     = $('canned-name');
const cannedBody     = $('canned-body');
const cannedClear    = $('canned-clear');
const cannedSave     = $('canned-save');
const cannedFormTitle = $('canned-form-title');
const composeInbox  = $('compose-inbox');
const composeTo     = $('compose-to');
const composeCc     = $('compose-cc');
const composeSubject = $('compose-subject');
const composeQueryType      = $('compose-query-type');
const composeQueryTypeGroup = $('compose-query-type-group');
const composeTemplate       = $('compose-template');
const composeTemplateGroup  = $('compose-template-group');
const composeJobNumber      = $('compose-job-number');
const composeJobGroup       = $('compose-job-group');
const composeBody   = $('compose-body');
const statTotalUnread = $('stat-total-unread');
const lastRefreshLabel = $('last-refresh-label');
const contentArea       = document.querySelector('.content-area');
const overviewGrid      = $('overview-grid');
const overviewSubtitle  = $('overview-subtitle');
const overviewRefresh   = $('overview-refresh');
const criticalRow       = $('critical-row');
const categoryRow       = $('category-row');
const performanceRow    = $('performance-row');
const missedRow         = $('missed-row');
const demoToggle        = $('demo-toggle');
const demoChip          = $('demo-chip');
const hypercareSummary  = $('hypercare-summary');
const hypercareQueue    = $('hypercare-queue');
const hypercareSubtitle = $('hypercare-subtitle');
const hypercareRefresh  = $('hypercare-refresh');
const hypercareMuteBtn  = $('hypercare-mute');
const hypercareCountdown = $('hypercare-refresh-countdown');
const hypercareActivity = $('hypercare-activity');
const hypercareActivityFeed = $('hypercare-activity-feed');
const hypercareTabs     = $('hypercare-tabs');
const hypercareHandover = $('hypercare-handover');
const hypercareNotifyPill = $('hypercare-notify-pill');
const badgeHypercareRed = $('badge-hypercare-red');
const settingsSubnav    = $('settings-subnav');
const settingsContent   = $('settings-content');
const tcAdd              = $('tc-add');
const tcList             = $('tc-list');
const topclientsSubtitle = $('topclients-subtitle');
const topclientsRefresh  = $('topclients-refresh');

// ── API helpers ───────────────────────────────────────────────────────────────

// CSRF token, lazy-fetched on first mutation request, refreshed on 403.
let csrfToken = null;
async function getCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  csrfToken = body.csrfToken || null;
  return csrfToken;
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Routes the backend deliberately exempts from CSRF (pre-session OAuth bootstrap
// and the token endpoint itself).
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/csrf-token']);

async function apiFetch(path, opts = {}, _retried = false) {
  const method = (opts.method || 'GET').toUpperCase();
  const needsCsrf = CSRF_METHODS.has(method) && !CSRF_EXEMPT_PATHS.has(path);
  const headers = { ...(opts.headers || {}) };
  if (needsCsrf) {
    const t = await getCsrfToken();
    if (t) headers['X-CSRF-Token'] = t;
  }

  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (!_retried && res.status === 403 && body.code === 'csrf_invalid') {
      await getCsrfToken(true);
      return apiFetch(path, opts, true);
    }
    const message = body.error || `HTTP ${res.status}`;
    const requestId = body.requestId || res.headers.get('X-Request-Id') || null;
    const err = new Error(message);
    err.status = res.status;
    err.code = body.code || null;
    err.requestId = requestId;
    err.graphRequestId = body.graphRequestId || null;
    err.details = body.details || null;
    throw err;
  }
  return res.json();
}

/** Render an error message with code badge + request-id chip for copy-paste. */
function formatErrorMessage(err) {
  const msg = err.message || 'Request failed.';
  const safeMsg = esc(msg);
  const code = err.code ? `<span class="err-code">${esc(err.code)}</span>` : '';
  const reqId = err.requestId ? `<span class="err-reqid" title="Request id">${esc(err.requestId)}</span>` : '';
  return `<span class="err-text">${safeMsg}</span>${code}${reqId}`;
}

/** Auto-redirect to login on auth failures so the user isn't stuck. */
function handleApiError(err) {
  if (err.status === 401) {
    setTimeout(() => { window.location.reload(); }, 1500);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const data = await apiFetch('/api/auth/status');
    if (data.authenticated) {
      showApp(data.user);
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

async function handleLogin() {
  loginBtn.disabled = true;
  loginError.classList.remove('visible');
  try {
    const data = await apiFetch('/api/auth/login', { method: 'POST' });
    window.location.href = data.redirectUrl;
  } catch (err) {
    showLoginError(err.message || 'Could not initiate sign-in. Please try again.');
    loginBtn.disabled = false;
  }
}

async function handleLogout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}

function showLogin() {
  loginScreen.style.display = 'flex';
  app.classList.remove('visible');
  const params = new URLSearchParams(window.location.search);
  const err = params.get('error');
  if (err) {
    showLoginError(decodeURIComponent(err));
    history.replaceState(null, '', '/');
  }
}

function showApp(user) {
  loginScreen.style.display = 'none';
  app.classList.add('visible');
  userNameEl.textContent = user.name || user.email;
  syncDemoStatus(); // pull current demo flag from the server before first render
  showOverview();
  loadStats();
  scheduleRefresh();
}

// ── Demo Mode toggle ─────────────────────────────────────────────────────────

async function syncDemoStatus() {
  try {
    const data = await apiFetch('/api/demo/status');
    setDemoUiState(!!data.demoMode);
  } catch { /* non-fatal: leave button at default */ }
}

function setDemoUiState(on) {
  state.demoMode = on;
  if (demoToggle) demoToggle.textContent = on ? 'Demo: on' : 'Demo: off';
  if (demoToggle) demoToggle.classList.toggle('demo-on', on);
  if (demoChip) demoChip.hidden = !on;
  document.body.classList.toggle('demo-mode', on);
}

async function toggleDemoMode() {
  const want = !state.demoMode;
  demoToggle.disabled = true;
  try {
    const data = await apiFetch(want ? '/api/demo/on' : '/api/demo/off', { method: 'POST' });
    setDemoUiState(!!data.demoMode);
    // Reload everything so the dashboard re-renders against the new mode.
    resetDemoOverlay();
    if (state.view === 'overview') loadOverview();
    else if (state.view === 'hypercare') {
      state.hypercare.previouslyRedIds = new Set();
      loadHypercare(true);
      loadHypercareActivity();
    }
    loadStats();
  } catch (err) {
    errorToast('Demo toggle failed', err);
  } finally {
    demoToggle.disabled = false;
  }
}

if (demoToggle) demoToggle.addEventListener('click', toggleDemoMode);

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.add('visible');
}

// ── Email loading ─────────────────────────────────────────────────────────────

async function loadInbox(inboxKey, append = false) {
  state.activeInbox = inboxKey;
  state.selectedEmailId = null;
  paneTitle.textContent = INBOX_LABELS[inboxKey] || inboxKey;
  composeInbox.value = inboxKey;

  document.querySelectorAll('.inbox-item').forEach(el => {
    el.classList.toggle('active', el.dataset.inbox === inboxKey);
  });

  hideDetail();

  if (!append) {
    renderSkeletons();
    state.emails = [];
  }

  try {
    const params = new URLSearchParams({ top: 50 });
    if (state.searchQuery) params.set('search', state.searchQuery);
    const data = await apiFetch(`/api/emails/${inboxKey}?${params}`);
    state.emails = data.value || [];
    renderEmailList(state.emails);
    updateLastRefresh();
  } catch (err) {
    emailList.innerHTML = `<div class="inline-error">Failed to load emails: ${formatErrorMessage(err)}</div>`;
    handleApiError(err);
  }
}

async function loadStats() {
  try {
    const data = await apiFetch('/api/dashboard/stats');
    statTotalUnread.textContent = data.totalUnread ?? '—';
    for (const [key, count] of Object.entries(data.unread || {})) {
      const badge = $(`badge-${key}`);
      if (badge) {
        badge.textContent = count;
        badge.classList.toggle('zero', count === 0);
      }
    }
  } catch { /* non-fatal */ }
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.view === 'overview') loadOverview();
    else if (state.view === 'hypercare') { /* its own faster timer */ }
    else if (state.view === 'settings') { /* static — nothing to refresh */ }
    else if (state.view === 'topclients') { /* on-demand only — use Refresh */ }
    else loadInbox(state.activeInbox);
    loadStats();
  }, REFRESH_INTERVAL_MS);
}

function updateLastRefresh(iso) {
  const at = iso || new Date().toISOString();
  state.lastRefreshAt = at;
  lastRefreshLabel.dataset.cachedAt = at;
  lastRefreshLabel.textContent = `Updated ${relTime(at)}`;
}

// Tick the sidebar's "Last refresh" indicator too.
setInterval(() => {
  if (lastRefreshLabel && lastRefreshLabel.dataset.cachedAt) {
    lastRefreshLabel.textContent = `Updated ${relTime(lastRefreshLabel.dataset.cachedAt)}`;
  }
}, 10_000);

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderEmailList(emails) {
  if (emails.length === 0) {
    emailList.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px;">No emails found.</div>';
    return;
  }
  emailList.innerHTML = emails.map(renderEmailItem).join('');
  emailList.querySelectorAll('.email-item').forEach(el => {
    el.addEventListener('click', () => openEmail(el.dataset.id));
  });
}

function renderEmailItem(email) {
  const isRead = email.isRead;
  const sender = email.from?.emailAddress?.name || email.from?.emailAddress?.address || 'Unknown';
  const senderEmail = (email.from?.emailAddress?.address || '').toLowerCase();
  const subject = email.subject || '(no subject)';
  const preview = email.bodyPreview || '';
  const time = formatTime(email.receivedDateTime);
  const isHighImportance = email.importance === 'high';
  const isPriority = PRIORITY_DOMAINS.some(d => senderEmail.endsWith(d));
  const hasAttachment = email.hasAttachments;

  const badges = [
    isPriority ? `<span class="priority-badge client">Priority Client</span>` : '',
    isHighImportance ? `<span class="priority-badge high">Urgent</span>` : '',
    hasAttachment ? `<span class="priority-badge attachment">📎</span>` : '',
  ].join('');

  return `<div class="email-item${isRead ? '' : ' unread'}${isPriority ? ' priority-client' : ''}" data-id="${esc(email.id)}">
    <div class="email-item-top">
      <span class="email-sender">${esc(sender)}</span>
      <span class="email-time">${time}</span>
    </div>
    <div class="email-subject">${esc(subject)}</div>
    <div class="email-preview">${esc(preview)}</div>
    ${badges ? `<div class="email-badges">${badges}</div>` : ''}
  </div>`;
}

function renderSkeletons(count = 8) {
  emailList.innerHTML = Array.from({ length: count }, () =>
    `<div class="skeleton-row">
      <div class="skeleton skel-line w60"></div>
      <div class="skeleton skel-line w80"></div>
      <div class="skeleton skel-line w40"></div>
    </div>`
  ).join('');
}

// ── Email detail ──────────────────────────────────────────────────────────────

async function openEmail(id) {
  state.selectedEmailId = id;

  emailList.querySelectorAll('.email-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  detailEmpty.style.display = 'none';
  detailContent.classList.add('visible');

  detailSubject.textContent = '…';
  detailFrom.textContent = '';
  detailTo.textContent = '';
  detailTime.textContent = '';
  detailBody.innerHTML = '<div class="skeleton skel-line w80" style="margin:8px 0"></div><div class="skeleton skel-line w60"></div>';

  // On mobile, show detail pane
  $('email-detail-pane').classList.add('mobile-visible');
  backBtn.style.display = 'inline-flex';

  try {
    const email = await apiFetch(`/api/emails/${state.activeInbox}/${encodeURIComponent(id)}`);
    renderDetail(email);

    // Mark as read in local state
    const local = state.emails.find(e => e.id === id);
    if (local && !local.isRead) {
      local.isRead = true;
      apiFetch(`/api/emails/${state.activeInbox}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      }).catch(() => {});
      renderEmailList(state.emails);
      emailList.querySelectorAll('.email-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === id);
      });
    }
  } catch (err) {
    detailBody.innerHTML = `<div class="inline-error">Failed to load email: ${formatErrorMessage(err)}</div>`;
    handleApiError(err);
  }
}

function renderDetail(email) {
  const sender = email.from?.emailAddress?.name
    ? `${email.from.emailAddress.name} <${email.from.emailAddress.address}>`
    : (email.from?.emailAddress?.address || 'Unknown');

  const to = (email.toRecipients || [])
    .map(r => r.emailAddress?.name || r.emailAddress?.address || '')
    .join(', ');

  detailSubject.textContent = email.subject || '(no subject)';
  detailFrom.textContent = sender;
  detailTo.textContent = to;
  detailTime.textContent = email.receivedDateTime
    ? new Date(email.receivedDateTime).toLocaleString()
    : '';

  markReadBtn.textContent = email.isRead ? 'Mark unread' : 'Mark read';
  markReadBtn.dataset.currentRead = email.isRead ? '1' : '0';

  if (email.body?.contentType === 'html') {
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-body-html';
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin';
    iframe.style.cssText = 'width:100%;border:none;min-height:400px;';
    wrapper.appendChild(iframe);
    detailBody.innerHTML = '';
    detailBody.appendChild(wrapper);
    iframe.srcdoc = email.body.content;
    iframe.onload = () => {
      iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px';
    };
  } else {
    detailBody.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit">${esc(email.body?.content || '')}</pre>`;
  }

  // Store for reply
  replyBtn.dataset.subject = email.subject || '';
  replyBtn.dataset.to = email.from?.emailAddress?.address || '';
}

function hideDetail() {
  detailEmpty.style.display = 'flex';
  detailContent.classList.remove('visible');
  $('email-detail-pane').classList.remove('mobile-visible');
  backBtn.style.display = 'none';
}

// ── Mark read / unread ────────────────────────────────────────────────────────

markReadBtn.addEventListener('click', async () => {
  if (!state.selectedEmailId) return;
  const isRead = markReadBtn.dataset.currentRead === '1';
  try {
    await apiFetch(`/api/emails/${state.activeInbox}/${encodeURIComponent(state.selectedEmailId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: !isRead }),
    });
    markReadBtn.dataset.currentRead = isRead ? '0' : '1';
    markReadBtn.textContent = isRead ? 'Mark read' : 'Mark unread';
    const local = state.emails.find(e => e.id === state.selectedEmailId);
    if (local) { local.isRead = !isRead; renderEmailList(state.emails); }
    loadStats();
  } catch (err) {
    errorToast('Update failed', err);
  }
});

backBtn.addEventListener('click', hideDetail);

// ── Compose / Reply ───────────────────────────────────────────────────────────

function openCompose(opts = {}) {
  modalTitle.textContent = opts.reply ? 'Reply' : 'New Message';
  composeInbox.value = state.activeInbox;
  composeTo.value = opts.to || '';
  composeSubject.value = opts.subject || '';
  composeBody.value = opts.body || '';
  // Query type + canned responses are only relevant when replying.
  composeQueryTypeGroup.hidden = !opts.reply;
  composeQueryType.value = '';
  composeJobGroup.hidden = !opts.reply;
  composeJobNumber.value = '';
  composeTemplateGroup.hidden = !opts.reply;
  composeTemplate.value = '';
  if (opts.reply) populateTemplateDropdown();
  composeModal.classList.add('visible');
  composeTo.focus();
}

composeBtn.addEventListener('click', () => openCompose());

replyBtn.addEventListener('click', () => {
  openCompose({
    reply: true,
    to: replyBtn.dataset.to,
    subject: replyBtn.dataset.subject?.startsWith('Re:')
      ? replyBtn.dataset.subject
      : `Re: ${replyBtn.dataset.subject}`,
  });
});

function closeCompose() {
  composeModal.classList.remove('visible');
  composeTo.value = '';
  composeSubject.value = '';
  composeBody.value = '';
  composeCc.value = '';
  composeQueryType.value = '';
  composeQueryTypeGroup.hidden = true;
  composeJobNumber.value = '';
  composeJobGroup.hidden = true;
  composeTemplate.value = '';
  composeTemplateGroup.hidden = true;
}

modalClose.addEventListener('click', closeCompose);
modalCancel.addEventListener('click', closeCompose);

// ── Canned responses ──────────────────────────────────────────────────────────
// Templates are fetched once and cached. The reply box gets a "Canned responses"
// dropdown listing them; picking one drops it into the message box (confirming
// first if the operator already typed something), then resets so it reads as an
// action rather than a sticky selection.
let replyTemplates = null;
async function ensureReplyTemplates() {
  if (replyTemplates) return replyTemplates;
  try {
    const data = await apiFetch('/api/reply-templates');
    replyTemplates = (data && data.templates) || {};
  } catch {
    replyTemplates = {};
  }
  return replyTemplates;
}

async function populateTemplateDropdown() {
  const templates = await ensureReplyTemplates();
  const names = Object.keys(templates);
  const opts = ['<option value="">Insert a canned response…</option>']
    .concat(names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`));
  composeTemplate.innerHTML = opts.join('');
  // Hide the control entirely if no templates are configured.
  composeTemplateGroup.hidden = names.length === 0 || composeQueryTypeGroup.hidden;
}

composeTemplate.addEventListener('change', async () => {
  const name = composeTemplate.value;
  if (!name) return;
  const templates = await ensureReplyTemplates();
  const tpl = templates[name];
  if (tpl) {
    const current = composeBody.value.trim();
    if (current && current !== tpl.trim() && !confirm(`Replace the current message with the “${name}” response?`)) {
      composeTemplate.value = '';
      return;
    }
    composeBody.value = tpl;
    composeBody.focus();
  }
  composeTemplate.value = ''; // reset to the placeholder after inserting
});
composeModal.addEventListener('click', e => { if (e.target === composeModal) closeCompose(); });

modalSend.addEventListener('click', async () => {
  const to = composeTo.value.trim();
  const subject = composeSubject.value.trim();
  const body = composeBody.value.trim();
  const cc = composeCc.value.trim();
  const inbox = composeInbox.value;
  const isReply = !composeQueryTypeGroup.hidden;
  const queryType = composeQueryType.value;
  const jobNumber = composeJobNumber.value.trim();

  if (!to || !subject || !body) {
    toast('Please fill in To, Subject, and Message.', 'error');
    return;
  }

  if (isReply && !queryType) {
    toast('Please choose a query type for this reply.', 'error');
    composeQueryType.focus();
    return;
  }

  if (isReply && !jobNumber) {
    toast('Please enter a job number for this reply.', 'error');
    composeJobNumber.focus();
    return;
  }

  modalSend.disabled = true;
  modalSend.textContent = 'Sending…';

  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: cc ? [{ emailAddress: { address: cc } }] : [],
  };

  try {
    await apiFetch('/api/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // queryType/jobNumber are null for new messages.
      body: JSON.stringify({ inbox, message, queryType: queryType || null, jobNumber: jobNumber || null }),
    });
    toast(queryType ? `Reply sent · tagged “${queryType}”${jobNumber ? ` · job ${jobNumber}` : ''}.` : 'Message sent.', 'success');
    closeCompose();
  } catch (err) {
    errorToast('Send failed', err);
  } finally {
    modalSend.disabled = false;
    modalSend.textContent = 'Send';
  }
});

// ── Reports (query-type) ──────────────────────────────────────────────────────

// date inputs are YYYY-MM-DD; expand to inclusive UTC day bounds for the API.
function reportsRangeQuery() {
  const qs = new URLSearchParams();
  if (reportsFrom.value) qs.set('from', `${reportsFrom.value}T00:00:00.000Z`);
  if (reportsTo.value)   qs.set('to',   `${reportsTo.value}T23:59:59.999Z`);
  if (reportsType.value) qs.set('queryType', reportsType.value);
  if (reportsJob.value.trim()) qs.set('jobNumber', reportsJob.value.trim());
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// Keep the filter list in sync with the reply dropdown automatically by cloning
// its options (relabelling the empty one as "All query types").
function populateReportTypeFilter() {
  const opts = Array.from(document.querySelectorAll('#compose-query-type option'));
  if (!opts.length) return;
  const current = reportsType.value;
  reportsType.innerHTML = opts.map((o, i) =>
    i === 0
      ? '<option value="">All query types</option>'
      : `<option value="${esc(o.value)}">${esc(o.textContent)}</option>`
  ).join('');
  reportsType.value = current; // preserve selection across reopens
}

function openReports() {
  populateReportTypeFilter();
  // default range: first of the current month → today
  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  reportsFrom.value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  reportsTo.value = iso(now);
  reportsJob.value = '';
  reportsModal.classList.add('visible');
  runReport();
}

function closeReports() {
  reportsModal.classList.remove('visible');
}

async function runReport() {
  reportsSummary.innerHTML = '<p class="form-label">Loading…</p>';
  try {
    const data = await apiFetch(`/api/reports/query-types${reportsRangeQuery()}`);
    if (!data.byType || data.byType.length === 0) {
      reportsSummary.innerHTML = '<p class="form-label">No tagged replies in this range yet.</p>';
      return;
    }
    const cellL = 'padding:6px 10px;';
    const cellR = 'padding:6px 10px; text-align:right; color:var(--brand-cream);';
    const th = 'padding:6px 10px; color:var(--text-muted); text-transform:uppercase; font-size:10px; letter-spacing:1.2px;';
    const body = data.byType.map(r =>
      `<tr><td style="${cellL}">${esc(r.queryType)}</td><td style="${cellR}">${r.count}</td></tr>`
    ).join('');
    const tableHtml =
      `<table style="width:100%; border-collapse:collapse; font-size:13px;">` +
      `<thead><tr><th style="text-align:left; ${th}">Query type</th>` +
      `<th style="text-align:right; ${th}">Replies</th></tr></thead>` +
      `<tbody>${body}</tbody>` +
      `<tfoot><tr style="border-top:1px solid var(--border-default);">` +
      `<td style="${cellL} font-weight:500;">Total</td>` +
      `<td style="${cellR} font-weight:500;">${data.total}</td></tr></tfoot></table>`;

    // Reply list: the individual replies behind the counts, newest first.
    const rows = data.rows || [];
    const MAX = 100;
    const items = rows.slice(0, MAX).map(r => {
      let d = {};
      try { d = r.detail ? JSON.parse(r.detail) : {}; } catch { /* leave d empty */ }
      const when = new Date(r.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const subject = d.subject || '(no subject)';
      const meta = [r.user, d.inbox, r.queryType, r.jobNumber].filter(Boolean).map(esc).join(' · ');
      return `<div style="padding:8px 10px; border-bottom:1px solid var(--border-subtle);">
        <div style="font-size:13px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(subject)}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${esc(when)} · ${meta}</div>
      </div>`;
    }).join('');
    const moreNote = rows.length > MAX
      ? `<p class="form-label" style="margin-top:8px;">Showing the most recent ${MAX}. Download CSV for all ${data.total}.</p>`
      : '';
    const listHtml = `<div style="margin-top:18px;">
      <p class="form-label" style="margin-bottom:6px;">Replies (newest first)</p>
      <div style="max-height:280px; overflow-y:auto; border:1px solid var(--border-default); border-radius:6px;">${items}</div>
      ${moreNote}
    </div>`;

    reportsSummary.innerHTML = tableHtml + listHtml;
  } catch (err) {
    reportsSummary.innerHTML =
      `<p class="form-label" style="color:var(--status-danger);">Couldn’t load report: ${esc(err.message)}</p>`;
  }
}

function downloadReportCsv() {
  // same-origin navigation carries the session cookie; the attachment header
  // makes the browser download rather than navigate away.
  window.location.href = `/api/reports/query-types.csv${reportsRangeQuery()}`;
}

reportsRun.addEventListener('click', runReport);
reportsType.addEventListener('change', runReport);
reportsJob.addEventListener('keydown', e => { if (e.key === 'Enter') runReport(); });
reportsDownload.addEventListener('click', downloadReportCsv);
reportsClose.addEventListener('click', closeReports);
reportsCancel.addEventListener('click', closeReports);
reportsModal.addEventListener('click', e => { if (e.target === reportsModal) closeReports(); });

// ── Canned responses manager ──────────────────────────────────────────────────
let cannedEditingName = null;

function openCannedManager() {
  resetCannedForm();
  cannedModal.classList.add('visible');
  renderCannedList();
}
function closeCannedManager() {
  cannedModal.classList.remove('visible');
}
function resetCannedForm() {
  cannedEditingName = null;
  cannedName.value = '';
  cannedBody.value = '';
  cannedFormTitle.textContent = 'Add a new response';
  cannedSave.textContent = 'Save response';
}

async function renderCannedList() {
  cannedList.innerHTML = '<p class="form-label">Loading…</p>';
  try {
    const data = await apiFetch('/api/reply-templates');
    const templates = (data && data.templates) || {};
    const names = Object.keys(templates);
    if (!names.length) {
      cannedList.innerHTML = '<p class="form-label">No canned responses yet. Add one below.</p>';
      return;
    }
    cannedList.innerHTML = names.map(name => {
      const preview = templates[name].replace(/\s+/g, ' ').slice(0, 80);
      return `<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border);">
        <div style="min-width:0;">
          <div style="font-weight:500; color:var(--text-primary);">${esc(name)}</div>
          <div style="font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(preview)}…</div>
        </div>
        <div style="flex-shrink:0; display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-canned-edit="${esc(name)}">Edit</button>
          <button class="btn btn-secondary btn-sm" data-canned-del="${esc(name)}">Delete</button>
        </div>
      </div>`;
    }).join('');
    cannedList.querySelectorAll('[data-canned-edit]').forEach(b =>
      b.addEventListener('click', () => editCanned(b.dataset.cannedEdit, templates[b.dataset.cannedEdit])));
    cannedList.querySelectorAll('[data-canned-del]').forEach(b =>
      b.addEventListener('click', () => deleteCanned(b.dataset.cannedDel)));
  } catch (err) {
    cannedList.innerHTML = `<p class="form-label" style="color:var(--status-danger);">Couldn’t load responses: ${esc(err.message)}</p>`;
  }
}

function editCanned(name, body) {
  cannedEditingName = name;
  cannedName.value = name;
  cannedBody.value = body;
  cannedFormTitle.textContent = `Editing “${name}”`;
  cannedSave.textContent = 'Update response';
  cannedBody.focus();
}

async function deleteCanned(name) {
  if (!confirm(`Delete the canned response “${name}”?`)) return;
  try {
    await apiFetch(`/api/reply-templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
    replyTemplates = null; // invalidate the reply-box cache so the dropdown updates
    toast('Canned response deleted.', 'success');
    if (cannedEditingName === name) resetCannedForm();
    renderCannedList();
  } catch (err) {
    errorToast('Delete failed', err);
  }
}

async function saveCanned() {
  const name = cannedName.value.trim();
  const body = cannedBody.value;
  if (!name || !body.trim()) { toast('Name and response are both required.', 'error'); return; }
  cannedSave.disabled = true;
  try {
    await apiFetch('/api/reply-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, body }),
    });
    // renaming an existing response: remove the old key after writing the new one
    if (cannedEditingName && cannedEditingName !== name) {
      await apiFetch(`/api/reply-templates/${encodeURIComponent(cannedEditingName)}`, { method: 'DELETE' });
    }
    replyTemplates = null; // invalidate the reply-box cache
    toast('Canned response saved.', 'success');
    resetCannedForm();
    renderCannedList();
  } catch (err) {
    errorToast('Save failed', err);
  } finally {
    cannedSave.disabled = false;
  }
}

cannedSave.addEventListener('click', saveCanned);
cannedClear.addEventListener('click', resetCannedForm);
cannedClose.addEventListener('click', closeCannedManager);
cannedModal.addEventListener('click', e => { if (e.target === cannedModal) closeCannedManager(); });

// ── Sidebar navigation ────────────────────────────────────────────────────────

document.querySelectorAll('.inbox-item').forEach(el => {
  el.addEventListener('click', () => {
    if (el.dataset.view === 'overview') { showOverview(); return; }
    if (el.dataset.view === 'hypercare') { showHypercare(); return; }
    if (el.dataset.view === 'topclients') { showTopClients(); return; }
    if (el.dataset.view === 'reports') { openReports(); return; }
    if (el.dataset.view === 'canned') { openCannedManager(); return; }
    if (el.dataset.view === 'settings') { showSettings(); return; }
    const key = el.dataset.inbox;
    if (key) {
      state.searchQuery = '';
      searchInput.value = '';
      showInbox(key);
    }
  });
});

if (overviewRefresh) overviewRefresh.addEventListener('click', () => {
  // Manual click bypasses every endpoint's server-side cache.
  loadOverview(true);
  loadStats();
});

// ── View switching ────────────────────────────────────────────────────────────

function setActiveSidebar(selector) {
  document.querySelectorAll('.inbox-item').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(selector);
  if (el) el.classList.add('active');
}

const VIEW_CLASSES = [
  'view-overview', 'view-inbox',
  'view-hypercare', 'view-settings', 'view-topclients',
];

// Switch the content area to a single view, clearing every other view class.
// Replaces the hand-maintained add/remove pairs that grew fragile as views
// were added — each new view only needs to extend VIEW_CLASSES.
function setContentView(viewClass) {
  contentArea.classList.remove(...VIEW_CLASSES);
  contentArea.classList.add(viewClass);
}

function showOverview() {
  state.view = 'overview';
  setContentView('view-overview');
  setActiveSidebar('.inbox-item[data-view="overview"]');
  stopHypercareTimers();
  loadOverview();
}

function showInbox(inboxKey) {
  state.view = 'inbox';
  setContentView('view-inbox');
  setActiveSidebar(`.inbox-item[data-inbox="${inboxKey}"]`);
  stopHypercareTimers();
  loadInbox(inboxKey);
}

function showHypercare() {
  state.view = 'hypercare';
  setContentView('view-hypercare');
  setActiveSidebar('.inbox-item[data-view="hypercare"]');
  setHypercareTab('queue');   // always open on the live queue
  loadHypercareConfig().then(() => {
    loadHypercare(true);
    loadHypercareActivity();
    startHypercareTimers();
  });
}

function showSettings() {
  state.view = 'settings';
  setContentView('view-settings');
  setActiveSidebar('.inbox-item[data-view="settings"]');
  stopHypercareTimers();
  renderSettings();
}

function showTopClients() {
  state.view = 'topclients';
  setContentView('view-topclients');
  setActiveSidebar('.inbox-item[data-view="topclients"]');
  stopHypercareTimers();
  loadTopClients();
}

// ── Overview loading + rendering ─────────────────────────────────────────────

async function loadOverview(force = false) {
  renderOverviewSkeleton();
  renderCriticalSkeleton();
  // Fire all in parallel — none needs to block the others. Errors are
  // surfaced inline per widget so one slow tier doesn't kill the page.
  loadClientHealth(force);
  loadCategories(force);
  loadPerformance(force);
  loadMissed(force);
  try {
    const data = await apiFetch(withForce('/api/dashboard/overview', force));
    renderOverview(data);
    updateLastRefresh(data.cachedAt || data.generatedAt);
  } catch (err) {
    overviewGrid.innerHTML =
      `<div class="tile wide inline-error" style="text-align:center;">
         Failed to load overview: ${formatErrorMessage(err)}
       </div>`;
    handleApiError(err);
  }
}

/** Append ?refresh=1 to a URL when the caller wants a cache bypass. */
function withForce(url, force) {
  if (!force) return url;
  return url + (url.includes('?') ? '&' : '?') + 'refresh=1';
}

// ── Critical Row: Client Health Grid + Revenue at Risk ───────────────────────

async function loadClientHealth(force = false) {
  try {
    const data = await apiFetch(withForce('/api/dashboard/client-health', force));
    renderCriticalRow(data);
    stampUpdated('critical-row', data.cachedAt);
  } catch (err) {
    criticalRow.innerHTML =
      `<div class="critical-tile inline-error" style="grid-column:1/-1;text-align:center;">
         Failed to load client health: ${formatErrorMessage(err)}
       </div>`;
    handleApiError(err);
  }
}

function renderCriticalSkeleton() {
  criticalRow.innerHTML = `
    <div class="critical-tile client-health-tile">
      <div class="tile-head">
        <div class="skeleton skel-line w40"></div>
        <div class="skeleton skel-line w20"></div>
      </div>
      <div class="client-grid">
        ${Array.from({ length: 6 }, () => `<div class="skeleton client-skel"></div>`).join('')}
      </div>
    </div>
  `;
}

function renderCriticalRow(data) {
  criticalRow.innerHTML = renderClientHealthGrid(data);
  wireClientTileClicks();
}

const GREEN_COLLAPSE_THRESHOLD = 5;

function renderClientHealthGrid(data) {
  const clients = data.clients || [];
  const summary = data.summary || { green: 0, amber: 0, red: 0 };

  const red    = clients.filter(c => c.status === 'red');
  const amber  = clients.filter(c => c.status === 'amber');
  const green  = clients.filter(c => c.status === 'green');

  const visibleTiles = [...red, ...amber];
  // If >5 greens, collapse them into a single summary pill at the end.
  const collapseGreens = green.length > GREEN_COLLAPSE_THRESHOLD;
  const greensToShow   = collapseGreens ? [] : green;

  const tilesHtml = [
    ...visibleTiles.map(clientTileHtml),
    ...greensToShow.map(clientTileHtml),
  ].join('');

  const collapsedPill = collapseGreens
    ? `<div class="client-card green collapsed-pill" title="All ${green.length} green clients within SLA">
         <div class="client-status">✓</div>
         <div class="client-name">${green.length} clients<br>all green</div>
       </div>`
    : '';

  return `<div class="critical-tile client-health-tile">
    <div class="tile-head">
      <span class="tile-label">Top Client Status</span>
      <span class="tile-counts">
        <span class="count green" title="Within SLA">${summary.green} ✓</span>
        <span class="count amber" title="Approaching SLA">${summary.amber} ●</span>
        <span class="count red" title="Past SLA">${summary.red} ✕</span>
      </span>
    </div>
    <div class="client-grid">${tilesHtml}${collapsedPill}</div>
  </div>`;
}

function clientTileHtml(c) {
  const status = c.status; // green | amber | red
  const icon = status === 'red' ? '✕' : status === 'amber' ? '●' : '✓';
  const wait = (status === 'red' || status === 'amber')
    ? `${formatHours(c.oldest_waiting_hours)} waiting`
    : '';
  const clickable = (status === 'red' || status === 'amber') && c.jump;
  const jumpAttr = clickable
    ? `data-jump-inbox="${esc(c.jump.inbox)}" data-jump-id="${esc(c.jump.message_id)}"`
    : '';
  const subjectAttr = c.latest_subject ? `title="${esc(c.latest_subject)}"` : '';
  return `<div class="client-card ${status}${clickable ? ' clickable' : ''}" ${jumpAttr} ${subjectAttr}>
    <div class="client-name">${esc(c.name)}</div>
    <div class="client-status">
      <span class="status-icon">${icon}</span>
      ${wait ? `<span class="status-wait">${esc(wait)}</span>` : ''}
    </div>
  </div>`;
}

function formatHours(h) {
  if (h == null) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function wireClientTileClicks() {
  criticalRow.querySelectorAll('.client-card.clickable').forEach(el => {
    el.addEventListener('click', () => {
      const inbox = el.dataset.jumpInbox;
      const id    = el.dataset.jumpId;
      if (!inbox || !id) return;
      showInbox(inbox);
      // openEmail uses state.activeInbox, which showInbox just set synchronously.
      openEmail(id);
    });
  });
}

// ── Category Row (Phase 2 Session 2) ─────────────────────────────────────────

// Show every configured category, even at open_count === 0 (shown as "No
// open items"). Live and demo views now render the same 5 cards.

async function loadCategories(force = false) {
  categoryRow.innerHTML = renderCategorySkeleton();
  try {
    const data = await apiFetch(withForce('/api/dashboard/categories', force));
    renderCategoryRow(data);
    // Categories is a multi-card row — relies on the global "Last refresh"
    // indicator instead of per-widget timestamps.
  } catch (err) {
    categoryRow.innerHTML =
      `<div class="category-card inline-error" style="grid-column:1/-1;text-align:center;">
         Failed to load categories: ${formatErrorMessage(err)}
       </div>`;
    handleApiError(err);
  }
}

function renderCategorySkeleton() {
  return Array.from({ length: 4 }, () => `
    <div class="category-card skeleton-card">
      <div class="skeleton skel-line w60"></div>
      <div class="skeleton skel-line w40" style="margin-top:10px;height:22px;"></div>
      <div class="skeleton skel-line w80" style="margin-top:10px;"></div>
    </div>`).join('');
}

function renderCategoryRow(data) {
  const cats = data.categories || [];
  if (cats.length === 0) {
    categoryRow.innerHTML = '';
    return;
  }
  categoryRow.innerHTML = cats.map(renderCategoryCard).join('');
  categoryRow.querySelectorAll('[data-drill-category]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.drillCategory;
      const label = el.dataset.drillLabel;
      openDrilldown({ title: `Category — ${label}`, url: `/api/dashboard/categories/${encodeURIComponent(id)}/messages` });
    });
  });
}

function renderCategoryCard(c) {
  const tone = c.urgent_count > 0 ? 'alert'
             : c.open_count === 0 ? 'ok'
             : 'info';
  const oldest = c.open_count > 0 ? `Oldest: ${formatHours(c.oldest_hours)}` : 'No open items';
  const urgent = c.urgent_count > 0
    ? `<div class="cat-urgent"><span class="urgent-dot"></span>${c.urgent_count} urgent</div>`
    : '';
  const clickable = c.open_count > 0;
  return `<div class="category-card tone-${tone}${clickable ? ' clickable' : ''}"
       style="--cat-color:${esc(c.color)}"
       ${clickable ? `data-drill-category="${esc(c.id)}" data-drill-label="${esc(c.label)}" title="Click to see ${c.open_count} open thread${c.open_count === 1 ? '' : 's'}"` : ''}>
    <div class="cat-head">
      <span class="cat-icon">${esc(c.icon || '')}</span>
      <span class="cat-label">${esc(c.label)}</span>
    </div>
    <div class="cat-count">${c.open_count}</div>
    <div class="cat-sub">${c.open_count === 1 ? 'open thread' : 'open threads'}</div>
    ${urgent}
    <div class="cat-oldest">${esc(oldest)}</div>
  </div>`;
}

function labelForCategory(id) {
  const map = {
    pharma: 'PHARMA', high_priority: 'HIGH PRIORITY', quotes: 'QUOTE',
    new_customers: 'NEW CUSTOMER', finance: 'FINANCE', it_alerts: 'IT LOAD',
  };
  return map[id] || id.toUpperCase();
}

// ── Performance Metrics Row (Phase 2 Session 3) ─────────────────────────────

async function loadPerformance(force = false) {
  performanceRow.innerHTML = renderPerformanceSkeleton();
  try {
    const data = await apiFetch(withForce('/api/dashboard/performance', force));
    renderPerformance(data);
  } catch (err) {
    performanceRow.innerHTML =
      `<div class="perf-card inline-error" style="grid-column:1/-1;text-align:center;">
         Failed to load performance: ${formatErrorMessage(err)}
       </div>`;
    handleApiError(err);
  }
}

function renderPerformanceSkeleton() {
  return Array.from({ length: 3 }, () => `
    <div class="perf-card">
      <div class="skeleton skel-line w40"></div>
      <div class="skeleton skel-line w60" style="margin-top:10px;height:24px;"></div>
      <div class="skeleton skel-line w80" style="margin-top:10px;"></div>
    </div>`).join('');
}

function renderPerformance(d) {
  const cards = [
    perfAvgResponseCard(d.avg_response_time),
    perfFirstReplyCard(d.first_response_rate),
    perfInboundCard(d.by_inbox),
  ];
  performanceRow.innerHTML = cards.join('');
  wireOverviewJumpClicks(performanceRow);
  performanceRow.querySelectorAll('[data-drill-firstreply]').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't fire if the click came from a nested .perf-inbox-jump
      if (e.target.closest('.perf-inbox-jump')) return;
      const bucket = el.dataset.drillFirstreply;
      const title = bucket === 'met' ? 'First reply — within SLA (today)' : 'First reply — missed SLA (today)';
      openDrilldown({ title, url: `/api/dashboard/first-reply/${encodeURIComponent(bucket)}/messages` });
    });
  });
}

/**
 * Generic click-to-jump wiring for any element with [data-jump-inbox] (and
 * optionally [data-jump-id]) inside the given container. Called from
 * renderOverview() and renderPerformance() after each re-render. In demo
 * mode, jumps that include an id will toast since demo emails aren't
 * real Graph messages — the inbox-only jump still navigates.
 */
function wireOverviewJumpClicks(container) {
  container.querySelectorAll('[data-jump-inbox]').forEach(el => {
    if (el.dataset.jumpWired === '1') return;
    el.dataset.jumpWired = '1';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const inbox = el.dataset.jumpInbox;
      const id = el.dataset.jumpId;
      if (!inbox) return;
      if (id) {
        if (state.demoMode) {
          const subj = el.querySelector('.hero-subject')?.textContent || 'email';
          toast(`Demo: would open "${subj}" in ${inboxLabel(inbox)}`, 'info');
          return;
        }
        showInbox(inbox);
        openEmail(id);
      } else {
        showInbox(inbox);
      }
    });
  });
}

// ── Drilldown modal ─────────────────────────────────────────────────────────
// Reusable list-of-messages drawer. All three Overview drilldowns
// (category / inbound-by-day / first-reply bucket) call openDrilldown()
// with a different URL; the backend returns {meta, items, totalCount} in
// a shared shape, so this single renderer handles all of them.

function openDrilldown({ title, url }) {
  drilldownTitle.textContent = title || 'Drilldown';
  drilldownBody.innerHTML = `<div class="drilldown-loading">Loading…</div>`;
  drilldownModal.classList.add('visible');

  apiFetch(url).then(data => {
    renderDrilldown(data);
  }).catch(err => {
    drilldownBody.innerHTML = `<div class="inline-error">Failed to load: ${formatErrorMessage(err)}</div>`;
    handleApiError(err);
  });
}

function closeDrilldown() {
  drilldownModal.classList.remove('visible');
  drilldownBody.innerHTML = '';
}

function renderDrilldown(data) {
  const items = data.items || [];
  if (items.length === 0) {
    drilldownBody.innerHTML = `<div class="drilldown-empty">No matching emails.</div>`;
    return;
  }
  const rowsHtml = items.map(renderDrilldownRow).join('');
  const trimmed = data.totalCount > items.length
    ? `<div class="drilldown-foot">Showing ${items.length} of ${data.totalCount}</div>` : '';
  drilldownBody.innerHTML = `<div class="drilldown-list">${rowsHtml}</div>${trimmed}`;
  drilldownBody.querySelectorAll('.drilldown-row').forEach(el => {
    el.addEventListener('click', () => {
      const inbox = el.dataset.inbox;
      const id = el.dataset.id;
      if (state.demoMode) {
        toast(`Demo: would open "${el.dataset.subject}" in ${inboxLabel(inbox)}`, 'info');
        closeDrilldown();
        return;
      }
      closeDrilldown();
      showInbox(inbox);
      openEmail(id);
    });
  });
}

function renderDrilldownRow(m) {
  const urgentDot = m.isUrgent ? `<span class="dd-urgent-dot" title="Urgent"></span>` : '';
  const sender = m.senderName || m.senderAddress || 'Unknown';
  return `<div class="drilldown-row" data-inbox="${esc(m.inbox)}" data-id="${esc(m.id)}" data-subject="${esc(m.subject)}" title="Click to open">
    ${urgentDot}
    <div class="dd-main">
      <div class="dd-subject">${esc(m.subject)}</div>
      <div class="dd-meta">
        <span class="dd-sender">${esc(sender)}</span>
        <span class="dd-inbox-tag" data-inbox="${esc(m.inbox)}">${esc(inboxLabel(m.inbox))}</span>
        <span class="dd-age">${esc(formatHours(m.ageHours))} ago</span>
      </div>
    </div>
  </div>`;
}

// wire close on first-paint
if (drilldownClose) drilldownClose.addEventListener('click', closeDrilldown);
if (drilldownModal) drilldownModal.addEventListener('click', e => {
  if (e.target === drilldownModal) closeDrilldown();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drilldownModal.classList.contains('visible')) closeDrilldown();
});

function perfAvgResponseCard(a) {
  const today = a.today_minutes;
  const seven = a.seven_day_avg_minutes;
  const trend = a.trend; // improving | worsening | stable
  const arrow = trend === 'improving' ? '↓'
              : trend === 'worsening' ? '↑'
              : '→';
  const toneCls = trend === 'improving' ? 'tone-ok'
                : trend === 'worsening' ? 'tone-alert'
                : 'tone-info';
  const value = today == null ? '—' : `${formatPerfMinutes(today)}`;
  const sub = seven == null
    ? 'No 7-day baseline yet'
    : `<span class="arrow">${arrow}</span> 7d: ${formatPerfMinutes(seven)}`;
  return `<div class="perf-card ${toneCls}">
    <div class="perf-label">Avg Response</div>
    <div class="perf-value">${esc(value)}</div>
    <div class="perf-sub">${sub}</div>
  </div>`;
}

function perfFirstReplyCard(f) {
  const pct = f.today_percent;
  const target = f.target_percent;
  const status = f.status; // above_target | below_target | no_data
  const toneCls = status === 'above_target' ? 'tone-ok'
                : status === 'below_target' ? 'tone-alert'
                : 'tone-info';
  const arrow = status === 'above_target' ? '↑'
              : status === 'below_target' ? '↓'
              : '→';
  const value = pct == null ? '—' : `${pct}%`;
  const sub = pct == null
    ? 'No inbound today yet'
    : `<span class="arrow">${arrow}</span> target ${target}%`;
  // Clickable when there's data — drills into the "missed" bucket if below target
  // (the actionable list), otherwise into "met" (the wins).
  const clickable = pct != null;
  const bucket = status === 'above_target' ? 'met' : 'missed';
  const drillAttrs = clickable
    ? ` data-drill-firstreply="${bucket}" title="Click to see ${bucket === 'met' ? 'replied-on-time' : 'missed-SLA'} emails today"`
    : '';
  return `<div class="perf-card ${toneCls}${clickable ? ' clickable' : ''}"${drillAttrs}>
    <div class="perf-label">First Reply (today, ≤ SLA)</div>
    <div class="perf-value">${esc(value)}</div>
    <div class="perf-sub">${sub}</div>
  </div>`;
}

function perfInboundCard(byInbox) {
  // "Inbound" tile shows the slowest inbox today as a tip — keeps the row
  // useful without duplicating the Inbound Today tile up in the overview grid.
  const inboxes = Object.entries(byInbox || {});
  const responded = inboxes.filter(([, v]) => v.avg_minutes != null);
  if (responded.length === 0) {
    return `<div class="perf-card tone-info">
      <div class="perf-label">By inbox</div>
      <div class="perf-value">—</div>
      <div class="perf-sub">No responses yet today</div>
    </div>`;
  }
  responded.sort((a, b) => (b[1].avg_minutes || 0) - (a[1].avg_minutes || 0));
  const [slowestKey, slowestVal] = responded[0];
  const [fastestKey] = responded[responded.length - 1];
  return `<div class="perf-card tone-info">
    <div class="perf-label">By inbox (30d avg)</div>
    <div class="perf-value">
      <span class="perf-inbox-jump" data-jump-inbox="${esc(fastestKey)}" title="Open ${esc(INBOX_LABELS[fastestKey] || fastestKey)} mailbox">${esc(INBOX_LABELS[fastestKey] || fastestKey)}</span>
      <span class="perf-value-sub"> fastest</span>
    </div>
    <div class="perf-sub">
      <span class="arrow">↑</span>
      <span class="perf-inbox-jump" data-jump-inbox="${esc(slowestKey)}" title="Open ${esc(INBOX_LABELS[slowestKey] || slowestKey)} mailbox">${esc(INBOX_LABELS[slowestKey] || slowestKey)}</span>
      slowest at ${formatPerfMinutes(slowestVal.avg_minutes)}
    </div>
  </div>`;
}

function formatPerfMinutes(min) {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h)} h`;
}

// ── Missed Card (Phase 2 Session 3) ─────────────────────────────────────────

async function loadMissed(force = false) {
  missedRow.innerHTML = renderMissedSkeleton();
  try {
    const data = await apiFetch(withForce('/api/dashboard/missed', force));
    renderMissed(data);
    stampUpdated('missed-row', data.cachedAt);
  } catch (err) {
    missedRow.innerHTML =
      `<div class="missed-card inline-error" style="text-align:center;">
         Failed to load missed: ${formatErrorMessage(err)}
       </div>`;
    handleApiError(err);
  }
}

function renderMissedSkeleton() {
  return `<div class="missed-card">
    <div class="skeleton skel-line w40"></div>
    <div class="skeleton skel-line w60" style="margin-top:10px;height:26px;"></div>
    <div class="skeleton skel-line w80" style="margin-top:12px;"></div>
  </div>`;
}

function renderMissed(d) {
  const total = d.total_missed || 0;
  if (total === 0) {
    missedRow.innerHTML = `<div class="missed-card pill green">
      <span class="pill-icon">✓</span>
      <span>All emails opened in the last 24h</span>
    </div>`;
    return;
  }
  const byInbox = Object.entries(d.by_inbox || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${INBOX_LABELS[k] || k}:${n}`)
    .join(' · ');
  const oldest = d.oldest;
  const oldestBlock = oldest ? `
    <div class="missed-oldest" data-jump-inbox="${esc(oldest.inbox)}" data-jump-id="${esc(oldest.message_id)}" title="Click to open">
      Oldest: "<strong>${esc(truncate(oldest.subject, 60))}</strong>"
      from ${esc(oldest.sender)} · ${esc(formatHours((Date.now() - new Date(oldest.received).getTime()) / 3_600_000))}
    </div>` : '';
  missedRow.innerHTML = `<div class="missed-card tone-alert">
    <div class="missed-head">
      <span class="missed-label">Missed Emails (24h)</span>
      <span class="missed-icon">📨</span>
    </div>
    <div class="missed-count">${total}<span class="missed-unit">unopened</span></div>
    <div class="missed-breakdown">${esc(byInbox)}</div>
    ${oldestBlock}
  </div>`;
  missedRow.querySelectorAll('.missed-oldest[data-jump-inbox]').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      showInbox(el.dataset.jumpInbox);
      openEmail(el.dataset.jumpId);
    });
  });
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderOverviewSkeleton() {
  const skel = `<div class="tile">
    <div class="tile-head">
      <div class="skeleton skel-line w40"></div>
      <div class="skeleton" style="width:30px;height:30px;border-radius:8px;"></div>
    </div>
    <div class="skeleton skel-line w60" style="height:28px;margin-top:8px;"></div>
    <div class="skeleton skel-line w80" style="margin-top:14px;"></div>
  </div>`;
  overviewGrid.innerHTML = skel.repeat(1) +
    `<div class="tile wide">
      <div class="tile-head">
        <div class="skeleton skel-line w40"></div>
        <div class="skeleton" style="width:30px;height:30px;border-radius:8px;"></div>
      </div>
      <div class="skeleton skel-line w80" style="margin:8px 0"></div>
      <div class="skeleton skel-line w60"></div>
    </div>`;
}

function renderOverview(d) {
  const tiles = [
    tileOldestUnanswered(d.oldestUnanswered),
    tileInbound(d.inbound),
  ];
  overviewGrid.innerHTML = tiles.join('');
  wireOverviewJumpClicks(overviewGrid);
  overviewGrid.querySelectorAll('.spark-bar[data-drill-date]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const date = el.dataset.drillDate;
      const label = el.dataset.drillLabel;
      openDrilldown({ title: `Inbound — ${label}`, url: `/api/dashboard/inbound/${encodeURIComponent(date)}/messages` });
    });
  });
  const ts = d.generatedAt ? new Date(d.generatedAt) : new Date();
  overviewSubtitle.textContent = `Updated ${ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · 6 mailboxes`;

  // Kick off animations: first render = full count-up + ring fill + bar growth.
  // Subsequent refreshes show final values immediately (no re-animating noise).
  requestAnimationFrame(() => animateOverview(!state.overviewAnimated));
  state.overviewAnimated = true;
}

function animateOverview(firstTime) {
  // Numeric count-up
  document.querySelectorAll('.counter').forEach(el => {
    const target = parseFloat(el.dataset.target);
    if (Number.isNaN(target)) return;
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const formatVal = v => decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals);
    if (!firstTime) { el.textContent = formatVal(target); return; }
    const duration = 750;
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      el.textContent = formatVal(target * eased);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });

  // Apply target geometry. On the first render let the CSS transitions play
  // from their zeroed initial state. On subsequent renders, disable the
  // transition for one frame so values snap into place without re-playing.
  const setProp = (el, applier) => {
    if (firstTime) { applier(); return; }
    const prev = el.style.transition;
    el.style.transition = 'none';
    applier();
    // Force reflow, then restore the transition for future value changes.
    void el.getBoundingClientRect();
    el.style.transition = prev;
  };

  document.querySelectorAll('[data-ring-target]').forEach(el => {
    setProp(el, () => el.setAttribute('stroke-dashoffset', el.dataset.ringTarget));
  });
  document.querySelectorAll('[data-anim-width]').forEach(el => {
    setProp(el, () => { el.style.width = el.dataset.animWidth; });
  });
  document.querySelectorAll('[data-anim-height]').forEach(el => {
    setProp(el, () => { el.style.height = el.dataset.animHeight; });
  });
}

function inboxLabel(key)  { return INBOX_LABELS[key] || key; }
function inboxDot(key)    { return `<span class="inbox-dot inbox-${esc(key)}"></span>`; }

function tileShell({ label, icon, tone, stat, statNumber, statUnit, context, chips, empty, isAlertActive, extra }) {
  const toneClass = tone ? ` tone-${tone}` : '';
  const activeClass = isAlertActive ? ' is-active' : '';
  let statHtml;
  if (empty) {
    statHtml = `<div class="tile-stat empty">${esc(empty)}</div>`;
  } else if (typeof statNumber === 'number') {
    statHtml = `<div class="tile-stat"><span class="counter" data-target="${statNumber}">0</span>${statUnit ? `<span class="unit">${esc(statUnit)}</span>` : ''}</div>`;
  } else {
    statHtml = `<div class="tile-stat">${esc(stat)}${statUnit ? `<span class="unit">${esc(statUnit)}</span>` : ''}</div>`;
  }
  const chipsHtml = (chips && chips.length)
    ? `<div class="tile-meta-row">${chips.map(c => {
        const dot = c.inbox ? inboxDot(c.inbox) : '';
        const toneCls = c.tone ? ` ${c.tone}` : '';
        return `<span class="tile-chip${toneCls}">${dot}${esc(c.text)}</span>`;
      }).join('')}</div>`
    : '';
  return `<div class="tile${toneClass}${activeClass}">
    <div class="tile-head">
      <span class="tile-label">${esc(label)}</span>
      <span class="tile-icon">${icon}</span>
    </div>
    ${statHtml}
    ${context ? `<div class="tile-context">${context}</div>` : ''}
    ${chipsHtml}
    ${extra || ''}
  </div>`;
}

function tileOldestUnanswered(o) {
  if (!o) {
    return `<div class="tile hero tone-ok">
      <div class="tile-head">
        <span class="tile-label">Oldest Unanswered</span>
        <span class="tile-icon">⏱</span>
      </div>
      <div class="hero-body" style="justify-content:center;">
        <div style="text-align:center;">
          <div style="font-size:32px;color:var(--success);font-weight:700;letter-spacing:-0.01em;">All caught up</div>
          <div class="tile-context" style="margin-top:6px;">Nothing waiting across the 6 mailboxes.</div>
        </div>
      </div>
    </div>`;
  }

  const hrs = o.ageHours;
  const tone = hrs >= 24 ? 'alert' : hrs >= 8 ? 'warn' : 'info';
  const isAlertActive = tone === 'alert';

  // Big value + unit for the ring center
  let ringValue, ringUnit;
  if (hrs < 1) { ringValue = Math.max(1, Math.round(hrs * 60)).toString(); ringUnit = 'minutes'; }
  else if (hrs < 24) { ringValue = hrs.toFixed(hrs < 10 ? 1 : 0); ringUnit = 'hours waiting'; }
  else { ringValue = (hrs / 24).toFixed(1); ringUnit = 'days waiting'; }

  // Ring progress: 0h → 0%, 24h → 100% (capped). Circumference for r=58 ≈ 364.42.
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(hrs / 24, 1);
  const targetOffset = circumference * (1 - progress);

  // Gradient stops keyed off tone
  const gradFrom = tone === 'alert' ? '#ff6b5e' : tone === 'warn' ? '#ffb74d' : '#6ea7e0';
  const gradTo   = tone === 'alert' ? '#f44336' : tone === 'warn' ? '#ff9800' : '#4f8fd6';

  const senderName  = o.senderName || o.senderAddress || 'Unknown';
  const senderEmail = o.senderAddress && o.senderName ? o.senderAddress : '';
  const received   = new Date(o.receivedAt);
  const receivedStr = received.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  const canJump = !!(o.inbox && o.id);
  const jumpAttrs = canJump
    ? ` data-jump-inbox="${esc(o.inbox)}" data-jump-id="${esc(o.id)}"`
    : '';
  return `<div class="tile hero tone-${tone}${isAlertActive ? ' is-active' : ''}${canJump ? ' clickable' : ''}"${jumpAttrs}>
    <div class="tile-head">
      <span class="tile-label">Oldest Unanswered</span>
      <span class="tile-icon">⏱</span>
    </div>
    <div class="hero-body">
      <div class="hero-ring-wrap">
        <svg class="hero-ring" viewBox="0 0 134 134">
          <defs>
            <linearGradient id="ringGrad-${tone}" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"  stop-color="${gradFrom}"/>
              <stop offset="100%" stop-color="${gradTo}"/>
            </linearGradient>
          </defs>
          <circle class="ring-bg"   cx="67" cy="67" r="${radius}"/>
          <circle class="ring-fill" cx="67" cy="67" r="${radius}"
                  stroke="url(#ringGrad-${tone})"
                  stroke-dasharray="${circumference.toFixed(2)}"
                  stroke-dashoffset="${circumference.toFixed(2)}"
                  data-ring-target="${targetOffset.toFixed(2)}"/>
        </svg>
        <div class="hero-ring-center">
          <div class="hero-ring-value">${esc(ringValue)}</div>
          <div class="hero-ring-unit">${esc(ringUnit)}</div>
        </div>
      </div>
      <div class="hero-meta">
        <div class="hero-subject">${esc(o.subject)}</div>
        <div class="hero-sender">${esc(senderName)}${senderEmail ? `<span class="sender-email">${esc(senderEmail)}</span>` : ''}</div>
        <div class="hero-inbox-row">${inboxDot(o.inbox)} ${esc(inboxLabel(o.inbox))} mailbox</div>
        <div class="hero-received">Received ${esc(receivedStr)}</div>
      </div>
    </div>
  </div>`;
}

function tileInbound(i) {
  const today = i.today;
  const avg = i.dailyAverage7d;
  const pct = i.deltaPct;
  let tone = 'info';
  let deltaHtml = '';
  if (pct === null) {
    deltaHtml = '<span class="delta flat">no baseline</span>';
  } else if (pct > 0) {
    tone = pct > 25 ? 'warn' : 'info';
    deltaHtml = `<span class="delta up">↑ ${pct}%</span>`;
  } else if (pct < 0) {
    deltaHtml = `<span class="delta down">↓ ${Math.abs(pct)}%</span>`;
  } else {
    deltaHtml = '<span class="delta flat">→ on pace</span>';
  }

  // Sparkline: 7-day daily inbound. Today is the last bar, highlighted.
  let sparkHtml = '';
  if (Array.isArray(i.daily) && i.daily.length) {
    const max = Math.max(...i.daily.map(d => d.count), 1);
    const bars = i.daily.map((d, idx) => {
      const heightPct = Math.max(4, (d.count / max) * 100);
      const isToday = idx === i.daily.length - 1;
      const dayLabel = new Date(d.date).toLocaleDateString([], { weekday: 'short' });
      const title = `${dayLabel} ${d.date} · ${d.count} ${d.count === 1 ? 'message' : 'messages'} · click to drill in`;
      const clickable = d.count > 0;
      const drillAttrs = clickable ? ` data-drill-date="${esc(d.date)}" data-drill-label="${esc(dayLabel)} ${esc(d.date)}"` : '';
      return `<div class="spark-bar${isToday ? ' today' : ''}${clickable ? ' clickable' : ''}" data-anim-height="${heightPct.toFixed(1)}%" title="${esc(title)}"${drillAttrs}></div>`;
    }).join('');
    const firstLabel = new Date(i.daily[0].date).toLocaleDateString([], { weekday: 'short' });
    sparkHtml = `<div class="spark-wrap">
      <div class="spark-bars">${bars}</div>
      <div class="spark-labels"><span>${esc(firstLabel)}</span><span>Today</span></div>
    </div>`;
  }

  return tileShell({
    label: 'Inbound Today', icon: '📥', tone,
    statNumber: today, statUnit: today === 1 ? 'message' : 'messages',
    context: `7-day average: <strong>${avg}</strong>/day ${deltaHtml}`,
    extra: sparkHtml,
  });
}

// ── Hypercare ─────────────────────────────────────────────────────────────────

async function loadHypercareConfig() {
  if (state.hypercare.config) return state.hypercare.config;
  try {
    const cfg = await apiFetch('/api/hypercare/config');
    state.hypercare.config = cfg;
    applyHypercareConfigToUi(cfg);
    return cfg;
  } catch (err) {
    errorToast('Hypercare config failed', err);
    return null;
  }
}

// Reflect the current config in the Hypercare header (subtitle + alert pill).
// Shared by the initial load and the Settings save path so an edit shows up
// immediately without a page reload.
function applyHypercareConfigToUi(cfg) {
  if (hypercareSubtitle && cfg) {
    hypercareSubtitle.textContent =
      `VIP loads · ${(cfg.vipClients || []).length} clients · ${cfg.slaMinutes}-min SLA`;
  }
  renderNotifyPill();
}

async function loadHypercare(force = false) {
  if (!hypercareQueue) return;
  if (force) renderHypercareSkeleton();
  try {
    const data = await apiFetch('/api/hypercare/loads');
    state.hypercare.loads = applyDemoOverlay(data.loads || []);
    renderHypercare();
    detectNewRedLoads(state.hypercare.loads);
    updateSidebarRedBadge();
  } catch (err) {
    hypercareQueue.innerHTML = `<div class="hypercare-empty inline-error">
      Failed to load hypercare: ${formatErrorMessage(err)}
    </div>`;
    handleApiError(err);
  }
  resetHypercareCountdown();
}

async function loadHypercareActivity() {
  if (!hypercareActivityFeed) return;
  try {
    const data = await apiFetch('/api/hypercare/activity');
    state.hypercare.activity = data.activity || [];
    renderHypercareActivity();
  } catch { /* non-fatal */ }
}

function renderHypercareSkeleton() {
  hypercareSummary.innerHTML = Array.from({ length: 5 }, () =>
    `<div class="hc-stat-card skeleton-card"><div class="skeleton skel-line w40"></div><div class="skeleton skel-line w20" style="margin-top:8px;height:22px;"></div></div>`
  ).join('');
  hypercareQueue.innerHTML = Array.from({ length: 3 }, () =>
    `<div class="hc-load-card skeleton-card">
      <div class="skeleton skel-line w60"></div>
      <div class="skeleton skel-line w80" style="margin-top:8px;"></div>
      <div class="skeleton skel-line w40" style="margin-top:8px;"></div>
    </div>`
  ).join('');
}

// ── Hypercare: status + countdown ────────────────────────────────────────────

function getLoadStatus(load) {
  const cfg = state.hypercare.config;
  if (!cfg) return 'green';
  const lastTouch = load.lastActionAt || load.receivedAt;
  const elapsedMs = Date.now() - new Date(lastTouch).getTime();
  const slaMs = cfg.slaMinutes * 60_000;
  const pct = (elapsedMs / slaMs) * 100;
  if (pct >= 100) return 'red';
  if (pct >= cfg.amberThresholdPct) return 'amber';
  return 'green';
}

function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function countdownFor(load) {
  const cfg = state.hypercare.config;
  if (!cfg) return { label: '', overdue: false };
  const lastTouch = load.lastActionAt || load.receivedAt;
  const deadline = new Date(lastTouch).getTime() + cfg.slaMinutes * 60_000;
  const remaining = deadline - Date.now();
  if (remaining < 0) {
    return { label: `OVERDUE +${formatMs(-remaining)}`, overdue: true };
  }
  return { label: `${formatMs(remaining)} until overdue`, overdue: false };
}

// ── Hypercare: summary strip + queue rendering ───────────────────────────────

const HC_FILTERS = ['red', 'amber', 'green'];

function renderHypercare() {
  if (!hypercareQueue) return;
  const loads = state.hypercare.loads;
  const counts = { red: 0, amber: 0, green: 0 };
  for (const load of loads) counts[getLoadStatus(load)]++;

  hypercareSummary.innerHTML = [
    hcStatCard('red',   counts.red,   'Overdue', '🔴'),
    hcStatCard('amber', counts.amber, 'At risk', '🟡'),
    hcStatCard('green', counts.green, 'Healthy', '🟢'),
  ].join('');

  hypercareSummary.querySelectorAll('.hc-stat-card[data-filter]').forEach(el => {
    el.addEventListener('click', () => {
      const filter = el.dataset.filter;
      state.hypercare.statusFilter = (state.hypercare.statusFilter === filter) ? null : filter;
      renderHypercare();
    });
  });

  // Build the displayed list
  const filter = state.hypercare.statusFilter;
  let toShow = loads
    .map(l => ({ load: l, status: getLoadStatus(l) }))
    .filter(({ status }) => filter ? status === filter : true);

  // Sort: red (oldest overdue first) → amber (closest to overdue first) →
  // green (most recently touched last)
  toShow.sort((a, b) => {
    const order = { red: 0, amber: 1, green: 2 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    const aTouch = new Date(a.load.lastActionAt || a.load.receivedAt).getTime();
    const bTouch = new Date(b.load.lastActionAt || b.load.receivedAt).getTime();
    if (a.status === 'red')   return aTouch - bTouch;            // oldest overdue first
    if (a.status === 'amber') return aTouch - bTouch;            // closest to overdue first
    return bTouch - aTouch;                                       // most recent first
  });

  if (toShow.length === 0) {
    hypercareQueue.innerHTML = `<div class="hypercare-empty">
      No hypercare loads ${filter ? `match the "${esc(filter)}" filter` : 'currently'}.
      ${filter ? '' : 'All VIP client emails responded to within SLA. 👍'}
    </div>`;
    return;
  }

  hypercareQueue.innerHTML = toShow.map(({ load, status }) => renderLoadCard(load, status)).join('');

  // Wire per-card actions
  wireHypercareActions();
  // Initial countdown labels (the shared ticker will update each tick)
  tickHypercareCountdowns();
  // Keep the handover snapshot in sync when it's the visible tab.
  if (state.hypercare.tab === 'handover') renderHandover();
}

function hcStatCard(filter, count, label, icon) {
  const active = state.hypercare.statusFilter === filter ? ' active' : '';
  return `<div class="hc-stat-card hc-stat-${esc(filter)}${active}" data-filter="${esc(filter)}">
    <div class="hc-stat-top">
      <span class="hc-stat-icon">${icon}</span>
      <span class="hc-stat-count">${count}</span>
    </div>
    <div class="hc-stat-label">${esc(label)}</div>
  </div>`;
}

// ── Hypercare: trend sparkline (§12.2) ───────────────────────────────────────

// Classify a response-time series (minutes, oldest→newest). Lower = faster,
// so a rising series is 'worsening'. Compares the older vs newer half.
function trendOf(values) {
  if (values.length < 2) return 'stable';
  const mid = Math.floor(values.length / 2);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const oldAvg = avg(values.slice(0, mid));
  const newAvg = avg(values.slice(mid));
  if (newAvg > oldAvg * 1.10) return 'worsening';
  if (newAvg < oldAvg * 0.90) return 'improving';
  return 'stable';
}

// Inline SVG line sparkline. Strokes in `currentColor` so the wrapping span's
// trend class sets the colour. Last point gets a dot.
function sparklineSvg(values) {
  const W = 64, H = 20, PAD = 2;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values);
  const flat = max === min;
  const x = i => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = v => flat ? H / 2 : PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="hc-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">` +
    `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(values[n - 1]).toFixed(1)}" r="2" fill="currentColor"/>` +
    `</svg>`;
}

// Sparkline cell for a load card — empty string when the load carries no
// responseHistory (live loads have none until Graph ingestion is wired).
function renderLoadSparkline(load) {
  const hist = load.responseHistory;
  if (!Array.isArray(hist) || hist.length < 2) return '';
  const trend = trendOf(hist);
  const arrow = trend === 'worsening' ? '▲' : trend === 'improving' ? '▼' : '▪';
  const title = `Response trend — last ${hist.length} loads: ${hist.join('→')} min (${trend})`;
  return `<span class="hc-spark-wrap hc-spark-${trend}" title="${esc(title)}">` +
    sparklineSvg(hist) + `<span class="hc-spark-arrow">${arrow}</span></span>`;
}

function renderLoadCard(load, status) {
  const cd = countdownFor(load);

  const cdHtml = `<span class="hc-cd hc-cd-${esc(status)}" data-cd-id="${esc(load.id)}">${esc(cd.label)}</span>`;

  const sparkHtml = renderLoadSparkline(load);

  const valueStr = (load.cargoValue != null)
    ? `€${load.cargoValue.toLocaleString('en-IE')}`
    : '';

  const routeStr = (load.route?.origin || load.route?.destination)
    ? `${esc(load.route.origin || '')} → ${esc(load.route.destination || '')}`
    : '';

  const lastTouchStr = load.lastActionAt
    ? `Last touched: ${relTime(load.lastActionAt)}${load.lastActionBy ? ` by ${esc(load.lastActionBy)}` : ''}`
    : 'Last touched: never';

  const recvStr = `Received ${new Date(load.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} from ${esc(load.fromAddress || '')}`;

  const actionsHtml = `
    <button class="btn btn-primary btn-sm" data-hc-action="reply" data-hc-id="${esc(load.id)}">Reply ↗</button>
    <button class="btn btn-secondary btn-sm" data-hc-action="thread" data-hc-id="${esc(load.id)}">Open thread ↗</button>
    <button class="btn btn-secondary btn-sm" data-hc-action="note" data-hc-id="${esc(load.id)}">+ Note</button>`;

  const noteCount = (load.notes || []).length;
  const notesToggle = `<button class="hc-notes-toggle" data-hc-action="togglenotes" data-hc-id="${esc(load.id)}">
    Notes (${noteCount}) <span class="hc-caret">▾</span>
  </button>`;

  const notesPanel = `<div class="hc-notes-panel" id="hc-notes-${esc(load.id)}" hidden>
    ${(load.notes || []).map(n => `
      <div class="hc-note">
        <div class="hc-note-head">
          <span class="hc-note-author">${esc(n.author)}</span>
          <span class="hc-note-time">${relTime(n.timestamp)}</span>
        </div>
        <div class="hc-note-text">${esc(n.text)}</div>
      </div>`).join('')}
    <div class="hc-note-input-row">
      <input type="text" class="hc-note-input form-control" placeholder="Add a note…" data-hc-note-id="${esc(load.id)}">
      <button class="btn btn-primary btn-sm hc-note-submit" data-hc-id="${esc(load.id)}">Save</button>
    </div>
  </div>`;

  return `<div class="hc-load-card hc-status-${esc(status)}" data-load-id="${esc(load.id)}">
    <div class="hc-load-top">
      <span class="hc-status-dot hc-dot-${esc(status)}"></span>
      <span class="hc-client">${esc(load.client)}</span>
      <span class="hc-sep">·</span>
      <span class="hc-bookingref">${esc(load.bookingRef)}</span>
      <div class="hc-load-top-right">
        ${cdHtml}
        ${sparkHtml}
      </div>
    </div>
    <div class="hc-load-meta">
      ${routeStr ? `<span>${routeStr}</span>` : ''}
      ${valueStr ? `<span class="hc-sep">·</span><span>${esc(valueStr)}</span>` : ''}
      ${load.clientReason ? `<span class="hc-sep">·</span><span class="hc-reason">${esc(load.clientReason)}</span>` : ''}
    </div>
    <div class="hc-load-subject">"${esc(load.subject || '')}"</div>
    <div class="hc-load-context">${esc(recvStr)} · ${esc(lastTouchStr)}</div>
    <div class="hc-load-actions">
      ${actionsHtml}
      <span class="hc-actions-spacer"></span>
      ${notesToggle}
    </div>
    ${notesPanel}
  </div>`;
}

function wireHypercareActions() {
  hypercareQueue.querySelectorAll('[data-hc-action]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const action = el.dataset.hcAction;
      const id = el.dataset.hcId;
      handleHypercareAction(action, id);
    });
  });
  hypercareQueue.querySelectorAll('.hc-note-submit').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.hcId;
      const input = hypercareQueue.querySelector(`.hc-note-input[data-hc-note-id="${cssEscape(id)}"]`);
      const text = input ? input.value.trim() : '';
      if (!text) return;
      submitHypercareNote(id, text);
    });
  });
  // Submit note on Enter
  hypercareQueue.querySelectorAll('.hc-note-input').forEach(inp => {
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const id = inp.dataset.hcNoteId;
        const text = inp.value.trim();
        if (text) submitHypercareNote(id, text);
      }
    });
  });
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function handleHypercareAction(action, id) {
  if (action === 'togglenotes') {
    const panel = $(`hc-notes-${id}`);
    if (panel) panel.hidden = !panel.hidden;
    return;
  }
  if (action === 'thread') {
    const load = state.hypercare.loads.find(l => l.id === id);
    if (load && load.threadUrl) {
      // For now, just toast — the dashboard's email view uses inbox/message-id
      // pairs, not arbitrary URLs. Hooking into the email pane is a follow-up.
      toast(`Open thread: ${load.bookingRef}`, 'success');
    }
    return;
  }
  if (action === 'reply') {
    const load = state.hypercare.loads.find(l => l.id === id);
    if (load) openLoadForReply(load);
    return;
  }
  if (action === 'note') {
    const panel = $(`hc-notes-${id}`);
    if (panel) panel.hidden = false;
    const input = hypercareQueue.querySelector(`.hc-note-input[data-hc-note-id="${cssEscape(id)}"]`);
    if (input) input.focus();
    return;
  }
}

// ── Hypercare: per-action submitters ─────────────────────────────────────────

// Reply: navigate to the inbox and open the linked email so the user can
// action it immediately. Loads need `inbox` + `messageId` for this to work;
// when ingestion isn't wired (or in demo mode), fall back to a toast.
function openLoadForReply(load) {
  if (load.inbox && load.messageId) {
    showInbox(load.inbox);
    openEmail(load.messageId);
    return;
  }
  toast(`Reply: ${load.client} · ${load.bookingRef} (no linked email yet)`, 'info');
}

async function submitHypercareNote(id, text) {
  const note = { author: currentUserName(), text, timestamp: new Date().toISOString() };
  optimisticUpdate(id, load => {
    load.notes = [...(load.notes || []), note];
  });
  try {
    const data = await apiFetch(`/api/hypercare/loads/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (data.load) replaceLoad(data.load);
  } catch (err) { errorToast('Note failed', err); loadHypercare(); }
}

function optimisticUpdate(id, mutator) {
  const load = state.hypercare.loads.find(l => l.id === id);
  if (!load) return;
  mutator(load);
  rememberDemo(load);
  renderHypercare();
}

function replaceLoad(updated) {
  const idx = state.hypercare.loads.findIndex(l => l.id === updated.id);
  if (idx >= 0) state.hypercare.loads[idx] = updated;
  rememberDemo(updated);
  renderHypercare();
}

function currentUserName() {
  return userNameEl.textContent || 'You';
}

// Demo mode: backend rejects mutations, so we keep an in-memory overlay of
// optimistic notes/touch updates so they survive the 30s poll. Cleared
// whenever demo mode is toggled.
function rememberDemo(load) {
  if (!state.demoMode) return;
  state.hypercare.demoOverlay[load.id] = {
    lastActionAt: load.lastActionAt,
    lastActionBy: load.lastActionBy,
    notes:        load.notes ? [...load.notes] : [],
  };
}

function applyDemoOverlay(loads) {
  if (!state.demoMode) return loads;
  const overlay = state.hypercare.demoOverlay;
  return loads.map(l => overlay[l.id] ? { ...l, ...overlay[l.id] } : l);
}

function resetDemoOverlay() {
  state.hypercare.demoOverlay = {};
}

// ── Hypercare: activity feed ─────────────────────────────────────────────────

function renderHypercareActivity() {
  if (!hypercareActivityFeed) return;
  const items = state.hypercare.activity;
  if (!items.length) {
    hypercareActivityFeed.innerHTML = `<div class="hypercare-empty">No hypercare activity today.</div>`;
    return;
  }
  hypercareActivityFeed.innerHTML = items.map(a => {
    const t = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who = a.actor || 'system';
    const ref = a.booking_ref ? ` ${esc(a.booking_ref)}` : '';
    const detail = a.detail ? ` — ${esc(a.detail)}` : '';
    return `<div class="hc-activity-row">
      <span class="hc-activity-time">${t}</span>
      <span class="hc-activity-text">${esc(who)} ${esc(a.action)}${ref}${detail}</span>
    </div>`;
  }).join('');
}

// ── Hypercare: shift handover view ───────────────────────────────────────────

// Toggle between the live action queue and the handover snapshot. Visibility
// runs off the `hidden` attribute — CSS gives `.foo[hidden]` higher specificity
// than `.foo`, so a base `display` rule (e.g. the summary grid) can't override.
function setHypercareTab(tab) {
  state.hypercare.tab = tab;
  if (hypercareTabs) {
    hypercareTabs.querySelectorAll('.hc-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.hcTab === tab));
  }
  const queueView = tab !== 'handover';
  if (hypercareSummary)  hypercareSummary.hidden  = !queueView;
  if (hypercareQueue)    hypercareQueue.hidden    = !queueView;
  if (hypercareActivity) hypercareActivity.hidden = !queueView;
  if (hypercareHandover) hypercareHandover.hidden = queueView;
  if (!queueView) renderHandover();
}

// Bucket loads by SLA status, each sorted for handover reading: red + amber
// oldest-touch first (most urgent at top), green most-recently-touched first.
function groupLoadsByStatus(loads) {
  const groups = { red: [], amber: [], green: [] };
  for (const load of loads) groups[getLoadStatus(load)].push(load);
  const touch = l => new Date(l.lastActionAt || l.receivedAt).getTime();
  groups.red.sort((a, b) => touch(a) - touch(b));
  groups.amber.sort((a, b) => touch(a) - touch(b));
  groups.green.sort((a, b) => touch(b) - touch(a));
  return groups;
}

const HC_HANDOVER_SECTIONS = [
  { key: 'red',   label: 'Overdue', icon: '🔴' },
  { key: 'amber', label: 'At risk', icon: '🟡' },
  { key: 'green', label: 'Healthy', icon: '🟢' },
];

function renderHandover() {
  if (!hypercareHandover) return;
  const loads = state.hypercare.loads;
  const groups = groupLoadsByStatus(loads);
  const tsStr = new Date().toLocaleString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const barHtml = (subtitle, disabled) => `
    <div class="hc-handover-bar">
      <div>
        <div class="hc-handover-title">Shift handover snapshot</div>
        <div class="hc-handover-ts">${esc(subtitle)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" id="hc-copy-summary"${disabled ? ' disabled' : ''}>📋 Copy summary</button>
    </div>`;

  if (!loads.length) {
    hypercareHandover.innerHTML = barHtml(`Generated ${tsStr}`, true) +
      `<div class="hypercare-empty">No VIP loads to hand over right now. 👍</div>`;
    return;
  }

  const counts = `${groups.red.length} overdue · ${groups.amber.length} at risk · ${groups.green.length} healthy`;
  const sectionsHtml = HC_HANDOVER_SECTIONS.map(s => {
    const items = groups[s.key];
    const rows = items.length
      ? items.map(l => renderHandoverRow(l, s.key)).join('')
      : `<div class="hc-handover-none">None.</div>`;
    return `<div class="hc-handover-section">
      <div class="hc-handover-section-head hc-ho-${s.key}">
        ${s.icon} ${esc(s.label)} <span class="hc-handover-count">(${items.length})</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  hypercareHandover.innerHTML =
    barHtml(`Generated ${tsStr} · ${loads.length} VIP load${loads.length === 1 ? '' : 's'} · ${counts}`, false) +
    sectionsHtml;

  const copyBtn = $('hc-copy-summary');
  if (copyBtn) copyBtn.addEventListener('click', copyHandoverSummary);
}

function renderHandoverRow(load, statusKey) {
  const cd = countdownFor(load);
  const routeStr = (load.route?.origin || load.route?.destination)
    ? `${esc(load.route.origin || '')} → ${esc(load.route.destination || '')}`
    : '';
  const valueStr = (load.cargoValue != null) ? `€${load.cargoValue.toLocaleString('en-IE')}` : '';
  const cfg = state.hypercare.config;
  const slaStr = cfg ? `${cfg.slaMinutes}m SLA` : '';
  const metaParts = [routeStr, valueStr, slaStr].filter(Boolean);
  const lastTouch = load.lastActionAt
    ? `Last touched ${relTime(load.lastActionAt)}${load.lastActionBy ? ` by ${esc(load.lastActionBy)}` : ''}`
    : 'Not yet touched';
  const notes = load.notes || [];
  const noteCount = notes.length ? ` · ${notes.length} note${notes.length === 1 ? '' : 's'}` : '';
  const lastNote = notes.length ? notes[notes.length - 1] : null;

  return `<div class="hc-handover-row">
    <div class="hc-handover-row-top">
      <span class="hc-handover-client">${esc(load.client)}</span>
      <span class="hc-sep">·</span>
      <span class="hc-handover-ref">${esc(load.bookingRef)}</span>
      <span class="hc-handover-cd hc-ho-cd-${esc(statusKey)}">${esc(cd.label)}</span>
    </div>
    <div class="hc-handover-subject">"${esc(load.subject || '')}"</div>
    <div class="hc-handover-meta">${metaParts.join(' · ')}</div>
    <div class="hc-handover-meta">${lastTouch}${noteCount}</div>
    ${lastNote ? `<div class="hc-handover-note">↳ "${esc(lastNote.text)}" — ${esc(lastNote.author)}</div>` : ''}
  </div>`;
}

// Plain-text digest for pasting into Teams / email at end of shift.
function buildHandoverText() {
  const loads = state.hypercare.loads;
  const groups = groupLoadsByStatus(loads);
  const ts = new Date().toLocaleString('en-IE', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const lines = [
    `SHIFT HANDOVER — ${ts}`,
    `Caffrey Ops · Hypercare · ${loads.length} VIP load${loads.length === 1 ? '' : 's'} ` +
      `(${groups.red.length} overdue, ${groups.amber.length} at risk, ${groups.green.length} healthy)`,
  ];
  for (const s of HC_HANDOVER_SECTIONS) {
    const items = groups[s.key];
    lines.push('', `${s.icon} ${s.label.toUpperCase()} (${items.length})`);
    if (!items.length) { lines.push('  — none'); continue; }
    for (const l of items) {
      const cd = countdownFor(l);
      lines.push(`  • ${l.client} · ${l.bookingRef} · ${cd.label}`);
      const route = (l.route?.origin || l.route?.destination)
        ? `${l.route.origin || ''} → ${l.route.destination || ''}` : '';
      const value = (l.cargoValue != null) ? `€${l.cargoValue.toLocaleString('en-IE')}` : '';
      const slaStr = state.hypercare.config ? `${state.hypercare.config.slaMinutes}m SLA` : '';
      const detail = [route, value, slaStr].filter(Boolean).join(' · ');
      if (detail) lines.push(`      ${detail}`);
      lines.push(`      Subject: "${l.subject || ''}"`);
      lines.push(`      ${l.lastActionAt
        ? `Last touched ${relTime(l.lastActionAt)}${l.lastActionBy ? ` by ${l.lastActionBy}` : ''}`
        : 'Not yet touched'}`);
      const notes = l.notes || [];
      if (notes.length) {
        const ln = notes[notes.length - 1];
        lines.push(`      Latest note: "${ln.text}" — ${ln.author}`);
      }
    }
  }
  return lines.join('\n');
}

async function copyHandoverSummary() {
  const btn = $('hc-copy-summary');
  const text = buildHandoverText();
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch { /* fall through to the legacy path */ }
  if (!copied) {
    try { legacyCopy(text); copied = true; } catch { /* ignore */ }
  }
  if (!copied) {
    toast('Could not copy — your browser blocked clipboard access.', 'error');
    return;
  }
  toast('Handover summary copied to clipboard.', 'success');
  if (btn) {
    btn.textContent = '✓ Copied';
    setTimeout(() => { if (btn.isConnected) btn.textContent = '📋 Copy summary'; }, 2000);
  }
}

// Clipboard fallback for non-secure contexts / older browsers.
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

// ── Hypercare: timers (auto-refresh + per-second countdowns) ─────────────────

function startHypercareTimers() {
  stopHypercareTimers();
  const cfg = state.hypercare.config;
  const periodSec = (cfg && cfg.refreshIntervalSec) || 30;
  state.hypercare.nextRefreshAt = Date.now() + periodSec * 1000;
  state.hypercare.refreshTimer = setInterval(() => {
    state.hypercare.nextRefreshAt = Date.now() + periodSec * 1000;
    loadHypercare();
    loadHypercareActivity();
  }, periodSec * 1000);
  // Per-second tick for countdowns + refresh countdown
  state.hypercare.countdownInterval = setInterval(() => {
    tickHypercareCountdowns();
    tickHypercareRefreshCountdown();
  }, 1000);
}

function stopHypercareTimers() {
  if (state.hypercare.refreshTimer)     clearInterval(state.hypercare.refreshTimer);
  if (state.hypercare.countdownInterval) clearInterval(state.hypercare.countdownInterval);
  state.hypercare.refreshTimer = null;
  state.hypercare.countdownInterval = null;
}

function resetHypercareCountdown() {
  const cfg = state.hypercare.config;
  const periodSec = (cfg && cfg.refreshIntervalSec) || 30;
  state.hypercare.nextRefreshAt = Date.now() + periodSec * 1000;
  tickHypercareRefreshCountdown();
}

function tickHypercareCountdowns() {
  // Walk all on-screen countdown spans and update their text; re-render any
  // card whose status transitions (green→amber, amber→red) on this tick.
  let needsRerender = false;
  for (const load of state.hypercare.loads) {
    const el = hypercareQueue?.querySelector(`[data-cd-id="${cssEscape(load.id)}"]`);
    if (!el) continue;
    const cd = countdownFor(load);
    const status = getLoadStatus(load);
    // If the dom class no longer matches the status, the card's full appearance
    // needs to update (border, gradient, dot). Trigger a full re-render once.
    if (!el.classList.contains(`hc-cd-${status}`)) needsRerender = true;
    el.textContent = cd.label;
  }
  if (needsRerender) {
    renderHypercare();
    detectNewRedLoads(state.hypercare.loads);
    updateSidebarRedBadge();
  }
}

function tickHypercareRefreshCountdown() {
  if (!hypercareCountdown || !state.hypercare.nextRefreshAt) return;
  const remainingSec = Math.max(0, Math.ceil((state.hypercare.nextRefreshAt - Date.now()) / 1000));
  hypercareCountdown.textContent = `Auto-refresh in ${remainingSec}s`;
}

// ── Hypercare: red audio alert ───────────────────────────────────────────────

function detectNewRedLoads(loads) {
  const prev = state.hypercare.previouslyRedIds;
  const nextRed = new Set();
  const newlyRed = [];
  for (const load of loads) {
    if (getLoadStatus(load) === 'red') {
      nextRed.add(load.id);
      if (!prev.has(load.id)) newlyRed.push(load);
    }
  }
  state.hypercare.previouslyRedIds = nextRed;

  // The first pass after page load just records which loads were already
  // overdue — no audio, no notifications for a pre-existing backlog.
  if (!state.hypercare.redBaselineSet) {
    state.hypercare.redBaselineSet = true;
    return;
  }
  if (newlyRed.length === 0) return;
  if (state.hypercare.audioEnabled && state.hypercare.audioUnlocked) playRedAlert();
  notifyOverdueLoads(newlyRed);
}

// ── Hypercare: Telegram / Teams notifications (§12.4) ────────────────────────

// POST one alert per load that just crossed into red. Credentials live
// server-side; the dashboard only relays the event. Suppressed in demo mode
// so synthetic loads never page anyone. Failures are non-fatal.
function notifyOverdueLoads(loads) {
  if (state.demoMode) return;
  const n = state.hypercare.config && state.hypercare.config.notifications;
  if (!n || !n.enabled) return;
  for (const load of loads) {
    apiFetch('/api/hypercare/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'overdue', load: notifyPayload(load) }),
    }).catch(() => { /* a missed alert must not break the dashboard */ });
  }
}

function notifyPayload(load) {
  const cfg = state.hypercare.config;
  return {
    client: load.client,
    bookingRef: load.bookingRef,
    subject: load.subject,
    route: load.route,
    cargoValue: load.cargoValue,
    sla: cfg ? cfg.slaMinutes : null,
  };
}

// Header pill — reflects server-side notification status, click to test.
function renderNotifyPill() {
  if (!hypercareNotifyPill) return;
  const n = state.hypercare.config && state.hypercare.config.notifications;
  hypercareNotifyPill.hidden = false;
  if (!n || !n.enabled) {
    hypercareNotifyPill.className = 'hypercare-notify-pill off';
    hypercareNotifyPill.textContent = '🔕 Alerts off';
    hypercareNotifyPill.title =
      'Overdue-load alerts are not configured. Add TELEGRAM_BOT_TOKEN / ' +
      'TELEGRAM_CHAT_ID / TEAMS_WEBHOOK_URL to backend/.env and restart.';
    return;
  }
  const channels = [];
  if (n.channels && n.channels.telegram) channels.push('Telegram');
  if (n.channels && n.channels.teams) channels.push('Teams');
  hypercareNotifyPill.className = 'hypercare-notify-pill on';
  hypercareNotifyPill.textContent = `🔔 ${channels.join(' + ')}`;
  hypercareNotifyPill.title = `Overdue-load alerts active: ${channels.join(', ')}. Click to send a test.`;
}

async function sendTestNotification() {
  try {
    const data = await apiFetch('/api/hypercare/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test' }),
    });
    if (!data.ok) {
      toast('Test alert not sent — alerts are disabled on the server.', 'error');
      return;
    }
    const sent = (data.sent || []);
    const failed = (data.failed || []);
    if (sent.length) toast(`Test alert sent via ${sent.join(' + ')}.`, 'success');
    if (failed.length) toast(`Test alert failed for ${failed.join(' + ')}.`, 'error');
    if (!sent.length && !failed.length) toast('No notification channels configured.', 'info');
  } catch (err) {
    errorToast('Test alert failed', err);
  }
}

function playRedAlert() {
  // Synthesised beep via WebAudio: avoids shipping an mp3 file. Two short
  // descending tones — distinctive but not abrasive.
  try {
    const ctx = state.hypercare.audio || new (window.AudioContext || window.webkitAudioContext)();
    state.hypercare.audio = ctx;
    const beep = (when, freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.3, when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(when); osc.stop(when + 0.27);
    };
    const t = ctx.currentTime;
    beep(t,        880);
    beep(t + 0.3,  660);
  } catch { /* audio not available; ignore */ }
}

function updateSidebarRedBadge() {
  if (!badgeHypercareRed) return;
  const reds = state.hypercare.loads.filter(l => getLoadStatus(l) === 'red').length;
  badgeHypercareRed.textContent = reds;
  badgeHypercareRed.classList.toggle('zero', reds === 0);
  badgeHypercareRed.classList.toggle('hc-red-badge', reds > 0);
}

function updateMuteButton() {
  if (!hypercareMuteBtn) return;
  const icon = hypercareMuteBtn.querySelector('.hc-mute-icon');
  if (icon) icon.textContent = state.hypercare.audioEnabled ? '🔊' : '🔇';
  hypercareMuteBtn.setAttribute('aria-pressed', state.hypercare.audioEnabled ? 'false' : 'true');
}

if (hypercareMuteBtn) {
  updateMuteButton();
  hypercareMuteBtn.addEventListener('click', () => {
    state.hypercare.audioEnabled = !state.hypercare.audioEnabled;
    localStorage.setItem('hypercareAudio', state.hypercare.audioEnabled ? 'on' : 'off');
    updateMuteButton();
    if (state.hypercare.audioEnabled) {
      // First click unlocks audio for the session (browser policy).
      state.hypercare.audioUnlocked = true;
      toast('Sound alerts enabled.', 'success');
    } else {
      toast('Sound alerts muted.', 'success');
    }
  });
}

if (hypercareRefresh) hypercareRefresh.addEventListener('click', () => {
  // Unlock audio on first user interaction with the page header.
  state.hypercare.audioUnlocked = true;
  loadHypercare(true);
  loadHypercareActivity();
});

if (hypercareTabs) {
  hypercareTabs.querySelectorAll('.hc-tab').forEach(btn => {
    btn.addEventListener('click', () => setHypercareTab(btn.dataset.hcTab));
  });
}

if (hypercareNotifyPill) {
  hypercareNotifyPill.addEventListener('click', () => {
    const n = state.hypercare.config && state.hypercare.config.notifications;
    if (!n || !n.enabled) {
      toast('Alerts not configured — add the Telegram/Teams credentials to backend/.env.', 'info');
      return;
    }
    sendTestNotification();
  });
}

// ── Settings (§12.5) ──────────────────────────────────────────────────────────

// The Settings view is a left sub-nav of panels. Each panel owns one area's
// config; a future "Top Clients" view registers a second entry here with its
// own render function — nothing else needs to change.
const SETTINGS_PANELS = [
  { id: 'hypercare',  label: 'Hypercare',  render: renderHypercareSettingsPanel },
  { id: 'categories', label: 'Categories', render: renderCategoriesSettingsPanel },
];

function renderSettings() {
  if (!settingsSubnav || !settingsContent) return;
  if (!SETTINGS_PANELS.some(p => p.id === state.settings.panel)) {
    state.settings.panel = SETTINGS_PANELS[0].id;
  }
  settingsSubnav.innerHTML = SETTINGS_PANELS.map(p =>
    `<button class="settings-navitem${p.id === state.settings.panel ? ' active' : ''}" ` +
    `data-settings-panel="${p.id}">${esc(p.label)}</button>`
  ).join('');
  settingsSubnav.querySelectorAll('.settings-navitem').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.panel = btn.dataset.settingsPanel;
      renderSettings();
    });
  });
  SETTINGS_PANELS.find(p => p.id === state.settings.panel).render();
}

// ── Settings: Hypercare panel ────────────────────────────────────────────────

async function renderHypercareSettingsPanel() {
  if (!settingsContent) return;
  settingsContent.innerHTML = '<div class="settings-panel-intro">Loading Hypercare settings…</div>';
  const cfg = await loadHypercareConfig();
  // The user may have navigated away while the fetch was in flight.
  if (state.view !== 'settings' || state.settings.panel !== 'hypercare') return;
  if (!cfg) {
    settingsContent.innerHTML = '<div class="hypercare-empty inline-error">Could not load Hypercare settings.</div>';
    return;
  }
  settingsContent.innerHTML = hypercareSettingsHtml(cfg);
}

function settingsNumberField({ key, label, value, min, max, hint }) {
  return `<div class="settings-field">
    <label for="set-${key}">${esc(label)}</label>
    <input class="settings-input" id="set-${key}" data-setting="${key}"
           type="number" min="${min}" max="${max}" value="${esc(String(value))}">
    <span class="settings-hint">${esc(hint)}</span>
  </div>`;
}

function vipRowHtml(client = {}) {
  const domains = Array.isArray(client.domains) ? client.domains.join(', ') : '';
  return `<div class="settings-vip-row">
    <input class="settings-input" data-vip="name" value="${esc(client.name || '')}"
           placeholder="Client name" maxlength="80">
    <input class="settings-input" data-vip="domains" value="${esc(domains)}"
           placeholder="domain.com, domain.ie">
    <input class="settings-input" data-vip="reason" value="${esc(client.reason || '')}"
           placeholder="Why VIP" maxlength="200">
    <button class="settings-vip-remove" data-vip-remove type="button" title="Remove client">✕</button>
  </div>`;
}

function notifStatusHtml(n) {
  const row = (label, on) =>
    `<div class="settings-notif-row">
      <span class="settings-notif-dot ${on ? 'on' : 'off'}"></span>
      ${esc(label)}: <strong>${on ? 'on' : 'off'}</strong>
    </div>`;
  const channels = (n && n.channels) || {};
  const note = (n && n.enabled)
    ? 'Alerts fire when a load goes overdue while the Hypercare page is open.'
    : 'Add the credentials and restart the service to enable alerts.';
  return row('Telegram', !!channels.telegram) +
    row('Microsoft Teams', !!channels.teams) +
    `<div class="settings-notif-note">Alert credentials live server-side in ` +
    `<code>backend/.env</code> (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ` +
    `TEAMS_WEBHOOK_URL) and can't be edited from the browser by design. ${note}</div>`;
}

function hypercareSettingsHtml(cfg) {
  const vipRows = (cfg.vipClients || []).map(vipRowHtml).join('');
  return `
    <div class="settings-panel-title">Hypercare</div>
    <div class="settings-panel-intro">VIP-load monitoring thresholds and watch-list.
      Changes save to the server and apply immediately — no restart needed.</div>

    <div class="settings-card">
      <div class="settings-card-head">Service-level thresholds</div>
      <div class="settings-field-grid">
        ${settingsNumberField({ key: 'slaMinutes', label: 'SLA (minutes)',
          value: cfg.slaMinutes, min: 1, max: 1440,
          hint: 'Applies to every VIP load.' })}
        ${settingsNumberField({ key: 'amberThresholdPct', label: 'Amber threshold (%)',
          value: cfg.amberThresholdPct, min: 1, max: 99,
          hint: 'A load turns amber once this share of its SLA has elapsed.' })}
        ${settingsNumberField({ key: 'refreshIntervalSec', label: 'Auto-refresh (seconds)',
          value: cfg.refreshIntervalSec, min: 10, max: 600,
          hint: 'How often the queue re-polls while the page is open.' })}
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-head">VIP clients</div>
      <div class="settings-vip-head">
        <span>Name</span><span>Domains</span><span>Reason</span><span></span>
      </div>
      <div class="settings-vip-list" id="settings-vip-list">
        ${vipRows || '<div class="settings-vip-empty">No VIP clients yet — add one below.</div>'}
      </div>
      <button class="settings-add-btn" id="settings-add-vip" type="button">+ Add VIP client</button>
    </div>

    <div class="settings-card">
      <div class="settings-card-head">Overdue-load alerts</div>
      ${notifStatusHtml(cfg.notifications || {})}
    </div>

    <div class="settings-savebar">
      <button class="btn btn-primary btn-sm" id="settings-save">Save changes</button>
      <button class="btn btn-secondary btn-sm" id="settings-reset" type="button">Reset</button>
      <span class="settings-dirty" id="settings-dirty"></span>
    </div>
  `;
}

function markSettingsDirty() {
  const dirty = $('settings-dirty');
  if (dirty) { dirty.textContent = 'Unsaved changes'; dirty.classList.remove('saved'); }
}

function addVipRow() {
  const list = $('settings-vip-list');
  if (!list) return;
  const empty = list.querySelector('.settings-vip-empty');
  if (empty) empty.remove();
  list.insertAdjacentHTML('beforeend', vipRowHtml());
  const rows = list.querySelectorAll('.settings-vip-row');
  rows[rows.length - 1].querySelector('[data-vip="name"]').focus();
  markSettingsDirty();
}

// Scrape the Hypercare settings form into a config patch. Fully-blank VIP rows
// are dropped silently; the backend validates ranges and rejects bad values.
function collectHypercareSettings() {
  const setting = key => {
    const el = settingsContent.querySelector(`[data-setting="${key}"]`);
    return el ? Number(el.value.trim()) : NaN;
  };
  const patch = {
    slaMinutes: setting('slaMinutes'),
    amberThresholdPct: setting('amberThresholdPct'),
    refreshIntervalSec: setting('refreshIntervalSec'),
    vipClients: [],
  };
  settingsContent.querySelectorAll('.settings-vip-row').forEach(row => {
    const field = k => {
      const el = row.querySelector(`[data-vip="${k}"]`);
      return el ? el.value.trim() : '';
    };
    const name = field('name');
    const domains = field('domains'), reason = field('reason');
    if (!name && !domains && !reason) return;   // empty row — skip
    const client = { name, domains: domains.split(',').map(d => d.trim()).filter(Boolean) };
    if (reason) client.reason = reason;
    patch.vipClients.push(client);
  });
  return patch;
}

function saveHypercareSettings(btn) {
  settingsContent.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));

  // A VIP row with any content but no name is almost certainly a slip — catch
  // it here so the user keeps their typing instead of having the row dropped.
  let firstBad = null;
  settingsContent.querySelectorAll('.settings-vip-row').forEach(row => {
    const nameEl = row.querySelector('[data-vip="name"]');
    const filled = [...row.querySelectorAll('[data-vip]')].some(f => f.value.trim());
    if (filled && !nameEl.value.trim()) {
      nameEl.classList.add('is-invalid');
      firstBad = firstBad || nameEl;
    }
  });
  if (firstBad) {
    toast('Every VIP client row needs a name — fill it in or clear the row.', 'error');
    firstBad.focus();
    return;
  }

  const patch = collectHypercareSettings();
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  apiFetch('/api/hypercare/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(updated => {
    state.hypercare.config = updated;
    applyHypercareConfigToUi(updated);
    toast('Hypercare settings saved.', 'success');
    return renderHypercareSettingsPanel();
  }).then(() => {
    const dirty = $('settings-dirty');
    if (dirty) { dirty.textContent = '✓ Saved'; dirty.classList.add('saved'); }
  }).catch(err => {
    errorToast('Could not save settings', err);
    btn.disabled = false;
    btn.textContent = original;
  });
}

// Delegated wiring — bound once. The panel render functions replace the
// innerHTML of #settings-content on every render, so per-render listeners
// would accumulate; delegation on the stable parent avoids that. Save/reset
// buttons are shared, dispatched by the currently-active panel.
if (settingsContent) {
  settingsContent.addEventListener('input', markSettingsDirty);
  settingsContent.addEventListener('click', e => {
    const save = e.target.closest('#settings-save');
    if (save) {
      if (state.settings.panel === 'categories') saveCategoriesSettings(save);
      else saveHypercareSettings(save);
      return;
    }
    if (e.target.closest('#settings-reset')) {
      const panel = SETTINGS_PANELS.find(p => p.id === state.settings.panel);
      if (panel) panel.render();
      return;
    }
    if (e.target.closest('#settings-add-vip')) { addVipRow(); return; }
    const vipRem = e.target.closest('[data-vip-remove]');
    if (vipRem) { vipRem.closest('.settings-vip-row').remove(); markSettingsDirty(); return; }
    if (e.target.closest('#settings-add-category')) { addCategoryCard(); return; }
    const catRem = e.target.closest('[data-cat-remove]');
    if (catRem) { catRem.closest('.settings-cat-card').remove(); markSettingsDirty(); return; }
  });
}

// ── Settings: Categories panel ───────────────────────────────────────────────

async function renderCategoriesSettingsPanel() {
  if (!settingsContent) return;
  settingsContent.innerHTML = '<div class="settings-panel-intro">Loading category rules…</div>';
  try {
    const cfg = await apiFetch('/api/categories/config');
    if (state.view !== 'settings' || state.settings.panel !== 'categories') return;
    state.categories.config = cfg;
    settingsContent.innerHTML = categoriesSettingsHtml(cfg);
  } catch (err) {
    if (state.view !== 'settings' || state.settings.panel !== 'categories') return;
    settingsContent.innerHTML =
      `<div class="hypercare-empty inline-error">Could not load categories: ${formatErrorMessage(err)}</div>`;
    handleApiError(err);
  }
}

const CAT_PRIORITIES = [
  { id: 1, label: 'High (1)' },
  { id: 2, label: 'Medium (2)' },
  { id: 3, label: 'Low (3)' },
];

function categoriesSettingsHtml(cfg) {
  const cards = (cfg.categories || []).map(catCardHtml).join('');
  return `
    <div class="settings-panel-title">Categories</div>
    <div class="settings-panel-intro">Rules behind the 5 cards at the bottom of the Overview page.
      Edit keywords, sender domains, labels, and priorities. Each card needs at least one rule —
      a card with no rules can never match. Changes save server-side and apply to the next inbound
      email; the Overview counts refresh on the next poll.</div>

    <div class="settings-cat-list" id="settings-cat-list">
      ${cards || '<div class="settings-vip-empty">No categories yet — add one below.</div>'}
    </div>
    <button class="settings-add-btn" id="settings-add-category" type="button">+ Add category</button>

    <div class="settings-savebar">
      <button class="btn btn-primary btn-sm" id="settings-save">Save changes</button>
      <button class="btn btn-secondary btn-sm" id="settings-reset" type="button">Reset</button>
      <span class="settings-dirty" id="settings-dirty"></span>
    </div>
  `;
}

function catCardHtml(cat = {}) {
  const rules = cat.rules || {};
  const subj  = (rules.subject_keywords || []).join(', ');
  const doms  = (rules.sender_domains   || []).join(', ');
  const sndrs = (rules.sender_keywords  || []).join(', ');
  const priority = cat.priority || 2;
  return `<div class="settings-cat-card">
    <div class="settings-cat-head">
      <input class="settings-input settings-cat-icon" data-cat="icon"
             value="${esc(cat.icon || '')}" placeholder="🔧" maxlength="4" title="Icon (emoji)">
      <input class="settings-input settings-cat-label" data-cat="label"
             value="${esc(cat.label || '')}" placeholder="Card label" maxlength="60">
      <button class="settings-vip-remove" data-cat-remove type="button" title="Remove category">✕</button>
    </div>
    <div class="settings-cat-meta">
      <div class="settings-field">
        <label>ID</label>
        <input class="settings-input" data-cat="id" value="${esc(cat.id || '')}"
               placeholder="snake_case_id" maxlength="40" pattern="[a-z0-9_]{2,40}">
        <span class="settings-hint">Lowercase letters, digits, underscore. Used internally — avoid renaming once set.</span>
      </div>
      <div class="settings-field">
        <label>Priority</label>
        <select class="settings-input" data-cat="priority">
          ${CAT_PRIORITIES.map(p => `<option value="${p.id}"${p.id === priority ? ' selected' : ''}>${p.label}</option>`).join('')}
        </select>
        <span class="settings-hint">Higher-priority cards float to the front of the row.</span>
      </div>
      <div class="settings-field">
        <label>Colour</label>
        <input class="settings-input" data-cat="color" value="${esc(cat.color || '#888888')}"
               placeholder="#1EBFEB" maxlength="7">
        <span class="settings-hint">Hex like #1EBFEB. Used for the card accent.</span>
      </div>
    </div>
    <div class="settings-cat-rules">
      <div class="settings-field">
        <label>Subject keywords</label>
        <textarea class="settings-input settings-cat-textarea" data-cat="subject_keywords"
                  placeholder="urgent, complaint, damaged">${esc(subj)}</textarea>
        <span class="settings-hint">Comma-separated. Substring match, case-insensitive.</span>
      </div>
      <div class="settings-field">
        <label>Sender domains</label>
        <textarea class="settings-input settings-cat-textarea" data-cat="sender_domains"
                  placeholder="pfizer.com, msd.com">${esc(doms)}</textarea>
        <span class="settings-hint">Exact domain match (no @, case-insensitive).</span>
      </div>
      <div class="settings-field">
        <label>Sender keywords</label>
        <textarea class="settings-input settings-cat-textarea" data-cat="sender_keywords"
                  placeholder="postmaster, noreply">${esc(sndrs)}</textarea>
        <span class="settings-hint">Substring match against the sender's local-part (before @).</span>
      </div>
    </div>
  </div>`;
}

function addCategoryCard() {
  const list = $('settings-cat-list');
  if (!list) return;
  const empty = list.querySelector('.settings-vip-empty');
  if (empty) empty.remove();
  list.insertAdjacentHTML('beforeend', catCardHtml({ priority: 2 }));
  const cards = list.querySelectorAll('.settings-cat-card');
  cards[cards.length - 1].querySelector('[data-cat="label"]').focus();
  markSettingsDirty();
}

// Comma-or-newline split + trim + lowercase. The backend also normalises but
// we do it here so what the user sees is what gets saved.
function splitList(raw) {
  return String(raw || '')
    .split(/[,\n]/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function collectCategoriesSettings() {
  const cards = [...settingsContent.querySelectorAll('.settings-cat-card')];
  return {
    categories: cards.map(card => {
      const field = k => {
        const el = card.querySelector(`[data-cat="${k}"]`);
        return el ? el.value.trim() : '';
      };
      return {
        id: field('id'),
        label: field('label'),
        icon: field('icon'),
        color: field('color'),
        priority: Number(field('priority')) || 2,
        rules: {
          subject_keywords: splitList(field('subject_keywords')),
          sender_domains:   splitList(field('sender_domains')),
          sender_keywords:  splitList(field('sender_keywords')),
        },
      };
    }),
  };
}

function saveCategoriesSettings(btn) {
  settingsContent.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));

  // Clientside guard: every card must have an id and a label, otherwise the
  // backend rejects the whole patch and the user has to reverse-engineer which
  // card is bad. Highlight the offender.
  let firstBad = null;
  settingsContent.querySelectorAll('.settings-cat-card').forEach(card => {
    const id    = card.querySelector('[data-cat="id"]');
    const label = card.querySelector('[data-cat="label"]');
    if (!id.value.trim())    { id.classList.add('is-invalid');    firstBad = firstBad || id; }
    if (!label.value.trim()) { label.classList.add('is-invalid'); firstBad = firstBad || label; }
  });
  if (firstBad) {
    toast('Every category needs an id and a label.', 'error');
    firstBad.focus();
    return;
  }

  const patch = collectCategoriesSettings();
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  apiFetch('/api/categories/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(updated => {
    state.categories.config = updated;
    toast('Categories saved.', 'success');
    // Re-render from server state (server may have normalised ids, etc.).
    return renderCategoriesSettingsPanel();
  }).then(() => {
    const dirty = $('settings-dirty');
    if (dirty) { dirty.textContent = '✓ Saved'; dirty.classList.add('saved'); }
    // Bust the local categories cache so the Overview re-fetches on next view.
    if (state.view === 'settings') { /* user is still here, no immediate effect needed */ }
  }).catch(err => {
    errorToast('Could not save categories', err);
    btn.disabled = false;
    btn.textContent = original;
  });
}

// ── Top Clients ───────────────────────────────────────────────────────────────

// Per-thread status → display. red = past 2× SLA, amber = past SLA, green = within.
const TC_STATUS = {
  red:   { label: 'Overdue',  cls: 'red' },
  amber: { label: 'Due soon', cls: 'amber' },
  green: { label: 'On track', cls: 'green' },
};

// Compact euro figure for the client meta line: €850k / €1.2M.
function formatEurShort(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return '€' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M';
  if (v >= 1e3) return '€' + Math.round(v / 1e3) + 'k';
  return '€' + v;
}

function formatWaited(hours) {
  const h = Number(hours) || 0;
  if (h < 1) return Math.round(h * 60) + 'm';
  return (Math.round(h * 10) / 10) + 'h';
}

async function loadTopClients() {
  if (!tcList) return;
  state.topclients.expanded = null;
  state.topclients.threadCache = {};
  renderTopClientsAddPanel();
  tcList.innerHTML = '<div class="tc-loading">Loading clients…</div>';
  try {
    state.topclients.config = await apiFetch('/api/topclients');
    renderTopClientsList();
  } catch (err) {
    tcList.innerHTML = `<div class="hypercare-empty inline-error">Failed to load top clients: ${formatErrorMessage(err)}</div>`;
    handleApiError(err);
  }
}

function renderTopClientsAddPanel() {
  if (!tcAdd) return;
  tcAdd.innerHTML = `
    <details class="tc-add-card">
      <summary class="tc-add-summary">+ Add a top client</summary>
      <div class="tc-add-form">
        <div class="tc-add-grid">
          <div class="settings-field">
            <label for="tc-f-name">Name</label>
            <input class="settings-input" id="tc-f-name" maxlength="80" placeholder="Acme Logistics">
          </div>
          <div class="settings-field">
            <label for="tc-f-domains">Email domains</label>
            <input class="settings-input" id="tc-f-domains" placeholder="acme.com, acme.ie">
          </div>
          <div class="settings-field">
            <label for="tc-f-value">Annual value (€)</label>
            <input class="settings-input" id="tc-f-value" type="number" min="0" placeholder="500000">
          </div>
          <div class="settings-field">
            <label for="tc-f-sla">SLA (hours)</label>
            <input class="settings-input" id="tc-f-sla" type="number" min="1" max="168" placeholder="3">
          </div>
        </div>
        <div class="tc-add-actions">
          <button class="btn btn-primary btn-sm" id="tc-add-submit" type="button">Add client</button>
        </div>
      </div>
    </details>`;
}

function renderTopClientsList() {
  if (!tcList) return;
  const clients = (state.topclients.config && state.topclients.config.clients) || [];
  if (topclientsSubtitle) {
    topclientsSubtitle.textContent = clients.length
      ? `${clients.length} key account${clients.length === 1 ? '' : 's'} · click a client to see their open emails`
      : 'No key accounts configured yet';
  }
  tcList.innerHTML = clients.length
    ? clients.map(renderTopClientRow).join('')
    : '<div class="tc-empty">No top clients yet — add one with the panel above.</div>';
  // Re-hydrate the open client's threads after any list re-render.
  if (state.topclients.expanded) loadClientThreads(state.topclients.expanded);
}

function renderTopClientRow(client) {
  const expanded = state.topclients.expanded === client.name;
  const domains = (client.domains || []).join(', ');
  const meta = `${formatEurShort(client.annual_value_eur)}/yr · ${esc(String(client.sla_hours))}h SLA · ${esc(domains)}`;
  return `<div class="tc-client${expanded ? ' is-open' : ''}" data-tc-client="${esc(client.name)}">
    <div class="tc-client-head" data-tc-toggle>
      <span class="tc-chevron">${expanded ? '▾' : '▸'}</span>
      <span class="tc-client-name">${esc(client.name)}</span>
      <span class="tc-client-meta">${meta}</span>
      <button class="tc-remove" data-tc-remove type="button" title="Remove ${esc(client.name)}">✕</button>
    </div>
    <div class="tc-threads" data-tc-threads></div>
  </div>`;
}

function clientRowEl(name) {
  if (!tcList) return null;
  return [...tcList.querySelectorAll('.tc-client')].find(el => el.dataset.tcClient === name) || null;
}

function toggleTopClient(name) {
  state.topclients.expanded = (state.topclients.expanded === name) ? null : name;
  renderTopClientsList();
}

// Fetch (or serve from cache) one client's open threads and render them into
// that client's expanded panel, worst-first.
async function loadClientThreads(name) {
  const cached = state.topclients.threadCache[name];
  if (cached) { fillClientThreads(name, cached); return; }
  const box = clientRowEl(name)?.querySelector('[data-tc-threads]');
  if (box) box.innerHTML = '<div class="tc-loading">Loading emails…</div>';
  try {
    const data = await apiFetch(`/api/dashboard/client-threads?client=${encodeURIComponent(name)}`);
    state.topclients.threadCache[name] = data.threads || [];
    if (state.topclients.expanded === name) fillClientThreads(name, data.threads || []);
  } catch (err) {
    const b = clientRowEl(name)?.querySelector('[data-tc-threads]');
    if (b) b.innerHTML = `<div class="inline-error">Failed to load emails: ${formatErrorMessage(err)}</div>`;
  }
}

function fillClientThreads(name, threads) {
  const box = clientRowEl(name)?.querySelector('[data-tc-threads]');
  if (!box) return;
  box.innerHTML = threads.length
    ? threads.map(renderClientThreadRow).join('')
    : '<div class="tc-threads-empty">No open emails — all caught up ✓</div>';
}

function renderClientThreadRow(t) {
  const st = TC_STATUS[t.status] || TC_STATUS.green;
  const inboxLbl = INBOX_LABELS[t.inbox] || t.inbox;
  return `<div class="tc-thread tc-st-${st.cls}" data-tc-thread
               data-inbox="${esc(t.inbox)}" data-msg="${esc(t.messageId)}">
    <span class="tc-thread-dot"></span>
    <div class="tc-thread-body">
      <div class="tc-thread-subject">${esc(t.subject)}</div>
      <div class="tc-thread-meta">${esc(inboxLbl)} · waiting ${esc(formatWaited(t.waitingHours))}</div>
    </div>
    <span class="tc-thread-status">${esc(st.label)}</span>
  </div>`;
}

function submitNewTopClient() {
  const val = id => { const el = $(id); return el ? el.value.trim() : ''; };
  const name = val('tc-f-name');
  if (!name) { toast('Enter a client name.', 'error'); const e = $('tc-f-name'); if (e) e.focus(); return; }
  const payload = {
    name,
    domains: val('tc-f-domains'),
    annual_value_eur: val('tc-f-value'),
    sla_hours: val('tc-f-sla'),
  };
  const btn = $('tc-add-submit');
  const original = btn ? btn.textContent : 'Add client';
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  apiFetch('/api/topclients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(data => {
    state.topclients.config = data.config;
    state.topclients.threadCache = {};   // roster changed — drop cached threads
    toast(`Added ${data.client.name} to top clients.`, 'success');
    ['tc-f-name', 'tc-f-domains', 'tc-f-value', 'tc-f-sla'].forEach(id => {
      const e = $(id); if (e) e.value = '';
    });
    const card = tcAdd.querySelector('.tc-add-card');
    if (card) card.open = false;
    renderTopClientsList();
  }).catch(err => {
    errorToast('Could not add client', err);
  }).finally(() => {
    const b = $('tc-add-submit');
    if (b) { b.disabled = false; b.textContent = original; }
  });
}

function removeTopClient(name) {
  apiFetch(`/api/topclients/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(data => {
      state.topclients.config = data.config;
      delete state.topclients.threadCache[name];
      if (state.topclients.expanded === name) state.topclients.expanded = null;
      toast(`Removed ${name} from top clients.`, 'success');
      renderTopClientsList();
    })
    .catch(err => errorToast('Could not remove client', err));
}

// Delegated wiring — bound once on the stable containers (their innerHTML is
// replaced per render, so per-render listeners would accumulate).
if (tcAdd) {
  tcAdd.addEventListener('click', e => {
    if (e.target.closest('#tc-add-submit')) submitNewTopClient();
  });
  tcAdd.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('input.settings-input')) {
      e.preventDefault();
      submitNewTopClient();
    }
  });
}

if (tcList) {
  tcList.addEventListener('click', e => {
    const removeBtn = e.target.closest('[data-tc-remove]');
    if (removeBtn) {
      const name = removeBtn.closest('.tc-client')?.dataset.tcClient;
      if (name && confirm(`Remove ${name} from top clients?`)) removeTopClient(name);
      return;
    }
    const thread = e.target.closest('[data-tc-thread]');
    if (thread) {
      const { inbox, msg } = thread.dataset;
      if (inbox && msg) { showInbox(inbox); openEmail(msg); }
      return;
    }
    const head = e.target.closest('[data-tc-toggle]');
    if (head) {
      const name = head.closest('.tc-client')?.dataset.tcClient;
      if (name) toggleTopClient(name);
    }
  });
}

if (topclientsRefresh) topclientsRefresh.addEventListener('click', () => loadTopClients());

// ── Search ────────────────────────────────────────────────────────────────────

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = searchInput.value.trim();
    loadInbox(state.activeInbox);
  }, 400);
});

// ── Auth button wiring ────────────────────────────────────────────────────────

loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

$('ms-icon').innerHTML = microsoftIcon();

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffH = diffMs / 3_600_000;
  if (diffH < 24 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffH < 168) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/** Toast for an API error: prefix + formatted message (code + requestId). Stays longer. */
function errorToast(prefix, err) {
  const el = document.createElement('div');
  el.className = 'toast error';
  el.innerHTML = `${esc(prefix)}: ${formatErrorMessage(err)}`;
  $('toast-container').appendChild(el);
  // Errors stick around longer so the user can read/copy the request id.
  setTimeout(() => el.remove(), 8000);
  handleApiError(err);
}

// ── "Updated Xs ago" timestamps (Phase 2 Session 4) ──────────────────────────

/**
 * Stamp an ISO timestamp onto a container element. A ticker (below) reads the
 * data attribute and re-renders the relative time every 10s.
 */
function stampUpdated(containerId, iso) {
  const root = document.getElementById(containerId);
  if (!root || !iso) return;
  // Locate or create a `.widget-updated` indicator placed at the top-right of
  // the container. We put it in the first .tile-head we find — most widgets
  // have one. Fallback: append a floating chip in the container itself.
  let badge = root.querySelector('.widget-updated');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'widget-updated';
    const head = root.querySelector('.tile-head, .missed-head, .cat-head');
    if (head) head.appendChild(badge);
    else root.prepend(badge);
  }
  badge.dataset.cachedAt = iso;
  badge.textContent = relTime(iso);
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 5)   return 'just now';
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

// Tick all visible updated-stamps every 10s
setInterval(() => {
  document.querySelectorAll('.widget-updated[data-cached-at]').forEach(el => {
    el.textContent = relTime(el.dataset.cachedAt);
  });
}, 10_000);

function microsoftIcon() {
  return `<svg width="18" height="18" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="10" height="10" fill="#F25022"/><rect x="11" width="10" height="10" fill="#7FBA00"/>
    <rect y="11" width="10" height="10" fill="#00A4EF"/><rect x="11" y="11" width="10" height="10" fill="#FFB900"/>
  </svg>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Live date/time under the sidebar logo.
function startSidebarClock() {
  const timeEl = document.getElementById('sidebar-clock-time');
  const dateEl = document.getElementById('sidebar-clock-date');
  if (!timeEl || !dateEl) return;
  function tick() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }
  tick();
  setInterval(tick, 15_000); // minute-resolution display; refresh often enough to stay accurate
}
startSidebarClock();

checkAuth();
