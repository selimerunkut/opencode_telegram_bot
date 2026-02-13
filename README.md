# OpenCode Telegram Bot

A **standalone** Telegram bot that provides a chat interface to OpenCode AI, allowing you to interact with OpenCode directly from Telegram.

**Important**: This is a standalone application, not an OpenCode plugin. It runs independently and connects to OpenCode servers via HTTP API.

## Features

- 💬 **Two-way messaging**: Send messages to OpenCode and receive responses in Telegram
- 📁 **Session management**: Create, switch, and manage multiple OpenCode sessions
- 🔄 **Real-time updates**: Receive streaming responses and status updates
- 🔒 **Secure**: User whitelist authentication and rate limiting
- 📱 **Mobile-friendly**: Use OpenCode AI on the go from your phone
- 🖥️ **Multi-instance support**: Connect to multiple OpenCode servers simultaneously

## Architecture Overview

```
┌─────────────┐      HTTP API      ┌─────────────────┐
│   Telegram  │◄──────────────────►│  Telegram Bot   │
│   Servers   │   (Bot API)        │  (This App)     │
└─────────────┘                    └────────┬────────┘
                                            │
                              HTTP/WebSocket│
                                            │
                                    ┌───────▼────────┐
                                    │ OpenCode Server│
                                    │ (Separate App) │
                                    └────────────────┘
```

**Key Points**:
- The bot is a **separate Node.js application** that runs independently
- It connects to **OpenCode servers** via HTTP API (acts as a client)
- It connects to **Telegram** via the Bot API
- OpenCode must be running separately with its API server enabled

## Prerequisites

### Required
- Node.js 20+ (or Docker)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- OpenCode CLI/server running with API enabled

### Optional
- Redis (for production persistence; falls back to in-memory storage)
- Multiple OpenCode instances (for multi-server support)

## Quick Start

### Step 1: Create a Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the instructions
3. Save the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. Get your Telegram user ID (message [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot))

### Step 2: Start OpenCode Server

The bot requires OpenCode to be running with its API server enabled:

```bash
# Option 1: Run opencode with server mode
cd /path/to/your/project
opencode --server

# Option 2: If using the OpenCode SDK programmatically
# Ensure the server is started with API enabled on port 3000 (default)
```

Verify OpenCode is running:
```bash
curl http://localhost:3000/session
curl http://localhost:4096/session
```

### Step 3: Configure and Run the Bot

```bash
# Clone and install
git clone <repository-url>
cd opencode-telegram-bot
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your settings
# See Configuration section below for details

# Run in development mode
npm run dev

# Or build and run production
npm run build
npm start
```

### Step 4: Test the Bot

1. Open Telegram and find your bot
2. Send `/start` to initialize
3. Send `/instances` to see available OpenCode servers
4. Select an instance (or use `/new` directly with single-instance config)
5. Send a message to start chatting with OpenCode!

## Configuration

Edit the `.env` file with your settings:

### Single OpenCode Instance (Simple Setup)

```bash
# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_ALLOWED_USER_IDS=12345678,87654321

# OpenCode (single instance)
OPENCODE_API_URL=http://localhost:3000
OPENCODE_PROJECT_PATH=/path/to/your/project

# Storage (optional)
REDIS_URL=redis://localhost:6379
```

### Multiple OpenCode Instances (Advanced)

```bash
# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_ALLOWED_USER_IDS=12345678

# OpenCode (multiple instances as JSON)
OPENCODE_INSTANCES=[
  {
    "id": "prod",
    "name": "Production",
    "apiUrl": "http://localhost:3000",
    "projectPath": "/home/user/projects/production",
    "isDefault": true
  },
  {
    "id": "dev",
    "name": "Development",
    "apiUrl": "http://localhost:3001",
    "projectPath": "/home/user/projects/development"
  }
]
```

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated list of allowed Telegram user IDs |
| `OPENCODE_API_URL` | Yes* | URL of OpenCode server (for single instance) |
| `OPENCODE_PROJECT_PATH` | Yes* | Path to project OpenCode manages |
| `OPENCODE_INSTANCES` | Yes* | JSON array for multiple instances |
| `REDIS_URL` | No | Redis connection URL (falls back to memory) |

*Use either `OPENCODE_API_URL` + `OPENCODE_PROJECT_PATH` for single instance, OR `OPENCODE_INSTANCES` for multiple.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and show welcome message |
| `/help` | Show available commands |
| `/instances` | List available OpenCode instances (multi-instance mode) |
| `/new [title]` | Create a new OpenCode session |
| `/sessions` | List all your active sessions |
| `/switch <id>` | Switch to a different session |
| `/status` | Show current session status |
| `/stop` | Stop/abort the current session |

## Testing

### Manual Testing Checklist

Use this checklist to verify the bot is working correctly:

#### Basic Functionality
- [ ] Send `/start` - Should receive welcome message
- [ ] Send `/help` - Should show command list
- [ ] Send any text message - Should create session automatically or prompt to select instance

#### Multi-Instance Setup (if configured)
- [ ] Send `/instances` - Should list all configured OpenCode servers
- [ ] Click on an instance - Should switch to that instance
- [ ] Send `/new` - Should create session on selected instance

#### Session Management
- [ ] Send `/new My Test Session` - Should create named session
- [ ] Send `/sessions` - Should show all sessions with instance info
- [ ] Send `/switch <session_id>` - Should switch to that session
- [ ] Send `/status` - Should show current session details
- [ ] Send `/stop` - Should abort current session

#### Messaging
- [ ] Send a simple question - Should receive response from OpenCode
- [ ] Send a code-related question - Should receive code response
- [ ] Check that responses are streamed in real-time

#### Error Handling
- [ ] Try without OpenCode running - Should show connection error
- [ ] Try with wrong instance ID - Should show "unknown instance" error
- [ ] Try unauthorized user - Should receive "not authorized" message

### Automated Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration
```

### Debugging

Enable debug logging:

```bash
# In .env
DEBUG_MODE=true
LOG_LEVEL=debug

# Or inline
DEBUG_MODE=true npm run dev
```

Check logs:
```bash
# If running directly
npm run dev 2>&1 | tee bot.log

# If using Docker
docker-compose logs -f bot
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Formatting
npm run format
```

## Deployment

### Docker Deployment (Recommended)

```bash
# Build and start with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f bot

# Stop
docker-compose down
```

### Production Considerations

1. **Security**:
   - Use strong bot token
   - Restrict allowed user IDs (whitelist)
   - Use environment variables for sensitive data

2. **Persistence**:
   - Use Redis for production (data survives restarts)
   - Without Redis, sessions are lost on bot restart

3. **Monitoring**:
   - Set up log aggregation
   - Monitor OpenCode server availability
   - Set up alerts for bot crashes

4. **Backups**:
   - Backup Redis data regularly
   - Document session recovery procedures

## Troubleshooting

### Bot not responding
- Check bot token is correct: `TELEGRAM_BOT_TOKEN`
- Verify your user ID is in `TELEGRAM_ALLOWED_USER_IDS`
- Check logs: `docker-compose logs bot` or console output
- Ensure bot is running: `docker ps` or `ps aux | grep node`

### Session not created
- Verify OpenCode is running with API server: `curl http://localhost:3000/session`
- Check `OPENCODE_API_URL` points to correct server
- Check `OPENCODE_PROJECT_PATH` exists and is accessible
- Look for connection errors in logs

### "Unknown OpenCode instance" error
- Check instance IDs match between config and code
- Verify `OPENCODE_INSTANCES` JSON is valid
- For single instance, ensure `OPENCODE_API_URL` and `OPENCODE_PROJECT_PATH` are set

### Rate limiting
- Default: 30 messages per minute per user
- Adjust `RATE_LIMIT_MESSAGES` in `.env` if needed
- Consider implementing user-specific rate limits

### Connection refused errors
- OpenCode server not running or wrong port
- Firewall blocking connections
- Wrong `OPENCODE_API_URL` (check http vs https, correct port)

## How It Works

1. **Startup**: Bot initializes storage (Redis or memory), creates clients for each OpenCode instance, and subscribes to event streams
2. **User connects**: User sends `/start`, bot creates user state in storage
3. **Instance selection**: User selects an OpenCode instance via `/instances` (or uses default)
4. **Session creation**: User sends `/new` or a message, bot creates session on selected instance
5. **Message flow**: 
   - User message → Bot → OpenCode API
   - OpenCode response → Event stream → Bot → Telegram
6. **Cleanup**: Old sessions are automatically cleaned up after timeout (default: 1 hour)

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.

## License

MIT

## Contributing

Contributions welcome! Please ensure:
- Code passes linting: `npm run lint`
- TypeScript compiles: `npm run typecheck`
- Tests pass: `npm test`

## Support

For issues and feature requests, please use the GitHub issue tracker.
