// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/CitationNavLink`
 * Purpose: Router link for `@cogni/knowledge-base-ui` citation rows and inbox link lists.
 * Scope: Client-side navigation only. toks5 has no side sheet, so `entityId` is dropped.
 * Side-effects: none
 * @internal
 */

"use client";

import type { CitationLinkProps } from "@cogni/knowledge-base-ui";
import Link from "next/link";
import type { ReactElement } from "react";

export function CitationNavLink({
  entityId: _entityId,
  href,
  children,
  ...rest
}: CitationLinkProps): ReactElement {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
