// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/route-capabilities`
 * Purpose: This node's route-only capability declarations: the `@cogni-dao/agent-grants` map plus one declaration this node owns.
 * Scope: Pure data. No I/O.
 * Invariants:
 *   - NODE_OWNED_DECLARATION_ONLY: the package owns `knowledge.read`, `knowledge.contribute` and every route twin map. This file adds only the
 *     declaration (label and description) of the `work_item:transition` scope for `core__work_item_update`, because this node's ai-tools
 *     has no work-item-update tool contract to carry it. Delete the entry when the node adopts that tool.
 * Side-effects: none
 * @internal
 */

import { ROUTE_ONLY_CAPABILITIES as PACKAGE_ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";

type RouteOnlyCapabilities = typeof PACKAGE_ROUTE_ONLY_CAPABILITIES;

export const ROUTE_ONLY_CAPABILITIES: RouteOnlyCapabilities = {
  ...PACKAGE_ROUTE_ONLY_CAPABILITIES,
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
