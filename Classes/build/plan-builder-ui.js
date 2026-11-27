// Plan Builder behaviour for the Teachers Hub. Expects window.PB_CATALOGUE (set by the page)
// and window.PlanEngine (plan-engine.js, loaded first). Plans are saved in this browser only.
(function () {
  var catalogue = window.PB_CATALOGUE || [];
  var Engine = window.PlanEngine;
  var STORAGE_KEY = "globalkey.plans";
  var byId = {};
  catalogue.forEach(function (c) { byId[c.id] = c; });

  var plan = [];          // the plan as an ordered list of class IDs
  var perWeek = 2;        // classes per week, used for the week table and the copy text
  var planName = "";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function link(c) {
    return (c.phase === "Spark" ? "spark" : c.phase === "Flow" ? "flow" : "drive") + "/" + c.id + ".html";
  }
  function kindLabel(c) {
    var k = Engine.kindOf(c);
    if (k === "core") return "Core";
    if (k === "bridge") return "Bridge";
    if (k === "readiness") return "Readiness check";
    return "Pathway: " + c.pathway;
  }
  function planItems() {
    return plan.map(function (id) { return byId[id]; }).filter(Boolean);
  }

  // ----- Suggest a plan -----

  function selectedValues(name) {
    var boxes = document.querySelectorAll('input[name="' + name + '"]:checked');
    return Array.prototype.map.call(boxes, function (b) { return b.value; });
  }

  function generate() {
    var level = $("pb-level").value;
    var start = parseInt($("pb-start").value, 10) || 1;
    var result = Engine.buildSuggestedPlan(catalogue, {
      level: level,
      startNumber: start,
      pathways: selectedValues("pb-pathway"),
      topics: Array.prototype.map.call($("pb-topics").selectedOptions, function (o) { return o.value; }),
      bridge: $("pb-bridge").checked,
      readiness: $("pb-readiness").checked,
      mode: $("pb-mode").value,
    });
    plan = result.items.map(function (c) { return c.id; });
    perWeek = parseInt($("pb-perweek").value, 10) || 2;
    $("pb-perweek-out").value = String(perWeek);
    $("pb-warn").innerHTML = result.warnings.length
      ? result.warnings.map(function (w) { return '<p class="warn">' + esc(w) + "</p>"; }).join("")
      : (plan.length ? '<p class="note">Plan created with ' + plan.length + " classes. You can adjust it below.</p>" : "");
    $("pb-warn").hidden = false;
    renderPlan();
  }

  // ----- Build manually -----

  function filteredCatalogue() {
    var words = $("pb-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var level = $("pb-filter-level").value;
    return catalogue.filter(function (c) {
      if (level && c.phase !== level) return false;
      var text = [c.id, c.title, c.phase, c.cefr, c.pathway || "Core"].concat(c.topics).join(" ").toLowerCase();
      return words.every(function (w) { return text.indexOf(w) !== -1; });
    });
  }

  function renderResults() {
    var list = filteredCatalogue();
    $("pb-results-count").textContent = "Showing " + list.length + " classes";
    $("pb-results").innerHTML = list.map(function (c) {
      return '<tr><td><a href="' + link(c) + '" target="_blank" rel="noopener">' + esc(c.id) + "</a></td>" +
        "<td>" + esc(c.phase) + "</td><td>" + esc(c.cefr) + "</td><td>" + esc(c.title) + "</td>" +
        '<td><button type="button" class="pb-btn" data-add="' + esc(c.id) + '">Add</button></td></tr>';
    }).join("");
  }

  // ----- Plan output -----

  function renderPlan() {
    var items = planItems();
    var body = $("pb-plan");
    if (items.length === 0) {
      body.innerHTML = '<p class="lead">No classes in this plan yet. Use Suggest a plan, or add classes from the list.</p>';
      $("pb-count").textContent = "";
      return;
    }
    var weeks = Engine.splitWeeks(items, perWeek);
    var index = 0;
    var rows = weeks.map(function (w) {
      var head = '<tr class="pb-week"><td colspan="6">Week ' + w.week + "</td></tr>";
      var lines = w.items.map(function (c) {
        var i = index++;
        return "<tr><td>" + (i + 1) + '</td><td><a href="' + link(c) + '">' + esc(c.id) + "</a></td>" +
          "<td>" + esc(c.title) + "</td><td>" + esc(c.cefr) + "</td><td>" + esc(kindLabel(c)) + "</td>" +
          '<td class="no-print">' +
          '<button type="button" class="pb-btn" data-up="' + i + '" title="Move up">&uarr;</button> ' +
          '<button type="button" class="pb-btn" data-down="' + i + '" title="Move down">&darr;</button> ' +
          '<button type="button" class="pb-btn" data-remove="' + i + '">Remove</button> ' +
          '<button type="button" class="pb-btn" data-prompt="' + i + '">AI prompt</button></td></tr>';
      });
      return head + lines.join("");
    }).join("");
    body.innerHTML = '<table class="grid"><tr><th>#</th><th>Class</th><th>Title</th><th>CEFR</th><th>Type</th><th class="no-print">Change</th></tr>' + rows + "</table>";
    $("pb-count").textContent = items.length + " classes over " + weeks.length + " weeks, " + perWeek + " per week";
  }

  function addClass(id) {
    if (plan.indexOf(id) !== -1) {
      $("pb-warn").innerHTML = '<p class="warn">' + esc(id) + " is already in the plan.</p>";
      $("pb-warn").hidden = false;
      return;
    }
    plan.push(id);
    renderPlan();
  }

  function move(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= plan.length) return;
    var tmp = plan[i];
    plan[i] = plan[j];
    plan[j] = tmp;
    renderPlan();
  }

  // ----- AI prompt for one lesson -----

  function readPlacement() {
    try {
      return JSON.parse(localStorage.getItem("globalkey.placement") || "null");
    } catch (e) {
      return null;
    }
  }

  function showPrompt(i) {
    var item = planItems()[i];
    var skeleton = window.PB_SKELETONS && item ? window.PB_SKELETONS[item.id] : null;
    if (!skeleton || !window.AiPrompt) {
      $("pb-prompt-status").textContent = "The prompt tool did not load. Reload the page.";
      return;
    }
    var placed = readPlacement();
    var details = placed && placed.details ? placed.details : null;
    var scores = placed && placed.scores ? placed.scores : null;
    if (!details && $("pb-student").value.trim()) {
      details = { name: $("pb-student").value.trim() };
    }
    $("pb-prompt-text").value = window.AiPrompt.build(skeleton, details, scores);
    $("pb-prompt-info").textContent = "For " + skeleton.id + ": " + skeleton.title + (details && details.name ? " (" + details.name + ")" : "");
    $("pb-prompt-status").textContent = "";
    $("pb-prompt").hidden = false;
    $("pb-prompt").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function copyPrompt() {
    var text = $("pb-prompt-text").value;
    var status = $("pb-prompt-status");
    var done = function () { status.textContent = "Prompt copied."; };
    var fail = function () {
      $("pb-prompt-text").select();
      status.textContent = "Copy failed. The text is selected, so copy it manually.";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      $("pb-prompt-text").select();
      try { document.execCommand("copy"); done(); } catch (e) { fail(); }
    }
  }

  // ----- Copy, print, save -----

  function planText() {
    return Engine.planAsText(planName || "Student plan", planItems(), perWeek);
  }

  function copyPlan() {
    var text = planText();
    var done = function () { $("pb-status").textContent = "Plan copied. Paste it into Google Docs."; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (e) { $("pb-status").textContent = "Copy failed. Select the plan and copy it manually."; }
    document.body.removeChild(area);
  }

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function writeSaved(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function savePlan() {
    if (plan.length === 0) {
      $("pb-status").textContent = "Add classes before saving.";
      return;
    }
    var name = $("pb-name").value.trim() || ("Plan " + new Date().toLocaleDateString());
    var list = readSaved().filter(function (p) { return p.name !== name; });
    list.unshift({ name: name, perWeek: perWeek, ids: plan.slice(), savedAt: new Date().toISOString() });
    if (writeSaved(list)) {
      planName = name;
      $("pb-name").value = name;
      $("pb-status").textContent = 'Saved as "' + name + '" in this browser.';
      renderSaved();
    } else {
      $("pb-status").textContent = "This browser would not save the plan. Copy it instead.";
    }
  }

  function renderSaved() {
    var list = readSaved();
    var box = $("pb-saved");
    if (list.length === 0) {
      box.innerHTML = '<p class="lead">No saved plans in this browser yet.</p>';
      return;
    }
    box.innerHTML = '<table class="grid"><tr><th>Name</th><th>Classes</th><th>Saved</th><th></th></tr>' +
      list.map(function (p, i) {
        return "<tr><td>" + esc(p.name) + "</td><td>" + p.ids.length + "</td><td>" +
          esc(new Date(p.savedAt).toLocaleString()) + '</td><td class="no-print">' +
          '<button type="button" class="pb-btn" data-load="' + i + '">Open</button> ' +
          '<button type="button" class="pb-btn" data-delete="' + i + '">Delete</button></td></tr>';
      }).join("") + "</table>";
  }

  function openSaved(i) {
    var p = readSaved()[i];
    if (!p) return;
    plan = p.ids.slice();
    perWeek = p.perWeek || 2;
    planName = p.name;
    $("pb-name").value = p.name;
    $("pb-perweek-out").value = String(perWeek);
    renderPlan();
    $("pb-status").textContent = 'Opened "' + p.name + '".';
  }

  function deleteSaved(i) {
    var list = readSaved();
    if (!list[i]) return;
    var name = list[i].name;
    list.splice(i, 1);
    writeSaved(list);
    renderSaved();
    $("pb-status").textContent = 'Deleted "' + name + '".';
  }

  // ----- Student document -----

  function longDate(iso) {
    var p = iso.split("-");
    if (p.length !== 3) return iso;
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  function exportStudent() {
    var status = $("pb-status");
    if (!window.StudentExport || !window.PB_STUDENT) {
      status.textContent = "The student document tool did not load. Reload the page.";
      return;
    }
    var items = planItems();
    if (items.length === 0) {
      status.textContent = "Add classes to the plan before exporting.";
      return;
    }
    var student = $("pb-student").value.trim();
    if (!student) {
      status.textContent = "Enter the student's name.";
      return;
    }
    var studentItems = items
      .map(function (c) { return window.PB_STUDENT[c.id]; })
      .filter(Boolean);
    var html = window.StudentExport.buildStudentHtml(studentItems, {
      student: student,
      tutor: $("pb-tutor").value.trim(),
      date: $("pb-date").value ? longDate($("pb-date").value) : "",
    });
    var win = window.open("", "_blank");
    if (!win) {
      status.textContent = "Allow pop-ups for this page to open the document.";
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    status.textContent = "The document opened in a new tab. Use Print, then Save as PDF.";
  }

  // ----- Wiring -----

  function setupTopics() {
    var topics = {};
    catalogue.forEach(function (c) { c.topics.forEach(function (t) { topics[t] = true; }); });
    $("pb-topics").innerHTML = Object.keys(topics).sort().map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + "</option>";
    }).join("");
  }

  function setupLevelStart() {
    var level = $("pb-level");
    var start = $("pb-start");
    var max = { Spark: 16, Flow: 40, Drive: 46 };
    var sync = function () {
      var m = max[level.value] || 10;
      start.max = String(m);
      if (parseInt(start.value, 10) > m) start.value = "1";
    };
    level.addEventListener("change", sync);
    sync();
  }

  function init() {
    if (!$("panel-plan")) return;
    setupTopics();
    setupLevelStart();
    renderResults();
    renderPlan();
    renderSaved();

    $("pb-generate").addEventListener("click", generate);
    $("pb-search").addEventListener("input", renderResults);
    $("pb-filter-level").addEventListener("change", renderResults);
    $("pb-perweek-out").addEventListener("change", function () {
      perWeek = parseInt($("pb-perweek-out").value, 10) || 2;
      renderPlan();
    });
    $("pb-copy").addEventListener("click", copyPlan);
    $("pb-print").addEventListener("click", function () { window.print(); });
    $("pb-save").addEventListener("click", savePlan);
    $("pb-clear").addEventListener("click", function () {
      plan = [];
      planName = "";
      $("pb-name").value = "";
      renderPlan();
      $("pb-status").textContent = "Plan cleared.";
    });
    $("pb-name").addEventListener("input", function () { planName = $("pb-name").value.trim(); });
    $("pb-export").addEventListener("click", exportStudent);
    $("pb-prompt-copy").addEventListener("click", copyPrompt);
    var today = new Date();
    $("pb-date").value = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute("data-add")) addClass(t.getAttribute("data-add"));
      if (t.getAttribute("data-up") !== null) move(parseInt(t.getAttribute("data-up"), 10), -1);
      if (t.getAttribute("data-down") !== null) move(parseInt(t.getAttribute("data-down"), 10), 1);
      if (t.getAttribute("data-remove") !== null) {
        plan.splice(parseInt(t.getAttribute("data-remove"), 10), 1);
        renderPlan();
      }
      if (t.getAttribute("data-prompt") !== null) showPrompt(parseInt(t.getAttribute("data-prompt"), 10));
      if (t.getAttribute("data-load") !== null) openSaved(parseInt(t.getAttribute("data-load"), 10));
      if (t.getAttribute("data-delete") !== null) deleteSaved(parseInt(t.getAttribute("data-delete"), 10));
    });
  }

  init();
})();
