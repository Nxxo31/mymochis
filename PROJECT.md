# MyMochis — PROJECT.md

Fuente única de verdad del proyecto. Regla vigente: decisiones, arquitectura, estado operativo, roadmap y runbooks viven aquí; no crear `.md` adicionales salvo `AGENTS.md` cuando aplique.

## Arquitectura autónoma single-tenant con deploy gratuito

Fecha: 2026-10-08
Estado: decisión aprobada por operador (**sin SaaS multi-tenant**)
Ámbito: app actual `mymochis` v2.0.0 (`Express + node:sqlite + frontend estático`)

## 1. Decisión arquitectónica

**Decisión:** mantener MyMochis como **monolito single-tenant portable**, desplegado primero en **Oracle Cloud Always Free** con persistencia local SQLite y backups cifrados fuera del proveedor. No continuar con MyMochis Studio multi-tenant como requisito para operar el negocio del amigo.

**Motivación:**
- El negocio necesita autonomía operativa: catálogo, pedidos, promos, horarios, delivery y dashboard sin depender de Sebas.
- El código actual ya cubre esas capacidades en modo single-tenant.
- SaaS multi-tenant agrega complejidad de plataforma (tenants, provisioning, DNS wildcard, billing, soporte) innecesaria para este caso.
- Render free + disk persistente deja de ser "gratis" si se cobra el disco; la persistencia es obligatoria para SQLite/uploads.

**No-objetivos:**
- No construir meta-plataforma multi-tenant.
- No procesar tarjetas ni guardar datos sensibles de pago.
- No migrar a microservicios.
- No depender de Sebas para operación diaria.

## 2. Requisitos

### Funcionales
- RF-01: el cliente puede ver catálogo, promos, horarios, métodos de pago y release windows vigentes.
- RF-02: cliente puede crear pedido programado o inmediato con validaciones actuales.
- RF-03: operador/admin puede gestionar catálogo, combos, promos, pedidos, stock, delivery, uploads, usuarios y métricas.
- RF-04: el negocio puede operar sin intervención del desarrollador para el flujo normal.
- RF-05: el sistema puede restaurarse ante pérdida del servidor.

### No funcionales
- RNF-01 Disponibilidad práctica: servicio accesible 24/7 con auto-restart.
- RNF-02 Persistencia: SQLite y uploads deben sobrevivir reinicios/redeploys.
- RNF-03 Backup: RPO objetivo ≤ 24h; RTO objetivo ≤ 60 min con runbook.
- RNF-04 Seguridad: TLS, rate limiting, auth scrypt+JWT, mínimos permisos, backups cifrados.
- RNF-05 Costo: mantenerse dentro de free tiers razonables.
- RNF-06 Datos: minimizar PII; pagos siguen siendo manuales/off-platform.

## 3. Restricciones y hechos verificados

- App actual: `mymochis` v2.0.0, Express, SQLite `node:sqlite`, frontend estático, auth propia scrypt+JWT.
- Persistencia actual README asume Render disk; Render pricing muestra compute free pero **persistent disks `$0.25/GB/mo`**, por lo que no es la mejor opción "gratis con persistencia".
- Oracle Cloud Always Free incluye cómputo VM Ampere A1 Flex hasta 2 OCPUs/12GB RAM, 200GB block volume total y 10TB egress/mes.
- Cloudflare R2 free tier: 10GB-mes storage Standard, 1M Class A ops/mes, 10M Class B ops/mes, egress free.
- Cloudflare D1 free tier: 5M rows read/day, 100k rows write/day, 5GB storage; viable solo si se migra la app a Workers/D1.

## 4. Opciones evaluadas

| Opción | Persistencia | Cambio de código | Costo objetivo | Riesgo | Veredicto |
|---|---|---|---|---|---|
| Render free + disk | SQLite same | Nulo | Disk pago | Bajo esfuerzo, costo pequeño | **Descartada para "gratis estricto"** |
| Fly.io | Necesita volume pago | Nulo | No tiene free tier nuevo | Serverless-like pero no gratis | **Descartada** |
| Cloudflare Pages/Workers + D1/R2 | D1/R2 | Alto | $0 hasta límites | Migración Express/SQLite→Workers/D1 | **Opción futura si se quiere cero servidor** |
| Oracle Cloud Always Free VM | Block volume local | Nulo/bajo | $0 Always Free | Capacidad/región/ocio puede reclamar instancias idle | **Recomendada ahora** |

## 5. Arquitectura recomendada

### 5.1 Vista lógica

```text
Cliente (browser)
  │ HTTPS
  ▼
Dominio propio o sslip/nip temporal
  │ DNS
  ▼
Cloudflare DNS (proxy opcional)
  │
  ▼
OCI Always Free VM (Ubuntu + Docker)
  ├─ Caddy (80/443, TLS automático)
  ├─ MyMochis app (Node/Express, container)
  │   ├─ /api/public, /api/orders, ... rutas actuales
  │   └─ SQLite file + uploads en volumen persistente
  └─ Backup job (cron/contenedor sidecar)
      ├─ SQLite online backup / VACUUM INTO
      ├─ tar uploads
      ├─ age encrypt
      └─ upload a Cloudflare R2 bucket privado

Backups
  ├─ R2 cifrado (fuera de OCI)
  └─ OCI block volume backups (máx 5 Always Free), si se habilitan
```

### 5.2 Vista de despliegue

```text
OCI Home Region
  VCN
    Subnet pública
      VM.Standard.A1.Flex Always Free
        - Ubuntu LTS
        - Docker Engine + docker compose plugin
        - ufw: permite solo 22, 80, 443
        - ssh solo por key
        - systemd: docker compose up -d --restart unless-stopped

/data/mymochis/
  mymochis.db
  uploads/
  backups-tmp/
/opt/mymochis/
  docker-compose.yml
  Caddyfile
  .env.production  (600, fuera de repo)
  backup-mymochis.sh
  restore-mymochis.md
```

## 6. Componentes

| Componente | Responsabilidad | Decisión |
|---|---|---|
| Frontend estático | Landing + dashboard operador | Se mantiene `public/` actual |
| API Express | Reglas de negocio actuales | Se mantiene `server.js` + `src/routes/*` |
| SQLite local | Datos del negocio/clientes | Se mantiene `node:sqlite`; archivo en volumen persistente |
| Uploads | Imágenes/videos productos | Carpeta local persistente; backup cifrado |
| Caddy | HTTPS, cabeceras de proxy, compresión | Reemplaza exponer Node directo a Internet |
| Cloudflare DNS | DNS + proxy opcional | Gratis; mejora TLS/DDoS básico |
| R2 | Backup externo cifrado | Free tier suficiente para este volumen |
| OCI Vol backups | Copia rápida del volumen | Complementario; no reemplaza backup lógico |

## 7. Seguridad y protección de datos

### Clasificación de datos
| Dato | Sensibilidad | Control |
|---|---|---|
| Email/password admin y usuarios | alta | scrypt + salt; nunca logs; env secret fuera del repo |
| Cliente nombre/teléfono/dirección | PII media | acceso solo autenticado para administración; TLS; backups cifrados |
| Órdenes/notas | PII media + negocio | auth admin para consulta; retention policy |
| Imágenes productos | baja/media | uploads validados por tipo/tamaño; servir con cache y nosniff |
| Pagos | fuera de alcance | no almacenar tarjetas; comprobantes solo por WhatsApp/manual |

### Controles mínimos antes de producción
1. **Fail-fast secrets**: quitar defaults inseguros; si falta `NEXOMOCHIS_JWT_SECRET`, la app no arranca.
2. **CORS cerrado**: `NEXOMOCHIS_CORS=https://dominio-del-negocio`.
3. **JWT TTL reducido**: bajar de 7 días a 12h o 24h para admin; refresh manual por login.
4. **Admin seed seguro**: `ADMIN_PASSWORD` generado, primer login obliga cambio manual documentado; `ADMIN_PASSWORD_RESET` solo durante rotación y luego se elimina.
5. **Subir duración de lockout auth** si el negocio recibe fuerza bruta; mantener rate limits.
6. **Logs sin PII**: confirmar que no se loguean bodies ni passwords; revisar antes de habilitar logs persistentes.
7. **Permisos filesystem**: DB y env con `0600`; uploads con permisos mínimos.
8. **Backups cifrados**: clave privada offline (age o GPG); repo solo con public key/config.
9. **Formulario público anti-abuso**: evaluar Cloudflare Turnstile si aparece spam de pedidos.
10. **Privacidad básica**: publicar aviso de datos personales en landing (nombre, WhatsApp, dirección para delivery, finalidad, contacto para modificación/eliminación).

## 8. Backup y disaster recovery

- **RPO**: 24h mediante backup diario cifrado a R2.
- **RTO**: 60 min con runbook probado.
- **Estrategia**: 3-2-1 simplificado:
  - 1 copia primaria: volumen OCI.
  - 1 copia lógica cifrada: R2.
  - 1 copia infraestructural opcional: OCI block volume backup (max 5 Always Free).

### Retención recomendada R2
- 7 diarios
- 4 semanales
- 6 mensuales

### Prueba obligatoria
Una vez al mes: restaurar backup en VM local o VM temporal y abrir `/manage.html` + revisar pedidos recientes.

## 9. Observabilidad mínima sin cargar operación

- `GET /api/health` ya existe; usarlo para uptime externo.
- Docker restart policy `unless-stopped`.
- Logs de aplicación: journald/docker logs, retención corta.
- Alerta simple por correo/Telegram/WhatsApp manual si uptime externo falla.
- Revisar semanalmente backups recientes en R2 con un checklist de 5 minutos.

## 10. Docker/Compose blueprint

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3737
      - NEXOMOCHIS_DB_PATH=/var/data/mymochis.db
      - NEXOMOCHIS_UPLOAD_DIR=/var/data/uploads
      - NEXOMOCHIS_CORS=${PUBLIC_ORIGIN}
      - NEXOMOCHIS_JWT_SECRET=${NEXOMOCHIS_JWT_SECRET}
    volumes:
      - mysqldata:/var/data
    expose:
      - "3737"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

volumes:
  mysqldata:
  caddy_data:
  caddy_config:
```

`Caddyfile` mínimo:

```caddy
{$DOMAIN} {
  encode zstd gzip
  reverse_proxy app:3737
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
}
```

## 11. Plan de despliegue

### Fase 0 — freeze de alcance
- Confirmar que `mymochis-studio` queda fuera del camino crítico.
- Confirmar negocio: dominio, email/teléfono admin, política de datos y backups.

### Fase 1 — hardening mínimo del código
- Quitar fallback `dev-secret` de JWT.
- Agregar `.env.production.example` completo.
- Opcional: exigir cambio de contraseña documentado tras primer login.
- Opcional: restringir vistas internas a admin donde aplique (`include_all`, `include_inactive`).
- Smoke tests locales y revisión rápida de logs sin PII.

### Fase 2 — infraestructura
- Crear cuenta OCI y VM A1 Always Free.
- Configurar DNS en Cloudflare; usar dominio propio recomendado. Si se exige costo cero absoluto, iniciar con `sslip.io`/`nip.io` y migrar a dominio propio después.
- Docker + compose + Caddy.
- Crear bucket R2 privado + token permisos mínimos.

### Fase 3 — deploy
- Primer arranque, seed admin, prueba login, cambio de clave.
- Smoke E2E: health, catálogo, crear pedido programado, crear pedido inmediato si aplica, dashboard, upload imagen.
- Verificar TLS/CSP/HSTS.

### Fase 4 — backup/recovery
- Instalar job diario SQLite backup + uploads tar + encrypt + upload.
- Hacer restore drill en local.
- Guardar runbook impreso/exportado para el negocio.

### Fase 5 — handoff autónomo
- Crear cuenta admin del amigo y retirar/rotar credenciales de Sebas.
- Entregar guía operativa corta: "si falla", "cómo recuperar pedidos", "a quién contactar".
- Programar recordatorio mensual de prueba de backup.

## 12. Criterios de aceptación

- [ ] La app opera el negocio actual sin MyMochis Studio.
- [ ] SQLite y uploads persistentes en volumen.
- [ ] HTTPS válido con renovación automática.
- [ ] Backups diarios cifrados restaurables.
- [ ] Auth admin endurecida y sin defaults de producción.
- [ ] El amigo puede operar catálogo/pedidos sin hablar con Sebas.
- [ ] Gasto mensual objetivo: `$0`, salvo dominio propio opcional.

## 13. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| OCI reclama instancia idle Always Free | Caída del servicio | tráfico real + uptime monitor + restore runbook |
| Capacidad Always Free no disponible en home region | No se puede crear VM | reintentar AD/region permitido; plan B Render disk pago o VPS barato |
| Backup corrupto | Pérdida de datos | backup lógico SQLite `.backup`/`VACUUM INTO` + restore drill mensual |
| Credenciales admin expuestas | Toma de control | rotación, mínimo privilegio, logs, 2FA futuro |
| PII de clientes filtrada | Riesgo legal/reputacional | minimizar campos, TLS, backups cifrados, aviso de privacidad |
| Ataques al formulario de pedidos | Spam/fraude | rate limit + Turnstile opcional + validaciones actuales |

## 14. Camino futuro opcional (si cambia el negocio)

Si el negocio crece y se necesita "cero servidor" o varios negocios independientes:
- Migrar SQLite→D1/Postgres y Express→Workers o mantener Node en VPS pago.
- Añadir pagos online hosted (Wompi/MercadoPago) sin guardar PAN.
- Añadir 2FA y auditoría detallada de cambios admin.
- No reabrir SaaS multi-tenant salvo que el modelo de negocio cambie a producto para muchos negocios.

## 15. Conclusión

La arquitectura correcta para el objetivo es **single-tenant autónomo**, no SaaS multi-tenant. La ruta más barata y menos intrusiva es:

**Oracle Cloud Always Free VM + Caddy + Docker + SQLite persistente + uploads persistentes + backups cifrados a Cloudflare R2.**

Esto conserva las características actuales, protege datos del negocio/clientes y permite desligar la operación diaria de Sebas.

## 16. Estado de implementación — 2026-10-08

Implementación inicial completada en repo:

- `Dockerfile`: build Node 24 Alpine, sin devDependencies, usuario `node`, healthcheck `/api/health`.
- `Caddyfile`: TLS automático con `DOMAIN` + `LETSENCRYPT_EMAIL`.
- `docker-compose.yml`: servicios `app` + `caddy`, volumen persistente `mymochis_data:/var/data`.
- `.env.production.example`: variables requeridas para producción/backups.
- `scripts/backup-sqlite.mjs`: backup consistente de SQLite con `VACUUM INTO`.
- `scripts/backup-mymochis.sh`: empaqueta DB + uploads, cifra con `age`, sube a R2 (`daily/weekly/monthly`).
- `scripts/restore-mymochis.sh`: restaura desde backup cifrado local/R2 con confirmación explícita (`CONFIRM_RESTORE=yes`).
- `scripts/stack-smoke.sh`: smoke mínimo de `/api/health`, `/api/public`, `/manage.html`.
- Hardening aplicado: producción falla si falta `NEXOMOCHIS_JWT_SECRET`; TTL JWT configurable por `NEXOMOCHIS_JWT_TTL_SECONDS` y acortado por defecto a 12h en producción.

Despliegue en VM Oracle Always Free:

```bash
cp .env.production.example .env.production
nano .env.production
docker compose --env-file .env.production up -d --build
bash scripts/stack-smoke.sh "https://$DOMAIN"
```

Cron de backups diarios:

```cron
17 4 * * * cd /opt/mymochis && /usr/bin/env bash scripts/backup-mymochis.sh >> /var/log/mymochis-backup.log 2>&1
```

Restore manual:

```bash
CONFIRM_RESTORE=yes bash scripts/restore-mymochis.sh "r2:mymochis-backups/mymochis/daily/mymochis-YYYYMMDDTHHMMSSZ.tar.age"
```

Verificación local ejecutada: `npm test` → 7/7 tests passing.

## 17. Verificación MVP E2E — 2026-10-09

Smoke E2E funcional sobre el server Node (mismo código que el contenedor Docker): **13/13 PASS**.

- `GET /api/health` ✓
- `GET /api/public` ✓ (config, categories, flavors, combos, promos, payment_methods, delivery_schedule, delivery_config, release_windows)
- Login admin sembrado por env ✓ (`ADMIN_EMAIL`/`ADMIN_PASSWORD` en `src/db.js`)
- Flujo operador: crear sabor ✓ + abrir release window ✓
- Flujo cliente: `POST /api/orders` pedido programado ✓ (valida schedule por día + cutoff + ventana `open` + stock). Ver §23 sobre la zona horaria del cutoff, que hoy tiene un bug abierto.
- Stock decrementa `units_sold` tras pedido ✓
- Gestión admin: `GET /api/orders` ✓, `GET /api/metrics` ✓
- Estáticos: landing `/` ✓, dashboard `/manage.html` ✓
- RBAC: `/api/metrics` sin token → 401 ✓
- Regla de negocio confirmada: pickup_day en domingo → `no_pickup_schedule` (schedule Lun–Sáb, correcto).
- Payload de pedidos: `items` es **objeto** `{ flavor_id: qty }` (no array).

Los pedidos del cliente final entran por **WhatsApp** (link directo en la landing, diseño intencional); el endpoint público `/api/orders` queda habilitado y validado para uso futuro.

Adicionalmente en este cierre:
- Aviso de datos personales publicado en el footer de la landing (control §7.10): nombre, WhatsApp, dirección de entrega, finalidad y canal de modificación/eliminación.
- `render.yaml` eliminado (Render descartado en §4).
- Docker no disponible en la máquina de desarrollo: el build de imagen se valida en la VM (Fase 3).

## 18. Único pendiente para producción

Fases 2–5 del §11 requieren recursos del operador. Todo el paquete de
deploy ya está en repo y el MVP está verificado; la puesta en producción
sigue este runbook actualizado 2026-10-11:

### 18.1 Preflight (idempotente)

Antes de tocar OCI, validar localmente que todos los prerequisitos están
en su lugar. **No modifica nada del host, solo reporta gaps.**

```bash
bash scripts/preflight-oci.sh
```

El script verifica los 4 bloqueos del operador + artefactos locales:

| Bloqueo | Verifica |
|---------|----------|
| OCI CLI autenticado | `oci iam user get --self` |
| Dominio DNS | `dig +short $DOMAIN A` resuelve IP |
| R2 bucket + API keys | vars `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` presentes |
| SSH key pair | `~/.ssh/id_ed25519_oci{.pub}` existen |

Si exit code != 0: leer la lista de gaps y resolver antes de continuar.

### 18.2 Secuencia del operador

Una vez preflight en verde:

1. **Crear VM Oracle A1 Flex** (Ubuntu 22.04 LTS) + abrir 22/80/443 en
   security list. Mantener la VM en `Always Free-eligible` region
   (ej. us-ashburn-1, eu-frankfurt-1).
2. **Apuntar DNS**: en Cloudflare (o proveedor del dominio), crear
   registro A `mymochis.tudominio.com` → IP pública de la VM. Proxy
   activado (orange cloud) para TLS + DDoS básico.
3. **Subir SSH pubkey**: en OCI Compute → Instances → Create →
   Paste SSH keys. Usar el contenido de `~/.ssh/id_ed25519_oci.pub`.
4. **Clonar repo + configurar**:
   ```bash
   ssh ubuntu@$VM_IP
   git clone https://github.com/Nxxo31/mymochis.git
   cd mymochis
   cp .env.production.example .env.production
   # Rellenar: NEXOMOCHIS_JWT_SECRET, ADMIN_PASSWORD, DOMAIN,
   # LETSENCRYPT_EMAIL, R2_*, AGE_*
   ```
   Generar secrets:
   - `NEXOMOCHIS_JWT_SECRET`: `openssl rand -hex 32`
   - `ADMIN_PASSWORD`: `openssl rand -base64 24`
   - `AGE_RECIPIENT`: `age-keygen -o ~/age_key.txt && cat ~/age_key.txt`
     (la pública es el recipient; guardar la privada offline)
5. **Levantar stack**:
   ```bash
   docker compose --env-file .env.production up -d
   bash scripts/stack-smoke.sh        # valida /api/health + /api/public
   ```
6. **Habilitar backups**:
   ```bash
   # Crear systemd timer para backup-mymochis.sh (3 AM UTC diario)
   sudo cp deploy/backup-mymochis.service /etc/systemd/system/
   sudo cp deploy/backup-mymochis.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now backup-mymochis.timer
   sudo systemctl list-timers backup-mymochis
   ```
7. **DNS verification final**:
   ```bash
   curl -sI https://$DOMAIN/api/health | head -1
   # Esperar: HTTP/2 200
   ```

### 18.3 Lo que NO requiere acción del operador

- Dockerfile, docker-compose.yml, Caddyfile: ya en repo y validados.
- backup-mymochis.sh: idempotente, valida env vars al inicio.
- restore-mymochis.sh: idempotente, requiere `CONFIRM_RESTORE=yes`.
- stack-smoke.sh: 13+ smoke tests pre-deploy.
- preflight-oci.sh: añadido 2026-10-11 (commit b91d24c) — ejecutable
  ANTES de la secuencia para detectar gaps temprano.

Refs: memo #178 (mymochis MVP cerrado), memo #188 P0, commit b91d24c.

## 19. Histórico de preflight (archivado 2026-10-11) up -d --build`.
4. `bash scripts/stack-smoke.sh "https://$DOMAIN"`.
5. Seed admin, login, cambio de clave (`ADMIN_PASSWORD_RESET=true` y retirar).
6. Cron backup diario (§16) + restore drill.
7. Handoff: crear cuenta admin del operador del negocio y rotar la de Sebas.

## 19. Cheatsheet del operador para producción (no técnico)

Estado código: 100% listo y verificado (commit `8729c4f` 2026-10-09 + E2E 13/13 PASS, memo #178). Deploy pendiente solo de cuentas tuyas + 7 acciones de ~1 hora total. Refiere a §18 para los pasos técnicos.

### Recursos que necesitas conseguir

| # | Recurso | Costo | Dónde | Tiempo |
|---|---|---|---|---|
| 1 | Cuenta Oracle Cloud Free Tier | $0 | https://cloud.oracle.com/free | 10 min (sign-up + verificación tarjeta — NO cobran, es anti-fraude) |
| 2 | Dominio propio | ~$10/año | Namecheap o Cloudflare Registrar | 5 min |
| 3 | Cuenta Cloudflare (DNS gratis + R2) | $0 | https://dash.cloudflare.com/sign-up | 2 min |
| 4 | Bucket R2 + token escritura | $0 (free 10GB) | Cloudflare → R2 → Create + API token | 5 min |
| 5 | Llave pública `age` (cifra backups) | $0 | La genero yo y te la paso | 1 min |

WSP Business queda fuera del MVP inicial: los pedidos se siguen haciendo por WSP personal manual (tu preferencia confirmada 2026-09-29). Si querés WSP Business auto, son 30+ días adicionales de Meta approval — el deploy igual funciona, solo el canal auto queda pendiente.

### El día del deploy (yo corro los 7 pasos de §18, vos accedés 3 veces)

**Bloque 1 — Vos creás los recursos (~1h una sola sesión)**
- Oracle Cloud → Create VM → Ubuntu 22.04 → shape `VM.Standard.A1.Flex` 1 OCPU/1GB (free tier) → subís tu SSH key → abris puertos 22/80/443.
- Comprás dominio y lo apuntás a los nameservers de Cloudflare (te paso los NS exactos).
- En Cloudflare: DNS → A record a la IP pública de la VM + bucket R2 + API token con scope Object Storage Write.

**Bloque 2 — Pasamos credenciales (5 min)**
- Me das por chat: `ORACLE_VM_IP`, `DOMAIN`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `AGE_PUBLIC_KEY`.
- Yo las guardo cifradas en Windows Credential Manager (dark-memory keyring). No tocan tu repo.
- Yo corro los 7 pasos del §18 y dejo `https://$DOMAIN` operativo.

**Bloque 3 — Verificación (30 min)**
- Smoke E2E: home 200, catálogo público 200, login admin, crear pedido, ver métricas admin.
- Crear cuenta para el operador del negocio y rotar mi acceso.

### Decisiones que necesito antes de empezar

| Pregunta | Default si no contestás |
|---|---|
| ¿Qué dominio? (ej: `mymochis.app`, `mimochis.co`, `mochis.lat`) | Te propongo 3 cuando digas GO |
| ¿Tamaño VM Oracle? (1 OCPU/1GB vs 2/12GB) | 1 OCPU/1GB (sobra para MVP) |
| ¿Backups automáticos desde día 1? | Después de validar 1 semana |
| ¿HTTPS con Caddy automático u otro CA? | Caddy (ya en `docker-compose.yml`) |
| ¿WSP auto o personal manual? | Personal manual (preferencia confirmada) |

### Riesgos (transparente)

1. **Oracle A1 reclamation**: si CPU <10% por días puede reclamar la VM y avisa 48h antes. Mitigación: el MVP tiene tráfico real, no va a estar ocioso.
2. **R2 free 10GB**: alcanza para catálogo. Si crece a miles de productos, plan paid (~$0.015/GB-mes).
3. **DNS propagation**: 5-30 min global en primer apuntado. No bloquea, solo el operador del negocio entra después de propagar.
4. **Costo sorpresa**: ninguno esperado. Si ves algo raro en Oracle a 30 días, bajamos el shape.

### Comando para arrancar

Cuando tengas los 4 recursos del Bloque 1, mandame: **"GO deploy MyMochis"** + la info, y arrancamos el mismo día.

## 20. Multi-número, multi-admin y dispatch WhatsApp — 2026-10-17

Fecha: 2026-10-17. Estado: **implementado, testeado (11/11) y verificado E2E en vivo**.
Refs: skill `whatsapp-order-dispatch` (canon del patrón), commit de esta sesión.

### Flujo del pedido (nuevo)

1. El cliente arma el pedido (landing modal o tienda).
2. `POST /api/orders` valida horario/cutoff/stock, persiste en SQLite **y** arma el
   dispatch: elige el destinatario con **round-robin** (`recipients[orderCount % n]`
   sobre los activos, `ORDER BY sort_order, id`) y responde
   `{ whatsapp: { deep_link, primary_phone, primary_label, recipients_count, cloud_status, cloud_results } }`.
3. El cliente abre el `deep_link` (`api.whatsapp.com/send/`, NUNCA `wa.me`): su
   WhatsApp abre con el mensaje pre-llenado dirigido al admin elegido.
4. Si `WHATSAPP_CLOUD_TOKEN` + `WHATSAPP_CLOUD_PHONE_ID` están configurados, el
   server ADEMÁS envía el pedido por Meta Cloud API a TODOS los números activos
   (`sent`/`partial`/`failed`/`skipped`). Sin credenciales → `skipped`, el pedido
   nunca falla por el canal.

**Unidad de dinero en TODA la app: pesos COP.** Los `*_cents` históricos son
pesos (flavor.price 8000 = $8.000). NUNCA dividir total entre 100.

### Multi-número (`order_recipients`)

- Tabla `(label, phone UNIQUE, active, sort_order)`; seed inicial importa
  `config.whatsapp_number` si no hay destinatarios y no es el placeholder.
- CRUD admin-only en `POST/GET/PATCH/DELETE /api/recipients` (8–15 dígitos,
  normaliza no-dígitos, rechaza duplicados). UI: sección **Números de pedido**
  del panel (agregar / pausar / eliminar).
- Respaldo legacy: pool vacío → usa `config.whatsapp_number` (sin placeholder).

### Multi-admin

- `POST /api/users` (solo admin) crea cuentas `admin|customer`. UI: sección
  **Usuarios** del panel. El register público sigue forzando `role=customer`.
- **Se eliminó el demote global de init()** (antes: cualquier admin distinto de
  admin@mymochis.app volvía a customer en cada boot — mataba multi-admin).
- Borrar admins por API sigue bloqueado a propósito; un admin de más se limpia
  directo en SQLite.

### Mensaje WhatsApp (single source of truth en `src/lib/whatsapp.js`)

- Lo arma el SERVER con: # de pedido (cruce con dashboard), ventana de horario
  real del día (`delivery_schedule`), subtotales por sabor/combo en pesos,
  notas, y aviso de que quedó registrado en el panel.
- La landing ya no arma mensaje propio: hace `await POST /api/orders` y abre el
  `deep_link` de la respuesta. Fallback con mensaje local SOLO si la API falla.

### Bugs corregidos en esta pasada (encontrados por QA)

1. `tienda.html` `#cartSheet` inexistente → `init()` crasheaba y **la tienda
   nunca cargaba catálogo**. Fix: `#cartSheetBack`.
2. Precios 100× mal: `tienda.html` y el mensaje WSP dividían entre 100 ($8.500
   → "$85"); también el chart del panel. Fix: formatear pesos directo.
3. `wa.me` corrompe emojis 4-byte en su redirect (🍡→U+FFFD); verificado
   empíricamente. Fix: `api.whatsapp.com/send/` en todos los links del repo.
4. Pedidos de la landing enviaban `pickup_day: "Martes"` → 400 silencioso →
   **ningún pedido de la landing llegaba al dashboard**. Fix: conversión al
   próximo `YYYY-MM-DD` real + await del POST.
5. sw.js cache `mochis-land-v8` (renovar precache de index/manage).

### Tests

`npm test` → 11/11: los 7 originales + recipients CRUD/RBAC, multi-admin
sobrevive reinicio, flujo pedido→dashboard→round-robin→mensaje, y pausa de
número. Paridad completa en `worker/` (D1): tabla, ruta, dispatch y users.

## 21. Sistema visual v3 — Color + Motion + Shaders

Fecha: 2026-10-19. Estado: **implementado (2026-10-23) — ver §25**: build Vite +
isla React con shader aurora WebGL nativo (sin three/R3F: el chunk pesaba 817 kB
para un plano de 40 líneas; el contexto WebGL directo lo hace en <6 kB) y motion
para la entrada del contenido. R3F quedó descartado por peso. Refs: context7 motion@^12.

### 21.1 Contexto y decisiones arquitectónicas

**Hallazgo de marca** (scrape IG `@my.mochiss`, 2026-10-19): la marca real es
**"Mochi's Land"** (no "MyMochis" en la marca visible) y su paleta actual ya es
azul cielo (#3B9BE0) + indigo CTA (#4F5BD5) + mochi cartoon (rosa/marrón/beige).
El pedido del operador (azul/blanco/gris + rosado claro) es una **refinación
hacia más neutral**, no un rebrand. Tokens derivados del logo + observación.

**Decisión arquitectónica (recomendada):** patrón **React island** vía build
step con Vite, replicando el patrón validado en NX-Studio v0.8.0 (memo #243).
- Razón: `motion@^12` y `@react-three/fiber` son React-first. Vanilla Motion
  existe pero limita a `animate()` sobre el DOM; no soporta `useAnimate` con
  variantes compuestas ni integración limpia con R3F.
- Costo: 1-2 días de setup (Vite + punto de entrada + script tag en HTML).
- Reversibilidad: el `public/` vanilla existente queda intacto; la isla es
  un `<div id="hero-island">` que monta React. Si falla, el fallback es HTML
  estático sin animación.
- Alternativas consideradas:
  - **B) Motion vanilla + CSS shaders**: cero build, drop-in. Sin R3F.
  - **C) Híbrido vanilla + Canvas2D raw**: bundle mínimo, animaciones ricas
    pero shader custom manual.
  - **A) React island (recomendada)**: validación previa en NX-Studio.

**Stack additions (`package.json` devDependencies):**
- `vite@^5` (build step)
- `react@^18.3`, `react-dom@^18.3`
- `motion@^12` (antes `framer-motion`; v12 lo renombró)
- `three@^0.169`, `@react-three/fiber@^8`, `@react-three/drei@^9`
- `@vitejs/plugin-react@^4`

**Bundle strategy:** isla única en landing (`#hero-island`), una en cada
sección crítica (galería IG, menu). Resto de `public/*.html` queda vanilla
HTML+JS. Esto mantiene la app <100KB de JS por página fuera de la landing.

### 21.2 Color tokens (light + dark)

**Light theme** (default, derivado del IG brand):
```css
:root {
  /* Brand */
  --brand-blue-600: #2D6CDF;   /* CTA principal (derivado del IG logo) */
  --brand-blue-500: #4F8AE8;
  --brand-blue-400: #7BA8F0;
  --brand-blue-100: #EAF1FC;   /* tint surface */
  --brand-blue-50:  #F5F8FE;

  /* Accent (rosado claro, derivado del mochi cartoon) */
  --accent-pink-300: #FFD6E0;  /* chip de sabor, hover sutil */
  --accent-pink-400: #F8B4C8;  /* borde hover de cards */
  --accent-pink-600: #E91E63;  /* SOLO urgency (badges, errores), NUNCA base */

  /* Neutrales (gris) */
  --neutral-0:   #FFFFFF;
  --neutral-50:  #F8FAFC;
  --neutral-100: #F1F5F9;
  --neutral-200: #E2E8F0;
  --neutral-300: #CBD5E1;
  --neutral-500: #64748B;
  --neutral-700: #334155;
  --neutral-900: #0F172A;

  /* Semantic (semánticos sobre los raw) */
  --bg-surface:        var(--neutral-0);
  --bg-elevated:       var(--neutral-50);
  --bg-tint:           var(--brand-blue-50);
  --text-primary:      var(--neutral-900);
  --text-secondary:    var(--neutral-700);
  --text-muted:        var(--neutral-500);
  --text-inverse:      var(--neutral-0);
  --border-default:    var(--neutral-200);
  --border-strong:     var(--neutral-300);
  --action-primary:    var(--brand-blue-600);
  --action-primary-hover: var(--brand-blue-500);
  --focus-ring:        var(--brand-blue-400);

  /* Status */
  --success: #10B981;
  --warning: #F59E0B;
  --danger:  #EF4444;
}

[data-theme="dark"] {
  --bg-surface:        #0B1220;          /* navy muy oscuro */
  --bg-elevated:       #111A2E;
  --bg-tint:           #1A2547;
  --text-primary:      #F1F5F9;
  --text-secondary:    #CBD5E1;
  --text-muted:        #94A3B8;
  --border-default:    #1E293B;
  --border-strong:     #334155;
  --action-primary:    #7BA8F0;          /* blue-400 para contraste AAA en dark */
  --accent-pink-300:   #4A2030;          /* pink muted para dark */
  --accent-pink-400:   #6B2D40;
  /* neutros y status idénticos (escala universal) */
}
```

**Reglas de uso:**
- **NUNCA** usar `--accent-pink-600` en UI base. Solo badges de "última
  unidad" / "oferta termina hoy" / "error".
- **NUNCA** mezclar blue-500 (CTA) con blue-400 (focus ring) en el mismo
  elemento; el focus ring debe ser más claro, nunca más oscuro.
- En dark mode, `--bg-elevated` es para cards/popovers; nunca invertir
  `--bg-surface` (queda como el "lienzo" más oscuro).
- Tokens semánticos (`--action-primary`, `--text-primary`) sobre los raw
  (`--brand-blue-600`). Los componentes consumen los semánticos; los
  raw son para variantes específicas (e.g. gradient `from-blue-600 to-blue-400`).

### 21.3 Typography

Mantener stack actual (system font + display). Cambio mínimo:
```css
--font-display: 'Inter', system-ui, -apple-system, sans-serif;
--font-body:    'Inter', system-ui, -apple-system, sans-serif;
--font-mono:    'JetBrains Mono', ui-monospace, monospace;
--fs-xs:  0.75rem;  /* 12px - meta */
--fs-sm:  0.875rem; /* 14px - body small */
--fs-md:  1rem;     /* 16px - body */
--fs-lg:  1.125rem; /* 18px - body large */
--fs-xl:  1.25rem;  /* 20px - h4 */
--fs-2xl: 1.5rem;   /* 24px - h3 */
--fs-3xl: 1.875rem; /* 30px - h2 */
--fs-4xl: 2.25rem;  /* 36px - h1 */
--fs-5xl: 3rem;     /* 48px - hero */
--fw-regular:  400;
--fw-medium:   500;
--fw-semibold: 600;
--fw-bold:     700;
--lh-tight:    1.2;
--lh-snug:     1.375;
--lh-normal:   1.5;
--lh-relaxed:  1.625;
```

### 21.4 Spacing, radius, shadows, motion

```css
--space-0: 0;
--space-1: 0.25rem;  /* 4 */
--space-2: 0.5rem;   /* 8 */
--space-3: 0.75rem;  /* 12 */
--space-4: 1rem;     /* 16 */
--space-5: 1.25rem;  /* 20 */
--space-6: 1.5rem;   /* 24 */
--space-8: 2rem;     /* 32 */
--space-10: 2.5rem;  /* 40 */
--space-12: 3rem;    /* 48 */
--space-16: 4rem;    /* 64 */

--radius-sm:   6px;  /* chips, inputs */
--radius-md:  10px;  /* buttons, cards */
--radius-lg:  16px;  /* modals */
--radius-xl:  24px;  /* hero shapes */
--radius-pill: 9999px;

--shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
--shadow-md: 0 4px 12px rgba(15, 23, 42, 0.08);
--shadow-lg: 0 12px 32px rgba(15, 23, 42, 0.12);
--shadow-glow: 0 0 24px rgba(45, 108, 223, 0.25);
```

### 21.5 Motion system (durations, easings, semantic tokens)

```ts
// src/lib/motion-tokens.ts (isla)
export const duration = {
  instant: 0.1,
  fast:    0.2,
  base:    0.3,
  slow:    0.5,
  page:    0.6,
} as const;

export const easing = {
  // CSS-equivalente de cubic-bezier(0.22, 1, 0.36, 1) — "out-expo"
  out:    [0.22, 1, 0.36, 1] as const,
  // cubic-bezier(0.64, 0, 0.35, 1) — "in-out"
  inOut:  [0.64, 0, 0.35, 1] as const,
  // cubic-bezier(0.16, 1, 0.3, 1) — "out-quart" (más dramático)
  bounce: [0.16, 1, 0.3, 1] as const,
  // CSS linear (reservado para shaders y loaders)
  linear: 'linear' as const,
};

export const semantic = {
  hoverLift: { y: -4, scale: 1.02, transition: { duration: duration.fast, ease: easing.out } },
  tapPress:  { scale: 0.98, transition: { duration: duration.instant } },
  fadeIn:    { opacity: [0, 1], transition: { duration: duration.base, ease: easing.out } },
  slideUp:   { y: [16, 0], opacity: [0, 1], transition: { duration: duration.slow, ease: easing.bounce } },
} as const;
```

**Regla de oro:** nunca duración > 0.6s en UI. Shaders y loaders pueden ir a
1-2s. Page transitions máximo 0.6s (percepción de respuesta).

### 21.6 Animation primitives (variants library)

```ts
// src/lib/variants.ts (isla)
import { Variants } from 'motion/react';
import { duration, easing } from './motion-tokens';

export const stagger = (delay = 0.08, initial = 0.05): Variants => ({
  hidden: {},
  visible: {
    transition: { delayChildren: initial, staggerChildren: delay },
  },
});

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1, y: 0,
    transition: { duration: duration.slow, ease: easing.bounce },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: easing.out } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: duration.base, ease: easing.out } },
};

// Card hover (componer con whileHover en motion.div)
export const cardHover = {
  whileHover: { y: -4, scale: 1.02, transition: { duration: duration.fast, ease: easing.out } },
  whileTap:   { scale: 0.98 },
};
```

**Patrón canónico (replicado de NX-Studio v0.8.0):**
```tsx
import { motion, useReducedMotion } from 'motion/react';
import { stagger, fadeUp, cardHover } from '../lib/variants';

export function AnimatedHero({ title, subtitle, cta }: HeroProps) {
  const reduce = useReducedMotion();
  const v = reduce ? fadeIn : stagger();

  return (
    <motion.div initial="hidden" animate="visible" variants={v}>
      <motion.h1 variants={fadeUp}>{title}</motion.h1>
      <motion.p variants={fadeUp}>{subtitle}</motion.p>
      <motion.button variants={fadeUp} {...cardHover}>{cta}</motion.button>
    </motion.div>
  );
}
```

### 21.7 Shader system (R3F island, hero background)

**Componente `<HeroBackground>` (R3F shader plane):**
```tsx
// src/islands/HeroBackground.tsx
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { useRef, useMemo } from 'react';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';

const AuroraMaterial = shaderMaterial(
  { uTime: 0, uMouse: new THREE.Vector2(0, 0), uColorA: '#2D6CDF', uColorB: '#FFD6E0' },
  /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform vec2  uMouse;
    uniform vec3  uColorA;
    uniform vec3  uColorB;
    varying vec2 vUv;

    // 2D simplex noise (Ashima Arts)
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
    float snoise(vec2 v){
      const vec4 C=vec4(0.211324865405187,0.366025403784439,
                       -0.577350269189626,0.024390243902439);
      vec2 i=floor(v+dot(v,C.yy));
      vec2 x0=v-i+dot(i,C.xx);
      vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
      vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
      i=mod289(i);
      vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))
                    +i.x+vec3(0.0,i1.x,1.0));
      vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),
                           dot(x12.zw,x12.zw)),0.0);
      m=m*m; m=m*m;
      vec3 x=2.0*fract(p*C.www)-1.0;
      vec3 h=abs(x)-0.5;
      vec3 ox=floor(x+0.5);
      vec3 a0=x-ox;
      m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
      vec3 g;
      g.x=a0.x*x0.x+h.x*x0.y;
      g.yz=a0.yz*x12.xz+h.yz*x12.yw;
      return 130.0*dot(m,g);
    }

    void main() {
      vec2 uv = vUv;
      vec2 m = (uMouse - 0.5) * 0.15;
      float t = uTime * 0.15;

      // Dos octavas de noise para aurora suave
      float n1 = snoise(uv * 2.0 + vec2(t, t * 0.7) + m);
      float n2 = snoise(uv * 4.0 - vec2(t * 0.5, t) + m * 0.5);
      float n  = 0.6 * n1 + 0.4 * n2;

      // Mezcla blue ↔ pink soft según noise
      vec3 col = mix(uColorA, uColorB, smoothstep(-0.4, 0.4, n));

      // Vignette sutil para no distraer
      float d = distance(uv, vec2(0.5));
      col *= 1.0 - d * 0.4;

      gl_FragColor = vec4(col, 0.55);  // alpha 0.55 para blend con contenido
    }
  `
);
extend({ AuroraMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements { auroraMaterial: any }
}

function AuroraPlane() {
  const ref = useRef<any>(null);
  const { size } = useThree();
  useFrame(({ clock, pointer }) => {
    if (ref.current) {
      ref.current.uniforms.uTime.value = clock.elapsedTime;
      ref.current.uniforms.uMouse.value = pointer;
    }
  });
  return (
    <mesh scale={[size.width, size.height, 1]}>
      <planeGeometry args={[1, 1]} />
      <auroraMaterial ref={ref} transparent />
    </mesh>
  );
}

export function HeroBackground() {
  return (
    <div className="hero-bg" aria-hidden>
      <Canvas
        dpr={[1, 1.6]}                // cap en mobile
        gl={{ antialias: false, powerPreference: 'low-power' }}
        camera={{ position: [0, 0, 1] }}
      >
        <AuroraPlane />
      </Canvas>
    </div>
  );
}
```

**Reglas del shader:**
- `dpr={[1, 1.6]}` para no quemar GPU en mobile.
- `pointer` lo da R3F; sin listener manual.
- `transparent` + `alpha=0.55` para que el contenido del hero sea legible encima.
- Render condicional con `useReducedMotion()`: si true → fallback a gradient
  CSS estático, sin Canvas.
- Lazy mount con `client:visible` o `IntersectionObserver` para no pagar el
  shader en el primer paint.

### 21.8 Component patterns

**`motion.*` everywhere hay animación.** Reglas:
- Botones: `whileHover={{ y: -1 }}` + `whileTap={{ scale: 0.98 }}`.
- Cards: `variants={fadeUp}` + `whileHover={{ y: -4, scale: 1.02 }}`.
- Modal/sheet: `AnimatePresence` + `initial={{ opacity: 0, y: 8 }}` +
  `exit={{ opacity: 0, y: 8 }}`.
- Page transitions: NO en MyMochis (single-page flow), pero dejar el patrón
  listo por si se suma multipágina.

**`AnimateActivity` para listas (disponible en motion v12):**
```tsx
import { motion, AnimateActivity } from 'motion/react';

<AnimateActivity mode="popLayout">
  {items.map(item => (
    <motion.div
      key={item.id}
      layout
      variants={fadeUp}
      exit={{ opacity: 0, scale: 0.95 }}
    >
      <Card {...item} />
    </motion.div>
  ))}
</AnimateActivity>
```

### 21.9 Build pipeline (Vite)

**Estructura de directorios nueva:**
```
mymochis/
├── public/                     # (existente, intacto)
│   ├── index.html              # + <script type="module" src="/landing-island.js"></script>
│   ├── tienda.html             # + idem
│   ├── manage.html             # + idem
│   └── ...
├── src/                        # (existente, intacto)
│   ├── routes/
│   ├── lib/
│   ├── db.js
│   └── server.js
├── web/                        # NUEVO — entry points Vite
│   ├── landing/
│   │   ├── main.tsx            # <AnimatedHero> + <HeroBackground>
│   │   ├── AnimatedHero.tsx
│   │   ├── HeroBackground.tsx  # R3F
│   │   ├── MenuGrid.tsx        # cards de sabores
│   │   └── variants.ts         # re-export
│   ├── tienda/
│   │   ├── main.tsx            # (futuro) carrito animado
│   │   └── ...
│   ├── manage/                 # (futuro) panel con transiciones
│   ├── styles/
│   │   ├── tokens.css          # vars del §21.2-21.4
│   │   └── islands.css         # estilos solo de las islas
│   └── lib/
│       ├── motion-tokens.ts
│       └── variants.ts
├── vite.config.ts              # NUEVO — multi-entry
├── tsconfig.json               # NUEVO
└── package.json                # + scripts: "dev:web", "build:web"
```

**`vite.config.ts` (multi-entry, output a `public/build/`):**
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'public/build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'web/landing/main.tsx'),
        tienda:  resolve(__dirname, 'web/tienda/main.tsx'),
        // manage: resolve(__dirname, 'web/manage/main.tsx'),  // cuando exista
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3737' } },
});
```

**`package.json` scripts nuevos:**
```json
{
  "dev:web":  "vite",
  "build:web": "vite build",
  "build:web:watch": "vite build --watch"
}
```

**Import en HTML (sin hash para cachear manual):**
```html
<!-- public/index.html, dentro de <head> o antes de </body> -->
<script type="module" src="/build/landing.js"></script>
```

### 21.10 a11y (no negociable)

- **`useReducedMotion()` siempre presente** en componentes animados. Si true,
  `variants` se reduce a `fadeIn` puro (sin translate, sin scale).
- `prefers-reduced-motion` en CSS también como red de seguridad:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
- Contraste mínimo AA (4.5:1 texto, 3:1 UI). Validar con axe-core en CI.
- Focus visible: outline 2px `--focus-ring` + offset 2px, NUNCA `outline: none`
  sin reemplazo.
- `<Canvas>` de R3F lleva `aria-hidden="true"`; el contenido textual del hero
  está fuera del Canvas.
- Shaders no llevan información; son decorativos. No requieren alt-text.

### 21.11 Migración desde el sistema actual

**Plan por olas (zero-downtime, todos reversibles):**

**Ola 1 — Tokens** (1-2h):
1. Crear `web/styles/tokens.css` con §21.2-21.4.
2. Importar en `public/index.html` ANTES de cualquier otro CSS.
3. Mapeo de las vars existentes del proyecto a los nuevos tokens semánticos.
4. Build del sitio estático NO cambia; solo cambia la paleta.
5. QA visual: dark mode toggle (`localStorage nx-theme` + `<meta name="color-scheme">`).

**Ola 2 — Build pipeline** (½ día):
1. Crear `vite.config.ts` + `tsconfig.json` + `package.json` scripts.
2. Mover entry point mínimo (`web/landing/main.tsx` con un `motion.div` "Hello").
3. Importar en `public/index.html` como `<script type="module" src="/build/landing.js">`.
4. Verificar que el sitio sigue funcionando CON y SIN el script (degradación
   graciosa: si el bundle falla, el HTML estático sigue).
5. npm scripts: `npm run build:web` antes de `docker build` (en el Dockerfile
   de deploy, agregar `RUN npm run build:web`).

**Ola 3 — Isla Hero** (1 día):
1. Implementar `<AnimatedHero>` con `useAnimate` + `stagger` + `fadeUp`.
2. Implementar `<HeroBackground>` con el shader aurora.
3. Mover el HTML actual del hero a un `<div id="hero-island">` que monta React.
4. QA cross-browser: Chrome, Firefox, Safari, mobile (Safari iOS especialmente
   — WebGL ahí es más restrictivo).
5. Test de performance: Lighthouse mobile, FCP < 1.8s, TTI < 3.5s.

**Ola 4 — Resto de islas** (opcional, +1 día):
- `<MenuGrid>` con cards animadas.
- `<GalleryIG>` con masonry + hover.
- `<TiendaCarrito>` con sheet animado.

**Rollback:** borrar `web/`, restaurar `public/index.html`. La paleta CSS
también se puede revertir comentando el `<link>` de tokens.

### 21.12 Open questions (para el operador)

1. **¿Lanzar la Ola 1 (solo tokens) YA sin build step?** Es la más barata y
   ya mejora el sitio. Sin React, sin shader, sin build. Solo CSS vars.
2. **¿Dark mode desde el día 1 o solo light?** El operador usa el sitio
   mayormente de día; dark mode podría ser nice-to-have.
3. **¿Shader en todas las páginas o solo landing?** Spec actual: solo landing.
   Si se quiere en tienda, +1 ola.
4. **¿Migra a Astro en lugar de Vite + HTML?** Astro sería más limpio (file-
   based routing) pero es un cambio mayor. Lo dejo fuera de scope.

## 22. Backend de pagos digitales v1 — spec

Fecha: 2026-10-19. Estado: **implementado — el camino automático funciona end-to-end (ver §24); faltan credenciales Nequi reales y UI de checkout**. Refs:
artículos de sistema de pagos (idempotency, webhooks, ledger, outbox, sagas,
reconciliation), docs Nequi API, Daviplata botón, Bancolombia API Market,
Mercado Pago, NIIO aggregator. Patrón canónico del dev.to / singhajit.

### 22.1 Contexto y objetivos

MyMochis hoy recibe pedidos y el cliente paga **off-platform** (transferencia
manual a Nequi/Daviplata/Bancolombia/efectivo). Esto requiere confirmar
manualmente cada pago. El operador quiere digitalizar el cierre del pedido:
que el cliente pague desde la app y el sistema reconcilie automáticamente.

**Objetivo:** backend que orqueste cobros a Nequi, Daviplata, Bancolombia
QR, Mercado Pago y (futuro) WhatsApp Pay, con reconciliación diaria, ledger
double-entry, idempotencia duradera, y webhook handlers autenticados.

**Casos de uso primarios:**
- **C1**: cliente confirma pedido → app genera link de pago Nequi push → cliente
  autoriza en su app Nequi → webhook confirma → pedido pasa a "paid".
- **C2**: cliente paga con Daviplata desde el dashboard → DaviPlata notifica
  al backend vía webhook → pedido se reconcilia.
- **C3**: cliente paga con tarjeta vía Mercado Pago Checkout Pro → MP webhook
  notifica → pedido se reconcilia.
- **C4**: cliente transfiere manual a Bancolombia (no API) → operador sube
  comprobante + sistema hace match con el pedido.
- **C5 (futuro)**: cliente paga vía WhatsApp Pay desde el deep-link.

### 22.2 No-objetivos (explícitos)

- **NO** guardar datos de tarjeta crudos (PCI scope reduction). Tokens via
  MP Checkout Pro o tokenización de Nequi cuando exista.
- **NO** hacer settlement / payouts / acquirer. Cada provider paga al
  operador por su lado; nosotros solo confirmamos "el cliente pagó".
- **NO** subscriptions / recurring billing. Solo one-time.
- **NO** FX / multi-currency. Solo COP.
- **NO** fraud scoring ML. Solo reglas (monto máximo, IP rate limit, etc.).

### 22.3 Arquitectura general

```
Cliente (web/wsp)
  │
  ▼
[MyMochis app — Express]
  │
  ├─ /api/payments (crear intent, idempotency-key)
  │    │
  │    ▼
  │  [Payment Service]  ← state machine
  │    │
  │    ├─ → [Provider Adapter Nequi]  → API Nequi (push)
  │    ├─ → [Provider Adapter Daviplata] → API DaviPlata
  │    ├─ → [Provider Adapter MercadoPago] → API MP
  │    └─ → [Provider Adapter Bancolombia] → API Market
  │
  ├─ /api/webhooks/{provider}  ← POST firmado por cada provider
  │    │
  │    ▼
  │  [Webhook Handler]  (verify signature → durable inbox → enqueue)
  │    │
  │    ▼
  │  [Outbox Worker]  (relay eventos a consumers)
  │    │
  │    ▼
  │  Consumers: orders, notifications, ledger-poster
  │
  └─ /api/admin/reconcile  ← cron diario, operador manual trigger
       │
       ▼
     [Reconciliation Job]  (ledger vs provider reports)
```

### 22.4 State machine

```
INITIATED ─→ PROCESSING ─→ SUCCEEDED
    │            │              │
    │            ├─→ FAILED    │
    │            │              │
    │            ├─→ REQUIRES_ACTION (cliente debe hacer algo en su app)
    │            │              │
    │            └─→ UNRESOLVED  (timeout, red cayó — requiere reconcile)
    │
    └─→ EXPIRED  (45min sin acción, según Nequi)
```

**Reglas de transición (con optimistic locking):**
```sql
UPDATE payments
SET state = :next, state_version = state_version + 1, updated_at = :now
WHERE payment_id = :id
  AND state = :expected_state
  AND state_version = :expected_version;
-- Si 0 filas: otro proceso ya cambió el estado; recargar y evaluar.
```

**Estados terminales:** SUCCEEDED, FAILED, EXPIRED.
**Estados que pueden transicionar a SUCCEEDED:** PROCESSING, REQUIRES_ACTION,
UNRESOLVED (vía reconcile), y INITIATED (solo si el provider respondió
sincrónicamente con success — raro pero posible en algunos flows).

### 22.5 DB schema (SQLite, compatible con D1)

```sql
-- ===========================================================================
-- 1. payments (la "operación" lógica: pagar pedido X por Y pesos)
-- ===========================================================================
CREATE TABLE payments (
  payment_id        TEXT PRIMARY KEY,                  -- "pay_<uuidv7>"
  merchant_id       TEXT NOT NULL DEFAULT 'mymochis',  -- futuro: multi-merchant
  order_id          TEXT NOT NULL,                     -- FK a orders.id
  amount_minor      INTEGER NOT NULL,                  -- pesos * 100 (COP × 100 = centavos)
  currency          TEXT NOT NULL DEFAULT 'COP',
  state             TEXT NOT NULL DEFAULT 'INITIATED', -- enum
  state_version     INTEGER NOT NULL DEFAULT 0,        -- optimistic lock
  customer_phone    TEXT,                              -- para Nequi push
  customer_email    TEXT,
  description       TEXT,
  metadata_json     TEXT,                              -- provider-specific extras
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT,                              -- INITIATED/REQUIRES_ACTION timeout
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_state ON payments(state, created_at);

-- ===========================================================================
-- 2. idempotency_records (UNIQUE por merchant+operation+key)
-- ===========================================================================
CREATE TABLE idempotency_records (
  merchant_id         TEXT NOT NULL,
  operation           TEXT NOT NULL,         -- "create_payment", "refund"
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,         -- sha256 del body canonical
  payment_id          TEXT,                  -- FK si aplicó
  response_status     INTEGER,               -- status HTTP cacheado
  response_body_json  TEXT,                  -- body cacheado
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  PRIMARY KEY (merchant_id, operation, idempotency_key)
);

-- ===========================================================================
-- 3. payment_attempts (cada interacción con un provider)
-- ===========================================================================
CREATE TABLE payment_attempts (
  attempt_id            TEXT PRIMARY KEY,                -- "att_<uuidv7>"
  payment_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,                   -- 'nequi' | 'daviplata' | 'mercadopago' | 'bancolombia'
  provider_idempotency_key TEXT NOT NULL,                -- la que el provider recordará
  provider_reference     TEXT,                           -- txn_id / payment_id del provider
  attempt_state          TEXT NOT NULL,                  -- mismo enum que payments.state
  provider_response_json TEXT,                           -- último response del provider
  error_code             TEXT,
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE CASCADE
);
CREATE INDEX idx_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX idx_attempts_provider_ref ON payment_attempts(provider, provider_reference);

-- ===========================================================================
-- 4. provider_events (durable inbox para webhooks)
-- ===========================================================================
CREATE TABLE provider_events (
  event_id            TEXT PRIMARY KEY,                -- "evt_<uuidv7>"
  provider            TEXT NOT NULL,
  provider_event_id   TEXT,                            -- id del evento en el provider
  payload_json        TEXT NOT NULL,
  signature           TEXT,                            -- header de firma
  received_at         TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at        TEXT,
  process_status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processed' | 'failed' | 'quarantined'
  process_attempts    INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  UNIQUE (provider, provider_event_id)                 -- dedupe de entregas duplicadas
);
CREATE INDEX idx_events_pending ON provider_events(process_status, received_at);

-- ===========================================================================
-- 5. ledger_entries (double-entry journal, append-only)
-- ===========================================================================
CREATE TABLE ledger_entries (
  entry_id        TEXT PRIMARY KEY,                    -- "led_<uuidv7>"
  payment_id      TEXT NOT NULL,
  account         TEXT NOT NULL,                       -- 'customer_cash' | 'merchant_receivable' | 'provider_fee' | 'refund_clearing'
  amount_minor    INTEGER NOT NULL,                    -- signed: + debit, - credit (o convención que elijas)
  currency        TEXT NOT NULL DEFAULT 'COP',
  memo            TEXT,
  posted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE RESTRICT
);
CREATE INDEX idx_ledger_payment ON ledger_entries(payment_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account, posted_at);

-- View: balance por cuenta (para reconciliation rápida)
CREATE VIEW ledger_balances AS
SELECT account, currency, SUM(amount_minor) AS balance_minor
FROM ledger_entries
GROUP BY account, currency;

-- ===========================================================================
-- 6. outbox_events (transactional outbox)
-- ===========================================================================
CREATE TABLE outbox_events (
  event_id        TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,                       -- 'payment' | 'order'
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,                       -- 'payment.succeeded' | 'payment.failed' | etc.
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  published_at    TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_pending ON outbox_events(published_at, created_at);

-- ===========================================================================
-- 7. reconciliation_runs (audit trail del reconciler)
-- ===========================================================================
CREATE TABLE reconciliation_runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  provider          TEXT,                              -- NULL = todos
  status            TEXT NOT NULL DEFAULT 'running',   -- 'running' | 'ok' | 'mismatch' | 'failed'
  checks_total      INTEGER NOT NULL DEFAULT 0,
  mismatches        INTEGER NOT NULL DEFAULT 0,
  details_json      TEXT                               -- array de mismatches
);

-- ===========================================================================
-- 8. payment_methods (extender la config existente)
-- ===========================================================================
ALTER TABLE payment_methods ADD COLUMN provider TEXT;   -- 'nequi' | 'daviplata' | etc.
ALTER TABLE payment_methods ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payment_methods ADD COLUMN credentials_ref TEXT;  -- keyring key, NUNCA el secreto

-- ===========================================================================
-- 9. Extender orders para enlazar al payment
-- ===========================================================================
ALTER TABLE orders ADD COLUMN payment_id TEXT REFERENCES payments(payment_id);
ALTER TABLE orders ADD COLUMN payment_state TEXT;        -- duplicado denormalizado para queries rápidos
```

### 22.6 Idempotency model

**Reglas (dev.to / singhajit):**
1. **Clave durable** en `idempotency_records` con UNIQUE por
   `(merchant_id, operation, idempotency_key)`.
2. **Request fingerprint**: SHA-256 del body canonical. Si misma key con
   fingerprint distinto → 409 Conflict (es OTRO request, no retry).
3. **In-progress behavior**: si el original está corriendo, devolver
   `202 Accepted` con `state=PROCESSING` y el `payment_id`. El cliente puede
   hacer poll a `GET /api/payments/{id}`.
4. **Provider-side idempotency**: cada attempt lleva `provider_idempotency_key`
   (re-uso del mismo si se reintenta el mismo attempt lógico).
5. **TTL**: el idempotency record NO expira (es durable). El response cacheado
   se mantiene por 24h mínimo para retries de cliente.

**Flujo de POST /api/payments con idempotency:**
```
1. INSERT INTO idempotency_records (merchant, op, key, fingerprint) — atómico.
   Si UNIQUE violation: recargar el record existente.
2. Comparar fingerprint del nuevo request con el stored.
   - Match + completed_at NOT NULL → devolver el response cacheado.
   - Match + completed_at NULL → 202 con el payment_id en PROCESSING.
   - Mismatch → 409 Conflict.
3. Crear payment (state=INITIATED).
4. Actualizar idempotency_records con payment_id.
5. Llamar provider adapter.
6. Actualizar attempt + state.
7. INSERT outbox_events si terminal.
8. UPDATE idempotency_records SET completed_at=now, response_status, response_body.
9. Devolver response.
```

### 22.7 Outbox pattern

**Por qué:** no podemos hacer `UPDATE payments + PUBLISH payment.succeeded`
atómicamente. Si la app crashea entre ambas, el evento se pierde.

**Tabla `outbox_events` (ver §22.5.6) + relay:**

```ts
// worker/outbox-relay.mjs (corre como sidecar / cron)
const pending = db.prepare(`
  SELECT * FROM outbox_events
  WHERE published_at IS NULL
  ORDER BY created_at ASC
  LIMIT 50
`).all();

for (const evt of pending) {
  try {
    // 1. Publicar a consumers (in-process: notifications, orders; externo: cola)
    await dispatch(evt);
    // 2. Marcar como publicado
    db.prepare(`UPDATE outbox_events SET published_at = :now, publish_attempts = publish_attempts + 1 WHERE event_id = :id`)
      .run({ now: new Date().toISOString(), id: evt.event_id });
  } catch (e) {
    db.prepare(`UPDATE outbox_events SET publish_attempts = publish_attempts + 1 WHERE event_id = :id`).run({ id: evt.event_id });
    // Si supera N intentos → DLQ (outbox_dead_letters)
  }
}
```

**At-least-once:** el relay puede publicar el mismo evento 2 veces si crashea
post-ack pre-mark. Por eso cada consumer debe ser idempotente (e.g. orders
puede aplicar el `payment.succeeded` con un guard `state_version`).

### 22.8 Webhook handler contract

**Endpoint:** `POST /api/webhooks/{provider}` (uno por provider).

**Reglas del handler (dev.to §7):**
1. **Verificar firma** contra los bytes exactos del request. NUNCA confiar
   en el JSON parseado. Para Nequi/Daviplata/MP/Bancolombia cada uno tiene
   su mecanismo (HMAC SHA-256 típicamente, con timestamp para replay
   protection).
2. **Insertar en `provider_events`** con el `provider_event_id` extraído.
   Dedupe vía UNIQUE constraint.
3. **Ack inmediatamente** (HTTP 200) según el contrato del provider. NO
   procesar síncronamente.
4. **Worker async** toma el evento, lo aplica al payment (con guard
   `state_version`), postea al ledger, escribe al outbox.

**Ejemplo (Mercado Pago):**
```ts
// src/routes/webhooks-mercadopago.js
router.post('/api/webhooks/mercadopago', async (req, res) => {
  // 1. Verify signature
  const sig = req.headers['x-signature']; // ts=...,v1=...
  if (!verifyMpSignature(req.rawBody, sig, MP_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  // 2. Durable inbox
  const eventId = req.body.data?.id ?? req.body.id;
  try {
    db.prepare(`INSERT INTO provider_events (event_id, provider, provider_event_id, payload_json, signature) VALUES (?, 'mercadopago', ?, ?, ?)`)
      .run(`evt_${randomUUID()}`, eventId, JSON.stringify(req.body), sig);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(200).json({ ok: true, deduped: true });
    }
    throw e;
  }
  // 3. Ack inmediato
  res.status(200).json({ ok: true });
  // 4. Worker procesa async (no en este handler)
});
```

**Worker async:**
```ts
// worker/process-events.mjs
const events = db.prepare(`SELECT * FROM provider_events WHERE process_status = 'pending' ORDER BY received_at ASC LIMIT 50`).all();
for (const evt of events) {
  try {
    await applyProviderEvent(evt);
    db.prepare(`UPDATE provider_events SET process_status = 'processed', processed_at = :now WHERE event_id = :id`)
      .run({ now: new Date().toISOString(), id: evt.event_id });
  } catch (e) {
    db.prepare(`UPDATE provider_events SET process_status = :s, process_attempts = process_attempts + 1, last_error = :e WHERE event_id = :id`)
      .run({ s: e.retriable ? 'pending' : 'quarantined', e: String(e), id: evt.event_id });
  }
}
```

### 22.9 Provider adapter interface

```ts
// src/lib/payments/adapter.js
export interface PaymentAdapter {
  readonly providerId: string;        // 'nequi' | 'daviplata' | 'mercadopago' | 'bancolombia'
  createPaymentIntent(input: CreateInput): Promise<CreateOutput>;
  getPaymentStatus(providerRef: string): Promise<ProviderStatus>;
  refund(providerRef: string, amountMinor: number): Promise<RefundOutput>;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;
}

export interface CreateInput {
  paymentId: string;                  // nuestro ID
  amountMinor: number;                // COP × 100
  currency: 'COP';
  description: string;
  customerPhone?: string;             // requerido para Nequi push
  customerEmail?: string;
  metadata?: Record<string, string>;
  expiresAt?: string;                 // ISO8601
}

export interface CreateOutput {
  providerReference: string;          // txn_id del provider
  providerResponse: Record<string, any>;
  // Estado inmediato (algunos providers devuelven SUCCEEDED aquí)
  immediateState?: 'PROCESSING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED';
  // Para flows donde el cliente debe hacer algo en su app
  deepLink?: string;                  // 'nequi://...'
  qrCode?: string;                    // base64 PNG
  instructions?: string;              // texto para mostrar en UI
}
```

**Adapter concreto (ejemplo Nequi):**
```js
// src/lib/payments/adapters/nequi.js
import { PaymentAdapter } from '../adapter.js';
import { signNequiRequest } from './nequi-sign.js';

export class NequiAdapter extends PaymentAdapter {
  providerId = 'nequi';

  async createPaymentIntent({ paymentId, amountMinor, customerPhone, description }) {
    if (!customerPhone) throw new Error('Nequi requires customerPhone');
    const body = {
      phoneNumber: customerPhone,
      value: amountMinor / 100,         // Nequi espera pesos, NO centavos
      reference1: paymentId,            // nuestro ID (reconciliation)
      reference2: description?.slice(0, 40) ?? '',
    };
    const res = await this.post('/payments/v2/-services-paymentservice-generatecodeqr', body, {
      'X-Api-Key': NEQUI_API_KEY,
      'X-Request-Id': paymentId,        // idempotency-key del provider
    });
    return {
      providerReference: res.transactionId,
      providerResponse: res,
      immediateState: 'REQUIRES_ACTION', // cliente debe aprobar en su app
      deepLink: `nequi://payment?token=${res.paymentId}`,
      qrCode: res.qrImage,
      instructions: 'Abrí tu app Nequi y aprobá el pago.',
    };
  }

  verifyWebhookSignature(rawBody, headers) {
    return verifyHmacSha256(rawBody, headers['x-signature'], NEQUI_WEBHOOK_SECRET);
  }
}
```

### 22.10 API endpoints (REST, Express)

```
POST   /api/payments                 Crea un intent. Idempotency-Key requerido.
GET    /api/payments/:id             Estado actual del payment.
GET    /api/payments                 Lista pagos (admin). ?state= ?order_id= ?from= ?to=
POST   /api/payments/:id/cancel      Cancela antes de SUCCEEDED.
POST   /api/payments/:id/refund      Reembolso (admin, post-SUCCEEDED).
GET    /api/payments/:id/attempts    Historial de attempts.

POST   /api/webhooks/nequi           (no auth — verified por signature)
POST   /api/webhooks/daviplata
POST   /api/webhooks/mercadopago
POST   /api/webhooks/bancolombia

POST   /api/admin/payments/reconcile           Trigger manual del reconciler.
GET    /api/admin/payments/reconcile/runs      Historial de runs.
GET    /api/admin/payments/mismatches          Lista de mismatches abiertos.

GET    /api/admin/ledger                       (opcional) Visualización del ledger.
```

**Request/response canónico (POST /api/payments):**
```json
// Request
{
  "order_id": "MYM-MVCXSPB7",
  "amount_minor": 2500000,            // $25.000 COP
  "currency": "COP",
  "provider": "nequi",                 // opcional: si null, devolver opciones
  "customer_phone": "+573213050426",
  "description": "Combo 6 unidades",
  "metadata": { "release_window_id": "1" }
}
// Headers
Idempotency-Key: "checkout-MYM-MVCXSPB7-v1"

// Response 201
{
  "payment_id": "pay_01HXY...",
  "state": "REQUIRES_ACTION",
  "provider": "nequi",
  "provider_reference": "NEQ-TXN-12345",
  "whatsapp": { "deep_link": "nequi://...", "qr_code": "data:image/png;base64,..." },
  "instructions": "Abrí tu app Nequi y aprobá el pago.",
  "expires_at": "2026-10-19T18:00:00Z"
}
```

### 22.11 Reconciliation cron

**Cuándo correr:** diario 04:00 COL (después del cierre de batches bancarios
típicamente). Manual trigger desde `/api/admin/payments/reconcile`.

**Estrategia de 2 capas:**

**Capa 1 — Operational reconciliation (cada 5 min, solo UNRESOLVED):**
```sql
SELECT * FROM payments
WHERE state IN ('PROCESSING', 'UNRESOLVED')
  AND updated_at < datetime('now', '-2 minutes');
```
Para cada uno, llamar `adapter.getPaymentStatus(providerRef)` y aplicar
state transition.

**Capa 2 — Financial reconciliation (diaria, full sweep):**
1. Por cada provider, descargar el report del día anterior (API o CSV).
2. Comparar cada `provider_reference` del report con `payment_attempts` local.
3. Detectar:
   - **Missing webhooks**: provider reporta SUCCEEDED, local sigue PROCESSING →
     aplicar transición + postear ledger.
   - **Phantom payments**: provider NO reporta nada, local dice SUCCEEDED →
     INVESTIGAR (no auto-flip; posible bug).
   - **Amount mismatch**: provider dice X, local dice Y → quarantine.
4. Reporte en `reconciliation_runs` con array de mismatches.

**Mismatches que NO se auto-resuelven** (siempre requieren operador):
- Phantom payments (local dice SUCCEEDED, provider no encuentra).
- Amount mismatch.
- Refunds no reflejados.

**Mismatches que SÍ se auto-resuelven** (con log):
- Missing webhooks (provider confirma SUCCEEDED, local rezagado) → aplicar
  transición con nota `reconciled_at`.

### 22.12 Provider-specific notes

**Nequi (`/payments/v2/-services-paymentservice-generatecodeqr`):**
- API push: el cliente recibe notificación en su app Nequi.
- Espera `customer_phone`. Si no, solo QR.
- Webhook firma: HMAC-SHA256 sobre body con `X-Nequi-Signature` header.
- Timeout: 45 minutos (configurable).
- Sandbox: requiere onboarding con Nequi (no público; tramitamos).
- Documentación: https://www.nequi.com.co/negocios/apis

**Daviplata (Botón DaviPlata):**
- SDK embebible o redirect.
- `payment_id` interno nuestro, `reference` para reconciliation.
- Webhook: IP whitelist + token compartido.
- Sandbox: disponible en https://conectesunegocio.daviplata.com/

**Bancolombia API Market:**
- Para QR de Bancolombia: `api-rest-qr-payment/v1/qr` genera QR, webhook
  notifica pago.
- Sandbox: https://api-portal-external.apps.bancolombia.com/ (free, requiere
  signup).
- **Importante**: actualmente la app muestra Bancolombia como transferencia
  MANUAL. Migrar a QR + webhook es ola 2.

**Mercado Pago Checkout Pro:**
- SDK completa, sandbox generoso.
- Webhook: `merchant_order` o `payment` topics; firmar con `x-signature`.
- Tokenización fuera de PCI scope (Checkout Pro hosted).
- Documentación: https://www.mercadopago.com.co/developers/en/reference

**WhatsApp Pay (futuro):**
- Requiere Meta Business verification (30+ días).
- Spec adelantada, NO implementar hasta approval.

**NIIO aggregator (opcional):**
- 1 sola integración para PSE, Nequi, Daviplata, Bancolombia, cards, crypto.
- Fee por transacción.
- Trade-off: vendor lock-in vs simplicidad.
- Documentación: https://pay.niiopay.com/docs

### 22.13 Money handling

- **TODO en pesos × 100 = centavos (integer)**, NUNCA float.
- Schema: `INTEGER` (en SQLite, 8 bytes safe hasta ~9.2 × 10^18).
- COP no tiene sub-centavo; redondear al entero.
- Display: helper `formatCOP(minor) → '$25.000'` (sin decimales).
- Regla operativa: NUNCA `parseFloat` ni `Number()` en dinero. Solo
  `Math.trunc` y operaciones con integers.

### 22.14 Security y PCI scope

- **Card data**: NUNCA tocan nuestro backend. Siempre Checkout Pro (MP) o
  redirect a provider (Nequi, Daviplata). PCI scope = SAQ-A (mínimo).
- **Secrets**: `NEQUI_API_KEY`, `MP_ACCESS_TOKEN`, `BANCO_WEBHOOK_SECRET`
  viven en dark-memory keyring / Windows Credential Manager. NUNCA en
  archivos del repo. Solo la REFERENCIA (`credentials_ref`) en DB.
- **Webhooks**: signature verify obligatorio. Reject 401 si falla.
- **Idempotency keys**: scope per-merchant (default `mymochis`).
- **RBAC**: solo admin puede `GET /api/admin/payments/*`, `POST /refund`,
  `POST /reconcile`. Customer solo ve sus propios payments.
- **Audit log**: `reconciliation_runs` + `provider_events` ya son audit trail.
  Sumar `audit_log` table para acciones admin (refunds, manual override).

### 22.15 Migración desde el sistema actual

**Ola 0 — Schema (sin tocar UI, ~1h):**
1. Correr migrations de §22.5 sobre DB local.
2. Migrar `payment_methods` para sumar `provider` y `enabled`.
3. Verificar que `npm test` sigue 11/11 (no debe romperse).

**Ola 1 — Adapter Nequi + endpoint POST /api/payments (1-2 días):**
1. Implementar `NequiAdapter` con sandbox (credenciales de Nequi business).
2. Crear ruta `POST /api/payments` con idempotency.
3. Crear handler `POST /api/webhooks/nequi` con signature verify.
4. Tests: 8 nuevos (idempotency, state machine, signature, outbox).
5. QA manual en sandbox: crear payment, simular webhook, ver SUCCEEDED.

**Ola 2 — Outbox + workers (1 día):**
1. Implementar `outbox-relay` y `process-events` workers.
2. Decidir: ¿cron cada 30s, o `setInterval` in-process?
   Recomendación: in-process setInterval (Express app), con restart
   recovery del sweep.
3. Test: simular crash entre INSERT outbox y PUBLISH → recover on next sweep.

**Ola 3 — Reconciler (1 día):**
1. Operational reconciliation cada 5 min (in-process setInterval).
2. Financial reconciliation diario 04:00 COL (in-process timer).
3. UI admin: `/admin/reconcile.html` con botón "Run now" + lista de runs.

**Ola 4 — Daviplata + Mercado Pago (2-3 días):**
1. Repetir el patrón de Nequi para los 2 providers.
2. UI de selección de método al confirmar pedido.

**Ola 5 — Bancolombia QR (1 día):**
1. Migrar la opción "Bancolombia" de manual-transfer a QR + webhook.
2. UI: mostrar QR generado, esperar webhook, mostrar "¡Listo!".

**Rollback:** las migrations son `CREATE TABLE` / `ALTER TABLE ADD COLUMN`,
ambas reversibles. `DROP TABLE` no se necesita; en el peor caso borrar las
tablas nuevas.

### 22.16 Open questions (para el operador)

1. **¿Nequi sandbox account existe ya?** Si no, ¿la tramitamos nosotros
   (necesita RUT/NIT del negocio del amigo) o lo hace el operador?
2. **¿MP sandbox token está disponible?** (gratis en MP developers).
3. **¿NIIO aggregator o integración directa por provider?** Trade-off:
   simplicidad (NIIO) vs lock-in + fee (NIIO) vs control (directo).
4. **¿Auto-cobro al confirmar pedido o step manual del operador?** Hoy el
   operador confirma cada pedido. Spec asume auto-cobro al confirmar.
5. **¿Límite de monto por transacción?** (recomendación: 5M COP / attempt).
6. **¿Refunds desde el panel admin?** Spec dice sí, pero requiere
   implementación de `POST /api/payments/:id/refund` por provider.
7. **¿WhatsApp Pay cuándo?** NO para v1, esperar Meta approval.

### 22.17 Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Nequi webhook se pierde | Pedido queda PROCESSING forever | Reconciler capa 1 cada 5min |
| Provider downtime | Pagos fallan | Mostrar "sistema caído, intenta más tarde"; reconciler recover |
| Customer paga pero webhook nunca llega + reconciler tampoco | Pedido sin cerrar | UI: "si pagaste y no se reflejó, escribinos por WSP"; operador tiene vista admin para manual flip |
| Idempotency key mal generado por bug del cliente | Duplicados o "lost" payments | Validar fingerprint; 409 explícito si mismatch |
| Outbox relay duplica eventos | Orders procesados 2 veces | Consumer-side idempotencia con `state_version` |
| DB corruption en SQLite | Ledger pierde entries | Backup R2 cada 24h (§8 ya documentado) + verify en startup |
| PCI scope creep si guardamos tarjeta | Auditoría, multas | Test E2E obligatorio: ningún endpoint acepta card data |

---

## 23. Fecha de recogida: el cutoff manda, no el calendario — 2026-10-21

Regla: **el cliente nunca ofrece una fecha que el backend va a rechazar.** El
`<select>` de "Día de recogida" se puebla desde lo que el server declara
aceptable, no desde una aproximación del calendario del cliente.

### 23.1 Por qué el flag lo calcula el server

`GET /api/public` publica por cada release_window:

| Campo | Significado |
|---|---|
| `orderable` | `status === 'open'` **Y** el cutoff no ha vencido. Es lo que el cliente puede ofrecer. |
| `not_orderable_reason` | `window_not_open` · `past_cutoff` · `no_pickup_schedule` |
| `cutoff_computed_at` | El instante del cutoff, para depurar sin leer código. |

El cálculo vive en `pickupCutoffFor()` (`src/routes/orders.js`), que es la
**misma función** que usa `validateScheduled()` para rechazar el pedido. Una
sola copia de la regla. Cuando existieron dos —el server rejecting y el front
calculando por su cuenta— divergieron, y esa divergencia era el bug: el
cliente ofrecía una fecha, el usuario llenaba el formulario entero y recibía un
`400 past_cutoff` sin explicación útil.

**No reimplementar la regla del cutoff en el front.** Si el server no manda el
flag, el cliente cae a `status + fecha` solo para no quedar inservible.

### 23.2 Orden de inicialización (bug que se llevó 4 días sin commitear)

`configureDateInput()` se llamaba **antes** del `fetch` del catálogo, así que
`catalog` era `undefined` y el `<select>` se renderizaba siempre deshabilitado
con "Sin días abiertos por ahora". La tienda no aceptaba ningún pedido. Todo
setup derivado de datos traídos por fetch va **debajo** de la asignación,
junto a los demás `render()`.

### 23.3 BUG ABIERTO — el cutoff corre 5 horas adelantado (t_f6d7dd48)

`combineDateAndTime()` construye el cutoff con `Date.UTC(y, m, d, hh, mm)`, o
sea interpreta `"15:00"` como **15:00 UTC**. El negocio opera en Colombia
(UTC−5):

```
Negocio cree:   pickup 15:00 local → cutoff 07:00 local
Código computa: 15:00 UTC − 8h     = 07:00 UTC = 02:00 local
                                        ↑ 5 horas antes
```

Los pedidos se cerraron a las **2:00 AM** cuando el dueño pensaba que cerrarían a
las 7:00 AM. No se arregló porque altera *cuándo vende el negocio*, que es
decisión del operador, no una corrección técnica.

Decidir antes de tocarlo:
1. ¿La zona horaria canónica es Colombia? Entonces `combineDateAndTime` debe
   construir hora local, no UTC. Opciones: una columna `tz` en `config`, o
   `America/Bogota` fijo (UTC−5, sin DST desde 2015).
2. Hay dos fuentes de cutoff —la columna `release_windows.cutoff_at` y el
   computado desde `delivery_schedule`— y hoy la segunda manda sola. ¿Cuál es
   la oficial?

### 23.4 Estado al 2026-10-21

Las 3 ventanas abiertas en la DB (2026-10-15, 10-20, 10-21) tienen su cutoff ya
vencido, así que la tienda muestra correctamente "no abrimos por ahora". Para
volver a vender hay que abrir ventanas futuras; no es un bug del código.

## 24. Pagos: el camino automático funciona end-to-end — 2026-10-23

Cierre de la ola P0 del backend de pagos (spec_id=25). La cadena completa
**webhook → transitionState → outbox → relay → consumer → pedido pagado + stock
comprometido** está implementada, testeada y commiteada (e261c03..477b1bc):

| Pieza | Dónde | Nota |
|---|---|---|
| Reservas compartidas | `src/lib/stock.js` | commit/release salen de routes/orders.js; las necesita el consumer sin cerrar el ciclo de imports |
| Relay del outbox | `src/lib/payments/relay.js` | drenaje compartido server/Worker; antes el server **nunca drenaba** y `payment.succeeded` moría en la cola |
| Consumer de pago OK | `src/lib/payments/consumers.js` | `payment.succeeded` marca el pedido pagado **y convierte la reserva en venta** |
| Estado real vs dominio | `src/lib/payments/index.js` | `orders.payment_state` lleva el estado del grafo (SUCCEEDED…); `payment_status` el dominio (pending\|paid) |
| Nequi fail-closed | `src/lib/payments/adapters/nequi.js` | sin `NEQUI_API_KEY` lanza; el mock solo entra con `NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1` |
| KPIs limpios | `src/routes/metrics.js` | gross/hoy/last_7/serie diaria excluyen cancelados |

**Regresión:** `test/payment-auto-flow.test.js` fija la cadena completa con
workers activos (relay a 500ms via `MYMOCHIS_OUTBOX_RELAY_INTERVAL_MS`), el
dedupe del inbox y que `SUCCEEDED` es punto de no retorno. Suite 88/88.

**Lección de la sesión:** el webhook marca `payment_status='paid'` de forma
*sincrónica* (transitionState) pero el stock llega *async* por el relay — el
test debe esperar el efecto de negocio (reserva→0, sold→qty), no la
denormalización intermedia, o es una carrera.

**Pendiente para cerrar pagos del todo:** (1) credenciales Nequi reales (hoy el
adapter fail-closed; requiere sandbox + aprobación), (2) que la tienda llame
`POST /api/payments` — hoy ninguna pantalla lo invoca, el cliente sigue pagando
por transferencia y el operador confirma a mano, (3) deploy (§18 sigue siendo el
runbook vigente).

## 25. Frente visual — onda del 2026-10-23 (spec_id=26)

Estado: **implementado**. Commits b0d4b4b..e5aebe8. Suite 88/88.

| Cambio | Dónde | Commit |
|---|---|---|
| WSP al admin al confirmar pago (auto + manual) | `src/lib/payments/order-notify.js` | b0d4b4b |
| Logo footer 72px, redes 32px, NX-Studio, privacidad, sin Marketing | `index.html` + `manage.html` | 6f155e7 |
| Sección **Producción** (insumos, costo/lote, unitario, margen; localStorage a la espera de API propia) | `manage.html` | ddef815 |
| Checkboxes clay + botón entrega inmediata fresa | `manage.html` | ddef815 |
| Sección **Fotos**: subir a categoría marketplace + "Usar como hero" (`PUT /api/config`) | `manage.html` | 240bab0 |
| Hero de la landing usa `config.hero_image_url` (foto del admin) | `index.html` | 0eea9fc |
| Promos como popout flotante | `index.html` | a58229b |
| Carrito: líneas clay + qty +/− | `tienda.html` | a0730a1 |
| **Shader aurora ambiental** fijo detrás de toda la página, paleta v5 (cielo→sakura→mist) | `web/` + `index.html` | 0eea9fc |
| Doble footer eliminado (isla de contenido montada al final del body) | `index.html` | 0eea9fc |
| Meta CSP sin `frame-ancestors` (console limpia; helmet manda el header) | `index.html` | 0eea9fc |
| Dockerfile multi-stage: `npm run build:web` antes de empaquetar (public/build es gitignored) | `Dockerfile` | e5aebe8 |

**Lección:** el bundle de las islas (§21) nunca se había compilado — `/build/landing.js`
y `islands.css` daban 404 y la isla de contenido quedó montada al final del body,
viéndose como "un segundo footer con shaders". Una isla sin build verificado no
está implementada.

**Pendiente de esta onda:** producción aún persiste en localStorage (migrar a
tabla + endpoints cuando el operador quiera historial real); sección Cobros del
panel se puede retirar cuando el checkout UI (§24.2) exista.

## 26. Onda spec_id=30 — checkout, panel sin redundancia y UI en español

Estado al 2026-10-23: **en curso**. Commits 87c3f07 + a44a3ad. Suite 93/93.

**Panel sin redundancia (87c3f07):** fuera Cobros/Fotos/Métodos de pago del
sidebar (Cobros accesible desde Pedidos; portada dentro de Productos; métodos
en Entregas→pagos). "Sabores" → "Productos" (portafolio ampliable). "Dashboard"
→ "Panel". UI entendible sin saber programar ni inglés: estados en español
(vía `STATUS_ES` — los valores que viajan al server siguen siendo los ingleses),
chips traducidos, login sin endpoints. FIX: `render.dashboard` crasheaba en
`by-status` (elemento huérfano) — el panel llevaba tiempo a media render;
cazado con Playwright, bloque muerto eliminado.

**Checkout con domicilio por distancia (a44a3ad):** el carrito elige recoger
vs domicilio; en domicilio, `POST /api/delivery/quote` geocodifica (Nominatim
con caché), mide haversine al centro de la zona y cotiza **tarifa base +
precio por km redondeada a $50** (estilo DiDi/Rappi). La fórmula vive en
`src/lib/delivery-fee.js` — fuente única compartida con POST /api/orders.
Config nueva `delivery_immediate_base_fare_cents` / `_price_per_km_cents`
(defaults 0 = tarifa plana, backward compatible). El carrito también elige
forma de pago (efectivo o los `payment_methods` del admin → `payment_method_id`).
Domicilio desactivado = pill deshabilitada con explicación.

**Pendiente del spec_id=30:** G3 producción persistente + analíticas de unit
economics, G4-01 captura de Instagram (requiere conectar la cuenta del negocio),
G2-03 pasada responsiva multi-dispositivo, G5-01 shaders visibles en secciones
de fondo opaco.

### 26.1 Cierre de la onda — 2026-10-24 (spec_id=30 COMPLETO)

Commits `7bdbeea` (checkout) + `05e84d2` (aurora), suite **99/99**, push
`ec9d925..05e84d2`.

**G5-01 — la aurora se ve a través de las secciones (05e84d2).** El shader WebGL
vive en `.page-shader` con `z-index: -1`, pero el `body` tenía `background-color`
opaco: en el orden de pintado, un hijo con `z-index: -1` se dibuja **antes** del
fondo del body, así que la aurora quedaba tapada (por eso "pintado" no era lo
mismo que "visible"). El body pasa a `color-mix(... 80%, transparent)` y las
secciones también (`.combos` / `.gallery` / `.how-it-works` → canvas-2 al 78 %,
`.why` → canvas al 74 %, `.releases` → gradiente con ambos stops al 80 %).
Verificado con Playwright: body `rgba(1,1,1,0.8)`, secciones 0.78 / 0.74, canvas
WebGL 1280×720 montado, consola 0 errores.

**Checkout electrónico cierra el hueco #330 (7bdbeea).** El WIP traía
`submitOrder` calculando `payInfo` (método + intent de pago) pero
`showSuccess(order)` **ignoraba el segundo argumento**: el `#successPay` quedaba
siempre vacío y oculto, así que el cliente nunca veía cómo pagar. Ahora
`showSuccess(order, payInfo)` pinta "Cómo pagar tu pedido" con las instrucciones
del método, la cuenta del negocio (primer `payout_accounts`) cuando existe, y el
link de la pasarela electrónica cuando el intent devuelve `deep_link`.
Verificado e2e en dev: pedido `#03a2ddf3` creado, `#successPay` visible
(`display: block`) con título + instrucciones; sin link porque Nequi está
fail-closed sin credenciales (401) y el flujo manual continúa — por diseño.
El `pay-box` solo aparece si hay método de pago elegido.

**Verificación:** suite 99/99; e2e Playwright en landing (fondos con alpha +
canvas WebGL) y en tienda (pedido + pay-box); consola 0 errores salvo el 401
esperado de `/api/payments` (fail-closed de la pasarela).

**Pendiente del operador (fuera del código):** token de Instagram del negocio
(Credenciales→Instagram), credenciales Nequi reales, DEPLOY OCI (§18/§19) y
limpiar las dos `release_windows` sembradas en dev para QA (2026-10-25 domingo
y 2026-10-30 viernes, 50 unidades de `clasico-fresa`).

## 27. Onda visual 2026-10-28 — tienda clay, panel responsive y compra al back-end

Cierra el pedido de rediseño: la tienda deja de ser una página "del sistema" y
comparte el lenguaje visual de la landing (aurora + superficies de cristal), el
panel deja de empujar la página en móvil, y el formulario de compra alimenta el
back-end con los datos que el operador necesita.

### 27.1 Tienda: la aurora y el cristal

La tienda tenía su propio fondo opaco (`--clay-canvas` al 100 %) y tarjetas
opacas, así que se veía plana frente a la landing. Ahora:

- `body` a `color-mix(in srgb, var(--clay-canvas) 70%, transparent)` + los
  cuatro halos de color, igual que la landing.
- `.page-shader` con el island `hero-bg` (mismo bundle `/build/landing.js`) y
  **fallback CSS**: sin WebGL o sin bundle la página sigue teniendo ambiente.
- `main`/`footer` en `z-index: 1` y el shader en `0` — sin esto el contenido
  in-flow queda por debajo del shader.
- Rejilla de puntos (`body::after`) como textura fina sobre la aurora.
- `.product-card`, `.cart-sheet` y `.success-card` pasan a superficie de
  cristal (`backdrop-filter: blur() saturate()` + borde claro + fondo al 82 %).
- El destacado conserva su tinte crema, también translúcido: opaco tapaba la
  aurora justo en la tarjeta que más se mira.

### 27.2 Formulario de compra → back-end

Dos huecos reales entre la tienda y el panel:

- **Teléfono.** La tienda mandaba los 10 dígitos locales; el panel y el
  despacho de WhatsApp trabajan con números completos. Ahora la tienda (y el
  pedido manual del panel) completan el `57` cuando el número es local de 10
  dígitos.
- **Punto de referencia.** El domiciliario no tenía forma de saber la
  referencia ("portón azul") porque `orders` no tiene columna para eso. Viaja en
  `notes` con el prefijo `Referencia:` y el operador lo ve en la tabla y en el
  detalle del pedido.

### 27.3 Panel: lo que la API ya traía y la tabla no mostraba

`rowToOrder` ya devolvía `delivery_mode`, `delivery_address`,
`delivery_fee_cents`, `delivery_distance_km`, `delivery_free_applied`,
`source`, `payment_method_id` y `release_window_id`. Nada de eso se veía.

- La fila ahora lleva el chip de entrega (🏪 Recogida / 🛵 Domicilio), el chip
  de origen, la dirección, el costo del domicilio y el método de pago.
- Botón 🔎 que abre el **detalle del pedido**: cliente, WhatsApp, día, entrega,
  origen, método de pago, estado del pago, dirección, distancia, costo,
  coordenadas, ventana de producción, notas y productos con precios.
- Botón **➕ Nuevo pedido**: el canal real del negocio es WhatsApp y el
  operador no tenía forma de registrar ese pedido — quedaba fuera de las
  métricas, del stock y de la caja. El formulario usa el **mismo endpoint que
  la tienda** (`POST /api/orders`), así que el pedido entra por la misma
  tubería: valida la ventana, reserva stock, recalcula el total en el server y
  dispara el WhatsApp.

Los ids viajan en `data-*` con un listener delegado, nunca interpolados en un
`onclick`: un `flavor_id` con apostrofe cerraba el atributo (el mismo bug que
ya se corrigió en los botones de edición).

### 27.4 Bug de responsive: la tabla estiraba la página

Con la fila real (dirección, notas y chips), `documentElement.scrollWidth` daba
**852 px en un viewport de 375**. Causa: con la `<table>` en `static` y las
`th` en `sticky`, el ancho mínimo de la tabla se escapa del clip de
`.table-wrap` y el scroll horizontal se va a la página entera. Con
`position: relative` en la tabla el overflow queda dentro del contenedor. A
≤560 px además `table { min-width: 460px }` y `overflow-wrap: anywhere`, para
que una dirección larga no estire la tabla.

### 27.5 Verificación

- `npm test` → **131/131**.
- `npx playwright test` → **54/54** en 3 viewports (375 / 768 / 1440):
  - `e2e/tienda.spec.ts`: la aurora se monta (`canvas` dentro de
    `.page-shader`), el body es translúcido y las tarjetas tienen
    `backdrop-filter`.
  - `e2e/dashboard.spec.ts` (nuevo): login, el formulario de compra abre con
    los días de la ventana y sus productos, el total se calcula, el pedido
    creado aparece en la tabla con sus chips, el detalle lo muestra y el
    panel no desborda en móvil.
- `npm run build:web` verde; el dev server sirve `/`, `/tienda.html` y
  `/manage.html` con 200 y `/api/health` = `{"ok":true}`.
