# Deployment Guide — PostgreSQL MCP Server

Deploy to any VPS with Node.js 18+, nginx, and systemd.

---

## Overview

| What | Value |
| --- | --- |
| Server path | `/opt/PostgresMCP/` |
| Port (internal) | `3200` |
| Domain | `YOUR_DOMAIN` |
| MCP endpoint | `https://YOUR_DOMAIN/mcp` |
| Health check | `https://YOUR_DOMAIN/health` |
| systemd service | `postgres-mcp` |

---

## Step 1 — Point your domain to the VPS

Configure your DNS provider to point your domain to the VPS IP address.

Verify:
```bash
ping YOUR_DOMAIN
```

---

## Step 2 — Clone repo on VPS

```bash
ssh root@YOUR_VPS_IP

git clone https://github.com/YOUR_USERNAME/postgres-mcp-server /opt/PostgresMCP
cd /opt/PostgresMCP
```

---

## Step 3 — Install Node.js (if not already installed)

```bash
# Check first
node --version  # should be 18+

# Install if needed
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

---

## Step 4 — Install dependencies and build

```bash
cd /opt/PostgresMCP
npm install
npm run build
```

Verify the build produced `dist/index.js`:
```bash
ls dist/index.js
```

---

## Step 5 — Create connections.json

This file stays on the server only — **never commit it to git**.

```bash
cat > /opt/PostgresMCP/connections.json << 'EOF'
{
  "mydb": "postgresql://user:password@localhost:5432/mydb"
}
EOF
```

> To add more DBs later, just add entries here and restart the service — no code changes needed.

---

## Step 6 — Create .env

```bash
# Generate a strong random token
TOKEN=$(openssl rand -hex 32)
echo "Your MCP_TOKEN: $TOKEN"   # save this somewhere!

cat > /opt/PostgresMCP/.env << EOF
TRANSPORT=http
PORT=3200
DEFAULT_DB=mydb
MCP_TOKEN=$TOKEN
EOF
```

---

## Step 7 — Install systemd service

```bash
cp /opt/PostgresMCP/deploy/postgres-mcp.service /etc/systemd/system/postgres-mcp.service

systemctl daemon-reload
systemctl enable postgres-mcp
systemctl start postgres-mcp

# Verify it's running
systemctl status postgres-mcp
```

Check logs:
```bash
journalctl -u postgres-mcp -f
```

Expected output:
```
[postgres-mcp] HTTP server running on port 3200
[postgres-mcp] Endpoint: http://0.0.0.0:3200/mcp
[postgres-mcp] Active DB: mydb
[postgres-mcp] Auth: Bearer token enabled
```

---

## Step 8 — Install nginx config

```bash
cp /opt/PostgresMCP/deploy/nginx-postgres-mcp.conf /etc/nginx/sites-available/postgres-mcp
ln -s /etc/nginx/sites-available/postgres-mcp /etc/nginx/sites-enabled/postgres-mcp
```

Insert the token into the nginx config before testing:
```bash
YOUR_TOKEN=$(grep MCP_TOKEN /opt/PostgresMCP/.env | cut -d= -f2)
sed -i "s/REPLACE_WITH_YOUR_TOKEN/$YOUR_TOKEN/g" /etc/nginx/sites-available/postgres-mcp
```

Replace the domain placeholder:
```bash
sed -i "s/YOUR_DOMAIN/your.actual.domain/g" /etc/nginx/sites-available/postgres-mcp
```

```bash
# Test nginx config
nginx -t

# Reload nginx
systemctl reload nginx
```

---

## Step 9 — SSL certificate with certbot

```bash
certbot --nginx -d YOUR_DOMAIN
```

Certbot will:
1. Verify domain ownership
2. Issue Let's Encrypt certificate
3. Automatically update the nginx config with SSL settings

Auto-renewal is already enabled via the certbot systemd timer. Verify:
```bash
systemctl status certbot.timer
```

---

## Step 10 — Verify everything works

```bash
# Health check (no auth needed)
curl https://YOUR_DOMAIN/health
# Expected: {"status":"ok","activeDb":"mydb","connections":["mydb"],"sessions":0}

# Test auth rejection
curl https://YOUR_DOMAIN/mcp -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401 Unauthorized

# Test with token
curl https://YOUR_DOMAIN/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# Expected: JSON response with serverInfo
```

---

## Step 11 — Add to Claude Code (local)

```powershell
claude mcp add --transport http postgres-mcp "https://YOUR_DOMAIN/mcp?token=YOUR_MCP_TOKEN"
```

---

## Deploying Updates

```bash
# On local machine
git add . && git commit -m "feat: ..." && git push

# On VPS
cd /opt/PostgresMCP
git pull
npm run build
systemctl restart postgres-mcp
systemctl status postgres-mcp
```

---

## Adding a New Database Connection

No code changes needed — just edit `connections.json` and restart:

```bash
nano /opt/PostgresMCP/connections.json

# Example:
# {
#   "mydb": "postgresql://user:pass@localhost:5432/mydb",
#   "analytics": "postgresql://user:pass@localhost:5432/analytics"
# }

systemctl restart postgres-mcp
```

Then in Claude: `pg_list_connections` → `pg_use_connection("analytics")` → query away.

---

## Service Management

```bash
systemctl status postgres-mcp      # current status
systemctl restart postgres-mcp     # restart
systemctl stop postgres-mcp        # stop
journalctl -u postgres-mcp -f      # live logs
journalctl -u postgres-mcp -n 50   # last 50 log lines
```

---

## Troubleshooting

**Service won't start**
```bash
journalctl -u postgres-mcp -n 30
# Check: Does dist/index.js exist? Did npm run build succeed?
# Check: Is .env present? Is connections.json valid JSON?
```

**Cannot connect to PostgreSQL**
```bash
# Test the connection string directly
psql postgresql://user:password@localhost:5432/mydb -c "SELECT 1"
```

**nginx 502 Bad Gateway**
```bash
# Check if the Node process is running on port 3200
systemctl status postgres-mcp
curl http://localhost:3200/health  # should work from VPS
```

**SSL certificate expired**
```bash
certbot renew --dry-run   # test renewal
certbot renew              # force renewal
systemctl reload nginx
```
