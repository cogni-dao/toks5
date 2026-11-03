// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node facade: canonical read envelope and execution; local catalog/bindings remain sovereign. */
import { KnowledgeReadOutputSchema } from "@cogni/shared-ai-tools";

export type {
  KnowledgeReadDeps,
  KnowledgeReadInput,
  KnowledgeReadOutput,
  KnowledgeReadRedacted,
} from "@cogni/shared-ai-tools";
export {
  createKnowledgeReadImplementation,
  KNOWLEDGE_READ_NAME,
  KnowledgeReadInputSchema,
  KnowledgeReadOutputSchema,
  knowledgeReadBoundTool,
  knowledgeReadContract,
  knowledgeReadStubImplementation,
} from "@cogni/shared-ai-tools";
export const KnowledgeReadEntrySchema =
  KnowledgeReadOutputSchema.shape.entries.element;
