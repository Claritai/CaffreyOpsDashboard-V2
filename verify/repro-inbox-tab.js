// Repro: clicking an inbox tab in the sidebar errors + bounces to Overview.
const path = require('node:path');
const { testLogin, enableDemo, launchWithSession, BASE_URL } = require('./lib');

(async () => {
  const sessionId = await testLogin();
  await enableDemo(sessionId);
  const { browser, context } = await launchWithSession(sessionId);
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push({ kind: 'pageerror', msg: e.message, stack: e.stack }));
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning')
      errors.push({ kind: msg.type(), text: msg.text() });
  });
  page.on('requestfailed', req => errors.push({ kind: 'reqfail', url: req.url(), failure: req.failure() }));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#category-row .category-card', { timeout: 15_000 });

  // List the inbox-tab candidates in the sidebar.
  const inboxItems = await page.$$eval('.inbox-item', els => els.map(e => ({
    text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
    view: e.dataset.view || null,
    inbox: e.dataset.inbox || null,
  })));
  console.log('[sidebar items]');
  inboxItems.forEach((it, i) => console.log(`  ${i}:`, it));

  // Click the first item that looks like a mailbox tab (has data-inbox, not data-view).
  const target = inboxItems.findIndex(it => it.inbox && !it.view);
  if (target === -1) { console.error('no inbox tab found'); process.exit(2); }
  console.log(`\n[clicking item #${target}: ${inboxItems[target].text} / inbox=${inboxItems[target].inbox}]`);

  const all = page.locator('.inbox-item');
  await all.nth(target).click();
  await page.waitForTimeout(1200);

  console.log('\n[final URL]', page.url());
  const visiblePanes = await page.$$eval(
    '#overview-pane, #hotlist-view-pane, #topclients-pane, .email-list-pane, .email-detail-pane',
    els => els.map(e => ({ id: e.id || e.className, visible: getComputedStyle(e).display !== 'none' }))
  );
  console.log('[panes]');
  visiblePanes.forEach(p => console.log(' ', p));

  console.log('\n[errors observed]', errors.length);
  errors.forEach(e => console.log(' ', JSON.stringify(e)));

  await page.screenshot({ path: path.resolve(__dirname, 'screenshots/after-inbox-click.png'), fullPage: true });
  await browser.close();
})().catch(err => { console.error('REPRO FAIL:', err); process.exit(1); });
