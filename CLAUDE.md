# CLAUDE.md - Project Instructions for Claude Code

This file provides context for Claude Code when working on this project.

## Project Summary

Personal AI Assistant - a server-backed chat interface with Google OAuth authentication. Users sign in with Google (which also connects their Google Drive) and store API keys server-side. Features customizable personas with avatar expressions and conversation history synced across devices.

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no frameworks)
- **Backend**: Express.js (Node.js)
- **Database**: SQLite via better-sqlite3 (abstracted for future PostgreSQL migration)
- **Auth**: Google OAuth 2.0 (provides login + Google Drive access)
- **Storage**:
  - SQLite for structured data (users, personas, conversations, messages, settings)
  - Server filesystem for avatar/expression images
  - Google Drive (per user) for project files (Phase 1)
- **APIs**: Server-side proxy to Anthropic, Gemini, OpenAI (keys stored encrypted)
- **Hosting**: Railway (Hobby tier)

## File Overview

| File/Directory | Purpose | Key Contents |
|----------------|---------|--------------|
| `index.html` | Frontend structure | Sidebar, chat area, floating avatar, modals, login screen |
| `styles.css` | Frontend styling | CSS variables for theming, responsive design, animations |
| `app.js` | Frontend logic | State management, UI updates, API client calls |
| `api-client.js` | API wrapper | All backend API calls (auth, personas, chat, etc.) |
| `server/` | Backend directory | Express server, database, API routes |
| `server/src/index.js` | Server entry point | Express app setup, middleware, route mounting |
| `server/src/config.js` | Configuration | Environment variables, constants |
| `server/src/db/` | Database layer | SQLite connection, schema, data access layer |
| `server/src/routes/` | API routes | auth, personas, conversations, chat, settings, etc. |
| `server/src/middleware/` | Express middleware | authenticate, errorHandler, rateLimiter |
| `server/src/providers/` | AI provider modules | anthropic.js, gemini.js (provider-specific API calls) |
| `server/src/utils/` | Utilities | logger, encryption, AppError |

## Architecture

### Database Schema

SQLite database at `server/data/assistant.db` with these tables:

```sql
users (id, google_id, email, display_name, drive_token, drive_refresh, created_at, updated_at)
personas (id, user_id, name, system_prompt, prefill, avatar_filename, expressions, model_config, created_at, updated_at)
conversations (id, user_id, persona_id, project_id, title, created_at, updated_at)
messages (id, conversation_id, role, content, attachments, created_at)
projects (id, user_id, name, instructions, drive_folder_id, created_at, updated_at)
project_files (id, project_id, filename, mime_type, size_bytes, drive_file_id, created_at)
settings (id, user_id, avatar_size, avatar_position, show_avatar, custom_models, created_at, updated_at)
api_keys (id, user_id, provider, encrypted_key, created_at, updated_at)
```

All tables include `user_id` for multi-user data isolation.

### Frontend State Object (`state` in app.js)

```javascript
state = {
  user: { id, email, displayName },  // From auth
  settings: { avatarSize, avatarPosition, showAvatar, customModels },
  personas: { [id]: { id, name, systemPrompt, prefill, modelConfig, ... } },
  activePersonaId: "uuid",
  conversations: { [id]: { id, title, personaId, messages } },
  activeConversationId: "uuid",
  currentExpression: 'neutral',
  isLoading: false,
  isAuthenticated: false
}
```

### API Client (`api-client.js`)

All backend calls go through the API client module:

```javascript
API.auth.me() / .logout()
API.personas.list() / .get(id) / .create(data) / .update(id, data) / .delete(id)
API.conversations.list() / .get(id) / .create(data) / .update(id, data) / .delete(id)
API.messages.create(convId, data) / .update(convId, msgId, data) / .delete(convId, msgId)
API.settings.get() / .update(data)
API.apiKeys.list() / .set(provider, key) / .delete(provider)
API.chat.send(params) / .stream(params, onChunk) / .abort()
API.models.list(provider)
API.avatars.upload(personaId, file) / .delete(personaId) / .getUrl(personaId)
```

### Backend API Routes

```
Auth:
  GET  /api/auth/google           -> Redirect to Google OAuth
  GET  /api/auth/google/callback  -> Handle OAuth callback, issue JWT
  GET  /api/auth/me               -> Get current user info
  POST /api/auth/logout           -> Clear session

Data CRUD:
  GET/POST/PUT/DELETE /api/personas
  GET/POST/PUT/DELETE /api/conversations
  POST/PUT/DELETE     /api/conversations/:id/messages
  GET/PUT             /api/settings
  GET/PUT/DELETE      /api/api-keys/:provider

Chat Proxy:
  POST /api/chat         -> Non-streaming chat (proxies to AI provider)
  POST /api/chat/stream  -> Streaming chat (SSE)
  GET  /api/models/:provider -> Fetch available models

Avatars:
  POST/DELETE /api/personas/:id/avatar
  POST/DELETE /api/personas/:id/expressions/:name/image
  GET         /api/avatars/:personaId/avatar
  GET         /api/avatars/:personaId/expressions/:name
```

### Error Handling

Server uses structured errors via `AppError` class:

```javascript
// Error codes: AUTH_ERROR, PROVIDER_ERROR, DRIVE_ERROR, RATE_LIMITED, VALIDATION_ERROR, NOT_FOUND, SERVER_ERROR
AppError.auth(message)         // 401
AppError.provider(message)     // 502
AppError.rateLimited(seconds)  // 429
AppError.validation(message)   // 400
AppError.notFound(resource)    // 404
AppError.server(message)       // 500
```

Frontend displays errors via: toast notifications (transient), inline chat errors (conversation-related), or modal/banner (critical, requires action).

### Expression System

1. AI can include `[expression: happy]` in response
2. Tag is detected via `detectExpression()`, stored, and stripped before display
3. Fallback: keyword matching against expression keywords
4. Avatar updates to show corresponding image or emoji

## Common Tasks

### Adding a New API Endpoint

1. Create or modify route file in `server/src/routes/`
2. Add DAL functions in `server/src/db/dal.js` if needed
3. Mount route in `server/src/index.js`
4. Add corresponding method to `api-client.js`
5. Use in `app.js`

### Adding a New Setting

1. Add column to `settings` table (add migration if schema exists)
2. Update DAL functions in `server/src/db/dal.js`
3. Update `server/src/routes/settings.js` to handle the field
4. Update `API.settings` methods in `api-client.js`
5. Add HTML input in sidebar (index.html)
6. Update `app.js` to read/save the setting

### Adding a New Persona Field

1. Add column to `personas` table in `server/src/db/schema.sql`
2. Update DAL functions for persona CRUD
3. Update the personas route
4. Update `api-client.js` if needed
5. Update UI to edit the field

### Adding a New AI Provider

1. Create `server/src/providers/{provider}.js` following existing pattern
2. Register in `server/src/routes/chat.js` provider dispatch
3. Add to allowed providers in `server/src/routes/apiKeys.js`
4. Update frontend model selector if needed

### Styling Changes

All styles in styles.css. CSS variables at top:
- `--accent`: Primary purple (#6c63ff)
- `--bg-primary/secondary/tertiary`: Background shades
- `--avatar-small/medium/large/xlarge`: Avatar sizes

## Development Commands

```bash
# Start the server (serves frontend + API)
cd server && npm start

# Development with auto-reload
cd server && npm run dev

# Check database
sqlite3 server/data/assistant.db ".tables"

# Git workflow
git status
git add . && git commit -m "message"
```

## Environment Variables

Server requires these environment variables (see `server/.env.example`):

```
PORT=3000
NODE_ENV=development
JWT_SECRET=<random-string>
ENCRYPTION_KEY=<32-byte-hex-key>
GOOGLE_CLIENT_ID=<from-google-cloud-console>
GOOGLE_CLIENT_SECRET=<from-google-cloud-console>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

## Current Limitations / Known Issues

- Google OAuth required for login (no username/password option)
- Offline mode not supported (requires server connectivity)
- Mobile: Avatar auto-shrinks, status bar hides some items

## Code Style

### Backend
- Use async/await for all async operations
- All routes use authenticate middleware (except auth routes)
- DAL functions enforce user_id scoping for data isolation
- Never log API keys, tokens, or passwords
- Use structured logging via pino

### Frontend
- DOM elements cached in `elements` object
- All data operations go through `api-client.js`
- State loaded from server on init, kept in memory during session
- Event listeners set up in `setupEventListeners()`

## When Making Changes

1. Understand the current flow before editing
2. Keep changes focused (one feature at a time)
3. Test in browser after changes (check both authenticated and unauthenticated states)
4. Check mobile view (resize browser or use DevTools)
5. For database changes, consider if a migration is needed
6. Commit working states to git
7. Verify both frontend and backend work together

## Reference Documents

- `PLANNING.txt` - Full architecture plan and development phases
- `PHASE0_TASKS.txt` - Detailed task breakdown for Phase 0 (backend foundation)
