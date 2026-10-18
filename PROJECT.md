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
- Flujo cliente: `POST /api/orders` pedido programado ✓ (valida schedule por día + cutoff UTC + ventana `open` + stock)
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
