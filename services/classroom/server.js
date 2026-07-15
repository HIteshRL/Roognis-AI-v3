require('./load-env');

const express = require('express');
const prisma  = require('./lib/prisma');

const classesRoutes = require('./routes/classes.routes');
const streamRoutes  = require('./routes/stream.routes');
const workRoutes    = require('./routes/work.routes');
const familyRoutes  = require('./routes/family.routes');

const app  = express();
const PORT = process.env.PORT || 3005;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'classroom' }));

app.use('/api/classroom', classesRoutes);
app.use('/api/classroom', streamRoutes);
app.use('/api/classroom', workRoutes);
app.use('/api/classroom', familyRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Express 4 error handler — Prisma failures land here instead of hanging the request.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[classroom] unhandled error:', err.message);
  res.status(500).json({ error: 'Internal error' });
});

async function shutdown(signal) {
  console.log(`[classroom] ${signal} received. Shutting down...`);
  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[classroom] Service running on :${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[classroom] Port ${PORT} is already in use. Stop the other process or change PORT in .env`
      );
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
