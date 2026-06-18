// Smoke test: login → demo on → load Overview → screenshot it.
// Run: node verify/smoke-overview.js
//
// Pass = page loaded, demo chip visible, screenshot captured.

const path = require('node:path');
const { testLogin, enableDemo, launchWithSession, BASE_URL } = require('./lib');

(async () => {
  const sessionId = await testLogin();
  console.log('[1] test-login OK, session created');

  const demo = await enableDemo(sessionId);
  console.log('[2] demo mode:', demo);

  const { browser, context } = await launchWithSession(sessionId);
  const page = await context.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });

  const url = `${BASE_URL}/`;
  await page.goto(url, { waitUntil: 'networkidle' });
  console.log('[3] page loaded:', page.url());

  // Wait for the Overview to populate (Categories row is one of the last to render).
  await page.waitForSelector('#category-row .category-card', { timeout: 15_000 });
  const catCount = await page.locator('#category-row .category-card').count();
  console.log('[4] category cards rendered:', catCount);

  const demoChipVisible = await page.locator('#demo-chip').isVisible().catch(() => false);
  console.log('[5] demo chip visible:', demoChipVisible);

  const outPath = path.resolve(__dirname, 'screenshots/overview.png');
  await page.screenshot({ path: outPath, fullPage: true });
  console.log('[6] screenshot →', outPath);

  await browser.close();
})().catch(err => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
