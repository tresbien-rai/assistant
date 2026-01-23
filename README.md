# AI Assistant

A personal AI assistant with customizable personas. Use your own API keys to chat with Claude (and soon, other AI models).

## Features

- Use your own API key (pay-as-you-go, no subscription)
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
- An Anthropic API key (get one at https://console.anthropic.com/)

### Running the App

1. Open a terminal in this folder
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Open your browser to the URL shown (usually http://localhost:3000)

### First-Time Setup

1. Click the menu button to open the sidebar
2. Go to the Settings tab and enter your Anthropic API key
3. Go to the Personas tab to customize your assistant's name and personality
4. Click "Save Settings"
5. Start chatting!

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

### Planned - Medium Priority

- [ ] OpenAI API support - Add provider option for GPT models
- [ ] Gemini API support - Add provider option for Google's Gemini models
- [ ] Export/Import - Export conversations and personas to JSON, import from file
- [ ] Search conversations - Search through message history
- [ ] Auto-generate conversation titles

### Planned - Nice to Have

- [ ] Themes - Light mode, custom accent colors
- [ ] Keyboard shortcuts - Quick actions (new chat, toggle sidebar, etc.)
- [ ] Message editing - Edit sent messages and regenerate responses
- [ ] Message actions - Copy, delete, regenerate individual messages
- [ ] Token counter - More accurate token counting (use tiktoken or API)
- [ ] Cost tracking - Track API usage costs per conversation/session
- [ ] Streaming responses - Show responses as they stream in
- [ ] File attachments - Support for uploading images/files to vision models
- [ ] Voice input - Speech-to-text for message input

## Known Issues

- CORS requires `anthropic-dangerous-direct-browser-access` header
- Mobile responsiveness could be improved
- No error recovery UI (just console errors)
- Toast notification system stubbed but not implemented

## Security Notes

- Your API key is stored in your browser's localStorage
- Keys are only sent to the respective AI provider's API
- No data is sent to any third-party servers
- Clear your browser data to remove stored keys

## Troubleshooting

### "CORS Error" or API not working

The Anthropic API requires the `anthropic-dangerous-direct-browser-access` header to allow browser requests. This is already included in the code. If you still get CORS errors:

1. Make sure you're using a valid API key
2. Check that your API key has the necessary permissions
3. Some browser extensions can interfere - try incognito mode

### Conversation not saving

- Make sure localStorage is not disabled in your browser
- Private/incognito mode may not persist localStorage

## License

MIT - Feel free to modify and use however you like!
