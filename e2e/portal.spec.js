import { test, expect } from '@playwright/test';
import { CUSTOMER, STAFF_STATE } from './accounts.js';
import { SIGNED_OUT, signIn, setDeskClock } from './helpers.js';

const signedOut = { storageState: SIGNED_OUT };

async function placeOrder(page, zip = '06103') {
  await page.goto('/portal/new-order');
  await expect(page.getByRole('heading', { level: 1, name: 'Place orders' })).toBeVisible();
  await page.getByLabel('Item code (SKU)').fill('HX-2201');
  await page.getByLabel('Quantity').fill('5');
  await page.getByLabel('Recipient').fill('Ann Lee');
  await page.getByLabel('Street').fill('12 Elm St');
  await page.getByLabel('City').fill('Hartford');
  await page.getByLabel('State').fill('CT');
  await page.getByLabel('ZIP code').fill(zip);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/portal\/shipments\/IN-\d{6}$/);
  return page.url().split('/').at(-1);
}

test.describe('signed out', () => {
  test.use(signedOut);

  test('visitors see the homepage and staff pages send them to sign in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /delivered when we said/ })).toBeVisible();
    await page.goto('/operations-day');
    await expect(page).toHaveURL(/\/login\?next=%2Foperations-day$/);
  });

  test('a wrong password shows one message', async ({ page }) => {
    await signIn(page, { email: CUSTOMER.email, password: 'not-the-password' });
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
  });
});

test.describe('customer', () => {
  test.use(signedOut);

  test('places an order and tracks it while staff move it on from Live operations', async ({ page, browser, baseURL }) => {
    // Staff (the default signed-in state) start a fresh desk run, so the order is live and stays received until moved on.
    const staff = await browser.newContext({ baseURL, storageState: STAFF_STATE });
    await setDeskClock(staff.request, '2026-09-25 09:15');
    await signIn(page, CUSTOMER);
    await expect(page).toHaveURL(/\/portal$/);
    const ref = await placeOrder(page);
    await expect(page.locator('.timeline li.done')).toHaveCount(1);
    const ops = await staff.newPage();
    await ops.goto('/live-operations');
    const row = ops.locator(`#live-orders tr[data-ref="${ref}"]`);
    await expect(row).toContainText('Received');
    await ops.getByRole('button', { name: `Move on ${ref}` }).click();
    await expect(row).toContainText('Picked');
    await staff.close();
    await page.reload();
    await expect(page.locator('.timeline li.done')).toHaveCount(2);
    await expect(page.locator('.timeline li.done').last()).toContainText('Picked');
  });

  test('a held order is fixed from the portal, and reloading a shipment keeps the portal', async ({ page }) => {
    await signIn(page, CUSTOMER);
    await expect(page).toHaveURL(/\/portal$/);
    const ref = await placeOrder(page, '');
    await expect(page.getByText("We're holding this order until it's fixed.")).toBeVisible();
    await page.getByLabel('ZIP code').fill('06103');
    await page.getByRole('button', { name: 'Fix and release' }).click();
    await expect(page.locator('.timeline li.done')).toHaveCount(1);
    await page.goto(`/portal/shipments/${ref}`);
    await expect(page.locator('.portal-nav')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: `Shipment ${ref}` })).toBeVisible();
  });

  test('cannot open staff screens or their data', async ({ page }) => {
    await signIn(page, CUSTOMER);
    await expect(page).toHaveURL(/\/portal$/);
    await page.goto('/operations-day');
    await expect(page).toHaveURL(/\/portal$/);
    expect((await page.request.get('/api/agents/datasets')).status()).toBe(403);
    expect((await page.request.get('/api/dispatch')).status()).toBe(403);
    expect((await page.request.get('/api/desk')).status()).toBe(403);
    expect((await page.request.post('/api/desk/advance')).status()).toBe(403);
  });
});

test.describe('sessions', () => {
  test.use(signedOut);

  test('signing out ends the session, even for a copied cookie', async ({ page }) => {
    const login = await page.request.post('/api/session/login', { data: CUSTOMER });
    expect(login.status()).toBe(200);
    const cookie = login.headers()['set-cookie'].split(';')[0];
    expect((await page.request.get('/api/portal/orders', { headers: { cookie } })).status()).toBe(200);
    await page.request.post('/api/session/logout', { headers: { cookie } });
    expect((await page.request.get('/api/portal/orders', { headers: { cookie } })).status()).toBe(401);
  });

  test('responses refuse framing and type sniffing', async ({ page }) => {
    const res = await page.request.get('/api/health');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });
});
