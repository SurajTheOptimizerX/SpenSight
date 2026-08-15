const express = require('express');
const cors = require('cors');
const path = require('path');
// Loads & validates env config (throws at startup if JWT_SECRET is missing)
const { ALLOWED_ORIGINS } = require('./config/env');

// Activate BullMQ background queue worker
require('./workers/csvWorker');

// Apply idempotent schema migrations on boot (safe if the DB is unavailable)
const { runMigrations } = require('./config/migrate');
runMigrations();

const app = express();
const ROOT_DIR = path.join(__dirname, '..');
app.set('ROOT_DIR', ROOT_DIR);

// Clean and sanitize ALLOWED_ORIGINS array to handle potential whitespace or markdown artifacts
const cleanAllowedOrigins = (Array.isArray(ALLOWED_ORIGINS) ? ALLOWED_ORIGINS : ALLOWED_ORIGINS.split(','))
  .map(url => url.replace(/\[|\]|\(.*\)/g, '').trim())
  .filter(Boolean);

// Restrictive CORS: only allow requests from explicitly configured origins.
// Same-origin requests (frontend served by this Express server) are always allowed.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || cleanAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const error = new Error(`Origin "${origin}" is not allowed by CORS.`);
      error.status = 403;
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve static frontend assets
app.use(express.static(path.join(ROOT_DIR, 'Frontend')));

// API Routes Registration
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/transactions', require('./routes/transactionRoutes'));
app.use('/api/health', require('./routes/healthRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api/budgets', require('./routes/budgetRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/accounts', require('./routes/accountRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/insights', require('./routes/insightsRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));

// Static HTML Page Fallbacks
app.get('/', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/register.html')));
app.get('/verify.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/verify.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/dashboard.html')));
app.get('/insights.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/insights.html')));
app.get('/categories.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/categories.html')));
app.get('/subscriptions.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/subscriptions.html')));
app.get('/settings.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'Frontend/settings.html')));

// 404 handler + central error handler (must be last)
const { notFoundMiddleware, errorMiddleware } = require('./middleware/errorMiddleware');
app.use(notFoundMiddleware);
app.use(errorMiddleware);

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SpenSight server running on port ${PORT}`);
  console.log(`CORS allowed origins: ${cleanAllowedOrigins.join(', ')}`);
});