// ─── Row Status ───────────────────────────────────────────────────────────────

export type DiffStatus = 'ADDED' | 'DELETED' | 'MODIFIED' | 'UNCHANGED';

// ─── Raw CSV row: column → value ──────────────────────────────────────────────

export type CsvRow = Record<string, string>;

// ─── In-memory map built from the base file ───────────────────────────────────
// Key   = primaryKey value for that row
// Value = { hash, row } so we can emit the full row on DELETED

export interface BaseMapEntry {
  hash: string;
  row: CsvRow;
}

export type BaseMap = Map<string, BaseMapEntry>;

// ─── A single diff record written to the JSONL output ─────────────────────────

export interface DiffRecord {
  status: DiffStatus;
  primaryKey: string;
  primaryKeyValue: string;
  /** Present for ADDED, MODIFIED, UNCHANGED rows (from target file) */
  targetRow?: CsvRow;
  /** Present for DELETED, MODIFIED rows (from base file) */
  baseRow?: CsvRow;
}

// ─── Request body after multer processes the multipart upload ─────────────────

export interface DiffRequestBody {
  primaryKey: string;
}

export interface DiffRequestFiles {
  base: Express.Multer.File[];
  target: Express.Multer.File[];
}

// ─── Final API response shape ─────────────────────────────────────────────────

export interface DiffJobResult {
  outputFile: string;
  stats: DiffStats;
  durationMs: number;
}

export interface DiffStats {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
  total: number;
}
