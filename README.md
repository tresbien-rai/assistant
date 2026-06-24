# Tessera

A personal AI assistant with customizable personas. Use your own API keys to chat with Claude or Gemini.

## Features

- **Multi-provider support** - Anthropic Claude and Google Gemini
- **Per-provider API keys** - Use your own keys (pay-as-you-go, no subscription)
- **Advanced model parameters** - Temperature, Top P/K, Max Tokens, Stop Sequences
- **Provider-specific settings**:
  - Claude: Extended Thinking with configurable budget
  - Gemini: Thinking Level, Safety Settings, Media Resolution
- Customizable personas with system prompts
- Avatar system with expressions (emoji + custom images)
- Expression detection (tags + keyword matching)
- Multi-conversation support with titles
- Multi-persona support
- Markdown rendering with syntax highlighting
- Tabbed sidebar (Chats, Settings, Personas)
- Schema versioning and migration system
- Custom model management with API suggestions
- Dark theme
- Responsive design (works on mobile)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) installed (for the development server)
- An API key from at least one provider:
  - Anthropic: https://console.anthropic.com/
  - Google AI: https://aistudio.google.com/apikey

### Running the App

1. Open a terminal in this folder
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Open your browser to the URL shown (usually http://localhost:3000)

### First-Time Setup

1. Click the menu button to open the sidebar
2. Go to the Settings tab:
   - Select your provider (Anthropic or Google)
   - Enter your API key for that provider
   - Click "Manage Models" to fetch and add available models
3. (Optional) Adjust Advanced Settings for temperature, thinking, etc.
4. Go to the Personas tab to customize your assistant's name and personality
5. Click "Save Settings"
6. Start chatting!

## Project Structure

```
00_assistant_project/
├── index.html      # Main HTML structure
├── styles.css      # All styling
├── app.js          # Application logic
├── package.json    # Project configuration
├── README.md       # This file
└── CLAUDE.md       # Development instructions for Claude Code
```

## Roadmap

### Completed

- [x] Basic chat interface with Claude API
- [x] Customizable personas with system prompts
- [x] Avatar system with expressions (emoji + custom images)
- [x] Expression detection (tags + keyword matching)
- [x] Settings persistence (localStorage)
- [x] Image storage migration to IndexedDB
- [x] Multi-conversation support (conversation IDs, titles)
- [x] Multi-persona support (persona IDs, separate from settings)
- [x] Schema versioning and migration system
- [x] Custom model management with API suggestions
- [x] Markdown rendering with syntax highlighting (marked.js + highlight.js)
- [x] Tabbed sidebar (Chats, Settings, Personas)
- [x] Conversation management (create, switch, rename, delete with context menus)
- [x] Persona management (create, switch, edit, delete with avatar previews)
- [x] Gemini API support - Google Gemini with per-provider API keys
- [x] Model parameters - Temperature, Top P/K, Max Tokens, Stop Sequences
- [x] Extended Thinking (Claude) - Toggle with configurable token budget
- [x] Gemini settings - Thinking Level, Safety Settings, Media Resolution

### Planned - Medium Priority

- [ ] OpenAI API support - Add provider option for GPT models
- [ ] Export/Import - Export conversations and personas to JSON, import from file
- [ ] Search conversations - Search through message history
- [ ] Auto-generate conversation titles

### Planned - Nice to Have

- [ ] Streaming responses - Show responses as they stream in (toggle exists, not yet wired)
- [ ] Themes - Light mode, custom accent colors
- [ ] Keyboard shortcuts - Quick actions (new chat, toggle sidebar, etc.)
- [ ] Message editing - Edit sent messages and regenerate responses
- [ ] Message actions - Copy, delete, regenerate individual messages
- [ ] Token counter - More accurate token counting (use tiktoken or API)
- [ ] Cost tracking - Track API usage costs per conversation/session
- [ ] File attachments - Support for uploading images/files to vision models
- [ ] Voice input - Speech-to-text for message input

## Known Issues

- CORS requires `anthropic-dangerous-direct-browser-access` header
- Mobile responsiveness could be improved
- No error recovery UI (just console errors)
- Toast notification system stubbed but not implemented

## Security Notes

- Your API keys are stored in your browser's localStorage (per-provider)
- Keys are only sent to their respective AI provider's API
- No data is sent to any third-party servers
- Clear your browser data to remove stored keys

## Troubleshooting

### "CORS Error" or API not working

**For Anthropic:** The API requires the `anthropic-dangerous-direct-browser-access` header to allow browser requests. This is already included in the code.

**For Google:** The Gemini API generally works without CORS issues from the browser.

If you still get errors:
1. Make sure you're using a valid API key
2. Check that your API key has the necessary permissions
3. For Google, ensure the Generative Language API is enabled in your Google Cloud Console
4. Some browser extensions can interfere - try incognito mode

### Conversation not saving

- Make sure localStorage is not disabled in your browser
- Private/incognito mode may not persist localStorage

## License

MIT - Feel free to modify and use however you like!
