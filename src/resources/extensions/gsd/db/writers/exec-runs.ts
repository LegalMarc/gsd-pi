// Project/App: gsd-pi
// File Purpose: Single-writer layer for exec_runs — the host record of every
// gsd_exec / gsd_uat_exec command, bound to the Attempt it ran in.
//
// A row is a host fact (see db-exec-run-schema.ts). Evidence checks read these
// rows; they never read `.gsd/exec/<id>.meta.json`.

import { getDb, transaction } from "../engine.js";
import { findWorktreeSegment } from "../../worktree-root.js";

export interface ExecRunRow {
  id: string;
  kind: "exec" | "uat_exec";
  runtime: string;
  command: string;
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  aborted: number;
  started_at: string;
  duration_ms: number;
  output_hash: string;
  milestone_id: string | null;
  slice_id: string | null;
  check_id: string | null;
  attempt_ref: string | null;
  source_revision: string | null;
}

export type ExecRunInput =
  & Pick<ExecRunRow, "id" | "runtime" | "command" | "cwd" | "exit_code" | "signal" | "started_at" | "duration_ms" | "output_hash">
  & {
    timedOut: boolean;
    aborted: boolean;
    /**
     * The Attempt the run's caller had when the command started
     * (currentExecAttemptRef, read before the command). When given, the run is
     * bound only if its Attempt is still that one when the run is stored; an
     * Attempt that was saved, settled or replaced while the command ran leaves
     * the run unbound. `null` (no Attempt, or it could not be read) leaves it
     * unbound too.
     */
    attemptRefAtStart?: string | null;
  }
  & (
    | { kind: "exec" }
    | { kind: "uat_exec"; milestoneId: string; sliceId: string; checkId: string; sourceRevision?: string | null }
  );

/** What a run's Attempt is read from: its kind, folder and, for UAT, its Slice. */
export type ExecAttemptScope =
  | { kind: "exec"; cwd: string }
  | { kind: "uat_exec"; cwd: string; milestoneId: string; sliceId: string };

/** Identity of one run-uat attempt. It is also the run id of the saved UAT result. */
export function uatAttemptRef(milestoneId: string, sliceId: string, attempt: number): string {
  return `uat:${milestoneId}:${sliceId}:attempt-${attempt}`;
}

/** Name of the GSD worktree a path is in ("" outside one). */
function worktreeNameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalized);
  return segment ? normalized.slice(segment.afterWorktrees).split("/")[0] ?? "" : "";
}

function callerScopeOf(cwd: string): string {
  const milestoneLock = process.env.GSD_MILESTONE_LOCK?.trim();
  if (!milestoneLock) return worktreeNameOf(cwd);
  const sliceLock = process.env.GSD_SLICE_LOCK?.trim();
  return sliceLock ? `${milestoneLock}-${sliceLock}` : milestoneLock;
}

/**
 * The Attempt a run belongs to. It is read before the command starts
 * (currentExecAttemptRef) and again in the transaction that stores the run;
 * the run is bound only when both reads agree.
 * A UAT run belongs to the run-uat attempt that is not saved yet. Another run
 * belongs to the Task Attempt of its caller that is not settled. The caller is
 * known by the scope of its worker: `<MID>` for a Milestone, `<MID>-<SID>` for
 * a Slice. The scope is the worker lock (GSD_MILESTONE_LOCK, GSD_SLICE_LOCK);
 * without a lock it is the name of the worktree the run is in. So parallel
 * workers each bind their own runs.
 * With no such Attempt, or with more than one, the run is unbound and proves
 * nothing.
 */
function currentAttemptRef(input: ExecAttemptScope): string | null {
  if (input.kind === "uat_exec") {
    const row = getDb().prepare(`
      SELECT MAX(attempt) AS attempt
      FROM gate_runs
      WHERE gate_id = 'UAT' AND gate_type = 'uat' AND unit_type = 'run-uat'
        AND milestone_id = :milestone_id AND slice_id = :slice_id
    `).get({ ":milestone_id": input.milestoneId, ":slice_id": input.sliceId });
    return uatAttemptRef(input.milestoneId, input.sliceId, Number(row?.["attempt"] ?? 0) + 1);
  }
  const open = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE lifecycle.item_kind = 'task' AND attempt.attempt_state != 'settled'
      AND (
        lifecycle.milestone_id = :scope
        OR lifecycle.milestone_id || '-' || lifecycle.slice_id = :scope
        OR (
          NOT EXISTS (SELECT 1 FROM milestones WHERE id = :scope)
          AND NOT EXISTS (SELECT 1 FROM slices WHERE milestone_id || '-' || id = :scope)
        )
      )
    LIMIT 2
  `).all({ ":scope": callerScopeOf(input.cwd) });
  return open.length === 1 ? String(open[0]!["attempt_id"]) : null;
}

/** The Attempt a run started now would belong to (see currentAttemptRef). */
export function currentExecAttemptRef(scope: ExecAttemptScope): string | null {
  return currentAttemptRef(scope);
}

export function recordExecRun(input: ExecRunInput): ExecRunRow {
  return transaction(() => {
    const uat = input.kind === "uat_exec" ? input : null;
    const attemptRef = currentAttemptRef(input);
    const row: ExecRunRow = {
      id: input.id,
      kind: input.kind,
      runtime: input.runtime,
      command: input.command,
      cwd: input.cwd,
      exit_code: input.exit_code,
      signal: input.signal,
      timed_out: input.timedOut ? 1 : 0,
      aborted: input.aborted ? 1 : 0,
      started_at: input.started_at,
      duration_ms: input.duration_ms,
      output_hash: input.output_hash,
      milestone_id: uat?.milestoneId ?? null,
      slice_id: uat?.sliceId ?? null,
      check_id: uat?.checkId ?? null,
      attempt_ref: input.attemptRefAtStart === undefined || input.attemptRefAtStart === attemptRef ? attemptRef : null,
      source_revision: uat?.sourceRevision ?? null,
    };
    const columns = Object.keys(row);
    getDb().prepare(
      `INSERT INTO exec_runs (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
    ).run(Object.fromEntries(columns.map((column) => [`:${column}`, row[column as keyof ExecRunRow]])));
    return row;
  });
}

export function readExecRun(id: string): ExecRunRow | null {
  const row = getDb().prepare("SELECT * FROM exec_runs WHERE id = :id").get({ ":id": id });
  return (row as unknown as ExecRunRow | undefined) ?? null;
}

export function listExecRunsOfAttempt(attemptRef: string): ExecRunRow[] {
  return getDb().prepare(
    "SELECT * FROM exec_runs WHERE attempt_ref = :attempt_ref ORDER BY started_at, id",
  ).all({ ":attempt_ref": attemptRef }) as unknown as ExecRunRow[];
}

/** Exit 0 and no signal, timeout or abort. */
export function execRunSucceeded(run: ExecRunRow): boolean {
  return run.exit_code === 0 && run.signal === null && run.timed_out === 0 && run.aborted === 0;
}
