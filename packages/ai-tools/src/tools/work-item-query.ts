// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node facade: shared release implementation; RED policy stays in host composition. */
export {
  WorkItemQueryInputSchema,
  WorkItemQueryOutputSchema,
  WORK_ITEM_QUERY_NAME,
  workItemQueryContract,
  createWorkItemQueryImplementation,
  workItemQueryStubImplementation,
  workItemQueryBoundTool,
} from "@cogni/shared-ai-tools";
export type {
  WorkItemQueryInput,
  WorkItemQueryOutput,
  WorkItemQueryRedacted,
  WorkItemQueryDeps,
} from "@cogni/shared-ai-tools";
