/**
 * Express Server Entry Point
 *
 * Sets up the Express application with middleware, routes, and error handling.
 * Serves both the API and static frontend files.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const config = require('./config');
const { getDb } = require('./db/connection');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/authenticate');
const { chatMinuteLimit, chatHourLimit } = require('./middleware/rateLimiter');
const { logger } = require('./utils/logger');

// Route modules
const authRoutes = require('./routes/auth');
const apiKeysRoutes = require('./routes/apiKeys');
const personasRoutes = require('./routes/personas');
const conversationsRoutes = require('./routes/conversations');
const workspacesRoutes = require('./routes/workspaces');
const projectsRoutes = require('./routes/projects');
const settingsRoutes = require('./routes/settings');
const { chatRouter, modelsRouter } = require('./routes/chat');
const { personaAvatarRouter, avatarServingRouter } = require('./routes/avatars');

// Initialize Express app
const app = express();

// Trust the hosting platform's reverse proxy (e.g. Railway) in production so
// req.ip / X-Forwarded-For resolve to the real client. Required for the per-user
// rate limiter to key on the correct IP; without it express-rate-limit warns and
// can throttle all users as if they share one address. Disabled in dev (no proxy),
// where trusting forwarded headers would let clients spoof their IP.
if (!config.isDev) {
  app.set('trust proxy', 1);
}

// Initialize database (getDb initializes if not already done)
getDb();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Request logging
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/api/health',
  },
}));

// CORS configuration
app.use(cors({
  origin: config.isDev ? true : process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true,
}));

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Parse cookies
app.use(cookieParser());

// =============================================================================
// API ROUTES
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Auth routes (no auth required)
app.use('/api/auth', authRoutes);

// API key management
app.use('/api/api-keys', apiKeysRoutes);

// Personas
app.use('/api/personas', personasRoutes);

// Conversations and messages
app.use('/api/conversations', conversationsRoutes);

// Workspaces (outer container: shared instructions + nested projects)
app.use('/api/workspaces', workspacesRoutes);

// Projects (instructions + Drive-backed files; nested under a workspace)
app.use('/api/projects', projectsRoutes);

// User settings
app.use('/api/settings', settingsRoutes);

// Avatar upload/delete (on persona routes) and serving
app.use('/api/personas', personaAvatarRouter);
app.use('/api/avatars', avatarServingRouter);

// Chat proxy (AI providers) - with per-user rate limiting
app.use('/api/chat', authenticate, chatMinuteLimit, chatHourLimit, chatRouter);
app.use('/api/models', modelsRouter);

// =============================================================================
// STATIC FILES
// =============================================================================

// Serve static files from the project root (frontend)
const staticPath = path.resolve(__dirname, config.staticPath);
app.use(express.static(staticPath));

// Serve index.html for any non-API routes (SPA fallback)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(staticPath, 'index.html'));
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler for API routes
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// =============================================================================
// START SERVER
// =============================================================================

const port = config.port;

app.listen(port, () => {
  logger.info({ port, env: config.nodeEnv }, `Server started on port ${port}`);
});

module.exports = app;
