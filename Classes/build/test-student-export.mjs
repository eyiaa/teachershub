// Tests for the student document: it must show the plan clearly and never show tutor-only content.
// Usage: node build/test-student-export.mjs

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadClasses, loadTopicsByClass, toCatalogue, toStudentCatalogue } from "./catalogue.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const Engine = require("./plan-engine.js");
const Export = require("./student-export.js");

const classes = loadClasses(root);
const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
const studentCatalogue = toStudentCatalogue(classes);
const catalogue = toCatalogue(classes, loadTopicsByClass(root));

// Text that only the tutor should see, taken from the full class files.
function tutorOnlyTexts(cls) {
  const s = cls.stages;
  return [
    s.theory.checkQuestion,
    s.comprehension.factCheck,
    s.comprehension.toneCheck,
    s.conversation.mandate,
    ...s.wrapup.mistakes,
    ...s.warmup.tutorAction ? [s.warmup.tutorAction] : [],
  ];
}

const ALLOWED_KEYS = [
  "id", "phase", "number", "pathway", "cefr", "title", "canDo", "goal", "minutes", "structure", "phrases",
].sort();

const tests = [
  [
    "Student catalogue holds only student-visible fields",
    () => {
      for (const entry of Object.values(studentCatalogue)) {
        assert.deepEqual(Object.keys(entry).sort(), ALLOWED_KEYS, entry.id);
      }
    },
  ],
  [
    "Student document has the company name, the student, and one section per session",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, {
        level: "Flow",
        pathways: ["Job Interviews"],
        mode: "parallel",
        readiness: true,
        bridge: true,
      });
      const items = plan.items.map((c) => studentCatalogue[c.id]);
      const html = Export.buildStudentHtml(items, { student: "Angy Rodriguez", tutor: "Ms Lee", date: "17 October 2026" });
      assert.match(html, /GLOBAL KEY/);
      assert.match(html, /Angy Rodriguez/);
      assert.equal((html.match(/class="session"/g) || []).length, items.length);
      assert.match(html, /Focus pathway: Job Interviews/);
      assert.match(html, /Readiness check/);
    },
  ],
  [
    "Student document never shows tutor-only content for any class in the plan",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, {
        level: "Drive",
        pathways: ["Fluency", "Presentation Skills", "Job Interviews"],
        mode: "blocks",
        bridge: true,
        readiness: true,
      });
      const items = plan.items.map((c) => studentCatalogue[c.id]);
      const html = Export.buildStudentHtml(items, { student: "Test", tutor: "Tutor", date: "" });
      assert.ok(!html.includes("Tutor checklist"), "no tutor checklist");
      assert.ok(!html.includes("Self-correction"), "no self-correction prompts");
      assert.ok(!html.includes("Ask:"), "no tutor questions");
      for (const item of plan.items) {
        for (const text of tutorOnlyTexts(byId[item.id])) {
          if (!text) continue;
          assert.ok(!html.includes(text), `${item.id} leaks tutor text: ${text.slice(0, 50)}`);
        }
      }
    },
  ],
  [
    "Student names and text are escaped",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark" });
      const items = plan.items.map((c) => studentCatalogue[c.id]);
      const html = Export.buildStudentHtml(items, { student: "<b>Injected</b>", tutor: "", date: "" });
      assert.ok(!html.includes("<b>Injected</b>"));
      assert.match(html, /&lt;b&gt;Injected&lt;\/b&gt;/);
    },
  ],
  [
    "Core-only plan lists the core course as the priority",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark" });
      const items = plan.items.map((c) => studentCatalogue[c.id]);
      const html = Export.buildStudentHtml(items, { student: "A", tutor: "", date: "" });
      assert.match(html, /Core course: Spark/);
    },
  ],
  [
    "Total minutes match 30 minutes per session",
    () => {
      const plan = Engine.buildSuggestedPlan(catalogue, { level: "Spark" });
      const items = plan.items.map((c) => studentCatalogue[c.id]);
      const html = Export.buildStudentHtml(items, { student: "A", tutor: "", date: "" });
      assert.match(html, new RegExp(`${items.length} \\(${items.length * 30} minutes in total\\)`));
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
console.log(`\n${tests.length - failed} of ${tests.length} student document tests passed.`);
if (failed > 0) process.exit(1);
