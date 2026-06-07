import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import csvParser from 'csv-parser';
import type {
  BaseMap,
  BaseMapEntry,
  CsvRow,
  DiffJobResult,
  DiffRecord,
  DiffStats,
} from '../types/diff.types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produces a deterministic MD5 hash for a CSV row object.
 * Keys are sorted alphabetically before serialisation so column ordering in the
 * header does not affect the hash value.
 */
function hashRow(row: CsvRow): string {
  const stable = Object.keys(row)
    .sort()
    .map((k) => `${k}=${row[k]}`)
    .join('\0');
  return crypto.createHash('md5').update(stable, 'utf8').digest('hex');
}

/**
 * Serialises a {@link DiffRecord} to a single JSONL line (no trailing newline).
 */
function toJsonLine(record: DiffRecord): string {
  return JSON.stringify(record);
}

// ─── Phase 1 – Build base map from base.csv (stream, no full RAM load) ────────

function buildBaseMap(filePath: string, primaryKey: string): Promise<BaseMap> {
  return new Promise((resolve, reject) => {
    const baseMap: BaseMap = new Map<string, BaseMapEntry>();
    let rowIndex = 0;

    const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });

    readStream.on('error', (err) =>
      reject(
        new Error(`Failed to open base file "${filePath}": ${err.message}`),
      ),
    );

    readStream
      .pipe(csvParser())
      .on('data', (row: CsvRow) => {
        rowIndex++;
        const pkValue = row[primaryKey];

        if (pkValue === undefined || pkValue === '') {
          // Skip rows that are missing the primary-key column but do not crash
          console.warn(
            `[diff] base row #${rowIndex} is missing primary key "${primaryKey}" – skipped`,
          );
          return;
        }

        baseMap.set(pkValue, { hash: hashRow(row), row });
      })
      .on('error', (err) =>
        reject(new Error(`CSV parse error in base file: ${err.message}`)),
      )
      .on('end', () => resolve(baseMap));
  });
}

// ─── Phase 2 – Stream target.csv, compare against base map, write JSONL ───────

function processTargetStream(
  targetPath: string,
  primaryKey: string,
  baseMap: BaseMap,
  writeStream: fs.WriteStream,
  stats: DiffStats,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let rowIndex = 0;

    const readStream = fs.createReadStream(targetPath, { encoding: 'utf8' });

    readStream.on('error', (err) =>
      reject(
        new Error(
          `Failed to open target file "${targetPath}": ${err.message}`,
        ),
      ),
    );

    readStream
      .pipe(csvParser())
      .on('data', (targetRow: CsvRow) => {
        rowIndex++;
        const pkValue = targetRow[primaryKey];

        if (pkValue === undefined || pkValue === '') {
          console.warn(
            `[diff] target row #${rowIndex} is missing primary key "${primaryKey}" – skipped`,
          );
          return;
        }

        const baseEntry = baseMap.get(pkValue);

        let record: DiffRecord;

        if (baseEntry === undefined) {
          // Key not present in base → row was ADDED in target
          record = {
            status: 'ADDED',
            primaryKey,
            primaryKeyValue: pkValue,
            targetRow,
          };
          stats.added++;
        } else {
          const targetHash = hashRow(targetRow);

          if (targetHash === baseEntry.hash) {
            record = {
              status: 'UNCHANGED',
              primaryKey,
              primaryKeyValue: pkValue,
              targetRow,
            };
            stats.unchanged++;
          } else {
            record = {
              status: 'MODIFIED',
              primaryKey,
              primaryKeyValue: pkValue,
              targetRow,
              baseRow: baseEntry.row,
            };
            stats.modified++;
          }

          // Consume the key – anything left after target scan = DELETED
          baseMap.delete(pkValue);
        }

        // Back-pressure: pause if the write buffer is full
        const canContinue = writeStream.write(toJsonLine(record) + '\n');
        if (!canContinue) {
          (readStream as unknown as NodeJS.ReadableStream).pause();
          writeStream.once('drain', () => {
            (readStream as unknown as NodeJS.ReadableStream).resume();
          });
        }
      })
      .on('error', (err) =>
        reject(new Error(`CSV parse error in target file: ${err.message}`)),
      )
      .on('end', () => resolve());
  });
}

// ─── Phase 3 – Flush remaining base-map keys as DELETED ──────────────────────

function flushDeleted(
  baseMap: BaseMap,
  primaryKey: string,
  writeStream: fs.WriteStream,
  stats: DiffStats,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const entries = [...baseMap.entries()];

    function writeNext(index: number): void {
      if (index >= entries.length) {
        resolve();
        return;
      }

      const [pkValue, { row }] = entries[index]!;
      const record: DiffRecord = {
        status: 'DELETED',
        primaryKey,
        primaryKeyValue: pkValue,
        baseRow: row,
      };
      stats.deleted++;

      const canContinue = writeStream.write(toJsonLine(record) + '\n');
      if (canContinue) {
        writeNext(index + 1);
      } else {
        writeStream.once('drain', () => writeNext(index + 1));
        writeStream.once('error', reject);
      }
    }

    writeNext(0);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RunDiffOptions {
  basePath: string;
  targetPath: string;
  primaryKey: string;
  /** Absolute path for the .jsonl output file */
  outputPath: string;
}

/**
 * Runs the full Row-level Hashing Diff algorithm and streams results into
 * `outputPath` as newline-delimited JSON (JSONL).
 *
 * Memory profile: only the base-file's primary-key → hash map is held in RAM.
 * The target file is fully streamed and never loaded wholesale.
 */
export async function runDiff(options: RunDiffOptions): Promise<DiffJobResult> {
  const { basePath, targetPath, primaryKey, outputPath } = options;

  const startedAt = Date.now();

  const stats: DiffStats = {
    added: 0,
    deleted: 0,
    modified: 0,
    unchanged: 0,
    total: 0,
  };

  // Ensure output directory exists
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  const writeStreamClosed = new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', (err) =>
      reject(new Error(`Write stream error: ${err.message}`)),
    );
  });

  try {
    // Step 1 – load base-file primary-keys + hashes into Map
    const baseMap = await buildBaseMap(basePath, primaryKey);

    // Step 2 – stream target file, compare, write ADDED / MODIFIED / UNCHANGED
    await processTargetStream(
      targetPath,
      primaryKey,
      baseMap,
      writeStream,
      stats,
    );

    // Step 3 – emit remaining base entries as DELETED
    await flushDeleted(baseMap, primaryKey, writeStream, stats);
  } finally {
    // Always close the write stream, even on error
    writeStream.end();
  }

  // Wait for OS to flush all data to disk
  await writeStreamClosed;

  stats.total = stats.added + stats.deleted + stats.modified + stats.unchanged;

  return {
    outputFile: outputPath,
    stats,
    durationMs: Date.now() - startedAt,
  };
}
