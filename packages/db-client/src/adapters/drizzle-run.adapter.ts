// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/scheduling/drizzle-run`
 * Purpose: DrizzleGraphRunAdapter for the canonical graph run ledger.
 * Scope: Implements GraphRunRepository with Drizzle ORM. Does not contain scheduling logic.
 * Invariants:
 * - Per SINGLE_RUN_LEDGER: one table for all execution types
 * - UNIQUE(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL prevents duplicate scheduled runs
 * - withTenantScope called on every method (uniform invariant, no-op on serviceDb)
 * - listRunsByUser relies on RLS for row visibility (no app-level requestedBy filter)
 * Side-effects: IO (database operations)
 * Links: ports/scheduling/schedule-run.port.ts, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/unified-graph-launch.md
 * @public
 */

import { graphRuns } from "@cogni/db-schema/scheduling";
import type { ActorId } from "@cogni/ids";
import type {
  GraphRun,
  GraphRunKind,
  GraphRunRepository,
  GraphRunStatus,
} from "@cogni/scheduler-core";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database, LoggerLike } from "../client";
import { withTenantScope } from "../tenant-scope";

export class DrizzleGraphRunAdapter implements GraphRunRepository {
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  /**
   * Creates a graph run record.
   * For scheduled runs: idempotent via UNIQUE(schedule_id, scheduled_for).
   * All writers serialize by runId before reading or inserting. Scheduled slots
   * retain their separate history key; no historical rows are rewritten.
   */
  async createRun(
    actorId: ActorId,
    params: {
      runId: string;
      graphId?: string;
      runKind?: GraphRunKind;
      triggerSource?: string;
      triggerRef?: string;
      requestedBy?: string;
      scheduleId?: string;
      scheduledFor?: Date;
      stateKey?: string;
    }
  ): Promise<GraphRun> {
    return withTenantScope(this.db, actorId, async (tx) => {
      // The ledger predates runId uniqueness. Serialize the repository's writers
      // without imposing a new constraint on historical schedule records.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`graph-run:${params.runId}`}, 0))`
      );
      const existing = await tx.select().from(graphRuns)
        .where(eq(graphRuns.runId, params.runId)).limit(2);
      if (existing.length > 1) {
        throw new Error("Ambiguous historical graph run identity");
      }
      if (existing[0]) return this.toRun(existing[0]);

      const values = {
        runId: params.runId,
        graphId: params.graphId ?? null,
        runKind: params.runKind ?? null,
        triggerSource: params.triggerSource ?? null,
        triggerRef: params.triggerRef ?? null,
        requestedBy: params.requestedBy ?? null,
        scheduleId: params.scheduleId ?? null,
        scheduledFor: params.scheduledFor ?? null,
        stateKey: params.stateKey ?? null,
        status: "pending" as const,
      };

      if (params.scheduleId && params.scheduledFor) {
        // A different runId may race for this schedule slot. PostgreSQL
        // resolves the partial unique index without aborting our transaction.
        await tx.insert(graphRuns).values(values).onConflictDoNothing();

        // Always SELECT to get the row (new or existing)
        const [row] = await tx
          .select()
          .from(graphRuns)
          .where(
            and(
              eq(graphRuns.scheduleId, params.scheduleId),
              eq(graphRuns.scheduledFor, params.scheduledFor)
            )
          );

        if (!row) {
          throw new Error("Failed to create or retrieve run record");
        }

        this.logger.debug(
          { runId: row.runId, scheduleId: params.scheduleId },
          "Created or retrieved scheduled run record"
        );

        return this.toRun(row);
      }

      // Non-scheduled run — the runId transaction lock owns this insert
      const [row] = await tx.insert(graphRuns).values(values).returning();

      if (!row) {
        throw new Error("Failed to create run record");
      }

      this.logger.debug(
        { runId: row.runId, runKind: params.runKind },
        "Created run record"
      );

      return this.toRun(row);
    });
  }

  /**
   * Marks a run as started. Monotonic: only transitions from 'pending'.
   * Idempotent on retry - no-op if already running/completed.
   */
  async markRunStarted(
    actorId: ActorId,
    runId: string,
    langfuseTraceId?: string
  ): Promise<void> {
    await withTenantScope(this.db, actorId, async (tx) => {
      // Monotonic guard: only update if status='pending' (prevents regression)
      await tx
        .update(graphRuns)
        .set({
          status: "running",
          startedAt: new Date(),
          langfuseTraceId: langfuseTraceId ?? null,
        })
        .where(
          and(eq(graphRuns.runId, runId), eq(graphRuns.status, "pending"))
        );
    });

    this.logger.debug({ runId }, "Marked run as started");
  }

  /**
   * Marks a run as completed. Definitive outcomes may upgrade transport timeout;
   * success/error remain terminal and cannot be overwritten by later workers.
   */
  async markRunCompleted(
    actorId: ActorId,
    runId: string,
    status: "success" | "error" | "timeout" | "skipped" | "cancelled",
    errorMessage?: string,
    errorCode?: string
  ): Promise<void> {
    await withTenantScope(this.db, actorId, async (tx) => {
      // Timeout is transport-incomplete, so a later node-owned outcome may
      // reconcile it. Definitive success/error remain monotonic terminals.
      await tx
        .update(graphRuns)
        .set({
          status,
          completedAt: new Date(),
          errorMessage: errorMessage ?? null,
          errorCode: errorCode ?? null,
        })
        .where(
          and(
            eq(graphRuns.runId, runId),
            inArray(graphRuns.status, ["pending", "running", "timeout"])
          )
        );
    });

    this.logger.info({ runId, status }, "Marked run as completed");
  }

  async getRunByRunId(
    actorId: ActorId,
    runId: string
  ): Promise<GraphRun | null> {
    return withTenantScope(this.db, actorId, async (tx) => {
      const rows = await tx
        .select()
        .from(graphRuns)
        .where(eq(graphRuns.runId, runId))
        .limit(2);
      if (rows.length > 1) {
        throw new Error("Ambiguous historical graph run identity");
      }
      return rows[0] ? this.toRun(rows[0]) : null;
    });
  }

  async patchRunStateKey(
    actorId: ActorId,
    runId: string,
    stateKey: string
  ): Promise<void> {
    await withTenantScope(this.db, actorId, async (tx) => {
      await tx
        .update(graphRuns)
        .set({ stateKey })
        .where(eq(graphRuns.runId, runId));
    });
  }

  async listRunsByUser(
    actorId: ActorId,
    userId: string,
    opts?: {
      status?: GraphRunStatus;
      runKind?: GraphRunKind;
      limit?: number;
      cursor?: string;
    }
  ): Promise<GraphRun[]> {
    const pageSize = Math.min(opts?.limit ?? 20, 100);

    return withTenantScope(this.db, actorId, async (tx) => {
      // requestedBy filter scopes to the queried principal. RLS provides the
      // security boundary (user sees own runs + schedule-owned runs), but this
      // WHERE clause ensures user-scope queries don't return system runs and
      // system-scope queries don't return user runs. Defense-in-depth.
      const conditions: (ReturnType<typeof eq> | undefined)[] = [
        eq(graphRuns.requestedBy, userId),
      ];

      if (opts?.status) {
        conditions.push(eq(graphRuns.status, opts.status));
      }
      if (opts?.runKind) {
        conditions.push(eq(graphRuns.runKind, opts.runKind));
      }
      // JS Date exposes millisecond precision. Use the same precision in SQL
      // ordering and comparisons, including historical sub-millisecond starts.
      const startedAt = sql`date_trunc('milliseconds', ${graphRuns.startedAt})`;
      if (opts?.cursor) {
        if (opts.cursor.startsWith("v1|")) {
          const [, timestamp, id] = opts.cursor.split("|");
          if (
            !id ||
            !timestamp ||
            (timestamp !== "null" && Number.isNaN(Date.parse(timestamp)))
          ) {
            throw new Error("Invalid run history cursor");
          }
          // SQL expressions have no timestamp-column encoder: bind ISO text
          // explicitly as timestamptz, matching started_at even outside UTC.
          const cursorDate =
            timestamp === "null"
              ? null
              : sql`${new Date(timestamp).toISOString()}::timestamptz`;
          conditions.push(
            cursorDate === null
              ? and(isNull(graphRuns.startedAt), lt(graphRuns.id, id))
              : or(
                  lt(startedAt, cursorDate),
                  and(eq(startedAt, cursorDate), lt(graphRuns.id, id)),
                  isNull(graphRuns.startedAt)
                )
          );
        } else {
          const cursorDate = sql`${new Date(opts.cursor).toISOString()}::timestamptz`;
          conditions.push(
            or(lt(startedAt, cursorDate), isNull(graphRuns.startedAt))
          );
        }
      }

      const rows = await tx
        .select()
        .from(graphRuns)
        .where(and(...conditions))
        .orderBy(sql`${startedAt} DESC NULLS LAST`, desc(graphRuns.id))
        .limit(pageSize + 1); // fetch one extra to detect next page

      return rows.map((row) => this.toRun(row));
    });
  }

  private toRun(row: typeof graphRuns.$inferSelect): GraphRun {
    return {
      id: row.id,
      scheduleId: row.scheduleId,
      runId: row.runId,
      graphId: row.graphId,
      runKind: row.runKind,
      triggerSource: row.triggerSource,
      triggerRef: row.triggerRef,
      requestedBy: row.requestedBy,
      scheduledFor: row.scheduledFor,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      status: row.status,
      attemptCount: row.attemptCount,
      langfuseTraceId: row.langfuseTraceId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      stateKey: row.stateKey,
    };
  }
}
