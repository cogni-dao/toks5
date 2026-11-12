// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/route-capabilities`
 * Purpose: The node's route-only capability declarations: the `@cogni-dao/agent-grants` 0.3.0 map plus what is newer in
 *   node-template than that release. Vendored for the v0 proof of concept; replaced by a pinned agent-grants release.
 * Scope: Pure data. No I/O.
 * Invariants:
 *   - VENDORED_DELTA: only entries newer than agent-grants 0.3.0 are written here (knowledge.read from node-template #355, minus knowledge.browse which this node has no route for;
 *     core__work_item_update, the twin of work.items.patch, because this node's pinned ai-tools has no such tool contract).
 * Side-effects: none
 * Links: https://github.com/cogni-dao/node-template/pull/355
 * @internal
 */

import { ROUTE_ONLY_CAPABILITIES as PACKAGE_ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";

type RouteOnlyCapabilities = typeof PACKAGE_ROUTE_ONLY_CAPABILITIES;

export const ROUTE_ONLY_CAPABILITIES: RouteOnlyCapabilities = {
  ...PACKAGE_ROUTE_ONLY_CAPABILITIES,
  "knowledge.read": {
    requires: {
      scope: "knowledge:read",
      kind: "node",
      subject: "member",
      label: "Read the knowledge base",
      description:
        "Read this node's published notes. A signed-in person always can; an agent needs an admin's yes.",
    },
    routes: [
      "knowledge.list",
      "knowledge.get",
      "knowledge.history",
      "knowledge.index",
      "knowledge.graph",
      "knowledge.domains.list",
      "knowledge.domains.get",
    ],
  },
  core__work_item_update: {
    requires: {
      scope: "work_item:transition",
      kind: "node",
      subject: "member",
      label: "Update work items (status, scores, labels and other PATCH fields)",
      description:
        "Change a work item's status, scores, labels and the other fields its PATCH allows.",
    },
    routes: ["work.items.patch"],
  },
};
