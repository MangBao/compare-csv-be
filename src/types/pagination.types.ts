import type { DiffRecord, DiffStatus } from './diff.types';

// ─── Query Parameters ─────────────────────────────────────────────────────────

export interface ResultsQueryParams {
  /** Job ID returned by POST /api/diff — used to locate the .jsonl file */
  jobId: string;
  /** 1-based page number (default: 1) */
  page?: string;
  /** Number of records per page (default: 100, max: 1000) */
  limit?: string;
  /** Optional filter: only return records of this diff status */
  status?: DiffStatus;
}

// ─── Parsed & validated version of the above ─────────────────────────────────

export interface ParsedResultsQuery {
  jobId: string;
  page: number;
  limit: number;
  statusFilter: DiffStatus | null;
}

// ─── Service return value ─────────────────────────────────────────────────────

export interface PaginatedDiffResult {
  data: DiffRecord[];
  meta: PaginationMeta;
}

export interface PaginationMeta {
  /** Current page number (1-based) */
  currentPage: number;
  /** Number of records requested per page */
  limit: number;
  /**
   * Total rows in the result file that match the active status filter.
   * Obtained in a single streaming pass — no second file read required.
   */
  totalRows: number;
  /** Total number of pages available */
  totalPages: number;
  /** Whether a next page exists */
  hasNextPage: boolean;
  /** Whether a previous page exists */
  hasPrevPage: boolean;
  /** Active status filter, or null if all statuses are returned */
  statusFilter: DiffStatus | null;
}
