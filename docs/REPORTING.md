# Query-Type Reporting — Implementation Reference

Handoff doc for the **query-type reporting** feature in the Caffrey Ops Dashboard.
Written for a developer (or Claude Code) picking the code up to extend it. It
describes what exists today, where it lives, and the contracts between the
pieces. A closely-related **job number** field shares the same storage and CSV,
and is noted where relevant.

## Overview

Operators tag each reply they send with a **query type** (e.g. ETA Request,
Quote, Customs Documentation) and, optionally, a **job number**. Those tags are
persisted on the send record, and a **Reports** panel aggregates them into
counts-by-type with a date range, a single-type filter, and a CSV export.

Data flow:

```
Reply modal (query type + job number)
   → POST /api/emails/send  (records the send in audit_log)
       → audit_log table in encrypted hypercare.db
            → GET /api/reports/query-types(.csv)  ← Reports modal reads these
```

## Files involved

| File | Role |
|------|------|
| `backend/services/audit-log.js` | Owns the `audit_log` table: schema, migrations, `record()`, and the reporting functions. |
| `backend/server.js` | The send route (writes the record) and the two report endpoints (read). |
| `frontend/index.html` | Reply-modal fields (`#compose-query-type`, `#compose-job-number`) and the Reports modal markup + sidebar nav item. |
| `frontend/app.js` | Reply send payload, and the Reports modal logic (open/run/filter/download). |

## Data model

Table `audit_log` (in `backend/data/hypercare.db`, SQLCipher-encrypted with
`DB_ENCRYPTION_KEY`). It is an append-only event log; reporting reads the
`email_sent` rows.

```
id          INTEGER PRIMARY KEY AUTOINCREMENT
ts          TEXT NOT NULL          -- ISO-8601 UTC, e.g. 2026-06-18T09:00:00.000Z
event       TEXT NOT NULL          -- reporting filters on event = 'email_sent'
user        TEXT                   -- sender email
ip          TEXT
detail      TEXT                   -- JSON blob: { inbox, recipients[], subject, queryType, jobNumber }
query_type  TEXT                   -- dedicated column for fast filtering/grouping
job_number  TEXT                   -- optional, free-text
```

Indexes: `ts`, `event`, `query_type`, `job_number`.

### Migrations

`audit-log.js` runs idempotent migrations on `openDb()`. SQLite has no
`ADD COLUMN IF NOT EXISTS`, so it reads `PRAGMA table_info(audit_log)` and only
`ALTER TABLE ADD COLUMN` when the column is missing. This is how existing
databases gain `query_type` / `job_number` on the next boot without a manual
step. **Any new column must follow this same guarded pattern.**

## Backend API (`audit-log.js`)

### `record(event, { user, ip, detail, queryType, jobNumber })`
Appends one row. `detail` is JSON-stringified (and truncated to ~2KB).
`query_type` / `job_number` are written to their dedicated columns (and also
mirrored inside `detail` by the caller). Best-effort: failures are logged, never
thrown, so logging can't break a send.

### `queryTypeReport({ from, to, queryType }) → object`
Aggregates `email_sent` rows that have a non-null `query_type`.
- `from` / `to`: optional ISO timestamps, inclusive. Both are always bound (with
  `0000…`/`9999…` defaults) so the prepared-statement param set stays stable —
  better-sqlite3 dislikes optional named params.
- `queryType`: optional single-type filter; empty/absent means all types.

Returns:
```js
{
  from, to, queryType,           // echo of the inputs (or null)
  total,                         // number — sum of counts
  byType: [ { queryType, count } ],   // grouped, ordered by count desc
  rows:   [ { ts, user, queryType, jobNumber, detail } ]  // raw, newest first, LIMIT 5000
}
```

### `queryTypeReportCsv({ from, to, queryType }) → string`
Runs the same query and serialises `rows` to CSV. Columns:
`Timestamp, User, Query Type, Job Number, Inbox, Recipients, Subject`
(`Inbox`/`Recipients`/`Subject` are pulled out of the `detail` JSON). Cells are
escaped (quotes doubled, fields containing `",\n\r` wrapped). Line ending `\r\n`.

Exports: `module.exports = { record, queryTypeReport, queryTypeReportCsv }`.

## HTTP endpoints (`server.js`)

All require an authenticated session (`requireAuth`) and are rate-limited
(`apiLimiter`).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/reports/query-types` | Query params `from`, `to`, `queryType`. Returns the `queryTypeReport(...)` object as JSON. |
| `GET` | `/api/reports/query-types.csv` | Same params. Returns CSV with `Content-Disposition: attachment; filename="query-type-report.csv"`. |

The write side is the existing send route:

`POST /api/emails/send` (`requireAuth`, `csrfProtect`, `sendLimiter`,
`apiLimiter`) — body `{ inbox, message, queryType, jobNumber }`. After sending
via Graph it calls `auditLog.record('email_sent', { … queryType, jobNumber,
detail })`. `queryType`/`jobNumber` are `null` for brand-new messages (the tags
only show when replying).

## Frontend

### Reply modal (`#compose-modal`)
- `#compose-query-type` — `<select>`; **required on reply** (send is blocked if
  empty). Options live in the HTML; the report filter clones them at runtime.
- `#compose-job-number` — `<input type=text>`; optional, free-text.
- On send, `app.js` includes `queryType` and `jobNumber` in the POST body.

### Reports modal (`#reports-modal`)
Opened from the **Reports** sidebar item (`data-view="reports"`, in the
"Configure" section). Implemented as a modal — **not** a full content view —
deliberately, because the content-view show/hide CSS is hand-maintained and
fragile; a modal keeps the feature additive. Key elements / functions in
`app.js`:
- `#reports-from`, `#reports-to` — date inputs; expanded to inclusive UTC day
  bounds (`T00:00:00.000Z` / `T23:59:59.999Z`) in `reportsRangeQuery()`.
- `#reports-type` — query-type filter; `populateReportTypeFilter()` clones the
  options from `#compose-query-type` (so the two lists never drift), relabelling
  the blank option as "All query types".
- `runReport()` — `GET`s the JSON summary and renders the counts-by-type table
  with a total. Re-runs on filter change.
- `downloadReportCsv()` — navigates to the `.csv` endpoint (same-origin, so the
  session cookie rides along; the attachment header triggers a download).

The on-screen table shows only the **byType** counts; the **rows** (with job
number) are exposed via the CSV. `apiFetch()` handles CSRF automatically for
non-GET requests.

## Persistence note (Render)

`hypercare.db` lives under `backend/data/`. On Render this must be on the
**persistent disk** (mount `…/backend/data`); without it the report history is
wiped on every redeploy. `DB_ENCRYPTION_KEY` must stay identical across deploys
or the database can't be opened.

## Sensible next extensions

- **Filter the report by job number** (and add a job-number column/aggregation
  to the on-screen table, not just the CSV).
- **A trend chart** of volume per type over time (data is already stored).
- **Time-to-first-reply / SLA reporting** off the same `ts` timestamps.
- **Per-inbox or per-client breakdowns** (the `detail` JSON already carries
  `inbox` and `recipients`).

When adding a new stored field, remember the three touch points: the guarded
migration + insert in `audit-log.js`, the `record(...)` call in the send route,
and the reply-modal field + send payload in the frontend.
