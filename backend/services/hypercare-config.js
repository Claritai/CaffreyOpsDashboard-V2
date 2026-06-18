'use strict';

/**
 * Hypercare configuration service.
 *
 * `hypercare.json` used to be `require`d once at server import, which made it
 * effectively read-only at runtime. The Settings view (§12.5) needs to edit it
 * live, so this module owns the file instead: it holds the config in memory,
 * exposes a validated `updateConfig`, and writes changes back atomically. No
 * `systemctl restart` is needed for an edit to take effect — `getConfig()`
 * always returns the current in-memory object and `/api/hypercare/config`
 * reads through it.
 *
 * Note: notification secrets are deliberately NOT part of this config (see
 * hypercare-notify.js) — they live in backend/.env and never touch this file.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'hypercare.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function getConfig() {
  return config;
}

/** Build a 400 error the errorHandler will surface verbatim to the SPA. */
function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code || 'hypercare.invalid_config';
  err.expose = true;
  return err;
}

/** Validate + coerce an integer within [min, max]. */
function intInRange(value, min, max, label, code) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${label} must be between ${min} and ${max}.`, code);
  }
  return Math.round(n);
}

function validateVipClients(list) {
  if (!Array.isArray(list)) {
    throw badRequest('VIP clients must be a list.', 'hypercare.invalid_clients');
  }
  if (list.length > 50) {
    throw badRequest('Too many VIP clients (max 50).', 'hypercare.invalid_clients');
  }
  const seen = new Set();
  return list.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest(`VIP client #${i + 1} is malformed.`, 'hypercare.invalid_clients');
    }
    const name = String(raw.name || '').trim();
    if (!name) throw badRequest(`VIP client #${i + 1} needs a name.`, 'hypercare.invalid_clients');
    if (name.length > 80) throw badRequest(`VIP client name "${name}" is too long (max 80 chars).`, 'hypercare.invalid_clients');
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest(`Duplicate VIP client "${name}".`, 'hypercare.duplicate_client');
    seen.add(key);

    const domains = Array.isArray(raw.domains)
      ? [...new Set(raw.domains.map(d => String(d || '').trim().toLowerCase()).filter(Boolean))]
      : [];

    const client = { name, domains };
    const reason = String(raw.reason || '').trim();
    if (reason) client.reason = reason.slice(0, 200);

    return client;
  });
}

/**
 * Merge a partial patch onto the current config, validating every touched
 * field. Keys not present in the patch (e.g. `managers`) are preserved as-is.
 * Throws a 400 error on any invalid field — nothing is written in that case.
 */
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('Invalid settings payload.', 'hypercare.invalid_config');
  }
  const next = { ...config };

  if ('slaMinutes' in patch) {
    next.slaMinutes = intInRange(patch.slaMinutes, 1, 1440, 'Default SLA (minutes)', 'hypercare.invalid_sla');
  }
  if ('amberThresholdPct' in patch) {
    next.amberThresholdPct = intInRange(patch.amberThresholdPct, 1, 99, 'Amber threshold (percent)', 'hypercare.invalid_amber');
  }
  if ('refreshIntervalSec' in patch) {
    next.refreshIntervalSec = intInRange(patch.refreshIntervalSec, 10, 600, 'Refresh interval (seconds)', 'hypercare.invalid_refresh');
  }
  if ('audioAlertOnRed' in patch) {
    next.audioAlertOnRed = !!patch.audioAlertOnRed;
  }
  if ('vipClients' in patch) {
    next.vipClients = validateVipClients(patch.vipClients);
  }
  return next;
}

/**
 * Apply a validated patch and persist it. The write is atomic — a temp file is
 * written then renamed over the original — so a crash mid-write can never
 * leave a half-written, unparseable config behind.
 */
function updateConfig(patch) {
  const next = validatePatch(patch);
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  config = next;
  return config;
}

module.exports = { getConfig, updateConfig };
