import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import categoriesRoutes from './src/routes/categories.js';
import deliveryConfigRoutes from './src/routes/delivery-config.js';
import deliveryScheduleRoutes from './src/routes/delivery-schedule.js';
import paymentMethodsRoutes from './src/routes/payment-methods.js';
import payoutAccountsRoutes from './src/routes/payout-accounts.js';
import releaseWindowsRoutes from './src/routes/release-windows.js';
import publicRoutes from './src/routes/public.js';
import uploadsRoutes from './src/routes/uploads.js';
import usersRoutes from './src/routes/users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const UPLOAD_DIR = process.env.NEXOMOCHIS_UPLOAD_DIR || join(__dirname, 'data', 'uploads');

const PORT = Number(process.env.PORT || 3737);
const CORS_ORIGIN = process.env.NEXOMOCHIS_CORS || '*';

init();

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      manifestSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
  noSniff: true,
  frameguard: { action: 'deny' },
  xssFilter: true,
  hidePoweredBy: true,
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()');
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Demasiadas solicitudes, intenta en un minuto' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'rate_limited', message: 'Demasiados intentos, espera 15 minutos' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Demasiadas subidas, intenta más tarde' },
});

app.use('/api/', generalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/uploads', uploadLimiter);

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'mymochis', version: '2.0.0', ts: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/config', configRoutes);
app.use('/api/delivery-config', deliveryConfigRoutes);
app.use('/api/delivery-schedule', deliveryScheduleRoutes);
app.use('/api/flavors', flavorsRoutes);
app.use('/api/combos', combosRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/payment-methods', paymentMethodsRoutes);
app.use('/api/payout-accounts', payoutAccountsRoutes);
app.use('/api/promos', promosRoutes);
app.use('/api/release-windows', releaseWindowsRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/users', usersRoutes);

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
}}));

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

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
  console.log(`[mymochis] uploads: ${UPLOAD_DIR}`);
  console.log(`[mymochis] security: helmet + rate-limit active`);
});
