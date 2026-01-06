# CLAUDE.md - Project Instructions for Claude Code

This file provides context for Claude Code when working on this project.

## Project Summary

Personal AI Assistant - a browser-based chat interface where users provide their own API keys to chat with AI models (Claude, with OpenAI and Gemini planned). Features customizable personas with avatar expressions.

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no frameworks)
- **Storage**: Browser localStorage (Base64 for images)
- **APIs**: Direct browser calls to Anthropic API
- **Server**: None required - static files served locally via `npm run dev`

## File Overview

| File | Purpose | Key Contents |
|------|---------|--------------|
| `index.html` | Structure | Sidebar, status bar, chat area, floating avatar, modals |
| `styles.css` | Styling | CSS variables for theming, responsive design, animations |
| `app.js` | Logic | State management, API calls, UI updates, file uploads |
| `package.json` | Config | Just has `npm run dev` script using `serve` |

## Architecture

### State Object (`state` in app.js)
```javascript
state = {
  settings: { provider, model, apiKey, assistantName, systemPrompt, avatarData, avatarSize, avatarPosition, showAvatar },
  expressions: { name: { emoji, imageData, keywords } },
  conversation: [{ role, content }],
  currentExpression: 'neutral',
  isLoading: false,
  // ... session tracking
}
```

### Key Functions
- `saveSettings()` / `loadSettings()` - localStorage persistence
- `updateUI()` - refreshes all UI elements from state
- `sendMessage()` - handles user input → API → response
- `callAnthropicAPI()` - actual API communication
- `detectExpression()` - parses response for mood
- `handleAvatarUpload()` / `handleExpressionImageUpload()` - Base64 conversion

### Expression System
1. AI can include `[expression: happy]` in response
2. Tag is detected, stored, and stripped before display
3. Fallback: keyword matching against expression keywords
4. Avatar updates to show corresponding image or emoji

## Common Tasks

### Adding a New Setting
1. Add to `state.settings` default in app.js
2. Add HTML input in sidebar (index.html)
3. Add to `elements` object
4. Update `saveSettings()` to read from input
5. Update `updateUI()` to populate input
6. Use the setting where needed

### Adding a New Expression Default
Edit `CONFIG.defaultExpressions` in app.js

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

- CORS: Anthropic API requires special header for browser access
- Storage: localStorage ~5-10MB limit (watch image sizes)
- Mobile: Avatar auto-shrinks, status bar hides some items
- No markdown rendering yet (messages show raw text)

## Code Style

- Functions are documented with comments
- DOM elements cached in `elements` object
- State changes → save to localStorage → update UI
- Event listeners set up in `setupEventListeners()`

## When Making Changes

1. Understand the current flow before editing
2. Keep changes focused (one feature at a time)
3. Test in browser after changes
4. Check mobile view (resize browser or use DevTools)
5. Commit working states to git
