import { test, expect } from '@playwright/test';

// The three-sided demo, as it is presented: Client 190 orders, Halcyon ops approves, the recipient tracks it.
// Each persona is its own tab (the persona lives in sessionStorage), all reading one order event log.
test('three-sided demo: order held, fixed, second wave, delay approved, delivered, reset', async ({ page, context }) => {
  // Start clean: earlier runs' demo orders are removed, nothing else is touched.
  await page.request.post('/api/demo/reset');

  // Customer: place a same-day order at 10:15 with the ZIP missing.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in as Customer' }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('Action needed: the ZIP code is missing.')).toBeVisible();
  await expect(page.getByText(/is on hold: ZIP is missing/).first()).toBeVisible();

  // The client fixes it; the order keeps same-day on the 13:00 second wave and gets an A-C carrier.
  await page.getByRole('textbox', { name: 'ZIP code' }).fill('30303');
  await page.getByRole('button', { name: 'Fix and release' }).click();
  await expect(page.getByText('On the 13:00 second pick list: same-day kept')).toBeVisible();
  await expect(page.getByText(/^Carrier [ABC]$/)).toBeVisible();

  // Halcyon ops, in a second tab: the carrier reports a delay; Client 190 is Tier 1 and at risk, so the notice waits.
  const ops = await context.newPage();
  await ops.goto('/login');
  await ops.getByRole('button', { name: 'Sign in as Halcyon Ops' }).click();
  await expect(ops).toHaveURL(/\/ops$/);
  await ops.getByRole('button', { name: 'Delayed' }).click();
  await expect(ops.getByText('Approval queue')).toBeVisible();
  await expect(ops.getByText(/Notifying a Tier 1 or at-risk client needs a manager/)).toBeVisible();
  // Nothing reaches the client before the supervisor decides.
  await expect(page.getByText('Running about a day late. Halcyon spotted it')).toBeVisible();
  await expect(page.getByText(/our carrier reports it is running about a day late/)).toHaveCount(0);

  await ops.getByRole('button', { name: 'Approve and send' }).click();
  await expect(ops.getByText('Approval queue')).toHaveCount(0);
  await expect(page.getByText(/our carrier reports it is running about a day late/).first()).toBeVisible({ timeout: 8000 });

  // The recipient's tracking page (no login) shows the delay and the moved date.
  const href = await ops.getByRole('link', { name: 'Tracking page' }).getAttribute('href');
  const track = await context.newPage();
  await track.setViewportSize({ width: 375, height: 812 });
  await track.goto(href);
  await expect(track.getByText('Your delivery is running about a day late.')).toBeVisible();
  await expect(track.getByText(/Originally promised/)).toBeVisible();
  await expect(track.getByText('Waiting for supervisor approval')).toHaveCount(0);   // internal steps stay internal

  // Delivered: every side turns green.
  await ops.getByRole('button', { name: 'Delivered', exact: true }).click();
  await expect(track.getByText('Delivered. Thank you for choosing Halcyon.')).toBeVisible({ timeout: 8000 });
  await expect(ops.getByText('Delivered on time')).toBeVisible();
  await track.getByRole('button', { name: 'Good' }).click();
  await expect(track.getByText('How did we do?')).toHaveCount(0);

  // Reset: ready to run again.
  await ops.getByRole('button', { name: 'Reset demo' }).click();
  await expect(ops.getByText('No demo orders yet.')).toBeVisible();
  await expect(page.getByText('No orders yet. Place one above.')).toBeVisible({ timeout: 8000 });
});
