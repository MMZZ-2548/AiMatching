import express from 'express';
import cors from 'cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, envReport } from './lib/env.js';
import { api } from './routes/api.js';
import { appApi } from './routes/app.js';
import { carePlanApi } from './routes/carePlan.js';
import { advisorApi } from './routes/advisor.js';
import { marketApi } from './routes/market.js';
import { boardApi } from './routes/board.js';
import { seed } from './seed/seed.js';
import { store } from './store/index.js';

export const app = express();
app.use(cors({ origin: [ENV.frontendUrl, 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.use('/api', api);
app.use('/api/app/care-plan', carePlanApi);
app.use('/api/app/advisor', advisorApi);
app.use('/api/app/market', marketApi);
app.use('/api/app/board', boardApi);
app.use('/api/app', appApi);

// This service is API-only. A web UI was built during development to prove the flows work
// end to end; it has been removed and is documented in docs/FRONTEND_HANDOFF.md for the team
// building the real frontend.
app.get('/', (_req, res) =>
  res.json({
    service: 'TrustCare backend',
    api: `http://localhost:${ENV.port}/api/health`,
    docs: 'docs/FRONTEND_HANDOFF.md',
  }),
);

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'INTERNAL', message: err.message });
});

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  // The memory store starts empty; seeding on boot is what makes the tester usable immediately.
  if (store.driver === 'memory') {
    const result = await seed({ reset: true });
    console.log('[seed]', result);
  }
  app.listen(ENV.port, () => {
    console.log(`TrustCare backend on http://localhost:${ENV.port}`);
    console.log(`  health  http://localhost:${ENV.port}/api/health`);
    console.log('  docs    docs/FRONTEND_HANDOFF.md');
    console.log('  env    ', envReport());
  });
}
