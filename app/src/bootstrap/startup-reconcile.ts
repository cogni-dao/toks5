// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/startup-reconcile`
 * Purpose: Self-activate this node's declared governance schedules (e.g. WORK_PRIORITIZER) from its
 *   OWN repo-spec at startup — no external trigger (operator `startup-reconcile` shape, story.5101).
 * Scope: One detached, retry-until-success kick of runGovernanceSchedulesSyncJob per process.
 *   Delegates all sync logic to the job; owns only the trigger + retry.
 * Invariants:
 *   - SELF_RECONCILE_ON_BOOT: a repo-spec schedule change activates on the next deploy with no
 *     INTERNAL_OPS_TOKEN POST. Nothing in the Akash deploy path calls the ops route, so without
 *     this a declared schedule never reaches Temporal. The ops route stays for manual re-sync.
 *   - RETRY_UNTIL_READY: Temporal may not be reachable on first init; retry with backoff. The job's
 *     pg advisory lock makes every attempt, and every replica, idempotent.
 *   - FIRE_ONCE_PER_PROCESS / TEST_INERT.
 * Side-effects: IO (Temporal schedule reconcile, DB advisory lock), async, detached.
 * Links: bootstrap/container.ts (getContainer trigger), bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @public
 */

let _started = false;

/** Attempts before giving up for this process (a redeploy restarts the loop). */
const MAX_ATTEMPTS = 8;
/** Backoff between attempts — covers Temporal coming up shortly after the app. */
const RETRY_DELAY_MS = 15_000;

/** Kick the governance-schedules reconcile once per process, detached. Never throws. */
export function startGovernanceSyncOnBoot(): void {
	if (_started) return;
	// biome-ignore lint/style/noProcessEnv: startup gate, before the config framework
	if (process.env.APP_ENV === "test" || process.env.VITEST === "true") return;
	_started = true;
	void attemptReconcile(1);
}

async function attemptReconcile(attempt: number): Promise<void> {
	try {
		// Dynamic import: the job statically imports getContainer, so a static edge would cycle.
		const { runGovernanceSchedulesSyncJob } = await import(
			"@/bootstrap/jobs/syncGovernanceSchedules.job"
		);
		await runGovernanceSchedulesSyncJob();
	} catch {
		if (attempt < MAX_ATTEMPTS) {
			setTimeout(() => void attemptReconcile(attempt + 1), RETRY_DELAY_MS);
		}
	}
}
