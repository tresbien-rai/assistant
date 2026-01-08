# TODO - AI Assistant Project

## Completed

- [x] Basic chat interface with Claude API
- [x] Customizable personas with system prompts
- [x] Avatar system with expressions (emoji + custom images)
- [x] Expression detection (tags + keyword matching)
- [x] Settings persistence (localStorage)
- [x] Image storage migration to IndexedDB
- [x] Multi-conversation support (conversation IDs, titles)
- [x] Multi-persona support (persona IDs, separate from settings)
- [x] Schema versioning and migration system

## In Progress

- [ ] Testing migration system with real data updates

## Planned Features

### High Priority

- [x] **Markdown rendering** - Render all messages as markdown with syntax highlighting (marked.js + highlight.js)
- [ ] **Conversation sidebar** - UI to switch between conversations, create new ones, delete old ones
- [ ] **Persona switcher** - UI to switch between personas, create/edit/delete personas

### Medium Priority

- [ ] **OpenAI API support** - Add provider option for GPT models
- [ ] **Gemini API support** - Add provider option for Google's Gemini models
- [ ] **Export/Import** - Export conversations and personas to JSON, import from file
- [ ] **Search conversations** - Search through message history
- [ ] **Conversation titles** - Auto-generate or manually edit conversation titles

### Low Priority / Nice to Have

- [ ] **Themes** - Light mode, custom accent colors
- [ ] **Keyboard shortcuts** - Quick actions (new chat, toggle sidebar, etc.)
- [ ] **Message editing** - Edit sent messages and regenerate responses
- [ ] **Message actions** - Copy, delete, regenerate individual messages
- [ ] **Token counter** - More accurate token counting (use tiktoken or API)
- [ ] **Cost tracking** - Track API usage costs per conversation/session
- [ ] **Streaming responses** - Show responses as they stream in
- [ ] **File attachments** - Support for uploading images/files to vision models
- [ ] **Voice input** - Speech-to-text for message input

## Known Issues / Technical Debt

- [ ] CORS requires `anthropic-dangerous-direct-browser-access` header
- [ ] Mobile responsiveness could be improved
- [ ] No error recovery UI (just console errors)
- [ ] Toast notification system is stubbed but not implemented

## Architecture Notes

When adding new features, remember:
- Schema changes require a new migration in `app.js`
- Bump `CURRENT_SCHEMA_VERSION` when adding migrations
- Test migrations with fresh data AND existing data
- All state changes should call appropriate save functions (which sync to unified storage)
