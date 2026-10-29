import { test, expect } from '@playwright/test';
import { STAFF, CUSTOMER } from './accounts.js';
import { SIGNED_OUT, signIn } from './helpers.js';

// The staff side: five sidebar entries, the last a collapsed Evidence group of three screens.
const SIDEBAR = ['The problem', 'Live operations', 'Operations day', 'Results', 'Evidence'];
const EVIDENCE = ['Carrier scorecard', 'Inventory placement', 'Test data'];
const SIDEBAR_TEXT = SIDEBAR.map((l) => new RegExp(`^${l}(LIVE)?$`));   // live screens carry a LIVE tag

const PAGES = [
  ['/problem', 'The problem', '71.0%', false],
  ['/live-operations', 'Live operations', 'Approval queue', false],
  ['/operations-day', 'Operations day', 'Start the day', false],
  ['/results', 'Six months with agents', 'On time with the agents', true],
  ['/carriers', 'Carrier scorecard', '$85.92', true],
  ['/inventory', 'Inventory placement', 'Safety-stock recommendations', true],
  ['/test-data', 'Test data', 'Drop a CSV file here', false],
];

for (const [path, title, figure, chart] of PAGES) {
  test(`${title} renders its data${chart ? ' and charts' : ''}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path);
    const screen = page.locator(`#${path.slice(1)}`);
    await expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(screen.getByText(figure).first()).toBeVisible();
    if (chart) await expect(screen.locator('.recharts-surface').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('staff sidebar has exactly the five entries, with Evidence collapsed', async ({ page }) => {
  await page.goto('/problem');
  const nav = page.locator('.nav');
  await expect(nav.locator(':scope > a, :scope > button')).toHaveText(SIDEBAR_TEXT);
  const evidence = nav.getByRole('button', { name: 'Evidence' });
  await expect(evidence).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.locator('.nav-sub')).toHaveCount(0);
  await evidence.click();
  await expect(nav.locator('.nav-sub a')).toHaveText(EVIDENCE);
});

test('results: the six-month replay lifts on-time, a bad setting is shown beside its field, the decision follows', async ({ page }) => {
  await page.goto('/results');
  const screen = page.locator('#results');
  const overall = screen.locator('#replay-overall');
  await expect(overall.getByText('71.0%')).toBeVisible();
  const agents = Number((await overall.locator('.kpi').nth(1).textContent()).match(/(\d+\.\d)%/)[1]);
  expect(agents).toBeGreaterThan(88);
  await expect(screen.locator('#replay-waterfall .recharts-surface')).toBeVisible();
  await expect(screen.getByRole('heading', { level: 1, name: 'The decision' })).toBeVisible();
  await screen.locator('#replay-settings input[type=time]').fill('07:00');
  await screen.getByRole('button', { name: /Re-run six months/ }).click();
  await expect(screen.locator('#replay-settings .field-error')).toContainText('after 08:00');
});

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

test('operations day: any day of the data can be picked and played', async ({ page }) => {
  await page.goto('/operations-day');
  const screen = page.locator('#operations-day');
  const day = screen.getByLabel('Day to play');
  await expect(day).toHaveValue('2026-09-25');
  await screen.locator('#ops-mode').selectOption('recorded');
  await expect(day).toBeDisabled(); // a recording holds one day's reasons
  await screen.locator('#ops-mode').selectOption('live');
  await day.selectOption('2026-04-03');
  await screen.getByRole('button', { name: /Start the day|Restart the day/ }).click();
  await expect(page.getByText(/Live · 2026-04-03 · A day from the history/i)).toBeVisible();
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
  await screen.getByRole('button', { name: /See it on Results/ }).click();
  await expect(page).toHaveURL(/\/results$/);
  const results = page.locator('#results');
  await expect(results.locator('.page-head').first()).toContainText('Test data · 1 orders');
  await expect(results.getByText('On time expected without agents')).toBeVisible();
  // A file without the required columns is refused, naming them.
  await page.goto('/test-data');
  await page.setInputFiles('[data-testid=dataset-file]', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('client_id\nC001\n') });
  await screen.getByRole('button', { name: /Upload and check/ }).click();
  await expect(screen.locator('.callout.bad')).toContainText('Missing required columns');
});

test('inbound test pack: every channel and error pattern behaves as expected', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('node', ['ingest/run-test-pack.mjs'], { env: { ...process.env, API_URL: 'http://localhost:4100/api', STAFF_EMAIL: STAFF.email, STAFF_PASSWORD: STAFF.password }, encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  expect(out, out).toMatch(/(\d+)\/\1 checks passed/);
});

test('theme switch applies dark mode, remembers it, recolours charts, and switches back', async ({ page }) => {
  await page.goto('/results');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await bg();
  const tick = page.locator('#results .recharts-cartesian-axis-tick-value').first();
  await expect(tick).toBeVisible();
  const lightTick = await tick.getAttribute('fill');

  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(lightBg);
  await expect(page.locator('#results .recharts-cartesian-axis-tick-value').first()).not.toHaveAttribute('fill', lightTick);

  await page.reload();                                         // the choice is remembered
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe(lightBg);
});

test('story scroll: scrolling moves the sidebar and URL, choosing a screen scrolls to it, the evidence opens its group', async ({ page }) => {
  await page.goto('/problem');
  await expect(page.locator('#problem .page-head h1')).toBeVisible();
  await page.waitForLoadState('networkidle');   // screens finish loading, so positions are final
  const evidence = page.locator('.nav').getByRole('button', { name: 'Evidence' });
  await expect(evidence).toHaveAttribute('aria-expanded', 'false');
  // Scroll "Live operations" up under the reading line: the sidebar and URL follow.
  const y = await page.evaluate(() => document.getElementById('live-operations').offsetTop);
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, y);
  await expect(page).toHaveURL(/\/live-operations$/);
  await expect(page.locator('.nav a.active')).toContainText('Live operations');
  // Choosing a screen in the sidebar brings its top to the top of the page.
  await page.locator('.nav a[href="/results"]').click();
  await expect(page).toHaveURL(/\/results$/);
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('results').getBoundingClientRect().top))).toBe(56);
  // Every screen hands over to the next one; following it into the evidence opens the Evidence group.
  await page.locator('#results .next-up').click();
  await expect(page).toHaveURL(/\/carriers$/);
  await expect(evidence).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.nav a.active')).toContainText('Carrier scorecard');
  // Scrolling (not clicking) into the evidence opens the group too.
  await page.goto('/problem');
  await expect(page.locator('#problem .page-head h1')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(evidence).toHaveAttribute('aria-expanded', 'false');
  const inv = await page.evaluate(() => document.getElementById('inventory').offsetTop);
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, inv);
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(evidence).toHaveAttribute('aria-expanded', 'true');
});

test('portal API key: a new key signs in, a second key stops the first; unknown samples are not found', async ({ playwright, baseURL }) => {
  const customer = await playwright.request.newContext({ baseURL, storageState: SIGNED_OUT });
  expect((await customer.post('/api/session/login', { data: CUSTOMER })).status()).toBe(200);
  const first = await (await customer.post('/api/portal/api-key')).json();
  expect(first.client_id).toBe('C176');
  const login = (secret) => customer.post('/api/auth/login', { data: { client_id: first.client_id, client_secret: secret } });
  const ok = await login(first.secret);
  expect(ok.status()).toBe(200);
  expect((await ok.json()).access_token).toBeTruthy();
  const second = await (await customer.post('/api/portal/api-key')).json();
  expect(second.secret).not.toBe(first.secret);
  expect((await login(first.secret)).status()).toBe(401);
  expect((await login(second.secret)).status()).toBe(200);
  expect((await customer.post('/api/portal/samples/9')).status()).toBe(404);
  await customer.dispose();
});

// The whole order journey: a customer sends the five sample orders through four channels, each showing one cause of
// late deliveries; staff see the agents' decisions on Live operations, approve what waits, and run the day to its end;
// the customer's tracking shows what the agents did and the delivery.
test('end to end: five channels, five causes, approval, delivered', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const SAMPLE_AGENT = { 1: 'Intake', 2: 'Wave Planner', 3: 'Stock', 4: 'Carrier', 5: 'Watchtower' };

  // Staff sign in, land on the problem, and start a clean desk run at 09:15 on Friday 25 September.
  const staffCtx = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
  const staff = await staffCtx.newPage();
  await signIn(staff, STAFF);
  await expect(staff).toHaveURL(/\/problem$/);
  await expect(staff.locator('.nav').locator(':scope > a, :scope > button')).toHaveText(SIDEBAR_TEXT);
  await staff.locator('.nav a[href="/live-operations"]').click();
  const desk = staff.locator('#live-operations');
  await desk.getByLabel('Ops clock, date and time').fill('2026-09-25 09:15');
  await desk.getByRole('button', { name: 'Set clock' }).click();
  await expect(desk.locator('#live-clock')).toContainText('2026-09-25 09:1');
  await expect(desk.getByText('No live orders in this run yet')).toBeVisible();

  // The customer sends the five samples: email, EDI, API (two) and the form.
  const custCtx = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
  const cust = await custCtx.newPage();
  await signIn(cust, CUSTOMER);
  await expect(cust).toHaveURL(/\/portal$/);
  await cust.getByRole('link', { name: 'Place orders' }).click();
  await expect(cust.getByRole('heading', { level: 1, name: 'Place orders' })).toBeVisible();
  const sendSample = async (tab) => {
    await cust.getByRole('tab', { name: tab }).click();
    await cust.getByRole('button', { name: 'Send a sample' }).click();
    const sent = cust.getByRole('status').filter({ hasText: 'We received' });
    await expect(sent).toBeVisible();
    return sent.getByRole('link').allTextContents();
  };
  const [r1] = await sendSample('Send email');
  const [r2] = await sendSample('Upload EDI');
  const [r3, r5] = await sendSample('API');
  const [r4] = await sendSample('Form');
  const refs = { 1: r1, 2: r2, 3: r3, 4: r4, 5: r5 };
  expect(new Set(Object.values(refs)).size).toBe(5);
  for (const ref of Object.values(refs)) expect(ref).toMatch(/^IN-\d{6}$/);

  // Staff see the five orders, each with the decision of the agent for its cause.
  await staff.reload();
  const rows = desk.locator('#live-orders tbody tr[data-ref]');
  await expect(rows).toHaveCount(5);
  for (const [n, ref] of Object.entries(refs)) {
    await desk.getByRole('button', { name: `Details for ${ref}` }).click();
    const detail = desk.locator(`#live-orders tr[data-ref="${ref}"] + tr.live-detail-row`);
    await expect(detail.locator('.ops-event b', { hasText: SAMPLE_AGENT[n] }).first(), `sample ${n} (${ref})`).toBeVisible();
  }
  for (const agent of ['intake', 'wave', 'stock', 'carrier', 'watchtower']) {
    await expect(desk.locator(`.ops-lanes [data-agent="${agent}"] .value`), agent).not.toHaveText('0');
  }
  await expect(desk.locator(`#live-orders tr[data-ref="${r2}"] + tr.live-detail-row`)).toContainText('Wave Planner');
  // The form sample is labelled as such; the API samples stay API. Newest first: the form, sent last, is on top.
  await expect(desk.locator(`#live-orders tr[data-ref="${r4}"] td`).nth(2)).toHaveText('Portal form');
  await expect(desk.locator(`#live-orders tr[data-ref="${r3}"] td`).nth(2)).toHaveText('API');
  await expect(rows.first()).toHaveAttribute('data-ref', r4);

  // What waits for a manager (the intake fix and/or the watchtower client flag) is approved on the desk.
  const queue = desk.locator('.ops-approvals .ops-approval');
  await expect(queue.first()).toBeVisible();
  await expect(desk.locator('.ops-approvals')).toContainText(r5);
  for (let i = 0; i < 10 && (await queue.count()) > 0; i++) {
    const approve = queue.first().locator('button[data-approve]');
    const id = await approve.getAttribute('data-approve');
    await approve.click();
    await expect(desk.locator(`button[data-approve="${id}"]`)).toHaveCount(0);
  }
  await expect(desk.getByText('Nothing waiting.')).toBeVisible();
  await expect(desk.locator(`#live-orders tr[data-ref="${r5}"] + tr.live-detail-row`)).toContainText('approved');

  // Advance through the day: the second pick wave at 13:00, collection at 14:00, then the end of the day.
  const clock = desk.locator('#live-clock');
  const advance = desk.getByRole('button', { name: 'Advance to next event' });
  for (const at of ['13:0', '14:0', '23:5']) {
    await advance.click();
    await expect(clock).toContainText(`2026-09-25 ${at}`);
  }
  await expect(desk.locator(`#live-orders tr[data-ref="${r2}"]`)).toContainText('Delivered');

  // The customer's tracking of sample 2 (same-day, sent after 08:00) shows the second wave and the delivery.
  await cust.goto(`/portal/shipments/${r2}`);
  await expect(cust.getByRole('heading', { level: 1, name: `Shipment ${r2}` })).toBeVisible();
  const did = cust.getByRole('region', { name: 'What we did' });
  await expect(did).toContainText('Second pick wave at 13:00: still same-day');
  await expect(cust.locator('.timeline li.done')).toHaveCount(5);
  await expect(cust.locator('.timeline li.done').last()).toContainText('Delivered');

  await staffCtx.close();
  await custCtx.close();
});
