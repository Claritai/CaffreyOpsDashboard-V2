Phase 2: CEO/Operations Manager Overview Redesign

Purpose: This document extends the Caffrey Ops Dashboard with an executive-grade overview page designed for CEOs and Operations Managers. Share this file with Claude Code after Phase 1 (initial build) is complete and the Microsoft Graph integration is working.


Prerequisite: Phase 1 dashboard must be deployed and functional with Microsoft 365 integration active.


1. Design Philosophy
The new overview answers one question in 5 seconds: "Is anything broken or about to embarrass us?"
Core principles:

Exception-based display — green/healthy items collapse, amber/red items rise to the top
Revenue and relationship focus — surface client risk, not just email counts
Action-driven — every widget should answer "what do I do about this?"
Hierarchy of urgency — critical risks at top, performance metrics at bottom


2. New Overview Page Layout
The overview replaces the current "Today at a glance" layout with five tiered rows:
┌─────────────────────────────────────────────────────────────────┐
│  HEADER: Caffrey International — Email Operations                │
├─────────────────────────────────────────────────────────────────┤
│  ROW 1 — CRITICAL ALERTS (only shown if items exist)            │
│  [Top Client Health Grid]  [Revenue at Risk]  [IT/Server]       │
├─────────────────────────────────────────────────────────────────┤
│  ROW 2 — TODAY'S PULSE                                          │
│  [Oldest Unanswered]  [Waiting >4h]  [Missed/Unopened]          │
├─────────────────────────────────────────────────────────────────┤
│  ROW 3 — CATEGORIES THAT MATTER                                 │
│  [Pharma Loads]  [Complaints]  [Quote Requests]  [Customs]      │
├─────────────────────────────────────────────────────────────────┤
│  ROW 4 — PERFORMANCE METRICS                                    │
│  [Avg Response Time]  [First Response Rate %]  [Inbound Today]  │
├─────────────────────────────────────────────────────────────────┤
│  ROW 5 — LIVE HOTLIST (top 10 urgent threads, click to open)    │
└─────────────────────────────────────────────────────────────────┘

3. Configuration Files (new)
3.1 config/top-clients.json
The "Top 15 Clients" list — used for client health scoring and revenue-at-risk.
json{
  "clients": [
    {
      "name": "Maersk",
      "domains": ["maersk.com", "maersk.ie"],
      "tier": "platinum",
      "annual_value_eur": 850000,
      "sla_hours": 2
    },
    {
      "name": "DHL",
      "domains": ["dhl.com", "dhl.ie"],
      "tier": "platinum",
      "annual_value_eur": 720000,
      "sla_hours": 2
    },
    {
      "name": "Kuehne+Nagel",
      "domains": ["kuehne-nagel.com", "kn-portal.com"],
      "tier": "platinum",
      "annual_value_eur": 680000,
      "sla_hours": 2
    },
    {
      "name": "Lidl Ireland",
      "domains": ["lidl.ie"],
      "tier": "gold",
      "annual_value_eur": 540000,
      "sla_hours": 3
    },
    {
      "name": "Tesco UK",
      "domains": ["tesco.com", "tescologistics.com"],
      "tier": "gold",
      "annual_value_eur": 510000,
      "sla_hours": 3
    },
    {
      "name": "DFDS",
      "domains": ["dfds.com"],
      "tier": "gold",
      "annual_value_eur": 460000,
      "sla_hours": 3
    }
  ],
  "tier_definitions": {
    "platinum": {
      "label": "Platinum",
      "color": "#d4a843",
      "sla_default_hours": 2
    },
    "gold": {
      "label": "Gold",
      "color": "#b08838",
      "sla_default_hours": 3
    },
    "silver": {
      "label": "Silver",
      "color": "#888888",
      "sla_default_hours": 4
    }
  }
}
Note: Sean should review and update the actual client list, domains, annual values, and SLA hours. Add up to 15 clients total.
3.2 config/categories.json
Auto-categorisation rules for inbound emails.
json{
  "categories": [
    {
      "id": "pharma",
      "label": "Pharma Loads",
      "icon": "🧪",
      "color": "#e91e63",
      "priority": 1,
      "rules": {
        "subject_keywords": ["pharma", "pharmaceutical", "medicine", "vaccine", "temperature controlled", "GDP", "cold chain"],
        "sender_domains": ["pfizer.com", "astrazeneca.com", "novartis.com", "msd.com", "gsk.com"],
        "sender_keywords": ["pharma", "pharmaceutical"]
      }
    },
    {
      "id": "complaints",
      "label": "Complaints / Escalations",
      "icon": "⚠️",
      "color": "#f44336",
      "priority": 1,
      "rules": {
        "subject_keywords": ["complaint", "urgent", "escalation", "damaged", "delayed", "missing", "wrong delivery", "claim", "incident"],
        "sender_domains": [],
        "sender_keywords": []
      }
    },
    {
      "id": "quotes",
      "label": "Quote Requests",
      "icon": "💰",
      "color": "#4caf50",
      "priority": 2,
      "rules": {
        "subject_keywords": ["quote", "quotation", "rate", "pricing", "tender", "rfq", "enquiry", "load available", "transport request"],
        "sender_domains": [],
        "sender_keywords": []
      }
    },
    {
      "id": "customs",
      "label": "Customs / Documentation",
      "icon": "📋",
      "color": "#ff9800",
      "priority": 2,
      "rules": {
        "subject_keywords": ["customs", "CMR", "T1", "T2", "EAD", "MRN", "declaration", "manifest", "documentation", "paperwork"],
        "sender_domains": ["revenue.ie", "hmrc.gov.uk", "douane.fr"],
        "sender_keywords": []
      }
    },
    {
      "id": "finance",
      "label": "Finance / Invoicing",
      "icon": "💼",
      "color": "#2196f3",
      "priority": 3,
      "rules": {
        "subject_keywords": ["invoice", "payment", "remittance", "credit note", "statement", "accounts", "overdue"],
        "sender_domains": [],
        "sender_keywords": ["accounts", "finance", "billing"]
      }
    },
    {
      "id": "it_alerts",
      "label": "IT / Server Alerts",
      "icon": "🔧",
      "color": "#9c27b0",
      "priority": 1,
      "rules": {
        "subject_keywords": ["alert", "monitoring", "downtime", "server", "outage", "error", "failed", "warning"],
        "sender_domains": [],
        "sender_keywords": ["postmaster", "mailer-daemon", "noreply", "monitoring", "alerts", "no-reply"]
      }
    }
  ]
}
Note: Sean should review keywords against actual email patterns in the inboxes — adjust based on what's commonly received.
3.3 config/sla.json
Default SLA targets used across the dashboard.
json{
  "default_first_response_hours": 4,
  "thresholds": {
    "green_max_hours": 2,
    "amber_max_hours": 4,
    "red_min_hours": 4
  },
  "after_hours": {
    "start": "18:00",
    "end": "08:00",
    "weekends_count_as_after_hours": true
  },
  "missed_threshold_hours": 24,
  "stalled_threshold_hours": 48
}

4. Backend — New API Endpoints
Add the following endpoints to the Express backend. Each fetches live from Microsoft Graph API and computes server-side. No data is stored.
4.1 GET /api/dashboard/client-health
Returns the health status of each top client based on their open emails.
Response:
json{
  "clients": [
    {
      "name": "Maersk",
      "tier": "platinum",
      "status": "red",
      "open_threads": 2,
      "oldest_waiting_hours": 5.3,
      "revenue_at_risk_eur": 850000,
      "sla_hours": 2,
      "latest_subject": "Available capacity: 3 trailers Dublin → Cherbourg"
    },
    {
      "name": "DHL",
      "tier": "platinum",
      "status": "green",
      "open_threads": 0,
      "oldest_waiting_hours": 0,
      "revenue_at_risk_eur": 0,
      "sla_hours": 2,
      "latest_subject": null
    }
  ],
  "summary": {
    "total_clients": 15,
    "green": 11,
    "amber": 3,
    "red": 1,
    "total_revenue_at_risk_eur": 1330000
  }
}
Logic:

For each client in top-clients.json, scan all six inboxes for unread/unanswered threads from their domains
Calculate oldest waiting time
Status: green if no open threads OR waiting < client SLA, amber if waiting > SLA but < 2x SLA, red if waiting > 2x SLA
Revenue at risk = sum of annual values for clients in red status

4.2 GET /api/dashboard/categories
Returns counts of open emails per category.
Response:
json{
  "categories": [
    {
      "id": "pharma",
      "label": "Pharma Loads",
      "icon": "🧪",
      "open_count": 4,
      "urgent_count": 1,
      "oldest_hours": 6.2
    },
    {
      "id": "complaints",
      "label": "Complaints / Escalations",
      "icon": "⚠️",
      "open_count": 2,
      "urgent_count": 2,
      "oldest_hours": 3.1
    }
  ]
}
Logic:

For each email in the last 7 days across all inboxes, apply rules from categories.json
An email matches a category if ANY rule matches (subject keyword OR sender domain OR sender keyword)
"Urgent" = waiting > 4 hours OR from a top client
Order by priority then open_count

4.3 GET /api/dashboard/missed
Returns emails received but never opened (read status = false AND age > 24h).
Response:
json{
  "total_missed": 8,
  "by_inbox": {
    "operations": 3,
    "uk": 2,
    "ireland": 1,
    "eu": 2,
    "export": 0,
    "offers": 0
  },
  "oldest": {
    "subject": "Re: Trailer collection Tuesday",
    "sender": "dispatch@example.com",
    "received": "2026-05-13T14:23:00Z",
    "inbox": "operations"
  }
}
4.4 GET /api/dashboard/performance
Returns response time metrics and first response rate.
Response:
json{
  "avg_response_time": {
    "today_minutes": 47,
    "seven_day_avg_minutes": 62,
    "thirty_day_avg_minutes": 71,
    "trend": "improving"
  },
  "first_response_rate": {
    "today_percent": 64,
    "target_percent": 50,
    "status": "above_target"
  },
  "by_inbox": {
    "operations": { "avg_minutes": 35, "first_response_percent": 72 },
    "export": { "avg_minutes": 58, "first_response_percent": 55 },
    "ireland": { "avg_minutes": 41, "first_response_percent": 68 },
    "uk": { "avg_minutes": 49, "first_response_percent": 61 },
    "eu": { "avg_minutes": 73, "first_response_percent": 48 },
    "offers": { "avg_minutes": 38, "first_response_percent": 70 }
  }
}
Logic:

Avg response time = time between received and first sent reply, in minutes
First response rate = % of received emails replied to within default_first_response_hours (from sla.json)
Trend: "improving" if today < 7-day avg, "worsening" if today > 7-day avg, "stable" if within 10%

4.5 GET /api/dashboard/hotlist
Returns the top 10 most urgent open threads.
Response:
json{
  "threads": [
    {
      "id": "AAMkADk...",
      "subject": "Available capacity: 3 trailers Dublin → Cherbourg Friday",
      "sender_name": "Sean Laffey",
      "sender_email": "sean.n.laffey@gmail.com",
      "inbox": "offers",
      "received_iso": "2026-05-11T09:14:00Z",
      "waiting_hours": 96,
      "client_name": null,
      "client_tier": null,
      "category": "quotes",
      "urgency_score": 95
    }
  ]
}
Logic:

Pull all unanswered threads across inboxes
Score each thread:

Base score = waiting_hours * 2
+30 if from a top client (tier multiplier: platinum ×3, gold ×2, silver ×1)
+20 if categorised as complaint or pharma
+15 if category is IT alert


Return top 10 by urgency score, descending

4.6 GET /api/dashboard/stalled
Returns threads where you replied but the client has not come back in 48+ hours.
Response:
json{
  "stalled": [
    {
      "subject": "Re: Q3 rates Maersk Dublin route",
      "sent_to": "ops@maersk.com",
      "sent_iso": "2026-05-10T11:23:00Z",
      "days_waiting": 5,
      "client_name": "Maersk",
      "inbox": "operations"
    }
  ],
  "total": 14
}
4.7 GET /api/dashboard/it-alerts
Returns recent IT/server alert emails (postmaster bounces, monitoring tools, etc.).
Response:
json{
  "alerts_24h": 8,
  "threshold": 10,
  "status": "ok",
  "recent_alerts": [
    {
      "subject": "Mail Delivery Failure",
      "sender": "postmaster@caffreyops.com",
      "received_iso": "2026-05-14T22:34:00Z"
    }
  ]
}

5. Frontend — New Widget Components
Each widget is a self-contained card that fetches its data on page load and refreshes every 60 seconds.
5.1 Top Client Health Grid Widget
Layout: A grid of 15 small client tiles, each showing:

Client name
Status indicator (green ✓, amber ●, red ✕)
If amber/red: "X hours waiting"
Click to expand: shows the actual open thread(s)

Visual:
┌─────────────────────────────────────────────────────────┐
│  TOP CLIENT STATUS                          11 ✓  3 ●  1 ✕│
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Maersk   │ │ DHL      │ │ K+N      │ │ Lidl IE  │    │
│  │ ✕ 5.3h   │ │ ✓        │ │ ✓        │ │ ● 2.5h   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Tesco UK │ │ DFDS     │ │ ...      │ │ ...      │    │
│  │ ✓        │ │ ● 3.1h   │ │          │ │          │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
└─────────────────────────────────────────────────────────┘
Behaviour:

Tiles sorted: red first, then amber, then green
Green tiles can be collapsed to a single "11 clients all green ✓" pill when there are >5 greens
Click red/amber tile → opens the relevant email thread in the email panel

5.2 Revenue at Risk Widget
A bold, single-number card. Only displays if revenue at risk > €0.
┌─────────────────────────────────────┐
│  REVENUE AT RISK                    │
│                                     │
│  €1,330,000                         │
│                                     │
│  Across 4 top clients with          │
│  emails waiting > SLA               │
└─────────────────────────────────────┘
When at €0, the card collapses to a green "All top clients within SLA ✓" indicator.
5.3 Missed / Unopened Card
┌─────────────────────────────────────┐
│  MISSED EMAILS (24H)                │
│  8 unopened                         │
│                                     │
│  Ops:3 · UK:2 · EU:2 · IRE:1        │
│                                     │
│  Oldest: "Re: Trailer collection"   │
│  from dispatch@example.com · 47h    │
└─────────────────────────────────────┘
5.4 Category Cards (Row 3)
Compact cards showing each high-priority category with open count and urgency indicator.
┌──────────────────┐ ┌──────────────────┐
│  🧪 PHARMA       │ │  ⚠️ COMPLAINTS   │
│  4 open          │ │  2 open          │
│  ● 1 urgent      │ │  ● 2 urgent      │
│  Oldest: 6.2h    │ │  Oldest: 3.1h    │
└──────────────────┘ └──────────────────┘
Pharma, Complaints, and IT Alerts always visible. Other categories shown if count > 0.
5.5 Performance Metrics Row
Three small cards showing today vs averages with trend arrows.
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ AVG RESPONSE │ │ FIRST REPLY  │ │ INBOUND      │
│ 47 min       │ │ 64%          │ │ 142          │
│ ↓ 7d: 62m    │ │ ↑ target 50% │ │ ↑ 7d: 128    │
└──────────────┘ └──────────────┘ └──────────────┘
Down arrow + green for response time improving, up arrow + green for first reply % improving, etc.
5.6 Live Hotlist Widget
A scrollable list of the 10 most urgent open threads. Each row clickable to jump to the email.
┌──────────────────────────────────────────────────────────────┐
│  🔥 LIVE HOTLIST — needs attention now                       │
├──────────────────────────────────────────────────────────────┤
│  ⚫ MAERSK  Available capacity 3 trailers Dublin→Cherbourg   │
│            sean.n.laffey@gmail.com · Offers · 96h waiting    │
├──────────────────────────────────────────────────────────────┤
│  ● PHARMA  Temperature controlled load Dublin to Madrid      │
│            dispatch@pfizer.com · Export · 6.2h waiting       │
├──────────────────────────────────────────────────────────────┤
│  ● LIDL    Q3 rate negotiation follow-up                     │
│            procurement@lidl.ie · UK · 2.5h waiting           │
└──────────────────────────────────────────────────────────────┘
5.7 IT/Server Alert Banner
A thin banner at the top of the overview that appears only when IT alerts exceed threshold.
┌──────────────────────────────────────────────────────────────┐
│  🔧 IT ALERT: 14 server/postmaster emails in last hour       │
│  (threshold: 10) — view all                                  │
└──────────────────────────────────────────────────────────────┘
Dismissible. Returns next time threshold crossed.

6. Smart Display Logic (the "calm dashboard" principle)
The dashboard should reward good performance with quietness:
ConditionDisplayZero red clientsHide Revenue at Risk card, show green "All clients within SLA ✓" pillZero complaints openHide Complaints cardZero missed emailsShow "✓ All emails opened" small badge instead of full cardIT alerts under thresholdHide IT alert banner entirelyFirst response rate > targetShow in green with ✓No stalled threadsHide Stalled sectionAll inboxes balancedCollapse Inbox Load Balance to single line
This means the dashboard physically shrinks when things are going well, and grows when things need attention. A calm dashboard means a calm business.

7. Color Coding Standards
Maintain Phase 1 branding but extend with status colors:
StateColorHexUsageHealthy/GreenSuccess Green#4caf50All within SLAWatch/AmberWarning Orange#ff9800Approaching SLACritical/RedError Red#f44336Past SLACaffrey GoldBrand Gold#d4a843Platinum tier, headersPharma PinkCategory#e91e63Pharma category onlyIT PurpleCategory#9c27b0IT alerts onlyInfo BlueCategory#2196f3Finance, neutral info

8. Performance & Caching
These endpoints will be slow if they hit Graph API on every page load. Implement server-side caching:
javascript// Recommended cache TTLs
const CACHE_TTL = {
  'client-health': 60,      // 1 minute — critical, refresh often
  'categories': 300,        // 5 minutes
  'missed': 300,            // 5 minutes
  'performance': 600,       // 10 minutes
  'hotlist': 60,            // 1 minute — most visible widget
  'stalled': 1800,          // 30 minutes — doesn't change fast
  'it-alerts': 120          // 2 minutes
};
Implementation:

Use node-cache package (in-memory, simple)
Cache key per endpoint + per inbox where applicable
Manual "Refresh" button on dashboard bypasses cache
Display "Last updated X seconds ago" timestamp on each widget

bashnpm install node-cache

9. New Backend Files to Create
backend/
├── config/
│   ├── top-clients.json          (NEW)
│   ├── categories.json           (NEW)
│   └── sla.json                  (NEW)
├── services/
│   ├── client-health.js          (NEW) — top client scoring
│   ├── categoriser.js            (NEW) — applies category rules
│   ├── performance.js            (NEW) — response time calc
│   ├── hotlist.js                (NEW) — urgency scoring
│   └── cache.js                  (NEW) — node-cache wrapper
├── routes/
│   └── dashboard.js              (EXTEND) — add new endpoints
└── server.js                     (existing)

10. New Frontend Files to Create
frontend/
├── components/
│   ├── client-health-grid.js     (NEW)
│   ├── revenue-at-risk.js        (NEW)
│   ├── category-card.js          (NEW)
│   ├── performance-metrics.js    (NEW)
│   ├── hotlist.js                (NEW)
│   ├── missed-card.js            (NEW)
│   └── it-alert-banner.js        (NEW)
├── overview.html                 (REBUILD with new layout)
├── overview.css                  (NEW — overview-specific styles)
├── overview.js                   (REBUILD — orchestrates all widgets)
└── styles.css                    (existing)

11. Implementation Order (for Claude Code)
Build in vertical slices — each session delivers a visible new widget on the dashboard, not just backend plumbing. This gives Sean tangible progress and something to test/screenshot after every session.
Session 1: Top Client Health Grid (~2–3 hours)
What Sean will see at the end:
A new "Top Client Status" grid on the overview page showing all seeded clients (Maersk, DHL, etc.) as tiles with green/amber/red status indicators. Revenue at Risk card appears when any client is amber/red.
Build steps:

Install node-cache package
Create config files: top-clients.json, categories.json, sla.json
Build services/cache.js wrapper
Build services/categoriser.js (shared utility — used in later sessions)
Build services/client-health.js (scoring logic)
Add /api/dashboard/client-health endpoint with caching
Build frontend client-health-grid.js widget
Build frontend revenue-at-risk.js widget
Wire both into the overview page (replace placeholder section)
Verify in browser — grid renders, tiles colour correctly, click expands


Session 2: Categories + Live Hotlist (~2–3 hours)
What Sean will see at the end:
A new row of category cards (Pharma, Complaints, Quotes, Customs, Finance, IT Alerts) showing live counts, plus a "Live Hotlist" panel listing the top 10 most urgent open threads ranked by an intelligent urgency score.
Build steps:

Build services/hotlist.js (urgency scoring algorithm)
Add /api/dashboard/categories endpoint with caching
Add /api/dashboard/hotlist endpoint with caching
Build frontend category-card.js widget (reusable component)
Build frontend hotlist.js widget
Wire both into the overview page
Make hotlist rows clickable → open the email thread in the main panel
Verify in browser — categories show real counts, hotlist populates with urgent threads


Session 3: Performance + Missed + IT Alerts (~2 hours)
What Sean will see at the end:
A performance metrics row (avg response time, first reply %, inbound today) with trend arrows, a missed emails card showing unopened emails over 24 hours, and an IT alerts banner that appears at the top of the page when server/postmaster emails spike.
Build steps:

Build services/performance.js (response time calculations)
Add /api/dashboard/performance endpoint with caching
Add /api/dashboard/missed endpoint with caching
Add /api/dashboard/it-alerts endpoint with caching
Add /api/dashboard/stalled endpoint (for future use, no widget yet)
Build frontend performance-metrics.js widget (three-card row)
Build frontend missed-card.js widget
Build frontend it-alert-banner.js widget
Wire all three into the overview page
Verify in browser — metrics calculate correctly, trends show arrows, banner appears only when threshold exceeded


Session 4: Polish, Smart-Hide & Mobile (~1–2 hours)
What Sean will see at the end:
The dashboard physically shrinks when things are healthy (green widgets collapse to pills) and expands when things need attention. Every widget shows a "last updated" timestamp. The Refresh button forces a fresh fetch bypassing cache. Layout works cleanly on tablets.
Build steps:

Implement the "calm dashboard" smart-hide logic from Section 6:

Hide Revenue at Risk when €0 → show green "All clients within SLA ✓" pill
Hide Complaints/Missed/IT widgets when empty
Collapse green clients into a single summary tile when >5 are green


Wire up the "Refresh" button to bypass cache on all endpoints
Add "Last updated X seconds ago" timestamp to each widget
Add loading skeleton states (grey shimmer) for slow endpoints
Add CSS media queries for tablet/mobile responsive layout
Click-through testing — every clickable element opens the right thing
Sean walks through with real email data, tunes category keywords and client list
