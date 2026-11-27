// AI prompt builder for the Teachers Hub. Turns one lesson skeleton and the placed student's
// details into a prompt. The tutor pastes it into an AI tool to get a presentation for that lesson.
// Expects window.PB_PHASES (stage order, stage labels, phase rules) set by the page.
(function () {
  function label(key) {
    var words = key.replace(/([A-Z])/g, " $1").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  function text(v) {
    return Array.isArray(v) ? v.join(" | ") : String(v);
  }

  function studentLines(details, scores) {
    if (!details) {
      return ["- No student details were entered. Keep the examples general and suitable for an adult learner."];
    }
    var goals = (details.goals || []).slice();
    if (details.otherGoals) goals.push(details.otherGoals);
    var lines = [
      "- Name: " + (details.name || "not entered"),
      "- Age: " + (details.age || "not entered"),
      "- Employment: " + ([details.employment, details.job].filter(Boolean).join(", ") || "not entered"),
      "- Learning goals: " + (goals.join("; ") || "not entered")
    ];
    if (scores) {
      lines.push("- Placement scores, 1 to 4 (conversation, grammar, listening): " + scores.conv + ", " + scores.theory + ", " + scores.comp);
    }
    return lines;
  }

  function skeletonLines(skeleton, phases) {
    var lines = [];
    var total = 0;
    phases.stageOrder.forEach(function (name, i) {
      var stage = skeleton.stages[name];
      if (!stage) return;
      total += stage.minutes || 0;
      lines.push((i + 1) + ". " + phases.stageLabels[name].replace(/^\d+\.\s*/, "") + " (" + stage.minutes + " min)");
      Object.keys(stage).forEach(function (key) {
        if (key === "minutes") return;
        lines.push("   " + label(key) + ": " + text(stage[key]));
      });
    });
    lines.push("Total: " + total + " minutes.");
    return lines;
  }

  function phaseLines(skeleton, phases) {
    var rule = phases.phases[skeleton.phase];
    if (!rule) return [];
    var lines = [
      "- Phase mandate: " + rule.mandate,
      "- Timing: " + rule.balance.replace(/^Skeleton timing:\s*/, "")
    ];
    if (rule.checklist && rule.checklist.length) {
      lines.push("- The lesson must meet this checklist:");
      rule.checklist.forEach(function (item) { lines.push("  - " + item); });
    }
    return lines;
  }

  // skeleton: one class from window.PB_SKELETONS. details: the placed student, or null.
  // scores: { conv, theory, comp } from the placement, or null.
  function build(skeleton, details, scores) {
    var phases = window.PB_PHASES;
    var parts = [];
    parts.push("You are helping an English tutor at Global Key prepare one 30-minute one-to-one online lesson. " +
      "Create a presentation that the tutor can share on screen and use to run the lesson.");
    parts.push("");
    parts.push("STUDENT");
    parts = parts.concat(studentLines(details, scores));
    parts.push("");
    parts.push("LESSON");
    parts.push("- Class: " + skeleton.id + ": " + skeleton.title);
    parts.push("- CEFR level: " + skeleton.cefr);
    parts.push("- Class goal: " + skeleton.goal);
    parts.push("- Can-do statement: " + skeleton.canDo);
    parts.push("");
    parts.push("LESSON SKELETON (use these stages, timings, and material; do not add stages)");
    parts = parts.concat(skeletonLines(skeleton, phases));
    parts.push("");
    parts.push("LEVEL RULES (" + skeleton.phase + ")");
    parts = parts.concat(phaseLines(skeleton, phases));
    parts.push("");
    parts.push("WHAT TO PRODUCE");
    parts.push("A presentation of exactly 10 slides, in this order:");
    parts.push("1. Title slide");
    parts.push("2. Lesson goal and can-do statement");
    parts.push("3. Warm-up");
    parts.push("4. Theory: structure and examples");
    parts.push("5. Theory: practice with the student's own content");
    parts.push("6. Comprehension: the text and the fact questions");
    parts.push("7. Comprehension: the tone and inference questions");
    parts.push("8. Conversation: the task and the phrases to use");
    parts.push("9. Conversation: the challenge or follow-up questions");
    parts.push("10. Wrap-up: common mistakes and feedback");
    parts.push("For each slide give:");
    parts.push("- Slide title");
    parts.push("- On-screen text: short, in English at the class CEFR level. Include the phrases, structures, and example sentences the student needs.");
    parts.push("- Tutor notes: what the tutor says or does, the timing, and the answer to any check question.");
    parts.push("");
    parts.push("RULES");
    parts.push("- Follow the stages, timings, and material in the skeleton. Do not add a new stage or change the minutes.");
    parts.push("- Use the student's job and goals for the examples and the conversation task where they fit. If no details were given, use general business and everyday examples.");
    parts.push("- Use the student's age only to keep examples suitable. Do not put the student's name, age, or other personal details on the slides.");
    parts.push("- Use no grammar or vocabulary above the class level.");
    parts.push("- End with a short list of anything the tutor should check or adapt before the lesson.");
    return parts.join("\n");
  }

  window.AiPrompt = { build: build };
})();
