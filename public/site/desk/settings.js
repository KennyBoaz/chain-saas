/* Settings: business profile (hours etc.), assistant prompt, brand, alert contacts. */
(function () {
  "use strict";
  var WC = window.WC, h = WC.h, Shell = window.Shell, esc = Shell.esc, BASE = WC.base;
  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  var tenant, profile, brand, root;

  // "mon-sat 09:00-18:00; sun 10:00-16:00" -> { mon: ["09:00","18:00"], ... }
  function parseHours(text) {
    var out = {};
    String(text || "").split(";").forEach(function (part) {
      var m = part.trim().toLowerCase().match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) return;
      var from = DAYS.indexOf(m[1]), to = m[2] ? DAYS.indexOf(m[2]) : from;
      if (from < 0 || to < 0) return;
      for (var i = from; ; i = (i + 1) % 7) { out[DAYS[i]] = [m[3].padStart(5, "0"), m[4].padStart(5, "0")]; if (i === to) break; }
    });
    return out;
  }

  function save(btn, fn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    Promise.resolve(fn()).then(function (r) {
      if (r && r.ok) WC.toast("Saved.", "ok"); else if (r) Shell.fail(r);
    }).then(function () { btn.disabled = false; btn.textContent = label; });
  }

  function field(label, control, hint) { return WC.field(label, control, hint); }

  function build() {
    var hours = parseHours(profile.hours);
    if (!Object.keys(hours).length) "mon tue wed thu fri sat".split(" ").forEach(function (d) { hours[d] = ["09:00", "18:00"]; });

    // ---- Business profile ----
    var name = h("input", { class: "input", type: "text", maxlength: "190" }); name.value = tenant.business_name || "";
    var rows = DAYS.map(function (d) {
      var on = h("input", { type: "checkbox" }); on.checked = !!hours[d];
      var a = h("input", { class: "input", type: "time" }); a.value = hours[d] ? hours[d][0] : "09:00";
      var b = h("input", { class: "input", type: "time" }); b.value = hours[d] ? hours[d][1] : "18:00";
      return { d: d, on: on, a: a, b: b, el: h("div", { class: "hrow" }, h("label", null, on, NAMES[d]), a, b) };
    });
    var slot = h("select", { class: "input" }, [30, 45, 60, 90, 120].map(function (m) { return h("option", { value: String(m) }, m + " minutes"); }));
    slot.value = String(profile.appointmentMinutes || 60);
    var delivery = h("textarea", { class: "input", placeholder: "e.g. Free delivery in Kampala above UGX 200,000; upcountry by courier." }); delivery.value = profile.delivery || "";
    var payment = h("textarea", { class: "input", placeholder: "e.g. Mobile money, bank transfer and cash on pickup." }); payment.value = profile.payment || "";
    var returns = h("textarea", { class: "input", placeholder: "e.g. Exchanges within 7 days with the receipt." }); returns.value = profile.returns || "";
    var emails = h("textarea", { class: "input", placeholder: "one email per line" }); emails.value = ((profile.alerts || {}).emails || []).join("\n");
    var phones = h("textarea", { class: "input", placeholder: "one phone number per line, e.g. +256700000000" }); phones.value = ((profile.alerts || {}).phones || []).join("\n");

    var profileBtn = h("button", { class: "btn", type: "button", onClick: function () {
      save(profileBtn, function () {
        var parts = rows.filter(function (r) { return r.on.checked && r.a.value && r.b.value; }).map(function (r) { return r.d + " " + r.a.value + "-" + r.b.value; });
        var lines = function (el) { return el.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10); };
        var next = Object.assign({}, profile, { hours: parts.join("; "), appointmentMinutes: Number(slot.value), delivery: delivery.value.trim(), payment: payment.value.trim(), returns: returns.value.trim(), alerts: { emails: lines(emails), phones: lines(phones) } });
        return Shell.api("PUT", "/tenant/profile", { businessName: name.value, businessProfile: next }).then(function (r) { if (r.ok) profile = next; return r; });
      });
    } }, "Save business profile");

    // ---- Assistant prompt ----
    var prompt = h("textarea", { class: "input", style: { minHeight: "260px" }, placeholder: "Describe your business and how the assistant should talk to customers." }); prompt.value = tenant.system_prompt || "";
    var starter = h("button", { class: "btn ghost small", type: "button", onClick: function () {
      if (prompt.value.trim() && !confirm("Replace the current text with the starter template?")) return;
      prompt.value = "You are the WhatsApp assistant for " + (name.value || "our business") + ". You chat with customers directly on WhatsApp on behalf of the business: speak as \"we\", keep messages short (1-3 sentences), warm and professional, and ask one question at a time.\n\n" +
        "ABOUT THE BUSINESS\n- What we sell or do: [describe]\n- Location: [address]\n- Phone / email: [contacts]\n\n" +
        "FREQUENTLY ASKED QUESTIONS\n- Q: [question] A: [answer]\n\n" +
        "YOUR JOB\n1. Answer questions using only the information above.\n2. When a customer wants to buy, collect the items, quantity and delivery details, confirm them back, then place the order.\n3. When a customer wants to visit, check availability and book an appointment.\n4. For complaints, refunds or anything you are unsure about, hand over to the team.\n\n" +
        "Never invent prices, stock, policies or delivery options that are not written here: say you will check with the team instead.";
    } }, "Insert starter template");
    var promptBtn = h("button", { class: "btn", type: "button", onClick: function () { save(promptBtn, function () { return Shell.api("PUT", "/tenant/profile", { systemPrompt: prompt.value }); }); } }, "Save assistant prompt");

    // ---- Brand ----
    var c1 = h("input", { class: "input swatch", type: "color" }); c1.value = brand.primaryColor || "#243b32";
    var c2 = h("input", { class: "input swatch", type: "color" }); c2.value = brand.secondaryColor || "#a8873a";
    var slogan = h("input", { class: "input", type: "text", maxlength: "120", placeholder: "e.g. Quality and Elegance" }); slogan.value = brand.slogan || "";
    var file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
    var brandBtn = h("button", { class: "btn", type: "button", onClick: function () {
      save(brandBtn, function () {
        return Shell.api("PUT", "/tenant/branding", { primaryColor: c1.value, secondaryColor: c2.value, slogan: slogan.value }).then(function (r) {
          if (!r.ok || !file.files[0]) return r;
          var fd = new FormData(); fd.append("logo", file.files[0]);
          return Shell.api("POST", "/tenant/logo", fd);
        });
      });
    } }, "Save brand");

    function panel(id, title, sub, kids) { return h("section", { class: "panel", id: id }, h("h3", null, title), h("p", { class: "sub" }, sub), kids); }

    WC.setKids(root, [
      h("div", { class: "view-head" }, h("div", null, h("h2", null, "Business ", h("em", null, "settings")), h("p", null, "What your assistant knows, how it looks, and who is alerted."))),
      panel("profile", "Business profile", "The assistant uses this to answer about opening hours and to offer appointment times.", [
        field("Business name", name),
        h("div", { class: "form-row" }, h("label", { class: "label" }, "Opening hours (days left unticked count as closed)"), rows.map(function (r) { return r.el; })),
        field("Appointment length", slot),
        field("Delivery", delivery), field("Payment methods", payment), field("Returns and exchanges", returns),
        h("div", { class: "row2" }, field("Alert emails", emails, "Who should be told when a customer needs a person, or places an order."), field("Alert phone numbers", phones, "For SMS alerts, once switched on for your plan.")),
        h("div", { class: "foot" }, profileBtn),
      ]),
      panel("bot", "Assistant prompt", "Describe your business, prices, FAQs and the tone you want. The more specific, the better the replies.", [prompt, h("div", { class: "foot" }, promptBtn, starter)]),
      panel("brand", "Brand", "Colors and logo used across your console.", [
        h("div", { class: "row2" }, field("Primary color", c1), field("Accent color", c2)),
        field("Slogan", slogan, "Shown in the bar at the top of your console."),
        field("Logo", file, brand.logoUrl ? "A logo is already set. Choose a file to replace it." : "PNG, JPG or WebP."),
        h("div", { class: "foot" }, brandBtn),
      ]),
    ]);
    if (location.hash) { var t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }
  }

  Shell.boot("settings", function (main) {
    root = main;
    Shell.api("GET", "/tenant/me").then(function (r) {
      if (!r.ok) return Shell.fail(r);
      tenant = r.data.tenant; profile = tenant.business_profile_json || {}; brand = tenant.branding_json || {};
      build();
    });
  });
})();