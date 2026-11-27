// Student-facing learning path document. Plain JavaScript with no dependencies:
// it runs in the browser (as window.StudentExport) and in Node (as module.exports) for tests.
// Input items come from the student catalogue (see toStudentCatalogue), which holds only
// student-visible fields, so tutor-only content cannot appear in the output.

(function (root) {
  var STEPS = [
    { key: "warmup", label: "Warm-up", text: "Talk about a familiar topic to get started." },
    { key: "theory", label: "Language focus", text: null },
    { key: "comprehension", label: "Listening and reading", text: "Read or listen to a short text, then answer questions about it." },
    { key: "conversation", label: "Speaking practice", text: "Take part in a role-play or discussion on this session's topic." },
    { key: "wrapup", label: "Review", text: "Correct your own mistakes and practise the improved sentences." },
  ];
  var PRIORITY_LABELS = ["PRIMARY", "SECONDARY", "INTEGRATED"];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function kindOf(item) {
    if (item.pathway) return "Focus pathway: " + item.pathway;
    if (/readiness/i.test(item.title || "")) return "Readiness check";
    // Last core class number per level; keep in step with CORE_LAST in plan-engine.js.
    var coreLast = { Spark: 16, Flow: 10, Drive: 10 }[item.phase] || 10;
    return item.number <= coreLast ? "Core lesson" : "Bridge lesson";
  }

  function unique(list) {
    var seen = {};
    var out = [];
    list.forEach(function (x) {
      if (x && !seen[x]) {
        seen[x] = true;
        out.push(x);
      }
    });
    return out;
  }

  function priorityRows(items) {
    var pathways = unique(items.map(function (i) { return i.pathway; }));
    if (pathways.length === 0) {
      var levels = unique(items.map(function (i) { return i.phase; }));
      return '<tr><td class="pnum">01</td><td class="plabel">CORE</td><td>Core course: ' + esc(levels.join(", ")) + "</td></tr>";
    }
    return pathways
      .map(function (p, i) {
        var label = PRIORITY_LABELS[i] || "FOCUS";
        return '<tr><td class="pnum">' + String(i + 1).padStart(2, "0") + '</td><td class="plabel">' + label + "</td><td>" + esc(p) + "</td></tr>";
      })
      .join("");
  }

  function sessionHtml(item, index, info) {
    var rows = STEPS.map(function (s) {
      var text = s.key === "theory" ? item.structure : s.text;
      return "<tr><td class=\"step\">" + esc(s.label) + '</td><td class="mins">' + item.minutes[s.key] + " min</td><td>" + esc(text) + "</td></tr>";
    }).join("");
    var phrases = (item.phrases || []).length
      ? "<p class=\"sub\">Target language</p><ul>" + item.phrases.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>"
      : "";
    return '<section class="session">' +
      '<div><span class="num">' + String(index + 1).padStart(2, "0") + '</span><span class="stitle">' + esc(item.title) + "</span></div>" +
      '<p class="tag">' + esc(kindOf(item)) + " &middot; " + esc(item.phase) + " &middot; " + esc(item.cefr) + "</p>" +
      '<p><b>Goal.</b> ' + esc(item.goal) + "</p>" +
      '<table class="acts">' + rows + "</table>" +
      phrases +
      '<div class="evidence"><b>Evidence of progress.</b> ' + esc(item.canDo) + "</div>" +
      '<p class="footer">GLOBAL KEY / PERSONALIZED LEARNING PATH / ' + esc(info.student) + " / " + esc(info.date) + "</p>" +
      "</section>";
  }

  function buildStudentHtml(items, info) {
    info = info || {};
    var student = info.student || "Student";
    var tutor = info.tutor || "";
    var date = info.date || "";
    var total = items.length;
    var levels = unique(items.map(function (i) { return i.phase; }));
    var totalMinutes = items.reduce(function (sum, i) {
      return sum + STEPS.reduce(function (m, s) { return m + i.minutes[s.key]; }, 0);
    }, 0);

    var sessions = items.map(function (item, i) { return sessionHtml(item, i, { student: student, date: date }); }).join("\n");

    return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
      "<title>Personalized learning path: " + esc(student) + "</title>" +
      "<style>" +
      "body{font-family:Calibri,Arial,Helvetica,sans-serif;color:#1d2b3a;margin:0;background:#fff;font-size:11pt;line-height:1.45}" +
      ".banner{background:#EAF1F8;color:#1F4E79;padding:10px 48px;font-size:10pt}" +
      ".banner button{background:#1F4E79;color:#fff;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font-family:inherit}" +
      ".cover{background:#0F2B46;color:#fff;padding:44px 48px 36px}" +
      ".brand{font-weight:bold;font-size:18pt;letter-spacing:1px}" +
      ".bar{width:44px;height:4px;background:#EE8A2F;margin:10px 0 14px}" +
      ".kicker{font-size:9pt;letter-spacing:2px;color:#9fb6cc;text-transform:uppercase}" +
      "h1{font-size:28pt;margin:12px 0 8px;font-weight:bold}" +
      ".sub-line{color:#cfe0ef;font-size:12pt}" +
      ".body{padding:28px 48px 40px;max-width:820px;margin:0 auto}" +
      "h2{color:#0F2B46;font-size:13pt;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid #d9e2ec;text-transform:uppercase;letter-spacing:1px}" +
      "table.info{width:100%;border-collapse:collapse;margin:14px 0}" +
      "table.info td{padding:7px 10px;border-bottom:1px solid #d9e2ec}" +
      "table.info td.k{color:#1F4E79;font-weight:bold;width:150px}" +
      "table.pri{width:100%;border-collapse:collapse}" +
      "table.pri td{padding:9px 10px;border-bottom:1px solid #d9e2ec}" +
      "td.pnum{color:#EE8A2F;font-weight:bold;width:50px}" +
      "td.plabel{color:#1F4E79;font-weight:bold;width:130px;font-size:10pt}" +
      ".session{border:1px solid #d9e2ec;border-left:6px solid #EE8A2F;border-radius:6px;padding:16px 20px;margin:18px 0;page-break-inside:avoid}" +
      ".num{display:inline-block;background:#1F4E79;color:#fff;border-radius:50%;width:32px;height:32px;line-height:32px;text-align:center;font-weight:bold;margin-right:10px;vertical-align:middle}" +
      ".stitle{font-size:14pt;font-weight:bold;color:#0F2B46;vertical-align:middle}" +
      ".tag{color:#EE8A2F;font-size:9pt;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin:4px 0 8px}" +
      "table.acts{width:100%;border-collapse:collapse;margin:8px 0}" +
      "table.acts td{padding:6px 8px;border-bottom:1px solid #e6edf4;vertical-align:top}" +
      "td.step{color:#1F4E79;font-weight:bold;width:150px}" +
      "td.mins{width:60px;color:#5F6B7A}" +
      ".sub{color:#1F4E79;font-weight:bold;margin:10px 0 2px}" +
      ".evidence{background:#F3F7FB;border-radius:4px;padding:10px 12px;margin-top:10px}" +
      ".footer{font-size:8.5pt;color:#6b7b8c;border-top:1px solid #d9e2ec;margin:12px 0 0;padding-top:6px}" +
      "@media print{.banner{display:none}.session{page-break-inside:avoid}}" +
      "</style></head><body>" +
      '<div class="banner no-print">Choose <b>Print</b>, then select <b>Save as PDF</b> as the destination. <button type="button" onclick="window.print()">Print</button></div>' +
      '<div class="cover">' +
      '<div class="brand">GLOBAL KEY</div><div class="bar"></div>' +
      '<div class="kicker">Personalized learning path</div>' +
      "<h1>Your learning path</h1>" +
      '<div class="sub-line">' + total + " sessions &middot; 30 minutes each &middot; " + esc(levels.join(", ")) + "</div>" +
      "</div>" +
      '<div class="body">' +
      '<table class="info">' +
      '<tr><td class="k">Student</td><td>' + esc(student) + "</td></tr>" +
      '<tr><td class="k">Tutor</td><td>' + esc(tutor) + "</td></tr>" +
      '<tr><td class="k">Date</td><td>' + esc(date) + "</td></tr>" +
      '<tr><td class="k">Sessions</td><td>' + total + " (" + totalMinutes + " minutes in total)</td></tr>" +
      "</table>" +
      "<h2>Your priorities</h2>" +
      '<table class="pri">' + priorityRows(items) + "</table>" +
      "<h2>How each session works</h2>" +
      "<p>Every session lasts 30 minutes and follows the same steps: a warm-up, a language focus, listening and reading, speaking practice, and a review of your own mistakes. Each session ends with an evidence-of-progress statement, which shows what you can do after the session.</p>" +
      "<h2>Your sessions</h2>" +
      sessions +
      '<p class="footer">GLOBAL KEY / PERSONALIZED LEARNING PATH / ' + esc(student) + " / " + esc(date) + "</p>" +
      "</div></body></html>";
  }

  var api = { buildStudentHtml: buildStudentHtml, kindOf: kindOf };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.StudentExport = api;
  }
})(typeof window !== "undefined" ? window : this);
