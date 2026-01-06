# AI Assistant

A personal AI assistant with customizable personas. Use your own API keys to chat with Claude (and soon, other AI models).

## Features

- 🔑 Use your own API key (pay-as-you-go, no subscription)
- 🎭 Customizable system prompts (create your own assistant persona)
- 💬 Conversation history (persisted locally)
- 🌙 Dark theme
- 📱 Responsive design (works on mobile)

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

1. Click the menu button (☰) to open settings
2. Enter your Anthropic API key
3. (Optional) Customize your assistant's name and personality
4. Click "Save Settings"
5. Start chatting!

## Project Structure

```
00_assistant_project/
├── index.html      # Main HTML structure
├── styles.css      # All styling
├── app.js          # Application logic
├── package.json    # Project configuration
└── README.md       # This file
```

## Development Phases

- [x] Phase 1: Basic chat with Claude, custom system prompts
- [ ] Phase 2: Conversation persistence, multiple personas
- [ ] Phase 3: Multi-provider support (OpenAI, Gemini)
- [ ] Phase 4: File/image attachments
- [ ] Phase 5: Avatar system with expressions
- [ ] Phase 6: Cloud sync (Google Drive)

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
