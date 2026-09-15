# MyMochis

Landing + panel operador para tienda de mochis artesanales en Neiva (dark kitchen, pedido por WhatsApp, recogida mar–sáb 3–7pm).

Stack: HTML + CSS + JS vanilla (zero deps, zero build). PWA instalable. Funciona offline después de la primera carga.

## Estructura

| archivo | qué hace |
|---|---|
| `index.html` | Landing pública con sabores, combos, carrito y form WhatsApp |
| `admin.html` | Panel operador (clave `mymochis2026`) con registro manual + parser de mensajes |
| `favicon.svg` | Ícono adaptable (kanji 餅 sobre fondo crema) |
| `og-image.svg` | Preview 1200×630 cuando alguien comparte el link por WhatsApp/redes |
| `manifest.json` | PWA instalable (nombre, colores, íconos) |
| `sw.js` | Service worker: cache-first para assets, network-first para HTML |
| `vercel.json` | Headers de seguridad y `cleanUrls` |

## Flujo de pedidos

```
Cliente                  Landing                WhatsApp                Operador
  │  ── elige sabores ───►  │                       │                       │
  │                         │ ── abre wa.me ───────► │ ── mensaje pre-armado►│
  │                         │                       │                       │
  │                         │                       │ ◄── confirma ─────────│
  │                         │                       │                       │
  │                         │                       │                       ├─► admin.html
  │                         │                       │                       │   + Nuevo pedido
  │                         │                       │                       │   (o Pegar mensaje)
  │  ── recoge mar–sáb ────────────────────────────────────────────────────►│
```

El admin guarda los pedidos en `localStorage` del navegador del operador. Es deliberadamente simple para MVP — un sólo operador, un sólo dispositivo. Cuando crezca el volumen se migra a backend (Supabase sugerido).

## Deploy

### Opción A: Vercel CLI (recomendado)

```bash
npm i -g vercel
cd Desktop\proyectos\mymochis
vercel              # primer deploy, te da URL *.vercel.app
vercel --prod       # promover a producción
```

Sin variables de entorno, sin build step. Vercel detecta el `vercel.json` y aplica `cleanUrls` + headers de seguridad.

### Opción B: Vercel dashboard

1. Ir a https://vercel.com/new
2. "Import Project" → seleccionar el repo (o drag-and-drop la carpeta `mymochis/`)
3. Framework preset: **Other** (no usa framework)
4. Deploy

### Dominio personalizado

Una vez con URL `*.vercel.app`:

1. Comprar dominio (Namecheap, Google Domains, etc.)
2. Vercel → Project Settings → Domains → agregar dominio
3. Apuntar DNS según instrucciones

Sugerencias `.co` colombianas: `mymochis.co`, `mymochisneiva.co`, `mochisdelhuila.co`.

## Configuración post-deploy

1. Abrir `https://TU-URL/admin.html`
2. Ingresar clave `mymochis2026`
3. **Configurar WhatsApp** (botón ⚙ en footer de la landing): poner el número real `57XXXXXXXXXX`
4. Probar el flujo: landing → carrito → confirmar → WhatsApp abre con mensaje
5. Verificar que el OG image se vea al compartir: https://www.opengraph.xyz/url-preview/TU-URL

## Pendientes del operador (no de código)

- [ ] Reemplazar `WHATSAPP_NUMBER` real (ya está en modal de config)
- [ ] Decidir si pickup es en local fijo (poner dirección en footer) o a convenir
- [ ] Crear cuenta Instagram `@mymochis.neiva` y actualizar footer
- [ ] Probar el form en móvil real (instalar la PWA)
- [ ] Definir capacidad semanal (cuántos mochis puede producir por día) y mostrar "agotado" cuando llegue al límite

## Limitaciones conocidas del MVP

- **Admin no sincroniza entre dispositivos** — el operador debe usar siempre el mismo navegador/celular. Próxima iteración: Supabase.
- **Parser de WPP es best-effort** — si el cliente edita mucho el mensaje pre-armado, los items no se detectan. Siempre revisar antes de guardar.
- **No hay capacidad máxima** — se puede recibir más pedidos de los que se pueden producir. Solución: contador semanal visible y corte automático cuando llegue al límite.

## Licencia

Uso interno — MyMochis Neiva.
