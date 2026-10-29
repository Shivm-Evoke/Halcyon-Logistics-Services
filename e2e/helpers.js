// Shared steps for the e2e specs.
import { expect } from '@playwright/test';

/** A browser state with nobody signed in. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Signs in through the sign-in page. */
export async function signIn(page, { email, password }, path = '/login') {
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Sets the live desk's ops clock as staff (starts a new desk run), through the API. */
export async function setDeskClock(request, setTo) {
  const res = await request.post('/api/desk/clock', { data: { set_to: setTo } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
