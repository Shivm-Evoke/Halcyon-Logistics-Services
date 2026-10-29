import { test, expect } from '@playwright/test';

const PAGES = [
  ['/why-late', "Why we're late", '71.0%'],
  ['/operations-day', 'Operations day', 'Start the day'],
  ['/six-months', 'Six months with agents', 'On time with the agents'],
  ['/agents', 'Meet the agents', 'Ops Lead'],
  ['/decision', 'The decision', 'Don\'t sign the routing contract as scoped'],
  ['/test-data', 'Test data', 'Drop a CSV file here'],
  ['/inventory', 'Inventory placement', 'Safety-stock recommendations'],
  ['/carriers', 'Carrier scorecard', '$85.92'],
  ['/control-tower', 'Exceptions control tower', '1,044'],
  ['/accounts', 'Account health', '$14.2M'],
  ['/ai-model', 'AI risk model', 'September backtest (ML policy)'],
  ['/data-quality', 'Data quality', 'Rule checks on the ingested data'],
  ['/inbound', 'Inbound gateway', 'Send data through the gateway'],
];

for (const [path, title, figure] of PAGES) {
  test(`${title} renders its data and charts`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(figure).first()).toBeVisible();
    if (!['/control-tower', '/accounts', '/operations-day', '/agents', '/decision', '/test-data'].includes(path)) {
      await expect(page.locator('.recharts-surface').first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test('planning safety stock marks the client as planned', async ({ page }) => {
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Plan' }).first().click();
  await expect(page.getByText(/Safety stock planned/)).toBeVisible();
  await expect(page.getByText(/units → W/).first()).toBeVisible();
});

test('carrier recommendation excludes non-API carriers for next-day', async ({ page }) => {
  await page.goto('/carriers');
  const table = page.locator('#carriers table').last();
  await expect(table.getByText('Recommended')).toBeVisible();
  await expect(table.getByText('Excluded')).toHaveCount(3);
});

test('control tower sends a proactive notice', async ({ page }) => {
  await page.goto('/control-tower');
  await expect(page.getByText('Clients notified')).toBeVisible();
  await page.getByRole('button', { name: 'Notify', exact: true }).first().click();
  await page.getByRole('button', { name: 'Send notice' }).click();
  await expect(page.getByText(/Notification sent to/)).toBeVisible();
  await expect(page.getByText('Notified').first()).toBeVisible();
});

test('account drawer shows a recovery plan', async ({ page }) => {
  await page.goto('/accounts');
  await page.locator('#accounts').getByRole('row', { name: /Client 263/ }).click();
  await expect(page.getByRole('heading', { name: 'Recovery plan' })).toBeVisible();
  await expect(page.getByText(/Move off hand-keyed email orders/)).toBeVisible();
});

test('six months: the replay lifts on-time and a bad setting is shown beside its field', async ({ page }) => {
  await page.goto('/six-months');
  const overall = page.locator('#replay-overall');
  await expect(overall.getByText('71.0%')).toBeVisible();
  const agents = Number((await overall.locator('.kpi').nth(1).textContent()).match(/(\d+\.\d)%/)[1]);
  expect(agents).toBeGreaterThan(88);
  await expect(page.locator('#replay-waterfall .recharts-surface')).toBeVisible();
  await page.locator('#replay-settings input[type=time]').fill('07:00');
  await page.getByRole('button', { name: /Re-run six months/ }).click();
  await expect(page.locator('#replay-settings .field-error')).toContainText('after 08:00');
});

test('operations day: the worst Friday runs offline, opens a second wave, and an approval acts once', async ({ page }) => {
  await page.goto('/operations-day');
  const screen = page.locator('#operations-day');
  await screen.locator('#ops-mode').selectOption('recorded');
  await screen.getByRole('button', { name: /Start the day|Restart the day/ }).click();
  await expect(screen.locator('#ops-clock')).toHaveText(/00:00/);
  await screen.getByRole('button', { name: '13:00', exact: true }).click();
  await expect(screen.locator('#ops-clock')).toHaveText(/13:00/);
  await expect(screen.locator('.ops-lane[data-agent="wave"]')).toContainText('Second wave, priority');
  const actual = Number((await screen.locator('#ops-counter-actual').textContent()).replace('%', ''));
  const agents = Number((await screen.locator('#ops-counter-agents').textContent()).replace('%', ''));
  expect(agents).toBeGreaterThan(actual + 20);
  // Approve the first waiting decision; asking again changes nothing.
  const approve = screen.locator('.ops-approval button[data-approve]').first();
  const id = await approve.getAttribute('data-approve');
  await approve.click();
  await expect(screen.locator(`button[data-approve="${id}"]`)).toHaveCount(0);
  const again = await page.request.post(`/api/agents/approvals/${id}`, { data: { approval: 'rejected' } });
  expect((await again.json()).changed).toBe(false);
});

test('test data: a dropped CSV is checked, saved, and the agents run on it', async ({ page }) => {
  const sample = await (await page.request.get('/api/agents/datasets/sample.csv')).text();
  const lines = sample.trim().split('\n');
  // One good order and one with an unknown client.
  const csv = [lines[0], lines[1], lines[2].replace(/^([^,]*),C\d{3},/, '$1,C999,')].join('\n');
  await page.goto('/test-data');
  const screen = page.locator('#test-data');
  await page.setInputFiles('[data-testid=dataset-file]', { name: 'two-orders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await screen.getByRole('button', { name: /Upload and check/ }).click();
  await expect(screen.locator('.callout.good')).toContainText('1 orders saved as “two-orders”');
  await expect(screen.locator('.rejected-rows')).toContainText('Line 3: Client C999');
  await screen.getByRole('button', { name: /See it on Six months/ }).click();
  const six = page.locator('#six-months');
  await expect(six.locator('.page-head')).toContainText('Test data · 1 orders');
  await expect(six.getByText('On time expected without agents')).toBeVisible();
  // A file without the required columns is refused, naming them.
  await page.goto('/test-data');
  await page.setInputFiles('[data-testid=dataset-file]', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('client_id\nC001\n') });
  await screen.getByRole('button', { name: /Upload and check/ }).click();
  await expect(screen.locator('.callout.bad')).toContainText('Missing required columns');
});

test('AI risk model shows out-of-time accuracy and the AI-driven backtest', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/ai-model');
  const screen = page.locator('#ai-model');
  await expect(screen.getByRole('heading', { level: 1, name: 'AI risk model' })).toBeVisible();
  await expect(screen.getByText(/^0\.8\d{2}$/).first()).toBeVisible();          // AUC
  await expect(screen.getByText(/September backtest \(ML policy\)/)).toBeVisible();
  await expect(screen.locator('.recharts-surface')).toHaveCount(4);
  // Live scorer: switching to an incomplete address raises the risk.
  const risk = screen.locator('.big-num').first();
  const before = await risk.textContent();
  await screen.getByLabel('Incomplete address').selectOption('1');
  await expect(risk).not.toHaveText(before);
  await expect(screen.getByText(/scored in [\d.]+ µs/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('data quality lists failing checks and opens the records behind one', async ({ page }) => {
  await page.goto('/data-quality');
  await expect(page.getByRole('heading', { level: 1, name: 'Data quality' })).toBeVisible();
  await expect(page.locator('.kpi .value', { hasText: /of 13$/ })).toBeVisible();
  await page.getByRole('row', { name: /Events out of order/ }).click();
  await expect(page.locator('.drawer').getByText(/delivered 2026-/).first()).toBeVisible();
  await page.locator('.drawer').getByRole('button').first().click();
  await expect(page.getByText(/Flagged incoming orders/)).toBeVisible();
});

test('carrier capacity stops the AI sending most orders to one carrier', async ({ page }) => {
  await page.goto('/ai-model');
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Carrier capacity' }) });
  const limited = card.getByRole('row', { name: /AI, within capacity/ });
  // No carrier above the 40% default share in the capacity-limited plan.
  const shares = (await limited.locator('td.num').allTextContents()).map((t) => parseFloat(t));
  expect(Math.max(...shares)).toBeLessThanOrEqual(40);
  const onTime = card.locator('.step .v').first();
  const before = await onTime.textContent();
  await card.getByLabel('Max share per carrier').fill('0.5');
  await card.getByLabel('Extra capacity').fill('0.75');
  await expect(onTime).not.toHaveText(before);
});

test('inbound gateway processes a test email and shows fixes, holds and the reply', async ({ page }) => {
  await page.goto('/inbound');
  await page.getByLabel('Test file').selectOption('10-csv-attachment-mixed.eml');
  await expect(page.getByLabel('Message content')).toHaveValue(/orders\.csv/);
  await page.getByRole('button', { name: /Process email/ }).click();
  await expect(page.getByText('needs attention').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'held', exact: true })).toHaveCount(2);
  await expect(page.locator('s', { hasText: 'Massachusetts' })).toBeVisible();   // the auto-fix "from" value
  await expect(page.getByText('Reply drafted to the sender')).toBeVisible();
});

test('inbound test pack: every channel and error pattern behaves as expected', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['ingest/run-test-pack.mjs'], { env: { ...process.env, API_URL: `http://localhost:${process.env.E2E_API_PORT || '4100'}/api` }, encoding: 'utf8' });
  expect(out).toMatch(/(\d+)\/\1 checks passed/);
});

test('inbound gateway: a held order is fixed from the message drawer and released', async ({ page }) => {
  await page.goto('/inbound');
  await page.getByLabel('Test file').selectOption('02-missing-city-and-house-number.eml');
  await expect(page.getByLabel('Message content')).toHaveValue(/Address: Harbor Street/);   // email 02's own line, not email 01's
  await page.getByRole('button', { name: /Process email/ }).click();
  await expect(page.getByRole('cell', { name: 'held', exact: true })).toBeVisible();
  await expect(page.getByText(/Please fix: City is missing/)).toBeVisible();          // reply to the client

  await page.locator('#inbound tbody tr.clickable').first().click();                          // newest message
  const drawer = page.locator('.drawer');
  await drawer.getByRole('button', { name: 'Fix', exact: true }).click();
  await drawer.getByLabel('street').fill('418 Harbor Street');
  await drawer.getByLabel('city').fill('Hartford');
  await drawer.getByRole('button', { name: 'Re-validate' }).click();
  await expect(page.getByText(/is now (accepted|corrected)/)).toBeVisible();
  await expect(drawer.getByRole('cell', { name: 'held', exact: true })).toHaveCount(0);
});

test('theme switch applies dark mode, remembers it, recolours charts, and switches back', async ({ page }) => {
  await page.goto('/why-late');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await bg();
  const tick = page.locator('.recharts-cartesian-axis-tick-value').first();
  const lightTick = await tick.getAttribute('fill');

  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(lightBg);
  await expect(page.locator('.recharts-cartesian-axis-tick-value').first()).not.toHaveAttribute('fill', lightTick);

  await page.reload();                                         // the choice is remembered
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe(lightBg);
});

test('start here maps the story and links every step to its screen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Start here' })).toBeVisible();
  await expect(page.getByText('Present it in seven steps')).toBeVisible();
  await expect(page.getByText('How the work runs today, and where it breaks')).toBeVisible();
  await expect(page.getByText(/On-time delivery from 71\.0% to 94%/)).toBeVisible();
  await expect(page.getByText('deliveries.csv', { exact: true })).toBeVisible();   // the supplied-data table
  // Each story step opens its screen.
  await page.locator('#start-here').getByRole('link', { name: /Six months with agents/ }).first().click();
  await expect(page).toHaveURL(/\/six-months$/);
  expect(errors).toEqual([]);
});

test('story scroll: scrolling moves the sidebar and URL, choosing a screen scrolls to it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#why-late .page-head h1')).toBeVisible();
  await page.waitForLoadState('networkidle');   // screens above finish loading, so positions are final
  // Scroll "Why we're late" up under the reading line: the sidebar and URL follow.
  const y = await page.evaluate(() => document.getElementById('why-late').offsetTop);
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, y);
  await expect(page).toHaveURL(/\/why-late$/);
  await expect(page.locator('.nav a.active')).toContainText("Why we're late");
  // Choosing a screen in the sidebar brings its top to the top of the page.
  await page.locator('.nav a[href="/carriers"]').click();
  await expect(page).toHaveURL(/\/carriers$/);
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('carriers').getBoundingClientRect().top))).toBe(56);
  // Every screen hands over to the next one.
  await page.locator('#carriers .next-up').click();
  await expect(page).toHaveURL(/\/inventory$/);
});
