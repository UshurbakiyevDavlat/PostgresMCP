# Deployment Guide — PostgreSQL MCP Server

Deploy to Hetzner CAX11 (`204.168.250.116`) — same server as knowledge-agent and linkedin-mcp.

---

## Overview

| What | Value |
| --- | --- |
| Server path | `/opt/PostgresMCP/` |
| Port (internal) | `3200` |
| Domain | `davlat-postgres.duckdns.org` |
| MCP endpoint | `https://davlat-postgres.duckdns.org/mcp` |
| Health check | `https://davlat-postgres.duckdns.org/health` |
| systemd service | `postgres-mcp` |

---

## Step 1 — DuckDNS subdomain

Open https://www.duckdns.org and add a new subdomain: **`davlat-postgres`**
Point it to `204.168.250.116` (same IP as your other MCPs).

Verify:
```bash
ping davlat-postgres.duckdns.org
```

---

## Step 2 — Clone repo on VPS

```bash
ssh root@204.168.250.116

git clone https://github.com/UshurbakiyevDavlat/postgres-mcp-server /opt/PostgresMCP
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
  "knowledge": "postgresql://agent:agentpass@localhost:5432/knowledge"
}
EOF
```

> The `knowledge` database is the existing pgvector DB running in Docker on this server.
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
DEFAULT_DB=knowledge
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
[postgres-mcp] Active DB: knowledge
[postgres-mcp] Connections: knowledge
[postgres-mcp] Auth: Bearer token enabled
```

---

## Step 8 — Install nginx config

```bash
cp /opt/PostgresMCP/deploy/nginx-postgres-mcp.conf /etc/nginx/sites-available/postgres-mcp
ln -s /etc/nginx/sites-available/postgres-mcp /etc/nginx/sites-enabled/postgres-mcp

# Test nginx config
nginx -t

# Reload nginx
systemctl reload nginx
```

---

## Step 9 — SSL certificate with certbot

```bash
certbot --nginx -d davlat-postgres.duckdns.org
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
curl https://davlat-postgres.duckdns.org/health
# Expected: {"status":"ok","activeDb":"knowledge","connections":["knowledge"],"sessions":0}

# Test auth rejection
curl https://davlat-postgres.duckdns.org/mcp -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401 Unauthorized

# Test with token
curl https://davlat-postgres.duckdns.org/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# Expected: JSON response with serverInfo
```

---

## Step 11 — Add to Claude Code (local)

```powershell
claude mcp add --transport http postgres-mcp https://davlat-postgres.duckdns.org/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"
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
# Edit the file
nano /opt/PostgresMCP/connections.json

# Example — add mps_prod:
# {
#   "knowledge": "postgresql://agent:agentpass@localhost:5432/knowledge",
#   "mps_prod": "postgresql://user:pass@10.0.0.1:5432/mps"
# }

# Restart to pick up changes
systemctl restart postgres-mcp
```

Then in Claude: `pg_list_connections` → `pg_use_connection("mps_prod")` → query away.

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
# Verify the Docker container is running
docker ps | grep pgvector

# Test the connection string directly
psql postgresql://agent:agentpass@localhost:5432/knowledge -c "SELECT 1"
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
