# MyMochis â€” PROJECT.md

Fuente Ãºnica de verdad del proyecto. Regla vigente: decisiones, arquitectura, estado operativo, roadmap y runbooks viven aquÃ­; no crear `.md` adicionales salvo `AGENTS.md` cuando aplique.

## Arquitectura autÃ³noma single-tenant con deploy gratuito

Fecha: 2026-10-08
Estado: decisiÃ³n aprobada por operador (**sin SaaS multi-tenant**)
Ãmbito: app actual `mymochis` v2.0.0 (`Express + node:sqlite + frontend estÃ¡tico`)

## 1. DecisiÃ³n arquitectÃ³nica

**DecisiÃ³n:** mantener MyMochis como **monolito single-tenant portable**, desplegado primero en **Oracle Cloud Always Free** con persistencia local SQLite y backups cifrados fuera del proveedor. No continuar con MyMochis Studio multi-tenant como requisito para operar el negocio del amigo.

**MotivaciÃ³n:**
- El negocio necesita autonomÃ­a operativa: catÃ¡logo, pedidos, promos, horarios, delivery y dashboard sin depender de Sebas.
- El cÃ³digo actual ya cubre esas capacidades en modo single-tenant.
- SaaS multi-tenant agrega complejidad de plataforma (tenants, provisioning, DNS wildcard, billing, soporte) innecesaria para este caso.
- Render free + disk persistente deja de ser "gratis" si se cobra el disco; la persistencia es obligatoria para SQLite/uploads.

**No-objetivos:**
- No construir meta-plataforma multi-tenant.
- No procesar tarjetas ni guardar datos sensibles de pago.
- No migrar a microservicios.
- No depender de Sebas para operaciÃ³n diaria.

## 2. Requisitos

### Funcionales
- RF-01: el cliente puede ver catÃ¡logo, promos, horarios, mÃ©todos de pago y release windows vigentes.
- RF-02: cliente puede crear pedido programado o inmediato con validaciones actuales.
- RF-03: operador/admin puede gestionar catÃ¡logo, combos, promos, pedidos, stock, delivery, uploads, usuarios y mÃ©tricas.
- RF-04: el negocio puede operar sin intervenciÃ³n del desarrollador para el flujo normal.
- RF-05: el sistema puede restaurarse ante pÃ©rdida del servidor.

### No funcionales
- RNF-01 Disponibilidad prÃ¡ctica: servicio accesible 24/7 con auto-restart.
- RNF-02 Persistencia: SQLite y uploads deben sobrevivir reinicios/redeploys.
- RNF-03 Backup: RPO objetivo â‰¤ 24h; RTO objetivo â‰¤ 60 min con runbook.
- RNF-04 Seguridad: TLS, rate limiting, auth scrypt+JWT, mÃ­nimos permisos, backups cifrados.
- RNF-05 Costo: mantenerse dentro de free tiers razonables.
- RNF-06 Datos: minimizar PII; pagos siguen siendo manuales/off-platform.

## 3. Restricciones y hechos verificados

- App actual: `mymochis` v2.0.0, Express, SQLite `node:sqlite`, frontend estÃ¡tico, auth propia scrypt+JWT.
- Persistencia actual README asume Render disk; Render pricing muestra compute free pero **persistent disks `$0.25/GB/mo`**, por lo que no es la mejor opciÃ³n "gratis con persistencia".
- Oracle Cloud Always Free incluye cÃ³mputo VM Ampere A1 Flex hasta 2 OCPUs/12GB RAM, 200GB block volume total y 10TB egress/mes.
- Cloudflare R2 free tier: 10GB-mes storage Standard, 1M Class A ops/mes, 10M Class B ops/mes, egress free.
- Cloudflare D1 free tier: 5M rows read/day, 100k rows write/day, 5GB storage; viable solo si se migra la app a Workers/D1.

## 4. Opciones evaluadas

| OpciÃ³n | Persistencia | Cambio de cÃ³digo | Costo objetivo | Riesgo | Veredicto |
|---|---|---|---|---|---|
| Render free + disk | SQLite same | Nulo | Disk pago | Bajo esfuerzo, costo pequeÃ±o | **Descartada para "gratis estricto"** |
| Fly.io | Necesita volume pago | Nulo | No tiene free tier nuevo | Serverless-like pero no gratis | **Descartada** |
| Cloudflare Pages/Workers + D1/R2 | D1/R2 | Alto | $0 hasta lÃ­mites | MigraciÃ³n Express/SQLiteâ†’Workers/D1 | **OpciÃ³n futura si se quiere cero servidor** |
| Oracle Cloud Always Free VM | Block volume local | Nulo/bajo | $0 Always Free | Capacidad/regiÃ³n/ocio puede reclamar instancias idle | **Recomendada ahora** |

## 5. Arquitectura recomendada

### 5.1 Vista lÃ³gica

```text
Cliente (browser)
  â”‚ HTTPS
  â–¼
Dominio propio o sslip/nip temporal
  â”‚ DNS
  â–¼
Cloudflare DNS (proxy opcional)
  â”‚
  â–¼
OCI Always Free VM (Ubuntu + Docker)
  â”œâ”€ Caddy (80/443, TLS automÃ¡tico)
  â”œâ”€ MyMochis app (Node/Express, container)
  â”‚   â”œâ”€ /api/public, /api/orders, ... rutas actuales
  â”‚   â””â”€ SQLite file + uploads en volumen persistente
  â””â”€ Backup job (cron/contenedor sidecar)
      â”œâ”€ SQLite online backup / VACUUM INTO
      â”œâ”€ tar uploads
      â”œâ”€ age encrypt
      â””â”€ upload a Cloudflare R2 bucket privado

Backups
  â”œâ”€ R2 cifrado (fuera de OCI)
  â””â”€ OCI block volume backups (mÃ¡x 5 Always Free), si se habilitan
```

### 5.2 Vista de despliegue

```text
OCI Home Region
  VCN
    Subnet pÃºblica
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

| Componente | Responsabilidad | DecisiÃ³n |
|---|---|---|
| Frontend estÃ¡tico | Landing + dashboard operador | Se mantiene `public/` actual |
| API Express | Reglas de negocio actuales | Se mantiene `server.js` + `src/routes/*` |
| SQLite local | Datos del negocio/clientes | Se mantiene `node:sqlite`; archivo en volumen persistente |
| Uploads | ImÃ¡genes/videos productos | Carpeta local persistente; backup cifrado |
| Caddy | HTTPS, cabeceras de proxy, compresiÃ³n | Reemplaza exponer Node directo a Internet |
| Cloudflare DNS | DNS + proxy opcional | Gratis; mejora TLS/DDoS bÃ¡sico |
| R2 | Backup externo cifrado | Free tier suficiente para este volumen |
| OCI Vol backups | Copia rÃ¡pida del volumen | Complementario; no reemplaza backup lÃ³gico |

## 7. Seguridad y protecciÃ³n de datos

### ClasificaciÃ³n de datos
| Dato | Sensibilidad | Control |
|---|---|---|
| Email/password admin y usuarios | alta | scrypt + salt; nunca logs; env secret fuera del repo |
| Cliente nombre/telÃ©fono/direcciÃ³n | PII media | acceso solo autenticado para administraciÃ³n; TLS; backups cifrados |
| Ã“rdenes/notas | PII media + negocio | auth admin para consulta; retention policy |
| ImÃ¡genes productos | baja/media | uploads validados por tipo/tamaÃ±o; servir con cache y nosniff |
| Pagos | fuera de alcance | no almacenar tarjetas; comprobantes solo por WhatsApp/manual |

### Controles mÃ­nimos antes de producciÃ³n
1. **Fail-fast secrets**: quitar defaults inseguros; si falta `NEXOMOCHIS_JWT_SECRET`, la app no arranca.
2. **CORS cerrado**: `NEXOMOCHIS_CORS=https://dominio-del-negocio`.
3. **JWT TTL reducido**: bajar de 7 dÃ­as a 12h o 24h para admin; refresh manual por login.
4. **Admin seed seguro**: `ADMIN_PASSWORD` generado, primer login obliga cambio manual documentado; `ADMIN_PASSWORD_RESET` solo durante rotaciÃ³n y luego se elimina.
5. **Subir duraciÃ³n de lockout auth** si el negocio recibe fuerza bruta; mantener rate limits.
6. **Logs sin PII**: confirmar que no se loguean bodies ni passwords; revisar antes de habilitar logs persistentes.
7. **Permisos filesystem**: DB y env con `0600`; uploads con permisos mÃ­nimos.
8. **Backups cifrados**: clave privada offline (age o GPG); repo solo con public key/config.
9. **Formulario pÃºblico anti-abuso**: evaluar Cloudflare Turnstile si aparece spam de pedidos.
10. **Privacidad bÃ¡sica**: publicar aviso de datos personales en landing (nombre, WhatsApp, direcciÃ³n para delivery, finalidad, contacto para modificaciÃ³n/eliminaciÃ³n).

## 8. Backup y disaster recovery

- **RPO**: 24h mediante backup diario cifrado a R2.
- **RTO**: 60 min con runbook probado.
- **Estrategia**: 3-2-1 simplificado:
  - 1 copia primaria: volumen OCI.
  - 1 copia lÃ³gica cifrada: R2.
  - 1 copia infraestructural opcional: OCI block volume backup (max 5 Always Free).

### RetenciÃ³n recomendada R2
- 7 diarios
- 4 semanales
- 6 mensuales

### Prueba obligatoria
Una vez al mes: restaurar backup en VM local o VM temporal y abrir `/manage.html` + revisar pedidos recientes.

## 9. Observabilidad mÃ­nima sin cargar operaciÃ³n

- `GET /api/health` ya existe; usarlo para uptime externo.
- Docker restart policy `unless-stopped`.
- Logs de aplicaciÃ³n: journald/docker logs, retenciÃ³n corta.
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

`Caddyfile` mÃ­nimo:

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

### Fase 0 â€” freeze de alcance
- Confirmar que `mymochis-studio` queda fuera del camino crÃ­tico.
- Confirmar negocio: dominio, email/telÃ©fono admin, polÃ­tica de datos y backups.

### Fase 1 â€” hardening mÃ­nimo del cÃ³digo
- Quitar fallback `dev-secret` de JWT.
- Agregar `.env.production.example` completo.
- Opcional: exigir cambio de contraseÃ±a documentado tras primer login.
- Opcional: restringir vistas internas a admin donde aplique (`include_all`, `include_inactive`).
- Smoke tests locales y revisiÃ³n rÃ¡pida de logs sin PII.

### Fase 2 â€” infraestructura
- Crear cuenta OCI y VM A1 Always Free.
- Configurar DNS en Cloudflare; usar dominio propio recomendado. Si se exige costo cero absoluto, iniciar con `sslip.io`/`nip.io` y migrar a dominio propio despuÃ©s.
- Docker + compose + Caddy.
- Crear bucket R2 privado + token permisos mÃ­nimos.

### Fase 3 â€” deploy
- Primer arranque, seed admin, prueba login, cambio de clave.
- Smoke E2E: health, catÃ¡logo, crear pedido programado, crear pedido inmediato si aplica, dashboard, upload imagen.
- Verificar TLS/CSP/HSTS.

### Fase 4 â€” backup/recovery
- Instalar job diario SQLite backup + uploads tar + encrypt + upload.
- Hacer restore drill en local.
- Guardar runbook impreso/exportado para el negocio.

### Fase 5 â€” handoff autÃ³nomo
- Crear cuenta admin del amigo y retirar/rotar credenciales de Sebas.
- Entregar guÃ­a operativa corta: "si falla", "cÃ³mo recuperar pedidos", "a quiÃ©n contactar".
- Programar recordatorio mensual de prueba de backup.

## 12. Criterios de aceptaciÃ³n

- [ ] La app opera el negocio actual sin MyMochis Studio.
- [ ] SQLite y uploads persistentes en volumen.
- [ ] HTTPS vÃ¡lido con renovaciÃ³n automÃ¡tica.
- [ ] Backups diarios cifrados restaurables.
- [ ] Auth admin endurecida y sin defaults de producciÃ³n.
- [ ] El amigo puede operar catÃ¡logo/pedidos sin hablar con Sebas.
- [ ] Gasto mensual objetivo: `$0`, salvo dominio propio opcional.

## 13. Riesgos y mitigaciones

| Riesgo | Impacto | MitigaciÃ³n |
|---|---|---|
| OCI reclama instancia idle Always Free | CaÃ­da del servicio | trÃ¡fico real + uptime monitor + restore runbook |
| Capacidad Always Free no disponible en home region | No se puede crear VM | reintentar AD/region permitido; plan B Render disk pago o VPS barato |
| Backup corrupto | PÃ©rdida de datos | backup lÃ³gico SQLite `.backup`/`VACUUM INTO` + restore drill mensual |
| Credenciales admin expuestas | Toma de control | rotaciÃ³n, mÃ­nimo privilegio, logs, 2FA futuro |
| PII de clientes filtrada | Riesgo legal/reputacional | minimizar campos, TLS, backups cifrados, aviso de privacidad |
| Ataques al formulario de pedidos | Spam/fraude | rate limit + Turnstile opcional + validaciones actuales |

## 14. Camino futuro opcional (si cambia el negocio)

Si el negocio crece y se necesita "cero servidor" o varios negocios independientes:
- Migrar SQLiteâ†’D1/Postgres y Expressâ†’Workers o mantener Node en VPS pago.
- AÃ±adir pagos online hosted (Wompi/MercadoPago) sin guardar PAN.
- AÃ±adir 2FA y auditorÃ­a detallada de cambios admin.
- No reabrir SaaS multi-tenant salvo que el modelo de negocio cambie a producto para muchos negocios.

## 15. ConclusiÃ³n

La arquitectura correcta para el objetivo es **single-tenant autÃ³nomo**, no SaaS multi-tenant. La ruta mÃ¡s barata y menos intrusiva es:

**Oracle Cloud Always Free VM + Caddy + Docker + SQLite persistente + uploads persistentes + backups cifrados a Cloudflare R2.**

Esto conserva las caracterÃ­sticas actuales, protege datos del negocio/clientes y permite desligar la operaciÃ³n diaria de Sebas.

## 16. Estado de implementaciÃ³n â€” 2026-10-08

ImplementaciÃ³n inicial completada en repo:

- `Dockerfile`: build Node 24 Alpine, sin devDependencies, usuario `node`, healthcheck `/api/health`.
- `Caddyfile`: TLS automÃ¡tico con `DOMAIN` + `LETSENCRYPT_EMAIL`.
- `docker-compose.yml`: servicios `app` + `caddy`, volumen persistente `mymochis_data:/var/data`.
- `.env.production.example`: variables requeridas para producciÃ³n/backups.
- `scripts/backup-sqlite.mjs`: backup consistente de SQLite con `VACUUM INTO`.
- `scripts/backup-mymochis.sh`: empaqueta DB + uploads, cifra con `age`, sube a R2 (`daily/weekly/monthly`).
- `scripts/restore-mymochis.sh`: restaura desde backup cifrado local/R2 con confirmaciÃ³n explÃ­cita (`CONFIRM_RESTORE=yes`).
- `scripts/stack-smoke.sh`: smoke mÃ­nimo de `/api/health`, `/api/public`, `/manage.html`.
- Hardening aplicado: producciÃ³n falla si falta `NEXOMOCHIS_JWT_SECRET`; TTL JWT configurable por `NEXOMOCHIS_JWT_TTL_SECONDS` y acortado por defecto a 12h en producciÃ³n.

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

VerificaciÃ³n local ejecutada: `npm test` â†’ 7/7 tests passing.

## 17. VerificaciÃ³n MVP E2E â€” 2026-10-09

Smoke E2E funcional sobre el server Node (mismo cÃ³digo que el contenedor Docker): **13/13 PASS**.

- `GET /api/health` âœ“
- `GET /api/public` âœ“ (config, categories, flavors, combos, promos, payment_methods, delivery_schedule, delivery_config, release_windows)
- Login admin sembrado por env âœ“ (`ADMIN_EMAIL`/`ADMIN_PASSWORD` en `src/db.js`)
- Flujo operador: crear sabor âœ“ + abrir release window âœ“
- Flujo cliente: `POST /api/orders` pedido programado âœ“ (valida schedule por dÃ­a + cutoff + ventana `open` + stock). Ver Â§23 sobre la zona horaria del cutoff, que hoy tiene un bug abierto.
- Stock decrementa `units_sold` tras pedido âœ“
- GestiÃ³n admin: `GET /api/orders` âœ“, `GET /api/metrics` âœ“
- EstÃ¡ticos: landing `/` âœ“, dashboard `/manage.html` âœ“
- RBAC: `/api/metrics` sin token â†’ 401 âœ“
- Regla de negocio confirmada: pickup_day en domingo â†’ `no_pickup_schedule` (schedule Lunâ€“SÃ¡b, correcto).
- Payload de pedidos: `items` es **objeto** `{ flavor_id: qty }` (no array).

Los pedidos del cliente final entran por **WhatsApp** (link directo en la landing, diseÃ±o intencional); el endpoint pÃºblico `/api/orders` queda habilitado y validado para uso futuro.

Adicionalmente en este cierre:
- Aviso de datos personales publicado en el footer de la landing (control Â§7.10): nombre, WhatsApp, direcciÃ³n de entrega, finalidad y canal de modificaciÃ³n/eliminaciÃ³n.
- `render.yaml` eliminado (Render descartado en Â§4).
- Docker no disponible en la mÃ¡quina de desarrollo: el build de imagen se valida en la VM (Fase 3).

## 18. Ãšnico pendiente para producciÃ³n

Fases 2â€“5 del Â§11 requieren recursos del operador. Todo el paquete de
deploy ya estÃ¡ en repo y el MVP estÃ¡ verificado; la puesta en producciÃ³n
sigue este runbook actualizado 2026-10-11:

### 18.1 Preflight (idempotente)

Antes de tocar OCI, validar localmente que todos los prerequisitos estÃ¡n
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
   registro A `mymochis.tudominio.com` â†’ IP pÃºblica de la VM. Proxy
   activado (orange cloud) para TLS + DDoS bÃ¡sico.
3. **Subir SSH pubkey**: en OCI Compute â†’ Instances â†’ Create â†’
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
     (la pÃºblica es el recipient; guardar la privada offline)
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

### 18.3 Lo que NO requiere acciÃ³n del operador

- Dockerfile, docker-compose.yml, Caddyfile: ya en repo y validados.
- backup-mymochis.sh: idempotente, valida env vars al inicio.
- restore-mymochis.sh: idempotente, requiere `CONFIRM_RESTORE=yes`.
- stack-smoke.sh: 13+ smoke tests pre-deploy.
- preflight-oci.sh: aÃ±adido 2026-10-11 (commit b91d24c) â€” ejecutable
  ANTES de la secuencia para detectar gaps temprano.

Refs: memo #178 (mymochis MVP cerrado), memo #188 P0, commit b91d24c.

## 19. HistÃ³rico de preflight (archivado 2026-10-11) up -d --build`.
4. `bash scripts/stack-smoke.sh "https://$DOMAIN"`.
5. Seed admin, login, cambio de clave (`ADMIN_PASSWORD_RESET=true` y retirar).
6. Cron backup diario (Â§16) + restore drill.
7. Handoff: crear cuenta admin del operador del negocio y rotar la de Sebas.

## 19. Cheatsheet del operador para producciÃ³n (no tÃ©cnico)

Estado cÃ³digo: 100% listo y verificado (commit `8729c4f` 2026-10-09 + E2E 13/13 PASS, memo #178). Deploy pendiente solo de cuentas tuyas + 7 acciones de ~1 hora total. Refiere a Â§18 para los pasos tÃ©cnicos.

### Recursos que necesitas conseguir

| # | Recurso | Costo | DÃ³nde | Tiempo |
|---|---|---|---|---|
| 1 | Cuenta Oracle Cloud Free Tier | $0 | https://cloud.oracle.com/free | 10 min (sign-up + verificaciÃ³n tarjeta â€” NO cobran, es anti-fraude) |
| 2 | Dominio propio | ~$10/aÃ±o | Namecheap o Cloudflare Registrar | 5 min |
| 3 | Cuenta Cloudflare (DNS gratis + R2) | $0 | https://dash.cloudflare.com/sign-up | 2 min |
| 4 | Bucket R2 + token escritura | $0 (free 10GB) | Cloudflare â†’ R2 â†’ Create + API token | 5 min |
| 5 | Llave pÃºblica `age` (cifra backups) | $0 | La genero yo y te la paso | 1 min |

WSP Business queda fuera del MVP inicial: los pedidos se siguen haciendo por WSP personal manual (tu preferencia confirmada 2026-09-29). Si querÃ©s WSP Business auto, son 30+ dÃ­as adicionales de Meta approval â€” el deploy igual funciona, solo el canal auto queda pendiente.

### El dÃ­a del deploy (yo corro los 7 pasos de Â§18, vos accedÃ©s 3 veces)

**Bloque 1 â€” Vos creÃ¡s los recursos (~1h una sola sesiÃ³n)**
- Oracle Cloud â†’ Create VM â†’ Ubuntu 22.04 â†’ shape `VM.Standard.A1.Flex` 1 OCPU/1GB (free tier) â†’ subÃ­s tu SSH key â†’ abris puertos 22/80/443.
- ComprÃ¡s dominio y lo apuntÃ¡s a los nameservers de Cloudflare (te paso los NS exactos).
- En Cloudflare: DNS â†’ A record a la IP pÃºblica de la VM + bucket R2 + API token con scope Object Storage Write.

**Bloque 2 â€” Pasamos credenciales (5 min)**
- Me das por chat: `ORACLE_VM_IP`, `DOMAIN`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `AGE_PUBLIC_KEY`.
- Yo las guardo cifradas en Windows Credential Manager (dark-memory keyring). No tocan tu repo.
- Yo corro los 7 pasos del Â§18 y dejo `https://$DOMAIN` operativo.

**Bloque 3 â€” VerificaciÃ³n (30 min)**
- Smoke E2E: home 200, catÃ¡logo pÃºblico 200, login admin, crear pedido, ver mÃ©tricas admin.
- Crear cuenta para el operador del negocio y rotar mi acceso.

### Decisiones que necesito antes de empezar

| Pregunta | Default si no contestÃ¡s |
|---|---|
| Â¿QuÃ© dominio? (ej: `mymochis.app`, `mimochis.co`, `mochis.lat`) | Te propongo 3 cuando digas GO |
| Â¿TamaÃ±o VM Oracle? (1 OCPU/1GB vs 2/12GB) | 1 OCPU/1GB (sobra para MVP) |
| Â¿Backups automÃ¡ticos desde dÃ­a 1? | DespuÃ©s de validar 1 semana |
| Â¿HTTPS con Caddy automÃ¡tico u otro CA? | Caddy (ya en `docker-compose.yml`) |
| Â¿WSP auto o personal manual? | Personal manual (preferencia confirmada) |

### Riesgos (transparente)

1. **Oracle A1 reclamation**: si CPU <10% por dÃ­as puede reclamar la VM y avisa 48h antes. MitigaciÃ³n: el MVP tiene trÃ¡fico real, no va a estar ocioso.
2. **R2 free 10GB**: alcanza para catÃ¡logo. Si crece a miles de productos, plan paid (~$0.015/GB-mes).
3. **DNS propagation**: 5-30 min global en primer apuntado. No bloquea, solo el operador del negocio entra despuÃ©s de propagar.
4. **Costo sorpresa**: ninguno esperado. Si ves algo raro en Oracle a 30 dÃ­as, bajamos el shape.

### Comando para arrancar

Cuando tengas los 4 recursos del Bloque 1, mandame: **"GO deploy MyMochis"** + la info, y arrancamos el mismo dÃ­a.

## 20. Multi-nÃºmero, multi-admin y dispatch WhatsApp â€” 2026-10-17

Fecha: 2026-10-17. Estado: **implementado, testeado (11/11) y verificado E2E en vivo**.
Refs: skill `whatsapp-order-dispatch` (canon del patrÃ³n), commit de esta sesiÃ³n.

### Flujo del pedido (nuevo)

1. El cliente arma el pedido (landing modal o tienda).
2. `POST /api/orders` valida horario/cutoff/stock, persiste en SQLite **y** arma el
   dispatch: elige el destinatario con **round-robin** (`recipients[orderCount % n]`
   sobre los activos, `ORDER BY sort_order, id`) y responde
   `{ whatsapp: { deep_link, primary_phone, primary_label, recipients_count, cloud_status, cloud_results } }`.
3. El cliente abre el `deep_link` (`api.whatsapp.com/send/`, NUNCA `wa.me`): su
   WhatsApp abre con el mensaje pre-llenado dirigido al admin elegido.
4. Si `WHATSAPP_CLOUD_TOKEN` + `WHATSAPP_CLOUD_PHONE_ID` estÃ¡n configurados, el
   server ADEMÃS envÃ­a el pedido por Meta Cloud API a TODOS los nÃºmeros activos
   (`sent`/`partial`/`failed`/`skipped`). Sin credenciales â†’ `skipped`, el pedido
   nunca falla por el canal.

**Unidad de dinero en TODA la app: pesos COP.** Los `*_cents` histÃ³ricos son
pesos (flavor.price 8000 = $8.000). NUNCA dividir total entre 100.

### Multi-nÃºmero (`order_recipients`)

- Tabla `(label, phone UNIQUE, active, sort_order)`; seed inicial importa
  `config.whatsapp_number` si no hay destinatarios y no es el placeholder.
- CRUD admin-only en `POST/GET/PATCH/DELETE /api/recipients` (8â€“15 dÃ­gitos,
  normaliza no-dÃ­gitos, rechaza duplicados). UI: secciÃ³n **NÃºmeros de pedido**
  del panel (agregar / pausar / eliminar).
- Respaldo legacy: pool vacÃ­o â†’ usa `config.whatsapp_number` (sin placeholder).

### Multi-admin

- `POST /api/users` (solo admin) crea cuentas `admin|customer`. UI: secciÃ³n
  **Usuarios** del panel. El register pÃºblico sigue forzando `role=customer`.
- **Se eliminÃ³ el demote global de init()** (antes: cualquier admin distinto de
  admin@mymochis.app volvÃ­a a customer en cada boot â€” mataba multi-admin).
- Borrar admins por API sigue bloqueado a propÃ³sito; un admin de mÃ¡s se limpia
  directo en SQLite.

### Mensaje WhatsApp (single source of truth en `src/lib/whatsapp.js`)

- Lo arma el SERVER con: # de pedido (cruce con dashboard), ventana de horario
  real del dÃ­a (`delivery_schedule`), subtotales por sabor/combo en pesos,
  notas, y aviso de que quedÃ³ registrado en el panel.
- La landing ya no arma mensaje propio: hace `await POST /api/orders` y abre el
  `deep_link` de la respuesta. Fallback con mensaje local SOLO si la API falla.

### Bugs corregidos en esta pasada (encontrados por QA)

1. `tienda.html` `#cartSheet` inexistente â†’ `init()` crasheaba y **la tienda
   nunca cargaba catÃ¡logo**. Fix: `#cartSheetBack`.
2. Precios 100Ã— mal: `tienda.html` y el mensaje WSP dividÃ­an entre 100 ($8.500
   â†’ "$85"); tambiÃ©n el chart del panel. Fix: formatear pesos directo.
3. `wa.me` corrompe emojis 4-byte en su redirect (ðŸ¡â†’U+FFFD); verificado
   empÃ­ricamente. Fix: `api.whatsapp.com/send/` en todos los links del repo.
4. Pedidos de la landing enviaban `pickup_day: "Martes"` â†’ 400 silencioso â†’
   **ningÃºn pedido de la landing llegaba al dashboard**. Fix: conversiÃ³n al
   prÃ³ximo `YYYY-MM-DD` real + await del POST.
5. sw.js cache `mochis-land-v8` (renovar precache de index/manage).

### Tests

`npm test` â†’ 11/11: los 7 originales + recipients CRUD/RBAC, multi-admin
sobrevive reinicio, flujo pedidoâ†’dashboardâ†’round-robinâ†’mensaje, y pausa de
nÃºmero. Paridad completa en `worker/` (D1): tabla, ruta, dispatch y users.

## 21. Sistema visual v3 â€” Color + Motion + Shaders

Fecha: 2026-10-19. Estado: **implementado (2026-10-23) â€” ver Â§25**: build Vite +
isla React con shader aurora WebGL nativo (sin three/R3F: el chunk pesaba 817 kB
para un plano de 40 lÃ­neas; el contexto WebGL directo lo hace en <6 kB) y motion
para la entrada del contenido. R3F quedÃ³ descartado por peso. Refs: context7 motion@^12.
**2026-11-02**: el shader aurora fue reemplazado por el shader Silk liquido (`<ShaderBackground>`, ver 21.7) con oscilacion de tonos e interaccion de cursor.

### 21.1 Contexto y decisiones arquitectÃ³nicas

**Hallazgo de marca** (scrape IG `@my.mochiss`, 2026-10-19): la marca real es
**"Mochi's Land"** (no "MyMochis" en la marca visible) y su paleta actual ya es
azul cielo (#3B9BE0) + indigo CTA (#4F5BD5) + mochi cartoon (rosa/marrÃ³n/beige).
El pedido del operador (azul/blanco/gris + rosado claro) es una **refinaciÃ³n
hacia mÃ¡s neutral**, no un rebrand. Tokens derivados del logo + observaciÃ³n.

**DecisiÃ³n arquitectÃ³nica (recomendada):** patrÃ³n **React island** vÃ­a build
step con Vite, replicando el patrÃ³n validado en NX-Studio v0.8.0 (memo #243).
- RazÃ³n: `motion@^12` y `@react-three/fiber` son React-first. Vanilla Motion
  existe pero limita a `animate()` sobre el DOM; no soporta `useAnimate` con
  variantes compuestas ni integraciÃ³n limpia con R3F.
- Costo: 1-2 dÃ­as de setup (Vite + punto de entrada + script tag en HTML).
- Reversibilidad: el `public/` vanilla existente queda intacto; la isla es
  un `<div id="hero-island">` que monta React. Si falla, el fallback es HTML
  estÃ¡tico sin animaciÃ³n.
- Alternativas consideradas:
  - **B) Motion vanilla + CSS shaders**: cero build, drop-in. Sin R3F.
  - **C) HÃ­brido vanilla + Canvas2D raw**: bundle mÃ­nimo, animaciones ricas
    pero shader custom manual.
  - **A) React island (recomendada)**: validaciÃ³n previa en NX-Studio.

**Stack additions (`package.json` devDependencies):**
- `vite@^5` (build step)
- `react@^18.3`, `react-dom@^18.3`
- `motion@^12` (antes `framer-motion`; v12 lo renombrÃ³)
- `three@^0.169`, `@react-three/fiber@^8`, `@react-three/drei@^9`
- `@vitejs/plugin-react@^4`

**Bundle strategy:** isla Ãºnica en landing (`#hero-island`), una en cada
secciÃ³n crÃ­tica (galerÃ­a IG, menu). Resto de `public/*.html` queda vanilla
HTML+JS. Esto mantiene la app <100KB de JS por pÃ¡gina fuera de la landing.

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

  /* Semantic (semÃ¡nticos sobre los raw) */
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
  /* neutros y status idÃ©nticos (escala universal) */
}
```

**Reglas de uso:**
- **NUNCA** usar `--accent-pink-600` en UI base. Solo badges de "Ãºltima
  unidad" / "oferta termina hoy" / "error".
- **NUNCA** mezclar blue-500 (CTA) con blue-400 (focus ring) en el mismo
  elemento; el focus ring debe ser mÃ¡s claro, nunca mÃ¡s oscuro.
- En dark mode, `--bg-elevated` es para cards/popovers; nunca invertir
  `--bg-surface` (queda como el "lienzo" mÃ¡s oscuro).
- Tokens semÃ¡nticos (`--action-primary`, `--text-primary`) sobre los raw
  (`--brand-blue-600`). Los componentes consumen los semÃ¡nticos; los
  raw son para variantes especÃ­ficas (e.g. gradient `from-blue-600 to-blue-400`).

### 21.3 Typography

Mantener stack actual (system font + display). Cambio mÃ­nimo:
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
  // CSS-equivalente de cubic-bezier(0.22, 1, 0.36, 1) â€” "out-expo"
  out:    [0.22, 1, 0.36, 1] as const,
  // cubic-bezier(0.64, 0, 0.35, 1) â€” "in-out"
  inOut:  [0.64, 0, 0.35, 1] as const,
  // cubic-bezier(0.16, 1, 0.3, 1) â€” "out-quart" (mÃ¡s dramÃ¡tico)
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

**Regla de oro:** nunca duraciÃ³n > 0.6s en UI. Shaders y loaders pueden ir a
1-2s. Page transitions mÃ¡ximo 0.6s (percepciÃ³n de respuesta).

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

**PatrÃ³n canÃ³nico (replicado de NX-Studio v0.8.0):**
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

### 21.7 Shader system (isla de fondo, landing)

> **Estado actual (2026-11-02):** el fondo de la landing es `<ShaderBackground>`
> (`web/landing/ShaderBackground.tsx`) — shader "Silk" liquido en WebGL1 nativo
> (cero dependencias, chunk de 5.9 kB gzip), montado en `[data-island="hero-bg"]`
> dentro de `.page-shader` (fixed, z-index 0). Paleta de marca (fresa/durazno/
> ube/matcha/cyan) con mezcla en OKLab y **oscilacion de tonos**: `u_hue` oscila
> con periodo ~45 s (`toneShift=0.45 rad`), asi el fondo viaja entre los tonos
> de la paleta sin cortes. Interactivo: el cursor deforma el campo con un
> vortice suave (effect 2, strength 0.55). Conserva el hardening del shader
> anterior: prefers-reduced-motion (frame estatico), pausa fuera de viewport
> (IntersectionObserver), pausa en background (visibilitychange), cap DPR 2 /
> 2 Mpx. Reemplaza al `<HeroBackground>` aurora (eliminado), que a su vez
> reemplazo al R3F descrito abajo (817 kB de three por 40 lineas de shader).

**Histórico — versión R3F original (reemplazada por aurora WebGL y luego por Silk):**

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

      // Mezcla blue â†” pink soft segÃºn noise
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
- Render condicional con `useReducedMotion()`: si true â†’ fallback a gradient
  CSS estÃ¡tico, sin Canvas.
- Lazy mount con `client:visible` o `IntersectionObserver` para no pagar el
  shader en el primer paint.

### 21.8 Component patterns

**`motion.*` everywhere hay animaciÃ³n.** Reglas:
- Botones: `whileHover={{ y: -1 }}` + `whileTap={{ scale: 0.98 }}`.
- Cards: `variants={fadeUp}` + `whileHover={{ y: -4, scale: 1.02 }}`.
- Modal/sheet: `AnimatePresence` + `initial={{ opacity: 0, y: 8 }}` +
  `exit={{ opacity: 0, y: 8 }}`.
- Page transitions: NO en MyMochis (single-page flow), pero dejar el patrÃ³n
  listo por si se suma multipÃ¡gina.

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
â”œâ”€â”€ public/                     # (existente, intacto)
â”‚   â”œâ”€â”€ index.html              # + <script type="module" src="/landing-island.js"></script>
â”‚   â”œâ”€â”€ tienda.html             # + idem
â”‚   â”œâ”€â”€ manage.html             # + idem
â”‚   â””â”€â”€ ...
â”œâ”€â”€ src/                        # (existente, intacto)
â”‚   â”œâ”€â”€ routes/
â”‚   â”œâ”€â”€ lib/
â”‚   â”œâ”€â”€ db.js
â”‚   â””â”€â”€ server.js
â”œâ”€â”€ web/                        # NUEVO â€” entry points Vite
â”‚   â”œâ”€â”€ landing/
â”‚   â”‚   â”œâ”€â”€ main.tsx            # <AnimatedHero> + <HeroBackground>
â”‚   â”‚   â”œâ”€â”€ AnimatedHero.tsx
â”‚   â”‚   â”œâ”€â”€ HeroBackground.tsx  # R3F
â”‚   â”‚   â”œâ”€â”€ MenuGrid.tsx        # cards de sabores
â”‚   â”‚   â””â”€â”€ variants.ts         # re-export
â”‚   â”œâ”€â”€ tienda/
â”‚   â”‚   â”œâ”€â”€ main.tsx            # (futuro) carrito animado
â”‚   â”‚   â””â”€â”€ ...
â”‚   â”œâ”€â”€ manage/                 # (futuro) panel con transiciones
â”‚   â”œâ”€â”€ styles/
â”‚   â”‚   â”œâ”€â”€ tokens.css          # vars del Â§21.2-21.4
â”‚   â”‚   â””â”€â”€ islands.css         # estilos solo de las islas
â”‚   â””â”€â”€ lib/
â”‚       â”œâ”€â”€ motion-tokens.ts
â”‚       â””â”€â”€ variants.ts
â”œâ”€â”€ vite.config.ts              # NUEVO â€” multi-entry
â”œâ”€â”€ tsconfig.json               # NUEVO
â””â”€â”€ package.json                # + scripts: "dev:web", "build:web"
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
- `prefers-reduced-motion` en CSS tambiÃ©n como red de seguridad:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
- Contraste mÃ­nimo AA (4.5:1 texto, 3:1 UI). Validar con axe-core en CI.
- Focus visible: outline 2px `--focus-ring` + offset 2px, NUNCA `outline: none`
  sin reemplazo.
- `<Canvas>` de R3F lleva `aria-hidden="true"`; el contenido textual del hero
  estÃ¡ fuera del Canvas.
- Shaders no llevan informaciÃ³n; son decorativos. No requieren alt-text.

### 21.11 MigraciÃ³n desde el sistema actual

**Plan por olas (zero-downtime, todos reversibles):**

**Ola 1 â€” Tokens** (1-2h):
1. Crear `web/styles/tokens.css` con Â§21.2-21.4.
2. Importar en `public/index.html` ANTES de cualquier otro CSS.
3. Mapeo de las vars existentes del proyecto a los nuevos tokens semÃ¡nticos.
4. Build del sitio estÃ¡tico NO cambia; solo cambia la paleta.
5. QA visual: dark mode toggle (`localStorage nx-theme` + `<meta name="color-scheme">`).

**Ola 2 â€” Build pipeline** (Â½ dÃ­a):
1. Crear `vite.config.ts` + `tsconfig.json` + `package.json` scripts.
2. Mover entry point mÃ­nimo (`web/landing/main.tsx` con un `motion.div` "Hello").
3. Importar en `public/index.html` como `<script type="module" src="/build/landing.js">`.
4. Verificar que el sitio sigue funcionando CON y SIN el script (degradaciÃ³n
   graciosa: si el bundle falla, el HTML estÃ¡tico sigue).
5. npm scripts: `npm run build:web` antes de `docker build` (en el Dockerfile
   de deploy, agregar `RUN npm run build:web`).

**Ola 3 â€” Isla Hero** (1 dÃ­a):
1. Implementar `<AnimatedHero>` con `useAnimate` + `stagger` + `fadeUp`.
2. Implementar `<HeroBackground>` con el shader aurora.
3. Mover el HTML actual del hero a un `<div id="hero-island">` que monta React.
4. QA cross-browser: Chrome, Firefox, Safari, mobile (Safari iOS especialmente
   â€” WebGL ahÃ­ es mÃ¡s restrictivo).
5. Test de performance: Lighthouse mobile, FCP < 1.8s, TTI < 3.5s.

**Ola 4 â€” Resto de islas** (opcional, +1 dÃ­a):
- `<MenuGrid>` con cards animadas.
- `<GalleryIG>` con masonry + hover.
- `<TiendaCarrito>` con sheet animado.

**Rollback:** borrar `web/`, restaurar `public/index.html`. La paleta CSS
tambiÃ©n se puede revertir comentando el `<link>` de tokens.

### 21.12 Open questions (para el operador)

1. **Â¿Lanzar la Ola 1 (solo tokens) YA sin build step?** Es la mÃ¡s barata y
   ya mejora el sitio. Sin React, sin shader, sin build. Solo CSS vars.
2. **Â¿Dark mode desde el dÃ­a 1 o solo light?** El operador usa el sitio
   mayormente de dÃ­a; dark mode podrÃ­a ser nice-to-have.
3. **Â¿Shader en todas las pÃ¡ginas o solo landing?** Spec actual: solo landing.
   Si se quiere en tienda, +1 ola.
4. **Â¿Migra a Astro en lugar de Vite + HTML?** Astro serÃ­a mÃ¡s limpio (file-
   based routing) pero es un cambio mayor. Lo dejo fuera de scope.

## 22. Backend de pagos digitales v1 â€” spec

Fecha: 2026-10-19. Estado: **implementado â€” el camino automÃ¡tico funciona end-to-end (ver Â§24); faltan credenciales Nequi reales y UI de checkout**. Refs:
artÃ­culos de sistema de pagos (idempotency, webhooks, ledger, outbox, sagas,
reconciliation), docs Nequi API, Daviplata botÃ³n, Bancolombia API Market,
Mercado Pago, NIIO aggregator. PatrÃ³n canÃ³nico del dev.to / singhajit.

### 22.1 Contexto y objetivos

MyMochis hoy recibe pedidos y el cliente paga **off-platform** (transferencia
manual a Nequi/Daviplata/Bancolombia/efectivo). Esto requiere confirmar
manualmente cada pago. El operador quiere digitalizar el cierre del pedido:
que el cliente pague desde la app y el sistema reconcilie automÃ¡ticamente.

**Objetivo:** backend que orqueste cobros a Nequi, Daviplata, Bancolombia
QR, Mercado Pago y (futuro) WhatsApp Pay, con reconciliaciÃ³n diaria, ledger
double-entry, idempotencia duradera, y webhook handlers autenticados.

**Casos de uso primarios:**
- **C1**: cliente confirma pedido â†’ app genera link de pago Nequi push â†’ cliente
  autoriza en su app Nequi â†’ webhook confirma â†’ pedido pasa a "paid".
- **C2**: cliente paga con Daviplata desde el dashboard â†’ DaviPlata notifica
  al backend vÃ­a webhook â†’ pedido se reconcilia.
- **C3**: cliente paga con tarjeta vÃ­a Mercado Pago Checkout Pro â†’ MP webhook
  notifica â†’ pedido se reconcilia.
- **C4**: cliente transfiere manual a Bancolombia (no API) â†’ operador sube
  comprobante + sistema hace match con el pedido.
- **C5 (futuro)**: cliente paga vÃ­a WhatsApp Pay desde el deep-link.

### 22.2 No-objetivos (explÃ­citos)

- **NO** guardar datos de tarjeta crudos (PCI scope reduction). Tokens via
  MP Checkout Pro o tokenizaciÃ³n de Nequi cuando exista.
- **NO** hacer settlement / payouts / acquirer. Cada provider paga al
  operador por su lado; nosotros solo confirmamos "el cliente pagÃ³".
- **NO** subscriptions / recurring billing. Solo one-time.
- **NO** FX / multi-currency. Solo COP.
- **NO** fraud scoring ML. Solo reglas (monto mÃ¡ximo, IP rate limit, etc.).

### 22.3 Arquitectura general

```
Cliente (web/wsp)
  â”‚
  â–¼
[MyMochis app â€” Express]
  â”‚
  â”œâ”€ /api/payments (crear intent, idempotency-key)
  â”‚    â”‚
  â”‚    â–¼
  â”‚  [Payment Service]  â† state machine
  â”‚    â”‚
  â”‚    â”œâ”€ â†’ [Provider Adapter Nequi]  â†’ API Nequi (push)
  â”‚    â”œâ”€ â†’ [Provider Adapter Daviplata] â†’ API DaviPlata
  â”‚    â”œâ”€ â†’ [Provider Adapter MercadoPago] â†’ API MP
  â”‚    â””â”€ â†’ [Provider Adapter Bancolombia] â†’ API Market
  â”‚
  â”œâ”€ /api/webhooks/{provider}  â† POST firmado por cada provider
  â”‚    â”‚
  â”‚    â–¼
  â”‚  [Webhook Handler]  (verify signature â†’ durable inbox â†’ enqueue)
  â”‚    â”‚
  â”‚    â–¼
  â”‚  [Outbox Worker]  (relay eventos a consumers)
  â”‚    â”‚
  â”‚    â–¼
  â”‚  Consumers: orders, notifications, ledger-poster
  â”‚
  â””â”€ /api/admin/reconcile  â† cron diario, operador manual trigger
       â”‚
       â–¼
     [Reconciliation Job]  (ledger vs provider reports)
```

### 22.4 State machine

```
INITIATED â”€â†’ PROCESSING â”€â†’ SUCCEEDED
    â”‚            â”‚              â”‚
    â”‚            â”œâ”€â†’ FAILED    â”‚
    â”‚            â”‚              â”‚
    â”‚            â”œâ”€â†’ REQUIRES_ACTION (cliente debe hacer algo en su app)
    â”‚            â”‚              â”‚
    â”‚            â””â”€â†’ UNRESOLVED  (timeout, red cayÃ³ â€” requiere reconcile)
    â”‚
    â””â”€â†’ EXPIRED  (45min sin acciÃ³n, segÃºn Nequi)
```

**Reglas de transiciÃ³n (con optimistic locking):**
```sql
UPDATE payments
SET state = :next, state_version = state_version + 1, updated_at = :now
WHERE payment_id = :id
  AND state = :expected_state
  AND state_version = :expected_version;
-- Si 0 filas: otro proceso ya cambiÃ³ el estado; recargar y evaluar.
```

**Estados terminales:** SUCCEEDED, FAILED, EXPIRED.
**Estados que pueden transicionar a SUCCEEDED:** PROCESSING, REQUIRES_ACTION,
UNRESOLVED (vÃ­a reconcile), y INITIATED (solo si el provider respondiÃ³
sincrÃ³nicamente con success â€” raro pero posible en algunos flows).

### 22.5 DB schema (SQLite, compatible con D1)

```sql
-- ===========================================================================
-- 1. payments (la "operaciÃ³n" lÃ³gica: pagar pedido X por Y pesos)
-- ===========================================================================
CREATE TABLE payments (
  payment_id        TEXT PRIMARY KEY,                  -- "pay_<uuidv7>"
  merchant_id       TEXT NOT NULL DEFAULT 'mymochis',  -- futuro: multi-merchant
  order_id          TEXT NOT NULL,                     -- FK a orders.id
  amount_minor      INTEGER NOT NULL,                  -- pesos * 100 (COP Ã— 100 = centavos)
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
  payment_id          TEXT,                  -- FK si aplicÃ³
  response_status     INTEGER,               -- status HTTP cacheado
  response_body_json  TEXT,                  -- body cacheado
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  PRIMARY KEY (merchant_id, operation, idempotency_key)
);

-- ===========================================================================
-- 3. payment_attempts (cada interacciÃ³n con un provider)
-- ===========================================================================
CREATE TABLE payment_attempts (
  attempt_id            TEXT PRIMARY KEY,                -- "att_<uuidv7>"
  payment_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,                   -- 'nequi' | 'daviplata' | 'mercadopago' | 'bancolombia'
  provider_idempotency_key TEXT NOT NULL,                -- la que el provider recordarÃ¡
  provider_reference     TEXT,                           -- txn_id / payment_id del provider
  attempt_state          TEXT NOT NULL,                  -- mismo enum que payments.state
  provider_response_json TEXT,                           -- Ãºltimo response del provider
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
  amount_minor    INTEGER NOT NULL,                    -- signed: + debit, - credit (o convenciÃ³n que elijas)
  currency        TEXT NOT NULL DEFAULT 'COP',
  memo            TEXT,
  posted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE RESTRICT
);
CREATE INDEX idx_ledger_payment ON ledger_entries(payment_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account, posted_at);

-- View: balance por cuenta (para reconciliation rÃ¡pida)
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
ALTER TABLE orders ADD COLUMN payment_state TEXT;        -- duplicado denormalizado para queries rÃ¡pidos
```

### 22.6 Idempotency model

**Reglas (dev.to / singhajit):**
1. **Clave durable** en `idempotency_records` con UNIQUE por
   `(merchant_id, operation, idempotency_key)`.
2. **Request fingerprint**: SHA-256 del body canonical. Si misma key con
   fingerprint distinto â†’ 409 Conflict (es OTRO request, no retry).
3. **In-progress behavior**: si el original estÃ¡ corriendo, devolver
   `202 Accepted` con `state=PROCESSING` y el `payment_id`. El cliente puede
   hacer poll a `GET /api/payments/{id}`.
4. **Provider-side idempotency**: cada attempt lleva `provider_idempotency_key`
   (re-uso del mismo si se reintenta el mismo attempt lÃ³gico).
5. **TTL**: el idempotency record NO expira (es durable). El response cacheado
   se mantiene por 24h mÃ­nimo para retries de cliente.

**Flujo de POST /api/payments con idempotency:**
```
1. INSERT INTO idempotency_records (merchant, op, key, fingerprint) â€” atÃ³mico.
   Si UNIQUE violation: recargar el record existente.
2. Comparar fingerprint del nuevo request con el stored.
   - Match + completed_at NOT NULL â†’ devolver el response cacheado.
   - Match + completed_at NULL â†’ 202 con el payment_id en PROCESSING.
   - Mismatch â†’ 409 Conflict.
3. Crear payment (state=INITIATED).
4. Actualizar idempotency_records con payment_id.
5. Llamar provider adapter.
6. Actualizar attempt + state.
7. INSERT outbox_events si terminal.
8. UPDATE idempotency_records SET completed_at=now, response_status, response_body.
9. Devolver response.
```

### 22.7 Outbox pattern

**Por quÃ©:** no podemos hacer `UPDATE payments + PUBLISH payment.succeeded`
atÃ³micamente. Si la app crashea entre ambas, el evento se pierde.

**Tabla `outbox_events` (ver Â§22.5.6) + relay:**

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
    // Si supera N intentos â†’ DLQ (outbox_dead_letters)
  }
}
```

**At-least-once:** el relay puede publicar el mismo evento 2 veces si crashea
post-ack pre-mark. Por eso cada consumer debe ser idempotente (e.g. orders
puede aplicar el `payment.succeeded` con un guard `state_version`).

### 22.8 Webhook handler contract

**Endpoint:** `POST /api/webhooks/{provider}` (uno por provider).

**Reglas del handler (dev.to Â§7):**
1. **Verificar firma** contra los bytes exactos del request. NUNCA confiar
   en el JSON parseado. Para Nequi/Daviplata/MP/Bancolombia cada uno tiene
   su mecanismo (HMAC SHA-256 tÃ­picamente, con timestamp para replay
   protection).
2. **Insertar en `provider_events`** con el `provider_event_id` extraÃ­do.
   Dedupe vÃ­a UNIQUE constraint.
3. **Ack inmediatamente** (HTTP 200) segÃºn el contrato del provider. NO
   procesar sÃ­ncronamente.
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
  amountMinor: number;                // COP Ã— 100
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
  // Estado inmediato (algunos providers devuelven SUCCEEDED aquÃ­)
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
      instructions: 'AbrÃ­ tu app Nequi y aprobÃ¡ el pago.',
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

POST   /api/webhooks/nequi           (no auth â€” verified por signature)
POST   /api/webhooks/daviplata
POST   /api/webhooks/mercadopago
POST   /api/webhooks/bancolombia

POST   /api/admin/payments/reconcile           Trigger manual del reconciler.
GET    /api/admin/payments/reconcile/runs      Historial de runs.
GET    /api/admin/payments/mismatches          Lista de mismatches abiertos.

GET    /api/admin/ledger                       (opcional) VisualizaciÃ³n del ledger.
```

**Request/response canÃ³nico (POST /api/payments):**
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
  "instructions": "AbrÃ­ tu app Nequi y aprobÃ¡ el pago.",
  "expires_at": "2026-10-19T18:00:00Z"
}
```

### 22.11 Reconciliation cron

**CuÃ¡ndo correr:** diario 04:00 COL (despuÃ©s del cierre de batches bancarios
tÃ­picamente). Manual trigger desde `/api/admin/payments/reconcile`.

**Estrategia de 2 capas:**

**Capa 1 â€” Operational reconciliation (cada 5 min, solo UNRESOLVED):**
```sql
SELECT * FROM payments
WHERE state IN ('PROCESSING', 'UNRESOLVED')
  AND updated_at < datetime('now', '-2 minutes');
```
Para cada uno, llamar `adapter.getPaymentStatus(providerRef)` y aplicar
state transition.

**Capa 2 â€” Financial reconciliation (diaria, full sweep):**
1. Por cada provider, descargar el report del dÃ­a anterior (API o CSV).
2. Comparar cada `provider_reference` del report con `payment_attempts` local.
3. Detectar:
   - **Missing webhooks**: provider reporta SUCCEEDED, local sigue PROCESSING â†’
     aplicar transiciÃ³n + postear ledger.
   - **Phantom payments**: provider NO reporta nada, local dice SUCCEEDED â†’
     INVESTIGAR (no auto-flip; posible bug).
   - **Amount mismatch**: provider dice X, local dice Y â†’ quarantine.
4. Reporte en `reconciliation_runs` con array de mismatches.

**Mismatches que NO se auto-resuelven** (siempre requieren operador):
- Phantom payments (local dice SUCCEEDED, provider no encuentra).
- Amount mismatch.
- Refunds no reflejados.

**Mismatches que SÃ se auto-resuelven** (con log):
- Missing webhooks (provider confirma SUCCEEDED, local rezagado) â†’ aplicar
  transiciÃ³n con nota `reconciled_at`.

### 22.12 Provider-specific notes

**Nequi (`/payments/v2/-services-paymentservice-generatecodeqr`):**
- API push: el cliente recibe notificaciÃ³n en su app Nequi.
- Espera `customer_phone`. Si no, solo QR.
- Webhook firma: HMAC-SHA256 sobre body con `X-Nequi-Signature` header.
- Timeout: 45 minutos (configurable).
- Sandbox: requiere onboarding con Nequi (no pÃºblico; tramitamos).
- DocumentaciÃ³n: https://www.nequi.com.co/negocios/apis

**Daviplata (BotÃ³n DaviPlata):**
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
- TokenizaciÃ³n fuera de PCI scope (Checkout Pro hosted).
- DocumentaciÃ³n: https://www.mercadopago.com.co/developers/en/reference

**WhatsApp Pay (futuro):**
- Requiere Meta Business verification (30+ dÃ­as).
- Spec adelantada, NO implementar hasta approval.

**NIIO aggregator (opcional):**
- 1 sola integraciÃ³n para PSE, Nequi, Daviplata, Bancolombia, cards, crypto.
- Fee por transacciÃ³n.
- Trade-off: vendor lock-in vs simplicidad.
- DocumentaciÃ³n: https://pay.niiopay.com/docs

### 22.13 Money handling

- **TODO en pesos Ã— 100 = centavos (integer)**, NUNCA float.
- Schema: `INTEGER` (en SQLite, 8 bytes safe hasta ~9.2 Ã— 10^18).
- COP no tiene sub-centavo; redondear al entero.
- Display: helper `formatCOP(minor) â†’ '$25.000'` (sin decimales).
- Regla operativa: NUNCA `parseFloat` ni `Number()` en dinero. Solo
  `Math.trunc` y operaciones con integers.

### 22.14 Security y PCI scope

- **Card data**: NUNCA tocan nuestro backend. Siempre Checkout Pro (MP) o
  redirect a provider (Nequi, Daviplata). PCI scope = SAQ-A (mÃ­nimo).
- **Secrets**: `NEQUI_API_KEY`, `MP_ACCESS_TOKEN`, `BANCO_WEBHOOK_SECRET`
  viven en dark-memory keyring / Windows Credential Manager. NUNCA en
  archivos del repo. Solo la REFERENCIA (`credentials_ref`) en DB.
- **Webhooks**: signature verify obligatorio. Reject 401 si falla.
- **Idempotency keys**: scope per-merchant (default `mymochis`).
- **RBAC**: solo admin puede `GET /api/admin/payments/*`, `POST /refund`,
  `POST /reconcile`. Customer solo ve sus propios payments.
- **Audit log**: `reconciliation_runs` + `provider_events` ya son audit trail.
  Sumar `audit_log` table para acciones admin (refunds, manual override).

### 22.15 MigraciÃ³n desde el sistema actual

**Ola 0 â€” Schema (sin tocar UI, ~1h):**
1. Correr migrations de Â§22.5 sobre DB local.
2. Migrar `payment_methods` para sumar `provider` y `enabled`.
3. Verificar que `npm test` sigue 11/11 (no debe romperse).

**Ola 1 â€” Adapter Nequi + endpoint POST /api/payments (1-2 dÃ­as):**
1. Implementar `NequiAdapter` con sandbox (credenciales de Nequi business).
2. Crear ruta `POST /api/payments` con idempotency.
3. Crear handler `POST /api/webhooks/nequi` con signature verify.
4. Tests: 8 nuevos (idempotency, state machine, signature, outbox).
5. QA manual en sandbox: crear payment, simular webhook, ver SUCCEEDED.

**Ola 2 â€” Outbox + workers (1 dÃ­a):**
1. Implementar `outbox-relay` y `process-events` workers.
2. Decidir: Â¿cron cada 30s, o `setInterval` in-process?
   RecomendaciÃ³n: in-process setInterval (Express app), con restart
   recovery del sweep.
3. Test: simular crash entre INSERT outbox y PUBLISH â†’ recover on next sweep.

**Ola 3 â€” Reconciler (1 dÃ­a):**
1. Operational reconciliation cada 5 min (in-process setInterval).
2. Financial reconciliation diario 04:00 COL (in-process timer).
3. UI admin: `/admin/reconcile.html` con botÃ³n "Run now" + lista de runs.

**Ola 4 â€” Daviplata + Mercado Pago (2-3 dÃ­as):**
1. Repetir el patrÃ³n de Nequi para los 2 providers.
2. UI de selecciÃ³n de mÃ©todo al confirmar pedido.

**Ola 5 â€” Bancolombia QR (1 dÃ­a):**
1. Migrar la opciÃ³n "Bancolombia" de manual-transfer a QR + webhook.
2. UI: mostrar QR generado, esperar webhook, mostrar "Â¡Listo!".

**Rollback:** las migrations son `CREATE TABLE` / `ALTER TABLE ADD COLUMN`,
ambas reversibles. `DROP TABLE` no se necesita; en el peor caso borrar las
tablas nuevas.

### 22.16 Open questions (para el operador)

1. **Â¿Nequi sandbox account existe ya?** Si no, Â¿la tramitamos nosotros
   (necesita RUT/NIT del negocio del amigo) o lo hace el operador?
2. **Â¿MP sandbox token estÃ¡ disponible?** (gratis en MP developers).
3. **Â¿NIIO aggregator o integraciÃ³n directa por provider?** Trade-off:
   simplicidad (NIIO) vs lock-in + fee (NIIO) vs control (directo).
4. **Â¿Auto-cobro al confirmar pedido o step manual del operador?** Hoy el
   operador confirma cada pedido. Spec asume auto-cobro al confirmar.
5. **Â¿LÃ­mite de monto por transacciÃ³n?** (recomendaciÃ³n: 5M COP / attempt).
6. **Â¿Refunds desde el panel admin?** Spec dice sÃ­, pero requiere
   implementaciÃ³n de `POST /api/payments/:id/refund` por provider.
7. **Â¿WhatsApp Pay cuÃ¡ndo?** NO para v1, esperar Meta approval.

### 22.17 Riesgos y mitigaciones

| Riesgo | Impacto | MitigaciÃ³n |
|---|---|---|
| Nequi webhook se pierde | Pedido queda PROCESSING forever | Reconciler capa 1 cada 5min |
| Provider downtime | Pagos fallan | Mostrar "sistema caÃ­do, intenta mÃ¡s tarde"; reconciler recover |
| Customer paga pero webhook nunca llega + reconciler tampoco | Pedido sin cerrar | UI: "si pagaste y no se reflejÃ³, escribinos por WSP"; operador tiene vista admin para manual flip |
| Idempotency key mal generado por bug del cliente | Duplicados o "lost" payments | Validar fingerprint; 409 explÃ­cito si mismatch |
| Outbox relay duplica eventos | Orders procesados 2 veces | Consumer-side idempotencia con `state_version` |
| DB corruption en SQLite | Ledger pierde entries | Backup R2 cada 24h (Â§8 ya documentado) + verify en startup |
| PCI scope creep si guardamos tarjeta | AuditorÃ­a, multas | Test E2E obligatorio: ningÃºn endpoint acepta card data |

---

## 23. Fecha de recogida: el cutoff manda, no el calendario â€” 2026-10-21

Regla: **el cliente nunca ofrece una fecha que el backend va a rechazar.** El
`<select>` de "DÃ­a de recogida" se puebla desde lo que el server declara
aceptable, no desde una aproximaciÃ³n del calendario del cliente.

### 23.1 Por quÃ© el flag lo calcula el server

`GET /api/public` publica por cada release_window:

| Campo | Significado |
|---|---|
| `orderable` | `status === 'open'` **Y** el cutoff no ha vencido. Es lo que el cliente puede ofrecer. |
| `not_orderable_reason` | `window_not_open` Â· `past_cutoff` Â· `no_pickup_schedule` |
| `cutoff_computed_at` | El instante del cutoff, para depurar sin leer cÃ³digo. |

El cÃ¡lculo vive en `pickupCutoffFor()` (`src/routes/orders.js`), que es la
**misma funciÃ³n** que usa `validateScheduled()` para rechazar el pedido. Una
sola copia de la regla. Cuando existieron dos â€”el server rejecting y el front
calculando por su cuentaâ€” divergieron, y esa divergencia era el bug: el
cliente ofrecÃ­a una fecha, el usuario llenaba el formulario entero y recibÃ­a un
`400 past_cutoff` sin explicaciÃ³n Ãºtil.

**No reimplementar la regla del cutoff en el front.** Si el server no manda el
flag, el cliente cae a `status + fecha` solo para no quedar inservible.

### 23.2 Orden de inicializaciÃ³n (bug que se llevÃ³ 4 dÃ­as sin commitear)

`configureDateInput()` se llamaba **antes** del `fetch` del catÃ¡logo, asÃ­ que
`catalog` era `undefined` y el `<select>` se renderizaba siempre deshabilitado
con "Sin dÃ­as abiertos por ahora". La tienda no aceptaba ningÃºn pedido. Todo
setup derivado de datos traÃ­dos por fetch va **debajo** de la asignaciÃ³n,
junto a los demÃ¡s `render()`.

### 23.3 BUG ABIERTO â€” el cutoff corre 5 horas adelantado (t_f6d7dd48)

`combineDateAndTime()` construye el cutoff con `Date.UTC(y, m, d, hh, mm)`, o
sea interpreta `"15:00"` como **15:00 UTC**. El negocio opera en Colombia
(UTCâˆ’5):

```
Negocio cree:   pickup 15:00 local â†’ cutoff 07:00 local
CÃ³digo computa: 15:00 UTC âˆ’ 8h     = 07:00 UTC = 02:00 local
                                        â†‘ 5 horas antes
```

Los pedidos se cerraron a las **2:00 AM** cuando el dueÃ±o pensaba que cerrarÃ­an a
las 7:00 AM. No se arreglÃ³ porque altera *cuÃ¡ndo vende el negocio*, que es
decisiÃ³n del operador, no una correcciÃ³n tÃ©cnica.

> **Corrección de estado (2026-11-02).** Esta sección decía "bug abierto" pero el
> código ya lo resolvió: commit `bc2724c` (2026-10-22) aplicó el fix y fijó la
> regresión en `test/audit-regression.test.js`. `combineDateAndTime()` ya no usa
> `Date.UTC` crudo: resta `BUSINESS_TZ_OFFSET_MINUTES = -300`
> (`src/lib/business-time.js:2`, `src/routes/orders.js:67-68`, y el espejo
> `worker/routes/orders.js:49-53`). Se conserva el análisis original porque
> explica la clase de bug: interpretar una hora local como UTC.
>
> **Fuente de cutoff oficial (decidido):** el computado desde
> `delivery_schedule` (`pickupCutoffFor`, `src/routes/orders.js:88-105`). La
> columna `release_windows.cutoff_at` queda como dato informativo.

Decidir antes de tocarlo:
1. Â¿La zona horaria canÃ³nica es Colombia? Entonces `combineDateAndTime` debe
   construir hora local, no UTC. Opciones: una columna `tz` en `config`, o
   `America/Bogota` fijo (UTCâˆ’5, sin DST desde 2015).
2. Hay dos fuentes de cutoff â€”la columna `release_windows.cutoff_at` y el
   computado desde `delivery_schedule`â€” y hoy la segunda manda sola. Â¿CuÃ¡l es
   la oficial?

### 23.4 Estado al 2026-10-21

Las 3 ventanas abiertas en la DB (2026-10-15, 10-20, 10-21) tienen su cutoff ya
vencido, asÃ­ que la tienda muestra correctamente "no abrimos por ahora". Para
volver a vender hay que abrir ventanas futuras; no es un bug del cÃ³digo.

## 24. Pagos: el camino automÃ¡tico funciona end-to-end â€” 2026-10-23

Cierre de la ola P0 del backend de pagos (spec_id=25). La cadena completa
**webhook â†’ transitionState â†’ outbox â†’ relay â†’ consumer â†’ pedido pagado + stock
comprometido** estÃ¡ implementada, testeada y commiteada (e261c03..477b1bc):

| Pieza | DÃ³nde | Nota |
|---|---|---|
| Reservas compartidas | `src/lib/stock.js` | commit/release salen de routes/orders.js; las necesita el consumer sin cerrar el ciclo de imports |
| Relay del outbox | `src/lib/payments/relay.js` | drenaje compartido server/Worker; antes el server **nunca drenaba** y `payment.succeeded` morÃ­a en la cola |
| Consumer de pago OK | `src/lib/payments/consumers.js` | `payment.succeeded` marca el pedido pagado **y convierte la reserva en venta** |
| Estado real vs dominio | `src/lib/payments/index.js` | `orders.payment_state` lleva el estado del grafo (SUCCEEDEDâ€¦); `payment_status` el dominio (pending\|paid) |
| Nequi fail-closed | `src/lib/payments/adapters/nequi.js` | sin `NEQUI_API_KEY` lanza; el mock solo entra con `NEXOMOCHIS_ALLOW_PROVIDER_FALLBACK=1` |
| KPIs limpios | `src/routes/metrics.js` | gross/hoy/last_7/serie diaria excluyen cancelados |

**RegresiÃ³n:** `test/payment-auto-flow.test.js` fija la cadena completa con
workers activos (relay a 500ms via `MYMOCHIS_OUTBOX_RELAY_INTERVAL_MS`), el
dedupe del inbox y que `SUCCEEDED` es punto de no retorno. Suite 88/88.

**LecciÃ³n de la sesiÃ³n:** el webhook marca `payment_status='paid'` de forma
*sincrÃ³nica* (transitionState) pero el stock llega *async* por el relay â€” el
test debe esperar el efecto de negocio (reservaâ†’0, soldâ†’qty), no la
denormalizaciÃ³n intermedia, o es una carrera.

**Pendiente para cerrar pagos del todo:** (1) credenciales Nequi reales (hoy el
adapter fail-closed; requiere sandbox + aprobaciÃ³n), (2) que la tienda llame
`POST /api/payments` â€” hoy ninguna pantalla lo invoca, el cliente sigue pagando
por transferencia y el operador confirma a mano, (3) deploy (Â§18 sigue siendo el
runbook vigente).

## 25. Frente visual â€” onda del 2026-10-23 (spec_id=26)

Estado: **implementado**. Commits b0d4b4b..e5aebe8. Suite 88/88.

| Cambio | DÃ³nde | Commit |
|---|---|---|
| WSP al admin al confirmar pago (auto + manual) | `src/lib/payments/order-notify.js` | b0d4b4b |
| Logo footer 72px, redes 32px, NX-Studio, privacidad, sin Marketing | `index.html` + `manage.html` | 6f155e7 |
| SecciÃ³n **ProducciÃ³n** (insumos, costo/lote, unitario, margen; localStorage a la espera de API propia) | `manage.html` | ddef815 |
| Checkboxes clay + botÃ³n entrega inmediata fresa | `manage.html` | ddef815 |
| SecciÃ³n **Fotos**: subir a categorÃ­a marketplace + "Usar como hero" (`PUT /api/config`) | `manage.html` | 240bab0 |
| Hero de la landing usa `config.hero_image_url` (foto del admin) | `index.html` | 0eea9fc |
| Promos como popout flotante | `index.html` | a58229b |
| Carrito: lÃ­neas clay + qty +/âˆ’ | `tienda.html` | a0730a1 |
| **Shader aurora ambiental** fijo detrÃ¡s de toda la pÃ¡gina, paleta v5 (cieloâ†’sakuraâ†’mist) | `web/` + `index.html` | 0eea9fc |
| Doble footer eliminado (isla de contenido montada al final del body) | `index.html` | 0eea9fc |
| Meta CSP sin `frame-ancestors` (console limpia; helmet manda el header) | `index.html` | 0eea9fc |
| Dockerfile multi-stage: `npm run build:web` antes de empaquetar (public/build es gitignored) | `Dockerfile` | e5aebe8 |

**LecciÃ³n:** el bundle de las islas (Â§21) nunca se habÃ­a compilado â€” `/build/landing.js`
y `islands.css` daban 404 y la isla de contenido quedÃ³ montada al final del body,
viÃ©ndose como "un segundo footer con shaders". Una isla sin build verificado no
estÃ¡ implementada.

**Pendiente de esta onda:** producciÃ³n aÃºn persiste en localStorage (migrar a
tabla + endpoints cuando el operador quiera historial real); secciÃ³n Cobros del
panel se puede retirar cuando el checkout UI (Â§24.2) exista.

## 26. Onda spec_id=30 â€” checkout, panel sin redundancia y UI en espaÃ±ol

Estado al 2026-10-23: **en curso**. Commits 87c3f07 + a44a3ad. Suite 93/93.

**Panel sin redundancia (87c3f07):** fuera Cobros/Fotos/MÃ©todos de pago del
sidebar (Cobros accesible desde Pedidos; portada dentro de Productos; mÃ©todos
en Entregasâ†’pagos). "Sabores" â†’ "Productos" (portafolio ampliable). "Dashboard"
â†’ "Panel". UI entendible sin saber programar ni inglÃ©s: estados en espaÃ±ol
(vÃ­a `STATUS_ES` â€” los valores que viajan al server siguen siendo los ingleses),
chips traducidos, login sin endpoints. FIX: `render.dashboard` crasheaba en
`by-status` (elemento huÃ©rfano) â€” el panel llevaba tiempo a media render;
cazado con Playwright, bloque muerto eliminado.

**Checkout con domicilio por distancia (a44a3ad):** el carrito elige recoger
vs domicilio; en domicilio, `POST /api/delivery/quote` geocodifica (Nominatim
con cachÃ©), mide haversine al centro de la zona y cotiza **tarifa base +
precio por km redondeada a $50** (estilo DiDi/Rappi). La fÃ³rmula vive en
`src/lib/delivery-fee.js` â€” fuente Ãºnica compartida con POST /api/orders.
Config nueva `delivery_immediate_base_fare_cents` / `_price_per_km_cents`
(defaults 0 = tarifa plana, backward compatible). El carrito tambiÃ©n elige
forma de pago (efectivo o los `payment_methods` del admin â†’ `payment_method_id`).
Domicilio desactivado = pill deshabilitada con explicaciÃ³n.

**Pendiente del spec_id=30:** G3 producciÃ³n persistente + analÃ­ticas de unit
economics, G4-01 captura de Instagram (requiere conectar la cuenta del negocio),
G2-03 pasada responsiva multi-dispositivo, G5-01 shaders visibles en secciones
de fondo opaco.

### 26.1 Cierre de la onda â€” 2026-10-24 (spec_id=30 COMPLETO)

Commits `7bdbeea` (checkout) + `05e84d2` (aurora), suite **99/99**, push
`ec9d925..05e84d2`.

**G5-01 â€” la aurora se ve a travÃ©s de las secciones (05e84d2).** El shader WebGL
vive en `.page-shader` con `z-index: -1`, pero el `body` tenÃ­a `background-color`
opaco: en el orden de pintado, un hijo con `z-index: -1` se dibuja **antes** del
fondo del body, asÃ­ que la aurora quedaba tapada (por eso "pintado" no era lo
mismo que "visible"). El body pasa a `color-mix(... 80%, transparent)` y las
secciones tambiÃ©n (`.combos` / `.gallery` / `.how-it-works` â†’ canvas-2 al 78 %,
`.why` â†’ canvas al 74 %, `.releases` â†’ gradiente con ambos stops al 80 %).
Verificado con Playwright: body `rgba(1,1,1,0.8)`, secciones 0.78 / 0.74, canvas
WebGL 1280Ã—720 montado, consola 0 errores.

**Checkout electrÃ³nico cierra el hueco #330 (7bdbeea).** El WIP traÃ­a
`submitOrder` calculando `payInfo` (mÃ©todo + intent de pago) pero
`showSuccess(order)` **ignoraba el segundo argumento**: el `#successPay` quedaba
siempre vacÃ­o y oculto, asÃ­ que el cliente nunca veÃ­a cÃ³mo pagar. Ahora
`showSuccess(order, payInfo)` pinta "CÃ³mo pagar tu pedido" con las instrucciones
del mÃ©todo, la cuenta del negocio (primer `payout_accounts`) cuando existe, y el
link de la pasarela electrÃ³nica cuando el intent devuelve `deep_link`.
Verificado e2e en dev: pedido `#03a2ddf3` creado, `#successPay` visible
(`display: block`) con tÃ­tulo + instrucciones; sin link porque Nequi estÃ¡
fail-closed sin credenciales (401) y el flujo manual continÃºa â€” por diseÃ±o.
El `pay-box` solo aparece si hay mÃ©todo de pago elegido.

**VerificaciÃ³n:** suite 99/99; e2e Playwright en landing (fondos con alpha +
canvas WebGL) y en tienda (pedido + pay-box); consola 0 errores salvo el 401
esperado de `/api/payments` (fail-closed de la pasarela).

**Pendiente del operador (fuera del cÃ³digo):** token de Instagram del negocio
(Credencialesâ†’Instagram), credenciales Nequi reales, DEPLOY OCI (Â§18/Â§19) y
limpiar las dos `release_windows` sembradas en dev para QA (2026-10-25 domingo
y 2026-10-30 viernes, 50 unidades de `clasico-fresa`).

## 27. Onda visual 2026-10-28 â€” tienda clay, panel responsive y compra al back-end

Cierra el pedido de rediseÃ±o: la tienda deja de ser una pÃ¡gina "del sistema" y
comparte el lenguaje visual de la landing (aurora + superficies de cristal), el
panel deja de empujar la pÃ¡gina en mÃ³vil, y el formulario de compra alimenta el
back-end con los datos que el operador necesita.

### 27.1 Tienda: la aurora y el cristal

La tienda tenÃ­a su propio fondo opaco (`--clay-canvas` al 100 %) y tarjetas
opacas, asÃ­ que se veÃ­a plana frente a la landing. Ahora:

- `body` a `color-mix(in srgb, var(--clay-canvas) 70%, transparent)` + los
  cuatro halos de color, igual que la landing.
- `.page-shader` con el island `hero-bg` (mismo bundle `/build/landing.js`) y
  **fallback CSS**: sin WebGL o sin bundle la pÃ¡gina sigue teniendo ambiente.
- `main`/`footer` en `z-index: 1` y el shader en `0` â€” sin esto el contenido
  in-flow queda por debajo del shader.
- Rejilla de puntos (`body::after`) como textura fina sobre la aurora.
- `.product-card`, `.cart-sheet` y `.success-card` pasan a superficie de
  cristal (`backdrop-filter: blur() saturate()` + borde claro + fondo al 82 %).
- El destacado conserva su tinte crema, tambiÃ©n translÃºcido: opaco tapaba la
  aurora justo en la tarjeta que mÃ¡s se mira.

### 27.2 Formulario de compra â†’ back-end

Dos huecos reales entre la tienda y el panel:

- **TelÃ©fono.** La tienda mandaba los 10 dÃ­gitos locales; el panel y el
  despacho de WhatsApp trabajan con nÃºmeros completos. Ahora la tienda (y el
  pedido manual del panel) completan el `57` cuando el nÃºmero es local de 10
  dÃ­gitos.
- **Punto de referencia.** El domiciliario no tenÃ­a forma de saber la
  referencia ("portÃ³n azul") porque `orders` no tiene columna para eso. Viaja en
  `notes` con el prefijo `Referencia:` y el operador lo ve en la tabla y en el
  detalle del pedido.

### 27.3 Panel: lo que la API ya traÃ­a y la tabla no mostraba

`rowToOrder` ya devolvÃ­a `delivery_mode`, `delivery_address`,
`delivery_fee_cents`, `delivery_distance_km`, `delivery_free_applied`,
`source`, `payment_method_id` y `release_window_id`. Nada de eso se veÃ­a.

- La fila ahora lleva el chip de entrega (ðŸª Recogida / ðŸ›µ Domicilio), el chip
  de origen, la direcciÃ³n, el costo del domicilio y el mÃ©todo de pago.
- BotÃ³n ðŸ”Ž que abre el **detalle del pedido**: cliente, WhatsApp, dÃ­a, entrega,
  origen, mÃ©todo de pago, estado del pago, direcciÃ³n, distancia, costo,
  coordenadas, ventana de producciÃ³n, notas y productos con precios.
- BotÃ³n **âž• Nuevo pedido**: el canal real del negocio es WhatsApp y el
  operador no tenÃ­a forma de registrar ese pedido â€” quedaba fuera de las
  mÃ©tricas, del stock y de la caja. El formulario usa el **mismo endpoint que
  la tienda** (`POST /api/orders`), asÃ­ que el pedido entra por la misma
  tuberÃ­a: valida la ventana, reserva stock, recalcula el total en el server y
  dispara el WhatsApp.

Los ids viajan en `data-*` con un listener delegado, nunca interpolados en un
`onclick`: un `flavor_id` con apostrofe cerraba el atributo (el mismo bug que
ya se corrigiÃ³ en los botones de ediciÃ³n).

### 27.4 Bug de responsive: la tabla estiraba la pÃ¡gina

Con la fila real (direcciÃ³n, notas y chips), `documentElement.scrollWidth` daba
**852 px en un viewport de 375**. Causa: con la `<table>` en `static` y las
`th` en `sticky`, el ancho mÃ­nimo de la tabla se escapa del clip de
`.table-wrap` y el scroll horizontal se va a la pÃ¡gina entera. Con
`position: relative` en la tabla el overflow queda dentro del contenedor. A
â‰¤560 px ademÃ¡s `table { min-width: 460px }` y `overflow-wrap: anywhere`, para
que una direcciÃ³n larga no estire la tabla.

### 27.5 VerificaciÃ³n

- `npm test` â†’ **131/131**.
- `npx playwright test` â†’ **54/54** en 3 viewports (375 / 768 / 1440):
  - `e2e/tienda.spec.ts`: la aurora se monta (`canvas` dentro de
    `.page-shader`), el body es translÃºcido y las tarjetas tienen
    `backdrop-filter`.
  - `e2e/dashboard.spec.ts` (nuevo): login, el formulario de compra abre con
    los dÃ­as de la ventana y sus productos, el total se calcula, el pedido
    creado aparece en la tabla con sus chips, el detalle lo muestra y el
    panel no desborda en mÃ³vil.
- `npm run build:web` verde; el dev server sirve `/`, `/tienda.html` y
  `/manage.html` con 200 y `/api/health` = `{"ok":true}`.

## 28. Onda 2026-10-29 (cerrada el 2026-11-01) â€” base compartida, modal de pedido y el panel clay

Cierra el trabajo visual que quedÃ³ sin commitear el 2026-10-29, con la auditorÃ­a
real del panel del 2026-10-31 como filtro. Siete commits atÃ³micos, del mÃ¡s general
al mÃ¡s puntual: `ui.css` â†’ onda de las pÃ¡ginas pÃºblicas â†’ fix del overlay â†’ onda
del panel â†’ fix de checkbox y KPI â†’ test del CTA â†’ documentos.

### 28.1 La base visual sale de las pÃ¡ginas (`public/ui.css`)

Las cuatro pÃ¡ginas (landing, tienda, cocina, panel) tenÃ­an su propia copia de
superficie, botones, campos, tablas y badges. Ahora la base vive en
`public/ui.css` y cada pÃ¡gina conserva solo lo suyo. El panel mantiene su
densidad de herramienta (14 px); la landing y la tienda, su aire.

`theme.css` queda como la fuente de tokens: la paleta clara y la oscura, con
los alias `--mochi-*` y `--clay-*` que usa el cÃ³digo.

### 28.2 Landing: el modal de pedido

El hero ya no lleva a la tienda: abre un modal de 2 pasos (quÃ© te antoja â†’
datos, tipo de entrega, mÃ©todo de pago). Es la primera vez que la landing
crea pedidos contra el back-end sin salir de la pÃ¡gina.

### 28.3 Tres bugs de render (y por quÃ© la auditorÃ­a mattered)

- **El overlay del modal tapaba la landing entera.** El modal se muestra con el
  atributo `hidden`, pero su `style` inline traÃ­a `display:flex`, que le gana al
  `[hidden]` del navegador: el overlay (`inset:0`, `z-index:1000`) quedaba
  siempre encima y **nada era pulsable**. El layout del modal pasa a una regla
  de autor que respeta `[hidden]`.
- **El checkbox clay caÃ­a encima de su texto.** `.form-group label::before`
  dibujaba una caja y ademÃ¡s `span.check-text` â€”el elemento que *contiene* el
  textoâ€” se forzaba a 20Ã—20 con borde y fondo. Ahora la caja la dibuja
  `span.check-text::before` y el texto conserva su caja.
- **El KPI de pedidos pendientes flotaba sobre el panel.** Usaba
  `class="kpi mochi"` y `.mochi` es la mascota flotante de 48 px con su
  animaciÃ³n: la tarjeta se quedaba en 48Ã—48, flotando, y el grid del panel
  repartÃ­a mal sus columnas. El acento pasa a `.kpi crema`.

Los tres eran **collisiones de nombre o de cascada**, no fallos de lÃ³gica: el
cÃ³digo hacÃ­a lo correcto, el CSS decidÃ­a otra cosa.

### 28.4 Lo que NO se hizo (decisiÃ³n de arquitectura)

`EVALUACION_ARQUITECTURA.md` (sin commitear hasta esta onda) propone
PostgreSQL + Drizzle + Astro + Tailwind. **No es la arquitectura vigente.** El
MVP del panel se queda en el stack actual â€”Express + `node:sqlite` + HTML/CSS/JS
con islas Viteâ€” porque el backend ya tiene outbox transaccional, idempotencia,
ledger de doble entrada y reconciliaciÃ³n, verificados con 153 tests, y
reescribir 97 endpoints para el MVP de administraciÃ³n es riesgo sin beneficio.
`MVP_ARQUITECTURA_OPENSOURCE.md` sÃ­ es compatible con esa decisiÃ³n (SQLite +
Node + JS/HTML/CSS, sin build step obligatorio).

### 28.5 VerificaciÃ³n

- `npm test` â†’ **131/131**.
- `npx playwright test` â†’ **54/54** en 3 viewports (375 / 768 / 1440).
- El test del CTA del hero se reescribiÃ³: esperaba la navegaciÃ³n a la tienda y
  el hero ya abre el modal; ahora comprueba que el modal arranca oculto, que el
  CTA lo abre con su panel y que se cierra.
- RevisiÃ³n visual con login real en el panel (375/768/1440): los 12 secciones
  renderizan, el checkbox se ve en los dos estados y el dashboard ya no tiene
  tarjetas pisadas.
- `gitleaks` limpio en los 7 commits.

## 29. MM-32 â€” los 5 P0 del panel y 3 bugs mÃ¡s que traÃ­a el WIP (2026-11-01)

Cierra la spec MM-32 (10/10 tareas). 11 commits atÃ³micos: uno por cambio
lÃ³gico, del mÃ¡s general al mÃ¡s puntual.

### 29.1 Lo que la auditorÃ­a del 2026-10-31 atribuyÃ³ mal

- **El checkbox roto no lo introdujo el WIP sin commitear**: ya estaba en
  `HEAD` (commit `cb651fd`). La causa era `.form-group label::before` (que
  dibuja una caja) **mÃ¡s** `span.check-text` forzado a 20Ã—20 con borde y fondo
  â€”el texto dentro de una cajaâ€”. La caja ahora la dibuja
  `span.check-text::before` y el texto conserva la suya.
- **El "KPI solapado" era una colisiÃ³n de clases**: la tarjeta de pedidos
  pendientes usaba `class="kpi mochi"` y `.mochi` es **la mascota flotante**
  de 48 px con su animaciÃ³n. La tarjeta quedaba en 48Ã—48 flotando sobre el
  panel y el grid repartÃ­a mal sus columnas. El acento pasa a `.kpi crema`.

### 29.2 Tres bugs que la auditorÃ­a no vio (venÃ­an del WIP)

- **La landing entera era inclicable.** El modal de pedido se muestra con el
  atributo `hidden`, pero su `style` inline traÃ­a `display:flex`, que le gana
  al `[hidden]` del navegador: el overlay (`inset:0`, `z-index:1000`) quedaba
  siempre encima. Por eso el CTA del hero no navegaba y el e2e fallaba por
  tiempo de espera en los tres viewports.
- **El modal de pedido no podÃ­a crear pedidos.** Mandaba un payload inventado
  (`customer_address`, `delivery_type`, `total_cents`, `items` como array) y
  `POST /api/orders` respondÃ­a 400 siempre. Ahora usa el contrato real (`id`,
  `pickup_day`, `items` como mapa, `combos` como array, `delivery_mode`,
  `payment_method_id`), elige el dÃ­a de recogida entre las ventanas abiertas
  del server y el total del domicilio sale de la configuraciÃ³n, no de un
  `5000` fijo.
- **El paso 2 del modal se re-renderizaba** al cambiar el tipo de entrega y
  vaciaba lo que el cliente habÃ­a escrito. Ahora se captura antes de
  re-renderizar.

### 29.3 Los 5 P0 del panel

| P0 | Causa | Cierre |
|---|---|---|
| XSS almacenado desde `orders.id` | El id lo elige el cliente en un endpoint pÃºblico y el panel lo interpolaba crudo en atributos y cÃ³digo | El servidor acota el formato (`/^[A-Za-z0-9_-]{1,64}$/`); el panel lo mueve a `data-payload` con listener delegado; 3 tests de regresiÃ³n |
| `_paymentMethods` siempre vacÃ­o | El panel leÃ­a `payMethods.methods`; la API devuelve un array plano | Se acepta el array (y el envelope) |
| Cambio de estado sin confirmar | Un `<select onchange>` cancelaba pedidos y devolvÃ­a el stock reservado sin preguntar | Pide confirmaciÃ³n (avisando que se devuelve el stock) y el `select` vuelve atrÃ¡s si se rechaza |
| Umbral de dÃ­a gratis Ã—100 | En esta app los `*_cents` son **pesos COP** (`delivery-fee.js`), el panel dividÃ­a y multiplicaba por 100 | Se muestra y se guarda en la escala real |
| `available` hardcodeado a `true` | Era imposible despublicar un producto y editar uno despublicado lo reactivaba en silencio | Interruptor "Disponible" en el formulario de sabor |

### 29.4 Limpieza

`.table-wrap` estaba declarado dos veces, `esc()` y `escapeHtml()` eran el
mismo escape con dos nombres, `formatCents()` era `fmt()` con otro nombre y
habÃ­a dos `fmt()` locales que sombreaban al global. Una implementaciÃ³n cada
uno.

### 29.5 VerificaciÃ³n

- `npm test` â†’ **134/134** (131 previos + 3 de regresiÃ³n del XSS).
- `npx playwright test` â†’ **57/57** en 3 viewports (375 / 768 / 1440), con DB
  temporal limpia.
- Barrido manual con login real: las 12 secciones renderizan con contenido y
  0 errores de consola; con un id de pedido malicioso inyectado en memoria,
  la fila no genera ningÃºn handler ni etiqueta (0 elementos con
  `onmouseover`/`onerror`/`onfocus`).
- `gitleaks` limpio en los 14 commits.

## 30. Onda de feedback del operador â€” hero mochi, aurora viva y foto de combos (2026-11-01)

Cuatro observaciones del operador probando el dev server (:3737), las cuatro
corregidas el mismo dÃ­a. 4 commits, verificaciÃ³n 134/134 unit + 57/57 e2e.

### 30.1 El hero era un cuadrado, no un mochi

La onda del 2026-10-29 dejÃ³ una **segunda definiciÃ³n** del hero visual
(420Ã—420, `border-radius: 28px !important`) que pisaba el marco blob original,
y el `overflow: hidden` del wrap recortaba el `::before`: el marco orgÃ¡nico
existÃ­a pero no se veÃ­a. La foto toma ahora la silueta del mochi
(`55% 45% 62% 38% / 48% 58% 42% 52%`), el marco detrÃ¡s lleva el radio
contrario con su rotaciÃ³n, y el wrap ya no recorta. De paso se borrÃ³ un bloque
de `.ico` duplicado que el mismo cambio dejÃ³ pegado.

### 30.2 La aurora parecÃ­a estÃ¡tica

El shader **sÃ­ animaba** (verificado con capturas aisladas cada 3 s), pero a
0.04 de factor temporal y con un desplazamiento de mouse de 0.15: imperceptible
detrÃ¡s del contenido. La marcha sube a 0.10, el recorrido del mouse a 0.4, y el
puntero se interpola con inercia (0.06 por frame) para que la aurora persiga al
mouse en vez de seguirlo en seco.

### 30.3 La secciÃ³n "Por quÃ© MyMochis" sin borde

`.why` tenÃ­a el fondo clay translÃºcido sin `border-radius` ni margen, Ãºnica
secciÃ³n translÃºcida sin los 48px que llevan las demÃ¡s.

### 30.4 La foto de los combos se sube desde el dashboard

Los combos tenÃ­an tÃ­tulo, descripciÃ³n y precio, pero **ninguno tenÃ­a imagen**:
el formulario solo traÃ­a un campo de URL con un botÃ³n que mandaba a la galerÃ­a
de otra secciÃ³n, asÃ­ que la landing los mostraba con el placeholder SVG. El
modal del combo ahora sube el archivo directo a `POST /api/uploads`
(categorÃ­a `combo`), rellena la URL, muestra la vista previa y conserva la
galerÃ­a como alternativa. Verificado de punta a punta: subida â†’ guardado â†’ la
landing muestra la foto con su descripciÃ³n y precio.

## 31. Las etiquetas de los combos (2026-11-02)

Los sabores tenian un sistema de presentacion -**ribbon** (etiqueta de la
esquina), **acento de color** y **foto de referencia**, todo desde
`img/mochis/mochis.config.json`- y los combos no tenian nada de eso: solo el
badge de destacado, un placeholder SVG y las unidades en un parrafo. 5 commits,
134/134 unit + 57/57 e2e.

### 31.1 `img/mochis/combos.config.json`

El equivalente del config de sabores para los combos: foto de referencia, acento,
ribbon y la etiqueta de unidades. Se indexa por el **slug del nombre** del
combo, no por su id: el id de la tabla `combos` es autoincrement y cambia
entre bases, mientras que el nombre es la clave con la que el seed y el
operador hablan del combo.

La foto que el operador sube desde el panel **siempre gana** sobre la de
referencia. Las de referencia son fotos reales de producto del catalogo de
sabores, con su acento correspondiente.

### 31.2 Las tres superficies

- **Landing**: la tarjeta de combo toma el ribbon, el acento, la foto y las
  unidades en pastilla (`6 unidades` + `Tu eliges los sabores`), con la
  descripcion debajo. Se borro de paso un bloque `.combos-grid` duplicado que
  habia dejado la onda del 2026-10-29.
- **Tienda**: el ribbon "Combo" solo salia en los destacados, asi que un combo
  normal no se distinguia de un sabor. Ahora todos llevan su etiqueta y la foto.
- **Panel**: la tarjeta de combo lleva la miniatura de la foto subida, o un
  "sin foto" explicito - sin eso no habia forma de saber si la imagen habia
  quedado pegada.

### 31.3 Un bug de etiquetas que salio de paso

`FLAVOR_LABELS` (el resumen del pedido en la landing) usaba los slugs viejos
(`fresas-crema`, `chokis-cream`, `blueberry`) mientras la tabla
`flavors` usa `clasico-fresa`, `clasico-chokis`,
`blueberry-cheesecake`: **ninguna clave coincidia**, asi que el resumen
mostraba el id crudo (`clasico-fresa`) en vez de "Fresas con crema".
Corregido.

### 31.4 Cache

`combos.config.json` entra al precache del service worker (version `v12`)
para que la landing conserve las etiquetas sin red. El servidor manda
`Cache-Control: public, max-age=300` sobre los assets: tras tocar el config
hay que recargar con Ctrl+F5 (o esperar 5 minutos) para verlo.

## 32. Caso de uso 1 — El panel opera el negocio y la landing lo refleja (2026-11-02)

> **Estado: PROPUESTA para aprobación del operador.** Esta es la definición de
> la lógica de funcionalidad del primer caso de uso. No hay código de esto
> todavía: describe el modelo, las reglas y el plan.

### 32.1 El caso de uso, en una frase

El admin es el **único autor**. Sube sus productos, los categoriza, sube sus
imágenes y su contenido, arma promociones, combos y ofertas **a partir de los
productos que hay**, edita la landing con el contenido que quiera, y recibe en
su panel y en su WhatsApp cada pedido y cada confirmación. El cliente ve en la
landing el resultado de todo eso, y **nadie tiene que tocar el repo** para que
la landing cambie.

### 32.2 La regla que hoy está rota

Hoy hay tres fuentes de verdad y solo una es editable desde el panel:

| Dato | Dónde vive HOY | ¿Editable desde el panel? |
|---|---|---|
| Nombre, precio, disponibilidad del sabor | tabla `flavors` (`src/db.js:45`) | Sí |
| Categoría del sabor | `flavors.category_id` (`src/db.js:639`) | API sí, **UI no** (el modal no manda `category_id`, `manage.html:2320-2329`) |
| Foto de referencia, acento, ribbon del sabor | `public/img/mochis/mochis.config.json` (archivo del repo) | **No** |
| Foto de referencia, acento, ribbon del combo | `public/img/mochis/combos.config.json` (archivo del repo, indexado por slug) | **No** |
| Texto del hero, "cómo funciona", trust, "por qué" | HTML fijo (`public/index.html:1138-1197`) | **No** |
| Orden y visibilidad de las secciones | HTML fijo | **No** |
| WhatsApp | `config.whatsapp_number` **y** `573213050426` hardcodeado (`index.html:2172`) | Sí, pero la landing **ignora** el valor |
| Qué sabores trae un combo | **no existe** (`combos` no tiene items, `src/db.js:57`) | — |
| Si una promo descuenta | **no existe** (`src/lib/pricing.js` no lee `promos`) | — |
| `alt_text` y referencias de una imagen | `uploads` (`src/db.js:212`) sin refs | Parcial |

**Principio que corrige todo lo demás:** *todo lo que el cliente ve y compra
sale de la DB; lo que vive en el repo es semilla, no configuración.*

### 32.3 Cuatro capas y una sola dirección de escritura

```
C1 CATÁLOGO     panel  -> producto, categoría, media, stock por día
C2 DERIVADOS    panel  -> combos y promos (el server los CALCULA sobre C1)
C3 CONTENIDO    panel  -> secciones de la landing, copy, SEO, imágenes
C4 PEDIDOS      cliente-> checkout autoritativo en el server
                 -> panel (el admin ve) + WSP (el admin recibe)
```

Reglas de dependencia: C2 no puede referring a nada que no exista en C1; C3 no
puede mencionar un producto que no exista; C4 solo lee lo que C1 y C2
publicaron. Ninguna capa escribe en otra: el panel escribe en C1/C2/C3, el
cliente escribe en C4, el server deriva.

### 32.4 C1 — Catálogo: producto, categoría, media y disponibilidad

Un **producto** (sabor) tiene: id (slug), nombre, descripción, precio,
acento/color, ribbon, categoría, imagen, orden, destacado, disponible.

- **R1** El `id` (slug) es **inmutable**: es la clave de la presentación y la
  clave con la que los pedidos lo referencian. Renombrar el sabor no lo cambia.
- **R2** El precio es **pesos COP enteros**, nunca centavos
  (`src/lib/pricing.js:5-9`). Prohibido dividir entre 100.
- **R3** Todo sabor pertenece a **exactamente una** categoría; las categorías
  se editan desde el panel (hoy el CRUD de `src/routes/categories.js` es
  inalcanzable: 0 llamadas a `/api/categories` en `manage.html`).
- **R4** La presentación (acento, ribbon, foto de referencia, texto corto) vive
  en la DB. Los dos JSON del repo pasan a ser **semilla** (backfill) y luego se
  borran: si el admin no puede cambiarlo desde el panel, no está en la landing.
- **R5** `available` es el flag global; el **stock real por día** está en
  `release_items` por ventana de recogida (`src/db.js:172-179`). "Disponible
  hoy" = ventana abierta ∧ stock > 0 ∧ cutoff no vencido, y ese cálculo es
  **del server** (el bug del cutoff 5 h adelantado sigue abierto, `PROJECT.md`
  §23.3).
- **R6** `sort_order` y "destacado" son editables desde el panel (hoy
  `sort_order` se manda siempre 99 y `featured` no existe en `flavors`).
- **R7** Toda imagen tiene `alt_text`; borrar un asset con referencias se
  bloquea o desasigna (hoy `DELETE /api/uploads/:filename` borra el archivo
  físico y deja referencias colgadas, `src/routes/uploads.js:92`).
- **R8** La galería de Instagram es contenido **externo**: no se edita, pero sí
  se puede ocultar.

### 32.5 C2 — Derivados: combos, promos y ofertas

**Combos.** Tabla nueva `combo_items(combo_id, flavor_id, qty)`.

- El combo se **arma en el panel** eligiendo productos del catálogo y
  cantidades. Es lo que el operador pidió: combos *según los productos que
  haya*.
- `units` pasa a ser **derivado** (Σ qty de los items) y se recalcula al guardar.
- **Precio**: por defecto derivado = Σ (precio del item × qty), con el
  descuento que defina el admin; `compare_at_price` = la misma Σ sin descuento
  (el "antes" tachado). Modo "precio fijo" (override) = no se recalcula.
- **Disponibilidad**: `combo disponible = available ∧ ∀ item (disponible ∧
  stock suficiente)`. Si un item se agota, el combo se marca agotado en
  landing, tienda y panel, y el server lo rechaza en el checkout.
- **Composición visible**: el cliente ve "2× Fresas + 1× Durazno" en la landing,
  la tienda, el resumen del pedido y el mensaje de WSP. Hoy el combo no dice
  qué trae.

**Promos.** Hoy son decorativas: `pricing.js` no las lee, solo se pintan en una
barra (`src/routes/public.js:23`), y el panel ni siquiera manda la ventana
(`manage.html:2656` vs `src/routes/promos.js:32`).

- Campos nuevos: `applies_to` (sabor/categoría/combo/todo), `applies_to_id`,
  `max_discount`, `usage_limit`, `used_count`, `stackable`.
- **Motor de aplicación (server, en este orden)**:
  1. la promo está activa y dentro de la ventana `starts_at`/`ends_at`;
  2. el pedido alcanza `min_purchase`;
  3. solo se affectan las líneas elegibles según `applies_to`;
  4. una promo por pedido (o varias si `stackable`);
  5. `percent` = % del subtotal elegible acotado por `max_discount`; `fixed` =
     monto fijo acotado al subtotal elegible; `bxgy` = "compra X y paga Y"
     sobre la línea elegible más cara.
- El resultado se **desglosa**: `subtotal · promo · envío · total`. El cliente
  ve ese desglose antes de confirmar; el pedido lo guarda (`pricing_snapshot`)
  y el admin ve exactamente lo que se descontó.
- La barra de promos de la landing muestra solo promos **realmente aplicables**.

**Ofertas.** Lo que hoy el sistema llama "oferta del día" son las ventanas de
recogida con stock por sabor (`release_windows` + `release_items`): el admin
define qué se produce y para qué día, y la landing muestra solo lo
disponible. Se le suma la promo de esa ventana como oferta acotada.

### 32.6 C3 — Contenido: la landing editable desde el panel

Hoy no existe: no hay tabla de contenido, ni endpoint, ni UI
(0 hits de `site_config`/`landing_content`/`sections` en `src/` y `worker/`).

- Tabla nueva `landing_sections`:
  `key, kind, visible, sort_order, title, subtitle, body, image_url, cta_label,
  cta_url, config_json`.
- `kind` ∈ `hero · flavors · combos · promos · why · how · hours · gallery ·
  faq · order_form`.
- La landing pasa a ser un **template con slots** (`data-section="key"`); el
  JS rellena cada slot con el payload de `GET /api/public` (que ya es el
  payload único que consume la landing, `src/routes/public.js:9`). Si una
  sección no existe o está oculta, no sale.
- Panel: sección nueva **"Contenido"** con editor por sección (texto, imagen,
  visible, orden con drag, CTA) y vista previa. Se escribe con
  `PUT /api/landing/sections/:key`.
- SEO (`title`, `description`, `og:image`) y ajustes de marca en
  `landing_settings` (key/value) o en la fila `config` extendida.
- **Límite explícito**: se edita el *contenido*, no el *diseño*. El CSS y el
  JS son código del repo; el texto y las imágenes son datos.

### 32.7 C4 — El pedido: de la landing al panel y de vuelta al WhatsApp

Estados: `pending → confirmed → preparing → ready → completed`, más
`cancelled` y `expired`. Hoy `status` es texto libre sin transiciones
(`src/db.js:87`).

1. El cliente ve el catálogo real (C1+C2) y arma el pedido: nombre, teléfono,
   día de recogida, modo (recogida/domicilio), dirección si aplica, método de
   pago, notas y promo.
2. `POST /api/orders` (público, `src/routes/orders.js:253`): el server valida
   cutoff, **recalcula** los precios (`pricing.js`), **aplica la promo**,
   reserva stock, **genera el id del pedido** (hoy lo genera el cliente,
   `index.html:2151`) y guarda el desglose. Devuelve
   `{order, breakdown, whatsapp.deep_link}`.
3. La landing **abre el WhatsApp con el `deep_link` del server** (hoy lo ignora
   y usa un número hardcodeado, `index.html:2171-2172`), y el mensaje lo arma
   **un solo formateador** (`src/lib/whatsapp.js:88`) → el round-robin entre
   `order_recipients` funciona de verdad y el mensaje incluye el desglose y el
   código del pedido.
4. El admin ve el pedido en el panel: filtro "sin confirmar", contador, badge
   y sonido.
5. El admin confirma el pago (`POST /api/orders/:id/confirm-payment`,
   `orders.js:515`): se hace el **commit del stock** (la reserva se convierte en
   venta) y se notifica. Idempotente.
6. Cada cambio de estado notifica por WSP (al admin y, opcionalmente, al
   cliente): nuevo, confirmado, listo, entregado, cancelado. Hoy solo se
   notifica la confirmación y con `business_name: null`
   (`src/lib/payments/order-notify.js:48`).

### 32.8 Invariantes (no negociables)

- **I1** El precio de toda línea y todo descuento lo calcula el server. El
  cliente nunca manda precios.
- **I2** La disponibilidad de un combo = ∩ de sus items; la de un pedido = ∩
  de sus líneas.
- **I3** Todo texto visible en la landing sale de la DB. Si el admin no lo
  puede cambiar desde el panel, no está en la landing.
- **I4** El `id` de un sabor es inmutable.
- **I5** La presentación de un producto no vive en un archivo del repo.
- **I6** El número de WhatsApp sale de la DB (`config.whatsapp_number` +
  `order_recipients`); nunca hardcodeado.
- **I7** Toda imagen tiene `alt_text`; no se borra un asset referenciado.
- **I8** Todo cambio de estado de pedido deja rastro y notifica.
- **I9** El dinero son pesos COP enteros. Nunca `/100`.

### 32.9 Flujos end-to-end

| # | Flujo | Resultado verificable |
|---|---|---|
| F1 | Admin crea/edita un producto (categoría, imagen, acento, precio, disponibilidad) | La landing lo muestra con su foto y su categoría; el panel no tiene otro checkout |
| F2 | Admin arma un combo con 3 productos | La landing muestra qué trae, su precio derivado y "agotado" si un item se agota |
| F3 | Admin activa una promo de 15% con ventana y mínimo | El checkout descuenta 15% server-side, desglosado, y el panel ve el mismo desglose |
| F4 | Admin edita el hero y reordena secciones | La landing cambia sin tocar el repo |
| F5 | Cliente pide → admin recibe en panel y WSP → admin confirma | El pedido aparece en "sin confirmar", llega al WSP del admin (número del round-robin), y al confirmar el stock se vende y se notifica |

### 32.10 Gap verificado contra el código

| Gap | Dónde | Efecto en este caso de uso |
|---|---|---|
| Sin UI de categorías; el modal no manda `category_id` | `manage.html:2320-2329`, `src/routes/categories.js` | "los categoriza" no se puede hacer |
| Presentación en JSON del repo | `mochis.config.json`, `combos.config.json` | El panel no manda sobre fotos/acentos/ribbons |
| Combos sin items | `src/db.js:57` | No hay combos "según los productos que haya" |
| Promos decorativas | `src/lib/pricing.js` | Las promociones no descuentan |
| Landing no editable | `public/index.html` (HTML fijo) | "editar la landing" no existe |
| WSP hardcodeado + mensaje duplicado | `index.html:2171-2172` vs `src/lib/whatsapp.js:88` | El round-robin no aplica al cliente final |
| Id de pedido lo genera el cliente | `index.html:2151` | El cliente elige su propia clave |
| `source:'landing'` fuera de `SOURCE_ES` | `manage.html:1921` | La tabla muestra el literal crudo |
| `sort_order` fijo en 99; sin `featured` en sabores | `manage.html:2328` | No se puede ordenar ni destacar desde el panel |
| Delete de media deja refs colgadas | `src/routes/uploads.js:92` | Imágenes rotas en la landing |
| Secciones `social` y `pagos` inalcanzables | `manage.html:1397`, `:1440` | Trabajo a medias visible |
| Cutoff 5 h adelantado | `PROJECT.md` §23.3 | "disponible hoy" puede mentir |
| Dos checkouts (landing y `/tienda`) | `index.html:2147`, `tienda.html:1726` | El formulario se mantiene duplicado |

### 32.11 Cambios de schema propuestos

- `flavors`: + `accent`, `ribbon`, `description_short`, `featured`
- `combos`: + `accent`, `ribbon`, `description_short`, `price_mode`
  (`derived`/`fixed`), `discount_pct`; **nueva** `combo_items(combo_id,
  flavor_id, qty)`
- `promos`: + `applies_to`, `applies_to_id`, `max_discount`, `usage_limit`,
  `used_count`, `stackable`, `auto_apply`
- `uploads`: + `entity_type`, `entity_id` (o tabla `media_refs`)
- `orders`: `status` con CHECK + `pricing_snapshot` + `promo_code`
- **nuevas**: `landing_sections`, `landing_settings`
- Backfill: `mochis.config.json` y `combos.config.json` → columnas de
  `flavors`/`combos`; después los JSON se borran del repo.

### 32.12 Decisiones que bloquean (preguntas al operador)

- **D1** ¿El precio del combo es siempre derivado del catálogo o el admin lo
  fija a mano? *Propuesta: derivado por defecto, con override manual.*
- **D2** ¿Las promos se aplican automáticamente (la mejor elegible) o el cliente
  mete un código? *Propuesta: automática si `auto_apply`; por código si no.*
- **D3** ¿Landing editable por sección (10 secciones, con visible + orden) o
  solo bloques de texto? *Propuesta: por sección.*
- **D4** ¿El cliente recibe confirmación por WSP o solo el admin?
  *Propuesta: ambos; al cliente "tu pedido #X quedó confirmado".*
- **D5** ¿Quién más opera el panel además del dueño? *Si hay una segunda
  persona, se activa el gating por rol de MM-33.*
- **D6** ¿El formulario de compra vive en la landing, en `/tienda` o en ambos?
  *Propuesta: un solo checkout (el de la landing) y `/tienda` como vitrine.*

### 32.13 Plan: cuatro specs nuevas (y reconciliación con el plan vigente)

| Spec | Nombre | Tareas |
|---|---|---|
| **MM-37** (spec 44) | Catálogo como fuente de verdad | categorías en la UI + `category_id`; presentación a la DB (backfill y borrado de los JSON); media con `alt_text` y referencias; `sort_order`/`featured`; alt-text obligatorio; fin de los JSON |
| **MM-38** (spec 45) | Combos y promos que se calculan | `combo_items` + constructor de combos; precio/unidades/disponibilidad derivados; motor de promos (ventana, elegibilidad, mínimo, bxgy) + desglose en el checkout; snapshot del desglose en el pedido |
| **MM-39** (spec 46) | Landing editable | `landing_sections` + `landing_settings`; template con slots; `GET /api/public` ampliado; editor por sección en el panel con vista previa; SEO; secciones visibles y ordenables |
| **MM-40** (spec 47) | Cierre del pedido: panel ↔ WSP | id de pedido server-side; la landing usa el `deep_link`; un solo formateador de mensaje; estados con transiciones; notificación en cada cambio; contador/badge de "sin confirmar"; `SOURCE_ES`; id de combo por slug |

**Reconciliación** con el plan vigente (specs 39-43): MM-32 está cerrada. MM-33
(modularidad del panel) es requisito previo y no se toca. **MM-34 se
re-escopifica**: sus 11 tareas se reparten entre MM-37/38/40 (promos que no
descontan, categorías muertas, paginación y contador de "sin confirmar",
secciones huérfanas, `apply-suggested` con previsualización). MM-35 (cobertura)
se amplía a las cuatro specs nuevas. MM-36 (producción) se queda al final.

Orden: MM-33 → MM-37 → MM-38 → MM-39 → MM-40 → MM-35 → MM-36.

### 32.14 Verificación

Base actual: **134/134 unit + 57/57 e2e**. Para este caso de uso:
- e2e del ciclo completo admin → landing → pedido → panel → WSP (con aserciones
  sobre el desglose y el `deep_link`);
- contrato de API de `GET /api/public` (que la landing y el panel no se
  desincronicen);
- regresión: el total del cliente nunca manda; el WSP nunca usa un número
  hardcodeado; ningún JSON de presentación sobrevive en el repo.

> **Actualizado en §33.15**: el plan de specs de este capítulo (MM-37..MM-40)
> queda sustituido por el plan del patrón (§33), que lo descompone en 8 specs
> (MM-37..MM-44) e integra el módulo de producción y el de domicilios, que en
> este capítulo no estaban dentro del caso de uso 1.

## 33. El patrón de diseño: Núcleo + Perfil de Negocio (2026-11-02)

> **Estado: PROPUESTA para aprobación del operador.** Define el patrón con el
> que se construye el caso de uso 1 y, con el mismo núcleo, cualquier otro
> modelo de negocio de este tipo (artesanal por lotes, panadería,/node-food).
> No es código todavía.

### 33.1 Qué motivó el patrón (medido sobre el código, no opiniado)

| Hallazgo | Dónde | Consecuencia |
|---|---|---|
| 3.561 líneas de `<style>` inline que re-declaran lo que `ui.css` ya tiene | `index.html:45-1099` (1054), `tienda.html:18-851` (833), `manage.html:16-1689` (1674) | Tres "design systems" que se contradicen |
| 2 checkouts duplicados con DOM distinto para la misma card | `index.html:1990-2036` vs `tienda.html:960-1037`; `.product-card` en `ui.css:403-545` y re-declarado en `tienda.html:214-330` | Cada arreglo se hace dos veces (o ninguna) |
| 8 funciones de render + 3 loaders, y `/api/public` se pide **dos veces** | `index.html:1519-1749`, `1719` | La landing no es un render, es un guion |
| ~60 líneas de copy hardcodeado en el HTML | `index.html:1138-1380` | "Editar la landing" no existe |
| Panel de 4.734 líneas escrito a mano, 100 callables, 68 `innerHTML` | `public/manage.html` | Agregar un campo = HTML + JS + wiring |
| Botones **muertos** en la landing: `data-flavor-add` y `data-combo` no tienen listener | `index.html:1554`, `1697` vs el delegado `2197-2247` | "Añadir al carrito" y "Pedir <combo>" no hacen nada |
| `.glass` y `.product-selector*` sin ninguna regla CSS | `index.html:1961-1975`, `2051-2064` | Elementos sin estilo |
| Producción: **una sola receta global** para todos los sabores | `production_items` (`src/db.js:241-248`) | "Materia prima" = una hoja de papel |
| `apply-suggested` escribe **el mismo precio en todos los sabores** | `src/routes/production.js:107` (`WHERE price IS NOT NULL` es un no-op con `price NOT NULL DEFAULT 8000`) | DESTRUCTIVO: un clic destruye el precio del catálogo |
| `production_items.name` no es UNIQUE | `src/db.js:243` | "Harina" repetida infla el costo del lote |
| Producción no alimenta el stock vendible | `production_items` no tiene FK; `release_items` se carga a mano | Dos silos: costeo y stock |
| Dos calendarios para lo mismo: día de semana y fecha | `delivery_schedule` (`db.js:181`) vs `release_windows` (`db.js:160`) | "Semanas y días" no se pueden editar con un modelo |
| El domicilio no valida stock, ventana ni cutoff | `src/routes/orders.js:320-362` | Se puede vender lo que no hay |
| La landing no usa el motor de cotización | `index.html:2091-2092` (tarifa plana) vs `tienda.html:1584` (`/api/delivery/quote`) | El precio mostrado puede diferir del cobrado |
| El WSP al admin no incluye dirección ni modo de entrega | `src/lib/whatsapp.js:88-114` | El admin no sabe si es domicilio |
| Sin estados de entrega, repartidor ni cola | `orders.status` es genérico (`orders.js:18`) | No hay operación de reparto |

**Conclusión:** no faltan funciones; falta el modelo. Cada necesidad se
resolvió a mano, dentro de una página, y por eso todo se duplica y nada se
puede editar desde el panel.

### 33.2 El patrón en una frase

**Un núcleo declarativo (esquemas + slots + motor de reglas) y un "perfil de
negocio" por tipo de modelo (entidades, reglas, secciones y workflows)
declarados como datos. El panel y la landing son dos vistas del mismo perfil.**

Regla de oro: **el admin edita DATOS; el núcleo los convierte en PANTALLA.**
Si algo necesita código para cambiarse, es código: no se pone en el panel.
Y al revés: si el negocio va a cambiarlo cada semana, es dato: se pone en el
panel aunque hoy parezca un texto fijo.

### 33.3 Las seis piezas del núcleo

| # | Pieza | Qué resuelve | Hoy |
|---|---|---|---|
| N1 | Registro de esquemas | formularios generados: el panel no escribe un form por entidad | 4.734 líneas a mano |
| N2 | Registro de secciones (`kind`) | cada sección de la landing editable sin tocar HTML | 0 editables |
| N3 | Renderer de slots | una sola ruta de render, responsive, un solo fetch | 8 renders, 2 fetch, CSS duplicado |
| N4 | Motor de reglas | precio, disponibilidad, combo, promo, cutoff: un solo cálculo | 3 copias de la fórmula |
| N5 | Calendario de servicio | semanas → instancias → slots, todo editable | 2 calendarios desligados |
| N6 | Salidas + RBAC | todo cambio notifica (WSP), deja rastro y respeta el rol | WSP duplicado, sin audit, sin roles |

### 33.4 N1 — Registro de esquemas (los formularios se generan)

Cada entidad se declara con un esquema: `key`, `label`, `fields[]`
(`name`, `type`, `label`, `required`, `options`, `min`, `max`, `help`, `group`,
`visible_by`), `list[]` (columnas), `order`, `parent`, `api`.

Tipos de campo: `text`, `textarea`, `number` (pesos), `money`, `select`,
`multiselect`, `switch`, `date`, `datetime`, `time`, `weekday`, `image`,
`color`, `richtext-lite`, `ref` (relación a otra entidad), `json`.

- El panel recibe **una pantalla genérica** por entidad: filtro + tabla +
  formulario, con permisos por campo y por rol.
- Agregar "categoría" o "proveedor" deja de ser 200 líneas de HTML y pasa a ser
  una entrada en el registro.
- **Lo que no se mete en el registro**: apps especiales que se construyen
  encima del núcleo (el constructor de combos, el plan de producción, la
  matriz de precios). Se hacen como *apps* con sus propios componentes, no
  como páginas aparte ni como formularios genéricos.

### 33.5 N2 — Registro de secciones (cada sección editable)

`landing_sections(key, kind, visible, sort_order, title, subtitle, body,
image_url, cta_label, cta_url, config_json)`.

Cada `kind` declara: sus **campos editables**, su **componente de render** y
los **datos que consume**.

Catálogo inicial de kinds:

| kind | Campos editables | Datos |
|---|---|---|
| `hero` | eyebrow, title, lead, cta, imagen, badge | config + media |
| `flavors` | título, subtítulo, filtro por categoría, orden, límite, layout | catálogo |
| `combos` | título, subtítulo, filtro, orden, destacado | catálogo |
| `promos` | título, mostrar/ocultar, estilo | promos aplicables |
| `releases` | título, weeks_label, mostrar cupos, mostrar "cerrado" | calendario N5 |
| `hours` | título, nota | `service_templates` |
| `why` | título, ítems (texto + icono + texto) | datos |
| `how` | título, pasos (título + texto + imagen) | datos |
| `gallery` | título, visible, origen (IG / manual) | `ig_posts` / media |
| `faq` | título, preguntas (pregunta + respuesta) | datos |
| `social` | título, usuario, enlaces | config |
| `footer` | columnas (título + links) | datos |
| `order_form` | título, campos visibles, nota, métodos de pago | config + métodos |

- El panel: editor por sección con (a) los campos del kind, (b) visible,
  (c) orden con drag, (d) **previsualización real** (el mismo renderer que
  usa la landing).
- Los kinds de catálogo (`flavors`, `combos`, `promos`) se configuran con
  filtros y orden, no con HTML.
- **Semanas y días**: el kind `releases` se alimenta del calendario N5, así que
  cuando el admin edite el patrón semanal y las excepciones, la sección de la
  landing cambia sola.

### 33.6 N3 — Renderer de slots y sistema de diseño

- HTML final mínimo: `<section data-slot="hero"></section>`, `<section
  data-slot="flavors"></section>`, … El JS monta; **si no hay sección, el slot
  desaparece**.
- Un **solo** `GET /api/public` devuelve `sections` + datos; el front no
  vuelve a pedirlo (hoy `loadReleases()` lo hace, `index.html:1719`).
- Sistema de diseño: `theme.css` (tokens, fuente canónica) + `ui.css`
  (componentes) ya existen → el trabajo es **matar los `<style>` inline**
  (3.561 líneas) y subir a `ui.css` lo que aún vive dentro de una página.
- Responsive por defecto, no por excepción:
  - grids fluidos `repeat(auto-fit, minmax(Xpx, 1fr))`;
  - tipografía con `clamp()`;
  - **container queries** para los componentes (hoy no hay ninguna);
  - **variables de breakpoint** (hoy 11 valores escritos a mano por página);
  - un solo `.product-card` y un solo modal (hoy hay 2 de cada uno).

### 33.7 N4 — Motor de reglas (la parte que se calcula)

Un módulo `src/rules/` con funciones puras y **una sola** implementación:

```
priceLine(item, qty)          precio de una línea
priceCombo(combo)              precio de un combo (derivado o fijo)
availableCombo(combo)          disponible = ∩ de sus items
applyPromo(order, promo)       descuento con ventana, elegibilidad, mínimo, tope
cutoffFor(instance)            cutoff único (fecha + hora + zona)
orderableWeek(template, date)  qué días se puede pedir
quoteDelivery(address, basket) tarifa, distancia, ETA, fuera de cobertura
```

- El **server** las usa para cobrar; el **panel** las usa para previsualizar
  ("así lo verá el cliente"); la **landing** recibe resultados, no recalcula.
- Reglas que deben salir del motor: precio del combo, promos, disponibilidad
  por ventana, cutoff, tarifa de domicilio, mínimo de pedido, precio sugerido
  por producto (hoy duplicado y divergente: `production.js:106` vs `:122`).
- Regla: **el panel no calcula nada que el servidor vaya a cobrar.** Si el
  panel y el server discrepan, el server manda y el panel muestra el valor
  del server.

### 33.8 N5 — Calendario: semanas, días y cupos

Se unifican los dos calendarios actuales en tres tablas:

```
service_templates  patrón semanal: day_of_week, start, end, modes,
                   capacity, cutoff_hours, active
service_instances  fecha concreta: date, template_id, status,
                   capacity_override, notes
service_slots      franja: instance_id, start, end, capacity, reserved
```

- El **cliente** ve la semana: "Semana del 3 al 9 de noviembre", con los días
  abiertos, su horario y si quedan cupos (hoy ve un `<select>` plano de
  fechas, `index.html:2012-2016`).
- El **admin** edita el patrón una vez (se aplica a todas las semanas) y las
  excepciones por fecha (cerrar un día, cambiar horario, más cupos).
- El **stock por sabor** se cuelga de la instancia (hoy vive en
  `release_items` con una fecha suelta).
- El **cutoff** sale de plantilla + instancia con una sola función.

### 33.9 N6 — Salidas, notificación y RBAC

- **Un solo formateador de WSP** (`src/lib/whatsapp.js`) para: pedido nuevo,
  cambio de estado, resumen al cliente. Hoy hay 2 formatos y la landing arma el
  suyo (`index.html:2171`).
- **Eventos**: `order.created`, `order.payment_confirmed`, `order.ready`,
  `order.delivered`, `order.cancelled`, `stock.low`, `window.closing`. Cada
  evento decide a quién notifica (admin, cliente, ambos).
- **Audit log**: todo cambio del panel deja rastro (actor, antes, después).
  Hoy `apply-suggested` pisa precios sin rastro.
- **RBAC**: roles `owner` / `editor` / `operator` con permisos por módulo
  (catálogo, contenido, producción, reparto, caja). El panel oculta lo que no
  se puede tocar.

### 33.10 El perfil MyMochis (el "pack")

**Catálogo unificado** — la clave para que "productos" y "combos" se
administren igual:

```
catalog_items      id (slug inmutable), kind ('product'|'combo'), name,
                   description, description_short, category_id, price,
                   compare_at_price, accent, ribbon, image_url, units,
                   sort_order, featured, available, price_mode
combo_items        combo_id, item_id, qty      (solo kind='combo')
```

- Un solo formulario, una sola card, un solo motor de precio y de stock para
  los dos. El combo añade **composición** (`combo_items`) y puede tener
  precio derivado o fijo.
- El operador puede **categorizar, poner precio, descripción y nombre** a
  productos y combos con la misma pantalla.

Resto de entidades del pack: `categories`, `media`, `promos`,
`service_templates/instances/slots`, `ingredients`, `recipes`,
`recipe_items`, `suppliers`, `stock_movements`, `production_batches`,
`delivery_zones`, `couriers`, `payment_methods`, `order_recipients`,
`landing_sections`, `landing_settings`.

Secciones del pack: las 13 del catálogo N2. Reglas del pack: las 9
invariantes de §32.8.

### 33.11 Materia prima: qué significa gestionarla (3 niveles)

Hoy: una "receta" global de insumos con costo tecleado por el admin, sin
stock, sin proveedores, sin lotes, sin merma; `apply-suggested` destruye los
precios del catálogo; la producción no genera unidades vendibles.

- **Nivel 1 — Costeo por producto (lo mínimo útil)**
  `recipes(id, item_id)` + `recipe_items(recipe_id, ingredient_id, qty,
  unit_cost_snapshot)` → costo real **por sabor** → precio sugerido **por
  producto** → margen real por sabor (hoy el panel ya muestra una tabla de
  márgenes por producto, pero solo de lectura y con un costo global).
  Corrige de paso el bug de `apply-suggested`.
- **Nivel 2 — Inventario de insumos**
  `ingredients(id, name UNIQUE, unit, qty_on_hand, min_qty, avg_cost,
  supplier_id)` + `stock_movements(ingredient_id, qty, reason, ref)` →
  "cuánta harina me queda", "me estoy por quedar", valor del inventario y
  costo promedio ponderado.
- **Nivel 3 — Ciclo completo**
  `suppliers` + `purchase_orders` (entradas con costo real) +
  `production_batches` (producción de X unidades con merma) + `waste` +
  escandallo (costo → precio → margen → utilidad por sabor y por día) +
  comparación contra la referencia de mercado.
- **Regla que cierra el silo**: `production_batch` → unidades vendibles →
  `service_instance` (stock por día). Hoy el stock vendible se teclea a mano.
- **Coherencia de unidades**: toda la app usa **pesos**; los nombres
  `unit_cost_cents` / `market_reference_cents` son históricos → renombrar al
  migrar (la app ya avisa de esto en `pricing.js:5-9`).

### 33.12 Domicilios: estado real y recomendaciones

**Estado real (verificado):**
- Una sola zona: un círculo con radio (`config.delivery_zone_*`), tarifa plana
  o `base + por km` con redondeo a múltiplos de $50
  (`src/lib/delivery-fee.js:12-21`).
- `delivery_schedule` = patrón por día de semana con cutoff;
  `release_windows` = fecha concreta con stock.
- El pedido a domicilio **no valida stock, ventana ni cutoff**
  (`orders.js:320-362`): se puede vender lo que no hay, y la reserva de stock
  es condicional a `scheduled` (`orders.js:418`, `:438`).
- La landing **no cotiza**: usa la tarifa plana del config
  (`index.html:2091-2092`); la tienda sí usa `/api/delivery/quote`
  (`tienda.html:1584`). El cliente puede ver un precio y ser cobrado otro.
- Sin estados de entrega, sin repartidor, sin cola, sin hoja de ruta.
- El mensaje de WSP al admin **no lleva dirección ni modo de entrega**
  (`whatsapp.js:88-114`).
- "Efectivo al recibir" es solo una fila de `payment_methods`: no hay cobro
  contra entrega.

**Recomendaciones**

*P0 — corrección (que el sistema no mienta)*
1. **Una sola cotización**: la landing usa el motor (`/api/delivery/quote`) y el
   server cobra lo mismo; el precio del formulario es el precio cobrado.
2. **El domicilio valida lo mismo que la recogida**: stock, ventana abierta y
   cutoff.
3. **Mensaje de despacho completo**: dirección, barrio, modo, ventana, total,
   código y link al pedido en el panel.
4. **Estados de entrega propios** (`assigned → picked_up → on_way → delivered →
   failed`) con ETA y repartidor, sin reusar `status` del pedido.
5. **Capacidad por franja**: la ventana se cierra cuando se llena; el cliente
   ve los cupos que quedan.

*P1 — operación (poder repartir de verdad)*
6. `delivery_zones` como **entidad**: varias zonas, radio o polígono, tarifa y
   mínimo por zona, en vez de 13 columnas de `config`.
7. **Reparto propio o apps**: si es propio → `couriers` + cola de pedidos +
   hoja de ruta; si es apps (Rappi/Pickapp/IVoy) → etiqueta y enlace, sin
   módulo de reparto. Hoy `delivery_provider` es texto libre validado contra
   una whitelist (`orders.js:21`) sin ninguna integración.
8. **Cobro contra entrega** como estado real (`pay_on_delivery`,
   `cash_collected_by`) si el negocio lo necesita; con cierre de caja.
9. **Notificar al cliente** en cada cambio de estado ("tu pedido va en camino").

*P2 — avance*
10. Rutas por zona y priorización por cercanía.
11. Horarios y mínimos distintos por zona.
12. Pedido programado a varios días (si el negocio lo necesita).

### 33.13 Decisiones del operador (2026-11-02, respondidas)

- **D7 — Reparto**: el domicilio se calcula por **distancia** entre la
  ubicación del admin (donde están los mochis, fijada por él en el mapa) y la
  dirección que el cliente selecciona **en el mapa**; el admin decide a qué
  domiciliario enviar. → Se mantiene la zona única con origen fijo + tarifa
  por distancia; se agrega **selector de dirección en mapa** para el cliente y
  **asignación manual de domiciliario** (sin módulo de rutas por ahora).
- **D8 — Cobro**: **los dos, según el método de pago**. → Cada
  `payment_method` declara si se cobra antes (`prepaid`) o contra entrega
  (`on_delivery`); el flujo de caja depende del método.
- **D10 — Franjas / eventos**: el admin define horario y días en el
  cronograma, **y además hace eventos visitando lugares**: el calendario debe
  mostrar estos eventos y la landing debe anunciarlos. → N5 agrega una
  entidad de **eventos** (fecha, lugar, horario, descripción) visible en la
  sección de calendario de la landing.
- **D9 — Zonas**: **una sola zona** (como hoy). El modelo de tarifas por
  distancia se mantiene; `delivery_zones` queda como entidad futura si algún
  día hay varias.
- **D13 — Stack del panel**: **vanilla + formularios declarativos** (N1). No
  se migra a React.
- **D15 — Materia prima**: tablas estilo Excel **con exportación a Excel**,
  incluyendo precios de productos, cajas, pegatinas, etc., para determinar el
  gasto del negocio; y un panel de estadísticas que recopile todo y dé datos
  específicos: qué mochis se compran más, en qué se gasta más, cuánto se está
  ganando. → Nivel 1 (recetas/costeo por producto) + Nivel 2 (inventario de
  insumos, incluidos empaques) + **exportación** + **analítica** (top
  productos, gasto por insumo, margen por producto).
- **D14 — Checkout**: **solo el de la landing**, y el formulario debe ser lo
  más rápido y eficaz posible para pagar. → Un solo checkout, optimizado por
  pasos; `/tienda` queda como vitrine.

**Queda abierta** (no bloquea el arranque): D11/D12 — si alguien más que el
dueño operará el panel (roles). RBAC se deja para MM-44 y se activa cuando el
operador defina quién más entra.

### 33.14 Bugs y deudas que hay que arreglar sí o sí (de esta auditoría)

| Severidad | Bug | Dónde |
|---|---|---|
| **P0** | `apply-suggested` escribe el mismo precio en **todos** los sabores | `src/routes/production.js:107` |
| **P0** | Botones muertos en la landing: "Añadir al carrito" y "Pedir <combo>" | `index.html:1554`, `1697` (sin listener en `2197-2247`) |
| **P0** | El domicilio no valida stock/ventana/cutoff | `src/routes/orders.js:320-362` |
| **P0** | La landing muestra una tarifa que puede no ser la cobrada | `index.html:2091-2092` |
| **P0** | El WSP al admin no dice si es domicilio ni dónde | `src/lib/whatsapp.js:88-114` |
| **P1** | `production_items.name` sin UNIQUE → insumos duplicados inflan el costo | `src/db.js:243` |
| **P1** | Fórmulas de precio sugerido duplicadas y divergentes | `production.js:106` vs `:122` |
| **P1** | `.glass` y `.product-selector*` sin reglas CSS | `index.html:1961-1975`, `2051-2064` |
| **P1** | `/api/public` se pide dos veces en la landing | `index.html:1719` |
| **P1** | La tienda sobreescribe el `.product-card` compartido | `tienda.html:214-330` vs `ui.css:403-545` |
| **P1** | Sin audit en producción: borrar un insumo o pisar precios no deja rastro | `production.js:89-93`, `:107` |
| **P2** | Docs desactualizadas: §23.3 decía "bug abierto" del cutoff (ya corregido en `bc2724c`) | PROJECT.md §23.3 (corregido en esta revisión) |
| **P2** | `applyServerConfig` lee columnas inexistentes (código muerto) | `index.html:1775-1783` |

### 33.15 Plan (sustituye §32.13)

| Spec | Nombre | Núcleo |
|---|---|---|
| **MM-37** (44) | Núcleo: registro de esquemas + registro de secciones | N1, N2 |
| **MM-38** (45) | Catálogo unificado: productos y combos, categorías, presentación en DB, media | N1 |
| **MM-39** (46) | Motor de reglas: combos derivados, promos, desglose, disponibilidad | N4 |
| **MM-40** (47) | Calendario unificado: semanas, instancias, slots, stock por día | N5 |
| **MM-41** (48) | Landing editable: secciones, slots, un solo fetch, un solo checkout, fin del CSS inline | N2, N3 |
| **MM-42** (49) | Cierre del pedido: deep_link, un solo mensaje, estados de entrega, capacidad, cotización única | N6 + domicilios P0 |
| **MM-43** (50) | Materia prima: recetas por producto (N1) + inventario de insumos (N2) + producción que alimenta el stock | pack |
| **MM-44** (51) | Cobertura e2e del ciclo completo + RBAC + audit | N6 |

**Reconciliación con el plan vigente (specs 39-43).** MM-32 está cerrada.
**MM-33 (modularidad del panel) se fusiona con MM-37**: la modularidad es
parte del núcleo (un render por sección, un store con invalidación, una capa
DOM). **MM-34 se re-escopifica**: sus 11 tareas caen dentro de MM-38 (categorías
muertas), MM-39 (promos que no descuentan), MM-42 (paginación y contador de "sin
confirmar", secciones huérfanas) y MM-43 (`apply-suggested` con
previsualización). **MM-35 (cobertura)** se amplía a MM-44. **MM-36 (producción
y entrega al admin del negocio)** se queda al final, ya que el patrón cambia
la forma del panel.

Orden: **MM-37 → MM-38 → MM-39 → MM-40 → MM-41 → MM-42 → MM-43 → MM-44**, y
MM-36 al cierre.

### 33.16 Verificación del patrón

- Base actual: **134/134 unit + 57/57 e2e**.
- El patrón no se acepta hasta que: (a) `manage.html` deje de crecer por
  funcionalidad (toda entidad nueva es una entrada en el registro, no HTML);
  (b) el CSS inline de las 3 páginas quede en 0 líneas;
  (c) exista un e2e del ciclo **admin → landing → pedido → panel → WSP**;
  (d) el panel y el server muestren el mismo precio para el mismo pedido
  (prueba de paridad, no deSnapshot).

### 33.17 La IA del panel: 5 módulos y el ciclo operativo (2026-11-02, orden del operador)

El operador define la corrección: **la arquitectura gira en torno a lo que el
admin publica y desea hacer desde el dashboard**. El panel actual (12
secciones ordenadas por historia, no por operación) se reorganiza en **5
módulos** que siguen el ciclo real del negocio:

```
CONFIGURAR ─► PRODUCIR ─► PUBLICAR ─► VENDER ─► ANALIZAR ─┐
     ▲                                                    │
     └──────────────── (qué producir mañana) ◄────────────┘
```

| Módulo | Propósito | Absorbe (secciones actuales) | Falta por construir |
|---|---|---|---|
| **1. Producción** | Evaluar y compilar la producción de todo el producto: insumos, recetas, costeo, y **cuánto vale hacer un día de pedidos** | Producción | Inventario de insumos, recetas por producto, costo por día de servicio, lotes → stock, merma, export Excel |
| **2. Pedidos y Domicilios** | La cola de pedidos de los clientes junto al domicilio: confirmar, cobrar, despachar, asignar domiciliario | Pedidos + Cobros (huérfana) + estado operativo de horarios/ventanas | Estados de entrega, domiciliarios, cotización en vivo, vista del día por franja |
| **3. Tienda y Landing** | Gestionar los productos y subirlos al landing con sus promociones: catálogo, anuncios, promos y todo el contenido publicado | Productos, Combos, Promos, social (huérfana), Horarios, Ventanas | Catálogo unificado, editor de secciones, calendario publicado (semanas/días/cupos/eventos), anuncios/banners |
| **4. Estadísticas** | Análisis de mercado: qué se vende, qué se gasta, qué se gana | Panel (KPIs), Análisis | Márgenes por producto, gasto por insumo, top mochis, referencia de mercado, utilidad del día |
| **5. Configuración** | Información del usuario/negocio, medios de pago y las APIs que se vayan configurando | Configuración, Usuarios, Credenciales, Números de pedido, Inmediato (zona/tarifa), Métodos de pago | `settlement` por método (prepaid/on_delivery), zonas/tarifas como entidad, readiness de APIs |

**Decisiones de ubicación (propuesta alineada con lo que dijo el operador):**

- El **calendario** (semanas, días, cupos, eventos) se **edita en Tienda y
  Landing** — es contenido publicado, y el operador ya dijo que el cronograma
  se maneja "del lado del landing". Su **estado operativo** (cupos restantes,
  pedidos por franja) se consulta en Pedidos y Domicilios.
- Las reglas comerciales de envío ("días gratis") son **ofertas** → Tienda y
  Landing; su efecto operativo se ve en Pedidos.
- Al abrir el panel se aterriza en **"Hoy"** (dentro de Pedidos): pedidos del
  día por franja, alertas de stock y ventanas por cerrar. El KPI general vive
  en Estadísticas.

**La métrica nueva que pide el operador — "Cuánto vale hacer un día de
pedidos":** para cada `service_instance` (día), Producción compila
`Σ (costo de receta × unidades planificadas/vendidas de cada producto) +
empaques + tarifas de domicilio propias` contra `ingreso del día` →
**margen del día**. Es el puente Producción ↔ Calendario ↔ Pedidos: el mismo
dato alimenta el plan de compra, el precio y la estadística. Requiere las
recetas por producto (MM-43) y el calendario unificado (MM-40).

**Impacto en el plan:** la IA la implementa el **shell de MM-37** (spec 49,
t6: sidebar con los 5 módulos y ruteo), el catálogo/editor de MM-38 y MM-41
llenan el módulo 3, MM-40/42 llenan el 2, MM-43 llena el 1 y la parte de gasto
del 4, MM-44 agrega audit/RBAC al 5. No cambia el orden de ejecución.

---

## 34. Plan 2026-11-05: motor de reparto, portal del domiciliario, pasarela de pagos, capa de datos y marketplace

> Pedido del operador (2026-11-05): "quiero añadir un panel para gestionar
> domiciliarios, es decir que cada que se pague un producto combo domicilio
> para llevar, si hay un número, automáticamente al igual que al número de
> pedidos debe llegar el pedido al wsp del domiciliario y del admin; todo pedido
> debe quedar registrado; para esto quiero crear una solución para extraer datos
> y poder determinar en tiempo real stock y adquirir estadísticas". Luego:
> "necesito crear apis de pago funcionales y seguras para crear la pasarela de
> pago de e-commerce, haz un research de herramientas opensource", "que el
> domiciliario pueda confirmar pedido desde un usuario solo para ellos en el
> sistema" y "abarca un plan que contemple todo lo necesario back-end funcional
> con APIs para todos los servicios, también quiero que mejores el UI del
> apartado de productos para crear el marketplace".

### 34.1 Decisiones del operador (D16–D21)

| # | Decisión |
|---|---|
| **D16** | La asignación del domiciliario es **AUTOMÁTICA**: si hay uno disponible se asigna y el pedido **entra en cola**; el admin puede reasignar a mano. **Supera D7** ("el admin decide a qué domiciliario enviar", manual). |
| **D17** | Cada domiciliario tiene **su propia tarifa según su ubicación** (base + por km), con la ubicación fijada por el admin en el mapa. Sin domiciliario asignado se usa la tarifa ya especificada: distancia desde la ubicación del admin hasta el cliente. |
| **D18** | El domiciliario **envía su ubicación** y el precio al cliente se determina desde ella, pero con **piso de margen**: "el costo reduce y se busca la mayor rentabilidad con el modelo de negocio" → el precio nunca baja del costo + margen mínimo. |
| **D19** | El **pago contra entrega lo confirma el domiciliario** desde un **usuario solo para ellos** (rol propio + portal propio). |
| **D20** | El plan abarca **todo el back-end funcional con APIs para todos los servicios** + mejora del **UI del apartado de productos** para el marketplace. |
| **D21** | **Pasarela: Wompi** (una sola API cubre PSE, Nequi, Daviplata, Bancolombia, link de pago por WSP y tarjetas → 1 adapter en vez de 4). **Piso de margen: mínimo por pedido + % sobre el costo.** |

### 34.2 Veredicto del research OSS de pasarelas

| Candidato | Veredicto | Razón |
|---|---|---|
| **Hyperswitch** (juspay/hyperswitch, Rust, OSS) | **Rechazado como núcleo** | Orquestador multi-PSP (vault PCI, routing a 120+ PSPs, reconciliación 2/3-way, cost observability). No tiene métodos colombianos (PSE/Nequi/Daviplata) y exige Postgres+Redis con operación 24/7: desproporcionado para un mono-tenant en SQLite. Reconsiderar solo si el negocio llega a multi-comercio o exige vault PCI propio. |
| **Medusa v2** (Payment Module) | **Rechazado** | Es un framework e-commerce completo (authorize/capture/refund, payment collections, webhooks, providers). Adoptarlo es reescribir el backend: contradice la decisión de **no migrar de stack**. |
| **Arquitectura de adapter ya existente** | **Adoptado** | `src/lib/payments/adapters/*` con fail-closed, vault, outbox, idempotencia, ledger y state machine. Se añade **un adapter por proveedor colombiano**, empezando por **Wompi**. |

*Nota:* la doc de Wompi (`docs.wompi.co`) devolvió 403 al verificador, así que sus
métodos exactos **no** quedaron verificados en esta sesión: el operador confirma
cuenta, métodos y comisiones.

### 34.3 P0 reales que este plan cierra (auditados en código, no de memoria)

- El **domicilio no tocaba stock**: la reserva era condicional a `delivery_mode='scheduled'` → se podía **vender lo que no había**. `flavor_out_of_stock` además salía 500 en vez de 409.
- El **webhook no validaba amount/currency** contra `payments.amount_minor` ni cruzaba `provider_reference` con `payment_attempts` → un evento firmado con monto menor cobra el pedido completo.
- `POST /api/orders` es **público y dispara push de Nequi a cualquier teléfono** sin OTP → phishing y quema de cuota.
- Los pagos que quedan en `REQUIRES_ACTION` **nunca se barren** (`expires_at`) → las reservas de stock **no se liberan nunca**.
- `index.js` usaba `require()` en un módulo ESM (`supported: []` siempre vacío) y un `LIKE` que filtraba eventos de otros pagos.
- El **reconciler financiero era un TODO**; los refunds solo existían para `provider='manual'` y sin idempotencia propia.
- `payment_methods.provider` era **columna muerta**; `worker/` no tenía ninguna tabla de pagos ni montaba `/api/payments` ni `/api/webhooks`.
- **No existía `order_items`**: los ítems vivían en JSON y toda estadística parseaba en RAM.

### 34.4 Los cinco bloques (specs en dark-memory)

| Bloque | Spec | Tareas | Contenido |
|---|---|---|---|
| **A · Motor de reparto** | 57 | 12 | `couriers` (tarifa propia + ubicación) · `dispatches` (estados `assigned→picked_up→on_way→delivered/failed`, `assigned_by auto|manual`) · `dispatch_log` · CRUD `/api/couriers` · `src/lib/dispatch.js` (menos carga activa, desempate por distancia, radio máximo) · WSP 2ª plantilla `new_delivery_courier` + deep link de respaldo · panel "Domiciliarios" como módulo aparte |
| **B · Portal del domiciliario** | 57 (r8-r10) | 3 | Rol `courier` + `/api/courier/*` · `public/domiciliario.html` móvil (su cola, mapa, estados, confirmar cobro, incidencia) · `POST /api/courier/location` (heartbeat) |
| **C · Precio con piso de margen** | 57 (r4, r10) | 2 | Tarifa del domiciliario asignado con snapshot inmutable en el pedido; fallback a la distancia admin→cliente; piso = mínimo por pedido + % sobre el costo |
| **D · Pasarela + COD + seguridad** | 58 | 11 | Adapter Wompi · Nequi completo (refund, `REQUIRES_ACTION`, barrido de `expires_at`) · `payment_methods.provider` vivo · **COD como estado de dominio** (`cod_state`, ledger `cash_on_delivery`, cierre de caja) · reconciliación real · refunds con idempotencia propia · métricas de pagos · `audit_log` + CSP/cookie httpOnly · **los 4 P0 de seguridad** |
| **E · Datos + tiempo real** | 59 | 6 | `order_items` con backfill · `GET /api/inventory` (stock vendible por sabor/combo/día) · `GET /api/metrics` con rango libre `from/to` y desgloses (modo, domiciliario, estado, franja, barrio, método) · export CSV/Excel · **SSE** |
| **F · Marketplace UI** | 60 | 6 | Editor único de catálogo (combo = composición) · etiquetas en fuente única · imágenes con recorte y focal point · borrador→publicado con preview · stats de catálogo |

### 34.5 Orden de ejecución

`r5` (P0: el domicilio valida stock/ventana) → `r1-r3` (tablas + API + motor de
asignación y cola) → `r6-r7` (WSP al domiciliario + panel) → `r8-r10` (portal,
tarifa propia, ubicación y piso de margen) → `r11` (SSE) → `r12` (tests) →
después **spec 58** (pagos) en paralelo de **spec 59** (datos), y **spec 60**
(marketplace) al final.

### 34.6 Estado de ejecución

- **Hecho (2026-11-05):** `r5` — el domicilio **valida ventana y saldo** como la
  recogida. Se unificó la regla en `resolveWindowStock()` (única copia, la usan
  `validateScheduled` y la rama `immediate`), la entrega inmediata ahora exige
  **horario de reparto** para el día (`no_delivery_schedule`), **reserva** stock
  como cualquier pedido (antes no lo hacía) y devuelve **409** en
  `insufficient_stock` / `flavor_out_of_stock`. Regresión:
  `test/delivery-stock.test.js` (4 casos) + fixtures ajustados en
  `test/delivery-rules.test.js`. Suite **140/140**.
- **Abierto:** el cutoff propio del domicilio (el pedido inmediato hoy no tiene
  hora límite: lo decide la ventana abierta de stock).
- **Hecho (2026-11-05, tarde):** `r1` + `r2` + `r3` + `r8` + `r9` — la cadena
  mínima del **motor de reparto** y del **portal del domiciliario**. Archivos
  nuevos: `src/lib/dispatch.js` (motor), `src/routes/couriers.js` (CRUD admin),
  `src/routes/courier.js` (API del portal), `public/domiciliario.html` (portal
  móvil), `test/courier-dispatch.test.js` (13 casos). Suite **153/153**.
  - `r1` — tablas `couriers` (tarifa propia + ubicación + radio máximo),
    `dispatches` (estados `assigned→picked_up→on_way→delivered/failed`,
    `assigned_by auto|manual`, `cod_collected`), `dispatch_log` (rastro de cada
    transición) y `courier_locations` (heartbeat); `orders.courier_id` y
    `orders.dispatch_id`.
  - `r2` — `GET/POST /api/couriers`, `PATCH/DELETE /api/couriers/:id`,
    `POST /api/couriers/:id/dispatch` (asignación manual, D16). Todo **admin-only**.
    Crear el domiciliario con `email`+`password` le crea la cuenta de portal con
    `role='courier'`. No se puede borrar un domiciliario con repartos (409): se
    desactiva, para no perder historial.
  - `r3` — `src/lib/dispatch.js`: elige el de **menos carga activa**, desempata
    por **distancia** al destino y respeta el **radio máximo** por domiciliario.
    **Fail-closed**: sin domiciliario elegible no se asigna a nadie y el pedido
    del cliente NO falla (queda en la cola). La asignación salta al crear el
    pedido con `delivery_mode='immediate'`.
  - `r8`/`r9` — `POST /api/courier/login` (solo rol `courier`), `GET /api/courier/queue`
    (solo su cola), `POST /api/courier/dispatch/:id/status` (máquina de estados
    estricta e idempotente), `POST /api/courier/dispatch/:id/collect-cash`
    (cobro contra entrega idempotente: reusa `confirmManualPayment`, deja el
    pedido pagado y el stock vendido), `POST /api/courier/dispatch/:id/incident`
    (nota o fallo) y `POST /api/courier/location` (heartbeat de ubicación).
    Portal en `public/domiciliario.html`: login propio, su cola con el contenido
    del pedido, enlaces de WhatsApp/llamada/ruta, estados, cobro e incidencia.
    El domiciliario **solo** puede mover sus propios repartos.
  - **Nombre del portal:** `public/domiciliario.html` (decidido aquí; la nota de
    cuaderno #435 decía `/domiciliar.html` — manda este documento).
  - **Pendiente de esta cadena:** nada — `r11` (SSE) y `r12` (e2e) cerrados el
    2026-11-10. (`r6` — WSP al
    domiciliario — y `r7` — el módulo "Domiciliarios" dentro del panel admin —
    se completaron el 2026-11-05 por la noche; `r4`/`r10` el 2026-11-08.) El
    árbol `worker/` (Cloudflare Worker)
    **no** se tocó: el motor vive en `src/` (Node + SQLite, la arquitectura
    autónoma).
- **Hecho (2026-11-05, noche):** `r7` (UI) + **costo en el portal** +
  **rediseño de la sección Productos** del panel. Pedido literal del operador:
  "mejora la sección de productos pues se ve desorganizado sus componentes de
  UI respecto al panel de domiciliario; el usuario de domiciliario debe crearlo
  el admin en entregas para que este pueda acceder al panel de domiciliario y
  en este gestionar los pedidos atraves de un api determinando el costo desde
  la landing page al domiciliario junto con toda la informacion".
  - **`r7` (UI del admin):** subtab **Entregas → Domiciliarios**. El admin crea
    ahí al domiciliario (nombre, WhatsApp, email, clave, tarifa base, precio
    por km, radio máximo) y esa es la cuenta con la que entra a
    `/domiciliario.html`. Debajo, la tabla "Equipo de reparto" con su carga,
    entregados, tarifa, radio y estado (activar/desactivar/eliminar; con
    repartos no se borra, se desactiva).
  - **Costo en el portal del domiciliario:** `GET /api/courier/queue` devuelve
    por reparto un bloque `cost`: subtotal (del catálogo, no del cliente),
    domicilio, total a cobrar, distancia, y **el costo de recogida con la
    tarifa PROPIA del domiciliario** (base + por km) sobre la distancia entre
    el negocio y su última ubicación, con **piso de margen** (nunca por debajo
    de lo que el domicilio le cuesta al negocio). El domicilio de lalanding
    se recalcula con `evaluateDelivery()`, o sea **las mismas reglas que
    usa la landing** (`POST /api/delivery/quote`): el número que ve el
    domiciliario es el que pagó el cliente. Si el pedido no tiene
    coordenadas se cae al valor guardado del pedido (`source: 'pedido'`).
    La cola además trae toda la información: precios unitarios de cada item,
    ventana de recogida, método y estado de pago, notas y datos del cliente.
  - **Sección Productos del panel (rediseño):** una sola tarjeta "Imágenes"
    con las categorías en la cabecera, zona de arrastre compacta y la
    "Portada" como bloque dentro de la misma tarjeta; columna lateral con
    "Resumen" y "Cómo se usa" plegable; barra de catálogo con buscador, filtro
    de disponibilidad y contador; tarjetas de producto con foto cuando la hay.
    Se arreglaron tres defectos: el texto de portada quedaba encerrado en una
    columna de 150 px (dentro de un grid), la zona de arrastre comía media
    pantalla, y los mochis flotantes del login se colaban en los márgenes del
    panel (`body.app-on` los oculta).
- **Hecho (2026-11-08):** `r4`/`r10` — **piso de margen y precio de recogida
  congelado**. El precio de recogida del domiciliario (su tarifa propia: base +
  por km sobre la distancia negocio → domiciliario) ya no se recalcula en cada
  lectura de la cola: **se congela al asignar el reparto**.
  - **Piso de margen (D18):** el piso es lo que el domicilio le cuesta al
    negocio (`delivery_fee_cents`) **más** un margen mínimo: el mayor entre un
    **% sobre ese costo** (`courier_margin_pct`) y un **mínimo por pedido**
    (`courier_min_margin_cents`). Con 0 en los dos, el piso es el costo (lo que
    ya hacía).
  - **Snapshot inmutable:** al asignar (automático o manual) queda guardado en
    `dispatches.pickup_snapshot_json` + `dispatches.pickup_cost_cents` +
    `dispatches.pickup_distance_km` y en `orders.pickup_cost_cents`. El portal
    muestra ese número aunque el domicillero se mueva o el admin cambie las
    reglas: **lo que se cobra no cambia bajo los pies de quien cobra**. Los
    repartos anteriores (sin snapshot) se estiman en vivo y se marcan con
    `frozen: false`.
  - **Fallback (r4/r10):** sin ubicación conocida del domicillero, la distancia
    del negocio es la del pedido (admin → cliente) y el costo sale de su tarifa
    propia sobre esa distancia (`source: 'fallback_cliente'`).
  - **Dónde se configura:** Entregas → Inmediato → grupo **"Margen del
    reparto"** (% y mínimo por pedido), o por API `PUT /api/delivery-config`.
  - **Archivos:** `src/lib/courier-pricing.js` (nuevo: piso, cálculo y
    snapshot) · `src/lib/dispatch.js` (congela el snapshot al asignar) ·
    `src/routes/courier.js` (la cola usa el snapshot) · `src/db.js` (columnas) ·
    `src/routes/delivery-config.js` · `public/manage.html` ·
    `public/domiciliario.html`.
  - **Verificado:** suite **159/159** (4 casos nuevos en
    `test/courier-dispatch.test.js`: el % sobre el costo, el mínimo por pedido,
    el precio congelado aunque el domicillero se mueva, y el fallback sin
    ubicación).
- **Hecho (2026-11-05, noche):** `r6` — **WSP al domicillero**. Segunda
  plantilla de Meta Cloud API (`new_delivery_courier`, env
  `WHATSAPP_CLOUD_TEMPLATE_COURIER`): cuando se asigna un reparto (automático
  o manual) el pedido llega al WhatsApp del repartidor con la dirección, lo que
  debe cobrar, la fecha y el deep link de respaldo. Nunca rompe el pedido del
  cliente (si el WSP falla, el reparto sigue asignado). Archivos:
  `src/lib/whatsapp.js` (`buildCourierMessage` + `buildCourierDispatch`),
  `src/routes/orders.js`, `src/lib/dispatch.js` (`logWspOutcome` deja el rastro
  en `dispatch_log`).
- **Hecho (2026-11-08/10):** `r11` — **tiempo real (SSE)**. Bus de eventos en
  memoria (`src/lib/events.js`) + endpoint `GET /api/events?token=<jwt>`
  (`src/routes/events.js`, SSE nativo de Node, cero dependencias). El evento
  es la *señal*, no el dato: el cliente vuelve a pedir lo que necesita. Cada
  evento se entrega solo a quien le interesa (el admin ve todo; el
  domicillero solo sus repartos). El panel y el portal se suscriben y
  repintan sin recargar.
- **Hecho (2026-11-10):** `r12` — **e2e del ciclo completo** en
  `e2e/reparto.spec.ts` (5 tests × 3 viewports = 15): el admin crea el
  domiciliario en Entregas → Domiciliarios, el domicillero entra a su portal y
  reporta su ubicación, el pedido se asigna solo y sale el WSP con deep link,
  el domicillero avanza los estados y cobra contra entrega, y el panel se
  actualiza solo cuando el reparto cambia (SSE). El e2e es hermético: la
  dirección se precachea en la DB temporal (el `e2e/server.mjs` publica la
  ruta de la DB en un archivo de estado) para no depender de Nominatim.
  **Suite: 161/161 unit + 72/72 e2e.**
- **Dos bugs reales que el e2e destapó (corregidos el 2026-11-10):**
  1. **La geolocalización estaba bloqueada para todos**: el servidor mandaba
     `Permissions-Policy: geolocation=()`, así que el botón "Enviar ubicación"
     del portal **nunca pudo funcionar** en un navegador real — y de ella
     dependen la asignación por distancia y el precio de recogida. Ahora es
     `geolocation=(self)`.
  2. **El portal escondía el botón de cobro justo cuando servía**: la tarjeta
     lo ocultaba con el reparto en `delivered` (que es cuando la API sí
     acepta el cobro) y lo mostraba con el reparto en `assigned` (que es
     cuando la API lo rechaza). El domicillero no podía cobrar en el flujo
     natural (recoger → en camino → entregado → cobrar). Ahora el botón se
     ofrece mientras el reparto no esté anulado ni cobrado.
---

## 35. Stack tecnologico 100% open source y auto-alojado (2026-11-05)

> Pedido del operador: "quiero determinar un stack tecnologico para las apis de
> este proyecto en el cual use tecnologias opensource que no requieran de login
> por parte de mi admin ni los domiciliarios que sea totalmente independiente".

### 35.1 Criterio (medible, no retorico)

"Totalmente independiente" para MyMochis significa:

1. **Cero cuentas de terceros** que el admin o un domiciliario tengan que abrir
   para usar el producto. Entran con su email y clave de MyMochis y ya.
2. **Cero SaaS que cobre por uso** en el camino caliente (pedido, pago,
   reparto, mapa, mensaje).
3. **Todo corre en el `docker-compose.yml` del proyecto** o en la maquina del
   operador, y se puede apagar internet y seguir vendiendo.
4. **Cero lock-in de codigo**: si mañana se cae un componente, se cambia por
   otro sin reescribir el dominio.

Lo que NO entra en el criterio: que el operador tenga que contratar un banco o
un portal de pagos (ver 35.4, es imposible y lo es por ley/regulación).

### 35.2 Auditoria real de hoy (extraida del codigo, no de memoria)

Host externos que el proyecto usa hoy, con lo que exigen:

| Dependencia | Host | Que exige del operador |
|---|---|---|
| WhatsApp Cloud API | `graph.facebook.com`, `api.whatsapp.com` | Cuenta Meta Business + WABA + token + numero verificado |
| Instagram Graph | `graph.instagram.com` | Cuenta Meta Business + pagina de FB + token de larga vida |
| Google Maps JS | `maps.googleapis.com` | API key + cuenta de facturacion de Google (tarifa por uso) |
| Google Fonts | `fonts.googleapis.com` | Nada (CDN), pero es dependencia externa y punto de fuga de datos |
| Nequi / Daviplata / Bancolombia / MercadoPago | 4 APIs distintas | 4 contratos de comercio + 4 credenciales |
| Backups a R2 | Cloudflare R2 | Cuenta Cloudflare + credenciales S3 |
| Geocoding | `nominatim.openstreetmap.org` | Nada (publico) pero sin SLA, 1 req/s y prohibido en produccion masiva |
| Git remoto | GitHub | Cuenta GitHub (el operador la usa para trazabilidad; **decision propia, no forzada**) |

**Lo que YA es independiente y no hay que tocar:** runtime Node (MIT), Express
(MIT), SQLite via `node:sqlite` (sin driver nativo), JWT + scrypt propios,
ledger/outbox/idempotencia de pagos, deploy con Dockerfile + Caddy
(Apache-2.0), y el geocoding con Nominatim (sin key).

### 35.3 Stack elegido (licencias verificadas contra la API de GitHub, 2026-11-05)

| Capacidad | Hoy | Elegido | Licencia verificada | Que elimina |
|---|---|---|---|---|
| Runtime API | Node + Express | **Node 24 + Express (mantener)** | MIT | — (ya era OSS) |
| Contrato de API | no hay | **OpenAPI 3.1 + Scalar** (docs auto-alojadas) | MIT | el "no hay documentacion" |
| Validacion | a mano | **Zod** | MIT | errores silenciosos en el body |
| Base de datos | SQLite | **SQLite ahora** -> **PostgreSQL 17** cuando lo pida el volumen | PostgreSQL License | — (ya era OSS) |
| Cache / cola | nada (in-process) | **Valkey** (NO Redis: desde 2024 no es OSI) + **BullMQ** | BSD-3-Clause / MIT | dependencia no-OSI |
| Jobs | workers con `setInterval` | **BullMQ sobre Valkey** | MIT | timers que mueren con el server |
| Auth | JWT + scrypt propios | **mantener** (+ **Zitadel** si algun dia hay OIDC multi-servicio) | AGPL-3.0 / propio | ya es 0 cuentas |
| WhatsApp | Meta Cloud API | **WAHA** (`devlikeapro/waha`, Apache-2.0) o **Evolution API** | Apache-2.0 / NOASSERTION | cuenta Meta + WABA |
| Geocoding | Nominatim publico | **Photon** (`komoot/photon`) auto-alojado | Apache-2.0 | cuota publica, latencia, SLA |
| Mapas y rutas | Google Maps | **Leaflet + tiles OSM + OSRM** (`Project-OSRM/osrm-backend`) | BSD-2 / BSD-2 | API key + facturacion |
| Fuentes | Google Fonts | **auto-alojar los WOFF2** de `google/fonts` | OFL / Apache-2.0 | CDN externo + fuga de datos |
| Pagos | 4 cuentas | **BTCPay Server** (cripto, 0 cuentas) + **Wompi** (1 cuenta) como adapter | MIT / MIT | 4 cuentas -> 1 o 0 |
| Objetos (uploads) | disco local | **disco local** (ya) y **SeaweedFS** si se quiere API S3 (NO MinIO: AGPL + sin binarios desde 2026-04) | Apache-2.0 | dependencia R2/MinIO |
| Backups | R2 (Cloudflare) | **restic** -> disco local o SeaweedFS | BSD-2-Clause | cuenta Cloudflare |
| Secretos | env vars en claro | **SOPS + age** o Docker secrets | Apache-2.0 / MIT | secretos en el repo |
| Metricas y logs | logs sueltos | **OpenTelemetry + Prometheus + Grafana + Loki** | Apache-2.0 / AGPL-3.0 | — |
| Uptime / alertas | nada | **Uptime Kuma** | MIT | — |
| Correo | nada | **listmonk + Postfix** (o SMTP del hosting) | AGPL-3.0 / GPL | servicios de email |
| Push al domiciliario | nada | **Web Push (VAPID generado local)** o SSE nativo | Apache-2.0 | — |
| Realtime (r11) | pendiente | **SSE nativo de Node** (0 dependencias) | MIT | — |
| Proxy / TLS | Caddy | **Caddy (mantener)** | Apache-2.0 | — |
| Git | GitHub | **Gitea** si el operador quiere 0 cuentas; GitHub se queda si le sirve la trazabilidad | MIT | cuenta GitHub (decision del operador) |

### 35.4 Lo que NO se puede volver independiente (limites honestos)

1. **Tarjetas y PSE en Colombia no tienen OSS.** Toda pasarela real (Wompi,
   Nequi, Daviplata, Bancolombia, MercadoPago) exige **contrato de comercio** y
   KYC del operador. La meta alcanzable es **UNA cuenta** (D21: Wompi cubre
   PSE + Nequi + Daviplata + Bancolombia + link de pago por WSP + tarjetas) o
   **CERO** si se cobra en efectivo o en cripto (BTCPay). El dominio ya esta
   desacoplado (`src/lib/payments/adapters/*` con fail-closed, vault, outbox,
   idempotencia y ledger): cambiar de proveedor no toca pedidos ni contabilidad.
2. **Instagram no tiene alternativa OSS.** La Graph API oficial exige cuenta
   Meta Business. decision: o se mantiene como plug-in opcional (1 cuenta) o se
   saca la auto-publicacion y se publica a mano.
3. **WhatsApp auto-alojado va contra los ToS de WhatsApp.** WAHA y Evolution
   API usan Baileys (Web no oficial): el numero puede ser baneado. Solo
   corresponde en un numero secundario, nunca en el principal. La via oficial
   (Meta Cloud API) si exige cuenta.
4. **Auto-alojar significa mantener.** Cada pieza self-hosted la mantiene el
   operador (o un `syseng`). El ahorro es de cuentas y de costes por uso, no de
   trabajo.

### 35.5 Topologia objetivo (docker-compose)

```
caddy (TLS)  ->  app (Node+Express, imagen actual)
                   |- postgres (o sqlite en el volumen actual)
                   |- valkey  (cache + colas)
                   |- photon  (geocoding)   -> osrm (rutas)
                   |- waha    (WhatsApp)     -> [opcional] bitcoind + btcpay
                   |- seaweedfs (uploads, opcional)
                   `- prometheus -> grafana + loki + uptime-kuma
```

Todo con `restart: unless-stopped`, volumen local, y `.env.production` cifrado
con SOPS+age. El `docker-compose.yml` actual ya tiene `app` + `caddy` + volumen
`mymochis_data`: la migracion es agregar servicios, no reescribir el deploy.

### 35.6 Decisiones que faltan del operador (forks)

- **F1 · Pagos**: BTCPay (cripto, 0 cuentas, pero el cliente paga en cripto) |
  Wompi (1 cuenta, cubre PSE/tarjetas/Nequi) | efectivo + WSP manual (0 cuentas).
- **F2 · WhatsApp/Instagram**: auto-alojado (WAHA, riesgo ToS) | Meta oficial
  (1 cuenta) | sacar el auto-mensaje y avisar por la app del domiciliario.
- **F3 · Git**: Gitea auto-alojado (0 cuentas) | GitHub (trazabilidad para el
  operador, ya en uso).
- **F4 · Base de datos**: quedarse en SQLite (0 servicios) | Postgres (spec 59
  de metricas y `order_items` con volumen real).

### 35.7 Plan por fases (con gate de calidad por fase)

| Fase | Que | Esfuerzo | Gate |
|---|---|---|---|
| F0 | OpenAPI 3.1 + Scalar + Zod en las rutas nuevas | 1 dia | `/api/docs` sirve el contrato; tests siguen verdes |
| F1 | Auto-alojar fuentes (WOFF2) y cambiar el mapa del admin y del portal a Leaflet + OSM + OSRM | 2 dias | 0 peticiones a `fonts.googleapis.com` ni `maps.googleapis.com` (verificado en el log del server) |
| F2 | Photon + OSRM en el compose; `geocode.js` y la tarifa de distancia contra el servicio interno, con fallback a la cache y a Nominatim | 2-3 dias | la cotizacion de la landing sigue dando el mismo numero que hoy |
| F3 | WhatsApp: adapter WAHA detras de `src/lib/whatsapp.js` (fallback a Meta si el operador decide) | 1 dia | el WSP de pedido sigue saliendo y queda en el outbox |
| F4 | Backups con restic a disco local + prueba de restauracion (hoy van a R2) | 1 dia | `scripts/stack-smoke.sh` + restauracion probada |
| F5 | OpenTelemetry + Prometheus + Grafana + Loki + Uptime Kuma | 2 dias | alertas de pagos, reparto y salud del server |
| F6 | Postgres + Valkey + BullMQ (solo si el negocio crece) | 2-3 dias | migracion de datos con checksum + suite verde |
| F7 | Adapter BTCPay (cripto) o Wompi (1 cuenta) | 1-2 dias | idempotencia y fail-closed verificados con los tests de pagos |
| F8 | SOPS+age para `.env.production` | 0,5 dia | el compose levanta sin secretos en claro |

**Regla de este cap.:** cada fase entra por su propio commit atomico, con la
suite verde antes. Ninguna fase introduce una dependencia con login para el
admin o el domiciliario; las unicas dependencias con cuenta quedan aisladas
dentro de un adapter (`src/lib/payments/adapters/*`, `src/lib/whatsapp.js`), que
es justo lo que ya permite el diseño actual.

---

## 35.8 Estado de ejecución de specs 57-60 (2026-11-10)

- **spec 57 · Motor de reparto · COMPLETA (12/12 tareas r1-r12)** — commits 364277e, 374874f, a5997ad, 31d4a25, 449a3e7. Suite 161/161 unit + 72/72 e2e.
- **spec 58 · Pasarela de pagos + seguridad P0 · COMPLETA (11/11 tareas p1-p11)** — commits d4fe266, f8fb930, 6e9e3a9, 07ef802, 5fd07c7, ebb5da0, 40d4988, 03408e1, 67389d0. Suite 163/163 verde.
- **spec 59 · Capa de datos · COMPLETA (d1-d6)** — commit 925b9f0. Suite 165/165 verde.
- **spec 60 · Marketplace UI · NO INICIADA** — editor único de catálogo (combo como composición), etiquetas en fuente única, imágenes con recorte/focal point, publicación borrador→publicado, stats de catálogo, e2e.
