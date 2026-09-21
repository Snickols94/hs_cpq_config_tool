// Quick manual sanity check. Run with: npx tsx convex/lib/configEngine.test.ts
import { evaluate, Rule } from "./configEngine";

const options = ["4k_display", "premium_gpu", "integrated_gpu", "compact_case"];

const rules: Rule[] = [
  { type: "requires", whenOptionId: "4k_display", thenOptionId: "premium_gpu" },
  {
    type: "excludes",
    whenOptionId: "premium_gpu",
    thenOptionId: "integrated_gpu",
  },
];

// User selects the 4K display. Engine should: require premium_gpu.
const result = evaluate(options, ["4k_display"], rules);
console.log("Statuses:", result.statuses);
console.log("Violations:", result.violations);
// Test 2: select two things that exclude each other → expect a violation.
console.log("\n--- Test 2: conflicting selection ---");
const conflict = evaluate(
  options,
  ["premium_gpu", "integrated_gpu"], // both selected — illegal
  rules,
);
console.log("Statuses:", conflict.statuses);
console.log("Violations:", conflict.violations);
// Test 3: order-independence. Same selections, reversed order → identical result.
console.log("\n--- Test 3: order independence ---");
const orderA = evaluate(options, ["4k_display", "premium_gpu"], rules);
const orderB = evaluate(options, ["premium_gpu", "4k_display"], rules);
console.log(
  "Same result regardless of order:",
  JSON.stringify(orderA.statuses) === JSON.stringify(orderB.statuses),
);
