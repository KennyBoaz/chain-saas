/* Shared top bar and API helper for the Dashboard and Settings pages. */
(function () {
  "use strict";
  var WC = window.WC, h = WC.h, S = WC.S, BASE = WC.base, icon = WC.icon;
  var Shell = (window.Shell = { user: null, tenant: null, branding: {} });

  Shell.esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  /** path like "/tenant/overview". Sends the CSRF token on writes; FormData is sent as is. */
  Shell.api = function (method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      init.headers["X-CSRF-Token"] = S.csrf || "";
      if (body instanceof FormData) init.body = body;
      else { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body || {}); }
    }
    return fetch(BASE + "/api" + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) location.href = BASE + "/site/login.html";
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function () { return { ok: false, status: 0, data: { error: "Can't reach the server. Check your internet connection." } }; });
  };

  function parseB(b) {
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    return b && typeof b === "object" ? b : {};
  }

  function logout() {
    Shell.api("POST", "/auth/logout", {}).then(function () {
      try { localStorage.removeItem("csrf"); } catch (e) { /* ignore */ }
      // location.href = BASE + "/site/index.html";
      location.href = "/";
    });
  }

  function topbar(active, name, b) {
    var logo = b.logoUrl ? (/^https?:/.test(b.logoUrl) ? b.logoUrl : BASE + b.logoUrl) : "";
    var text = [h("span", { class: "brand-mark" }, name), h("span", { class: "brand-sub" }, "Console")];
    var brand = h("div", { class: "brand" });
    if (logo) {
      var img = h("img", { class: "brand-logo", src: logo, alt: name });
      img.addEventListener("error", function () { WC.setKids(brand, text); });
      WC.setKids(brand, [img]);
    } else WC.setKids(brand, text);

    var links = [["dashboard", "Dashboard", "box"], ["inbox", "Inbox", "chat"], ["templates", "Templates", "tag"], ["settings", "Settings", "edit"]].map(function (l) {
      return h("a", { class: "tab" + (l[0] === active ? " active" : ""), href: BASE + "/site/" + l[0] + ".html" }, icon(l[2]), h("span", { class: "tl" }, l[1]), h("span", { class: "tl-s" }, l[1]));
    });
    var menu = h("div", { class: "menu hidden", role: "menu" },
      h("div", { class: "who" }, h("b", null, Shell.user.name), h("small", null, Shell.user.email)),
      h("button", { type: "button", role: "menuitem", onClick: logout }, icon("logout"), "Sign out"));
    var btn = h("button", { class: "user-btn", type: "button", "aria-label": "Account menu", onClick: function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); } },
      WC.avatar(Shell.user.name, "u" + Shell.user.id), h("span", { class: "nm" }, Shell.user.name));
    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) menu.classList.add("hidden"); });
    return h("header", { class: "topbar" }, brand, h("nav", { class: "tabs" }, links), h("div", { class: "top-right" }, h("div", { class: "user-wrap" }, btn, menu)));
  }

  /** Loads the signed-in user + tenant, applies branding, draws the page frame, then calls cb(mainElement, tenant). */
  Shell.boot = function (active, cb) {
    Shell.api("GET", "/auth/me").then(function (r) {
      if (!r.ok) return;
      var d = r.data, t = d.tenant || {}, b = parseB(t.branding), root = document.documentElement.style, hex = /^#[0-9a-f]{6}$/i;
      S.csrf = d.csrf || "";
      try { localStorage.setItem("csrf", S.csrf); } catch (e) { /* ignore */ }
      Shell.user = { id: d.user.id, name: d.user.name || d.user.email, email: d.user.email };
      Shell.tenant = t; Shell.branding = b;
      if (hex.test(b.primaryColor || "")) { root.setProperty("--brand", b.primaryColor); root.setProperty("--forest", b.primaryColor); }
      if (hex.test(b.secondaryColor || "")) root.setProperty("--gold", b.secondaryColor);
      document.title = (document.title.split(" · ")[0]) + " · " + (t.name || "");
      var main = h("div", { class: "items-inner" });
      WC.setKids(document.getElementById("app"), [
        b.slogan ? h("div", { class: "announce" }, b.slogan) : null,
        topbar(active, t.name || "Console", b),
        h("main", { class: "main" }, h("div", { class: "items-view" }, main)),
      ]);
      cb(main, t);
    });
  };

  Shell.fail = function (r) { WC.toast((r && r.data && r.data.error) || "Something went wrong.", "error"); };
})();