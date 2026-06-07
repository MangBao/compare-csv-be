import express, { Request, Response, NextFunction } from 'express';
import { diffRouter } from './routes/diff.routes';

const app: express.Express = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic CORS for local development (tighten in production via env variable)
app.use((_req: Request, res: Response, next: NextFunction) => {
  const origin = process.env.CORS_ORIGIN ?? '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/diff', diffRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled error]', err);
  const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
  res.status(status).json({
    error: err.message ?? 'An unexpected error occurred.',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

export default app;
