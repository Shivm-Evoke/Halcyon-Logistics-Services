// Signs in once as the e2e staff user; every test runs as staff unless it opens its own context.
import { request } from '@playwright/test';
import { STAFF, STAFF_STATE } from './accounts.js';

export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/session/login', { data: STAFF });
  if (!res.ok()) throw new Error(`Staff sign-in for e2e failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: STAFF_STATE });
  await ctx.dispose();
}
