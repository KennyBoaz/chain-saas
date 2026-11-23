/* Desk shell for Chain SaaS (replaces the old admin-app.js): tenant branding, tabs, live updates, alerts. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, R = WC.R, api = WC.api, icon = WC.icon, setKids = WC.setKids, BASE = WC.base;

  var TABS = [["chats", "Chats", "chat"], ["issues", "Tickets", "ticket"], ["orders", "Orders", "box"], ["appointments", "Appointments", "calendar", "Visits"]];
  var info = { name: "Inbox", slogan: "", logo: "", status: "active" };
  var baseTitle = "Inbox", pollTimer = null, pollCount = 0, snapshot = null, alertsOn = false, audioCtx = null, loggedOut = true;

  function toLogin() { location.href = BASE + "/site/login.html"; }
  WC.onUnauthorized = function () { if (!loggedOut) toLogin(); };

  // ---------------- branding ----------------
  function parseBranding(b) {
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    return b && typeof b === "object" ? b : {};
  }
  function applyBranding(b) {
    var root = document.documentElement.style, hex = /^#[0-9a-f]{6}$/i;
    if (hex.test(b.primaryColor || "")) { root.setProperty("--brand", b.primaryColor); root.setProperty("--forest", b.primaryColor); }
    if (hex.test(b.secondaryColor || "")) root.setProperty("--gold", b.secondaryColor);
    info.slogan = b.slogan || "";
    info.logo = b.logoUrl ? (/^https?:/.test(b.logoUrl) ? b.logoUrl : BASE + b.logoUrl) : "";
  }

  function brand() {
    var wrap = h("div", { class: "brand" });
    var text = [h("span", { class: "brand-mark" }, info.name), h("span", { class: "brand-sub" }, "Desk")];
    if (info.logo) {
      var img = h("img", { class: "brand-logo", src: info.logo, alt: info.name });
      img.addEventListener("error", function () { setKids(wrap, text); });
      setKids(wrap, [img, h("span", { class: "brand-sub" }, "Desk")]);
    } else setKids(wrap, text);
    return wrap;
  }

  // ---------------- shell ----------------
  function userMenu() {
    var menu = h("div", { class: "menu hidden", role: "menu" },
      h("div", { class: "who" }, h("b", null, S.user.name), h("small", null, S.user.email + " · " + (S.user.role === "admin" ? "Admin" : "Staff"))),
      h("button", { type: "button", role: "menuitem", onClick: function () { location.href = BASE + "/site/dashboard.html"; } }, icon("box"), "Dashboard"),
      h("button", { type: "button", role: "menuitem", onClick: function () { location.href = BASE + "/site/settings.html"; } }, icon("edit"), "Settings"),
      h("button", { type: "button", role: "menuitem", onClick: logout }, icon("logout"), "Sign out"));
    var btn = h("button", { class: "user-btn", type: "button", "aria-haspopup": "menu", "aria-label": "Account menu", onClick: function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); } },
      WC.avatar(S.user.name, "u" + S.user.id), h("span", { class: "nm" }, S.user.name));
    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) menu.classList.add("hidden"); });
    return h("div", { class: "user-wrap" }, btn, menu);
  }

  function logout() {
    api("POST", "/auth/logout", {}, { keepOn401: true }).then(function () {
      try { localStorage.removeItem("csrf"); } catch (e) { /* ignore */ }
      location.href = BASE + "/site/index.html";
    });
  }

  function startApp() {
    loggedOut = false;
    baseTitle = info.name + " · Inbox";
    try { alertsOn = localStorage.getItem("wc_alerts") === "on"; } catch (e) { alertsOn = false; }

    R.tabButtons = {};
    var tabBar = h("nav", { class: "tabs", "aria-label": "Sections" }, TABS.map(function (t) {
      var badge = h("span", { class: "badge hidden" });
      var btn = h("button", { class: "tab", type: "button", onClick: function () { WC.showTab(t[0]); } }, icon(t[2]), h("span", { class: "tl" }, t[1]), h("span", { class: "tl-s" }, t[3] || t[1]), badge);
      R.tabButtons[t[0]] = { btn: btn, badge: badge };
      return btn;
    }));

    R.live = h("span", { class: "live" });
    R.liveText = h("span", { class: "lt" }, "Live");
    R.live.appendChild(R.liveText);
    R.alertsBtn = h("button", { class: "btn ghost small alerts-btn", type: "button", onClick: toggleAlerts });
    renderAlertsButton();

    var topbar = h("header", { class: "topbar" }, brand(), tabBar, h("div", { class: "top-right" }, R.live, R.alertsBtn, userMenu()));
    R.views = { chats: h("div", { class: "view chats-view" }, WC.buildChats()) };
    ["issues", "orders", "appointments"].forEach(function (k) { R.views[k] = h("div", { class: "view" }, WC.buildItems(k)); });
    var main = h("main", { class: "main" }, Object.keys(R.views).map(function (k) { return R.views[k]; }));

    var notice = info.status !== "active"
      ? h("div", { class: "notice inactive" }, "This account is not active, so the bot is not answering customers. Open the Dashboard to activate it.")
      : null;
    setKids(document.getElementById("app"), [info.slogan ? h("div", { class: "announce" }, info.slogan) : null, topbar, notice, main]);
    WC.showTab("chats");
    WC.loadChats(true);
    WC.refreshSummary();
    refreshSnapshot();
    schedulePoll();

    var m = location.hash.match(/^#chat=(\d{6,20})$/);
    if (m) WC.openChat(m[1]);
  }

  WC.showTab = function (name) {
    if (!R.views || !R.views[name]) return;
    S.tab = name;
    Object.keys(R.views).forEach(function (k) {
      R.views[k].classList.toggle("active", k === name);
      R.tabButtons[k].btn.classList.toggle("active", k === name);
    });
    document.body.classList.toggle("chat-open", name === "chats" && !!S.chats.selected);
    if (S.items[name]) { if (!S.items[name].loaded) WC.loadItems(name, true); else WC.refreshItems(name); }
    if (name === "chats") WC.refreshChatList();
  };

  // ---------------- live updates ----------------
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll() { stopPolling(); pollTimer = setTimeout(pollOnce, document.hidden ? WC.config.POLL_HIDDEN_MS : WC.config.POLL_MS); }

  function pollOnce() {
    if (loggedOut) return;
    pollCount += 1;
    var jobs = [WC.refreshSummary()];
    if (S.chats.selected) jobs.push(WC.pollThread());
    WC.tickWindow();
    if (pollCount % 4 === 0) {
      if (S.tab === "chats") jobs.push(WC.refreshChatList()); else if (S.items[S.tab]) jobs.push(WC.refreshItems(S.tab));
    }
    function done() { if (!loggedOut) schedulePoll(); }
    Promise.all(jobs).then(done, done);
  }

  document.addEventListener("visibilitychange", function () { if (!loggedOut && !document.hidden) { stopPolling(); pollOnce(); } });
  window.addEventListener("focus", function () { if (!loggedOut) WC.autoRead(); });

  var WATCH = ["last_message_id", "last_incoming_message_id", "unread_chats", "unread_needing_staff", "escalated_chats", "human_chats", "new_issues", "new_orders", "new_appointments", "last_issue_id", "last_order_id", "last_appointment_id"];

  WC.refreshSummary = function () {
    return api("GET", "/summary").then(function (r) {
      if (!r.ok) return;
      var prev = S.summary, cur = r.data.summary;
      S.summary = cur;
      updateBadges();
      WC.renderChips();
      if (prev && WATCH.some(function (k) { return prev[k] !== cur[k]; })) return onNews(prev, cur);
    });
  };

  function updateBadges() {
    var sm = S.summary || {};
    var counts = { chats: sm.unread_needing_staff, issues: sm.new_issues, orders: sm.new_orders, appointments: sm.new_appointments };
    Object.keys(R.tabButtons || {}).forEach(function (k) {
      var n = counts[k] || 0, b = R.tabButtons[k].badge;
      b.textContent = n > 99 ? "99+" : n;
      b.classList.toggle("hidden", !n);
    });
    var total = (counts.chats || 0) + (counts.issues || 0) + (counts.orders || 0) + (counts.appointments || 0);
    document.title = (total ? "(" + total + ") " : "") + baseTitle;
  }

  function onNews(prev, cur) {
    var jobs = [];
    if (S.tab === "chats") jobs.push(WC.refreshChatList().then(function () { return WC.autoRead(); }));
    if (S.chats.selected) jobs.push(WC.refreshDetail());
    ["issues", "orders", "appointments"].forEach(function (k) { if (S.tab === k) jobs.push(WC.refreshItems(k)); });
    jobs.push(refreshSnapshot().then(chatAlerts));
    if (cur.last_issue_id > prev.last_issue_id) jobs.push(itemAlerts("issues", prev.last_issue_id));
    if (cur.last_order_id > prev.last_order_id) jobs.push(itemAlerts("orders", prev.last_order_id));
    if (cur.last_appointment_id > prev.last_appointment_id) jobs.push(itemAlerts("appointments", prev.last_appointment_id));
    return Promise.all(jobs);
  }

  // ---------------- alerts: chime + notification + toast ----------------
  function refreshSnapshot() {
    return api("GET", "/conversations?filter=active&limit=50").then(function (r) {
      var prev = snapshot;
      if (r.ok) snapshot = r.data.conversations || [];
      return { prev: prev, now: snapshot };
    });
  }

  function chatAlerts(res) {
    if (!res.prev || !res.now) return;
    var before = {};
    res.prev.forEach(function (c) { before[c.phone] = c; });
    res.now.forEach(function (c) {
      var p = before[c.phone], label = c.name || WC.phone(c.phone);
      var looking = S.chats.selected === c.phone && document.visibilityState === "visible" && document.hasFocus();
      if (c.status === "escalated" && (!p || p.status !== "escalated")) notify("Needs a person", label + " asked to speak to the team.", "esc-" + c.phone, c.phone);
      else if ((c.mode === "human" || c.status === "escalated") && c.unread_count > (p ? p.unread_count : 0) && !looking) notify(label, c.last_message_preview || "New message", "msg-" + c.phone, c.phone);
    });
  }

  function itemAlerts(kind, afterId) {
    return api("GET", "/" + kind + "?status=new&limit=5").then(function (r) {
      if (!r.ok) return;
      (r.data[kind] || []).filter(function (it) { return it.id > afterId; }).reverse().forEach(function (it) {
        var who = it.customer_name || it.chat_name || WC.phone(it.phone);
        if (kind === "orders") notify("New order", (it.items || []).join(", ") + " · " + who, "order-" + it.id, it.phone);
        else if (kind === "appointments") notify("New appointment request", [it.appt_date, it.appt_time].filter(Boolean).join(" ") + " · " + who, "appt-" + it.id, it.phone);
        else if (it.type === "inquiry") notify("New inquiry", (it.summary || "") + " · " + who, "issue-" + it.id, it.phone);
        else if (it.type !== "escalation") notify("New support ticket", (it.summary || "") + " · " + who, "issue-" + it.id, it.phone);
      });
    });
  }

  function notify(title, body, tag, phone) {
    if (document.visibilityState === "visible") WC.toast(title + ": " + body);
    if (!alertsOn) return;
    chime();
    if ("Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
      try {
        var n = new Notification(title, { body: body, tag: tag });
        n.onclick = function () { window.focus(); if (phone) WC.openChat(phone); n.close(); };
      } catch (e) { /* some browsers only allow this from a service worker */ }
    }
  }

  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var now = audioCtx.currentTime;
      [[880, 0], [1175, 0.15]].forEach(function (n) {
        var osc = audioCtx.createOscillator(), gain = audioCtx.createGain(), t = now + n[1];
        osc.type = "sine"; osc.frequency.value = n[0];
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(t); osc.stop(t + 0.42);
      });
    } catch (e) { /* no audio available */ }
  }

  function renderAlertsButton() {
    var denied = "Notification" in window && Notification.permission === "denied";
    setKids(R.alertsBtn, [icon("bell"), h("span", { class: "lbl" }, alertsOn ? (denied ? "Alerts on (sound)" : "Alerts on") : "Enable alerts")]);
    R.alertsBtn.classList.toggle("gold", alertsOn);
    R.alertsBtn.classList.toggle("ghost", !alertsOn);
    R.alertsBtn.title = alertsOn ? "Click to turn alerts off" : "Get a chime and a notification when something needs the team";
  }

  function toggleAlerts() {
    alertsOn = !alertsOn;
    try { localStorage.setItem("wc_alerts", alertsOn ? "on" : "off"); } catch (e) { /* ignore */ }
    if (alertsOn) {
      chime(); // a click is needed before browsers allow sound
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().then(renderAlertsButton, renderAlertsButton);
      WC.toast("Alerts are on. You'll hear a chime and get a notification while this page stays open.", "ok");
    } else WC.toast("Alerts are off.");
    renderAlertsButton();
  }

  document.addEventListener("click", function () { if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); });

  // ---------------- start ----------------
  api("GET", "/auth/me", null, { keepOn401: true }).then(function (r) {
    if (!r.ok) return toLogin();
    var d = r.data, t = d.tenant || {};
    S.csrf = d.csrf || "";
    S.user = { id: d.user.id, name: d.user.name || d.user.email, email: d.user.email, role: d.user.role === "tenant_admin" ? "admin" : "staff" };
    info.name = t.name || "Inbox";
    info.status = t.status || "active";
    applyBranding(parseBranding(t.branding));
    try { localStorage.setItem("csrf", S.csrf); } catch (e) { /* ignore */ }
    startApp();
  });
})();
