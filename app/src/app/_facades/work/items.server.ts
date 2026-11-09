// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations across the markdown + Doltgres surfaces.
 * Scope: Maps one authoritative backend to contract DTOs; Markdown only when Doltgres is unconfigured (task.0056).
 * Invariants: P0P1_IS_NODE_ADMIN (story.5101: priority <= 1 on create/patch requires node admin,
 *   checked before the store write), PORT_VIA_CONTAINER (no direct adapter imports), CONTRACTS_ARE_TRUTH, NODE_STORE_IS_LOCAL.
 * Side-effects: IO (filesystem read via port; database read/write via Doltgres port)
 * Links: contracts/work.items.{list,get,create,patch}.v1.contract
 * @internal
 */


import {
  checkNodeAdmin,
  isPrivilegedPriority,
  NodeAdminRequiredError,
} from "@cogni/knowledge-store";
import type {
  WorkItemsCreateInput as ContractCreateInput,
  WorkItemsPatchInput as ContractPatchInput,
  WorkItemCoordinationOutput,
  WorkItemDto,
  WorkItemsListInput,
  WorkItemsListOutput,
  WorkItemSummariesListInput,
  WorkItemSummariesListOutput,
} from "@cogni/node-contracts";
import { WorkItemSummarySchema } from "@cogni/node-contracts";
import type {
  WorkBoardColumnPages,
  WorkItem,
  WorkItemId,
  WorkItemScoresIssue,
  WorkSummaryReadOptions,
} from "@cogni/work-items";
import { toWorkItemDto, toWorkItemId } from "@cogni/work-items";
import { getContainer } from "@/bootstrap/container";

/**
 * Thrown when the opaque pagination cursor cannot be decoded — translated
 * to HTTP 400 in the route layer instead of the wrapper's generic 500.
 * The adapter's cursor codec throws a structurally identical error
 * (`name === "InvalidCursorError"`); the facade detects by name and
 * rethrows its own copy so the app layer doesn't have to import from
 * `@/adapters/**` (forbidden by `no-restricted-imports`).
 */
export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export { NodeAdminRequiredError };

export class WorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Work item not found: ${id}`);
    this.name = "WorkItemNotFoundError";
  }
}

export class WorkItemForbiddenError extends Error {
  constructor(id: string) {
    super(`Not authorized to mutate work item: ${id}`);
    this.name = "WorkItemForbiddenError";
  }
}

/**
 * P0P1_IS_NODE_ADMIN (story.5101): refuse a priority <= 1 write unless the caller
 * is node admin (the container's `nodeAdmin` authority), BEFORE any store write.
 * Throws `NodeAdminRequiredError` (403 `authz_denied` / 503 `authz_unavailable`).
 */
async function assertPriorityAuthority(
  priority: number | null | undefined,
  actor: WorkItemActor
): Promise<void> {
  if (!isPrivilegedPriority(priority)) return;
  const decision = await checkNodeAdmin(getContainer().nodeAdmin, {
    userId: actor.id,
    walletAddress: actor.walletAddress ?? null,
  });
  if (!decision.ok) {
    const err = new NodeAdminRequiredError(
      decision,
      `work.items.priority.p${priority}`
    );
    getContainer().log.warn(
      {
        errorCode: err.errorCode,
        reason: err.reason,
        action: err.action,
        userId: actor.id,
      },
      "work.items.priority_node_admin_refused"
    );
    throw err;
  }
}

/** The caller of a work-item write; `walletAddress` is null for agent keys. */
export interface WorkItemActor {
  id: string;
  walletAddress?: string | null;
}

export class WorkItemLeaseConflictError extends Error {
  constructor(id: string) {
    super(`Work item is claimed by another principal or lease: ${id}`);
    this.name = "WorkItemLeaseConflictError";
  }
}

export class WorkItemsBackendNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemsBackendNotReadyError";
  }
}

export class WorkItemWriteOutcomeUnknownError extends Error {
  readonly code = "work_item_write_outcome_unknown";
  readonly retryable = false;
  get receipt() {
    return {
      code: this.code,
      retryable: false as const,
      lookup: {
        operationId: this.operationId,
        branch: this.branch,
        commitHash: this.commitHash ?? null,
        itemId: this.itemId ?? null,
      },
    };
  }
  constructor(
    readonly operationId: string,
    readonly branch: string,
    readonly commitHash?: string,
    readonly itemId?: string
  ) {
    super("Work item write outcome requires inspection before retry");
    this.name = "WorkItemWriteOutcomeUnknownError";
  }
}

export class WorkItemScoresInvalidError extends Error {
  readonly code = "work_item_scores_invalid";
  constructor(readonly issues: readonly WorkItemScoresIssue[]) {
    super("Invalid work item scores");
    this.name = "WorkItemScoresInvalidError";
  }
}
export class WorkItemRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number
  ) {
    super("revision_conflict");
    this.name = "WorkItemRevisionConflictError";
  }
}

function toDto(item: WorkItem): WorkItemDto {
  return toWorkItemDto(item);
}

function nextActionForWorkItem(item: WorkItem): string | null {
  if (item.blockedBy) return "blocked";
  switch (item.status) {
    case "needs_triage":
      return "/triage";
    case "needs_research":
      return "/research";
    case "needs_design":
      return "/design";
    case "needs_implement":
      return "/implement";
    case "needs_closeout":
      return "/closeout";
    case "needs_merge":
      return item.deployVerified ? "/merge" : "/validate-candidate";
    case "blocked":
      return "blocked";
    case "done":
    case "cancelled":
      return null;
  }
}

type StripUndefined<T> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function dropUndefined<T extends Record<string, unknown>>(
  obj: T
): StripUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as StripUndefined<T>;
}

function rethrowBackendError(error: unknown): never {
  if ((error as Error)?.name === "WorkItemWriteOutcomeUnknownError") {
    const receipt = error as {
      operationId: string;
      branch: string;
      commitHash?: string;
      itemId?: string;
    };
    throw new WorkItemWriteOutcomeUnknownError(
      receipt.operationId,
      receipt.branch,
      receipt.commitHash,
      receipt.itemId
    );
  }
  if ((error as Error)?.name === "WorkItemScoresInvalidError")
    throw new WorkItemScoresInvalidError(
      (error as { issues: readonly WorkItemScoresIssue[] }).issues
    );
  if ((error as Error)?.name === "WorkItemRevisionConflictError") {
    const conflict = error as {
      expectedRevision: number;
      currentRevision: number;
    };
    throw new WorkItemRevisionConflictError(
      conflict.expectedRevision,
      conflict.currentRevision
    );
  }
  const message = (error as Error)?.message ?? "";
  const notFound = /^Work item not found: (.+)$/.exec(message);
  if (notFound?.[1]) throw new WorkItemNotFoundError(notFound[1]);
  if (
    (error as Error)?.name === "DoltgresNotConfiguredError" ||
    (error as Error)?.name === "WorkItemsBusyError" ||
    (error as Error)?.name === "DoltMergeOutcomeUnknownError"
  ) {
    throw new WorkItemsBackendNotReadyError(message);
  }
  if ((error as Error)?.name === "WorkItemAuthorizationError") {
    const id = (error as { id?: string }).id ?? "unknown";
    throw new WorkItemForbiddenError(id);
  }
  if ((error as Error)?.name === "WorkItemLeaseConflictError") {
    const id = (error as { id?: string }).id ?? "unknown";
    throw new WorkItemLeaseConflictError(id);
  }
  throw error;
}

function workQuery(input: WorkItemsListInput) {
  return {
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.node && { node: input.node }),
    limit: input.limit ?? 100,
    ...(input.cursor && { cursor: input.cursor }),
  };
}

/** The published summary query (sort, project, rank, label filters) mapped to the port query. */
function summaryQuery(input: WorkItemSummariesListInput) {
  return {
    ...(input.sortBy !== undefined && { sortBy: input.sortBy }),
    ...(input.sortDirection !== undefined && {
      sortDirection: input.sortDirection,
    }),
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.projectIds && { projectIds: input.projectIds.map(toWorkItemId) }),
    ...(input.rankMin !== undefined && { rankMin: input.rankMin }),
    ...(input.rankMax !== undefined && { rankMax: input.rankMax }),
    ...(input.node && { node: input.node }),
    ...(input.labels && { labels: input.labels }),
    ...(input.labelPrefix !== undefined && { labelPrefix: input.labelPrefix }),
    ...(input.scored !== undefined && { scored: input.scored }),
    ...(input.limit !== undefined && { limit: input.limit }),
    ...(input.cursor && { cursor: input.cursor }),
  };
}

function rethrowCursorError(error: unknown): void {
  if ((error as Error)?.name === "InvalidCursorError")
    throw new InvalidCursorError((error as Error).message);
}

/**
 * One page from exactly one backend (task.0056). Configured Doltgres owns the
 * total order and its cursor; its failures stay errors. Markdown is read only
 * when Doltgres is genuinely unconfigured, so a page never merges a second,
 * unbounded Markdown list.
 */
export async function listWorkItems(
  input: WorkItemsListInput
): Promise<WorkItemsListOutput> {
  const container = getContainer();
  const queryShared = workQuery(input);
  try {
    const result = await container.doltgresWorkItems.list(queryShared);
    return {
      items: result.items.map(toDto),
      pageInfo: result.pageInfo,
      ...(result.pageInfo.endCursor !== null && {
        nextCursor: result.pageInfo.endCursor,
      }),
    };
  } catch (error) {
    rethrowCursorError(error);
    if ((error as Error)?.name !== "DoltgresNotConfiguredError")
      rethrowBackendError(error);
  }
  try {
    const result = await container.workItemQuery.list(queryShared);
    return {
      items: result.items.map(toDto),
      pageInfo: {
        endCursor: result.nextCursor ?? null,
        hasMore: result.nextCursor !== undefined,
      },
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    };
  } catch (error) {
    rethrowCursorError(error);
    throw error;
  }
}

/** One bounded summary page; `options` (signal, shared deadline, scan budget) only tightens the read. */
export async function listWorkSummaries(
  input: WorkItemSummariesListInput,
  options?: WorkSummaryReadOptions
): Promise<WorkItemSummariesListOutput> {
  const container = getContainer();
  const query = summaryQuery(input);
  try {
    return await container.doltgresWorkItems.listSummaries(query, options);
  } catch (error) {
    rethrowCursorError(error);
    if ((error as Error)?.name !== "DoltgresNotConfiguredError")
      rethrowBackendError(error);
  }
  try {
    const result = await container.workItemQuery.list(query);
    return {
      items: result.items.map((item) =>
        WorkItemSummarySchema.parse(toDto(item))
      ),
      pageInfo: {
        endCursor: result.nextCursor ?? null,
        hasMore: result.nextCursor !== undefined,
      },
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    };
  } catch (error) {
    rethrowCursorError(error);
    throw error;
  }
}

/**
 * First page of every listed board column in ONE store read when the Doltgres
 * port composes it; otherwise (Markdown) one summary read per column. Text
 * queries never reach here (the package keeps them per-column).
 */
export async function listWorkBoardColumns(
  input: WorkItemSummariesListInput,
  statuses: readonly string[],
  perColumn: number,
  options?: { readonly signal?: AbortSignal }
): Promise<WorkBoardColumnPages> {
  const port = getContainer().doltgresWorkItems;
  if (port.listBoardColumns) {
    try {
      return await port.listBoardColumns(
        summaryQuery(input),
        statuses,
        perColumn,
        options
      );
    } catch (error) {
      rethrowCursorError(error);
      if ((error as Error)?.name !== "DoltgresNotConfiguredError")
        rethrowBackendError(error);
    }
  }
  const columns = [];
  for (const status of statuses) {
    const page = await listWorkSummaries(
      { ...input, statuses: [status], limit: perColumn },
      options
    );
    columns.push({ status, items: page.items, pageInfo: page.pageInfo });
  }
  return { columns, queryCount: columns.length };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  // Doltgres-first: legacy markdown IDs (e.g. bug.0002) can also live in Doltgres
  // after the markdown→Doltgres import (task.5002). Fall back to markdown only when
  // Doltgres returns null, so unimported legacy IDs still resolve during transition.
  try {
    const item = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (item) return toDto(item);
  } catch (e) {
    if ((e as Error)?.name !== "DoltgresNotConfiguredError") {
      rethrowBackendError(e);
    }
  }
  const mdItem = await container.workItemQuery.get(id as WorkItemId);
  return mdItem ? toDto(mdItem) : null;
}

export async function createWorkItem(
  input: ContractCreateInput,
  sessionUser: WorkItemActor
): Promise<WorkItemDto> {
  await assertPriorityAuthority(input.priority, sessionUser);
  const container = getContainer();
  try {
    const created = await container.doltgresWorkItems.create(
      {
        type: input.type,
        title: input.title,
        ...(input.id !== undefined && { id: toWorkItemId(input.id) }),
        ...(input.summary !== undefined && { summary: input.summary }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.specRefs !== undefined && { specRefs: input.specRefs }),
        ...(input.projectId !== undefined && {
          projectId: toWorkItemId(input.projectId),
        }),
        ...(input.parentId !== undefined && {
          parentId: toWorkItemId(input.parentId),
        }),
        ...(input.labels !== undefined && { labels: input.labels }),
        ...(input.assignees !== undefined && { assignees: input.assignees }),
        ...(input.node !== undefined && { node: input.node }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.rank !== undefined && { rank: input.rank }),
        ...(input.estimate !== undefined && { estimate: input.estimate }),
        ...(input.scores !== undefined && { scores: input.scores }),
      },
      sessionUser.id
    );
    return toDto(created);
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function patchWorkItem(
  input: ContractPatchInput,
  sessionUser: WorkItemActor
): Promise<WorkItemDto> {
  await assertPriorityAuthority(input.set.priority, sessionUser);
  const container = getContainer();
  try {
    const patched = await container.doltgresWorkItems.patch(
      {
        id: toWorkItemId(input.id),
        set: dropUndefined(input.set),
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.expectedRevision !== undefined && {
          expectedRevision: input.expectedRevision,
        }),
      },
      sessionUser.id
    );
    if (!patched) throw new WorkItemNotFoundError(input.id);
    return toDto(patched);
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function deleteWorkItem(
  id: string,
  sessionUser: { id: string }
): Promise<boolean> {
  const container = getContainer();
  try {
    return await container.doltgresWorkItems.delete(
      toWorkItemId(id),
      sessionUser.id
    );
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function claimWorkItem(input: {
  id: string;
  runId: string;
  command: string;
  principalId: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.claim({
      id: toWorkItemId(input.id),
      runId: input.runId,
      command: input.command,
      principalId: input.principalId,
    });
    return toDto(item);
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function releaseWorkItem(input: {
  id: string;
  runId: string;
  principalId: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.release({
      id: toWorkItemId(input.id),
      runId: input.runId,
      principalId: input.principalId,
    });
    return toDto(item);
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function heartbeatWorkItem(input: {
  id: string;
  runId: string;
  command?: string;
  principalId: string;
}): Promise<WorkItemDto> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.heartbeat({
      id: toWorkItemId(input.id),
      runId: input.runId,
      ...(input.command !== undefined && { command: input.command }),
      principalId: input.principalId,
    });
    return toDto(item);
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function getWorkItemCoordination(
  id: string
): Promise<WorkItemCoordinationOutput> {
  const container = getContainer();
  try {
    const current = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (!current) throw new WorkItemNotFoundError(id);
    return {
      nextAction: nextActionForWorkItem(current),
      session: {
        status: current.claimedByRun ? "active" : "none",
        claimedByRun: current.claimedByRun ?? null,
        claimedByDisplayName: current.claimedByRun ?? null,
        claimedAt: current.claimedAt ?? null,
        lastCommand: current.lastCommand ?? null,
      },
    };
  } catch (error) {
    if (error instanceof WorkItemNotFoundError) throw error;
    rethrowBackendError(error);
  }
}
