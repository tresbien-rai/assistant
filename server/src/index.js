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
const { logger } = require('./utils/logger');

// Route modules
const authRoutes = require('./routes/auth');
const apiKeysRoutes = require('./routes/apiKeys');
const conversationsRoutes = require('./routes/conversations');
const { chatRouter, modelsRouter } = require('./routes/chat');

// Initialize Express app
const app = express();

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

// Conversations and messages
app.use('/api/conversations', conversationsRoutes);

// Chat proxy (AI providers)
app.use('/api/chat', chatRouter);
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
