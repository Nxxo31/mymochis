# MyMochis

Landing page para clientes + dashboard de gestión para el operador. Monolito Node.js + SQLite + frontend estático.

**Estado**: v2.0.0 cerrado · Deploy producción: https://mymochis.onrender.com

## Stack

- **Node.js 24+** con `node:sqlite` (sin npm install de drivers nativos)
- **Express** (única dependencia npm, + helmet + express-rate-limit + multer)
- **SQLite** (`/var/data/mymochis.db` en Render, persistente con disk 1GB)
- **Frontend estático** (HTML + CSS + JS vanilla, sin build step)
- **JWT HS256 custom** (sin libs)
- **scrypt** para passwords (built-in Node crypto)
- **Helmet** (CSP estricto, X-Frame-Options deny, HSTS)
- **express-rate-limit** (general 120/min, auth 20/15min, uploads 30/min)
- **Multer** para uploads (max 8 files, 25MB each, allowlist jpeg/png/webp/gif/avif/mp4/webm/quicktime/pdf)

## Setup local

```bash
npm install
ADMIN_EMAIL=admin@mymochis.app \
ADMIN_PASSWORD="$(node -e 'console.log(require(\"crypto\").randomBytes(24).toString(\"base64url\"))')" \
NEXOMOCHIS_JWT_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))')" \
npm start
```

Para desarrollo con auto-reload:

```bash
npm run dev
```

## Producción (Render)

- URL: https://mymochis.onrender.com
- Plan: free (Ohio region)
- Persistent disk: `/var/data` (1GB) → SQLite + uploads
- Auto-deploy on push to `main`
- Health check: `GET /api/health` → `{ok:true, version:"2.0.0"}`

### Variables de entorno (Render)

| Variable | Tipo | Descripción |
|---|---|---|
| `NODE_ENV` | literal | `production` |
| `PORT` | auto | Render inyecta |
| `NEXOMOCHIS_CORS` | literal | `https://mymochis.onrender.com` |
| `NEXOMOCHIS_JWT_SECRET` | `generateValue: true` | HMAC para JWT (auto-generado por Render) |
| `NEXOMOCHIS_DB_PATH` | literal | `/var/data/mymochis.db` |
| `NEXOMOCHIS_UPLOAD_DIR` | literal | `/var/data/uploads` |
| `CONTACT_EMAIL` | literal | `nxstudioing31@gmail.com` |
| `ADMIN_EMAIL` | literal | `admin@mymochis.app` |
| `ADMIN_PASSWORD` | `generateValue: true` | Seed admin en primer deploy, consultar Render dashboard si se pierde |
| `ADMIN_PASSWORD_RESET` | literal, opcional | Si vale `true`, al arrancar actualiza la password del admin existente al valor actual de `ADMIN_PASSWORD`. Usar para rotar y luego borrar la variable |

El seed admin (`init()` en `src/db.js`) crea `admin@mymochis.app` con role `'admin'` solo si el email no existe; restaura el role si fue demoteado; y con `ADMIN_PASSWORD_RESET=true` rota la password al valor del env. **Idempotente** — re-deploys no duplican. Para rotar en producción: setear `ADMIN_PASSWORD` nuevo + `ADMIN_PASSWORD_RESET=true` → redeploy → login → quitar `ADMIN_PASSWORD_RESET`.

## Endpoints

| Ruta | Método | Auth | Descripción |
|---|---|---|---|
| `/` | GET | No | Landing pública (cliente) |
| `/manage.html` | GET | Login inline | Dashboard del operador |
| `/api/health` | GET | No | Health check |
| `/api/public` | GET | No | Config + catálogo + métodos de pago + delivery |
| `/api/auth/login` | POST | No | Login → JWT (rate-limit 20/15min) |
| `/api/auth/register` | POST | No | **Solo crea `role:'customer'`** (lockdown v2.0.0) |
| `/api/me` | GET | JWT | Usuario actual |
| `/api/config` | GET/PUT | mixto | Config del negocio |
| `/api/flavors` | CRUD | mixto | Sabores |
| `/api/combos` | CRUD | mixto | Combos |
| `/api/categories` | CRUD | mixto | Categorías |
| `/api/orders` | CRUD | mixto | Pedidos |
| `/api/promos` | CRUD | JWT | Promos |
| `/api/social` | CRUD | JWT | Cola posts redes sociales |
| `/api/metrics` | GET | JWT | KPIs dashboard |
| `/api/payment-methods` | CRUD | mixto | Métodos de pago |
| `/api/payout-accounts` | CRUD | JWT | Cuentas de payout |
| `/api/delivery-config` | CRUD | JWT | Config delivery inmediata |
| `/api/delivery-schedule` | CRUD | mixto | Horarios de entrega |
| `/api/release-windows` | CRUD | JWT | Ventas por fecha |
| `/api/uploads` | POST/GET/DELETE | JWT | Upload imagen/video (rate-limit 30/min) |
| `/uploads/<filename>` | GET | No | Static serve con cache 30d immutable |

## Seguridad (v2.0.0)

- **Register lockdown**: `POST /api/auth/register` ahora **solo crea `role:'customer'`**. Cualquier `role` en el body es ignorado. Defensa contra escalación de privilegios.
- **Helmet**: CSP estricto, X-Frame-Options deny, HSTS 180d, hidePoweredBy, frameguard deny.
- **Rate-limit**: 120/min general, 20/15min auth, 30/min uploads.
- **Fail2ban login**: 5 intentos fallidos → bloquea IP por 15min.
- **Migraciones in-place**: `init()` downgradea admins viejos a customer (excepto `admin@mymochis.app`) y actualiza defaults de config en cada boot.
- **JWT HS256 custom**: firmado con `NEXOMOCHIS_JWT_SECRET` (auto-generado por Render).
- **scrypt**: password hashing con salt random 16 bytes.

## Estructura

```
mymochis/
├── server.js                  # Express entry + helmet + rate-limit + routes
├── render.yaml                # Render Blueprint (env vars + disk + health)
├── src/
│   ├── db.js                  # SQLite + schema + seeds + migrations
│   ├── auth.js                # JWT + scrypt + middleware
│   └── routes/
│       ├── auth.js            # register (customer only), login, fail2ban
│       ├── me.js              # current user
│       ├── config.js          # business config (PUT requiere admin)
│       ├── flavors.js         # flavors CRUD
│       ├── combos.js          # combos CRUD
│       ├── orders.js          # orders CRUD + delivery immediate + scheduled
│       ├── promos.js          # promos CRUD
│       ├── social.js          # social posts queue
│       ├── metrics.js         # KPIs
│       ├── categories.js      # categories
│       ├── payment-methods.js # métodos de pago
│       ├── payout-accounts.js # cuentas payout
│       ├── delivery-config.js # config delivery inmediata
│       ├── delivery-schedule.js # horarios
│       ├── release-windows.js # ventas por fecha
│       ├── public.js          # bundle público (config + catálogo + métodos + delivery)
│       └── uploads.js         # POST/GET/DELETE uploads
├── public/
│   ├── index.html              # landing (cliente)
│   ├── manage.html            # dashboard (operador) + login screen
│   ├── sw.js                  # service worker (PWA)
│   ├── manifest.json          # PWA manifest
│   ├── favicon.svg
│   └── img/                   # fotos de producto
└── data/                      # local dev only (gitignored)
    ├── mymochis.db            # SQLite local
    └── uploads/               # uploads local
```

## Flujo del cliente

1. Cliente abre `/` (landing).
2. Elige sabores y/o combo → modal express.
3. Confirma con su nombre + WhatsApp + día de recogida.
4. JS abre `wa.me/573113852101` con mensaje pre-armado (cliente confirma el pedido directo al WhatsApp del operador).
5. POST a `/api/orders` en paralelo → queda registrado en el dashboard.

## Flujo del operador

1. Abre `/manage.html` → login (email + clave).
2. Dashboard con KPIs del día, semana, total, ticket promedio + chart de 14 días + top sabores.
3. **Pedidos**: tabla con filtros (estado, día, búsqueda). Cambiar status inline. Soporta delivery inmediata y programada.
4. **Sabores**: CRUD del catálogo (drag-drop upload de imágenes, v2.0.0).
5. **Combos**: CRUD de combos con flag `featured`, gallery picker.
6. **Promos**: códigos de descuento (percent / fixed / bxgy).
7. **Redes sociales**: cola de posts (draft → scheduled → posted) para IG / FB / TikTok.
8. **Configuración**: datos del negocio, WhatsApp, Instagram handle, horarios.

## Notas de cierre (v2.0.0)

MyMochis queda cerrado como single-tenant en Render. Migración futura:

- **Plan**: Convertir MyMochis en **tenant de MyMochis Studio** (multi-tenant OSS stack: Hetzner + Coolify + Neon + Auth.js, ADR-005).
- **Trigger**: cuando se sature el free tier de Render (1GB disk, cold start, no scale) o cuando se quiera ofrecer como producto a otros negocios de mochi/repostería artesanal.
- **Pasos**: provisionar Neon branch `mymochis` → migrar schema → adapter pg en `db.js` → deploy en Coolify con subdomain `mymochis.mymochis.app`.

Para retomar la conversación: ver `dark-memory` proyecto `default` memory `#130` (sesión completa 2026-09-28) y memoria actualizada de este cierre.