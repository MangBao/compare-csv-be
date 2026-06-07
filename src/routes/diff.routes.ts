import express, { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { runDiff } from '../services/diff.service';
import { parseResultsQuery, readPageFromJsonl } from '../services/pagination.service';
import type { DiffRequestBody } from '../types/diff.types';
import type { ResultsQueryParams } from '../types/pagination.types';

// ─── Multer Configuration ─────────────────────────────────────────────────────

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

/** Ensure the uploads directory exists at startup */
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}.csv`);
  },
});

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowedMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
  const allowedExt = ['.csv', '.txt'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMime.includes(file.mimetype) || allowedExt.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type for field "${file.fieldname}". Only CSV files are accepted.`,
      ),
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB per file
  },
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const diffRouter: express.Router = Router();

/**
 * POST /api/diff
 *
 * Accepts a multipart/form-data request with:
 *   - `base`       : CSV file (the original/reference file)
 *   - `target`     : CSV file (the new file to compare against)
 *   - `primaryKey` : string   (the column name that uniquely identifies each row)
 *
 * Returns a JSON object describing the diff job result and per-status counts.
 */
diffRouter.post(
  '/',
  upload.fields([
    { name: 'base', maxCount: 1 },
    { name: 'target', maxCount: 1 },
  ]),
  async (
    req: Request<object, object, DiffRequestBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const files = req.files as
      | { base?: Express.Multer.File[]; target?: Express.Multer.File[] }
      | undefined;

    // ── Validate files ──────────────────────────────────────────────────────
    if (!files?.base?.[0] || !files?.target?.[0]) {
      res.status(400).json({
        error: 'Both "base" and "target" CSV files are required.',
      });
      return;
    }

    const primaryKey = (req.body.primaryKey ?? '').trim();
    if (!primaryKey) {
      res.status(400).json({
        error: '"primaryKey" field is required in the request body.',
      });
      return;
    }

    const baseFile = files.base[0];
    const targetFile = files.target[0];

    // ── Build output path ───────────────────────────────────────────────────
    const outputDir = path.resolve(process.cwd(), 'output');
    const jobId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const outputPath = path.join(outputDir, `diff-result-${jobId}.jsonl`);

    try {
      const result = await runDiff({
        basePath: baseFile.path,
        targetPath: targetFile.path,
        primaryKey,
        outputPath,
      });

      res.status(200).json({
        message: 'Diff completed successfully.',
        jobId,
        outputFile: result.outputFile,
        stats: result.stats,
        durationMs: result.durationMs,
      });
    } catch (err) {
      next(err);
    } finally {
      // Clean up uploaded temp files regardless of success/failure
      await Promise.allSettled([
        fs.promises.unlink(baseFile.path),
        fs.promises.unlink(targetFile.path),
      ]);
    }
  },
);

/**
 * GET /api/diff/results
 *
 * Returns a paginated slice of a previously computed diff result file.
 *
 * Query parameters:
 *   - `jobId`   {string}           — required; returned by POST /api/diff
 *   - `page`    {number}           — 1-based page number (default: 1)
 *   - `limit`   {number}           — records per page (default: 100, max: 1000)
 *   - `status`  {DiffStatus}       — optional filter: ADDED | DELETED | MODIFIED | UNCHANGED
 *
 * The underlying JSONL file is never loaded into memory.  A single streaming
 * pass via `readline` + `fs.createReadStream` counts total rows and collects
 * only the requested page window.
 */
diffRouter.get(
  '/results',
  async (
    req: Request<object, object, object, ResultsQueryParams>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const parseResult = parseResultsQuery(
      req.query as unknown as Record<string, string | undefined>,
    );

    if (!parseResult.ok) {
      res.status(400).json({
        error: 'Invalid query parameters.',
        details: parseResult.errors,
      });
      return;
    }

    try {
      const paginated = await readPageFromJsonl(parseResult.value);
      res.status(200).json(paginated);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: (err as Error).message });
        return;
      }
      if (code === 'ERR_INVALID_JOB_ID') {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      next(err);
    }
  },
);

// ─── Error handler specific to multer ────────────────────────────────────────

diffRouter.use(
  (err: Error, _req: Request, res: Response, next: NextFunction): void => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload error: ${err.message}` });
      return;
    }
    next(err);
  },
);
