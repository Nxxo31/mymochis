# MyMochis MVP — Arquitectura Open Source Simple

> Versión MVP: solo lo esencial para operar y validar. Sin dependencias de pago, sin infra compleja.
> Stack: **SQLite + Node + Vanilla JS/HTML + CSS** — cero build step obligatorio, deploy en cualquier VPS/PC.

---

## Stack MVP (Open Source Only)

| Capa | Tecnología | Por qué |
|------|------------|---------|
| **DB** | **SQLite** (`better-sqlite3`) | Archivo único, cero config, backup = copiar archivo, 100k+ ops/s |
| **Backend** | **Node.js + Fastify** | 2x Express, types nativos, plugins ecosystem, sin runtime pesado |
| **Frontend** | **HTML + CSS + Vanilla JS** (actual) | Ya funciona, sin build, SEO nativo, carga instantánea |
| **Auth** | **JWT simple** (HS256) + cookie HttpOnly | 50 líneas, sin librerías extra |
| **OCR** | **Tesseract.js** (WASM, offline) | Gratis, local, suficiente para facturas simples |
| **Pagos** | **Wompi** (sandbox gratis) + **Efectivo/Transferencia** | Wompi cubre Nequi/PSE/Bancolombia; Stripe solo si tarjetas internacionales |
| **Distancia** | **OSRM local** (Docker 1 contenedor) O **Haversine formula** (client-side, 0 deps) | Haversine = 20 líneas JS, suficiente para radio 10-15km urbano |
| **Analytics** | **Vistas SQL + Chart.js** (CDN) | Gráficos en manage.html sin build |
| **Deploy** | **PM2 + Nginx** en VPS $5 (Hetzner/DigitalOcean) O **Docker Compose** | Control total, $0 licencias |

---

## Esquema SQLite MVP (1 archivo: `data/mymochis.db`)

```sql
-- 1. BAKERY (config única, single-tenant MVP)
CREATE TABLE bakery (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'MyMochis',
  whatsapp TEXT,
  address TEXT,
  lat REAL, lng REAL,
  pickup_start TEXT DEFAULT '15:00',
  pickup_end TEXT DEFAULT '19:00',
  pickup_days TEXT DEFAULT '[1,2,3,4,5,6]', -- JSON array lunes-sábado
  delivery_fee_per_km INTEGER DEFAULT 800,  -- COP/km
  delivery_max_km REAL DEFAULT 10,
  payment_methods TEXT DEFAULT '["cash","transfer","nequi","wompi"]', -- JSON
  wompi_public_key TEXT,
  wompi_private_key TEXT,
  wompi_integrity_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. USERS (admin only for MVP)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL, -- bcrypt
  role TEXT DEFAULT 'owner', -- owner, production, sales
  created_at TEXT DEFAULT (datetime('now'))
);

-- 3. CATEGORIES
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- 'Sabores', 'Combos', 'Promociones'
  slug TEXT UNIQUE NOT NULL,    -- 'sabores', 'combos', 'promos'
  display_order INTEGER DEFAULT 0,
  color TEXT,                   -- hex para badge
  icon TEXT,                    -- emoji
  is_active INTEGER DEFAULT 1
);

-- 4. PRODUCTS (unifica todo: sabores, combos, promos)
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  base_price_cents INTEGER NOT NULL,      -- COP centavos
  compare_at_price_cents INTEGER,         -- precio tachado
  unit TEXT DEFAULT 'unidad',
  image_url TEXT,
  badge_text TEXT,                        -- 'Más pedido', 'Nuevo'
  badge_color TEXT,
  tags TEXT,                              -- JSON array: ['frutales','clasicos']
  features TEXT,                          -- JSON array: ['sin gluten']
  is_combo INTEGER DEFAULT 0,             -- 1 = combo configurable
  combo_units INTEGER,                    -- unidades incluidas si combo
  max_flavors INTEGER,                    -- máx sabores a elegir
  display_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 5. INGREDIENTS (para costing básico + OPCIONAL OCR)
CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,           -- 'kg', 'g', 'unidad'
  current_stock REAL DEFAULT 0,
  min_stock REAL DEFAULT 0,
  cost_per_unit_cents INTEGER DEFAULT 0,
  supplier TEXT,
  allergen_tags TEXT,           -- JSON array
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 6. RECIPES (simple, 1:1 con product para MVP)
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER UNIQUE REFERENCES products(id),
  yield_quantity REAL DEFAULT 1,
  yield_unit TEXT DEFAULT 'unidad',
  labor_minutes INTEGER DEFAULT 0,
  overhead_percent REAL DEFAULT 0.15,
  calculated_cost_cents INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id),
  quantity REAL NOT NULL
);

-- 7. SUPPLIER INVOICES (OCR)
CREATE TABLE supplier_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  total_cents INTEGER,
  file_path TEXT,               -- ruta local PDF/imagen
  ocr_status TEXT DEFAULT 'pending', -- pending, processing, reviewed
  ocr_raw_json TEXT,            -- resultado Tesseract
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id),
  description TEXT,
  quantity REAL,
  unit TEXT,
  unit_price_cents INTEGER,
  matched_confidence REAL,      -- 0-1
  is_approved INTEGER DEFAULT 0
);

-- 8. ORDERS (core business)
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,      -- MO-2026-0001
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT,                  -- JSON: street, neighborhood, lat, lng, notes
  delivery_type TEXT NOT NULL,            -- 'pickup' | 'delivery'
  delivery_fee_cents INTEGER DEFAULT 0,
  distance_km REAL,
  payment_method TEXT NOT NULL,           -- 'cash','transfer','nequi','wompi'
  payment_status TEXT DEFAULT 'pending',  -- pending, paid, partial
  payment_ref TEXT,                       -- transaction ID
  subtotal_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'new',              -- new, confirmed, in_production, ready, delivered, cancelled
  notes TEXT,                             -- instrucciones cliente
  source TEXT DEFAULT 'web',              -- web, whatsapp, phone, walkin
  pickup_date TEXT,
  pickup_time_start TEXT,
  pickup_time_end TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  selected_flavors TEXT,                  -- JSON: [{"flavorId":1,"qty":2}]
  line_total_cents INTEGER NOT NULL
);

-- 9. PRODUCTION + SURPLUS (simple daily tracking)
CREATE TABLE daily_production (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                     -- YYYY-MM-DD
  product_id INTEGER REFERENCES products(id),
  produced INTEGER DEFAULT 0,
  sold INTEGER DEFAULT 0,
  waste INTEGER DEFAULT 0,
  waste_reason TEXT,
  notes TEXT,
  UNIQUE(date, product_id)
);

-- 10. RELEASE WINDOWS (ventanas de pedido reactivas)
CREATE TABLE release_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  release_date TEXT NOT NULL,
  order_open_at TEXT NOT NULL,
  order_close_at TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  pickup_start TEXT NOT NULL,
  pickup_end TEXT NOT NULL,
  max_orders INTEGER,
  current_orders INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',            -- draft, open, closed, completed
  items TEXT,                             -- JSON: [{"productId":1,"maxUnits":50}]
  created_at TEXT DEFAULT (datetime('now'))
);

-- 11. ANNOUNCEMENTS (ticker/marquee)
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                     -- 'product','combo','promo','general'
  title TEXT NOT NULL,
  message TEXT,
  product_id INTEGER REFERENCES products(id),
  cta_text TEXT,
  cta_link TEXT,
  priority INTEGER DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER DEFAULT 1,
  display_order INTEGER DEFAULT 0
);

-- ÍNDICES ÚTILES
CREATE INDEX idx_orders_date ON orders(date(created_at));
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_production_date ON daily_production(date);
```

---

## Estructura de Archivos MVP

```
mymochis/
├── public/                    # Static files (servidos por Fastify)
│   ├── index.html            # Landing (hero, selector, formulario, ticker, 4 things, schedule)
│   ├── tienda.html           # Catálogo simple (opcional, redirige a index)
│   ├── manage.html           # Admin dashboard (CRUD, analytics, OCR)
│   ├── cocina.html           # Vista cocina (pedidos día, estados, horarios)
│   ├── theme.css             # Tokens v5 (ya existe)
│   ├── ui.css                # Componentes (ya existe + .product-card)
│   ├── sw.js                 # Service worker
│   └── manifest.json
├── server/
│   ├── index.js              # Fastify entry point
│   ├── db.js                 # better-sqlite3 connection + migraciones
│   ├── auth.js               # JWT helpers
│   ├── routes/
│   │   ├── public.js         # GET /api/products, /api/releases, /api/announcements
│   │   ├── orders.js         # POST /api/orders, GET /api/orders (admin)
│   │   ├── admin.js          # CRUD products, categories, releases, announcements
│   │   ├── ocr.js            # POST /api/ocr/upload, POST /api/ocr/approve
│   │   ├── analytics.js      # GET /api/analytics/surplus, /api/analytics/kpis
│   │   └── sse.js            # GET /api/events (Server-Sent Events)
│   ├── services/
│   │   ├── ocr.js            # Tesseract.js wrapper
│   │   ├── payments.js       # Wompi integration
│   │   ├── distance.js       # Haversine formula (client-compatible)
│   │   └── surplus.js        # Cálculos surplus/waste
│   └── utils/
│       ├── haversine.js      # Distancia lat/lng
│       └── orderNumber.js    # Generador MO-YYYY-NNNN
├── data/
│   └── mymochis.db           # SQLite file (gitignored)
├── scripts/
│   ├── migrate.js            # Ejecuta schema.sql
│   ├── seed.js               # Datos iniciales
│   └── cron.js               # Refresh materialized views, cleanup
├── package.json
├── ecosystem.config.js       # PM2 config
└── docker-compose.yml        # OSRM + app (opcional)
```

---

## API Endpoints MVP (Mínimos)

| Método | Ruta | Descripción |
|--------|------|-------------|
| **Públicas (landing)** | | |
| GET | `/api/products?category=sabores&active=1` | Catálogo para selector |
| GET | `/api/releases?status=open` | Fechas/horarios reactivos |
| GET | `/api/announcements?active=1` | Ticker/marquee |
| POST | `/api/orders` | Crear pedido (landing form) |
| **Admin (manage.html)** | | |
| GET | `/api/admin/orders?status=new` | Lista pedidos |
| PATCH | `/api/admin/orders/:id` | Cambiar estado, asignar producción |
| CRUD | `/api/admin/products` | Productos, categorías |
| CRUD | `/api/admin/releases` | Ventanas de pedido |
| CRUD | `/api/admin/announcements` | Ticker |
| POST | `/api/admin/ocr/upload` | Subir factura → Tesseract |
| POST | `/api/admin/ocr/:id/approve` | Aprobar líneas → actualiza costos |
| GET | `/api/admin/analytics/surplus?days=30` | Surplus % por producto |
| GET | `/api/admin/analytics/kpis?days=30` | Revenue, margin, orders, AOV |
| **SSE (reactividad landing)** | | |
| GET | `/api/events` | Stream: `product:updated`, `release:changed`, `announcement:new` |

---

## Flujo de Datos MVP (Simple)

```
┌─────────────────────────────────────────────────────────────────┐
│                        MYMOCHIS MVP FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ADMIN (manage.html)          LANDING (index.html)             │
│  ┌─────────────────┐          ┌────────────────────────────┐   │
│  │ CRUD Products   │────REST──▶│ GET /api/products         │   │
│  │ CRUD Releases   │────REST──▶│ GET /api/releases         │   │
│  │ CRUD Announce   │────REST──▶│ GET /api/announcements    │   │
│  │ OCR Invoices    │          │ SSE /api/events ──────────▶│   │
│  │ Analytics       │          │ (reactividad tiempo real)  │   │
│  └─────────────────┘          └─────────────┬──────────────┘   │
│                                             │                  │
│                                  ┌──────────┴──────────┐       │
│                                  │   ORDER FORM        │       │
│                                  │ 1. Select producto  │       │
│                                  │ 2. Datos + entrega  │       │
│                                  │ 3. Pago (Wompi/cash)│       │
│                                  └──────────┬──────────┘       │
│                                             │                  │
│                                             ▼                  │
│                                  ┌─────────────────────┐      │
│                                  │  POST /api/orders   │      │
│                                  │  - Valida stock     │      │
│                                  │  - Calc delivery    │      │
│                                  │  - Crea pago        │      │
│                                  └──────────┬──────────┘      │
│                                             │                  │
│                              ┌──────────────┴──────────────┐   │
│                              ▼                             ▼   │
│                     ┌─────────────────┐          ┌─────────────────┐
│                     │  COCINA HTML    │          │  ANALYTICS SQL  │
│                     │  (pedidos día)  │          │  (surplus, P&L) │
│                     │  Estados Kanban │          │  Charts.js      │
│                     └─────────────────┘          └─────────────────┘
│                                                                 │
│  DATABASE: data/mymochis.db (SQLite)                           │
│  ─────────────────────────────────────────                     │
│  • products, categories, orders, order_items                   │
│  • daily_production (surplus tracking)                         │
│  • release_windows, announcements                              │
│  • supplier_invoices, ingredients, recipes (OCR optional)      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Landing Page — Componentes MVP (index.html)

```html
<!-- 1. HERO: Clay-blob circular 28px -->
<section class="hero">
  <div class="hero-visual clay-blob">
    <img src="/img/hero-mochi.jpg" alt="Mochis artesanales">
  </div>
  <div class="hero-copy">
    <h1>Mochis artesanales con alma del Huila</h1>
    <p>Pide cada semana, recoge en nuestra cocina oculta. Frescos, sin congelar, hechos el mismo día.</p>
    <button class="btn btn-primary hero-cta" data-open-order>Armar mi pedido</button>
  </div>
</section>

<!-- 2. TICKER: Products + Combos + Promos (SSE reactivo) -->
<div class="ticker" aria-live="polite">
  <div class="ticker__track" id="ticker-track"></div>
</div>

<!-- 3. PRODUCT SELECTOR (grid clicable) -->
<section class="product-selector-section" id="product-selector" hidden>
  <h2 class="serif">¿Qué te antoja?</h2>
  <div class="product-selector" id="product-grid"></div>
  <button class="btn btn-ghost" data-close-selector>Seguir viendo</button>
</section>

<!-- 4. ORDER SHEET (modal flotante, fondo difuminado) -->
<div class="order-sheet" id="order-sheet" role="dialog" aria-modal="true" hidden>
  <div class="order-sheet__panel">
    <!-- Step 1: Producto (pre-seleccionado o selector) -->
    <!-- Step 2: Nombre, teléfono, entrega (pickup/delivery + dirección), notas -->
    <!-- Step 3: Pago (Wompi / efectivo / transferencia) -->
    <!-- Step 4: Confirmación + WhatsApp -->
  </div>
</div>

<!-- 5. 4 THINGS THAT MATTER (grid 2x2/4col) -->
<section class="value-grid" aria-label="Lo que nos importa">
  <article class="value-card"><div class="value-card__icon">🍰</div><h3>Hechos hoy</h3><p>Producimos cada mañana lo que se pide. Cero stock viejo.</p></article>
  <article class="value-card"><div class="value-card__icon">📍</div><h3>Recogida fácil</h3><p>Lunes a sábado 3-7pm en nuestra cocina oculta.</p></article>
  <article class="value-card"><div class="value-card__icon">💬</div><h3>Pedido en 30s</h3><p>WhatsApp o web. Sin registro, sin app.</p></article>
  <article class="value-card"><div class="value-card__icon">📊</div><h3>Precio justo</h3><p>Costos reales + margen transparente. Sabes qué pagas.</p></article>
</section>

<!-- 6. SCHEDULE REACTIVO (desde release_windows) -->
<section class="schedule" id="schedule">
  <h2 class="serif">Fechas abiertas esta semana</h2>
  <div class="schedule-grid" id="schedule-grid"></div>
</section>

<!-- 7. FOOTER NAV VISIBLE (sticky bottom mobile) -->
<nav class="footer-nav glass">
  <a href="/" class="btn btn-ghost btn-sm">🏠 Inicio</a>
  <a href="/manage.html" class="btn btn-primary btn-sm">⚙️ Admin</a>
  <a href="/cocina.html" class="btn btn-ghost btn-sm">👨‍🍳 Cocina</a>
</nav>
```

---

## Order Sheet — Lógica Simple (Vanilla JS)

```javascript
// public/js/order-sheet.js (módulo ES)
const STEPS = ['product', 'details', 'payment', 'confirm'];

let currentStep = 0;
let orderData = {
  productId: null, quantity: 1, selectedFlavors: [],
  name: '', phone: '', deliveryType: 'pickup',
  address: '', neighborhood: '', notes: '',
  paymentMethod: 'cash', deliveryFee: 0
};

async function openSheet(productId = null) {
  if (productId) { orderData.productId = productId; currentStep = 1; }
  else { currentStep = 0; }
  renderStep();
  document.getElementById('order-sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function renderStep() {
  const step = STEPS[currentStep];
  // Render HTML según step (templates simples)
  // Step 0: grid de productos clicables
  // Step 1: formulario nombre/tel/entrega/dirección
  // Step 2: radios pago (Wompi/efectivo/transfer) + total
  // Step 3: confirmación + submit
}

async function submitOrder() {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(orderData)
  });
  if (res.ok) {
    const { orderNumber } = await res.json();
    showToast(`¡Pedido ${orderNumber} confirmado! Te avisamos por WhatsApp.`);
    closeSheet();
  }
}

// Haversine distance (client-side, sin API key)
function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLng = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

---

## Admin Dashboard — manage.html (MVP)

```html
<!-- Tabs navegación -->
<nav class="admin-tabs">
  <button data-tab="orders" class="active">📋 Pedidos</button>
  <button data-tab="products">🍡 Productos</button>
  <button data-tab="releases">📅 Fechas</button>
  <button data-tab="announcements">📢 Anuncios</button>
  <button data-tab="ocr">🧾 Facturas OCR</button>
  <button data-tab="analytics">📊 Analytics</button>
</nav>

<!-- Tab Pedidos: tabla + Kanban simple -->
<section id="tab-orders">
  <select id="order-filter"><option value="new">Nuevos</option><option value="confirmed">Confirmados</option>...</select>
  <table class="table"><thead>...</thead><tbody id="orders-tbody"></tbody></table>
</section>

<!-- Tab Products: CRUD inline -->
<section id="tab-products" hidden>
  <button class="btn btn-primary" data-new-product>+ Nuevo</button>
  <div id="products-list"></div>
  <!-- Modal editar: nombre, precio, categoría, badge, tags, features, combo config, imagen -->
</section>

<!-- Tab Releases: CRUD ventanas -->
<section id="tab-releases" hidden>...</section>

<!-- Tab Analytics: Charts.js -->
<section id="tab-analytics" hidden>
  <canvas id="chart-surplus"></canvas>
  <canvas id="chart-revenue"></canvas>
  <canvas id="chart-top-products"></canvas>
</section>

<!-- Tab OCR: upload + review -->
<section id="tab-ocr" hidden>
  <input type="file" accept=".pdf,.jpg,.png" id="ocr-upload">
  <div id="ocr-queue"></div>
  <!-- Cada factura: muestra líneas extraídas, match confidence, botón aprobar -->
</section>
```

---

## Scripts Package.json

```json
{
  "name": "mymochis",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch server/index.js",
    "start": "node server/index.js",
    "pm2": "pm2 start ecosystem.config.js",
    "migrate": "node scripts/migrate.js",
    "seed": "node scripts/seed.js",
    "ocr:test": "node -e \"import('./server/services/ocr.js').then(m=>m.test())\"",
    "backup": "cp data/mymochis.db data/backups/mymochis-$(date +%F).db"
  },
  "dependencies": {
    "fastify": "^4.28",
    "better-sqlite3": "^9.4",
    "bcrypt": "^5.1",
    "jsonwebtoken": "^9.0",
    "tesseract.js": "^5.1",
    "chart.js": "^4.4",
    "@wompi/sdk": "^1.0",
    "zod": "^3.23"
  }
}
```

---

## Deploy MVP (5 minutos en VPS)

```bash
# 1. VPS Ubuntu 22.04 ($5/mes Hetzner CX22 o DigitalOcean Basic)
ssh root@tu-ip

# 2. Instalar Node 20 + PM2 + Nginx + SQLite
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx sqlite3
npm i -g pm2

# 3. Clonar repo
cd /opt && git clone https://github.com/tu-user/mymochis.git
cd mymochis && npm ci

# 4. Migraciones + seed
npm run migrate && npm run seed

# 5. PM2
pm2 start ecosystem.config.js --name mymochis
pm2 save && pm2 startup

# 6. Nginx (reverse proxy + static + SSL Let's Encrypt)
# /etc/nginx/sites-available/mymochis
server {
  listen 80; server_name midominio.com;
  location / { proxy_pass http://localhost:3737; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection 'upgrade'; proxy_set_header Host $host; proxy_cache_bypass $http_upgrade; }
  location /public/ { alias /opt/mymochis/public/; expires 1y; add_header Cache-Control "public, immutable"; }
}
nginx -t && systemctl reload nginx
certbot --nginx -d midominio.com

# 7. OSRM opcional (Docker)
docker run -d -p 5000:5000 -v /opt/osrm:/data ghcr.io/project-osrm/osrm-backend:latest /data/colombia-latest.osrm
```

---

## Qué NO está en MVP (se añade después)

| Feature | Por qué no ahora |
|---------|------------------|
| Multi-tenant / SaaS | Single bakery first |
| Forecasting AI | Necesita histórico; MVP = tracking manual |
| Portal mayorista | No hay volumen yet |
| Recetas completas + costing cascade | Ingredientes opcional MVP |
| Loyalty / CRM | Pedidos simples primero |
| App móvil driver | WhatsApp coordina entrega |
| HACCP / trazabilidad | No requerido legalmente micro |

---

## Próximos Pasos Inmediatos (Orden)

1. **Crear `server/` + `db.js` + migraciones** (30 min)
2. **Endpoints públicos** `/api/products`, `/api/releases`, `/api/announcements`, `/api/orders` (1-2h)
3. **Landing: Hero clay-blob + Aurora mochi + Body 90% + OrderSheet + Footer nav** (2-3h)
4. **Admin CRUD básico** (products, releases, announcements) (3-4h)
5. **SSE reactividad** landing ← admin (1h)
6. **Analytics SQL + Chart.js** en manage.html (1-2h)
7. **OCR Tesseract.js** upload + review (2-3h)
8. **Wompi sandbox** integración pago (1-2h)
9. **Deploy VPS + SSL** (30 min)

**Total estimado: ~15-20h = 2-3 días trabajo enfocado.**

---

¿Arrancamos con **Paso 1 (server + DB + migraciones)**? Es la base para todo lo demás.