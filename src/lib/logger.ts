import { EventEmitter } from "node:events";
import db from "./db";

const insertLog = db.prepare(
  "INSERT INTO run_logs (run_id, ts, level, stage, message, data_json) VALUES (?, ?, ?, ?, ?, ?)"
);

// Incremental read: only rows newer than `sinceId`. Hits idx_run_logs_run
// (run_id, id) as a range scan, so it stays O(new rows) no matter how long the
// run's total history is. `sinceId = 0` returns the full history (ids start at 1).
const getLogsSinceStmt = db.prepare(
  "SELECT id, ts, level, stage, message, data_json FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC"
);

export type LogLevel = "info" | "warn" | "error" | "success" | "debug";

export interface LogEntry {
  id?: number;
  ts: string;
  runId: string;
  level: LogLevel;
  stage?: string;
  message: string;
  data?: unknown;
}

/**
 * Global event bus for live run logs. Each runId is its own event channel.
 * The UI subscribes via SSE, the backend pushes through this logger.
 */
class LogBus extends EventEmitter {}
const bus = new LogBus();
bus.setMaxListeners(0);

export function log(
  runId: string,
  level: LogLevel,
  message: string,
  opts: { stage?: string; data?: unknown } = {}
) {
  const dataJson = opts.data === undefined ? null : JSON.stringify(opts.data);
  const ts = new Date().toISOString();
  const result = insertLog.run(runId, ts, level, opts.stage ?? null, message, dataJson);
  const entry: LogEntry = {
    id: Number(result.lastInsertRowid),
    ts,
    runId,
    level,
    stage: opts.stage,
    message,
    data: opts.data,
  };
  bus.emit(`log:${runId}`, entry);
  // Mirror to the dev console for convenience
  const prefix = `[${runId.slice(0, 8)}${opts.stage ? `/${opts.stage}` : ""}]`;
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : "log"](prefix, message, opts.data ?? "");
  return entry;
}

export function subscribe(runId: string, handler: (e: LogEntry) => void) {
  const ev = `log:${runId}`;
  bus.on(ev, handler);
  return () => bus.off(ev, handler);
}

/**
 * Return this run's log rows with id > sinceId (ascending). Pass sinceId = 0
 * (the default) for the full history. The polling UI passes the id of the last
 * row it has, so each poll transfers only the new lines — the whole "incremental
 * log loading" contract lives here.
 */
export function getLogsSince(runId: string, sinceId = 0): LogEntry[] {
  type Row = {
    id: number;
    ts: string;
    level: LogLevel;
    stage: string | null;
    message: string;
    data_json: string | null;
  };
  const rows = getLogsSinceStmt.all(runId, sinceId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    runId,
    level: r.level,
    stage: r.stage ?? undefined,
    message: r.message,
    data: r.data_json ? JSON.parse(r.data_json) : undefined,
  }));
}

/** Full log history for a run (equivalent to getLogsSince(runId, 0)). */
export function getLogs(runId: string): LogEntry[] {
  return getLogsSince(runId, 0);
}
