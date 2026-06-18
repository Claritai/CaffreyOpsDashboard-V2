// Drives each Overview drilldown: category card, sparkline bar, first-reply card.
// Asserts modal opens, list renders, ESC + backdrop close, row click toasts in demo.

const path = require('node:path');
const { testLogin, enableDemo, launchWithSession, BASE_URL } = require('./lib');

const SHOTS = path.resolve(__dirname, 'screenshots');

async function expectModalOpen(page, label) {
  await page.waitForSelector('#drilldown-modal.visible', { timeout: 5_000 });
  const rows = await page.locator('#drilldown-body .drilldown-row').count();
  const title = await page.locator('#drilldown-title').textContent();
  console.log(`   ✅ ${label}: modal open, title="${title}", ${rows} rows`);
  return rows;
}

async function closeViaEsc(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#drilldown-modal.visible', { state: 'detached', timeout: 2000 })
    .catch(() => null);
  const stillVisible = await page.locator('#drilldown-modal').evaluate(el => el.classList.contains('visible'));
  console.log(`   ${stillVisible ? '❌' : '✅'} ESC closes modal`);
  return !stillVisible;
}

async function closeViaBackdrop(page) {
  await page.locator('#drilldown-modal').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(150);
  const stillVisible = await page.locator('#drilldown-modal').evaluate(el => el.classList.contains('visible'));
  console.log(`   ${stillVisible ? '❌' : '✅'} backdrop closes modal`);
  return !stillVisible;
}

(async () => {
  const sessionId = await testLogin();
  await enableDemo(sessionId);
  const { browser, context } = await launchWithSession(sessionId);
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#category-row .category-card', { timeout: 15_000 });
  console.log('[step 1] Overview loaded');

  // ── 1. Category drilldown ──
  console.log('\n[step 2] Category drilldown');
  const clickableCat = page.locator('.category-card.clickable').first();
  const catLabel = (await clickableCat.locator('.cat-label').textContent()).trim();
  await clickableCat.click();
  const catRows = await expectModalOpen(page, `category "${catLabel}"`);
  await page.screenshot({ path: `${SHOTS}/drill-category.png` });
  await closeViaEsc(page);

  // ── 2. Sparkline drilldown ──
  console.log('\n[step 3] Sparkline drilldown');
  await page.locator('.spark-bar.clickable.today').click();
  await expectModalOpen(page, 'sparkline today');
  await page.screenshot({ path: `${SHOTS}/drill-sparkline.png` });
  await closeViaBackdrop(page);

  // ── 3. First-reply drilldown ──
  console.log('\n[step 4] First-reply drilldown');
  await page.locator('.perf-card.clickable[data-drill-firstreply]').click();
  const bucket = await page.locator('.perf-card[data-drill-firstreply]').getAttribute('data-drill-firstreply');
  await expectModalOpen(page, `first-reply bucket=${bucket}`);
  await page.screenshot({ path: `${SHOTS}/drill-firstreply.png` });

  // ── 4. Row click toasts in demo ──
  console.log('\n[step 5] Row click in demo mode');
  await page.locator('#drilldown-body .drilldown-row').first().click();
  // Modal should close, toast should appear
  await page.waitForTimeout(300);
  const toast = await page.locator('#toast-container .toast').first().textContent().catch(() => null);
  console.log(`   ${toast?.startsWith('Demo:') ? '✅' : '❌'} toast: "${toast}"`);

  // ── 5. Oldest Unanswered hero click (demo) ──
  console.log('\n[step 6] Oldest Unanswered tile in demo');
  // Dismiss any open toast/modal first
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const heroClickable = await page.locator('.tile.hero.clickable').count();
  console.log(`   hero.clickable count: ${heroClickable}`);
  if (heroClickable > 0) {
    await page.locator('.tile.hero.clickable').first().click();
    await page.waitForTimeout(400);
    const heroToast = await page.locator('#toast-container .toast').last().textContent().catch(() => null);
    console.log(`   ${heroToast?.startsWith('Demo:') ? '✅' : '❌'} hero toast: "${heroToast}"`);
  } else {
    console.log('   ❌ hero tile not marked clickable');
  }

  console.log('\n[errors observed]', errors.length);
  errors.forEach(e => console.log('  ', e));

  await browser.close();
})().catch(err => { console.error('VERIFY FAIL:', err); process.exit(1); });
