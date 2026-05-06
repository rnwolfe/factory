/**
 * Rubric selection.
 *
 * Picks the right rubric for a (ceremony, role) pair. We seed five
 * active rubrics simultaneously — four owner-* rubrics keyed on
 * ceremony, plus a single `rubric-contributor` that handles all
 * contributor work regardless of upstream ceremony.
 *
 * Defaults:
 * - role defaults to `owner` when null/undefined.
 * - ceremony defaults to `tinker` when null/undefined.
 *
 * Operator-default settings (e.g. "always assume personal owner")
 * are applied upstream of this function — the caller passes the
 * resolved ceremony/role here.
 */

import type { Ceremony, ProjectRole } from "@factory/db";

export interface SelectRubricInput {
  ceremony: Ceremony | null | undefined;
  role: ProjectRole | null | undefined;
}

export function selectRubricKey({ ceremony, role }: SelectRubricInput): string {
  const r = role ?? "owner";
  if (r === "contributor") return "rubric-contributor";
  const c = ceremony ?? "tinker";
  return `rubric-owner-${c}`;
}
