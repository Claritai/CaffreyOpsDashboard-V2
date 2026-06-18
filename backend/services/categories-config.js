'use strict';

/**
 * Categories configuration service.
 *
 * `categories.json` used to be `require`d once at server import by
 * categoriser.js, so the rules were effectively frozen until restart. The
 * Settings → Categories panel needs to edit them live, so this module owns
 * the file: it holds the config in memory, exposes validated `updateConfig`,
 * and writes atomically. categoriser.js reads through `getConfig()` so an
 * edit to keywords reaches the next message that gets categorised — and the
 * server.js `/api/dashboard/categories` route busts the per-session cache
 * after a patch so the Overview row's counts refresh on the next poll.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'categories.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function getConfig() { return config; }

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code || 'categories.invalid_config';
  err.expose = true;
  return err;
}

const ID_RE = /^[a-z0-9_]{2,40}$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_CATEGORIES = 8;
const MAX_KEYWORDS_PER_RULE = 40;
const MAX_KEYWORD_LEN = 80;

function normaliseStringList(raw, label, code) {
  if (raw === undefined || raw === null || raw === '') return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(',');
  else throw badRequest(`${label} must be a list or comma string.`, code);
  const cleaned = [...new Set(
    arr.map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
  )];
  if (cleaned.length > MAX_KEYWORDS_PER_RULE) {
    throw badRequest(`${label}: too many entries (max ${MAX_KEYWORDS_PER_RULE}).`, code);
  }
  for (const s of cleaned) {
    if (s.length > MAX_KEYWORD_LEN) {
      throw badRequest(`${label}: "${s.slice(0, 30)}…" is too long (max ${MAX_KEYWORD_LEN} chars).`, code);
    }
  }
  return cleaned;
}

function validateCategory(raw, i, seenIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(`Category #${i + 1} is malformed.`, 'categories.invalid');
  }

  const id = String(raw.id || '').trim().toLowerCase();
  if (!id) throw badRequest(`Category #${i + 1} needs an id.`, 'categories.invalid_id');
  if (!ID_RE.test(id)) {
    throw badRequest(`Category id "${id}" must be lowercase letters, digits or underscore (2–40 chars).`, 'categories.invalid_id');
  }
  if (seenIds.has(id)) throw badRequest(`Duplicate category id "${id}".`, 'categories.duplicate');
  seenIds.add(id);

  const label = String(raw.label || '').trim();
  if (!label) throw badRequest(`Category "${id}" needs a label.`, 'categories.invalid_label');
  if (label.length > 60) throw badRequest(`Label for "${id}" is too long (max 60 chars).`, 'categories.invalid_label');

  const icon = String(raw.icon || '').trim().slice(0, 8);  // emoji can be 4+ code units

  let color = String(raw.color || '').trim();
  if (color && !HEX_RE.test(color)) {
    throw badRequest(`Color for "${id}" must be a hex like #1EBFEB.`, 'categories.invalid_color');
  }
  if (!color) color = '#888888';

  const priority = Number(raw.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw badRequest(`Priority for "${id}" must be 1, 2 or 3.`, 'categories.invalid_priority');
  }

  const r = raw.rules || {};
  const rules = {
    subject_keywords: normaliseStringList(r.subject_keywords, `Subject keywords for "${id}"`, 'categories.invalid_rules'),
    sender_domains:   normaliseStringList(r.sender_domains,   `Sender domains for "${id}"`,   'categories.invalid_rules'),
    sender_keywords:  normaliseStringList(r.sender_keywords,  `Sender keywords for "${id}"`,  'categories.invalid_rules'),
  };

  // A category with zero rules can never match — warn early rather than ship a
  // dud that silently catches nothing.
  if (!rules.subject_keywords.length && !rules.sender_domains.length && !rules.sender_keywords.length) {
    throw badRequest(`Category "${id}" needs at least one keyword or domain rule.`, 'categories.empty_rules');
  }

  return { id, label, icon, color, priority, rules };
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('Invalid settings payload.', 'categories.invalid_config');
  }
  if (!('categories' in patch)) {
    throw badRequest('Patch must include a categories list.', 'categories.invalid_config');
  }
  const list = patch.categories;
  if (!Array.isArray(list)) {
    throw badRequest('Categories must be a list.', 'categories.invalid_config');
  }
  if (!list.length) {
    throw badRequest('At least one category is required.', 'categories.invalid_config');
  }
  if (list.length > MAX_CATEGORIES) {
    throw badRequest(`Too many categories (max ${MAX_CATEGORIES}).`, 'categories.invalid_config');
  }
  const seenIds = new Set();
  return { categories: list.map((c, i) => validateCategory(c, i, seenIds)) };
}

function updateConfig(patch) {
  const next = validatePatch(patch);
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  config = next;
  return config;
}

module.exports = { getConfig, updateConfig };
