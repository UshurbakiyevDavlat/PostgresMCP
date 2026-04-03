# PostgreSQL MCP Server

Read-only MCP-сервер для PostgreSQL. Даёт Claude доступ к базе данных для анализа схемы, выполнения SELECT-запросов и диагностики производительности.

## Инструменты (Tools)

| Tool | Описание |
|------|----------|
| `pg_query` | Выполнить SELECT-запрос (write-запросы заблокированы) |
| `pg_list_tables` | Список всех таблиц с размерами и количеством строк |
| `pg_describe_table` | Структура таблицы: колонки, типы, PK, FK, индексы |
| `pg_explain_query` | План выполнения запроса (EXPLAIN ANALYZE) |
| `pg_table_stats` | Статистика таблицы: dead tuples, vacuum, scan usage |
| `pg_list_indexes` | Индексы таблицы с размерами и статистикой использования |

## Безопасность

- **Только чтение**: INSERT, UPDATE, DELETE, DROP, ALTER и другие write-операции заблокированы
- **Таймаут**: Каждый запрос ограничен 30 секундами
- **Лимит строк**: По умолчанию 100 строк, максимум 1000
- **Фильтрация**: SQL-комментарии и строковые литералы удаляются перед проверкой

## Установка

```bash
cd postgres-mcp-server
npm install
npm run build
```

## Подключение к Claude Code

Добавь в `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "node",
      "args": ["/ПОЛНЫЙ/ПУТЬ/К/postgres-mcp-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgres://user:password@localhost:5432/database_name"
      }
    }
  }
}
```

Или для проекта — в `.claude/settings.json` в корне репозитория.

## Использование

После подключения Claude автоматически видит новые инструменты. Просто спроси:

- "Покажи все таблицы в базе"
- "Опиши структуру таблицы users"
- "Найди дубликаты email в таблице customers"
- "Почему запрос SELECT * FROM orders WHERE status = 'pending' медленный?"
- "Какие индексы не используются в таблице products?"

## Разработка

```bash
# Запуск в dev-режиме
DATABASE_URL=postgres://... npm run dev

# Сборка
npm run build
```
