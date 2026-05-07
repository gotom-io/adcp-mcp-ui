# Refactoring Plan

## Overview
Restructure the project to separate frontend, backend, and shared code into organized directories while reducing verbosity and improving maintainability.

## Current State Analysis

### Files (all in `app/`):
- `index.template.html` - Main HTML template (224 lines)
- `app.js` - Frontend Vue application (283 lines)
- `server.mjs` - Backend server (500 lines)
- `shared.mjs` - Shared utility function (3 lines)
- `styles.css` - CSS styles (972 lines)

### Issues:
1. No separation of concerns - all files mixed in same folder
2. Very verbose HTML with excessive copy-paste
3. Repetitive code patterns throughout

---

## Proposed New Structure

```
adcp-mcp-ui/
├── app/                        # Entry point (will be minimal wrapper)
├── docker/                     # Docker configuration (unchanged)
│   └── Dockerfile
├── frontend/                   # NEW: All frontend-related files
│   ├── index.html             # Renamed from index.template.html (cleaned up)
│   ├── app.js                 # Renamed from app.js (refactored for conciseness)
│   ├── styles.css             # Unchanged
│   └── components/            # NEW: Vue components
│       ├── Layout.vue         # Sidebar + Main layout
│       ├── ChatArea.vue       # Messages, input, welcome screen
│       ├── LogsPanel.vue      # Log display and search UI
│       ├── ConfigSection.vue  # Server/model/API key config
│       └── Icon.vue           # Reusable icon component
└── backend/                    # NEW: All backend-related files
    ├── server.mjs             # Main server file (refactored)
    ├── shared.mjs             # Shared utility function
    ├── api/                   # NEW: API route handlers
    │   ├── settings.mjs       # GET/POST /api/settings
    │   ├── chat.mjs           # POST /api/chat
    │   └── logs.mjs           # GET /api/logs
    └── middleware/            # NEW: Request handlers
        └── auth.mjs           # Header validation (getHeaderInfo)
```

---

## Actions

### Phase 1: Directory Structure & File Movement
1. Create `frontend/`, `backend/`, and `shared/` directories at root level
2. Move files:
   - Frontend: `index.template.html`, `app.js`, `styles.css`, `shared.mjs`
   - Backend: `server.mjs`

### Phase 2: Refactoring (Reduce Verbosity)

#### A. HTML Cleanup (`frontend/index.html`)
- Remove excessive favicon links (keep only essential ones)
- Extract inline SVGs to component library
- Simplify doctype/comments

#### B. Frontend Componentization (`frontend/components/`)
- **Layout.vue**: Sidebar + Main container structure
- **ConfigSection.vue**: All configuration inputs in sidebar
- **ChatArea.vue**: Messages, welcome screen, thinking indicator, error toast
- **LogsPanel.vue**: Log search UI and display
- **Icon.vue**: Reusable icon wrapper component

**Benefits**: 
- Each file ~50-100 lines instead of 200+ in single file
- Reusable components
- Easier testing

#### C. Backend Refactoring (`backend/api/`)
- Split server.mjs into modular route handlers:
  - `api/settings.mjs`: Settings CRUD
  - `api/chat.mjs`: Chat streaming logic  
  - `api/logs.mjs`: Log search
- Extract shared utilities to `backend/utils/`:
  - `logger.mjs`: Logger factory
  - `contextHistory.mjs`: Context management
  - `mcpClient.mjs`: MCP client factory

### Phase 3: Code Improvements
1. Remove console.error from production code (line 34 app.js)
2. Extract hardcoded strings to constants
3. Add proper error boundaries
4. Simplify server.mjs by extracting functions

### Phase 4: Docker Updates
- Update `docker/Dockerfile` to use new structure
- Adjust volume mounts if needed

---

## Expected Outcomes

1. **Cleaner code**: ~40% reduction in line count through refactoring
2. **Better organization**: Clear separation between frontend/backend/shared
3. **Improved maintainability**: Smaller, focused files
4. **Reusability**: Extracted components/utils can be reused
5. **Same functionality**: All buttons/actions work identically

---

## Testing Checklist

After reorganization:
- [ ] `docker compose up` builds and runs successfully
- [ ] `http://localhost:3851/` loads without errors
- [ ] Sidebar config (server, model, API key) works
- [ ] Clear History button clears chat
- [ ] Get Logs button shows logs panel
- [ ] Log search functionality works
- [ ] Chat messages display correctly
- [ ] Markdown rendering in assistant messages works
- [ ] Auto-scrolling to bottom on new messages
- [ ] Enter key sends, Shift+Enter adds newline
- [ ] API key validation prevents sending without key

---

## Notes

- All existing routes will remain unchanged (`/`, `/api/settings`, `/api/chat`, `/api/logs`)
- Frontend URL paths change from `/app.js` to `/frontend/app.js` (handled by server)
- Shared utilities moved to `shared/` for clarity
