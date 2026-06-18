'use strict';

/**
 * Reply-templates configuration service.
 *
 * Maps a query type (the exact value used by the reply dropdown) to a canned
 * message body. The reply box inserts the matching template when an operator
 * picks a query type, so common freight queries can be answered in a click.
 *
 * Templates live in config/reply-templates.json and are editable by hand
 * (commit + redeploy). Unlike the other config loaders this one is deliberately
 * tolerant: a missing or malformed file falls back to an empty set rather than
 * crashing boot — templates are a convenience, not a hard dependency.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'reply-templates.json');

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed.templates === 'object' && parsed.templates) {
      return { templates: parsed.templates };
    }
    console.warn('[reply-templates] file present but has no "templates" object — using empty set');
    return { templates: {} };
  } catch (e) {
    console.warn('[reply-templates] could not read reply-templates.json — using empty set:', e.message);
    return { templates: {} };
  }
}

let config = load();

function getConfig() {
  return config;
}

module.exports = { getConfig };
