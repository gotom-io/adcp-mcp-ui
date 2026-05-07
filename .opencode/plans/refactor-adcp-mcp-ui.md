# Refactoring Plan: adcp-mcp-ui

## Goal
Refactor verbose monolithic files into a clean, modular structure while preserving all functionality.

## Current State
- `app/app.js` - 283 lines (Vue app mixing state, API, UI logic)
- `app/server.mjs` - 500 lines (monolithic server with all routes)
- `app/index.template.html` - 224 lines (UI template, no changes needed)
- `app/styles.css` - 972 lines (no changes needed)
- `app/shared.mjs` - 3 lines (shared utility)

## Target Structure

```
app/
├── frontend/
│   ├── app.js                  # Vue entry point (~30 lines)
│   ├── stores/
│   │   ├── settings.js         # Settings state & cookie management
│   │   ├── chat.js             # Chat state & streaming logic
│   │   └── logs.js             # Logs state & search/filter
│   ├── components/
│   │   └── api.js              # API client (fetch wrappers)
│   └── utils/
│       └── helpers.js          # Frontend utilities (markdown, textarea)
├── backend/
│   ├── server.mjs              # Minimal entry point (~80 lines)
│   ├── routes/
│   │   ├── settings.js         # GET/POST /api/settings
│   │   ├── chat.js             # POST /api/chat
│   │   └── logs.js             # GET /api/logs
│   └── services/
│       ├── logger.js           # Logger with cache
│       ├── context.js          # Context history management
│       └── mcp-client.js       # MCP client & tools cache
├── shared/
│   └── shared.mjs              # getMcpSessionIdShort
├── styles.css                  # No changes
├── index.template.html          # No changes
├── package.json                # No changes
└── .dockerignore              # No changes
```

## File Contents (detailed)

### Backend Files

#### `backend/services/logger.js`
- Extract from `server.mjs` lines 16-79
- Exports: `getLogger(sessionId)`, `NO_ID_FOUND`
- Handles: log file creation, log formatting, cache

#### `backend/services/context.js`
- Extract from `server.mjs` lines 85-153
- Exports: `getContextHistory`, `addToContextHistory`, `clearContextHistory`
- Handles: context window trimming

#### `backend/services/mcp-client.js`
- Extract from `server.mjs` lines 155-189
- Exports: `getHttpClientTools`
- Handles: MCP client creation, tools caching

#### `backend/routes/settings.js`
- Extract from `server.mjs` lines 192-284
- Exports: `getCookies`, `createSecureCookie`, `handleGetSettings`, `handlePostSettings`
- Handles: cookie parsing, settings API

#### `backend/routes/chat.js`
- Extract from `server.mjs` lines 360-469
- Exports: `handleChat`
- Handles: chat streaming, context management, MCP tool execution

#### `backend/routes/logs.js`
- Extract from `server.mjs` lines 307-359
- Exports: `handleLogs`
- Handles: log search via MCP tools

#### `backend/server.mjs`
- Minimal entry point
- Imports routes and serves static files
- Handles: request routing, static file serving, index.html templating

### Frontend Files

#### `frontend/stores/settings.js`
- Settings state: `authToken`, `mcpServer`, `aiModel`
- Methods: `saveSetting`, `saveCookie`, `saveServerCookie`, `saveModelCookie`, `loadSettings`

#### `frontend/stores/chat.js`
- Chat state: `promptInput`, `messages`, `loading`, `error`
- Methods: `submit`, `clearHistory`, `handleKeydown`, `scrollToBottom`, `adjustTextareaHeight`

#### `frontend/stores/logs.js`
- Logs state: `showLogs`, `logs`, `logFilter`, `logSearchQuery`
- Computed: `highlightedLogs`
- Methods: `searchLogs`, `closeLogs`

#### `frontend/components/api.js`
- API client functions: `fetchSettings`, `saveSetting`, `fetchLogs`, `sendChatMessage`
- Shared: `getRequestHeaders`

#### `frontend/utils/helpers.js`
- `renderMarkdown(text)` - markdown parsing
- `getMcpSessionIdShort(sessionId)` - session ID formatting

#### `frontend/app.js`
- Vue app entry point
- Imports from stores and components
- Minimal setup() that wires everything together

## Docker Updates

### `docker/Dockerfile`
```dockerfile
FROM node:lts
WORKDIR /app
COPY app/ .
RUN npm ci
EXPOSE 3000
ENTRYPOINT ["node", "/app/backend/server.mjs"]
```

### `docker-compose.yml`
```yaml
services:
    app:
        image: adcp-mcp-ui:latest
        container_name: adcp-mcp-ui
        build:
            context: .
            dockerfile: ./docker/Dockerfile
        working_dir: /app
        entrypoint: ["node", "backend/server.mjs"]  # Updated path
        volumes:
            - ./app:/app
        ports:
            - '3851:3000'
        environment:
            # ... unchanged ...
```

## Implementation Steps
1. Create folder structure
2. Move shared.mjs to shared/shared.mjs
3. Create backend service files (logger, context, mcp-client)
4. Create backend route files (settings, chat, logs)
5. Create backend server.mjs (minimal entry point)
6. Create frontend store files (settings, chat, logs)
7. Create frontend api.js and helpers.js
8. Create frontend app.js (Vue entry point)
9. Update Dockerfile
10. Update docker-compose.yml
11. Test with `docker compose up`

## Key Design Decisions
- Frontend split by **feature** (chat, logs, settings) as requested
- Backend split by **concern** (services for shared logic, routes for API handlers)
- All imports use relative paths from their new locations
- No functionality changes - pure refactoring
- CSS and HTML remain unchanged
