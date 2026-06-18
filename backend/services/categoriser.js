const topclientsConfig = require('./topclients-config');
const categoriesConfig = require('./categories-config');

// Both rosters (categories + top clients) are now editable from the Settings
// hub, so categoriser reads through their getConfig() each call. An edit
// reaches the next message that gets categorised — no restart needed.

function lower(s) { return (s || '').toLowerCase(); }
function senderAddress(msg) { return lower(msg.from?.emailAddress?.address); }
function senderDomain(msg)  {
  const addr = senderAddress(msg);
  const at = addr.indexOf('@');
  return at >= 0 ? addr.slice(at + 1) : '';
}
function subject(msg) { return lower(msg.subject); }

function senderLocalPart(msg) {
  const addr = senderAddress(msg);
  const at = addr.indexOf('@');
  return at >= 0 ? addr.slice(0, at) : addr;
}

/**
 * Return the array of category IDs that match a given message. A message can
 * belong to multiple categories (e.g. a complaint about a pharma load).
 */
function categorise(msg) {
  const subj = subject(msg);
  const dom  = senderDomain(msg);
  const local = senderLocalPart(msg);
  const matches = [];
  for (const cat of categoriesConfig.getConfig().categories) {
    const r = cat.rules || {};
    const subjectHit = (r.subject_keywords || []).some(k => k && subj.includes(k.toLowerCase()));
    const domainHit  = (r.sender_domains  || []).some(d => d && dom === d.toLowerCase());
    const senderHit  = (r.sender_keywords || []).some(k => k && local.includes(k.toLowerCase()));
    if (subjectHit || domainHit || senderHit) matches.push(cat.id);
  }
  return matches;
}

/** Map a message to the top-client entry whose domain matches the sender, or null. */
function matchClient(msg) {
  const dom = senderDomain(msg);
  if (!dom) return null;
  for (const client of (topclientsConfig.getConfig().clients || [])) {
    if ((client.domains || []).some(d => d.toLowerCase() === dom)) return client;
  }
  return null;
}

function getClients()      { return topclientsConfig.getConfig().clients || []; }
function getCategoriesCfg() { return categoriesConfig.getConfig().categories; }

module.exports = {
  categorise,
  matchClient,
  getClients,
  getCategoriesCfg,
};
