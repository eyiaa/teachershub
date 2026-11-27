// Shared data helpers: load the lesson classes and build the small catalogue used by the
// Plan Builder (both on the Teachers Hub and in the tests).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadClasses(root) {
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(dataDir, f), "utf8")));
}

export function loadTopicsByClass(root) {
  return JSON.parse(readFileSync(join(root, "spec", "topics.json"), "utf8")).classes;
}

// Student-facing fields only. Anything a tutor uses (answer keys, check questions, fact checks,
// mandates, mistakes to correct) is left out by construction, so it cannot reach the student export.
export function toStudentCatalogue(classes) {
  const out = {};
  for (const c of classes) {
    out[c.id] = {
      id: c.id,
      phase: c.phase,
      number: c.number,
      pathway: c.pathway ?? null,
      cefr: c.cefr,
      title: c.title,
      canDo: c.canDo,
      goal: c.goal,
      minutes: {
        warmup: c.stages.warmup.minutes,
        theory: c.stages.theory.minutes,
        comprehension: c.stages.comprehension.minutes,
        conversation: c.stages.conversation.minutes,
        wrapup: c.stages.wrapup.minutes,
      },
      structure: c.stages.theory.structure,
      phrases: c.stages.conversation.phrases ?? [],
    };
  }
  return out;
}

// The fields the Plan Builder needs. Full lesson content stays out of the hub page.
export function toCatalogue(classes, topicsByClass) {
  return classes
    .map((c) => ({
      id: c.id,
      phase: c.phase,
      number: c.number,
      pathway: c.pathway ?? null,
      cefr: c.cefr,
      title: c.title,
      topics: topicsByClass[c.id] ?? [],
    }))
    .sort((a, b) => a.phase.localeCompare(b.phase) || a.number - b.number);
}
