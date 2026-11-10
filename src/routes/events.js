// MyMochis · Eventos en vivo por SSE (spec 57, r11).
//
// Endpoint único: GET /api/events?token=<jwt>
//
// El token va en la query porque EventSource (la API nativa del navegador)
// no puede mandar headers. Es el mismo JWT que usan el resto de las rutas, con
// la misma expiración: no es una credencial nueva.
//
// Respuesta: text/event-stream. Cada evento trae un id de reparto y lo que
// cambió; el cliente vuelve a pedir la cola por la API (el evento es la señal
// de "hay novedad", no el dato).
import { Router } from 'express';
import { verifyJwt } from '../auth.js';
import { courierForUser } from '../lib/dispatch.js';
import { subscribe, stats } from '../lib/events.js';

const router = Router();

const KEEPALIVE_MS = 25000;

router.get('/', (req, res) => {
  const raw = String(req.query.token || '').trim()
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const payload = verifyJwt(raw);
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized', message: 'Token inválido o expirado' });
  }

  // El JWT del portal lleva `sub` (id del usuario); el del panel puede llevar
  // `id`. El domiciliario se resuelve por su usuario.
  const userId = payload.sub ?? payload.id;
  const courier = payload.role === 'courier' ? courierForUser(userId) : null;
  if (payload.role === 'courier' && !courier) {
    return res.status(403).json({ error: 'forbidden', message: 'La cuenta no es de un domiciliario' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx/Caddy no deben acumular la respuesta: el stream tiene que llegar
    // evento por evento.
    'X-Accel-Buffering': 'no',
  });
  // El navegador reconecta solo si el server se cae.
  res.write('retry: 3000\n\n');
  res.write(`: conectado (${stats().connected})\n\n`);

  const unsubscribe = subscribe(res, { role: payload.role, courierId: courier?.id ?? null });
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* el close de abajo limpia el intervalo */
    }
  }, KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
    try {
      res.end();
    } catch {
      /* ya estaba cerrado */
    }
  });
});

export default router;
