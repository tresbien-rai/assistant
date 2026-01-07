# CLAUDE.md - Project Instructions for Claude Code

This file provides context for Claude Code when working on this project.

## Project Summary

Personal AI Assistant - a browser-based chat interface where users provide their own API keys to chat with AI models (Claude, with OpenAI and Gemini planned). Features customizable personas with avatar expressions.

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no frameworks)
- **Storage**:
  - localStorage for settings, personas, conversations (JSON)
  - IndexedDB for images (Blobs)
- **APIs**: Direct browser calls to Anthropic API
- **Server**: None required - static files served locally via `npm run dev`

## File Overview

| File | Purpose | Key Contents |
|------|---------|--------------|
| `index.html` | Structure | Sidebar, status bar, chat area, floating avatar, modals |
| `styles.css` | Styling | CSS variables for theming, responsive design, animations |
| `app.js` | Logic | State management, API calls, UI updates, migrations |
| `package.json` | Config | Just has `npm run dev` script using `serve` |
| `TODO.md` | Roadmap | Feature checklist and planned work |

## Architecture

### Storage Schema

Data is stored in unified localStorage key `ai_assistant_data`:
```javascript
{
  schemaVersion: 1,
  settings: { provider, model, apiKey, avatarSize, avatarPosition, showAvatar },
  personas: { [id]: { id, name, systemPrompt, avatarImageKey, expressions, createdAt, updatedAt } },
  conversations: { [id]: { id, title, personaId, messages, createdAt, updatedAt } },
  activePersonaId: "uuid",
  activeConversationId: "uuid"
}
```

Images are stored in IndexedDB (`ai_assistant_images` database) as Blobs, referenced by key.

### State Object (`state` in app.js)
```javascript
state = {
  settings: { provider, model, apiKey, avatarSize, avatarPosition, showAvatar },
  personas: { [id]: { ... } },
  activePersonaId: "uuid",
  conversations: { [id]: { ... } },
  activeConversationId: "uuid",
  currentExpression: 'neutral',
  isLoading: false,
  // ... session tracking, temp state
}
```

### Key Modules

**Migrations (`CURRENT_SCHEMA_VERSION`, `migrations` object)**
- Schema version tracking for data format changes
- Sequential migrations run on app load
- Automatic backup before migrations

**ImageStore (IndexedDB wrapper)**
- `ImageStore.store(key, blob)` - Store image
- `ImageStore.get(key)` - Get object URL
- `ImageStore.delete(key)` - Remove image
- Handles Base64 ↔ Blob conversion

**Personas & Conversations**
- `createPersona()` / `getActivePersona()` / `updatePersona()`
- `createConversation()` / `getActiveConversation()` / `updateConversation()`
- Each conversation links to a persona via `personaId`

**Settings & Persistence**
- `saveSettings()` / `savePersonas()` / `saveConversations()`
- All save functions call `syncUnifiedStorage()` to keep unified storage in sync

### Expression System
1. AI can include `[expression: happy]` in response
2. Tag is detected via `detectExpression()`, stored, and stripped before display
3. Fallback: keyword matching against expression keywords
4. Avatar updates to show corresponding image or emoji

## Common Tasks

### Adding a New Migration

1. Increment `CURRENT_SCHEMA_VERSION`
2. Add migration function to `migrations` object:
```javascript
const migrations = {
  1: async (data) => { /* existing */ },
  2: async (data) => {
    console.log('[Migration 2] Starting: Description...');
    // Transform data.settings, data.personas, etc.
    return data;
  }
};
```
3. Test with both fresh install AND existing data

### Adding a New Setting

1. Add to `state.settings` default in app.js
2. Add HTML input in sidebar (index.html)
3. Add to `elements` object
4. Update `saveSettings()` to read from input
5. Update `updateUI()` to populate input
6. If schema change needed, add migration

### Adding a New Persona Field

1. Add to persona creation in `createPersona()`
2. Add migration to populate field in existing personas
3. Update UI to edit the field

### Styling Changes
All styles in styles.css. CSS variables at top:
- `--accent`: Primary purple (#6c63ff)
- `--bg-primary/secondary/tertiary`: Background shades
- `--avatar-small/medium/large/xlarge`: Avatar sizes

### API Changes
`callAnthropicAPI()` handles request formatting. For new providers, create similar function and update `callAPI()` switch.

## Development Commands

```bash
npm run dev          # Start local server (uses npx serve)
git status           # Check what's changed
git add . && git commit -m "message"  # Save checkpoint
```

## Current Limitations / Known Issues

- CORS: Anthropic API requires `anthropic-dangerous-direct-browser-access` header
- Mobile: Avatar auto-shrinks, status bar hides some items
- No markdown rendering yet (messages show raw text)
- Toast notifications stubbed but not implemented

## Code Style

- Functions are documented with comments
- DOM elements cached in `elements` object
- State changes → save to localStorage → sync unified storage → update UI
- Event listeners set up in `setupEventListeners()`
- Migrations logged with `[Migration N]` prefix

## When Making Changes

1. Understand the current flow before editing
2. Keep changes focused (one feature at a time)
3. Test in browser after changes
4. Check mobile view (resize browser or use DevTools)
5. If changing data structure, add a migration
6. Commit working states to git
