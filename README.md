# PostgreSQL MCP Server

Read-only MCP-сервер для PostgreSQL. Даёт Claude доступ к базе данных для анализа схемы, выполнения SELECT-запросов и диагностики производительности.

Поддерживает **named connections** (несколько баз одновременно), **dual transport** (SSE для Cowork + Streamable HTTP для Claude Code CLI) и деплой на VPS с nginx + systemd.

## Инструменты (Tools)

| Tool | Описание |
|------|----------|
| `pg_list_connections` | Список всех доступных named connections и активная база |
| `pg_use_connection` | Переключиться на другую базу без рестарта сервера |
| `pg_query` | Выполнить SELECT-запрос (write-запросы заблокированы) |
| `pg_list_tables` | Список всех таблиц с размерами и количеством строк |
| `pg_describe_table` | Структура таблицы: колонки, типы, PK, FK, индексы |
| `pg_explain_query` | План выполнения запроса (EXPLAIN ANALYZE) |
| `pg_table_stats` | Статистика таблицы: dead tuples, vacuum, scan usage |
| `pg_list_indexes` | Индексы таблицы с размерами и статистикой использования |

## Named Connections

Сервер поддерживает несколько баз одновременно через `connections.json`. Переключение прямо в чате — без рестарта.

Создай файл `connections.json` рядом с `dist/`:

```json
{
  "connections": {
    "knowledge": {
      "url": "postgres://user:password@localhost:5432/knowledge",
      "description": "Knowledge base (RAG)"
    },
    "shopdb": {
      "url": "postgres://user:password@localhost:5432/shopdb",
      "description": "Production shop DB"
    }
  },
  "default": "default"
}
```

Переключение в чате:
```
pg_use_connection("shopdb")
```

## Безопасность

- **Только чтение**: INSERT, UPDATE, DELETE, DROP, ALTER и другие write-операции заблокированы
- **Таймаут**: Каждый запрос ограничен 30 секундами
- **Лимит строк**: По умолчанию 100 строк, максимум 1000
- **Token auth**: Все эндпоинты защищены Bearer-токеном через nginx

## Установка и сборка

```bash
cd postgres-mcp-server
npm install
npm run build
```

## Подключение — Cowork (SSE transport)

```powershell
claude mcp add --transport sse postgres-mcp "https://<your-domain>/sse?token=TOKEN"
```

## Подключение — Claude Code CLI (Streamable HTTP)

```powershell
claude mcp add --transport http postgres-mcp "https://<your-domain>/mcp?token=TOKEN"
```

## Подключение — локально (stdio)

Добавь в `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "node",
      "args": ["/ПОЛНЫЙ/ПУТЬ/К/postgres-mcp-server/dist/index.js"]
    }
  }
}
```

При использовании `connections.json` переменная `DATABASE_URL` не нужна — базы берутся из файла.

## Деплой на VPS (Hetzner + nginx + systemd)

### Структура на сервере

```
/opt/PostgresMCP/
  dist/          ← собранный JS
  connections.json
  node_modules/
```

### systemd unit (`/etc/systemd/system/postgres-mcp.service`)

```ini
[Unit]
Description=PostgreSQL MCP Server
After=network.target

[Service]
WorkingDirectory=/opt/PostgresMCP
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=PORT=3200

[Install]
WantedBy=multi-user.target
```

### nginx — fragment (`/etc/nginx/sites-available/postgres-mcp`)

```nginx
server {
    listen 443 ssl;
    server_name postgres.org;

    location /sse {
        proxy_pass http://localhost:3200;
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding on;
    }

    location /mcp {
        proxy_pass http://localhost:3200;
    }

    # /messages — без token-check, sessionId достаточен
    location /messages {
        proxy_pass http://localhost:3200;
    }
}
```

### Деплой обновлений

```bash
# Локально
git add . && git commit -m "..." && git push

# На VPS
cd /opt/PostgresMCP && git pull && npm run build && systemctl restart postgres-mcp
```

### Управление сервисом

```bash
systemctl status postgres-mcp      # статус
systemctl restart postgres-mcp     # перезапуск
journalctl -u postgres-mcp -f      # логи в реальном времени
```

## Использование

После подключения Claude автоматически видит инструменты. Примеры:

- "Покажи все доступные базы данных"
- "Переключись на базу shopdb"
- "Покажи все таблицы в базе"
- "Опиши структуру таблицы users"
- "Найди дубликаты email в таблице customers"
- "Почему запрос SELECT * FROM orders WHERE status = 'pending' медленный?"
- "Какие индексы не используются в таблице products?"

## Разработка

```bash
# Запуск в dev-режиме
npm run dev

# Сборка
npm run build
```
