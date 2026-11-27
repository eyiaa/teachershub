// Validates lesson-class JSON files against spec/phases.json and spec/topics.json,
// renders each valid class to HTML (copy-paste into Google Docs), and builds:
//   out/index.html          Teachers Hub: "Classes" tab (search, filter, and each level's Core
//                           and Focus pathway dropdowns) and "Placement & Curriculum" tab
//   out/<level>/index.html  one page per level (Spark, Flow, Drive): its core classes and pathways
// Usage:  node build/build.mjs validate
//         node build/build.mjs build

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toCatalogue, toStudentCatalogue } from "./catalogue.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "spec", "phases.json"), "utf8"));
const topicsSpec = JSON.parse(readFileSync(join(root, "spec", "topics.json"), "utf8"));
const TOL = spec.toleranceCoveragePoints;
const TOTAL = spec.lessonMinutes;
const STAGES = spec.stageOrder;
const TOPIC_TAGS = new Set(topicsSpec.tags);
const TOPICS_BY_ID = topicsSpec.classes;
const PLAN_ENGINE_JS = readFileSync(join(root, "build", "plan-engine.js"), "utf8");
const PLAN_UI_JS = readFileSync(join(root, "build", "plan-builder-ui.js"), "utf8");
const AI_PROMPT_JS = readFileSync(join(root, "build", "ai-prompt.js"), "utf8");
const STUDENT_EXPORT_JS = readFileSync(join(root, "build", "student-export.js"), "utf8");

// Which CEFR sub-level each core class number must carry within its phase.
// Spark: class 1 is the Pre-A1 introduction, classes 2 to 16 are A1, and later classes are A2.
const cefrByNumber = {
  Spark: (n) => (n === 1 ? "Pre-A1" : n <= 16 ? "A1" : "A2"),
  Flow: () => "B1",
  Drive: () => "B2",
};

const phaseFile = {
  Spark: "spark",
  Flow: "flow",
  Drive: "drive",
};

// Focus pathways: short need-based courses. Each pathway has an ID code. Pathway classes are kept
// out of the core level lists and the curriculum guide, and shown under each level's Focus pathways.
const PATHWAY_CODES = {
  "Job Interviews": "INTERVIEW",
  "Fluency": "FLUENCY",
  "Presentation Skills": "PRESENTATION",
};

const PATHWAY_BLURB = {
  "Job Interviews": "Introduce yourself, tell past achievements clearly, talk about strengths, ask good questions, and finish with a full mock interview.",
  "Fluency": "Keep speaking smoothly: fillers and hesitation, linking ideas, rhythm and stress, and a timed speaking challenge.",
  "Presentation Skills": "Structure a talk, describe slides and visuals, handle questions, pace and pause well, and deliver a full presentation.",
};

// Levels shown on the hub, in order, with a short description.
const levels = [
  { phase: "Spark", description: "Foundations: basic sentence patterns and everyday topics (A1), then A2 bridge classes 17 to 31.", cefrNote: "A1 to A2", level: 1, label: "Spark (A1 to A2)" },
  { phase: "Flow", description: "Connected speech and steady conversation.", cefrNote: "B1", level: 2, label: "Flow (B1)" },
  { phase: "Drive", description: "Style, tone, and debate.", cefrNote: "B2", level: 3, label: "Drive (B2)" },
];

const requiredFields = {
  warmup: ["prompt", "tutorAction"],
  theory: ["structure", "method", "checkQuestion"],
  comprehension: ["source", "factCheck", "toneCheck"],
  conversation: ["task", "mandate"],
  wrapup: [],
};

const requiredArrays = {
  theory: ["examples"],
  conversation: ["phrases"],
  wrapup: ["mistakes"],
};

const placeholderPattern = /\[|\]|TODO|lorem|\{\{|\}\}|XXX/i;

function allStrings(obj, out = []) {
  if (typeof obj === "string") out.push(obj);
  else if (Array.isArray(obj)) obj.forEach((v) => allStrings(v, out));
  else if (obj && typeof obj === "object") Object.values(obj).forEach((v) => allStrings(v, out));
  return out;
}

function validate(cls) {
  const errors = [];
  const id = cls.id ?? "(no id)";
  const err = (msg) => errors.push(`${id}: ${msg}`);

  const phase = spec.phases[cls.phase];
  if (!phase) return [`${id}: unknown phase "${cls.phase}"`];

  for (const k of ["id", "number", "title", "canDo", "goal", "cefr"]) {
    if (cls[k] === undefined || cls[k] === "") err(`missing "${k}"`);
  }

  if (!phase.cefrAllowed.includes(cls.cefr)) err(`CEFR "${cls.cefr}" not allowed for ${cls.phase}`);
  const expectedCefr = cefrByNumber[cls.phase]?.(cls.number);
  // Pathway classes choose their CEFR level by content, so only the allowed list applies to them.
  if (!cls.pathway && expectedCefr && cls.cefr !== expectedCefr) {
    err(`class ${cls.number} should be CEFR ${expectedCefr}, found ${cls.cefr}`);
  }

  if (cls.pathway) {
    const code = PATHWAY_CODES[cls.pathway];
    // Flow pathway IDs have no level prefix (INTERVIEW-01); Spark and Drive add one (SPARK-INTERVIEW-01).
    const idPrefix = cls.phase === "Flow" ? code : `${phaseFile[cls.phase].toUpperCase()}-${code}`;
    if (!code) err(`unknown pathway "${cls.pathway}"`);
    else if (cls.id !== `${idPrefix}-${String(cls.number).padStart(2, "0")}`) {
      err(`id should be ${idPrefix}-${String(cls.number).padStart(2, "0")}`);
    }
  } else {
    const prefix = phaseFile[cls.phase]?.toUpperCase();
    if (cls.id !== `${prefix}-${String(cls.number).padStart(2, "0")}`) {
      err(`id should be ${prefix}-${String(cls.number).padStart(2, "0")}`);
    }
  }

  const topics = TOPICS_BY_ID[cls.id];
  if (!topics || topics.length === 0) {
    err(`no grammar topics assigned in spec/topics.json`);
  } else {
    for (const t of topics) if (!TOPIC_TAGS.has(t)) err(`unknown topic tag "${t}"`);
  }

  const stages = cls.stages ?? {};
  let minuteSum = 0;
  for (const s of STAGES) {
    const st = stages[s];
    if (!st) {
      err(`missing stage "${s}"`);
      continue;
    }
    if (typeof st.minutes !== "number" || st.minutes <= 0) {
      err(`stage "${s}" needs a positive minutes value`);
      continue;
    }
    minuteSum += st.minutes;

    const share = (st.minutes / TOTAL) * 100;
    const [lo, hi] = phase.skeletonRanges[s];
    if (share < lo - TOL || share > hi + TOL) {
      err(`stage "${s}" is ${share.toFixed(1)}% of the lesson; allowed ${lo}-${hi}% (±${TOL} pts)`);
    }

    for (const f of requiredFields[s] ?? []) {
      if (typeof st[f] !== "string" || st[f].trim() === "") err(`stage "${s}" missing "${f}"`);
    }
    for (const f of requiredArrays[s] ?? []) {
      if (!Array.isArray(st[f]) || st[f].length < 2) err(`stage "${s}" needs at least 2 "${f}" entries`);
    }
  }
  if (minuteSum !== TOTAL) err(`stage minutes add to ${minuteSum}, must be ${TOTAL}`);

  for (const text of allStrings(cls)) {
    if (placeholderPattern.test(text)) {
      err(`placeholder or bracket text found: "${text.slice(0, 60)}"`);
      break;
    }
  }
  return errors;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Theme: navy blue for structure, orange for accents. Lesson pages use inline
// styles so colours, tables, and headings survive a copy-paste into Google Docs.
const C = {
  blue: "#1F4E79",
  blueLight: "#EAF1F8",
  blueRule: "#C9D8E8",
  orange: "#D9731E",
  orangeLight: "#FDF1E7",
  text: "#222222",
  muted: "#5F6B7A",
};
const F = "font-family:Calibri,Arial,Helvetica,sans-serif;";

const S = {
  body: `${F}color:${C.text};font-size:11pt;line-height:1.5;max-width:820px;margin:28px auto;padding:0 24px;`,
  kicker: `${F}color:${C.orange};font-size:9pt;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 6px;`,
  h1: `${F}color:${C.blue};font-size:22pt;font-weight:bold;margin:0 0 12px;padding-bottom:10px;border-bottom:3px solid ${C.orange};`,
  h2: `${F}color:${C.blue};font-size:13pt;font-weight:bold;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid ${C.blueRule};`,
  h3: `${F}color:${C.orange};font-size:9.5pt;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin:12px 0 4px;`,
  p: `${F}margin:4px 0 8px;`,
  label: `${F}color:${C.blue};font-weight:bold;`,
  ul: `${F}margin:4px 0 8px 18px;padding:0;`,
  li: `${F}margin:2px 0;`,
  metaTable: `${F}border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:10pt;`,
  metaLabel: `${F}background:${C.blueLight};color:${C.blue};font-weight:bold;text-align:left;padding:7px 10px;width:150px;border:1px solid ${C.blueRule};`,
  metaValue: `${F}padding:7px 10px;border:1px solid ${C.blueRule};`,
  table: `${F}border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:10pt;`,
  th: `${F}background:${C.blue};color:#FFFFFF;text-align:left;padding:7px 10px;font-weight:bold;`,
  td: `${F}padding:7px 10px;border-bottom:1px solid ${C.blueRule};`,
  tdNum: `${F}padding:7px 10px;border-bottom:1px solid ${C.blueRule};text-align:right;`,
  checklist: `${F}background:${C.orangeLight};border-left:4px solid ${C.orange};padding:10px 14px;margin:8px 0 4px;`,
  footer: `${F}color:${C.muted};font-size:8.5pt;margin-top:28px;border-top:1px solid ${C.blueRule};padding-top:8px;`,
};

function render(cls) {
  const phase = spec.phases[cls.phase];
  const st = cls.stages;
  const ul = (arr) => `<ul style="${S.ul}">${arr.map((x) => `<li style="${S.li}">${esc(x)}</li>`).join("")}</ul>`;
  const rows = STAGES.map((s) => {
    const pct = Math.round((st[s].minutes / TOTAL) * 100);
    return `<tr><td style="${S.td}">${esc(spec.stageLabels[s])}</td><td style="${S.tdNum}">${st[s].minutes} min</td><td style="${S.tdNum}">${pct}%</td></tr>`;
  }).join("");
  const meta = (label, value) =>
    `<tr><td style="${S.metaLabel}">${esc(label)}</td><td style="${S.metaValue}">${value}</td></tr>`;
  const navLink = (href, text) =>
    `<a href="${href}" style="${F}display:inline-block;background:${C.blue};color:#FFFFFF;text-decoration:none;padding:6px 12px;border-radius:3px;font-size:9.5pt;margin-right:8px;">${text}</a>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(cls.id)} ${esc(cls.title)}</title></head>
<body style="${S.body}">
<nav style="${F}margin:0 0 14px;user-select:none;-webkit-user-select:none;">
${navLink("index.html", `&larr; Back to ${esc(cls.phase)} classes`)}${navLink("../index.html", "All levels")}
</nav>
<p style="${S.kicker}">3-Pillar Curriculum Framework &middot; ${esc(cls.phase)} &middot; ${esc(cls.cefr)}</p>
<h1 style="${S.h1}">${esc(cls.title)}</h1>
<table style="${S.metaTable}">
${meta("Class", esc(cls.id))}
${meta("Student name", "&nbsp;")}
${meta("CEFR phase", `${esc(cls.phase)} (${esc(cls.cefr)})`)}
${meta("Target goal", esc(cls.goal))}
${meta("Can-do objective", esc(cls.canDo))}
${meta("Lesson balance", esc(phase.balance))}
</table>

<table style="${S.table}">
<tr><th style="${S.th}">Stage</th><th style="${S.th}text-align:right;">Time</th><th style="${S.th}text-align:right;">Share</th></tr>${rows}
</table>

<h2 style="${S.h2}">${esc(spec.stageLabels.warmup)}</h2>
<p style="${S.p}"><span style="${S.label}">Hook / prompt:</span> ${esc(st.warmup.prompt)}</p>
<p style="${S.p}"><span style="${S.label}">Tutor action:</span> ${esc(st.warmup.tutorAction)}</p>

<h2 style="${S.h2}">${esc(spec.stageLabels.theory)}</h2>
<p style="${S.p}"><span style="${S.label}">Target structure / formula:</span> ${esc(st.theory.structure)}</p>
<h3 style="${S.h3}">Examples</h3>${ul(st.theory.examples)}
<p style="${S.p}"><span style="${S.label}">Execution method:</span> ${esc(st.theory.method)}</p>
<p style="${S.p}"><span style="${S.label}">Check question:</span> ${esc(st.theory.checkQuestion)}</p>

<h2 style="${S.h2}">${esc(spec.stageLabels.comprehension)}</h2>
<p style="${S.p}"><span style="${S.label}">Material / context source:</span> ${esc(st.comprehension.source)}</p>
<h3 style="${S.h3}">Direct fact check</h3>
<p style="${S.p}">${esc(st.comprehension.factCheck)}</p>
<h3 style="${S.h3}">Tone and implied meaning check</h3>
<p style="${S.p}">${esc(st.comprehension.toneCheck)}</p>

<h2 style="${S.h2}">${esc(spec.stageLabels.conversation)}</h2>
<p style="${S.p}"><span style="${S.label}">Real-world task:</span> ${esc(st.conversation.task)}</p>
<h3 style="${S.h3}">Target phrases and vocabulary</h3>${ul(st.conversation.phrases)}
<h3 style="${S.h3}">Tutor mandate</h3>
<p style="${S.p}">${esc(st.conversation.mandate)}</p>

<h2 style="${S.h2}">${esc(spec.stageLabels.wrapup)}</h2>
<h3 style="${S.h3}">Self-correction prompts</h3>${ul(st.wrapup.mistakes)}

<div style="${S.checklist}">
<p style="${S.label}; margin:0 0 4px;">Tutor checklist</p>
${phase.checklist.map((c) => `<p style="${S.p}margin:2px 0;">&#9744; ${esc(c)}</p>`).join("\n")}
</div>

<p style="${S.footer}">${esc(cls.id)} &middot; ${esc(cls.phase)} (${esc(cls.cefr)}) &middot; Global Key 3-Pillar Curriculum</p>
</body></html>`;
}

function loadClasses() {
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(dataDir, f), "utf8")));
}

// ---------- Shared page styles and behaviour ----------

const levelIndex = (phase) => levels.findIndex((l) => l.phase === phase);

const indexStyle = `
body{font-family:Calibri,Arial,Helvetica,sans-serif;color:${C.text};font-size:11pt;line-height:1.5;max-width:900px;margin:28px auto;padding:0 24px;background:#FFFFFF}
a{color:${C.blue}}
a:hover{color:${C.orange}}
.kicker{color:${C.orange};font-size:9pt;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 6px}
h1{color:${C.blue};font-size:22pt;margin:0 0 12px;padding-bottom:10px;border-bottom:3px solid ${C.orange}}
h2{color:${C.blue};font-size:13pt;margin:26px 0 10px;padding-bottom:4px;border-bottom:1px solid ${C.blueRule}}
h3{color:${C.orange};font-size:10pt;text-transform:uppercase;letter-spacing:1px;margin:16px 0 6px}
.lead{margin:4px 0 12px}
.tabs{display:flex;gap:4px;border-bottom:1px solid ${C.blueRule};margin:18px 0 6px}
.tab{background:none;border:none;border-bottom:3px solid transparent;padding:10px 16px;font-size:11pt;font-family:inherit;color:${C.muted};cursor:pointer;margin-bottom:-1px}
.tab:hover{color:${C.blue}}
.tab[aria-selected=true]{color:${C.blue};font-weight:bold;border-bottom-color:${C.orange}}
.tab:focus{outline:2px solid ${C.blueRule};outline-offset:2px}
.cards{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 4px}
.card{flex:1 1 230px;background:${C.blueLight};border-top:4px solid ${C.orange};padding:14px 16px;text-decoration:none;color:${C.text};display:block}
.card:hover{background:${C.orangeLight}}
.card .name{color:${C.blue};font-size:15pt;font-weight:bold}
.card .cefr{color:${C.orange};font-size:9pt;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin:2px 0 6px}
.card .count{color:${C.muted};font-size:9.5pt;margin-top:8px}
.controls{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 6px}
#q{flex:2 1 320px;padding:10px 12px;font-size:11pt;border:1px solid ${C.blueRule};border-radius:4px;outline:none;font-family:inherit}
#topic{flex:1 1 220px;padding:10px 12px;font-size:11pt;border:1px solid ${C.blueRule};border-radius:4px;background:#FFFFFF;font-family:inherit}
#q:focus,#topic:focus{border-color:${C.blue};box-shadow:0 0 0 2px ${C.blueLight}}
#count{color:${C.muted};font-size:9.5pt;margin:8px 0 10px}
table.idx{border-collapse:collapse;width:100%;font-size:10.5pt}
table.idx th{background:${C.blue};color:#FFFFFF;text-align:left;padding:8px 10px;cursor:pointer;user-select:none;white-space:nowrap}
table.idx th:focus{outline:2px solid ${C.orange};outline-offset:-2px}
table.idx th[aria-sort=ascending]::after{content:" \\25B2";color:${C.orange}}
table.idx th[aria-sort=descending]::after{content:" \\25BC";color:${C.orange}}
table.idx td{padding:8px 10px;border-bottom:1px solid ${C.blueRule};vertical-align:top}
table.idx tr:hover td{background:${C.blueLight}}
a.cid{color:${C.blue};font-weight:bold;text-decoration:none}
a.ctitle{color:${C.text};text-decoration:none}
.topics{color:${C.muted};font-size:9.5pt}
.empty{color:${C.muted};padding:14px 0;display:none}
[hidden]{display:none !important}
.nav{margin:0 0 14px;user-select:none;-webkit-user-select:none}
.btn{display:inline-block;background:${C.blue};color:#FFFFFF;text-decoration:none;padding:6px 12px;border-radius:3px;font-size:9.5pt;margin-right:8px;margin-bottom:6px}
.btn:hover{background:${C.orange};color:#FFFFFF}
.grid{width:100%;border-collapse:collapse;font-size:10pt;margin:6px 0 10px}
.grid th{background:${C.blue};color:#FFFFFF;text-align:left;padding:7px 10px;font-weight:bold;vertical-align:top}
.grid td{padding:7px 10px;border-bottom:1px solid ${C.blueRule};vertical-align:top}
.grid tr:nth-child(even) td{background:${C.blueLight}}
.note{background:${C.blueLight};border-left:4px solid ${C.blue};padding:10px 14px;margin:10px 0}
.warn{background:${C.orangeLight};border-left:4px solid ${C.orange};padding:10px 14px;margin:10px 0}
details{border:1px solid ${C.blueRule};border-radius:4px;margin:10px 0;padding:0}
summary{cursor:pointer;color:${C.blue};font-weight:bold;padding:12px 14px;font-size:12pt}
details[open] summary{border-bottom:1px solid ${C.blueRule}}
details > div{padding:6px 14px 14px}
details details{margin:8px 0}
details details summary{font-size:11pt;padding:10px 12px}
.sel{padding:8px 10px;font-size:11pt;border:1px solid ${C.blueRule};border-radius:4px;background:#FFFFFF;font-family:inherit;min-width:220px}
.pb-btn{background:${C.blue};color:#FFFFFF;border:none;padding:6px 10px;border-radius:3px;font-family:inherit;font-size:10pt;cursor:pointer;margin:2px 4px 2px 0}
.pb-btn:hover{background:${C.orange}}
.pb-week td{background:${C.blueLight};color:${C.blue};font-weight:bold}
.pb-check{margin-right:14px;display:inline-block}
.fb-card{border:1px solid ${C.blueRule};border-left:5px solid ${C.orange};border-radius:4px;padding:12px 14px;margin:10px 0}
.fb-meta{color:${C.muted};font-size:9.5pt;font-weight:normal}
@media print{body *{visibility:hidden}#pb-plan,#pb-plan *{visibility:visible}#pb-plan{position:absolute;left:0;top:0;width:100%}.no-print{display:none !important}}
#score-go{background:${C.blue};color:#FFFFFF;border:none;padding:10px 18px;font-size:11pt;font-family:inherit;border-radius:3px;cursor:pointer}
#score-go:hover{background:${C.orange}}
.footer{color:${C.muted};font-size:8.5pt;margin-top:28px;border-top:1px solid ${C.blueRule};padding-top:8px}
`;

// Shared behaviour for every catalogue. Expects: #q (search), #topic (topic filter),
// #count, #empty, table#idx. #results is optional (hub only): it is shown
// only while a search or topic filter is active. Static tables (no id) are not affected.
const indexScript = `
(function () {
  var table = document.getElementById("idx");
  var tbody = table.tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var headers = Array.prototype.slice.call(table.tHead.rows[0].cells);
  var input = document.getElementById("q");
  var topic = document.getElementById("topic");
  var count = document.getElementById("count");
  var empty = document.getElementById("empty");
  var box = document.getElementById("results");
  var collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  var sortCol = 0, dir = 1;

  function filter() {
    var words = input.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var t = topic.value;
    var shown = 0;
    rows.forEach(function (row) {
      var okWords = words.every(function (w) { return row.getAttribute("data-search").indexOf(w) !== -1; });
      var okTopic = !t || (row.getAttribute("data-topics") || "").split("|").indexOf(t) !== -1;
      row.hidden = !(okWords && okTopic);
      if (!row.hidden) shown++;
    });
    count.textContent = "Showing " + shown + " of " + rows.length + " classes";
    empty.style.display = shown === 0 ? "block" : "none";
    if (box) box.hidden = !(words.length > 0 || t !== "");
  }

  function sortBy(col) {
    if (sortCol === col) { dir = -dir; } else { sortCol = col; dir = 1; }
    rows.slice().sort(function (a, b) {
      var diff = collator.compare(a.cells[col].getAttribute("data-sort"), b.cells[col].getAttribute("data-sort"));
      if (diff === 0) diff = collator.compare(a.cells[0].getAttribute("data-sort"), b.cells[0].getAttribute("data-sort"));
      return dir * diff;
    }).forEach(function (row) { tbody.appendChild(row); });
    headers.forEach(function (th, i) {
      th.setAttribute("aria-sort", i === sortCol ? (dir === 1 ? "ascending" : "descending") : "none");
    });
  }

  headers.forEach(function (th, i) {
    th.tabIndex = 0;
    th.setAttribute("aria-sort", i === 0 ? "ascending" : "none");
    th.addEventListener("click", function () { sortBy(i); });
    th.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(i); }
    });
  });
  input.addEventListener("input", filter);
  topic.addEventListener("change", filter);
  filter();
})();
`;

// Tabs on the hub. The tab in the URL hash (#classes or #placement) opens on load.
const tabsScript = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
  var panels = {
    classes: document.getElementById("panel-classes"),
    placement: document.getElementById("panel-placement"),
    plan: document.getElementById("panel-plan"),
    guide: document.getElementById("panel-guide"),
    fillers: document.getElementById("panel-fillers"),
    reference: document.getElementById("panel-reference")
  };
  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = (k !== name); });
    tabs.forEach(function (t) { t.setAttribute("aria-selected", t.getAttribute("data-tab") === name ? "true" : "false"); });
    if (history.replaceState) history.replaceState(null, "", "#" + name);
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { show(t.getAttribute("data-tab")); });
  });
  var fromHash = location.hash.replace("#", "");
  show(panels[fromHash] ? fromHash : "classes");
  window.addEventListener("hashchange", function () {
    var h = location.hash.replace("#", "");
    if (panels[h]) show(h);
  });
})();
`;

// Full lesson skeletons for the AI prompt. Tutor-only stage notes are included on purpose:
// the prompt is for the tutor, not the student.
function toSkeletons(all) {
  const out = {};
  for (const c of all) {
    out[c.id] = { id: c.id, phase: c.phase, title: c.title, cefr: c.cefr, goal: c.goal, canDo: c.canDo, stages: c.stages };
  }
  return out;
}

// Plan Builder markup. Behaviour is in build/plan-builder-ui.js.
function planPanel() {
  const levelOptions = levels.map((l) => `<option value="${esc(l.phase)}">${esc(l.phase)}</option>`).join("");
  const weekOptions = (selected) =>
    [1, 2, 3].map((n) => `<option value="${n}"${n === selected ? " selected" : ""}>${n}</option>`).join("");
  const pathwayBoxes = Object.keys(PATHWAY_CODES)
    .map((name) => `<label class="pb-check"><input type="checkbox" name="pb-pathway" value="${esc(name)}"> ${esc(name)}</label>`)
    .join("");

  return `<section id="panel-plan" role="tabpanel" aria-labelledby="tab-plan" hidden>
<h2>Suggest a plan</h2>
<p class="lead">Enter the student's level and needs. The builder suggests a plan, which you can then adjust below.</p>
<div class="controls">
<label>Level <select id="pb-level" class="sel">${levelOptions}</select></label>
<label>Starting class number <input id="pb-start" type="number" min="1" max="10" value="1" class="sel" style="min-width:110px"></label>
<label>Classes per week <select id="pb-perweek" class="sel">${weekOptions(2)}</select></label>
</div>
<p style="margin:10px 0 4px;"><b>Focus pathways</b></p>
<p style="margin:0 0 10px;">${pathwayBoxes}</p>
<p style="margin:10px 0 4px;"><b>Grammar topics that need practice</b> (hold Ctrl or Cmd to pick several)</p>
<select id="pb-topics" class="sel" multiple size="6" style="min-width:300px"></select>
<div class="controls" style="margin-top:12px;">
<label class="pb-check"><input type="checkbox" id="pb-bridge"> Include bridge classes</label>
<label class="pb-check"><input type="checkbox" id="pb-readiness"> Include the readiness check</label>
<label>Pathway format <select id="pb-mode" class="sel">
<option value="parallel">Alongside core (spread through the plan)</option>
<option value="blocks">Blocks (before core)</option>
</select></label>
</div>
<p style="margin:12px 0;"><button type="button" id="pb-generate" class="pb-btn">Suggest a plan</button></p>
<div id="pb-warn" hidden></div>

<h2>Build manually</h2>
<p class="lead">Search the catalogue and add classes to the plan. Use the arrows to reorder, or remove a class.</p>
<div class="controls">
<input id="pb-search" type="search" class="sel" placeholder="Search classes, topics, or IDs" style="min-width:300px">
<select id="pb-filter-level" class="sel"><option value="">All levels</option>${levelOptions}</select>
</div>
<p id="pb-results-count" class="topics"></p>
<div style="max-height:360px;overflow:auto;border:1px solid ${C.blueRule};">
<table class="grid" style="margin:0;">
<tr><th>Class</th><th>Level</th><th>CEFR</th><th>Title</th><th></th></tr>
<tbody id="pb-results"></tbody>
</table>
</div>

<h2>Your plan</h2>
<div class="controls">
<input id="pb-name" type="text" class="sel" placeholder="Student or plan name" style="min-width:260px">
<label>Classes per week <select id="pb-perweek-out" class="sel">${weekOptions(2)}</select></label>
</div>
<div class="no-print" style="margin:8px 0;">
<button type="button" id="pb-copy" class="pb-btn">Copy as text</button>
<button type="button" id="pb-print" class="pb-btn">Print</button>
<button type="button" id="pb-save" class="pb-btn">Save in this browser</button>
<button type="button" id="pb-clear" class="pb-btn">Clear</button>
</div>
<p id="pb-status" class="topics"></p>
<p id="pb-count" class="topics"></p>
<div id="pb-plan"></div>
<div id="pb-prompt" class="no-print" hidden>
<h3>AI prompt for this lesson</h3>
<p class="topics" id="pb-prompt-info"></p>
<p class="topics">Paste this into an AI tool. It uses the lesson skeleton and the student details entered on the Placement tab. Check the reply before you use it.</p>
<textarea id="pb-prompt-text" class="sel" rows="20" readonly style="width:100%;max-width:900px;font-family:inherit;"></textarea>
<p style="margin:8px 0;"><button type="button" id="pb-prompt-copy" class="pb-btn">Copy prompt</button> <span id="pb-prompt-status" class="topics"></span></p>
</div>

<h3 style="margin-top:18px;">Student document</h3>
<p class="topics">Creates a branded learning path for the student, with the plan's sessions, goals, and evidence of progress. It contains no tutor notes.</p>
<div class="controls">
<input id="pb-student" type="text" class="sel" placeholder="Student name" style="min-width:220px">
<input id="pb-tutor" type="text" class="sel" placeholder="Tutor name" style="min-width:220px">
<input id="pb-date" type="date" class="sel">
<button type="button" id="pb-export" class="pb-btn">Export student document</button>
</div>

<h2>Saved plans (this browser)</h2>
<div id="pb-saved"></div>
</section>`;
}

// Placement scorer. Implements the standard's rules:
//   Speaking + Theory rule: place the student where speaking and theory meet (the lower score).
//   Mixed skill rule: Comprehension at Level 3 with Conversation and Theory at Level 1 places the student at Level 2.
const scorerScript = `
(function () {
  var levelName = { 1: "Spark (A1 to A2)", 2: "Flow (B1)", 3: "Drive (B2)", 4: "Drive (B2), advanced" };
  var startClass = { 1: "spark/SPARK-01.html", 2: "flow/FLOW-01.html", 3: "drive/DRIVE-01.html", 4: "drive/DRIVE-11.html" };
  var startLabel = { 1: "SPARK-01", 2: "FLOW-01", 3: "DRIVE-01", 4: "DRIVE-11" };
  var levelPage = { 1: "spark/index.html", 2: "flow/index.html", 3: "drive/index.html", 4: "drive/index.html" };
  var phaseName = { 1: "Spark", 2: "Flow", 3: "Drive", 4: "Drive" };
  var startNumber = { 1: 1, 2: 1, 3: 1, 4: 11 };
  var STORE_KEY = "globalkey.placement";
  var button = document.getElementById("score-go");
  var out = document.getElementById("score-out");
  var card = document.getElementById("cur-student");

  function $(id) { return document.getElementById(id); }
  function el(tag, text) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function readStored() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; }
  }
  function writeStored(p) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
  }
  function readDetails() {
    var goals = Array.prototype.map.call(document.querySelectorAll('input[name="st-goal"]:checked'), function (b) { return b.value; });
    var age = parseInt($("st-age").value, 10);
    return {
      name: $("st-name").value.trim(),
      age: isNaN(age) ? "" : age,
      employment: $("st-employ").value,
      job: $("st-job").value.trim(),
      goals: goals,
      otherGoals: $("st-goals").value.trim()
    };
  }
  function setDetails(d) {
    $("st-name").value = d.name || "";
    $("st-age").value = d.age ? String(d.age) : "";
    $("st-employ").value = d.employment || "";
    $("st-job").value = d.job || "";
    $("st-goals").value = d.otherGoals || "";
    Array.prototype.forEach.call(document.querySelectorAll('input[name="st-goal"]'), function (b) {
      b.checked = (d.goals || []).indexOf(b.value) !== -1;
    });
  }
  function goalText(d) {
    var parts = (d.goals || []).slice();
    if (d.otherGoals) parts.push(d.otherGoals);
    return parts.join("; ");
  }
  function renderCard(p) {
    card.textContent = "";
    if (!p) { card.hidden = true; return; }
    var d = p.details;
    card.appendChild(el("p")).appendChild(el("b", "Student plan: " + (d.name || "Unnamed student")));
    var rows = [
      ["Age", d.age ? String(d.age) : "Not entered"],
      ["Employment", [d.employment, d.job].filter(Boolean).join(", ") || "Not entered"],
      ["Goals", goalText(d) || "Not entered"],
      ["Placement", levelName[p.level]],
      ["Scores", "Conversation " + p.scores.conv + ", grammar " + p.scores.theory + ", listening " + p.scores.comp]
    ];
    rows.forEach(function (r) {
      var line = el("p");
      line.style.margin = "4px 0";
      line.appendChild(el("b", r[0] + ": "));
      line.appendChild(document.createTextNode(r[1]));
      card.appendChild(line);
    });
    var actions = el("p");
    actions.style.margin = "8px 0 4px";
    var start = el("a", "Start at " + startLabel[p.level]);
    start.className = "btn";
    start.href = startClass[p.level];
    var plan = el("a", "Open Plan Builder");
    plan.className = "btn";
    plan.href = "#plan";
    actions.appendChild(start);
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(plan);
    card.appendChild(actions);
    var clear = el("button", "Clear student");
    clear.type = "button";
    clear.className = "pb-btn";
    clear.addEventListener("click", function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ }
      renderCard(null);
    });
    card.appendChild(clear);
    card.hidden = false;
  }
  function prefillPlanBuilder(p) {
    var d = p.details;
    var level = $("pb-level");
    if (!level) return;
    level.value = phaseName[p.level];
    level.dispatchEvent(new Event("change"));
    $("pb-start").value = String(startNumber[p.level]);
    $("pb-name").value = d.name;
    $("pb-name").dispatchEvent(new Event("input"));
    $("pb-student").value = d.name;
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pb-pathway"]'), function (b) {
      b.checked = (d.goals || []).indexOf(b.value) !== -1;
    });
  }

  button.addEventListener("click", function () {
    var conv = parseInt(document.getElementById("s-conv").value, 10);
    var theory = parseInt(document.getElementById("s-theory").value, 10);
    var comp = parseInt(document.getElementById("s-comp").value, 10);
    if (!conv || !theory || !comp) {
      out.innerHTML = '<p class="warn">Score all three pillars before getting a suggestion.</p>';
      out.hidden = false;
      return;
    }
    var level, reason;
    if (comp === 3 && conv === 1 && theory === 1) {
      level = 2;
      reason = "Mixed skill rule applies: listening at Level 3 with speaking and grammar at Level 1 places the student at Flow (Level 2). Flow builds their grammar base while keeping the content engaging for their listening ability.";
    } else {
      level = Math.min(conv, theory);
      reason = "Speaking and theory rule applies: adult learners often understand more than they can say, so the student is placed where their speaking and grammar abilities meet, which is the lower of the two scores (" + Math.min(conv, theory) + ").";
      if (level === 4) reason = "Speaking and grammar are both at Level 4. Place the student in Drive and begin with the bridge classes.";
    }
    var note = (level === 4)
      ? '<p class="note">Level 4 on speaking and grammar: start at DRIVE-11 and use the bridge modules, which move toward more advanced work.</p>'
      : "";
    out.innerHTML =
      '<p><b>Suggested placement: ' + levelName[level] + '</b></p>' +
      '<p>' + reason + '</p>' + note +
      '<p><a class="btn" href="' + startClass[level] + '">Start at ' + startLabel[level] + '</a>' +
      '<a class="btn" href="' + levelPage[level] + '">Open ' + levelName[level].split(" ")[0] + ' classes</a></p>' +
      '<p style="color:#5F6B7A;font-size:9.5pt;">Comprehension is recorded for the mixed skill rule only. Use the tutor\\'s judgement for borderline scores, and re-test after a few weeks.</p>';
    var placement = {
      level: level,
      scores: { conv: conv, theory: theory, comp: comp },
      details: readDetails(),
      savedAt: new Date().toISOString()
    };
    var saved = writeStored(placement);
    out.insertAdjacentHTML("beforeend", saved
      ? '<p class="note">Saved. The student appears in the Curriculum section, and the Plan Builder has a suggested plan for them.</p>'
      : '<p class="warn">This browser would not save the student details, so they will not carry over to the Plan Builder.</p>');
    out.hidden = false;
    renderCard(placement);
    prefillPlanBuilder(placement);
    $("pb-generate").click();
  });

  var stored = readStored();
  if (stored && stored.details) {
    setDetails(stored.details);
    renderCard(stored);
    prefillPlanBuilder(stored);
  } else {
    renderCard(null);
  }
})();
`;

// ---------- Catalogue tables and dropdowns ----------

// Topic options and row data are built from whichever classes a page shows.
function topicOptions(classes) {
  const used = new Set();
  for (const c of classes) for (const t of TOPICS_BY_ID[c.id] ?? []) used.add(t);
  const sorted = [...used].sort((a, b) => a.localeCompare(b));
  return `<option value="">All grammar topics</option>${sorted
    .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
    .join("")}`;
}

// homeLinks: true for the hub (classes live in level folders), false for a level page.
function classRows(classes, { homeLinks, showLevel }) {
  return classes
    .map((c) => {
      const topics = TOPICS_BY_ID[c.id] ?? [];
      const search = [c.id, c.title, c.phase, c.cefr, c.goal, c.canDo, ...topics].join(" ").toLowerCase();
      const href = homeLinks ? `${phaseFile[c.phase]}/${esc(c.id)}.html` : `${esc(c.id)}.html`;
      const idKey = `${levelIndex(c.phase)}-${String(c.number).padStart(3, "0")}`;
      const levelCell = showLevel
        ? `<td data-sort="${levelIndex(c.phase)}">${esc(c.phase)}</td>`
        : "";
      return `<tr data-search="${esc(search)}" data-topics="${esc(topics.join("|"))}">
<td data-sort="${idKey}"><a href="${href}" class="cid">${esc(c.id)}</a></td>${levelCell}
<td data-sort="${esc(c.cefr)}">${esc(c.cefr)}</td>
<td data-sort="${esc(c.title.toLowerCase())}"><a href="${href}" class="ctitle">${esc(c.title)}</a></td>
<td data-sort="${esc(topics.join(", ").toLowerCase())}" class="topics">${esc(topics.join(" · "))}</td>
</tr>`;
    })
    .join("\n");
}

// tableId "idx" makes the table searchable and sortable. Pass null for a static table.
function catalogTable(classes, { homeLinks, showLevel, tableId = "idx" }) {
  const head = `<th>Class</th>${showLevel ? "<th>Level</th>" : ""}<th>CEFR</th><th>Title</th><th>Grammar topics</th>`;
  const idAttr = tableId ? ` id="${tableId}"` : "";
  return `<table${idAttr} class="idx">
<thead><tr>${head}</tr></thead>
<tbody>
${classRows(classes, { homeLinks, showLevel })}
</tbody>
</table>`;
}

function controls(classes) {
  return `<div class="controls">
<input id="q" type="search" placeholder="Search topics, titles, or IDs, e.g. conditional, passive, FLOW-12" autocomplete="off" aria-label="Search classes">
<select id="topic" aria-label="Filter by grammar topic">${topicOptions(classes)}</select>
</div>`;
}

// Focus pathway dropdowns for one level: one nested dropdown per pathway, inside a Focus pathways dropdown.
function pathwayDetails(level, all, { homeLinks }) {
  const names = Object.keys(PATHWAY_CODES);
  const total = all.filter((c) => c.phase === level && c.pathway).length;
  if (total === 0) return "";
  const inner = names
    .map((name) => {
      const list = all
        .filter((c) => c.phase === level && c.pathway === name)
        .sort((a, b) => a.number - b.number);
      if (list.length === 0) return "";
      const rows = list
        .map((c) => {
          const href = homeLinks ? `${phaseFile[level]}/${esc(c.id)}.html` : `${esc(c.id)}.html`;
          const topics = (TOPICS_BY_ID[c.id] ?? []).join(", ");
          return `<tr><td>${c.number}</td><td><a href="${href}" class="cid">${esc(c.id)}</a></td><td>${esc(c.title)}</td><td>${esc(topics)}</td></tr>`;
        })
        .join("\n");
      return `<details>
<summary>${esc(name)}: ${list.length} classes</summary>
<div>
<p style="margin:6px 0;">${esc(PATHWAY_BLURB[name])}</p>
<table class="grid">
<tr><th>#</th><th>Class</th><th>Title</th><th>Grammar topics</th></tr>
${rows}
</table>
</div>
</details>`;
    })
    .join("\n");
  return `<details>
<summary>Focus pathways: ${total} classes</summary>
<div>
<p style="margin:6px 0;">Short courses for needs we see often. Each pathway uses the ${esc(level)} lesson skeleton, so it fits the same 30-minute format as the core course.</p>
${inner}
</div>
</details>`;
}


// ---------- Classes tab (hub) and level pages ----------

function classesPanel(all) {
  const core = all.filter((c) => !c.pathway);
  const cards = levels
    .map((l) => {
      const list = core.filter((c) => c.phase === l.phase);
      return `<a class="card" href="${phaseFile[l.phase]}/index.html">
<div class="name">${esc(l.phase)}</div>
<div class="cefr">${esc(l.cefrNote)}</div>
<div>${esc(l.description)}</div>
<div class="count">${list.length} core classes &rarr;</div>
</a>`;
    })
    .join("\n");

  return `<section id="panel-classes" role="tabpanel" aria-labelledby="tab-classes">
<h2>Search all classes</h2>
${controls(all)}
<div id="results" hidden>
<p id="count">Showing ${all.length} of ${all.length} classes</p>
${catalogTable(all, { homeLinks: true, showLevel: true })}
</div>
<p id="empty" class="empty">No classes match your search. Try a shorter word or a different topic.</p>

<h2>Levels</h2>
<div class="cards">
${cards}
</div>

</section>`;
}

// ---------- Placement & Curriculum tab ----------

const indicatorRows = [
  {
    level: "Level 1: Spark (A1 to A2)",
    comp: ["Understands slow, clear speech.", "Catches key numbers, names, and daily words.", "Follows simple short instructions."],
    conv: ["Expresses basic personal details.", "Answers direct questions with simple sentences.", "Pauses frequently to look for words."],
    theory: ["Uses pronouns and Present Simple correctly.", "Forms simple questions (Who, What, Where).", "Uses basic word order: Subject + Verb + Object."],
  },
  {
    level: "Level 2: Flow (B1)",
    comp: ["Understands main ideas of clear speech on familiar topics.", "Follows medium-speed dialogues.", "Picks out specific details in short talks."],
    conv: ["Holds basic conversations without major trouble.", "Describes past events, experiences, and future plans.", "Explains opinions using simple connectors (because, but, so)."],
    theory: ["Knows the difference between Past Simple and Present Perfect.", "Uses future forms (going to vs. will).", "Uses basic modal verbs (can, should, must)."],
  },
  {
    level: "Level 3: Drive (B2)",
    comp: ["Follows fast, natural native speech and meetings.", "Understands complex arguments on familiar topics.", "Picks up implied meaning and changes in tone."],
    conv: ["Delivers clear, detailed presentations.", "Participates actively in discussions and debates.", "Explains viewpoints on issues, giving pros and cons."],
    theory: ["Uses complex conditionals (2nd and 3rd).", "Uses passive voice for formal reports.", "Uses relative clauses and advanced linking words (however, consequently)."],
  },
];

const list = (items) => `<ul style="margin:4px 0 0 18px;padding:0;">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

// Five listening passages for Step 2, graded from Level 1 to Level 3.
// Each passage is read twice at normal speed, then the two questions are asked in order.
const readingPassages = [
  {
    level: "Level 1 (Spark)",
    text: "My name is Ana, and I live in a small town near the coast. I work in a bank from Monday to Friday. In the morning, I drink coffee and walk to the office. In the evening, I cook dinner and call my mother.",
    direct: "Where does Ana work, and on which days?",
    meaning: "How does Ana feel about her daily life?",
    key: "A bank, Monday to Friday. She seems content and settled, with a simple, comfortable routine.",
  },
  {
    level: "Level 1 to 2 (Spark to Flow)",
    text: "Last summer, Tom and his brother went camping by a lake. On the first day, it rained, so they stayed in the tent and played cards. On the second day, the sun came out. They swam, cooked fish on a fire, and walked to the top of a hill.",
    direct: "What did Tom and his brother do on the first day?",
    meaning: "Why did they enjoy the second day more than the first?",
    key: "They stayed in the tent and played cards. The weather improved, so they could swim, cook outside, and walk.",
  },
  {
    level: "Level 2 (Flow)",
    text: "Maria was planning to move to Madrid for a new job. However, a week before she left, the company cancelled the position. She was disappointed at first, but she realised that she had more time to study, so she decided to stay and improve her English.",
    direct: "What happened a week before Maria was due to leave?",
    meaning: "Why did Maria decide to stay?",
    key: "The company cancelled the job. She realised she had more time to study and improve her English.",
  },
  {
    level: "Level 2 to 3 (Flow to Drive)",
    text: "Many people believe that cities should have more bicycle lanes. Cyclists are safer when they have their own space, and fewer cars mean cleaner air. Nevertheless, some shop owners worry that fewer parking spaces will reduce their customers.",
    direct: "What do the shop owners worry about?",
    meaning: "Does the speaker support the bicycle lanes? How can you tell?",
    key: "They worry that fewer parking spaces will reduce customers. The speaker supports the lanes, shown by the points in favour and the word Nevertheless, which sets the concern aside.",
  },
  {
    level: "Level 3 (Drive)",
    text: "The minister described the new housing plan as ambitious. Critics, however, pointed out that the plan had been announced three times before. One analyst remarked that the government seemed more interested in headlines than in homes.",
    direct: "How many times had the plan been announced before?",
    meaning: "What does the analyst suggest about the government?",
    key: "Three times. The analyst is sceptical: the government cares more about publicity than about results, so ambitious is used with irony.",
  },
];

function readingSection() {
  const passages = readingPassages
    .map(
      (p, i) => `<div class="note">
<p style="margin:0 0 6px;"><b>Passage ${i + 1}</b> &middot; <span style="color:#D9731E;font-weight:bold;">${esc(p.level)}</span></p>
<p style="margin:0 0 8px;">${esc(p.text)}</p>
<ul style="margin:0 0 6px 18px;padding:0;">
<li><b>Direct question:</b> ${esc(p.direct)}</li>
<li><b>Meaning question:</b> ${esc(p.meaning)}</li>
</ul>
<p style="margin:0;color:#5F6B7A;font-size:9.5pt;"><b>Look for:</b> ${esc(p.key)}</p>
</div>`
    )
    .join("\n");
  return `<p style="margin:4px 0 8px;">Read one passage twice at normal speed, then ask its two questions in order. Use the answer guide to check the response, and accept reasonable paraphrases. Choose a passage close to the student's expected level, and move up or down if the first answers are weak.</p>
${passages}`;
}

function placementSection() {
  const goalBoxes = Object.keys(PATHWAY_CODES)
    .map((name) => `<label class="pb-check"><input type="checkbox" name="st-goal" value="${esc(name)}"> ${esc(name)}</label>`)
    .join(" ");
  const rows = indicatorRows
    .map((r) => `<tr><td><b>${esc(r.level)}</b></td><td>${list(r.comp)}</td><td>${list(r.conv)}</td><td>${list(r.theory)}</td></tr>`)
    .join("\n");

  const levelOptions = (id) => `<select id="${id}" class="sel" aria-label="${id}">
<option value="">Choose a score</option>
<option value="1">Level 1 (Spark)</option>
<option value="2">Level 2 (Flow)</option>
<option value="3">Level 3 (Drive)</option>
<option value="4">Level 4 (above Drive)</option>
</select>`;

  return `<section>
<h2>Placement</h2>
<p class="lead">Use this guide to place a new student in Spark, Flow, or Drive. Work through the three steps, score each pillar, then use the suggested level.</p>

<h3>Student details</h3>
<div class="controls" style="align-items:flex-end;">
<label>Name <input id="st-name" type="text" class="sel" style="min-width:220px"></label>
<label>Age <input id="st-age" type="number" min="5" max="120" class="sel" style="min-width:90px"></label>
<label>Employment <select id="st-employ" class="sel">
<option value="">Choose</option>
<option>Employed</option>
<option>Self-employed</option>
<option>Student</option>
<option>Looking for work</option>
<option>Retired</option>
<option>Other</option>
</select></label>
<label>Job or field <input id="st-job" type="text" class="sel" style="min-width:220px" placeholder="e.g. nurse, software developer"></label>
</div>
<p style="margin:10px 0 4px;"><b>Learning goals</b> (tick any that apply)</p>
<p style="margin:0 0 6px;">${goalBoxes}</p>
<textarea id="st-goals" class="sel" rows="3" style="width:100%;max-width:700px;" placeholder="Other goals, in the student's words. e.g. speak confidently with clients"></textarea>

<h3>Step 1: Speaking and grammar test (10 to 12 minutes)</h3>
<ol style="margin:4px 0 8px 20px;padding:0;">
<li>Warm-up (1 to 2 minutes): a casual conversation about the student's job, daily routine, or learning goals.</li>
<li>Three graded questions (8 to 10 minutes). Ask them in order, and listen for the grammar each one checks.</li>
</ol>
<table class="grid">
<tr><th>Question</th><th>Prompt</th><th>What it checks</th></tr>
<tr><td>1. Present / daily routine</td><td>"Tell me about your typical workday and main responsibilities."</td><td>Present simple, daily vocabulary, subject-verb agreement</td></tr>
<tr><td>2. Past / storytelling</td><td>"Describe a recent challenge at work or in life and how you handled it."</td><td>Past simple, past continuous, connecting words (because, so, then)</td></tr>
<tr><td>3. Hypothetical / opinion</td><td>"If you could change one thing about your career path, what would it be and why?"</td><td>Conditionals, modal verbs, complex sentences</td></tr>
</table>

<h3>Step 2: Listening test (5 to 7 minutes)</h3>
<p style="margin:4px 0 8px;">Play a short 30-second audio clip, or use one of the five reading passages below. Ask one direct fact question and one question about underlying meaning.</p>
${readingSection()}

<h3>Step 3: Score each pillar (3 to 5 minutes)</h3>
<p style="margin:4px 0 8px;">Score Conversation (speaking), Theory (grammar), and Comprehension (listening) from Level 1 to 4, using the indicators below. Then use the scorer.</p>
<table class="grid">
<tr><th>Level</th><th>Comprehension indicators</th><th>Conversation indicators</th><th>Theory indicators</th></tr>
${rows}
</table>

<h3>Placement scorer</h3>
<div class="controls" style="align-items:flex-end;">
<div><div style="color:#1F4E79;font-weight:bold;margin-bottom:4px;">Conversation (speaking)</div>${levelOptions("s-conv")}</div>
<div><div style="color:#1F4E79;font-weight:bold;margin-bottom:4px;">Theory (grammar)</div>${levelOptions("s-theory")}</div>
<div><div style="color:#1F4E79;font-weight:bold;margin-bottom:4px;">Comprehension (listening)</div>${levelOptions("s-comp")}</div>
</div>
<p style="margin:10px 0;"><button id="score-go" type="button">Suggest a level</button></p>
<div id="score-out" class="note" hidden></div>

<h3>Placement rules for uneven profiles</h3>
<div class="note">
<p style="margin:0 0 6px;"><b>Speaking and theory rule.</b> Adult learners often understand more than they can say. Place the student where their speaking and grammar abilities meet.</p>
<p style="margin:0;"><b>Mixed skill rule.</b> A student with Level 3 listening but Level 1 speaking and grammar goes to Level 2 (Flow). This builds their grammar base while keeping content engaging for their listening ability.</p>
</div>
</section>`;
}

function curriculumSection(core) {
  const guide = {
    Spark: {
      role: "Teacher and helper",
      talk: "Teacher talk time strictly under 40%.",
      note: "Class 1 is a Pre-A1 introduction for absolute beginners. Classes 2 to 16 are the A1 course, and class 16 is the final A1 communication challenge. Classes 17 to 31 are the A2 bridge modules, for students who need more practice before Flow.",
    },
    Flow: {
      role: "Guide and facilitator",
      talk: "Student talks for 60 to 70% of the lesson.",
      note: "Classes 1 to 10 are the core B1 course. Classes 11 to 40 are the B1 bridge modules, for students who need more practice before Drive. Class 40 is the B1 readiness check.",
    },
    Drive: {
      role: "Coach and discussion partner",
      talk: "Student talks for 75 to 85% of the lesson.",
      note: "Classes 1 to 10 are the core B2 course. Classes 11 to 46 are the B2 bridge modules. Class 46 is the readiness check.",
    },
  };

  const pace = 2;
  const sections = levels
    .map((l) => {
      const phaseList = core
        .filter((c) => c.phase === l.phase)
        .sort((a, b) => a.number - b.number);
      const g = guide[l.phase];
      const rows = phaseList
        .map((c, i) => {
          const week = Math.floor(i / pace) + 1;
          const topics = (TOPICS_BY_ID[c.id] ?? []).join(", ");
          return `<tr><td>${week}</td><td><a href="${phaseFile[l.phase]}/${esc(c.id)}.html">${esc(c.id)}</a></td><td>${esc(c.title)}</td><td>${esc(topics)}</td></tr>`;
        })
        .join("\n");
      const weeks = Math.ceil(phaseList.length / pace);
      return `<details>
<summary>${esc(l.phase)} (${esc(l.cefrNote)}): ${phaseList.length} classes</summary>
<div>
<p style="margin:6px 0;"><b>Tutor role:</b> ${esc(g.role)}. <b>Talk time:</b> ${esc(g.talk)}</p>
<p style="margin:6px 0;"><b>Suggested pace:</b> ${pace} classes per week, about ${weeks} weeks for the full ${esc(l.phase)} course. Start a placed student at the class in the table, then continue in order.</p>
<p class="note" style="margin:8px 0;">${esc(g.note)}</p>
<table class="grid">
<tr><th>Week</th><th>Class</th><th>Title</th><th>Grammar topics</th></tr>
${rows}
</table>
</div>
</details>`;
    })
    .join("\n");

  return `<section>
<h2>Curriculum</h2>
<p class="lead">Build a course for a placed student. Start at the class that matches their placement, then work through the classes in order at the suggested pace. Use the bridge classes when a student is between levels or needs more practice on a topic. Focus pathways are listed on the Classes tab, under each level.</p>
<div id="cur-student" class="note" hidden></div>
<div class="warn">Students who finish one level should move up only when they score at the next level on all three pillars. Re-test with the placement steps before moving them.</div>
${sections}
</section>`;
}

// ---------- Level Guide tab ----------

// CEFR summaries are written in our own words, based on the Council of Europe Common Reference
// Levels (Global Scale). See the source link on the page.
const CEFR_SOURCE_URL = "https://www.coe.int/en/web/common-european-framework-reference-languages/table-1-cefr-3.3-common-reference-levels-global-scale";

const LEVEL_GUIDE = {
  Spark: {
    cefrLines: [
      ["A1", "Uses familiar everyday expressions and very simple phrases for concrete needs. Introduces themselves and others, and asks and answers questions about personal details. Communication works when the other person speaks slowly and clearly and is willing to help."],
      ["A2", "Understands sentences and common expressions about areas of immediate relevance, such as family, shopping, and work. Handles short, routine exchanges on familiar matters. Describes background and everyday needs in simple terms."],
    ],
    matrix: {
      theory: "Basic sentence structure, core words, simple grammar.",
      comprehension: "Guided listening, direct facts, teacher-controlled speed.",
      conversation: "Scripted dialogues, simple Q&A, personal facts.",
      tutorRole: "Teacher and helper",
    },
    talk: "Teacher talk time strictly under 40%. The student does most of the speaking in the conversation stage.",
    profile: [
      "New to English, or returning after a long break.",
      "Speaks in short sentences and relies on set phrases.",
      "Benefits from visuals, templates, and short, clear instructions.",
      "Speaking confidence is the priority. Accuracy comes second.",
    ],
    moveUp: [
      "Scores Level 2 (Flow) on all three pillars at a re-test, using the placement indicators.",
      "Places at Flow when speaking and theory meet at Level 2, under the speaking and theory rule.",
      "Places at Flow with Level 3 listening and Level 1 speaking and grammar, under the mixed skill rule.",
    ],
    pitfalls: [
      "Correcting every error in the first sessions. Praise complete sentences first.",
      "Talking for too long. Keep teacher talk under 40%, and use the visual templates.",
      "Skipping the speaking block when time runs short. Speaking is the goal of this level.",
    ],
  },
  Flow: {
    cefrLines: [
      ["B1", "Follows the main points of clear standard speech on familiar matters met at work, school, or in leisure. Deals with most situations that come up while travelling. Writes simple connected text on familiar or personal topics, and gives reasons for opinions and plans."],
    ],
    matrix: {
      theory: "Guided grammar discovery, complex tenses, linking words.",
      comprehension: "Main idea understanding, natural speech, contextual guessing.",
      conversation: "Longer answers, sharing opinions, telling stories freely.",
      tutorRole: "Guide and facilitator",
    },
    talk: "Student talks for 60 to 70% of the lesson. Do not interrupt mid-sentence.",
    profile: [
      "Handles everyday topics, but struggles with long, unplanned speech.",
      "Knows the core tenses and uses them mostly correctly.",
      "Makes errors with perfect tenses, conditionals, and linking words.",
      "Follows clear speech at medium speed, and misses some detail in fast speech.",
    ],
    moveUp: [
      "Scores Level 3 (Drive) on all three pillars at a re-test.",
      "Completes the B1 readiness check (Flow class 40) at the standard required for Drive.",
      "Places at Drive when the scores meet the Level 3 indicators on every pillar.",
    ],
    pitfalls: [
      "Lecturing on grammar instead of guiding the student to discover the rule.",
      "Interrupting mid-sentence, which breaks the student's flow.",
      "Saving error correction too long. Use the delayed feedback stage each session.",
    ],
  },
  Drive: {
    cefrLines: [
      ["B2", "Understands the main ideas of complex text on concrete and abstract topics, including technical discussion in the student's field. Interacts with enough fluency for regular conversation with native speakers without strain. Produces clear, detailed text, and explains a viewpoint by weighing the advantages and disadvantages of options."],
    ],
    matrix: {
      theory: "Style and tone grammar, natural word pairings, formal tone.",
      comprehension: "Underlying tone, sarcasm, listening to various accents.",
      conversation: "Active debates, complex problem-solving, defending ideas.",
      tutorRole: "Coach and discussion partner",
    },
    talk: "Student talks for 75 to 85% of the lesson. Act as a conversation partner and challenge the student's views.",
    profile: [
      "Speaks fluently on familiar topics, and can argue a position.",
      "Needs help with nuance, tone, idioms, and natural word choice.",
      "Errors are mostly about precision and style, not basic grammar.",
      "Often still translates ideas from their first language.",
    ],
    moveUp: [
      "Completes the B2 readiness check (Drive class 46) at the standard required.",
      "Shows the Level 4 scores on speaking and grammar. The Level 4 path begins at the bridge classes (Drive 11 onward).",
    ],
    pitfalls: [
      "Staying in comfortable topics. Push the student toward debate and abstract argument.",
      "Translating for the student. Ask them to rephrase in English instead.",
      "Correcting style too early. Focus first on fluency and defending a view.",
    ],
  },
};

const COMPARISON_ROWS = [
  ["CEFR level", "A1 to A2", "B1", "B2"],
  ["Theory focus", "Basic sentence structure, core words", "Guided grammar discovery, complex tenses", "Style, tone, and natural word pairings"],
  ["Comprehension focus", "Direct facts, teacher-controlled speed", "Main ideas, natural speech", "Underlying tone, sarcasm, accents"],
  ["Conversation focus", "Scripted dialogues, personal facts", "Longer answers, opinions, stories", "Debates, problem-solving, defending ideas"],
  ["Lesson balance", "Theory 25-30%, Comprehension 25-30%, Conversation 25-30%", "Theory 25-30%, Comprehension 30-35%, Conversation 25-30%", "Theory 15-20%, Comprehension 25-30%, Conversation 45-50%"],
  ["Student talk time", "Teacher under 40%", "Student 60-70%", "Student 75-85%"],
  ["Tutor role", "Teacher and helper", "Guide and facilitator", "Coach and discussion partner"],
];

function levelGuidePanel(allClasses) {
  const counts = (phase) => {
    const list = allClasses.filter((c) => c.phase === phase);
    const core = list.filter((c) => !c.pathway && !/readiness/i.test(c.title) && c.number <= 10).length;
    const bridge = list.filter((c) => !c.pathway && !/readiness/i.test(c.title) && c.number > 10).length;
    const pathways = [...new Set(list.filter((c) => c.pathway).map((c) => c.pathway))];
    const pathwayCount = list.filter((c) => c.pathway).length;
    const readiness = list.filter((c) => /readiness/i.test(c.title)).length;
    return { core, bridge, pathways, pathwayCount, readiness };
  };

  const comparison = `<table class="grid">
${COMPARISON_ROWS.map((row, i) => (i === 0
    ? `<tr>${row.map((cell) => `<th>${esc(cell)}</th>`).join("")}</tr>`
    : `<tr>${row.map((cell, j) => (j === 0 ? `<td><b>${esc(cell)}</b></td>` : `<td>${esc(cell)}</td>`)).join("")}</tr>`)).join("\n")}
</table>`;

  const sections = levels
    .map((l) => {
      const d = LEVEL_GUIDE[l.phase];
      const ind = indicatorRows[l.level - 1];
      const n = counts(l.phase);
      const cefrList = d.cefrLines
        .map(([code, text]) => `<li><b>${esc(code)}:</b> ${esc(text)}</li>`)
        .join("");
      const indicatorTable = `<table class="grid">
<tr><th>Comprehension</th><th>Conversation</th><th>Theory</th></tr>
<tr><td>${list(ind.comp)}</td><td>${list(ind.conv)}</td><td>${list(ind.theory)}</td></tr>
</table>`;
      const matrixTable = `<table class="grid">
<tr><th>Theory focus</th><th>Comprehension focus</th><th>Conversation focus</th><th>Tutor role</th></tr>
<tr><td>${esc(d.matrix.theory)}</td><td>${esc(d.matrix.comprehension)}</td><td>${esc(d.matrix.conversation)}</td><td>${esc(d.matrix.tutorRole)}</td></tr>
</table>`;
      const classLine = n.pathways.length
        ? `${n.core} core classes${n.bridge ? `, ${n.bridge} bridge classes` : ""}${n.readiness ? ", 1 readiness check" : ""}. Focus pathways: ${n.pathways.map(esc).join(", ")} (${n.pathwayCount} classes).`
        : `${n.core} core classes${n.bridge ? `, ${n.bridge} bridge classes` : ""}${n.readiness ? ", 1 readiness check" : ""}. No focus pathways yet.`;

      return `<section class="guide-level" id="guide-${esc(l.phase.toLowerCase())}">
<h2>${esc(l.label)}</h2>
<p class="lead">${esc(l.description)}</p>

<h3>CEFR can-do summary</h3>
<ul>${cefrList}</ul>
<p class="topics">Summarised in our own words from the Council of Europe Common Reference Levels. <a href="${CEFR_SOURCE_URL}" target="_blank" rel="noopener">Read the full descriptors</a>.</p>

<h3>Global Key indicators</h3>
${indicatorTable}

<h3>Level matrix and tutor role</h3>
${matrixTable}

<h3>Lesson balance and talk time</h3>
<p><b>Skeleton timing:</b> ${esc(spec.phases[l.phase].balance)}</p>
<p><b>Talk time:</b> ${esc(d.talk)}</p>

<h3>Classes at this level</h3>
<p>${classLine}</p>
<p><a class="btn" href="${phaseFile[l.phase]}/index.html">Open ${esc(l.phase)} classes</a></p>

<h3>Typical student profile</h3>
${list(d.profile)}

<h3>Moving up</h3>
${list(d.moveUp)}

<h3>Common pitfalls</h3>
${list(d.pitfalls)}
</section>`;
    })
    .join("\n");

  return `<section id="panel-guide" role="tabpanel" aria-labelledby="tab-guide" hidden>
<h2>Level classification guide</h2>
<p class="lead">Use this guide to decide which level a student belongs to, what each level needs from you as a tutor, and when a student is ready to move up. It draws on the CEFR levels and the Global Key standard.</p>

<h2>Levels side by side</h2>
${comparison}

${sections}

<h2>Placement at a glance</h2>
<p>Use the Placement tab to score a new student. Use this guide to check your reasoning:</p>
<ul>
<li>Speaking and grammar scores decide the level. Listening can place a student one level higher.</li>
<li>When listening is strong but speaking and grammar are weak, use the mixed skill rule.</li>
<li>Re-test after a few weeks before moving a student up. Do not move a student up after a single good session.</li>
</ul>

<p class="footer">CEFR summaries: Council of Europe, Common European Framework of Reference for Languages, Common Reference Levels (Global Scale). Global Key indicators and matrix: Global Key Curriculum Framework.</p>
</section>`;
}

// ---------- Warm-up and Filler Bank ----------

const FILLERS = JSON.parse(readFileSync(join(root, "data-fillers", "fillers.json"), "utf8"));
const FILLER_LEVELS = ["Spark", "Flow", "Drive"];
const FILLER_SKILLS = ["Speaking", "Listening", "Vocabulary", "Grammar", "Debate"];
const FILLER_MINUTES = [5, 7, 10];
const FILLER_PREP = ["None", "Few minutes"];

function validateFiller(f) {
  const errors = [];
  const id = f.id ?? "(no id)";
  const err = (msg) => errors.push(`${id}: ${msg}`);
  for (const k of ["id", "name", "level", "skill", "materials", "variation"]) {
    if (typeof f[k] !== "string" || f[k].trim() === "") err(`missing "${k}"`);
  }
  if (!FILLER_LEVELS.includes(f.level)) err(`unknown level "${f.level}"`);
  if (!FILLER_SKILLS.includes(f.skill)) err(`unknown skill "${f.skill}"`);
  if (!FILLER_MINUTES.includes(f.minutes)) err(`minutes must be 5, 7, or 10`);
  if (!FILLER_PREP.includes(f.prep)) err(`prep must be None or Few minutes`);
  if (!Array.isArray(f.steps) || f.steps.length < 2) err(`needs at least 2 steps`);
  for (const text of allStrings(f)) {
    if (placeholderPattern.test(text)) {
      err(`placeholder or bracket text found: "${text.slice(0, 60)}"`);
      break;
    }
  }
  return errors;
}

function fillerText(f) {
  const steps = f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `${f.name}\n${f.level} | ${f.skill} | ${f.minutes} minutes | Prep: ${f.prep}\nMaterials: ${f.materials}\n\n${steps}\n\nVariation: ${f.variation}`;
}

function fillerPanel() {
  const levelOptions = FILLER_LEVELS.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  const skillOptions = FILLER_SKILLS.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  const cards = FILLERS.map((f) => {
    const search = [f.name, f.level, f.skill, `${f.minutes} minutes`, f.materials, ...f.steps, f.variation].join(" ").toLowerCase();
    return `<article class="fb-card" data-level="${esc(f.level)}" data-skill="${esc(f.skill)}" data-time="${f.minutes}" data-search="${esc(search)}">
<div><b>${esc(f.name)}</b> <span class="fb-meta">${esc(f.level)} &middot; ${esc(f.skill)} &middot; ${f.minutes} min &middot; Prep: ${esc(f.prep)}</span></div>
<p class="topics" style="margin:4px 0;">Materials: ${esc(f.materials)}</p>
<ol style="margin:6px 0 6px 20px;padding:0;">${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<p style="margin:4px 0;"><b>Variation:</b> ${esc(f.variation)}</p>
<button type="button" class="pb-btn fb-copy" data-copy="${esc(f.id)}">Copy</button>
<div hidden id="fbt-${esc(f.id)}">${esc(fillerText(f))}</div>
</article>`;
  }).join("\n");

  return `<section id="panel-fillers" role="tabpanel" aria-labelledby="tab-fillers" hidden>
<h2>Warm-up and filler bank</h2>
<p class="lead">Low-prep activities of 5 to 10 minutes, for warm-ups, spare minutes, and closing. Filter by level, skill, or time, or search by keyword. Copy an activity to use it in a lesson.</p>
<div class="controls">
<input id="fb-q" type="search" class="sel" placeholder="Search activities" autocomplete="off" style="min-width:260px">
<select id="fb-level" class="sel" aria-label="Filter by level"><option value="">All levels</option>${levelOptions}</select>
<select id="fb-skill" class="sel" aria-label="Filter by skill"><option value="">All skills</option>${skillOptions}</select>
<select id="fb-time" class="sel" aria-label="Filter by time"><option value="">Any time</option><option value="5">5 minutes</option><option value="7">7 minutes</option><option value="10">10 minutes</option></select>
</div>
<p id="fb-count" class="topics">Showing ${FILLERS.length} of ${FILLERS.length} activities</p>
<div id="fb-list">
${cards}
</div>
<p id="fb-empty" class="empty">No activities match. Try a shorter search, or clear one of the filters.</p>
</section>`;
}

const fillerScript = `
(function () {
  var q = document.getElementById("fb-q");
  var lv = document.getElementById("fb-level");
  var sk = document.getElementById("fb-skill");
  var tm = document.getElementById("fb-time");
  var count = document.getElementById("fb-count");
  var empty = document.getElementById("fb-empty");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".fb-card"));

  function filter() {
    var words = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (c) {
      var ok = (!lv.value || c.getAttribute("data-level") === lv.value) &&
        (!sk.value || c.getAttribute("data-skill") === sk.value) &&
        (!tm.value || c.getAttribute("data-time") === tm.value) &&
        words.every(function (w) { return c.getAttribute("data-search").indexOf(w) !== -1; });
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = "Showing " + shown + " of " + cards.length + " activities";
    empty.style.display = shown === 0 ? "block" : "none";
  }

  function copyText(text, button) {
    var done = function () {
      var label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = label; }, 1500);
    };
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); done(); } catch (e) { button.textContent = "Copy failed"; }
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  document.addEventListener("click", function (e) {
    var b = e.target;
    if (b && b.classList && b.classList.contains("fb-copy")) {
      var src = document.getElementById("fbt-" + b.getAttribute("data-copy"));
      if (src) copyText(src.textContent, b);
    }
  });

  [q, lv, sk, tm].forEach(function (el) {
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", filter);
  });
  filter();
})();
`;

// ---------- Quick Reference (grammar, pronunciation, false friends) ----------

const QUICK_REF = JSON.parse(readFileSync(join(root, "data-reference", "quick-reference.json"), "utf8"));
const QR_TYPES = ["Grammar", "Pronunciation", "False friend"];
const QR_TOPICS = ["Tenses", "Verbs", "Quantity", "Questions", "Negatives", "Word order", "Vowels", "Consonants", "Stress", "Word meaning"];

function validateReference(r) {
  const errors = [];
  const id = r.id ?? "(no id)";
  const err = (msg) => errors.push(`${id}: ${msg}`);
  for (const k of ["id", "question", "answer", "mistake"]) {
    if (typeof r[k] !== "string" || r[k].trim() === "") err(`missing "${k}"`);
  }
  if (!QR_TYPES.includes(r.type)) err(`unknown type "${r.type}"`);
  if (!QR_TOPICS.includes(r.topic)) err(`unknown topic "${r.topic}"`);
  if (!Array.isArray(r.examples) || r.examples.length < 1) err(`needs at least 1 example`);
  for (const text of allStrings(r)) {
    if (placeholderPattern.test(text)) {
      err(`placeholder or bracket text found: "${text.slice(0, 60)}"`);
      break;
    }
  }
  return errors;
}

function quickRefPanel() {
  const typeOptions = QR_TYPES.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const topicOptions = QR_TOPICS.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const cards = QUICK_REF.map((r) => {
    const search = [r.question, r.answer, r.type, r.topic, ...r.examples, r.mistake, r.tip ?? ""].join(" ").toLowerCase();
    const text = `${r.question}\n${r.type} | ${r.topic}\n\nAnswer: ${r.answer}\n\nExamples:\n${r.examples.map((e) => `- ${e}`).join("\n")}\n\nCommon mistake: ${r.mistake}${r.tip ? `\nTip: ${r.tip}` : ""}`;
    return `<article class="qr-card" data-type="${esc(r.type)}" data-topic="${esc(r.topic)}" data-search="${esc(search)}">
<div><b>${esc(r.question)}</b> <span class="fb-meta">${esc(r.type)} &middot; ${esc(r.topic)}</span></div>
<p style="margin:6px 0;"><b>Answer:</b> ${esc(r.answer)}</p>
<ul style="margin:4px 0 6px 20px;padding:0;">${r.examples.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
<p style="margin:4px 0;"><b>Common mistake:</b> ${esc(r.mistake)}</p>
${r.tip ? `<p style="margin:4px 0;"><b>Tip:</b> ${esc(r.tip)}</p>` : ""}
<button type="button" class="pb-btn qr-copy" data-copy="${esc(r.id)}">Copy</button>
<div hidden id="qrt-${esc(r.id)}">${esc(text)}</div>
</article>`;
  }).join("\n");

  return `<section id="panel-reference" role="tabpanel" aria-labelledby="tab-reference" hidden>
<h2>Quick reference</h2>
<p class="lead">Use this when a student asks "why do we say this and not that?", or struggles with a sound. Each card gives the answer, examples, the usual mistake for Spanish speakers, and a tip. Search, filter by type or topic, and copy a card.</p>
<div class="controls">
<input id="qr-q" type="search" class="sel" placeholder="Search, e.g. for, actually, sheep, think" autocomplete="off" style="min-width:260px">
<select id="qr-type" class="sel" aria-label="Filter by type"><option value="">All types</option>${typeOptions}</select>
<select id="qr-topic" class="sel" aria-label="Filter by topic"><option value="">All topics</option>${topicOptions}</select>
</div>
<p id="qr-count" class="topics">Showing ${QUICK_REF.length} of ${QUICK_REF.length} entries</p>
<div id="qr-list">
${cards}
</div>
<p id="qr-empty" class="empty">No entries match. Try a shorter search, or clear one of the filters.</p>
</section>`;
}

const quickRefScript = `
(function () {
  var q = document.getElementById("qr-q");
  var type = document.getElementById("qr-type");
  var topic = document.getElementById("qr-topic");
  var count = document.getElementById("qr-count");
  var empty = document.getElementById("qr-empty");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".qr-card"));

  function filter() {
    var words = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (c) {
      var ok = (!type.value || c.getAttribute("data-type") === type.value) &&
        (!topic.value || c.getAttribute("data-topic") === topic.value) &&
        words.every(function (w) { return c.getAttribute("data-search").indexOf(w) !== -1; });
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = "Showing " + shown + " of " + cards.length + " entries";
    empty.style.display = shown === 0 ? "block" : "none";
  }

  function copyText(text, button) {
    var done = function () {
      var label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = label; }, 1500);
    };
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); done(); } catch (e) { button.textContent = "Copy failed"; }
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  document.addEventListener("click", function (e) {
    var b = e.target;
    if (b && b.classList && b.classList.contains("qr-copy")) {
      var src = document.getElementById("qrt-" + b.getAttribute("data-copy"));
      if (src) copyText(src.textContent, b);
    }
  });

  [q, type, topic].forEach(function (el) {
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", filter);
  });
  filter();
})();
`;

function renderHub(allClasses) {
  const core = allClasses.filter((c) => !c.pathway);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Teachers Hub &middot; Global Key</title>
<style>${indexStyle}</style></head>
<body>
<p class="kicker">Global Key</p>
<h1>Teachers Hub</h1>
<p class="lead">Find classes, place new students, and plan a course. Every lesson is 30 minutes.</p>

<div class="tabs" role="tablist" aria-label="Teachers Hub sections">
<button class="tab" role="tab" id="tab-classes" data-tab="classes" aria-controls="panel-classes" aria-selected="true">Classes</button>
<button class="tab" role="tab" id="tab-placement" data-tab="placement" aria-controls="panel-placement" aria-selected="false">Placement &amp; Curriculum</button>
<button class="tab" role="tab" id="tab-plan" data-tab="plan" aria-controls="panel-plan" aria-selected="false">Plan Builder</button>
<button class="tab" role="tab" id="tab-guide" data-tab="guide" aria-controls="panel-guide" aria-selected="false">Level Guide</button>
<button class="tab" role="tab" id="tab-fillers" data-tab="fillers" aria-controls="panel-fillers" aria-selected="false">Filler Bank</button>
<button class="tab" role="tab" id="tab-reference" data-tab="reference" aria-controls="panel-reference" aria-selected="false">Quick Reference</button>
</div>

${classesPanel(allClasses)}

<section id="panel-placement" role="tabpanel" aria-labelledby="tab-placement" hidden>
${placementSection()}
${curriculumSection(core)}
</section>

${planPanel()}

${levelGuidePanel(allClasses)}

${fillerPanel()}

${quickRefPanel()}

<p class="footer">Global Key &middot; 3-Pillar Curriculum Framework</p>
<script>window.PB_CATALOGUE = ${JSON.stringify(toCatalogue(allClasses, TOPICS_BY_ID)).replace(/</g, "\\u003c")};</script>
<script>window.PB_STUDENT = ${JSON.stringify(toStudentCatalogue(allClasses)).replace(/</g, "\\u003c")};</script>
<script>window.PB_SKELETONS = ${JSON.stringify(toSkeletons(allClasses)).replace(/</g, "\\u003c")};</script>
<script>window.PB_PHASES = ${JSON.stringify({ stageOrder: spec.stageOrder, stageLabels: spec.stageLabels, phases: spec.phases }).replace(/</g, "\\u003c")};</script>
<script>${PLAN_ENGINE_JS}</script>
<script>${STUDENT_EXPORT_JS}</script>
<script>${AI_PROMPT_JS}</script>
<script>${PLAN_UI_JS}</script>
<script>${indexScript}</script>
<script>${tabsScript}</script>
<script>${scorerScript}</script>
<script>${fillerScript}</script>
<script>${quickRefScript}</script>
</body></html>`;
}

function renderLevel(phase, all) {
  const level = levels.find((l) => l.phase === phase);
  const core = all
    .filter((c) => c.phase === phase && !c.pathway)
    .sort((a, b) => a.number - b.number);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(phase)} classes &middot; Teachers Hub</title>
<style>${indexStyle}</style></head>
<body>
<nav class="nav"><a class="btn" href="../index.html">&larr; Teachers Hub</a></nav>
<p class="kicker">${esc(phase)} &middot; ${esc(level.cefrNote)}</p>
<h1>${esc(phase)} classes</h1>
<p class="lead">${esc(level.description)} ${core.length} core classes. Search by topic or filter by grammar topic. Open a class to copy it into Google Docs.</p>
<details open>
<summary>Core classes: ${core.length}</summary>
<div>
${controls(core)}
<p id="count">Showing ${core.length} of ${core.length} classes</p>
${catalogTable(core, { homeLinks: false, showLevel: false })}
<p id="empty" class="empty">No classes match your search. Try a shorter word or a different topic.</p>
</div>
</details>
${pathwayDetails(phase, all, { homeLinks: false }) || ""}
<p class="footer">Global Key &middot; 3-Pillar Curriculum Framework</p>
<script>${indexScript}</script>
</body></html>`;
}

// ---------- Main ----------

const mode = process.argv[2] ?? "validate";
const classes = loadClasses();
let failures = 0;
const seen = new Set();

for (const cls of classes) {
  const errs = validate(cls);
  if (seen.has(cls.id)) errs.push(`${cls.id}: duplicate id`);
  seen.add(cls.id);
  if (errs.length) {
    failures++;
    errs.forEach((e) => console.log("FAIL", e));
  }
}

for (const f of FILLERS) {
  const errs = validateFiller(f);
  if (errs.length) {
    failures++;
    errs.forEach((e) => console.log("FAIL", e));
  }
}

for (const r of QUICK_REF) {
  const errs = validateReference(r);
  if (errs.length) {
    failures++;
    errs.forEach((e) => console.log("FAIL", e));
  }
}

console.log(`Checked ${classes.length} classes, ${FILLERS.length} filler activities, and ${QUICK_REF.length} reference entries: ${classes.length + FILLERS.length + QUICK_REF.length - failures} passing, ${failures} failing.`);

if (mode === "build") {
  if (failures > 0) {
    console.log("Build stopped: fix failing classes first.");
    process.exit(1);
  }
  const outDir = join(root, "out");
  for (const cls of classes) {
    const dir = join(outDir, phaseFile[cls.phase]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${cls.id}.html`), render(cls), "utf8");
  }
  writeFileSync(join(outDir, "index.html"), renderHub(classes), "utf8");
  for (const l of levels) {
    writeFileSync(join(outDir, phaseFile[l.phase], "index.html"), renderLevel(l.phase, classes), "utf8");
  }
  console.log(`Built ${classes.length} class files, the Teachers Hub, and ${levels.length} level pages`);
}
