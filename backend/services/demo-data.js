/**
 * Synthetic data for Demo Mode. Each function returns a payload that matches
 * the real endpoint's response shape. Timestamps are computed relative to
 * `Date.now()` so age-based displays (oldest_waiting_hours, etc.) stay accurate
 * across refreshes — the dashboard feels live without touching Graph.
 *
 * Toggle from the UI header. Real mailboxes are untouched.
 */

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

const isoAgo = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const dayKey = (offsetDays) => {
  const d = new Date(Date.now() - offsetDays * DAY_MS);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
};

// Stable-ish IDs so jump-to-thread doesn't 404 — they just won't actually open
// a real message; the inbox panel will show "(loading...)" and then surface the
// 404 error nicely. Good enough for screenshots.
const DEMO_ID = (slug) => `demo-${slug}`;

function clientHealth() {
  return {
    clients: [
      {
        name: 'Maersk', status: 'red',
        open_threads: 2, oldest_waiting_hours: 5.3,
        revenue_at_risk_eur: 850000, sla_hours: 2,
        latest_subject: 'URGENT: Trailer collection Dublin Port — bay 14 booked 09:00',
        jump: { inbox: 'operations', message_id: DEMO_ID('maersk') },
      },
      {
        name: 'DFDS', status: 'amber',
        open_threads: 1, oldest_waiting_hours: 3.8,
        revenue_at_risk_eur: 0, sla_hours: 3,
        latest_subject: 'Q3 rate negotiation — Rosslare to Dunkirk',
        jump: { inbox: 'eu', message_id: DEMO_ID('dfds') },
      },
      {
        name: 'Lidl Ireland', status: 'amber',
        open_threads: 1, oldest_waiting_hours: 4.2,
        revenue_at_risk_eur: 0, sla_hours: 3,
        latest_subject: 'Load enquiry: 5 trailers Newbridge DC weekly',
        jump: { inbox: 'ireland', message_id: DEMO_ID('lidl') },
      },
      {
        name: 'DHL', status: 'green',
        open_threads: 0, oldest_waiting_hours: 0,
        revenue_at_risk_eur: 0, sla_hours: 2,
        latest_subject: null, jump: null,
      },
      {
        name: 'Kuehne+Nagel', status: 'green',
        open_threads: 0, oldest_waiting_hours: 0,
        revenue_at_risk_eur: 0, sla_hours: 2,
        latest_subject: null, jump: null,
      },
      {
        name: 'Tesco UK', status: 'green',
        open_threads: 0, oldest_waiting_hours: 0,
        revenue_at_risk_eur: 0, sla_hours: 3,
        latest_subject: null, jump: null,
      },
    ],
    summary: {
      total_clients: 6, green: 3, amber: 2, red: 1,
      total_revenue_at_risk_eur: 850000,
    },
  };
}

function overview() {
  // Build 7-day inbound sparkline ending today
  const dailySeries = [];
  const counts = [22, 31, 28, 45, 39, 41, 47]; // last bar = today
  for (let i = 6; i >= 0; i--) {
    dailySeries.push({ date: dayKey(i), count: counts[6 - i] });
  }
  const today = counts[6];
  const total7d = counts.reduce((a, b) => a + b, 0);
  const dailyAverage7d = Math.round((total7d / 7) * 10) / 10;
  const delta = Math.round((today - dailyAverage7d) * 10) / 10;
  const deltaPct = dailyAverage7d > 0 ? Math.round(((today - dailyAverage7d) / dailyAverage7d) * 100) : null;

  return {
    generatedAt: new Date().toISOString(),
    oldestUnanswered: {
      id: 'demo-oldest',
      subject: 'URGENT: Trailer collection Dublin Port — bay 14 booked 09:00',
      senderName: 'Maersk Operations',
      senderAddress: 'ops@maersk.com',
      inbox: 'operations',
      receivedAt: isoAgo(5.3),
      ageHours: 5.3,
    },
    waiting: {
      thresholdHours: 4,
      count: 4,
      byInbox: { operations: 2, export: 1, eu: 1, ireland: 0, uk: 0, offers: 0 },
    },
    afterHours24h: {
      count: 6,
      byInbox: { operations: 2, ireland: 1, uk: 2, eu: 0, export: 0, offers: 1 },
    },
    inbound: {
      today,
      dailyAverage7d,
      delta,
      deltaPct,
      daily: dailySeries,
    },
  };
}

function categories() {
  return {
    categories: [
      { id: 'high_priority', label: 'High Priority', icon: '⚠️', color: '#f44336',
        priority: 1, open_count: 2, urgent_count: 2, oldest_hours: 3.1 },
      { id: 'pharma', label: 'Pharma Loads', icon: '🧪', color: '#e91e63',
        priority: 1, open_count: 3, urgent_count: 1, oldest_hours: 6.2 },
      { id: 'it_alerts', label: 'IT / Server Loads', icon: '🔧', color: '#9c27b0',
        priority: 1, open_count: 1, urgent_count: 1, oldest_hours: 0.8 },
      { id: 'quotes', label: 'Quote Requests', icon: '💰', color: '#4caf50',
        priority: 2, open_count: 8, urgent_count: 2, oldest_hours: 1.5 },
      { id: 'new_customers', label: 'New Customers', icon: '🤝', color: '#1EBFEB',
        priority: 2, open_count: 4, urgent_count: 1, oldest_hours: 4.8 },
    ],
  };
}

function performance() {
  return {
    avg_response_time: {
      today_minutes: 47,
      seven_day_avg_minutes: 62,
      thirty_day_avg_minutes: 71,
      trend: 'improving',
    },
    first_response_rate: {
      today_percent: 64,
      target_percent: 50,
      status: 'above_target',
    },
    by_inbox: {
      operations: { avg_minutes: 35, first_response_percent: 72 },
      export:     { avg_minutes: 58, first_response_percent: 55 },
      ireland:    { avg_minutes: 41, first_response_percent: 68 },
      uk:         { avg_minutes: 49, first_response_percent: 61 },
      eu:         { avg_minutes: 73, first_response_percent: 48 },
      offers:     { avg_minutes: 38, first_response_percent: 70 },
    },
  };
}

function missed() {
  return {
    total_missed: 8,
    by_inbox: { operations: 3, uk: 2, eu: 2, ireland: 1, export: 0, offers: 0 },
    oldest: {
      subject: 'Re: Trailer collection Tuesday — confirmation needed',
      sender: 'dispatch@logistics-partner.com',
      received: isoAgo(47),
      inbox: 'operations',
      message_id: DEMO_ID('missed'),
    },
  };
}

function itAlerts() {
  const samples = [
    { subject: 'Mail Delivery Failure: external recipient',
      sender: 'postmaster@caffreyops.com', received_iso: isoAgo(0.2),
      inbox: 'operations', message_id: DEMO_ID('alert1') },
    { subject: '[ALERT] Disk usage above threshold on srv-fileshare-01',
      sender: 'monitoring@caffreyops.com', received_iso: isoAgo(0.4),
      inbox: 'operations', message_id: DEMO_ID('alert2') },
    { subject: 'Undeliverable: Q3 rate confirmation',
      sender: 'mailer-daemon@caffreyops.com', received_iso: isoAgo(0.6),
      inbox: 'export', message_id: DEMO_ID('alert3') },
    { subject: '[OUTAGE] tracking-portal.caffreyops.com — 502',
      sender: 'alerts@uptimerobot.com', received_iso: isoAgo(0.75),
      inbox: 'operations', message_id: DEMO_ID('alert4') },
    { subject: 'Critical: Mailbox quota 95% on export@',
      sender: 'monitoring@caffreyops.com', received_iso: isoAgo(0.9),
      inbox: 'export', message_id: DEMO_ID('alert5') },
  ];
  return {
    alerts_24h: 14,
    alerts_1h: 14,
    threshold: 10,
    status: 'alert',
    recent_alerts: samples,
  };
}

function stalled() {
  return {
    stalled: [
      { subject: 'Re: Q3 rates Maersk Dublin route', sent_to: 'ops@maersk.com',
        sent_iso: isoAgo(120), days_waiting: 5, client_name: 'Maersk', inbox: 'operations',
        message_id: DEMO_ID('stalled1') },
      { subject: 'Re: Confirmation needed for Tesco distribution Sept',
        sent_to: 'transport@tesco.com', sent_iso: isoAgo(96), days_waiting: 4,
        client_name: 'Tesco UK', inbox: 'uk', message_id: DEMO_ID('stalled2') },
    ],
    total: 14,
  };
}

function hypercareLoads() {
  // Cover every visual state. Times computed against Date.now() so the
  // countdown timer stays meaningful across page refreshes.
  const min = (m) => new Date(Date.now() - m * 60_000).toISOString();
  return {
    loads: [
      {
        id: 'demo-hc-1',
        bookingRef: 'MAEU-4471', client: 'Maersk', clientReason: 'Tier 1 contract',
        route: { origin: 'Dublin Port', destination: 'Rotterdam' },
        cargoValue: 185000,
        subject: 'URGENT: Trailer collection — bay 14 booked 09:00',
        fromAddress: 'ops@maersk.com',
        receivedAt: min(21), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null, escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [],
        threadUrl: '/operations/thread/demo-hc-1',
        // responseHistory: recent first-response times (minutes) for this
        // client's loads, oldest→newest — drives the §12.2 trend sparkline.
        responseHistory: [6, 7, 6, 8, 9, 11, 12],
      },
      {
        id: 'demo-hc-2',
        bookingRef: 'DHL-9982', client: 'DHL', clientReason: 'Strategic account',
        route: { origin: 'Cork', destination: 'Liverpool' },
        cargoValue: 92000,
        subject: 'Re: ETA confirmation — sailing 14:00',
        fromAddress: 'tracking@dhl.com',
        receivedAt: min(11), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null, escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [],
        threadUrl: '/operations/thread/demo-hc-2',
        responseHistory: [13, 14, 12, 13, 14, 13, 13],
      },
      {
        id: 'demo-hc-3',
        bookingRef: 'LIDL-2207', client: 'Lidl Ireland', clientReason: 'Peak season',
        route: { origin: 'Belfast', destination: 'Hamburg' },
        cargoValue: 64000,
        subject: 'Pallet count discrepancy — Newbridge DC',
        fromAddress: 'logistics@lidl.ie',
        receivedAt: min(8), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null,
        escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [
          { author: 'Sean Laffey', text: 'Phoned bay supervisor, awaiting recount.', timestamp: min(2) },
        ],
        threadUrl: '/operations/thread/demo-hc-3',
        responseHistory: [24, 21, 19, 17, 16, 14, 13],
      },
      {
        id: 'demo-hc-4',
        bookingRef: 'MAEU-4480', client: 'Maersk', clientReason: 'Tier 1 contract',
        route: { origin: 'Dublin Port', destination: 'Antwerp' },
        cargoValue: 240000,
        subject: 'Damaged seal reported on container MSCU7842113',
        fromAddress: 'claims@maersk.com',
        receivedAt: min(34), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null,
        escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [],
        threadUrl: '/operations/thread/demo-hc-4',
        responseHistory: [6, 7, 6, 8, 9, 11, 12],
      },
      {
        id: 'demo-hc-5',
        bookingRef: 'DHL-2208', client: 'DHL', clientReason: 'Strategic account',
        route: { origin: 'Rosslare', destination: 'Cherbourg' },
        cargoValue: 78000,
        subject: 'Re: Customs paperwork received — thanks',
        fromAddress: 'export@dhl.com',
        receivedAt: min(4), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null,
        escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [],
        threadUrl: '/operations/thread/demo-hc-5',
        responseHistory: [13, 14, 12, 13, 14, 13, 13],
      },
      {
        id: 'demo-hc-6',
        bookingRef: 'LIDL-991', client: 'Lidl Ireland', clientReason: 'Peak season',
        route: { origin: 'Dublin', destination: 'Newbridge DC' },
        cargoValue: 42000,
        subject: 'Delivery slot — confirmation needed',
        fromAddress: 'transport@lidl.ie',
        receivedAt: min(2), lastActionAt: null, lastActionBy: null,
        workflowState: 'monitoring',
        claimedBy: null,
        escalatedTo: null, escalatedAt: null,
        resolvedAt: null, resolvedBy: null,
        notes: [],
        threadUrl: '/operations/thread/demo-hc-6',
        responseHistory: [24, 21, 19, 17, 16, 14, 13],
      },
    ],
  };
}

function hypercareActivity() {
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  return {
    activity: [
      { timestamp: ago(2),  actor: 'Sean Laffey',  action: 'noted',   load_id: 'demo-hc-3', booking_ref: 'LIDL-2207', detail: 'Phoned bay supervisor, awaiting recount.' },
      { timestamp: ago(12), actor: 'Mark Brennan', action: 'replied', load_id: 'demo-hc-4', booking_ref: 'MAEU-4480', detail: null },
      { timestamp: ago(25), actor: 'Sean Laffey',  action: 'replied', load_id: 'demo-hc-5', booking_ref: 'DHL-2208',  detail: null },
    ],
  };
}

// Synthetic per-client open threads for the Top Clients view. The count and
// ages are derived from the client name so each client looks distinct and a
// just-added client still gets a believable set. Demo uses a flat 3h SLA proxy
// (red ≥ 6h waiting, amber ≥ 3h) since synthetic threads carry no real SLA.
function clientThreads(clientName) {
  const name = String(clientName || '').trim();
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;

  const inboxes = ['operations', 'export', 'ireland', 'uk', 'eu', 'offers'];
  const subjects = [
    'Booking enquiry — 3 trailers Dublin → Rotterdam',
    'Re: ETA confirmation — sailing delayed to 14:00',
    'Demurrage query — container held at port',
    'Rate request Q3 — Rosslare to Dunkirk',
    'POD outstanding — load reference 4471',
    'Customs paperwork follow-up — T1 document',
  ];
  const baseAges = [9.4, 5.2, 3.1, 1.2];   // overdue → fresh
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';

  const count = h % 5;   // 0–4 threads — some clients show the empty state
  const threads = [];
  for (let i = 0; i < count; i++) {
    const waitingHours = baseAges[i % baseAges.length] + ((h >> i) % 6) * 0.3;
    let status = 'green';
    if (waitingHours >= 6) status = 'red';
    else if (waitingHours >= 3) status = 'amber';
    threads.push({
      subject: subjects[(h + i) % subjects.length],
      inbox: inboxes[(h + i) % inboxes.length],
      messageId: DEMO_ID(`${slug}-${i}`),
      receivedAt: isoAgo(waitingHours),
      waitingHours: Math.round(waitingHours * 10) / 10,
      status,
    });
  }
  const rank = { red: 0, amber: 1, green: 2 };
  threads.sort((a, b) => rank[a.status] - rank[b.status] || b.waitingHours - a.waitingHours);
  return { client: name, threads, openCount: threads.length };
}

// ── Drilldowns ──────────────────────────────────────────────────────────────
// Synthetic message lists for the three Overview drilldowns. Returns the same
// {meta, items, totalCount} shape the live `getDrilldownMessages` produces.

const DEMO_SENDERS = [
  { name: 'Maersk Ops',         addr: 'ops@maersk.com',         inbox: 'operations' },
  { name: 'DFDS Logistics',     addr: 'dispatch@dfds.com',      inbox: 'export'     },
  { name: 'Lidl Ireland',       addr: 'inbound@lidl.ie',        inbox: 'ireland'    },
  { name: 'DHL UK',             addr: 'uk-ops@dhl.com',         inbox: 'uk'         },
  { name: 'Aoife Brennan',      addr: 'aoife@brennan-bakery.ie', inbox: 'eu'        },
  { name: 'Eurotunnel Freight', addr: 'freight@eurotunnel.com', inbox: 'eu'         },
  { name: 'PostNord DK',        addr: 'cargo@postnord.dk',      inbox: 'export'     },
  { name: 'Tesco Stores',       addr: 'logistics@tesco.com',    inbox: 'uk'         },
];

function demoItem(slug, subject, ageHours, senderIdx, urgent) {
  const s = DEMO_SENDERS[senderIdx % DEMO_SENDERS.length];
  return {
    id: DEMO_ID(slug),
    subject,
    senderName: s.name,
    senderAddress: s.addr,
    inbox: s.inbox,
    receivedAt: isoAgo(ageHours),
    ageHours: Math.round(ageHours * 10) / 10,
    isUrgent: !!urgent,
  };
}

function drilldown(kind, key) {
  if (kind === 'category') {
    const subjectsByCat = {
      high_priority: [
        'COMPLAINT: trailer arrived 6h late — Lidl DC11',
        'URGENT: Maersk container damaged at quay, claim opening',
        'Escalation: missed delivery slot, customer demanding credit',
      ],
      pharma: [
        'Cold chain breach — temp logger 8.4°C peak, batch IRL-227',
        'Cryo shipment ETA confirmation needed (BCN→DUB)',
        'GDP audit paperwork request, due Friday',
      ],
      it_alerts: [
        'Mailer-daemon: undeliverable to ops@partner.eu',
        'Monitoring: SMTP latency spike on outbound-1',
      ],
      quotes: [
        'Quote: 12 pallets DUB→Rotterdam weekly',
        'RFQ: ambient FTL, Coventry → Cork, recurring',
        'Pricing on chilled groupage to Bilbao?',
        'Quote needed — palletised, hazmat 3, single load',
      ],
      new_customers: [
        'New account application — Doyle Pharma Ltd',
        'Onboarding: first load next Tuesday, credit terms?',
        'Introduction — looking for weekly EU groupage partner',
      ],
    };
    const subjects = subjectsByCat[key] || ['Sample drilldown email'];
    const cat = categories().categories.find(c => c.id === key) || { id: key, label: key, icon: '📋', color: '#1EBFEB' };
    const items = subjects.map((s, i) => demoItem(`${key}-${i}`, s, (i + 1) * 2.3, i, i === 0));
    return {
      meta: { kind: 'category', id: cat.id, label: cat.label, icon: cat.icon, color: cat.color },
      items, totalCount: items.length,
    };
  }

  if (kind === 'inbound') {
    // `key` is YYYY-MM-DD. Today gets more rows; older days get fewer.
    const isToday = key === dayKey(0);
    const subjects = [
      'Booking enquiry — 2 trailers DUB→ROT, Thursday',
      'CMR scan requested for load #88421',
      'Confirmation: collection slot 14:30 confirmed',
      'Re: ETA update on container MSCU8842913',
      'BoL correction needed — wrong consignee address',
      'Demurrage charges query — invoice 7723',
      'Pre-alert: 18 pallets ambient, arriving 06:00',
      'Quote follow-up?',
    ];
    const count = isToday ? subjects.length : Math.max(2, subjects.length - 3);
    const items = subjects.slice(0, count).map((s, i) => demoItem(`inb-${key}-${i}`, s, isToday ? i * 1.1 + 0.4 : 26 + i * 1.2, i + 2, false));
    return {
      meta: { kind: 'inbound', date: key, label: `Inbound on ${key}` },
      items, totalCount: items.length,
    };
  }

  if (kind === 'first-reply') {
    if (key === 'met') {
      const items = [
        demoItem('fr-met-0', 'Re: booking confirmation — load 88440',  0.4, 0, false),
        demoItem('fr-met-1', 'Pricing for 4 pallets to Madrid',          1.2, 3, false),
        demoItem('fr-met-2', 'POD received, thanks',                     2.8, 5, false),
        demoItem('fr-met-3', 'Slot 11:00 OK for Friday',                 3.6, 7, false),
      ];
      return {
        meta: { kind: 'first-reply', bucket: 'met', label: 'First reply within 4h (today)' },
        items, totalCount: items.length,
      };
    }
    const items = [
      demoItem('fr-miss-0', 'URGENT: Trailer collection Dublin Port — bay 14 booked 09:00', 5.3, 0, true),
      demoItem('fr-miss-1', 'Need credit application form',              4.7, 1, true),
      demoItem('fr-miss-2', 'Quote on weekly chilled groupage?',         4.2, 6, false),
    ];
    return {
      meta: { kind: 'first-reply', bucket: 'missed', label: 'First reply > 4h or pending (today)' },
      items, totalCount: items.length,
    };
  }

  return { meta: { kind, key, label: 'Unknown drilldown' }, items: [], totalCount: 0 };
}

module.exports = {
  clientHealth, overview, categories, performance, missed, itAlerts, stalled,
  hypercareLoads, hypercareActivity, clientThreads, drilldown,
};
