# Add reply tagging: Query type + Job number

**Task:** add two fields to the email **reply** box — a required **Query type**
dropdown and an optional **Job number** text box — that appear only when
replying (not when composing a new message), are sent with the reply, and are
stored on the send record for later reporting.

Four files change: `frontend/index.html`, `frontend/app.js`,
`backend/server.js`, `backend/services/audit-log.js`. (Optional white styling at
the end.) Apply each part to the corresponding existing anchor; the anchors all
exist in the base app.

---

## 1. `frontend/index.html` — add the two fields to the compose modal

Inside the compose modal (`#compose-modal`), **immediately after the Subject
`form-group`** and **before the Message `form-group`**, insert:

```html
<div class="form-group" id="compose-query-type-group" hidden>
  <label class="form-label" for="compose-query-type">Query type</label>
  <select class="form-control" id="compose-query-type">
    <option value="">Select query type…</option>
    <option value="ETA Request">ETA Request</option>
    <option value="POD Request">POD Request</option>
    <option value="Quote">Quote</option>
    <option value="Ferry Booking">Ferry Booking</option>
    <option value="Customs Documentation">Customs Documentation</option>
    <option value="Timeslot Booking">Timeslot Booking</option>
    <option value="General Enquiry">General Enquiry</option>
  </select>
</div>
<div class="form-group" id="compose-job-group" hidden>
  <label class="form-label" for="compose-job-number">Job number</label>
  <input type="text" class="form-control" id="compose-job-number"
         placeholder="e.g. J-10421 (optional)" maxlength="60">
</div>
```

Both groups start `hidden`; the JS reveals them only in reply mode.

---

## 2. `frontend/app.js`

### 2a. Element references
Near the other compose element refs (e.g. `composeSubject`, `composeBody`), add:

```js
const composeQueryType      = document.getElementById('compose-query-type');
const composeQueryTypeGroup = document.getElementById('compose-query-type-group');
const composeJobNumber      = document.getElementById('compose-job-number');
const composeJobGroup       = document.getElementById('compose-job-group');
```

(If the file uses a `$('id')` helper instead of `document.getElementById`, match
that style.)

### 2b. Show + reset on open — inside `openCompose(opts)`
The fields are reply-only. After the existing field setup in `openCompose`, add:

```js
// Query type + job number only apply when replying.
composeQueryTypeGroup.hidden = !opts.reply;
composeQueryType.value = '';
composeJobGroup.hidden = !opts.reply;
composeJobNumber.value = '';
```

`opts.reply` is the flag the reply button passes (the reply handler calls
`openCompose({ reply: true, ... })`). If your reply call doesn't set a `reply`
flag yet, add `reply: true` to it.

### 2c. Reset on close — inside `closeCompose()`
Add to the existing field-clearing block:

```js
composeQueryType.value = '';
composeQueryTypeGroup.hidden = true;
composeJobNumber.value = '';
composeJobGroup.hidden = true;
```

### 2d. Read, validate, and send — inside the Send handler
In the click handler for the modal Send button, read the values near where `to`
/ `subject` / `body` are read:

```js
const isReply = !composeQueryTypeGroup.hidden;
const queryType = composeQueryType.value;
const jobNumber = composeJobNumber.value.trim();
```

Add this validation (Query type is required on a reply; remove this block if you
want it optional):

```js
if (isReply && !queryType) {
  toast('Please choose a query type for this reply.', 'error');
  composeQueryType.focus();
  return;
}
```

Include both in the POST body to `/api/emails/send` (add the two fields to the
existing `JSON.stringify({ ... })`):

```js
body: JSON.stringify({ inbox, message, queryType: queryType || null, jobNumber: jobNumber || null }),
```

(Optional) reflect it in the success toast:

```js
toast(queryType
  ? `Reply sent · tagged “${queryType}”${jobNumber ? ` · job ${jobNumber}` : ''}.`
  : 'Message sent.', 'success');
```

---

## 3. `backend/server.js` — store the tags on send

In the `POST /api/emails/send` route, read the two new body fields and pass them
to the audit record. Replace the destructure and the `auditLog.record(...)` call
with:

```js
const { inbox, message, queryType, jobNumber } = req.body;
// ... existing send via Graph ...
auditLog.record('email_sent', {
  user: req.session.user && req.session.user.email,
  ip: req.ip,
  queryType: typeof queryType === 'string' ? queryType : null,
  jobNumber: typeof jobNumber === 'string' && jobNumber.trim() ? jobNumber.trim() : null,
  detail: { inbox, recipients, subject: message.subject || null, queryType: queryType || null, jobNumber: jobNumber || null },
});
```

(`recipients` is the array the route already builds from `message.toRecipients`.)

---

## 4. `backend/services/audit-log.js` — persist the columns

### 4a. Guarded migration + insert (in the DB-open / table-setup function)
SQLite has no `ADD COLUMN IF NOT EXISTS`, so check `table_info` first. After the
`CREATE TABLE audit_log (...)` block, add:

```js
const cols = db.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name);
if (!cols.includes('query_type')) db.exec('ALTER TABLE audit_log ADD COLUMN query_type TEXT');
if (!cols.includes('job_number')) db.exec('ALTER TABLE audit_log ADD COLUMN job_number TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_query_type ON audit_log(query_type)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_job_number ON audit_log(job_number)');
```

Update the prepared insert to include the two columns:

```js
insertStmt = db.prepare(
  'INSERT INTO audit_log (ts, event, user, ip, detail, query_type, job_number) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
```

### 4b. Accept + write the values in `record(...)`
Add `queryType` / `jobNumber` to the options and pass them to `insertStmt.run`:

```js
function record(event, { user, ip, detail, queryType, jobNumber } = {}) {
  try {
    openDb();
    let detailStr = null;
    if (detail != null) {
      detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      if (detailStr.length > 2048) detailStr = detailStr.slice(0, 2045) + '...';
    }
    insertStmt.run(new Date().toISOString(), event, user || null, ip || null, detailStr, queryType || null, jobNumber || null);
  } catch (e) {
    console.error('[audit] failed to record', event, e.message);
  }
}
```

The migration runs automatically on the next boot — existing `hypercare.db`
files gain the columns with no manual step.

---

## 5. (Optional) white fields — `frontend/styles.css`

If you want the reply-box inputs white (as on the live dashboard), add:

```css
#compose-modal .form-control { background: #ffffff; color: #0A1B3D; }
#compose-modal .form-control::placeholder { color: #6b7280; }
#compose-modal .form-control option { color: #0A1B3D; }
```

---

## Notes / behaviour

- The fields are **reply-only**: hidden for new messages because those aren't
  answering a query. That's driven by `opts.reply` in `openCompose`.
- **Query type is required on reply; Job number is optional.** Drop the
  validation block in 2d to make Query type optional too.
- After deploying, the values are stored on every reply. Reporting over them
  (the `/api/reports/query-types` endpoints + Reports panel) is a separate piece
  — see `docs/REPORTING.md`.
- Bump the `app.js?v=` / `styles.css?v=` cache strings in `index.html` so
  browsers pick up the new files.
