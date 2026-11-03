// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node facade: shared release implementation; RED policy stays in host composition. */
export {
  KnowledgeSearchInputSchema,
  KnowledgeSearchOutputSchema,
  KNOWLEDGE_SEARCH_NAME,
  knowledgeSearchContract,
  createKnowledgeSearchImplementation,
  knowledgeSearchStubImplementation,
  knowledgeSearchBoundTool,
} from "@cogni/shared-ai-tools";
export type {
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
  KnowledgeSearchRedacted,
  KnowledgeSearchDeps,
} from "@cogni/shared-ai-tools";
