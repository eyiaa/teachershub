// Curriculum plan engine. Plain JavaScript with no dependencies: it runs in the browser
// (as window.PlanEngine) and in Node (as module.exports) so it can be tested.
//
// Rules:
//   Core classes are numbers 1 to CORE_LAST of the level (Spark 16, Flow and Drive 10), in order,
//     starting at the chosen class.
//   Bridge classes (numbers after the core, not the readiness check) are added when the bridge option
//     is on, or when they cover a requested grammar topic.
//   The readiness check (title contains "Readiness") goes at the end, when requested.
//   Pathway classes come from each selected pathway, in their own order. Two formats:
//     parallel: pathway classes are spaced evenly through the core sequence.
//     blocks:   each pathway runs as a block, in the order selected, before the core sequence.

(function (root) {
  // The last core class number in each level. Classes after it are bridge classes.
  var CORE_LAST = { Spark: 16, Flow: 10, Drive: 10 };

  function coreLast(phase) {
    return CORE_LAST[phase] || 10;
  }

  function isReadiness(c) {
    return /readiness/i.test(c.title || "");
  }

  function kindOf(c) {
    if (c.pathway) return "pathway";
    if (isReadiness(c)) return "readiness";
    return c.number <= coreLast(c.phase) ? "core" : "bridge";
  }

  function byNumber(a, b) {
    return a.number - b.number;
  }

  function intersects(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (b.indexOf(a[i]) !== -1) return true;
    }
    return false;
  }

  // Spread the extra items evenly through the base sequence.
  function interleave(base, extra) {
    var result = base.slice();
    var n = extra.length;
    var m = base.length;
    if (n === 0) return result;
    if (m === 0) return extra.slice();
    var positions = [];
    for (var j = 0; j < n; j++) {
      positions.push(Math.round(((j + 1) * (m + 1)) / (n + 1)));
    }
    // Insert from the last position backwards, so earlier positions stay valid.
    for (var k = n - 1; k >= 0; k--) {
      var pos = Math.min(Math.max(positions[k], 1), m);
      result.splice(pos, 0, extra[k]);
    }
    return result;
  }

  // opts: { level, startNumber, pathways[], topics[], bridge, readiness, mode }
  function buildSuggestedPlan(catalogue, opts) {
    opts = opts || {};
    var warnings = [];
    var level = opts.level;
    if (!level) {
      return { items: [], warnings: ["Choose a level first."] };
    }
    var start = opts.startNumber || 1;
    var topics = opts.topics || [];
    var levelClasses = catalogue.filter(function (c) {
      return c.phase === level;
    });

    var base = levelClasses
      .filter(function (c) {
        if (c.pathway || isReadiness(c) || c.number < start) return false;
        if (c.number <= coreLast(level)) return true;
        if (opts.bridge) return true;
        return topics.length > 0 && intersects(c.topics || [], topics);
      })
      .sort(byNumber);

    var readiness = [];
    if (opts.readiness) {
      readiness = levelClasses.filter(isReadiness);
      if (readiness.length === 0) warnings.push(level + " has no readiness check.");
    }

    var pathwayItems = [];
    (opts.pathways || []).forEach(function (name) {
      var list = levelClasses
        .filter(function (c) {
          return c.pathway === name;
        })
        .sort(byNumber);
      if (list.length === 0) warnings.push(name + " has no " + level + " classes yet.");
      pathwayItems = pathwayItems.concat(list);
    });

    var seq;
    if ((opts.mode || "parallel") === "blocks") {
      seq = pathwayItems.concat(base);
    } else {
      seq = interleave(base, pathwayItems);
    }
    seq = seq.concat(readiness);

    return { items: seq, warnings: warnings };
  }

  function splitWeeks(items, perWeek) {
    var n = Math.max(1, perWeek || 2);
    var weeks = [];
    for (var i = 0; i < items.length; i += n) {
      weeks.push({ week: weeks.length + 1, items: items.slice(i, i + n) });
    }
    return weeks;
  }

  function planAsText(title, items, perWeek) {
    var lines = [title || "Student plan", ""];
    splitWeeks(items, perWeek).forEach(function (w) {
      lines.push("Week " + w.week);
      w.items.forEach(function (c) {
        lines.push("  " + c.id + "  " + c.title + " (" + c.cefr + ")");
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  var api = {
    buildSuggestedPlan: buildSuggestedPlan,
    splitWeeks: splitWeeks,
    planAsText: planAsText,
    kindOf: kindOf,
    isReadiness: isReadiness,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PlanEngine = api;
  }
})(typeof window !== "undefined" ? window : this);
