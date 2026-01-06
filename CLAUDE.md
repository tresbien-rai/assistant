# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev    # Start local dev server at http://localhost:3000 (uses npx serve .)
```

No build step, tests, or linting configured - this is a vanilla HTML/CSS/JS application.

## Architecture

This is a single-page AI assistant web app built with vanilla JavaScript that integrates directly with the Anthropic Claude API from the browser.

### Core Files

- **index.html** - UI structure: sidebar settings, chat area, floating avatar, status bar
- **app.js** - All application logic (~950 lines)
- **styles.css** - Dark theme styling with CSS variables (~1100 lines)

### State Management (app.js)

The application uses a centralized `state` object with three localStorage keys:
- `ai_assistant_settings` - User configuration (API key, persona, avatar settings)
- `ai_assistant_conversations` - Chat message history
- `ai_assistant_expressions` - Custom avatar expressions

### Key Flow

```
User Input → sendMessage() → callAnthropicAPI() → detectExpression() → appendMessage()
                                                        ↓
                                               setExpression() → updateFloatingAvatar()
```

### API Integration

- Direct browser-to-Anthropic API calls using `anthropic-dangerous-direct-browser-access` header
- API key stored in localStorage, sent with each request
- Expression detection parses AI responses for `[expression: name]` patterns or keyword matching

### Avatar System

- 6 expressions: neutral, happy, sad, thinking, excited, confused
- Supports custom image upload (2MB max) or emoji fallback
- Floating avatar displays in one of 4 screen corners with expression indicator

## Code Conventions

- Sections delimited by `// ===== Section Name =====` comments
- CONFIG object at top contains hardcoded defaults
- camelCase for functions/variables, UPPERCASE for constants
- Direct DOM manipulation (no frameworks)
- Storage keys prefixed with `ai_assistant_`

## Current Status

Phase 1 complete (basic chat, custom prompts, avatar expressions, conversation persistence). Phases 2-6 planned for multiple personas, multi-provider support, file attachments, and cloud sync.
