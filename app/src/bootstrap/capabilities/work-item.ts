// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** RED's tool capability uses the live backlog and released score/rank contracts. */
import type { WorkItemCapability, WorkItemInfo } from "@cogni/ai-tools";
import { WorkItemPatchConflictError } from "@cogni/ai-tools";
import { isPrivilegedPriority } from "@cogni/knowledge-store";
import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemsContentPort,
  WorkQuery,
} from "@cogni/work-items";
import { rankScore, toWorkItemId } from "@cogni/work-items";

export interface WorkItemCapabilityDeps {
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  readonly backlogReader?: Pick<WorkItemsContentPort, "get" | "list">;
  readonly backlogWriter?: {
    readonly patch: WorkItemsContentPort["patch"];
    readonly principalId: () => string;
  };
}
function toInfo(item: WorkItem): WorkItemInfo {
  const rank = rankScore(item.scores);
  return {
    ...item,
    assignees: item.assignees.map((a) => ({
      kind: a.kind,
      id:
        a.kind === "user"
          ? a.userId
          : a.kind === "agent"
            ? a.agentId
            : a.serviceId,
    })),
    ...(rank !== undefined && { rankScore: rank }),
  };
}
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps
): WorkItemCapability {
  const queryPage: NonNullable<WorkItemCapability["queryPage"]> = async (
    params
  ) => {
    const page = await (deps.backlogReader ?? deps.workItemQuery).list(
      params as WorkQuery
    );
    return {
      items: page.items.map(toInfo),
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  };
  return {
    query: async (params) => (await queryPage(params)).items,
    queryPage,
    transitionStatus: async (input) => {
      const current = await deps.workItemQuery.get(toWorkItemId(input.id));
      if (!current) throw new Error(`Work item not found: ${input.id}`);
      const updated = await deps.workItemCommand.transitionStatus({
        id: current.id,
        expectedRevision: String(current.revision),
        toStatus: input.toStatus as WorkItem["status"],
        ...(input.reason && { reason: input.reason }),
      });
      return {
        id: updated.id,
        previousStatus: current.status,
        newStatus: updated.status,
        revision: Number(updated.revision),
      };
    },
    patch: async (input) => {
      if (
        input.set.priority != null &&
        isPrivilegedPriority(input.set.priority)
      )
        throw new Error(
          `authz_denied: priority ${input.set.priority} requires node admin — propose it instead`
        );
      if (deps.backlogWriter) {
        const principal = deps.backlogWriter.principalId();
        if (!principal)
          throw new Error("WorkItemCapability: authenticated actor required");
        return toInfo(
          await deps.backlogWriter.patch(
            {
              id: toWorkItemId(input.id),
              ...(input.expectedRevision !== undefined && {
                expectedRevision: input.expectedRevision,
              }),
              set: input.set,
            },
            principal
          )
        );
      }
      const current = await deps.workItemQuery.get(toWorkItemId(input.id));
      if (!current) throw new Error(`Work item not found: ${input.id}`);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== Number(current.revision)
      )
        throw new WorkItemPatchConflictError(
          input.id,
          input.expectedRevision,
          Number(current.revision)
        );
      return toInfo(
        await deps.workItemCommand.patch({
          id: current.id,
          expectedRevision: String(current.revision),
          set: input.set,
        })
      );
    },
  };
}
