#!/bin/bash
# PhotoLynk Remote Server — one-line self-hosted installer
#
#   curl -fsSL https://raw.githubusercontent.com/viktorvishyn369/Server-Public/main/install.sh | sudo bash
#
# What it does:
#   1. Installs Node.js + Git (if missing)
#   2. Downloads the remote-server code from this public repo
#   3. Installs dependencies and creates a systemd service (auto-start on boot)
#   4. Optionally configures Nginx + Let's Encrypt HTTPS for your domain
#
# You need: a VPS (Ubuntu/Debian) and a domain whose DNS A record points to it.
#
# Non-interactive overrides (env vars survive `sudo` only via `sudo -E` or
# `sudo VAR=... bash`): DOMAIN, CERT_EMAIL, DO_HTTPS (y/n), DATA_DIR,
# INSTALL_DIR. Without a terminal, HTTPS setup is skipped with instructions.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}$*${NC}"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

REPO_URL="https://github.com/viktorvishyn369/Server-Public.git"
INSTALL_DIR="${INSTALL_DIR:-/opt/photolynk-remote}"
SERVICE_NAME="photolynk-remote"
SERVICE_USER="photolynk"
DATA_DIR="${DATA_DIR:-/var/lib/photolynk}"
APP_PORT=3000

echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   PhotoLynk Remote Server — Self-Hosted Installer   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    err "This installer needs root. Re-run with: sudo bash install.sh"
    exit 1
fi

# ── Interactive prompts ────────────────────────────────────────────────
# `curl ... | sudo bash` feeds the SCRIPT through stdin, so plain `read`
# would swallow the script itself. All prompts read /dev/tty (the real
# terminal) instead; with no controlling terminal we fall back to env vars
# and skip anything that requires an answer.
HAVE_TTY=0
if [ -r /dev/tty ] && [ -w /dev/tty ]; then HAVE_TTY=1; fi

ask() {
    # ask VAR_NAME "Prompt text" [default]
    local var="$1" prompt="$2" default="${3:-}" answer=""
    if [ "$HAVE_TTY" -eq 1 ]; then
        read -r -p "$prompt" answer < /dev/tty || true
    fi
    answer="${answer:-$default}"
    printf -v "$var" '%s' "$answer"
}

# ── 1. Git ─────────────────────────────────────────────────────────────
log "[1/8] Checking Git…"
if ! command -v git >/dev/null 2>&1; then
    warn "Git not found — installing…"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y && apt-get install -y git
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y git
    elif command -v yum >/dev/null 2>&1; then
        yum install -y git
    else
        err "Cannot install Git automatically — install it and re-run."
        exit 1
    fi
fi
ok "Git: $(git --version | awk '{print $3}')"

# ── 2. Node.js 20 LTS ──────────────────────────────────────────────────
log "[2/8] Checking Node.js…"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
    [ "${NODE_MAJOR:-0}" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 0 ]; then
    warn "Node.js 18+ not found — installing Node.js 20 LTS…"
    if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        dnf install -y nodejs
    elif command -v yum >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
    else
        err "Unsupported distro for automatic Node install — install Node.js 20+ manually: https://nodejs.org/"
        exit 1
    fi
fi
ok "Node.js: $(node -v)"

# ── 3. Download server code ────────────────────────────────────────────
log "[3/8] Downloading PhotoLynk remote server…"
if [ -d "$INSTALL_DIR/.git" ]; then
    ok "Existing install found — updating…"
    cd "$INSTALL_DIR"
    GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin main
    GIT_TERMINAL_PROMPT=0 git reset --hard origin/main
else
    # Sparse checkout: only remote-server/ is needed
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    git sparse-checkout set remote-server
fi
SERVER_DIR="$INSTALL_DIR/remote-server"
[ -f "$SERVER_DIR/server.js" ] || { err "remote-server/server.js missing after clone — repo layout changed?"; exit 1; }
node --check "$SERVER_DIR/server.js" || { err "server.js failed syntax check — aborting."; exit 1; }
ok "Code ready at $SERVER_DIR"

# ── 4. Dependencies ────────────────────────────────────────────────────
log "[4/8] Installing dependencies (this can take a few minutes)…"
cd "$SERVER_DIR"
npm install --omit=dev --no-audit --no-fund
ok "Dependencies installed"

# ── 5. Service user + data directories ─────────────────────────────────
log "[5/8] Preparing service user and data directories…"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    # Dedicated unprivileged user — the server handles untrusted uploads,
    # so it must not run as root.
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "Created system user: $SERVICE_USER"
fi
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/cloud" "$DATA_DIR/.well-known"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true
ok "Data dir: $DATA_DIR (owned by $SERVICE_USER)"

# ── 6. systemd service ─────────────────────────────────────────────────
log "[6/8] Creating systemd service…"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=PhotoLynk Remote Server (self-hosted)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SERVER_DIR
Environment="PORT=$APP_PORT"
Environment="HOST=0.0.0.0"
Environment="PHOTOSYNC_DATA_DIR=$DATA_DIR"
Environment="UPLOAD_DIR=$DATA_DIR/uploads"
Environment="DB_PATH=$DATA_DIR/backup.db"
Environment="HOME=$DATA_DIR"
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service ${SERVICE_NAME} is running on port $APP_PORT"
else
    err "Service failed to start — check: journalctl -u $SERVICE_NAME -n 50"
    if command -v ss >/dev/null 2>&1; then
        ss -ltnp "sport = :$APP_PORT" 2>/dev/null | grep -i listen || true
        warn "If port $APP_PORT shows a non-node process above, free it and re-run: systemctl restart $SERVICE_NAME"
    fi
    exit 1
fi

# ── 7. Firewall ────────────────────────────────────────────────────────
log "[7/8] Firewall…"
if command -v ufw >/dev/null 2>&1; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw allow $APP_PORT/tcp >/dev/null 2>&1 || true
    ok "UFW: ports 80, 443, $APP_PORT open"
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp --add-port=${APP_PORT}/tcp >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "Firewalld: ports 80, 443, $APP_PORT open"
else
    warn "No firewall tool found — make sure ports 80/443 are open in your cloud provider's security group."
fi

# ── HTTPS setup (interactive) ──────────────────────────────────────────
echo ""
log "════════════════════════════════════════════════════════════════"
log "  Server is installed and running on port $APP_PORT (HTTP)."
log "════════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}Next: connect your domain with free HTTPS (recommended).${NC}"
echo "  The PhotoLynk app expects your server on HTTPS port 443 for domains."
echo "  You need a domain whose DNS A record already points to this server."
echo ""

SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo -e "  ${BLUE}This server's public IP:${NC} ${YELLOW}$SERVER_IP${NC}"
echo ""
echo -e "  ${BLUE}Don't have a domain?${NC} Cheap options:"
echo -e "    • Porkbun   — https://porkbun.com        (~\$8-12/yr)"
echo -e "    • Namecheap — https://www.namecheap.com  (~\$10-15/yr)"
echo -e "    • Cloudflare — https://www.cloudflare.com/products/registrar/ (at-cost)"
echo ""
echo -e "  ${BLUE}DNS setup:${NC} create an A record, e.g.  ${YELLOW}photos.yourdomain.com → $SERVER_IP${NC}"
echo ""
echo -e "  ${BLUE}No domain at all?${NC} The app also accepts ${YELLOW}http://$SERVER_IP:$APP_PORT${NC}"
echo -e "  ${YELLOW}but that is plain HTTP — only use it on networks you trust.${NC}"
echo ""

DO_HTTPS="${DO_HTTPS:-}"
DOMAIN="${DOMAIN:-}"
CERT_EMAIL="${CERT_EMAIL:-}"

if [ -z "$DO_HTTPS" ]; then
    ask DO_HTTPS "Set up HTTPS with a domain now? [Y/n]: " "Y"
fi
DO_HTTPS="${DO_HTTPS:-Y}"

if [[ "$DO_HTTPS" =~ ^[Nn] ]]; then
    warn "Skipped. Re-run this script any time to configure HTTPS, or set up your own reverse proxy."
    DOMAIN="" # honor the opt-out even if DOMAIN was pre-set via env
elif [ "$HAVE_TTY" -eq 0 ] && [ -z "$DOMAIN" ]; then
    warn "No terminal available for prompts — HTTPS setup skipped."
    warn "Re-run interactively, or pre-set DOMAIN and CERT_EMAIL env vars."
else
    if [ -z "$DOMAIN" ]; then
        ask DOMAIN "Enter your domain (e.g. photos.example.com): " ""
    fi
    DOMAIN="$(echo "$DOMAIN" | tr -d ' ' | sed 's|^https\?://||' | cut -d/ -f1)"
    if [ -z "$DOMAIN" ]; then
        err "No domain given — skipping HTTPS."
    else
        # DNS sanity check (best effort, non-fatal). Only compare when we
        # have a public IP — a NAT/private fallback can't be checked reliably.
        RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
        SERVER_IP_PUBLIC=1
        echo "$SERVER_IP" | grep -qE '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|169\.254\.|::1|f[cd])' && SERVER_IP_PUBLIC=0
        if [ "$SERVER_IP_PUBLIC" -eq 1 ] && [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$SERVER_IP" ]; then
            warn "DNS for $DOMAIN currently resolves to $RESOLVED, not $SERVER_IP."
            warn "If you just changed DNS, wait a few minutes and re-run this script."
            CONT=""
            ask CONT "Continue anyway? [y/N]: " "N"
            [[ "$CONT" =~ ^[Yy] ]] || DOMAIN=""
        fi
    fi
fi

if [ -n "${DOMAIN:-}" ]; then
    log "Installing Nginx + Certbot…"
    TLS_TOOLS_OK=0
    if command -v apt-get >/dev/null 2>&1; then
        if apt-get update -y && apt-get install -y nginx certbot python3-certbot-nginx; then
            TLS_TOOLS_OK=1
        fi
    elif command -v dnf >/dev/null 2>&1; then
        if dnf install -y nginx certbot python3-certbot-nginx; then
            TLS_TOOLS_OK=1
        fi
    elif command -v yum >/dev/null 2>&1; then
        if yum install -y nginx certbot python3-certbot-nginx; then
            TLS_TOOLS_OK=1
        fi
    fi
    if [ "$TLS_TOOLS_OK" -eq 0 ]; then
        warn "Could not install nginx/certbot automatically — configure TLS manually"
        warn "(Caddy, an existing reverse proxy, or certbot with your own web server)."
        DOMAIN=""
    fi
fi

if [ -n "${DOMAIN:-}" ]; then
    # Debian/Ubuntu: sites-available + sites-enabled. RHEL/Fedora: conf.d/*.conf.
    if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
        log "Writing Nginx site config for $DOMAIN (Debian layout)…"
        tee "/etc/nginx/sites-available/photolynk-remote" > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Long uploads (multi-GB videos)
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
        ln -sf "/etc/nginx/sites-available/photolynk-remote" "/etc/nginx/sites-enabled/photolynk-remote"
    elif [ -d /etc/nginx/conf.d ]; then
        log "Writing Nginx config for $DOMAIN (conf.d layout)…"
        tee "/etc/nginx/conf.d/photolynk-remote.conf" > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Long uploads (multi-GB videos)
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
    else
        warn "Unrecognized nginx layout — configure the reverse proxy manually:"
        warn "  proxy_pass http://127.0.0.1:$APP_PORT with X-Forwarded-* headers and no body buffering."
        DOMAIN=""
    fi
fi

if [ -n "${DOMAIN:-}" ]; then
    if nginx -t; then
        systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null \
            || warn "nginx failed to reload — run: systemctl restart nginx"
        ok "Nginx configured"
    else
        err "nginx -t failed — fix /etc/nginx config, then run: certbot --nginx -d $DOMAIN"
        DOMAIN=""
    fi
fi

HTTPS_DONE=""
if [ -n "${DOMAIN:-}" ]; then
    if [ -z "$CERT_EMAIL" ]; then
        ask CERT_EMAIL "Email for Let's Encrypt expiry notices (required): " ""
    fi
    if [ -z "$CERT_EMAIL" ]; then
        err "Email required for Certbot — HTTPS not configured."
        warn "When ready, run:  certbot --nginx -d $DOMAIN -m you@example.com --agree-tos --redirect"
    else
        log "Requesting TLS certificate (make sure DNS already points here)…"
        if certbot --nginx -d "$DOMAIN" -m "$CERT_EMAIL" --agree-tos --redirect --non-interactive; then
            ok "HTTPS enabled: https://$DOMAIN"
            HTTPS_DONE=1
        else
            warn "Certbot failed — usually DNS isn't pointing here yet."
            warn "Fix DNS, then run:  certbot --nginx -d $DOMAIN"
        fi
    fi
fi

# ── Done ───────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ PhotoLynk Remote Server installed!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Connect the PhotoLynk app:${NC}"
if [ -n "${HTTPS_DONE:-}" ]; then
    echo -e "  1. In PhotoLynk: ${YELLOW}Settings → Server → Remote${NC}"
    echo -e "  2. Enter: ${YELLOW}$DOMAIN${NC}   (no https://, no port)"
elif [ -n "${DOMAIN:-}" ]; then
    echo -e "  1. Finish HTTPS first: ${YELLOW}certbot --nginx -d $DOMAIN${NC}"
    echo -e "  2. Then in PhotoLynk: ${YELLOW}Settings → Server → Remote${NC} → enter ${YELLOW}$DOMAIN${NC}"
else
    echo -e "  1. Point a domain's A record to: ${YELLOW}$SERVER_IP${NC}"
    echo -e "  2. Re-run this script to enable HTTPS, then in PhotoLynk:"
    echo -e "     ${YELLOW}Settings → Server → Remote${NC} → enter your domain"
    echo -e "  ${BLUE}Or skip HTTPS:${NC} enter ${YELLOW}$SERVER_IP${NC} in the app — it will use"
    echo -e "     ${YELLOW}http://$SERVER_IP:$APP_PORT${NC} (plain HTTP — trusted networks only)"
fi
echo ""
echo -e "${BLUE}Manage the service:${NC}"
echo -e "  status:   ${YELLOW}systemctl status $SERVICE_NAME${NC}"
echo -e "  logs:     ${YELLOW}journalctl -u $SERVICE_NAME -f${NC}"
echo -e "  restart:  ${YELLOW}systemctl restart $SERVICE_NAME${NC}"
echo -e "  update:   ${YELLOW}cd $INSTALL_DIR && git pull && cd remote-server && npm install --omit=dev && systemctl restart $SERVICE_NAME${NC}"
echo -e "  health:   ${YELLOW}curl http://localhost:$APP_PORT/api/health${NC}"
echo ""
echo -e "${BLUE}Your files are stored unencrypted under:${NC} ${YELLOW}$DATA_DIR/uploads${NC}"
echo -e "${YELLOW}Back them up yourself — this server has no cloud copy.${NC}"
echo ""
