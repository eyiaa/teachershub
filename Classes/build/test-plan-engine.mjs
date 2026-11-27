// Tests for the plan engine, run against the real lesson data.
// Usage: node build/test-plan-engine.mjs

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadClasses, loadTopicsByClass, toCatalogue } from "./catalogue.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const Engine = require("./plan-engine.js");

const catalogue = toCatalogue(loadClasses(root), loadTopicsByClass(root));
const ids = (plan) => plan.items.map((c) => c.id);

const tests = [
  [
    "Spark from class 1: sixteen core classes in order",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark", startNumber: 1 });
      assert.deepEqual(ids(plan), Array.from({ length: 16 }, (_, i) => `SPARK-${String(i + 1).padStart(2, "0")}`));
      assert.deepEqual(plan.warnings, []);
    },
  ],
  [
    "Spark from class 4: starts at SPARK-04",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark", startNumber: 4 });
      assert.equal(plan.items[0].id, "SPARK-04");
      assert.equal(plan.items.length, 13);
    },
  ],
  [
    "Flow core only: ten core classes, no bridge",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Flow" });
      assert.equal(plan.items.length, 10);
      assert.ok(plan.items.every((c) => c.number <= 10));
    },
  ],
  [
    "Flow with bridge and readiness: 11 to 39, then the readiness check last",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Flow", bridge: true, readiness: true });
      assert.equal(plan.items.length, 40);
      assert.equal(plan.items[10].id, "FLOW-11");
      assert.equal(plan.items[39].id, "FLOW-40");
      assert.ok(Engine.isReadiness(plan.items[39]));
    },
  ],
  [
    "Drive with bridge and readiness: ends with DRIVE-46",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Drive", bridge: true, readiness: true });
      assert.equal(plan.items.at(-1).id, "DRIVE-46");
      assert.equal(plan.items.length, 46);
    },
  ],
  [
    "Topic request adds only the bridge classes that cover it",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Flow", topics: ["Conditionals"] });
      const got = ids(plan);
      assert.ok(got.includes("FLOW-32"), "FLOW-32 is a first conditional bridge class");
      assert.ok(got.includes("FLOW-03"), "FLOW-03 is a core conditional class");
      assert.ok(!got.includes("FLOW-11"), "FLOW-11 has no conditionals tag");
    },
  ],
  [
    "Parallel pathway: pathway classes are spread through the core sequence",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, {
        level: "Flow",
        pathways: ["Job Interviews"],
        mode: "parallel",
      });
      assert.equal(plan.items.length, 15);
      const kinds = plan.items.map((c) => Engine.kindOf(c));
      const first = kinds.indexOf("pathway");
      const last = kinds.lastIndexOf("pathway");
      assert.ok(first > 0, "pathway does not start the plan");
      assert.ok(last < plan.items.length - 1, "pathway does not end the plan");
      // Pathway classes keep their own order.
      const pathwayIds = plan.items.filter((c) => c.pathway).map((c) => c.id);
      assert.deepEqual(pathwayIds, ["INTERVIEW-01", "INTERVIEW-02", "INTERVIEW-03", "INTERVIEW-04", "INTERVIEW-05"]);
    },
  ],
  [
    "Block pathway: the selected blocks come first, in the order chosen",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, {
        level: "Drive",
        pathways: ["Fluency", "Presentation Skills"],
        mode: "blocks",
      });
      const got = ids(plan);
      assert.deepEqual(got.slice(0, 4), ["DRIVE-FLUENCY-01", "DRIVE-FLUENCY-02", "DRIVE-FLUENCY-03", "DRIVE-FLUENCY-04"]);
      assert.deepEqual(got.slice(4, 8), [
        "DRIVE-PRESENTATION-01",
        "DRIVE-PRESENTATION-02",
        "DRIVE-PRESENTATION-03",
        "DRIVE-PRESENTATION-04",
      ]);
      assert.equal(got[8], "DRIVE-01");
      assert.equal(plan.items.length, 18);
    },
  ],
  [
    "Spark pathway uses Spark classes only",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark", pathways: ["Fluency"], mode: "blocks" });
      assert.ok(plan.items.every((c) => c.phase === "Spark"));
      assert.equal(plan.items[0].id, "SPARK-FLUENCY-01");
    },
  ],
  [
    "Readiness requested for Spark: warns, because Spark has no readiness check",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark", readiness: true });
      assert.deepEqual(plan.warnings, ["Spark has no readiness check."]);
      assert.equal(plan.items.length, 16);
    },
  ],
  [
    "Weeks split at the chosen rate",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark" });
      const weeks = Engine.splitWeeks(plan.items, 2);
      assert.equal(weeks.length, 8);
      assert.equal(weeks[4].items.length, 2);
      assert.equal(Engine.splitWeeks(plan.items, 3).length, 6);
    },
  ],
  [
    "Plain text export lists each week and class",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark" });
      const text = Engine.planAsText("Test", plan.items.slice(0, 2), 2);
      assert.match(text, /^Test/);
      assert.match(text, /Week 1/);
      assert.match(text, /SPARK-01/);
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failed} of ${tests.length} plan engine tests passed.`);
if (failed > 0) process.exit(1);
