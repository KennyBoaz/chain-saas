/* Message templates: list with Meta's review status, create, delete. */
(function () {
  "use strict";
  var WC = window.WC, h = WC.h, Shell = window.Shell, esc = Shell.esc;
  var root, isAdmin = false;
  var LANGS = [["en", "English"], ["en_GB", "English (UK)"], ["en_US", "English (US)"], ["sw", "Swahili"], ["fr", "French"]];
  var CLASS = { APPROVED: "p-open", PENDING: "p-progress", REJECTED: "p-escalated", PAUSED: "p-closed", DISABLED: "p-closed" };

  function render(list) {
    var rows = list.map(function (t) {
      return "<tr><td><b>" + esc(t.name) + '</b><div class="muted" style="font-size:12px;max-width:420px">' + esc(t.body).slice(0, 140) + "</div>" + (t.rejected_reason && t.rejected_reason !== "NONE" ? '<div style="color:var(--danger);font-size:12px">Reason: ' + esc(t.rejected_reason) + "</div>" : "") + "</td><td>" + esc(t.language) + "</td><td>" + esc(t.category || "") +
        '</td><td><span class="pill ' + (CLASS[t.status] || "") + '">' + esc(t.status.toLowerCase()) + "</span></td><td class=\"actions\">" +
        (isAdmin ? '<button class="btn ghost small" data-del="' + esc(t.name) + '">Delete</button>' : "") + "</td></tr>";
    }).join("");
    root.querySelector("#list").innerHTML = list.length
      ? '<div class="table-wrap"><table class="table"><thead><tr><th>Template</th><th>Language</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      : '<div class="empty-state"><h3>No templates yet</h3><p>Templates let you message a customer after the 24-hour window has closed.</p></div>';
  }

  function load() {
    Shell.api("GET", "/templates").then(function (r) {
      if (!r.ok) { root.querySelector("#list").innerHTML = '<div class="empty-state"><h3>Not available yet</h3><p>' + esc((r.data && r.data.error) || "Could not load templates.") + "</p></div>"; return; }
      render(r.data.templates || []);
    });
  }

  function create() {
    var name = h("input", { class: "input", type: "text", maxlength: "60", placeholder: "order_ready" });
    var category = h("select", { class: "input" }, h("option", { value: "UTILITY" }, "Utility (order updates, bookings, reminders)"), h("option", { value: "MARKETING" }, "Marketing (offers, announcements)"));
    var language = h("select", { class: "input" }, LANGS.map(function (l) { return h("option", { value: l[0] }, l[1]); }));
    var header = h("input", { class: "input", type: "text", maxlength: "60", placeholder: "Optional short title" });
    var body = h("textarea", { class: "input", maxlength: "1024", placeholder: "Hello {{1}}, your order {{2}} is ready for pickup." });
    var footer = h("input", { class: "input", type: "text", maxlength: "60", placeholder: "Optional, e.g. Reply STOP to opt out" });
    var exBox = h("div"), exInputs = [];
    function drawExamples() {
      var nums = (body.value.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(function (m) { return Number(m.replace(/\D/g, "")); });
      var n = nums.length ? Math.max.apply(null, nums) : 0, old = exInputs.map(function (i) { return i.value; });
      exInputs = [];
      WC.setKids(exBox, []);
      for (var i = 1; i <= n; i += 1) { var inp = h("input", { class: "input", type: "text", maxlength: "100", placeholder: "Example for {{" + i + "}}" }); inp.value = old[i - 1] || ""; exInputs.push(inp); exBox.appendChild(WC.field("{{" + i + "}} example", inp)); }
    }
    body.addEventListener("input", drawExamples);

    WC.dialog({
      title: "New message template", wide: true,
      body: [WC.field("Name", name, "Lowercase letters, numbers and underscores."), h("div", { class: "row2" }, WC.field("Category", category), WC.field("Language", language)),
        WC.field("Header", header), WC.field("Message", body, "Use {{1}}, {{2}} for details that change, such as a name or order number."), exBox, WC.field("Footer", footer)],
      actions: [{ label: "Cancel", kind: "ghost" }, {
        label: "Submit for approval",
        onClick: function (dlg) {
          return Shell.api("POST", "/templates", { name: name.value.trim(), category: category.value, language: language.value, header: header.value, body: body.value, footer: footer.value, examples: exInputs.map(function (i) { return i.value; }) }).then(function (r) {
            if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not create the template."); return false; }
            WC.toast("Submitted. WhatsApp usually reviews templates within minutes to a day.", "ok");
            load();
          });
        },
      }],
    });
  }

  Shell.boot("templates", function (main) {
    root = main;
    isAdmin = true; // only tenant admins can open this console section
    main.innerHTML = '<div class="view-head"><div><h2>Message <em>templates</em></h2><p>Pre-approved messages for reaching customers after the 24-hour window closes.</p></div><button class="btn" id="new">New template</button></div><div id="list"></div>';
    main.querySelector("#new").addEventListener("click", create);
    main.addEventListener("click", function (e) {
      var b = e.target.closest("[data-del]");
      if (!b) return;
      WC.confirm("Delete this template?", "It is removed from your WhatsApp account and can no longer be sent.", "Delete", "danger").then(function (yes) {
        if (!yes) return;
        Shell.api("DELETE", "/templates/" + encodeURIComponent(b.dataset.del)).then(function (r) { if (!r.ok) return Shell.fail(r); WC.toast("Deleted."); load(); });
      });
    });
    load();
  });
})();