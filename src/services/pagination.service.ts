import fs from 'fs';
import readline from 'readline';
import path from 'path';
import type { DiffRecord, DiffStatus } from '../types/diff.types';
import type { PaginatedDiffResult, ParsedResultsQuery } from '../types/pagination.types';

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

/**
 * Allowed jobId characters: digits and hyphens only.
 * This prevents path-traversal attacks such as `../../../etc/passwd`.
 */
const JOB_ID_PATTERN = /^[\d-]+$/;

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Returns the absolute path to a diff result file for a given jobId,
 * or throws a typed error if the jobId is invalid / file is not found.
 */
export function resolveOutputPath(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    const err = new Error(`Invalid jobId format: "${jobId}".`);
    (err as NodeJS.ErrnoException).code = 'ERR_INVALID_JOB_ID';
    throw err;
  }

  const filePath = path.join(OUTPUT_DIR, `diff-result-${jobId}.jsonl`);

  // Ensure the resolved path is still inside OUTPUT_DIR (defence in depth)
  if (!filePath.startsWith(OUTPUT_DIR + path.sep) && filePath !== OUTPUT_DIR) {
    const err = new Error('Resolved path is outside the output directory.');
    (err as NodeJS.ErrnoException).code = 'ERR_INVALID_JOB_ID';
    throw err;
  }

  return filePath;
}

// ─── Single-pass streaming pagination ────────────────────────────────────────

/**
 * Reads the JSONL file produced by the diff engine using a single streaming
 * pass with `readline` + `fs.createReadStream`.
 *
 * **Memory guarantee**: At most `limit` fully-parsed {@link DiffRecord} objects
 * are held in memory at any point.  Every other line is processed as a raw
 * string to count rows, then discarded immediately.
 *
 * Algorithm (all in one pass):
 *  1. For each non-empty line, JSON-parse it and check the optional status filter.
 *  2. Increment a running `matchingRows` counter for every line that passes the filter.
 *  3. Collect lines whose `matchingRows` index falls in [offset, offset + limit).
 *  4. After the stream closes, `matchingRows` == totalRows within the filter.
 */
export async function readPageFromJsonl(
  query: ParsedResultsQuery,
): Promise<PaginatedDiffResult> {
  const { jobId, page, limit, statusFilter } = query;

  const filePath = resolveOutputPath(jobId);

  // Verify the file exists before opening a stream (provides a clear 404 path)
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    const err = new Error(`Result file not found for jobId "${jobId}".`);
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  }

  const offset = (page - 1) * limit; // 0-based index of the first record to collect

  return new Promise<PaginatedDiffResult>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });

    const rl = readline.createInterface({
      input: readStream,
      // crlfDelay handles Windows-style line endings (\r\n)
      crlfDelay: Infinity,
    });

    const pageData: DiffRecord[] = [];
    let matchingRows = 0; // total rows that pass the status filter
    let lineNumber = 0;   // raw line counter for error messages

    rl.on('line', (rawLine: string) => {
      lineNumber++;
      const trimmed = rawLine.trim();
      if (trimmed === '') return; // skip blank lines (e.g. trailing newline)

      let record: DiffRecord;
      try {
        record = JSON.parse(trimmed) as DiffRecord;
      } catch {
        // Malformed line — emit a warning but do not abort the entire read
        console.warn(
          `[pagination] Skipping malformed JSON at line ${lineNumber} of "${filePath}"`,
        );
        return;
      }

      // ── Apply optional status filter ────────────────────────────────────
      if (statusFilter !== null && record.status !== statusFilter) {
        return; // does not match the requested filter — skip without counting
      }

      // ── Determine whether this record falls in the requested page window ─
      if (matchingRows >= offset && matchingRows < offset + limit) {
        pageData.push(record);
      }

      matchingRows++;
      // After we have counted past the last possible record for this page,
      // we still need to finish reading to get totalRows — no early exit.
    });

    rl.on('error', (err) => {
      reject(new Error(`Stream error reading "${filePath}": ${err.message}`));
    });

    readStream.on('error', (err) => {
      reject(new Error(`File read error for "${filePath}": ${err.message}`));
    });

    rl.on('close', () => {
      const totalRows = matchingRows;
      const totalPages = Math.ceil(totalRows / limit) || 1;

      resolve({
        data: pageData,
        meta: {
          currentPage: page,
          limit,
          totalRows,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
          statusFilter,
        },
      });
    });
  });
}

// ─── Query parser ─────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<DiffStatus>([
  'ADDED',
  'DELETED',
  'MODIFIED',
  'UNCHANGED',
]);

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const DEFAULT_PAGE = 1;

export interface QueryParseError {
  field: string;
  message: string;
}

/**
 * Parses and validates raw query-string values into a {@link ParsedResultsQuery}.
 * Returns either `{ ok: true, value }` or `{ ok: false, errors }`.
 */
export function parseResultsQuery(
  raw: Record<string, string | undefined>,
):
  | { ok: true; value: ParsedResultsQuery }
  | { ok: false; errors: QueryParseError[] } {
  const errors: QueryParseError[] = [];

  // ── jobId ────────────────────────────────────────────────────────────────
  const jobId = (raw.jobId ?? '').trim();
  if (!jobId) {
    errors.push({ field: 'jobId', message: '"jobId" query parameter is required.' });
  } else if (!JOB_ID_PATTERN.test(jobId)) {
    errors.push({ field: 'jobId', message: '"jobId" contains invalid characters.' });
  }

  // ── page ─────────────────────────────────────────────────────────────────
  let page = DEFAULT_PAGE;
  if (raw.page !== undefined) {
    const parsed = parseInt(raw.page, 10);
    if (isNaN(parsed) || parsed < 1) {
      errors.push({ field: 'page', message: '"page" must be a positive integer.' });
    } else {
      page = parsed;
    }
  }

  // ── limit ────────────────────────────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    const parsed = parseInt(raw.limit, 10);
    if (isNaN(parsed) || parsed < 1) {
      errors.push({ field: 'limit', message: '"limit" must be a positive integer.' });
    } else if (parsed > MAX_LIMIT) {
      errors.push({
        field: 'limit',
        message: `"limit" must not exceed ${MAX_LIMIT}.`,
      });
    } else {
      limit = parsed;
    }
  }

  // ── status filter ────────────────────────────────────────────────────────
  let statusFilter: DiffStatus | null = null;
  if (raw.status !== undefined) {
    const upper = raw.status.toUpperCase() as DiffStatus;
    if (!VALID_STATUSES.has(upper)) {
      errors.push({
        field: 'status',
        message: `"status" must be one of: ${[...VALID_STATUSES].join(', ')}.`,
      });
    } else {
      statusFilter = upper;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { jobId, page, limit, statusFilter } };
}
