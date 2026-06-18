'use strict';

/**
 * Top-clients configuration service.
 *
 * `top-clients.json` used to be read once at import by categoriser.js, so the
 * roster was effectively frozen until a restart. The Top Clients view lets the
 * user add/remove clients live, so this module owns the file: it holds the
 * config in memory, exposes validated add/remove, and writes back atomically.
 * categoriser.js now reads the roster through getConfig(), so an edit
 * immediately reaches client matching, hotlist scoring and health — no restart.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'top-clients.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function getConfig() {
  return config;
}

/** Build a 400 error the errorHandler will surface verbatim to the SPA. */
function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code || 'topclients.invalid';
  err.expose = true;
  return err;
}

/**
 * Validate + normalise one incoming client. `existingNames` is the set of
 * lower-cased names already in the roster — used for the uniqueness check.
 */
function validateClient(raw, existingNames) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Invalid client payload.', 'topclients.invalid');
  }

  const name = String(raw.name || '').trim();
  if (!name) throw badRequest('Client needs a name.', 'topclients.invalid_name');
  if (name.length > 80) throw badRequest('Client name is too long (max 80 chars).', 'topclients.invalid_name');
  if (existingNames.has(name.toLowerCase())) {
    throw badRequest(`"${name}" is already a top client.`, 'topclients.duplicate');
  }

  // Domains drive email matching — a client with none can never match, so ≥1
  // is required. Accept an array or a comma-separated string.
  const rawDomains = Array.isArray(raw.domains)
    ? raw.domains
    : String(raw.domains || '').split(',');
  const domains = [...new Set(
    rawDomains.map(d => String(d || '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  )];
  if (!domains.length) {
    throw badRequest('Add at least one email domain (e.g. acme.com).', 'topclients.invalid_domains');
  }

  const value = Number(raw.annual_value_eur);
  if (!Number.isFinite(value) || value < 0 || value > 1e12) {
    throw badRequest('Annual value must be a number between 0 and 1,000,000,000,000.', 'topclients.invalid_value');
  }

  const sla = Number(raw.sla_hours);
  if (!Number.isFinite(sla) || sla < 1 || sla > 168) {
    throw badRequest('SLA must be between 1 and 168 hours.', 'topclients.invalid_sla');
  }

  return {
    name,
    domains,
    annual_value_eur: Math.round(value),
    sla_hours: Math.round(sla),
  };
}

/** Atomic write: temp file + rename, so a crash mid-write can't corrupt config. */
function persist(next) {
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  config = next;
}

/** Append one validated client to the roster and persist. */
function addClient(raw) {
  const existing = new Set((config.clients || []).map(c => c.name.toLowerCase()));
  const client = validateClient(raw, existing);
  persist({ ...config, clients: [...(config.clients || []), client] });
  return client;
}

/** Remove a client by name (case-insensitive). Throws 404 if not found. */
function removeClient(name) {
  const target = String(name || '').trim().toLowerCase();
  const clients = config.clients || [];
  const next = clients.filter(c => c.name.toLowerCase() !== target);
  if (next.length === clients.length) {
    const err = new Error('Client not found.');
    err.status = 404;
    err.code = 'topclients.not_found';
    err.expose = true;
    throw err;
  }
  persist({ ...config, clients: next });
}

module.exports = { getConfig, addClient, removeClient };
