#!/usr/bin/env bash
# ============================================================================
# mymochis OCI deployment preflight (idempotente)
# Ejecutar ANTES de cualquier terraform/ansible/ssh a la VM real.
# No modifica nada del host. Solo reporta qué falta.
#
# Uso:  bash scripts/preflight-oci.sh
# Salida: exit 0 si todos los prerequisitos OK; exit 1 con lista de gaps.
# ============================================================================
set -uo pipefail

PASS=0
FAIL=0
GAPS=()

ok()   { echo "  [✓] $1"; PASS=$((PASS+1)); }
fail() { echo "  [✗] $1"; GAPS+=("$1"); FAIL=$((FAIL+1)); }

echo "============================================================"
echo " mymochis OCI preflight — 2026-10-11"
echo "============================================================"

# --- 1. Cuenta Oracle Cloud Always Free ---
echo ""
echo "[1] Cuenta Oracle Cloud Always Free"
if command -v oci >/dev/null 2>&1; then
  if oci iam user get --self 2>/dev/null | grep -q "data"; then
    ok "OCI CLI autenticado"
  else
    fail "OCI CLI instalado pero no autenticado. Correr: oci setup config"
  fi
else
  fail "OCI CLI no instalado. Instalar con: pip install oci-cli (o winget install Oracle.OCICLI)"
  fail "  + crear cuenta Always Free: https://cloud.oracle.com/free"
fi

# --- 2. Dominio DNS ---
echo ""
echo "[2] Dominio DNS configurado"
DOMAIN="${DOMAIN:-${PUBLIC_ORIGIN#https://}}"
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "mymochis.example.com" ]; then
  if command -v dig >/dev/null 2>&1; then
    if dig +short "$DOMAIN" A 2>/dev/null | grep -qE '^[0-9]'; then
      ok "Dominio $DOMAIN resuelve a una IP A"
    else
      fail "Dominio $DOMAIN no resuelve. Configurar DNS A/AAAA hacia la VM OCI"
    fi
  else
    echo "  [?] dig no instalado — verificar DNS manualmente"
  fi
else
  fail "DOMAIN es placeholder (mymochis.example.com). Cambiar en .env.production antes de deploy"
fi

# --- 3. Cloudflare R2 bucket + API key ---
echo ""
echo "[3] Cloudflare R2 bucket + API key"
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_BUCKET:-}" ]; then
  ok "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET presentes en entorno"
else
  fail "Faltan variables R2_*. Crear bucket + API token en https://dash.cloudflare.com/?to=/:account/r2"
  fail "  + añadir R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET al .env.production"
fi

# --- 4. SSH key pair ---
echo ""
echo "[4] SSH key pair para la VM OCI"
SSH_KEY="${HOME}/.ssh/id_ed25519_oci"
if [ -f "$SSH_KEY" ] && [ -f "${SSH_KEY}.pub" ]; then
  ok "SSH key encontrada: $SSH_KEY"
  echo "      Fingerprint: $(ssh-keygen -lf "$SSH_KEY" 2>/dev/null | awk '{print $2}')"
  echo "      Subir pubkey a OCI: Compute → Instances → Create → Paste SSH keys"
else
  fail "SSH key no encontrada. Generar con: ssh-keygen -t ed25519 -f $SSH_KEY -C 'oci-deploy'"
fi

# --- 5. .env.production completo ---
echo ""
echo "[5] .env.production con secrets reales"
ENV_FILE=".env.production"
if [ -f "$ENV_FILE" ]; then
  EMPTY_VARS=0
  for var in NEXOMOCHIS_JWT_SECRET ADMIN_PASSWORD DOMAIN AGE_RECIPIENT R2_BUCKET; do
    val=$(grep "^${var}=" "$ENV_FILE" | cut -d= -f2-)
    if [ -z "$val" ] || [ "$val" = "age1..." ]; then
      fail ".env.production: ${var} está vacío o placeholder"
      EMPTY_VARS=$((EMPTY_VARS+1))
    fi
  done
  [ $EMPTY_VARS -eq 0 ] && ok ".env.production: todos los secrets críticos presentes"
else
  fail "$ENV_FILE no existe. Copiar de .env.production.example y poblar secrets"
fi

# --- 6. Validaciones de artefactos del repo ---
echo ""
echo "[6] Validación de artefactos locales (no requiere OCI)"
[ -f "Dockerfile" ]    && ok "Dockerfile presente" || fail "Dockerfile falta"
[ -f "docker-compose.yml" ] && ok "docker-compose.yml presente" || fail "docker-compose.yml falta"
[ -f "Caddyfile" ]    && ok "Caddyfile presente" || fail "Caddyfile falta"
[ -x "scripts/backup-mymochis.sh" ]   && ok "scripts/backup-mymochis.sh ejecutable" || fail "scripts/backup-mymochis.sh no ejecutable (chmod +x)"
[ -x "scripts/restore-mymochis.sh" ]  && ok "scripts/restore-mymochis.sh ejecutable" || fail "scripts/restore-mymochis.sh no ejecutable"
[ -x "scripts/stack-smoke.sh" ]       && ok "scripts/stack-smoke.sh ejecutable" || fail "scripts/stack-smoke.sh no ejecutable"

# Docker compose syntax
if command -v docker >/dev/null 2>&1; then
  if docker compose config --quiet 2>/dev/null; then
    ok "docker compose config válido"
  else
    fail "docker compose config tiene errores de sintaxis"
  fi
else
  echo "  [?] docker no instalado localmente — validar sintaxis en la VM"
fi

# --- 7. Local build smoke (opcional, requiere Docker) ---
echo ""
echo "[7] Build smoke local (opcional, requiere Docker)"
if command -v docker >/dev/null 2>&1; then
  if docker build -t mymochis-preflight -f Dockerfile . >/dev/null 2>&1; then
    ok "Dockerfile build exit 0"
  else
    fail "Dockerfile build falló (revisar sintaxis COPY, npm ci)"
  fi
else
  echo "  [?] docker no instalado localmente — build se valida en la VM"
fi

# --- Resumen ---
echo ""
echo "============================================================"
echo " RESUMEN: $PASS OK, $FAIL gaps"
echo "============================================================"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "ACTION: resolver los gaps listados arriba antes de continuar."
  echo "Cuando todos estén en verde, ejecutar:"
  echo "  bash scripts/stack-smoke.sh        # smoke pre-deploy"
  echo "  bash scripts/deploy-oci.sh        # ansible/terraform a la VM"
  exit 1
fi

echo ""
echo "Todos los prerequisitos OK. Proceder con deploy OCI."
exit 0
