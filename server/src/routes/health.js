// Health of the optional AI service. Behind the site password like every other internal route;
// it reports the state, model and a reason a person can act on, never the key.
import { Router } from 'express';
import { getContainer } from '../container.js';

const r = Router();

r.get('/health/ai', async (req, res) => {
  const { claude } = await getContainer();
  res.json(await claude.probe({ force: req.query.force === '1' }));
});

export default r;
