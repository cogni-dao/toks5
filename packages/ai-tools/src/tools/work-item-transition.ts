// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node facade: shared release implementation; RED policy stays in host composition. */
export {
  WorkItemTransitionInputSchema,
  WorkItemTransitionOutputSchema,
  WORK_ITEM_TRANSITION_NAME,
  workItemTransitionContract,
  createWorkItemTransitionImplementation,
  workItemTransitionStubImplementation,
  workItemTransitionBoundTool,
} from "@cogni/shared-ai-tools";
export type {
  WorkItemTransitionInput,
  WorkItemTransitionOutput,
  WorkItemTransitionRedacted,
  WorkItemTransitionDeps,
} from "@cogni/shared-ai-tools";
