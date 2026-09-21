// convex/lib/configEngine.ts
// PURE constraint engine. No database, no Convex. Just logic.
// This is the reusable core — testable on its own.

export type RuleType =
  "requires" | "excludes" | "requiresOneOf" | "impliesValue";

export interface Rule {
  type: RuleType;
  whenOptionId: string;
  thenOptionId?: string; // requires / excludes / impliesValue
  thenOptionIds?: string[]; // requiresOneOf
}

// Each option ends up in exactly one of these states.
export type OptionStatus =
  | "available" // can be chosen
  | "selected" // user chose it
  | "disabled" // a rule forbids it given current selections
  | "required"; // a rule forces it given current selections

export interface EvaluationResult {
  statuses: Record<string, OptionStatus>; // optionId -> status
  violations: string[]; // human-readable rule problems
}

export function evaluate(
  allOptionIds: string[],
  selectedIds: string[],
  rules: Rule[],
): EvaluationResult {
  const statuses: Record<string, OptionStatus> = {};
  const violations: string[] = [];

  // Start: everything available, then mark selections.
  for (const id of allOptionIds) statuses[id] = "available";
  for (const id of selectedIds) statuses[id] = "selected";

  const isSelected = (id: string) => selectedIds.includes(id);

  // Propagation loop: re-apply all rules until nothing changes.
  // This is what makes the engine order-independent and handles rule chains.
  let changed = true;
  let guard = 0;
  while (changed && guard < 1000) {
    changed = false;
    guard++;

    for (const rule of rules) {
      // --- EXCLUDES: symmetric. A conflict is mutual regardless of which
      // side the rule was authored on. Selecting EITHER option disables the
      // other; selecting BOTH is a violation. Handled before the when-guard
      // below because it must fire in both directions.
      if (rule.type === "excludes" && rule.thenOptionId) {
        const a = rule.whenOptionId;
        const b = rule.thenOptionId;

        if (isSelected(a) && isSelected(b)) {
          const msg = `Conflict: ${a} and ${b} cannot be selected together.`;
          if (!violations.includes(msg)) {
            violations.push(msg);
            changed = true;
          }
        } else if (isSelected(a) && statuses[b] !== "disabled") {
          statuses[b] = "disabled";
          changed = true;
        } else if (isSelected(b) && statuses[a] !== "disabled") {
          statuses[a] = "disabled";
          changed = true;
        }
        continue; // excludes fully handled; skip the when-guard logic below
      }

      // All other rule types only fire when their trigger is selected.
      if (!isSelected(rule.whenOptionId)) continue;

      if (rule.type === "requires" && rule.thenOptionId) {
        const target = rule.thenOptionId;
        if (!isSelected(target) && statuses[target] !== "required") {
          statuses[target] = "required";
          changed = true;
        }
      }

      if (rule.type === "requiresOneOf" && rule.thenOptionIds) {
        const anySelected = rule.thenOptionIds.some(isSelected);
        if (!anySelected) {
          const msg = `Requirement: ${rule.whenOptionId} requires one of [${rule.thenOptionIds.join(", ")}].`;
          if (!violations.includes(msg)) {
            violations.push(msg);
            changed = true;
          }
        }
      }

      if (rule.type === "impliesValue" && rule.thenOptionId) {
        const target = rule.thenOptionId;
        if (!isSelected(target) && statuses[target] !== "required") {
          statuses[target] = "required";
          changed = true;
        }
      }
    }
  }

  return { statuses, violations };
}
