/**
 * Daemon-wide cap for non-run agent invocations (triage, plan iteration,
 * audit iteration, feedback). Bound to the live FactoryConfig at boot, so
 * mutations through the settings store automatically take effect on the
 * next call without re-binding.
 *
 * 0 = unlimited (matches running `claude` directly). Per-call overrides
 * (e.g. audit comments' explicit 120s) still win over this default.
 */

let configRef: { agentBudgetSeconds: number } = { agentBudgetSeconds: 0 };

export function bindAgentBudgetConfig(ref: { agentBudgetSeconds: number }): void {
  configRef = ref;
}

export function getAgentBudgetSeconds(): number {
  return configRef.agentBudgetSeconds;
}
