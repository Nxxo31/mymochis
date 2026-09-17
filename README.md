# MyMochis

Landing page para clientes + dashboard de gestión para el operador. Monolito Node.js + SQLite + frontend estático.

## Stack

- **Node.js 24+** con `node:sqlite` (sin npm install de drivers nativos)
- **Express** (única dependencia npm)
- **SQLite** (archivo `data/mymochis.db`, WAL mode, auto-seed)
- **Frontend estático** (HTML + CSS + JS vanilla, sin build step)
- **JWT HS256 custom** (sin libs)
- **scrypt** para passwords (built-in Node crypto)

## Setup

```bash
npm install
PORT=3737 NEXOMOCHIS_JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')" npm start
```

Para desarrollo con auto-reload:
```bash
npm run dev
```

## URLs

| Ruta | Para | Auth |
|---|---|---|
| `/` | Landing pública (cliente) | No |
| `/manage.html` | Dashboard del operador | Sí (JWT) |
| `/api/public` | Config + catálogo para landing | No |
| `/api/health` | Health check | No |
| `/api/auth/register` | Crear primer operador | No |
| `/api/auth/login` | Login → JWT | No |
| `/api/me` | Usuario actual | JWT |
| `/api/config` | GET (público) / PUT (auth) | mixto |
| `/api/flavors` | CRUD sabores | mixto |
| `/api/combos` | CRUD combos | mixto |
| `/api/orders` | POST (público) / GET, PATCH, DELETE (auth) | mixto |
| `/api/promos` | CRUD promos | Auth |
| `/api/social` | Cola de posts redes sociales | Auth |
| `/api/metrics` | KPIs para dashboard | Auth |

## Primer operador

```bash
curl -X POST http://localhost:3737/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"tu@email.com","password":"clave-segura","name":"Tu Nombre"}'
```

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3737` | Puerto del servidor |
| `NEXOMOCHIS_JWT_SECRET` | (dev fallback) | Secreto HMAC para JWT — rotar en producción |
| `NEXOMOCHIS_CORS` | `*` | Access-Control-Allow-Origin |
| `NEXOMOCHIS_DB_PATH` | `data/mymochis.db` | Path al SQLite |

## Estructura

```
mymochis/
├── server.js              # Express entry + static + routes
├── src/
│   ├── db.js              # SQLite + schema + seeds
│   ├── auth.js            # JWT + scrypt
│   └── routes/
│       ├── auth.js        # register, login
│       ├── me.js          # current user
│       ├── config.js      # business config
│       ├── flavors.js     # flavors CRUD
│       ├── combos.js      # combos CRUD
│       ├── orders.js      # orders CRUD + filters
│       ├── promos.js      # promos CRUD
│       ├── social.js      # social posts queue
│       ├── metrics.js     # KPIs
│       └── public.js      # public config bundle
├── public/
│   ├── index.html         # landing page (cliente)
│   ├── manage.html        # dashboard (operador)
│   ├── sw.js              # service worker (PWA)
│   ├── manifest.json      # PWA manifest
│   ├── favicon.svg
│   └── img/               # fotos de producto
└── data/
    └── mymochis.db        # SQLite (auto-creado, gitignored)
```

## Flujo del cliente

1. Cliente abre `/` (landing).
2. Elige sabores y/o combo → modal express.
3. Confirma con su nombre + WhatsApp + día de recogida.
4. JS abre `wa.me/` con mensaje pre-armado (cliente confirma el pedido directo al WhatsApp del operador).
5. POST a `/api/orders` en paralelo → queda registrado en el dashboard.

## Flujo del operador

1. Abre `/manage.html` → login (email + clave).
2. Dashboard con KPIs del día, semana, total, ticket promedio + chart de 14 días + top sabores.
3. **Pedidos**: tabla con filtros (estado, día, búsqueda). Cambiar status inline.
4. **Sabores**: CRUD del catálogo (5 sabores sembrados al inicio).
5. **Combos**: CRUD de combos con flag `featured`.
6. **Promos**: códigos de descuento (percent / fixed / bxgy).
7. **Redes sociales**: cola de posts (draft → scheduled → posted) para IG / FB / TikTok.
8. **Configuración**: datos del negocio, WhatsApp, Instagram handle, horarios.

## Notas de seguridad

- JWT firmado con HS256 + scrypt para passwords (no bcrypt, sin native build).
- API key `NEXOMOCHIS_JWT_SECRET` debe ser rotada en producción (mínimo 32 chars).
- `data/mymochis.db` está en `.gitignore` — nunca commitear.
- Para exponer públicamente: usar HTTPS, validar CORS, rotar JWT secret.
