import { Router, HttpResponse } from './router.js';
import { createDb, ensureInit } from './db.js';
import { rateLimit } from './ratelimit.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import configRoutes from './routes/config.js';
import deliveryConfigRoutes from './routes/delivery-config.js';
import deliveryScheduleRoutes from './routes/delivery-schedule.js';
import flavorsRoutes from './routes/flavors.js';
import combosRoutes from './routes/combos.js';
import categoriesRoutes from './routes/categories.js';
import ordersRoutes from './routes/orders.js';
import recipientsRoutes from './routes/recipients.js';
import paymentMethodsRoutes from './routes/payment-methods.js';
import payoutAccountsRoutes from './routes/payout-accounts.js';
import promosRoutes from './routes/promos.js';
import releaseWindowsRoutes from './routes/release-windows.js';
import socialRoutes from './routes/social.js';
import metricsRoutes from './routes/metrics.js';
import publicRoutes from './routes/public.js';
import uploadsRoutes from './routes/uploads.js';
import usersRoutes from './routes/users.js';

const api = new Router();

api.get('/api/health', async (req, res) => {
  res.json({ ok: true, service: 'mymochis', version: '2.1.0-workers', ts: new Date().toISOString() });
});

api.use('/api/auth', authRoutes);
api.use('/api/me', meRoutes);
api.use('/api/config', configRoutes);
api.use('/api/delivery-config', deliveryConfigRoutes);
api.use('/api/delivery-schedule', deliveryScheduleRoutes);
api.use('/api/flavors', flavorsRoutes);
api.use('/api/combos', combosRoutes);
api.use('/api/categories', categoriesRoutes);
api.use('/api/orders', ordersRoutes);
api.use('/api/recipients', recipientsRoutes);
api.use('/api/payment-methods', paymentMethodsRoutes);
api.use('/api/payout-accounts', payoutAccountsRoutes);
api.use('/api/promos', promosRoutes);
api.use('/api/release-windows', releaseWindowsRoutes);
api.use('/api/social', socialRoutes);
api.use('/api/metrics', metricsRoutes);
api.use('/api/public', publicRoutes);
api.use('/api/uploads', uploadsRoutes);
api.use('/api/users', usersRoutes);

const generalLimiter = rateLimit({ windowMs: 60_000, max: 120, message: 'Demasiadas solicitudes, intenta en un minuto' });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, skipSuccessful: true, message: 'Demasiados intentos, espera 15 minutos' });
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Demasiadas subidas, intenta mas tarde' });

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

async function handleUploadFetch(request, env, filename) {
  if (filename.includes('..') || filename.includes('\\')) {
    return new Response('not_found', { status: 404 });
  }
  const obj = await env.UPLOADS.get(filename);
  if (!obj) return new Response('not_found', { status: 404 });
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');
  if (obj.size != null) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith('/uploads/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('method_not_allowed', { status: 405 });
        }
        return await handleUploadFetch(request, env, decodeURIComponent(path.slice('/uploads/'.length)));
      }

      if (!path.startsWith('/api/')) {
        return await env.ASSETS.fetch(request);
      }

      // NO hay redirect de barra final. El router ya la normaliza en
      // Router._add() (`full.replace(/\/$/, '')`), asi que /api/orders compila a
      // `^/api/orders$` y matchea sin barra.
      //
      // El redirect que habia aqui (301 hacia /api/orders/) era activamente
      // danoso: en un redirect permanente el cliente puede replayar el POST
      // como GET, y ahi cae en router.get('/') de orders, que exige
      // authMiddleware -> 401. El pedido se perdia entero.

      await ensureInit(env);

      const corsOrigin = env.NEXOMOCHIS_CORS || (env.ENVIRONMENT === 'production' ? null : '*');
      if (request.method === 'OPTIONS') {
        const preflight = new Response('', {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '600',
          },
        });
        if (corsOrigin) preflight.headers.set('Access-Control-Allow-Origin', corsOrigin);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) preflight.headers.set(k, v);
        return preflight;
      }

      const req = {
        raw: request,
        env,
        ctx,
        params: {},
        query: Object.fromEntries(url.searchParams.entries()),
        body: undefined,
        headers: request.headers,
        ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown',
        db: createDb(env.DB),
        dbD1: env.DB,
        user: null,
        rateLimitBucket: 'general',
      };

      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const ct = request.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const len = Number(request.headers.get('content-length') || 0);
          if (len > 256 * 1024) {
            return json({ error: 'payload_too_large' }, 413, corsOrigin);
          }
          const text = await request.text();
          if (text.length > 256 * 1024) {
            return json({ error: 'payload_too_large' }, 413, corsOrigin);
          }
          try {
            req.body = JSON.parse(text);
          } catch {
            return json({ error: 'invalid_json' }, 400, corsOrigin);
          }
        }
      }

      if (path.startsWith('/api/auth')) req.rateLimitBucket = 'auth';
      else if (path.startsWith('/api/uploads')) req.rateLimitBucket = 'uploads';

      const res = new HttpResponse();
      const limiter = req.rateLimitBucket === 'auth' ? authLimiter : req.rateLimitBucket === 'uploads' ? uploadLimiter : generalLimiter;
      await limiter(req, res, async () => {
        const matched = await api.handle(req, res);
        if (!matched && !res.finished) {
          res.status(404).json({ error: 'not_found' });
        }
      });

      const response = res.toResponse();
      if (corsOrigin) response.headers.set('Access-Control-Allow-Origin', corsOrigin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
      response.headers.delete('X-Powered-By');
      return response;
    } catch (err) {
      console.error('[error]', err.stack || err);
      return json({ error: 'internal', message: 'Error interno' }, 500, env.NEXOMOCHIS_CORS || (env.ENVIRONMENT === 'production' ? null : '*'));
    }
  },
};

function json(obj, status, corsOrigin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  return new Response(JSON.stringify(obj), { status, headers });
}
