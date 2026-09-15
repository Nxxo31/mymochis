# MyMochis

Landing + panel operador para tienda de mochis artesanales en Neiva (dark kitchen, pedido por WhatsApp, recogida mar–sáb 3–7pm).

Stack: HTML + CSS + JS vanilla (zero deps, zero build). PWA instalable. Funciona offline después de la primera carga.

## Estructura

| archivo | qué hace |
|---|---|
| `index.html` | Landing pública con sabores, combos, carrito y form WhatsApp |
| `admin.html` | Panel operador (clave `mymochis2026`) con registro manual + parser de mensajes |
| `favicon.svg` | Ícono adaptable (kanji 餅 sobre fondo crema) |
| `og-image.png` | Preview 1200×630 PNG (WhatsApp/redes). El `.svg` es la fuente editable |
| `og-image.svg` | Preview 1200×630 cuando alguien comparte el link (fuente SVG) |
| `icon-192.png` / `icon-512.png` | Íconos PWA instalable |
| `manifest.json` | PWA instalable (nombre, colores, íconos) |
| `sw.js` | Service worker: cache-first para assets, network-first para HTML |

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

## Deploy — GitHub Pages (activo)

El sitio está publicado en GitHub Pages desde la rama `main`:

**URL:** `https://nxxo31.github.io/mymochis/`

Se activó vía la API de GitHub (Settings → Pages → Source: main / root). Cada `git push` a `main` re-deploya automáticamente en ~1 minuto. No hay build step — los archivos se sirven tal cual.

### Dominio personalizado (opcional)

1. Settings → Pages → Custom domain: poner el dominio (ej. `mymochis.co`)
2. En el DNS del dominio: `CNAME` → `nxxo31.github.io`
3. GitHub emite el certificado HTTPS automáticamente

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
