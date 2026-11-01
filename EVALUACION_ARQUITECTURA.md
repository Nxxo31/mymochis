# MyMochis — Evaluación Actual + Arquitectura Objetivo + Patrones de Diseño

> Documento vivo: base para decisiones de arquitectura, naming, roles y patrones.
> Fecha: 2026-10-29 | Versión: 1.0

---

## 1. ESTADO ACTUAL (Lo que existe hoy)

### 1.1 Páginas implementadas (4 páginas homogenizadas v5 "Sakura & Cielo")

| Página | Estado | Stack | Notas |
|--------|--------|-------|-------|
| `public/index.html` | ✅ Completa | HTML + JS vanilla + CSS tokens | Landing: hero, sabores (grid 4/3/2/1 + filtros chips), combos, fechas, horarios, "3 cosas", galería, social |
| `public/tienda.html` | ✅ Completa | HTML + JS vanilla + CSS tokens | Catálogo + carrito lateral (sheet) + formulario pedido (select día/retiro/pago) |
| `public/manage.html` | ✅ Completa | HTML + JS vanilla + CSS tokens | Panel admin: tabla pedidos, stock, releases, auth simple |
| `public/cocina.html` | ✅ Completa | HTML + JS vanilla + CSS tokens | Vista cocina: pedidos del día, estados, horarios reactivos |

### 1.2 Sistema visual unificado

| Archivo | Responsabilidad |
|---------|-----------------|
| `public/theme.css` | **Tokens v5**: paleta (cielo/sakura/tinta/papel), tipografía (Baloo 2 + Quicksand), radios, sombras, CTA colors |
| `public/ui.css` | **Componentes compartidos**: `.btn*`, `.form-group/.form-block`, `.card/.card-glass`, `.chip`, `.modal`, `.table`, `.product-card` (nuevo), `.flavor-grid`, `.combos-grid` |
| `web/styles/tokens.css` | Tokens mirror para build Vite (islands.css no sobrescribe fuentes) |
| `web/landing/HeroBackground.tsx` | WebGL shader "aurora" — **fix aplicado**: `gl.useProgram(prog)` + todos los uniforms por frame |

### 1.3 Backend/API (server.js)

- Express estático en puerto 3737
- Endpoints: `/api/public` (catálogo, combos, releases), `/api/admin/*` (auth, pedidos, stock, CRUD básico)
- **Sin persistencia real** — usa arrays en memoria / mock data

### 1.4 Tests

| Suite | Resultado |
|-------|-----------|
| Unit (node --test) | 131/131 ✅ |
| E2E (Playwright) | 54/54 ✅ (server fresco) |

### 1.5 Qué FALTA (gap vs specs nuevos)

| Área | Actual | Requerido |
|------|--------|-----------|
| Hero | Foto rectangular + texto | **Clay-blob circular 28px** con imagen mochi redonda |
| Body/Shader | 50% blanco + shader pastel suave | **85-90% blanco** + **aurora colores mochi** (fresa/matcha/durazno/ube/crema) |
| Productos/Combos | Hardcoded en JS (`FLAVORS`, `COMBOS`) | **CRUD Admin** → productos, categorías, features, colores etiqueta, descripción, precio, combos, promos, horarios, ubicación admin |
| Marquee/Ticker | Solo productos | **Productos + Promos + Combos** rotando |
| "3 cosas que importan" | 3 cards estáticas | **4 componentes** mejorados (falta definir 4to) |
| Fechas/Horarios | Estáticos | **Reactivos desde admin** |
| OCR Facturas | No existe | Sistema OCR (proveedor: Tesseract local / AWS Textract / Google Vision / Azure) |
| Carrito/Checkout | Paso separado (`tienda.html`) | **Eliminar carrito** → formulario único en landing con selector producto + datos entrega/pago + fondo difuminado |
| Formulario pago | Básico | Nombre, teléfono, **domicilio por API distancia** (admin configura su ubicación ↔ cliente), dirección/notas, **método: físico vs electrónico (APIs configuradas)** |
| Navegación | Header básico | **Botones visibles** entre páginas para clientes |
| Analytics/Surplus | No existe | **Recopilación datos → estadísticas → análisis mercado → superávit empresa** |
| Persistencia | Arrays en memoria | **DB real** (PostgreSQL/SQLite + Prisma/Drizzle) |
| Multi-tenencia | No | **Preparado para SaaS** (schema-per-tenant estilo BakeryOS) |

---

## 2. INVESTIGACIÓN DE MERCADO — Patrones, Nombres, Roles

### 2.1 Sistemas comparados (Top 10 bakery SaaS 2026)

| Sistema | Modelo | Core Modules | Diferenciador clave | Pricing |
|---------|--------|--------------|---------------------|---------|
| **LogiBake** | B2B SaaS | Recetas, costos, facturas OCR, stock, producción, HACCP, BI/AI | **OCR facturas + AI BI** (4 secciones: Compras, Rendimiento, Productos, Equipo) | €€€ |
| **BakeryMS** | B2B SaaS multi-site | Órdenes, producción, stock, costos ingredientes, loyalty, NFC timesheets | **Multi-sitio nativo** + analytics diario/mensual | €€ |
| **Cybake** | ERP on-prem/Azure | Producción, wholesale, retail, entregas, inventario, BI, lot tracking | **ERP completo** + Azure + integraciones POS/contabilidad | €€€ |
| **Panya Pro** | B2B SaaS micro | Pagos, recibos, staff, mercados, OCR recibos → FreeAgent, Stripe, Zettle, Square | **Contabilidad integrada** + "Run the bakery, not the books" | € |
| **FullGuest** | B2B SaaS todo-en-uno | Pre-orders, QR ordering, recetas, producción, inventario, POS, loyalty, staff, AI Captain | **AI Captain** (voz/chat/telefono 90+ idiomas) + reemplaza 6+ herramientas | €€ |
| **BakeryOS** | Multi-tenant SaaS | Stock, recetas, órdenes, facturación PDF, RBAC, reporting Recharts, super-admin portal | **Schema-per-tenant** + npm workspaces + Drizzle + shadcn/ui | Open source / SaaS |
| **BakeOnyx** | B2B SaaS + managed service | Recipe costing, order mgmt, smart inventory, CRM, calendar, 20 reportes, pagos Stripe, AI forecasting (clima, festivos) | **4 AI agents** 24/7 (producción, inventario, analytics, marketing) | €€ |
| **SmartlyServe** | B2B SaaS | Órdenes retail/wholesale, producción, stock, facturación, AI demand predictions, lot tracking, portal mayorista | **Portal mayorista white-label** + AI predicción demanda | €€ |
| **Bakery Dashboard** | B2B SaaS | Recetas, inventario, producción, expiry, ventas, P&L live (QuickBooks), labels/nutrición | **Live P&L** + construido/usado por Crusted Bakery NYC | $89/mes |
| **Profito** | B2B SaaS (FR) | Food cost real-time, OCR+AI facturas auto-import email, HACCP, alérgenos, IA forecasting, Alexa voice | **OCR email auto-import** + alertas precio proveedor + voice | €€ |

### 2.2 Patrones de arquitectura comunes

| Patrón | Descripción | Ejemplos |
|--------|-------------|----------|
| **Schema-per-tenant** | Un schema PG por bakery; super-admin portal gestiona tenants | BakeryOS, Cybake (multi-site) |
| **Recipe-centric costing** | Receta = nodo central; cambio precio ingrediente → recalcula todo en cascada | LogiBake, Bakery Dashboard, BakeOnyx, Profito |
| **OCR + AI invoice pipeline** | Email/Drive/Upload → extracción líneas → matching ingredientes → aprobación → actualiza costos | LogiBake (88% auto), Profito (auto-import email), Panya Pro, BakeryOS |
| **Production ↔︎ Inventory sync** | Producción deduce stock automático; waste registrado por lote | FullGuest, SmartlyServe, Bakery Dashboard |
| **AI Demand Forecasting** | Historial ventas + clima + festivos + eventos locales → predicción diaria por producto | BakeOnyx (8 calendarios culturales), SmartlyServe, Profito, LogiBake |
| **Wholesale portal** | Cafés/restaurantes piden en portal propio; facturación automática | SmartlyServe, Cybake, FullGuest |
| **Role-based access** | Owner / Production / Sales / Driver / Admin / Super-admin | Todos |
| **Multi-channel orders** | Web + WhatsApp + QR + Phone + POS + Market/Event | FullGuest (AI Captain), Panya Pro (markets) |

### 2.3 Roles típicos en estos sistemas

| Rol | Permisos típicos | Qué ve en dashboard |
|-----|------------------|---------------------|
| **Super Admin** (SaaS owner) | Gestión tenants, billing, platform analytics, feature flags | Portal super-admin (BakeryOS) |
| **Owner / Gerente** | Todo: analytics, P&L, configuración, usuarios, proveedores | KPIs, margen, surplus, forecasting, alertas |
| **Producción / Jefe cocina** | Recetas, plan producción, waste, lot tracking, etiquetas | Lista producción del día, mermas, trazabilidad |
| **Ventas / Mostrador** | Órdenes, clientes, POS, cobros, loyalty | Órdenes del día, clientes, pagos pendientes |
| **Repartidor / Driver** | Rutas, entregas, confirmaciones, app móvil | Ruta optimizada, comprobantes entrega |
| **Contabilidad** | Facturas, P&L, impuestos, conciliación bancaria | Export contable, facturas por cobrar |
| **Cliente final** | Catálogo, pedido, pago, seguimiento, historial | Landing/tienda, estado pedido, favoritos |

### 2.4 Nomenclatura estándar (términos de dominio)

| Concepto | Término estándar | Sinónimos vistos |
|----------|------------------|------------------|
| Producto vendible | **Product** / **Item** | SKU, Article, Producto |
| Receta / Fórmula | **Recipe** / **Formula** | BOM, Formula, Elaboración |
| Ingrediente/Insumo | **Ingredient** / **Stock Item** / **Raw Material** | Insumo, Materia prima |
| Lote de producción | **Batch** / **Production Run** | Hornada, Lote, Batch |
| Merma/Desperdicio | **Waste** / **Shrink** / **Loss** | Merma, Desperdicio |
| Excedente no vendido | **Surplus** / **Unsold** / **Overproduction** | Excedente, Sobrante |
| Pedido cliente | **Order** / **Customer Order** | Pedido, Comanda |
| Pedido proveedor | **Purchase Order** / **PO** | Orden compra, Reposición |
| Factura proveedor | **Supplier Invoice** / **Bill** | Factura compra, Albarán |
| Punto de venta | **POS** / **Till** / **Register** | Caja, TPV |
| Canal mayorista | **Wholesale** / **B2B** / **Trade** | Mayorista, Canal HORECA |
| Canal minorista | **Retail** / **B2C** / **Counter** | Mostrador, Venta directa |
| Precio coste | **Cost Price** / **Recipe Cost** | Coste, Precio coste |
| Precio venta | **Sale Price** / **Retail Price** | PVP, Precio venta |
| Margen | **Margin** / **Gross Margin** | Margen bruto |
| Superávit/Resultado | **Net Profit** / **Operating Profit** / **Surplus** | Beneficio, Superávit, Resultado |

---

## 3. ARQUITECTURA OBJETIVO PARA MYMOCHIS

### 3.1 Visión de producto

> **"Sistema operativo para micro-panadería/confitería artesanal (1-3 ubicaciones) que unifica: landing reactiva + pedidos WhatsApp/Web + admin CRUD + OCR facturas + analytics surplus/P&L + forecasting. Diseñado para dueño-operador que hace de todo: produce, vende, gestiona, analiza."**

### 3.2 Stack tecnológico propuesto

| Capa | Tecnología | Justificación |
|------|------------|---------------|
| **Frontend** | Astro + React Islands (ya parcial) + Tailwind CSS (tokens → theme.css) | Islands para interactividad (formulario, ticker, charts), Astro para SEO/performance, Tailwind consume tokens CSS nativos |
| **Backend** | Node.js + Fastify (o Hono) + TypeScript | Más rápido que Express, typing nativo, plugins ecosystem |
| **DB** | PostgreSQL + **Drizzle ORM** (schema-per-tenant ready) | Type-safe, ligero, migraciones, multi-tenant nativo |
| **Auth** | Better Auth (o Lucia) + JWT 15min/7d refresh | RBAC ready, session management, multi-tenant |
| **OCR** | **Tesseract.js local** (gratis, offline) + **AWS Textract** (fallback cloud) | Cero costo inicio; escala a cloud si volumen > 50 facturas/mes |
| **Payments** | **Wompi** (Colombia) + **Stripe** (internacional) + **Efectivo/Transferencia** | Wompi = Nequi/Bancolombia/PSE; Stripe para tarjetas; manual para físico |
| **Shipping/Distance** | **Google Maps Distance Matrix** / **OSRM self-hosted** | Admin configura ubicación cocina → calcula distancia cliente → precio domicilio |
| **Analytics/BI** | **Apache ECharts** / **Recharts** + **Materialized Views** PG | Dashboards reactivos, P&L live, surplus tracking, forecasting |
| **Realtime** | Server-Sent Events (SSE) o Socket.io | Landing reactiva a cambios admin (horarios, stock, promos) |
| **Deploy** | Docker + Coolify / Railway / Fly.io | Single-node start, escala horizontal後 |
| **Observability** | OpenTelemetry + Grafana Loki + Prometheus | Logs, métricas, trazas desde día 1 |

### 3.3 Esquema de datos núcleo (Drizzle/PostgreSQL)

```typescript
// core/schema.ts — entidades principales
// Multi-tenant: cada bakery = schema aislado o tenant_id en filas

// 1. TENANT / BAKERY
export const bakeries = pgTable('bakeries', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),           // mymochis, miniverse, etc.
  ownerId: uuid('owner_id').references(() => users.id),
  address: jsonb('address').$type<{street:string; city:string; lat:number; lng:number}>(),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  settings: jsonb('settings').$type<{
    currency: 'COP';
    timezone: 'America/Bogota';
    pickupWindow: {start: '15:00'; end: '19:00'; days: number[]};
    deliveryZones: DeliveryZone[];
    paymentMethods: PaymentMethodConfig[];
  }>(),
  createdAt: timestamp('created_at').defaultNow(),
});

// 2. USERS + RBAC
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  email: text('email').unique(),
  phone: text('phone'),
  name: text('name'),
  role: text('role', {enum: ['owner','production','sales','driver','accountant']}).notNull(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at').defaultNow(),
});

// 3. CATEGORIES (sabores, combos, promos, etc.)
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  name: text('name').notNull(),           // 'Sabores', 'Combos', 'Promociones'
  slug: text('slug').notNull(),           // 'sabores', 'combos', 'promos'
  displayOrder: integer('display_order').default(0),
  color: text('color'),                   // hex para badge/tag
  icon: text('icon'),                     // emoji o lucide icon name
  isActive: boolean('is_active').default(true),
});

// 4. PRODUCTOS (unifica sabores, combos, promos)
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  categoryId: uuid('category_id').references(() => categories.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  basePrice: integer('base_price_cents').notNull(),  // COP centavos
  compareAtPrice: integer('compare_at_price_cents'), // precio tachado
  unit: text('unit').default('unidad'),              // 'unidad', 'combo', 'kg'
  imageUrl: text('image_url'),
  badgeText: text('badge_text'),          // 'Más pedido', 'Nuevo', 'Oferta'
  badgeColor: text('badge_color'),        // hex personalizado
  features: jsonb('features').$type<string[]>(),     // ['sin gluten', 'vegano']
  tags: jsonb('tags').$type<string[]>(),             // ['frutales', 'clasicos', 'premium']
  isActive: boolean('is_active').default(true),
  displayOrder: integer('display_order').default(0),
  // Para combos: configuración de selección
  comboConfig: jsonb('combo_config').$type<{
    allowsFlavorSelection: boolean;
    unitsIncluded: number;
    maxFlavors?: number;
  }>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// 5. INGREDIENTES / STOCK
export const ingredients = pgTable('ingredients', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  name: text('name').notNull(),
  unit: text('unit').notNull(),           // 'kg', 'g', 'L', 'ml', 'unidad', 'docena'
  currentStock: real('current_stock').default(0),
  minStock: real('min_stock').default(0),
  costPerUnit: integer('cost_per_unit_cents').notNull(),  // último coste conocido
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  allergenInfo: jsonb('allergen_info').$type<string[]>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// 6. RECETAS (BOM)
export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  productId: uuid('product_id').references(() => products.id).unique(),
  name: text('name').notNull(),
  yieldQuantity: real('yield_quantity').notNull(),  // ej. 20 unidades
  yieldUnit: text('yield_unit').default('unidad'),
  instructions: text('instructions'),
  laborMinutes: integer('labor_minutes').default(0),
  overheadPercent: real('overhead_percent').default(0.15), // 15% overhead default
  // Coste calculado = sum(ingredientes) + labor + overhead
  calculatedCost: integer('calculated_cost_cents'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const recipeIngredients = pgTable('recipe_ingredients', {
  id: uuid('id').primaryKey().defaultRandom(),
  recipeId: uuid('recipe_id').references(() => recipes.id, {onDelete: 'cascade'}),
  ingredientId: uuid('ingredient_id').references(() => ingredients.id),
  quantity: real('quantity').notNull(),   // ej. 0.5 kg harina
  notes: text('notes'),
});

// 7. PROVEEDORES + FACTURAS OCR
export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  name: text('name').notNull(),
  contactName: text('contact_name'),
  email: text('email'),
  phone: text('phone'),
  address: text('address'),
  paymentTerms: text('payment_terms'),    // 'Net 7', 'Net 14', 'Contado'
  isActive: boolean('is_active').default(true),
});

export const supplierInvoices = pgTable('supplier_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate: date('invoice_date').notNull(),
  totalAmount: integer('total_amount_cents').notNull(),
  fileUrl: text('file_url'),              // PDF/imagen original en R2/S3
  ocrStatus: text('ocr_status', {enum: ['pending','processing','review','approved','rejected']}).default('pending'),
  ocrRawData: jsonb('ocr_raw_data'),      // resultado crudo Tesseract/Textract
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').references(() => supplierInvoices.id, {onDelete: 'cascade'}),
  ingredientId: uuid('ingredient_id').references(() => ingredients.id),
  description: text('description').notNull(),  // texto original OCR
  quantity: real('quantity').notNull(),
  unit: text('unit'),
  unitPrice: integer('unit_price_cents').notNull(),
  totalPrice: integer('total_price_cents').notNull(),
  matchedConfidence: real('matched_confidence'), // 0-1 AI matching
  isApproved: boolean('is_approved').default(false),
});

// 8. PEDIDOS CLIENTES
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  orderNumber: text('order_number').notNull().unique(), // MO-2026-001234
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone').notNull(),
  customerAddress: jsonb('customer_address').$type<{
    street: string; neighborhood: string; city: string; lat?: number; lng?: number; notes?: string
  }>(),
  pickupDate: date('pickup_date'),
  pickupTimeStart: time('pickup_time_start'),
  pickupTimeEnd: time('pickup_time_end'),
  deliveryType: text('delivery_type', {enum: ['pickup','delivery']}).notNull(),
  deliveryFee: integer('delivery_fee_cents').default(0),
  distanceKm: real('distance_km'),
  paymentMethod: text('payment_method', {enum: ['cash','transfer','nequi','bancolombia','wompi_card','wompi_pse','stripe']}).notNull(),
  paymentStatus: text('payment_status', {enum: ['pending','paid','partial','refunded']}).default('pending'),
  paymentRef: text('payment_ref'),        // transaction ID proveedor
  subtotal: integer('subtotal_cents').notNull(),
  total: integer('total_cents').notNull(),
  status: text('status', {enum: ['new','confirmed','in_production','ready','delivered','cancelled']}).default('new'),
  notes: text('notes'),                   // instrucciones cliente
  source: text('source', {enum: ['web','whatsapp','phone','walkin','market']}).default('web'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').references(() => orders.id, {onDelete: 'cascade'}),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(),  // snapshot nombre
  unitPrice: integer('unit_price_cents').notNull(),
  quantity: integer('quantity').notNull(),
  selectedFlavors: jsonb('selected_flavors').$type<{flavorId:string; quantity:number}[]>(),
  lineTotal: integer('line_total_cents').notNull(),
});

// 9. PRODUCCIÓN + WASTE + SURPLUS
export const productionBatches = pgTable('production_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  recipeId: uuid('recipe_id').references(() => recipes.id),
  batchNumber: text('batch_number').notNull(),
  plannedQuantity: real('planned_quantity').notNull(),
  actualQuantity: real('actual_quantity'),
  wasteQuantity: real('waste_quantity').default(0),
  wasteReason: text('waste_reason'),      // 'overbaked', 'damaged', 'expired', 'quality'
  bakerId: uuid('baker_id').references(() => users.id),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const dailySurplus = pgTable('daily_surplus', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  date: date('date').notNull(),
  productId: uuid('product_id').references(() => products.id),
  produced: integer('produced').notNull(),
  sold: integer('sold').notNull(),
  surplus: integer('surplus').notNull(),  // produced - sold
  surplusValue: integer('surplus_value_cents').notNull(), // surplus * cost_price
  waste: integer('waste').default(0),
  wasteValue: integer('waste_value_cents').default(0),
  notes: text('notes'),
});

// 10. HORARIOS / RELEASES (ventanas de pedido)
export const releaseWindows = pgTable('release_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  name: text('name').notNull(),           // 'Semana 15-21 Oct'
  releaseDate: date('release_date').notNull(),
  orderOpenAt: timestamp('order_open_at').notNull(),
  orderCloseAt: timestamp('order_close_at').notNull(),
  pickupDate: date('pickup_date').notNull(),
  pickupStart: time('pickup_start').notNull(),
  pickupEnd: time('pickup_end').notNull(),
  maxOrders: integer('max_orders'),
  currentOrders: integer('current_orders').default(0),
  status: text('status', {enum: ['draft','open','closed','completed']}).default('draft'),
  items: jsonb('items').$type<{productId:string; maxUnits:number; soldUnits:number}[]>(),
  createdAt: timestamp('created_at').defaultNow(),
});

// 11. ANUNCIOS / TICKER / MARQUEE
export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  type: text('type', {enum: ['product','combo','promo','general']}).notNull(),
  title: text('title').notNull(),
  message: text('message'),
  productId: uuid('product_id').references(() => products.id),
  ctaText: text('cta_text'),              // 'Ver en tienda', 'Pedir ahora'
  ctaLink: text('cta_link'),              // '/#product-xyz' o '/tienda.html'
  priority: integer('priority').default(0),
  startsAt: timestamp('starts_at'),
  endsAt: timestamp('ends_at'),
  isActive: boolean('is_active').default(true),
  displayOrder: integer('display_order').default(0),
});

// 12. ANALYTICS / MATERIALIZED VIEWS (refrescadas por cron)
export const dailyKpis = pgTable('daily_kpis', {
  id: uuid('id').primaryKey().defaultRandom(),
  bakeryId: uuid('bakery_id').references(() => bakeries.id),
  date: date('date').notNull(),
  revenue: integer('revenue_cents').default(0),
  ordersCount: integer('orders_count').default(0),
  avgOrderValue: integer('avg_order_value_cents').default(0),
  newCustomers: integer('new_customers').default(0),
  returningCustomers: integer('returning_customers').default(0),
  productionCost: integer('production_cost_cents').default(0),
  grossMargin: integer('gross_margin_cents').default(0),
  surplusValue: integer('surplus_value_cents').default(0),
  wasteValue: integer('waste_value_cents').default(0),
  netProfit: integer('net_profit_cents').default(0),
  topProductId: uuid('top_product_id'),
  topCategoryId: uuid('top_category_id'),
});
```

### 3.4 Flujo de datos clave

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MYMOCHIS DATA FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────────────────┐   │
│  │  ADMIN   │────▶│   CRUD UI    │────▶│  POSTGRESQL (Drizzle)        │   │
│  │ Dashboard│     │  (manage)    │     │  • products, categories      │   │
│  └──────────┘     └──────────────┘     │  • recipes, ingredients    │   │
│        │                                 │  • invoices, suppliers     │   │
│        │                                 │  • release_windows         │   │
│        ▼                                 │  • announcements           │   │
│  ┌──────────────────┐                    └──────────────┬─────────────┘   │
│  │ OCR PIPELINE     │                                     │               │
│  │ Email/Upload     │                                     ▼               │
│  │ → Tesseract.js   │                    ┌──────────────────────────────┐   │
│  │ → Match ingred.  │                    │  MATERIALIZED VIEWS          │   │
│  │ → Aprobar        │                    │  • daily_kpis                │   │
│  │ → Actualiza costos                │  • product_performance        │   │
│  └──────────────────┘                    │  • surplus_analysis          │   │
│                                          │  • customer_lifetime         │   │
│                                          └──────────────┬─────────────┘   │
│                                                         │                 │
│                    ┌────────────────────────────────────┘                 │
│                    ▼                                                      │
│          ┌─────────────────────┐     ┌──────────────────────────────┐   │
│          │   LANDING (SSR)     │◀────│   SSE / WebSocket            │   │
│          │  index.html         │     │   (cambios admin → UI)       │   │
│          │  • Hero clay-blob   │     └──────────────────────────────┘   │
│          │  • Aurora mochi colors                                        │
│          │  • Product selector + form                                    │
│          │  • Ticker: products+combos+promos                             │
│          │  • 4 Things That Matter                                       │
│          │  • Reactive dates/horarios                                    │
│          └──────────┬────────┘                                          │
│                     │                                                   │
│                     ▼                                                   │
│          ┌─────────────────────┐                                       │
│          │   ORDER CREATED     │                                       │
│          │  • Valida stock     │                                       │
│          │  • Calcula domicilio│                                       │
│          │  • Crea pago (Wompi │                                       │
│          │    / Stripe / Cash) │                                       │
│          └──────────┬────────┘                                       │
│                     │                                               │
│                     ▼                                               │
│          ┌─────────────────────┐     ┌──────────────────────────┐   │
│          │   KITCHEN VIEW      │     │   ANALYTICS DASHBOARD    │   │
│          │   (cocina.html)     │     │   (manage.html /charts)  │   │
│          │   • Pedidos día     │     │   • P&L diario/semanal   │   │
│          │   • Estados Kanban  │     │   • Surplus % por prod.  │   │
│          │   • Horarios react. │     │   • Forecast demanda     │   │
│          │   • Waste logging   │     │   • Customer cohorts     │   │
│          └─────────────────────┘     └──────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. PATRONES DE DISEÑO ESPECÍFICOS PARA MYMOCHIS

### 4.1 Naming Conventions (consistente con investigación)

| Capa | Convención | Ejemplo |
|------|------------|---------|
| **DB Tables** | snake_case plural | `products`, `order_items`, `daily_kpis` |
| **DB Columns** | snake_case | `base_price_cents`, `pickup_date`, `is_active` |
| **TypeScript Types** | PascalCase singular | `Product`, `OrderItem`, `DailyKpi` |
| **API Routes** | kebab-case plural | `GET /api/products`, `POST /api/orders` |
| **React Components** | PascalCase | `<ProductCard />`, `<OrderForm />`, `<SurplusChart />` |
| **CSS Classes** | kebab-case BEM | `.product-card`, `.product-card__photo`, `.product-card--featured` |
| **CSS Custom Props** | `--category-property` | `--color-fresa`, `--font-display`, `--r-xl` |
| **Events/SSE** | `domain:action` | `product:created`, `order:paid`, `surplus:calculated` |
| **Env Vars** | `UPPER_SNAKE_CASE` | `DATABASE_URL`, `WOMPI_PRIVATE_KEY`, `GMAPS_API_KEY` |

### 4.2 Component Design Patterns (para ui.css + React Islands)

```css
/* ui.css — Patrones base reutilizables */

/* 1. SUPERFICIE VIDRIO (glass) — deja ver aurora */
.glass {
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid rgba(255,255,255,0.6);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-glass), inset 3px -3px 6px rgba(255,255,255,0.85);
}

/* 2. CLAY BLOB (hero mochi) */
.clay-blob {
  border-radius: 28px;              /* NO 50% — forma orgánica mochi */
  background: var(--surface);
  box-shadow: var(--shadow-clay-lg), inset 4px -4px 8px rgba(255,255,255,0.9);
  aspect-ratio: 1 / 1;
  overflow: hidden;
}

/* 3. PRODUCT CARD (unificada) */
.product-card { @extend .glass; display:flex; flex-direction:column; }
.product-card__photo { aspect-ratio:1/1; overflow:hidden; background:var(--color-crema); }
.product-card__name { font-family:var(--font-display); font-size:1.25rem; font-weight:700; color:var(--ink); }
.product-card__price { font-family:var(--font-display); font-size:1.625rem; font-weight:700; color:var(--ink); }
.product-card__btn { @extend .btn-primary; width:100%; }

/* 4. TICKER / MARQUEE */
.ticker { overflow:hidden; white-space:nowrap; }
.ticker__track { display:flex; gap:2rem; animation:ticker-scroll 30s linear infinite; }
.ticker__item { flex-shrink:0; padding:0.5rem 1rem; @extend .glass; border-radius:var(--r-pill); }
@keyframes ticker-scroll { from{transform:translateX(0)} to{transform:translateX(-50%)} }

/* 5. FORMULARIO FLOTANTE (landing checkout) */
.order-sheet {
  position:fixed; inset:0; z-index:100;
  background:rgba(32,48,74,0.45); backdrop-filter:blur(6px);
  display:flex; align-items:center; justify-content:center; padding:1rem;
}
.order-sheet__panel {
  width:100%; max-width:480px; max-height:90vh; overflow:auto;
  @extend .glass; padding:1.5rem; border-radius:var(--r-2xl);
  animation:sheet-up 0.3s var(--ease-out);
}

/* 6. SELECTOR PRODUCTO EN FORMULARIO */
.product-selector { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:0.75rem; }
.product-selector__option {
  @extend .glass; padding:0.75rem; border-radius:var(--r-lg); cursor:pointer; text-align:center;
  transition:transform var(--dur-fast), box-shadow var(--dur-fast);
}
.product-selector__option:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); }
.product-selector__option--selected { border-color:var(--sakura-ink); box-shadow:0 0 0 2px var(--sakura-ink); }
.product-selector__img { aspect-ratio:1/1; border-radius:var(--r-md); object-fit:cover; margin-bottom:0.5rem; }
.product-selector__name { font-family:var(--font-display); font-size:0.875rem; font-weight:700; }
.product-selector__price { font-size:0.875rem; font-weight:600; color:var(--ink); }

/* 7. 4 THINGS THAT MATTER (grid 2x2 mobile, 4col desktop) */
.value-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1.5rem; }
@media(max-width:900px){ .value-grid{grid-template-columns:repeat(2,1fr)} }
@media(max-width:560px){ .value-grid{grid-template-columns:1fr} }
.value-card { @extend .glass; padding:2rem 1.5rem; text-align:center; border-radius:var(--r-2xl); }
.value-card__icon { width:64px; height:64px; margin:0 auto 1rem; background:var(--color-fresa); border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:1.5rem; }
.value-card__title { font-family:var(--font-display); font-size:1.125rem; font-weight:700; color:var(--ink); margin-bottom:0.5rem; }
.value-card__desc { font-size:0.875rem; color:var(--ink-soft); line-height:1.5; }

/* 8. HORARIOS REACTIVOS */
.schedule-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:1rem; }
.schedule-card { @extend .glass; padding:1.5rem; border-radius:var(--r-xl); }
.schedule-card__day { font-family:var(--font-display); font-weight:700; color:var(--ink); margin-bottom:0.5rem; }
.schedule-card__window { display:flex; align-items:center; gap:0.5rem; font-size:0.875rem; color:var(--ink-soft); }
.schedule-card__status { padding:0.25rem 0.75rem; border-radius:var(--r-pill); font-size:0.75rem; font-weight:700; }
.schedule-card__status--open { background:var(--color-matcha); color:var(--matcha-ink); }
.schedule-card__status--closed { background:var(--color-fresa); color:var(--fresa-ink); }
.schedule-card__status--soon { background:var(--color-durazno); color:var(--durazno-ink); }
```

### 4.3 Landing Page — Nueva Estructura (index.astro)

```astro
---
// src/pages/index.astro
import Hero from '@/components/Hero.astro';
import ProductSelector from '@/components/ProductSelector.tsx';
import Ticker from '@/components/Ticker.tsx';
import ValueGrid from '@/components/ValueGrid.tsx';
import Schedule from '@/components/Schedule.tsx';
import Announcements from '@/components/Announcements.tsx';
import OrderSheet from '@/components/OrderSheet.tsx';
import { getProducts, getAnnouncements, getReleaseWindows } from '@/lib/api';
---

<html lang="es">
<head>
  <link rel="stylesheet" href="/theme.css" />
  <link rel="stylesheet" href="/ui.css" />
  <meta name="theme-color" content="#62D3EC" />
</head>
<body>
  <!-- Shader Aurora (z-index: 0) -->
  <div class="page-shader" data-island="hero-bg" data-props='{"intensity":0.62,"colorA":"#F9B8CE","colorB":"#C9DC8A","colorC":"#C5B0E8"}'></div>

  <main class="z-10 relative">
    <!-- HERO: clay-blob circular + copy + CTA -->
    <Hero />

    <!-- TICKER: products + combos + promos -->
    <Ticker items={announcements} />

    <!-- PRODUCT SELECTOR + ORDER FORM (sheet) -->
    <ProductSelector products={products} onSelect={openOrderSheet} />

    <!-- 4 THINGS THAT MATTER -->
    <ValueGrid items={[
      {icon:'🍰', title:'Hechos hoy', desc:'Producimos cada mañana lo que se pide. Cero stock viejo, cero congelado.'},
      {icon:'📍', title:'Recogida fácil', desc:'Lunes a sábado 3-7pm en nuestra cocina oculta. Tú eliges el horario.'},
      {icon:'💬', title:'Pedido en 30s', desc:'WhatsApp o web. Sin registro, sin app. Solo tu nombre y qué quieres.'},
      {icon:'📊', title:'Precio justo', desc:'Costos reales + margen transparente. Sabes qué pagas y por qué.'}
    ]} />

    <!-- FECHAS/HORARIOS REACTIVOS -->
    <Schedule windows={releaseWindows} />

    <!-- FOOTER NAV VISIBLE -->
    <nav class="footer-nav glass" style="position:sticky; bottom:0; margin-top:3rem; padding:1rem; display:flex; gap:1rem; justify-content:center;">
      <a href="/" class="btn btn-ghost">🏠 Inicio</a>
      <a href="/tienda.html" class="btn btn-primary">🛍️ Tienda</a>
      <a href="/cocina.html" class="btn btn-ghost">👨‍🍳 Cocina</a>
      <a href="/manage.html" class="btn btn-ghost">⚙️ Admin</a>
    </nav>
  </main>

  <!-- ORDER SHEET (modal flotante con fondo difuminado) -->
  <OrderSheet />
</body>
</html>
```

### 4.4 Formulario de Pedido Único (OrderSheet.tsx)

```tsx
// src/components/OrderSheet.tsx
export default function OrderSheet() {
  const [step, setStep] = useState<'product'|'details'|'payment'|'confirm'>('product');
  const [form, setForm] = useState({
    productId: '',
    quantity: 1,
    selectedFlavors: [] as string[],
    name: '',
    phone: '',
    deliveryType: 'pickup' as 'pickup'|'delivery',
    address: '',
    neighborhood: '',
    notes: '',
    paymentMethod: 'cash' as PaymentMethod,
  });
  const [deliveryFee, setDeliveryFee] = useState(0);

  // Calcular domicilio al cambiar dirección
  useEffect(() => {
    if (form.deliveryType === 'delivery' && form.address) {
      calculateDistance(form.address).then(setDeliveryFee);
    }
  }, [form.address, form.deliveryType]);

  const submit = async () => {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...form, deliveryFee, subtotal: calcSubtotal(), total: calcSubtotal()+deliveryFee})
    });
    if (res.ok) { closeSheet(); showToast('¡Pedido confirmado! Te avisamos por WhatsApp.'); }
  };

  return (
    <div class="order-sheet" role="dialog" aria-modal="true">
      <div class="order-sheet__panel">
        {/* Step 1: Producto */}
        {step === 'product' && (
          <ProductPicker
            products={products}
            selected={form.productId}
            onSelect={(p) => { setForm(f=>({...f, productId:p.id})); setStep('details'); }}
          />
        )}

        {/* Step 2: Datos cliente + entrega */}
        {step === 'details' && (
          <form onSubmit={(e)=>{e.preventDefault(); setStep('payment');}}>
            <div class="form-group">
              <label>Nombre</label>
              <input name="name" value={form.name} onChange={h} required />
            </div>
            <div class="form-group">
              <label>WhatsApp / Teléfono</label>
              <input name="phone" type="tel" value={form.phone} onChange={h} required />
            </div>
            <div class="form-group">
              <label>
                <input type="radio" name="deliveryType" value="pickup" checked={form.deliveryType==='pickup'} onChange={h} /> Recoger en cocina
              </label>
              <label>
                <input type="radio" name="deliveryType" value="delivery" checked={form.deliveryType==='delivery'} onChange={h} /> Domicilio (+${deliveryFee/100} COP)
              </label>
            </div>
            {form.deliveryType === 'delivery' && (
              <>
                <div class="form-group"><label>Dirección</label><input name="address" value={form.address} onChange={h} required /></div>
                <div class="form-group"><label>Barrio / Referencia</label><input name="neighborhood" value={form.neighborhood} onChange={h} /></div>
              </>
            )}
            <div class="form-group"><label>Notas (opcional)</label><textarea name="notes" value={form.notes} onChange={h} /></div>
            <button type="submit" class="btn btn-primary w-full">Continuar →</button>
          </form>
        )}

        {/* Step 3: Pago */}
        {step === 'payment' && (
          <form onSubmit={(e)=>{e.preventDefault(); setStep('confirm');}}>
            <h3 class="serif mb-4">Total: ${(calcSubtotal()+deliveryFee).toLocaleString('es-CO')} COP</h3>
            <div class="form-group">
              <label>Método de pago</label>
              <div style="display:grid; gap:0.5rem; grid-template-columns:1fr 1fr;">
                {paymentMethods.map(m => (
                  <label key={m.id} class="glass p-3 text-center cursor-pointer border-2 {form.paymentMethod===m.id?'border-[var(--sakura-ink)]':''}" onClick={()=>setForm(f=>({...f,paymentMethod:m.id}))}>
                    {m.icon} {m.name}
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" class="btn btn-primary w-full">Confirmar pedido</button>
          </form>
        )}

        {/* Step 4: Confirmación */}
        {step === 'confirm' && (
          <div class="text-center py-4">
            <div class="text-4xl mb-2">✅</div>
            <h3 class="serif mb-2">¡Pedido enviado!</h3>
            <p class="text-sm text-[var(--ink-soft)] mb-4">Te llegará confirmación por WhatsApp al {form.phone}</p>
            <button class="btn btn-primary" onClick={closeSheet}>Cerrar</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 5. ROADMAP DE IMPLEMENTACIÓN (Priorizado)

| Fase | Entregable | Esfuerzo | Dependencias |
|------|------------|----------|--------------|
| **0** | **Setup DB + Auth + Drizzle** | 2-3 días | — |
| **1** | **Hero clay-blob + Aurora mochi colors** | 0.5 días | theme.css tokens |
| **2** | **Formulario único en landing (OrderSheet + ProductSelector)** | 2-3 días | API `/api/orders`, Wompi/Stripe config |
| **3** | **Admin CRUD completo** (productos, categorías, combos, promos, horarios, ubicación) | 4-5 días | DB schema, RBAC, manage.html rewrite |
| **4** | **Landing reactiva (SSE)** — ticker, fechas, horarios, 4 things | 1-2 días | SSE endpoint, manage → broadcast |
| **5** | **OCR Facturas** (Tesseract.js + review UI) | 3-4 días | supplierInvoices schema, upload R2/S3 |
| **6** | **Analytics / Surplus / P&L Dashboard** | 3-4 días | Materialized views, ECharts/Recharts, cron jobs |
| **7** | **Forecasting demanda** (historial + clima + festivos Colombia) | 2-3 días | API clima, calendario festivos CO |
| **8** | **Portal mayorista opcional** | 2-3 días | Wholesale portal, facturación auto |
| **9** | **Multi-tenant / SaaS hardening** | 2-3 días | Schema-per-tenant, super-admin portal |

### Quick Wins (esta semana)
1. **Hero clay-blob** — cambiar HTML/CSS hero a círculo 28px + imagen redonda
2. **Aurora colors** — actualizar `HeroBackground.tsx` uniforms a paleta mochi
3. **Body 90% blanco** — `color-mix(in srgb, var(--canvas) 90%, transparent)`
4. **OrderSheet en landing** — mover formulario de tienda.html a index.html como sheet
5. **Footer nav visible** — 4 botones sticky bottom

---

## 6. DECISIONES PENDIENTES (Necesito tu input)

| # | Decisión | Opciones | Recomendación |
|---|----------|----------|---------------|
| 1 | **OCR Provider** | Tesseract.js (gratis, local) / AWS Textract ($1.50/1000 páginas) / Google Document AI / Azure Form Recognizer | **Tesseract.js primero** — cero costo, offline, suficiente para facturas simples. Migra a Textract si >50/mes. |
| 2 | **Payment Gateway Colombia** | Wompi (Nequi/Bancolombia/PSE) + Stripe (tarjetas) / Solo Wompi / MercadoPago | **Wompi + Stripe** — cubre Nequi, PSE, tarjetas. Wompi = banco local. |
| 3 | **Distance/Delivery Pricing** | Google Maps Distance Matrix ($5/1000) / OSRM self-hosted (gratis, OpenStreetMap) | **OSRM self-hosted** — gratis, ilimitado, datos Colombia buenos. Docker 1 contenedor. |
| 4 | **4to componente "Things That Matter"** | (a) Precio justo / transparencia (b) Sostenibilidad / cero desperdicio (c) Comunidad local (d) Calidad artesanal | **(a) Precio justo** — diferencia vs competidores, alinea con analytics surplus. |
| 5 | **Tablero de anuncios** | Componente en landing (ticker + cards) / Página aparte `/anuncios.html` / Widget embedible | **En landing** (ticker + sección "Novedades") + página `/anuncios.html` para SEO. |
| 6 | **DB Hosting** | Railway PostgreSQL ($5/mes) / Neon Serverless (gratis hasta 0.5GB) / Supabase (gratis 500MB) / Self-hosted VPS | **Neon Serverless** — gratis generoso, branching, auto-scale, TypeScript DX. |
| 7 | **Deploy Target** | Coolify (self-host VPS) / Railway / Fly.io / Vercel (solo frontend) | **Railway** — PostgreSQL + Redis + Node en mismo proyecto, $5/mes, zero config. |

---

## 7. MÉTRICAS CLAVE A TRACKEAR (KPIs para Superávit)

| Métrica | Fórmula | Frecuencia | Alerta si |
|---------|---------|------------|-----------|
| **Revenue Diario** | Σ `orders.total` | Diaria | < 70% promedio 7d |
| **Gross Margin %** | (Revenue - COGS) / Revenue | Diaria | < 40% |
| **Surplus Rate %** | Σ `daily_surplus.surplus` / Σ `produced` | Diaria | > 8% |
| **Waste Rate %** | Σ `waste` / Σ `produced` | Diaria | > 3% |
| **Avg Order Value** | Revenue / Orders | Semanal | ↓ 10% vs mes anterior |
| **Customer Retention** | Returning / Total Customers | Mensual | < 30% |
| **Delivery Cost %** | Delivery Fees Collected / Delivery Cost Real | Semanal | < 100% (subsidiando) |
| **Invoice Processing Time** | `reviewed_at - created_at` (facturas) | Semanal | > 48h |
| **Forecast Accuracy (MAPE)** | \|Actual - Predicho\| / Actual | Semanal | > 20% |

---

## 8. PRÓXIMOS PASOS INMEDIATOS

1. **Confirmar decisiones pendientes** (tabla arriba) → yo elijo defaults si quieres velocidad
2. **Setup DB + Auth** (Fase 0) — 2-3 días, base para todo
3. **Quick Wins visuales** (Hero, Aurora, Body 90%, OrderSheet, Footer nav) — 1 día
4. **Admin CRUD real** — conecta manage.html a DB, elimina mock data
5. **Landing reactiva (SSE)** — admin cambia horario → landing actualiza sin refresh

---

¿Quieres que empiece por **Fase 0 (DB + Auth)** o por **Quick Wins visuales** para ver impacto inmediato en landing?