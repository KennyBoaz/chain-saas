/* Shared marketing-site pieces: nav, footer, live plans. EDIT THE CONFIG BLOCK. */
(function () {
  "use strict";
  var CONFIG = {
    brand: "Chain Innovations",
    app: "/chain-saas",              // where the app lives (login, signup, API)
    pages: [["pricing.html", "Pricing"]],   // add ["product.html","Product"], ["contact.html","Contact"], ["blog.html","Blog"] as they are built
    // contact details used by the footer (leave a value empty to hide it)
    email: "", phone: "", whatsapp: ""
  };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
  var here = location.pathname.split("/").pop() || "index.html";

  var nav = document.getElementById("nav");
  if (nav) nav.outerHTML = '<div class="nav"><div class="wrap"><a class="logo" href="index.html">' + LINK + esc(CONFIG.brand) + '</a><nav aria-label="Main">' +
    CONFIG.pages.map(function (p) { return '<a href="' + p[0] + '"' + (p[0] === here ? ' class="on"' : "") + ">" + p[1] + "</a>"; }).join("") +
    '</nav><div class="cta"><a class="btn ghost" href="' + CONFIG.app + '/site/login.html">Log in</a><a class="btn" href="' + CONFIG.app + '/site/signup.html">Start free</a></div></div></div>';

  var foot = document.getElementById("footer");
  if (foot) foot.outerHTML = '<footer><div class="wrap"><div><a class="logo" href="index.html">' + LINK + esc(CONFIG.brand) + "</a><p>WhatsApp assistants for businesses that answer every customer.</p></div>" +
    "<div><h4>Company</h4>" + CONFIG.pages.map(function (p) { return '<a href="' + p[0] + '">' + p[1] + "</a>"; }).join("") + '<a href="' + CONFIG.app + '/site/login.html">Log in</a><a href="' + CONFIG.app + '/site/signup.html">Sign up</a></div>' +
    "<div><h4>Legal</h4><a href=\"" + CONFIG.app + '/site/terms.html">Terms of Service</a><a href="' + CONFIG.app + '/site/privacy.html">Privacy Policy</a><a href="' + CONFIG.app + '/site/data-deletion.html">Data deletion</a>' +
    (CONFIG.email ? '<a href="mailto:' + esc(CONFIG.email) + '">' + esc(CONFIG.email) + "</a>" : "") + (CONFIG.phone ? '<a href="tel:' + esc(CONFIG.phone) + '">' + esc(CONFIG.phone) + "</a>" : "") +
    (CONFIG.whatsapp ? '<a href="https://wa.me/' + esc(CONFIG.whatsapp) + '">WhatsApp us</a>' : "") + "</div>" +
    '<div class="legal">&copy; ' + new Date().getFullYear() + " " + esc(CONFIG.brand) + " Company Limited. All rights reserved.</div></div></footer>";

  // ---------- live plans from the app's public API ----------
  function obj(v) { if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { v = {}; } } return v && typeof v === "object" ? v : {}; }
  var money = function (n) { return Number(n || 0).toLocaleString("en-US"); };
  function featuresOf(plan) {
    var f = obj(plan.features_json), out = [];
    if (Array.isArray(f)) return f.map(String);
    Object.keys(f).forEach(function (k) { if (f[k]) out.push(k.replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); })); });
    return out;
  }
  function limitLines(plan) {
    var l = obj(plan.limits_json), out = [];
    if (l.messages_per_month) out.push(money(l.messages_per_month) + " messages a month");
    if (l.staff_seats) out.push(l.staff_seats + (l.staff_seats === 1 ? " team seat" : " team seats"));
    if (l.whatsapp_numbers) out.push(l.whatsapp_numbers + (l.whatsapp_numbers === 1 ? " WhatsApp number" : " WhatsApp numbers"));
    return out;
  }
  window.ChainSite = {
    loadPlans: function (cb) {
      fetch(CONFIG.app + "/api/billing/plans").then(function (r) { return r.json(); }).then(function (d) { cb(d.plans || []); }, function () { cb([]); });
    },
    planCards: function (plans) {
      var pop = plans.length >= 3 ? 1 : -1;
      return plans.map(function (p, i) {
        return '<div class="plan' + (i === pop ? " pop" : "") + '">' + (i === pop ? '<span class="badge">Most chosen</span>' : "") + "<h3>" + esc(p.name) + '</h3><div class="price">' + money(p.amount_ugx) + ' <small>UGX / ' + (p.billing_cycle === "yearly" ? "year" : "month") + "</small></div><ul>" +
          limitLines(p).concat(featuresOf(p)).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul><a class="btn' + (i === pop ? " gold" : "") + '" href="' + CONFIG.app + "/site/signup.html?plan=" + p.id + '">Choose ' + esc(p.name) + "</a></div>";
      }).join("");
    },
    limitLines: limitLines, featuresOf: featuresOf, esc: esc, money: money,
  };
})();
