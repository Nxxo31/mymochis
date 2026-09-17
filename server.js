import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from './src/db.js';
import authRoutes from './src/routes/auth.js';
import meRoutes from './src/routes/me.js';
import configRoutes from './src/routes/config.js';
import flavorsRoutes from './src/routes/flavors.js';
import combosRoutes from './src/routes/combos.js';
import ordersRoutes from './src/routes/orders.js';
import promosRoutes from './src/routes/promos.js';
import socialRoutes from './src/routes/social.js';
import metricsRoutes from './src/routes/metrics.js';
import publicRoutes from './src/routes/public.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = Number(process.env.PORT || 3737);
const CORS_ORIGIN = process.env.NEXOMOCHIS_CORS || '*';

init();

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'mymochis', version: '2.0.0', ts: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/config', configRoutes);
app.use('/api/flavors', flavorsRoutes);
app.use('/api/combos', combosRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/promos', promosRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/public', publicRoutes);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  res.status(err.status || 500).json({ error: 'internal', message: err.message });
});

app.listen(PORT, () => {
  console.log(`[mymochis] listening on http://localhost:${PORT}`);
  console.log(`[mymochis] static: ${PUBLIC_DIR}`);
});