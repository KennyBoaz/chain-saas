/* Dashboard: setup checklist, subscription, usage, WhatsApp connection, 14-day analytics. */
(function () {
  "use strict";
  var WC = window.WC, S = WC.S, Shell = window.Shell, esc = Shell.esc, BASE = WC.base;
  var FB_APP_ID = "1669045207960904", FB_CONFIG_ID = "3702487739888996"; // Meta app + Embedded Signup configuration
  var root, data;

  var num = function (n) { return Number(n || 0).toLocaleString("en-US"); };
  var pct = function (used, limit) { return limit ? Math.min(100, Math.round((used / limit) * 100)) : 0; };
  var CHECK = '<svg class="i" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

  function step(done, text, action) {
    return '<div class="step' + (done ? " done" : "") + '"><span class="tick">' + (done ? CHECK : "") + '</span><span class="t">' + text + "</span>" + (done ? "" : action || "") + "</div>";
  }

  function render() {
    var d = data, sub = d.subscription, u = d.usage, t = d.totals, cl = d.checklist, active = d.tenant.status === "active";
    var left = sub.days_left, leftText = left === null ? "—" : left < 0 ? "Expired" : left + (left === 1 ? " day" : " days");
    var warn = left !== null && left <= 5;
    var allDone = cl.whatsapp && cl.prompt && cl.hours && cl.tested;
    var max = Math.max.apply(null, d.daily.map(function (x) { return Math.max(x.inbound, x.bot + x.staff); }).concat([1]));
    var replies = d.daily.reduce(function (a, x) { return a + x.bot + x.staff; }, 0);
    var botShare = replies ? Math.round((d.daily.reduce(function (a, x) { return a + x.bot; }, 0) / replies) * 100) : 0;

    var html = '<div class="view-head"><div><h2>Welcome, <em>' + esc(d.tenant.name) + "</em></h2><p>Here is how your WhatsApp assistant is doing.</p></div></div>";

    if (!active) html += '<div class="notice inactive" style="border-radius:4px;margin-bottom:16px">Your subscription is not active, so the assistant is not answering customers. Activate it below.</div>';

    if (!allDone) {
      html += '<div class="panel"><h3>Get started</h3><p class="sub">Four steps and your assistant is live.</p>' +
        step(cl.whatsapp, "Connect your WhatsApp number", active ? '<button class="btn small" data-act="connect">Connect</button>' : '<span class="muted">Activate your subscription first</span>') +
        step(cl.prompt, "Tell the assistant about your business", '<a class="btn small" href="' + BASE + '/site/settings.html#bot">Open settings</a>') +
        step(cl.hours, "Set your opening hours", '<a class="btn small" href="' + BASE + '/site/settings.html#profile">Open settings</a>') +
        step(cl.tested, "Send a test message to your number from another phone", "") + "</div>";
    }

    html += '<div class="tiles">' +
      '<div class="tile' + (warn ? " warn" : "") + '"><small>Subscription</small><span class="big">' + leftText + '</span><div class="note">' +
        esc(sub.plan || "Free trial") + " · " + esc(String(sub.status || "").replace("_", " ")) + (sub.period_end ? " · renews " + WC.fmt.date(sub.period_end) : "") + "</div></div>" +
      '<div class="tile"><small>Messages this month</small><span class="big">' + num(u.messages_month) + '</span><div class="note">' + (u.messages_limit ? "of " + num(u.messages_limit) : "no limit set") + '</div><div class="meter"><i style="width:' + pct(u.messages_month, u.messages_limit) + '%"></i></div></div>' +
      '<div class="tile"><small>Team seats</small><span class="big">' + u.seats_used + '</span><div class="note">' + (u.seats_limit ? "of " + u.seats_limit : "") + '</div><div class="meter"><i style="width:' + pct(u.seats_used, u.seats_limit) + '%"></i></div></div>' +
      '<div class="tile"><small>New customers, 14 days</small><span class="big">' + num(t.new_customers) + '</span><div class="note">' + num(t.chats) + " chats in total</div></div></div>";

    html += '<div class="panel"><h3>WhatsApp connection</h3><p class="sub">' + (d.whatsapp.connected
      ? 'Connected (number ID ' + esc(d.whatsapp.phone_number_id) + "). Customers who message it are answered by your assistant."
      : "Not connected yet.") + '</p><div class="foot">' +
      (d.whatsapp.connected ? '<span class="pill p-open">Connected</span><button class="btn ghost small" data-act="disconnect">Disconnect</button>'
        : active ? '<button class="btn" data-act="connect">Connect WhatsApp</button>' : '<span class="pill p-closed">Needs an active subscription</span>') +
      (!active ? '<button class="btn gold" data-act="pay">Activate subscription (test payment)</button>' : "") + "</div></div>";

    html += '<div class="panel"><h3>Last 14 days</h3><p class="sub">Customer messages and replies per day.</p><div class="bars">' +
      d.daily.map(function (x) {
        var r = x.bot + x.staff;
        return '<div title="' + x.d + ": " + x.inbound + " in, " + r + ' out"><div class="pair"><span style="height:' + Math.round((x.inbound / max) * 100) + '%"></span><span class="r" style="height:' + Math.round((r / max) * 100) + '%"></span></div><small>' + x.d.slice(8) + "</small></div>";
      }).join("") + '</div><div class="legend"><span><i></i>From customers</span><span><i class="r"></i>Replies</span></div></div>';

    html += '<div class="tiles">' +
      '<div class="tile"><small>Answered by the assistant</small><span class="big">' + botShare + '%</span><div class="note">of replies in 14 days</div></div>' +
      '<div class="tile"><small>Orders</small><span class="big">' + num(t.orders) + '</span><div class="note">captured by the assistant</div></div>' +
      '<div class="tile"><small>Appointments</small><span class="big">' + num(t.appointments) + '</span><div class="note">booked through WhatsApp</div></div>' +
      '<div class="tile"><small>Handed to your team</small><span class="big">' + num(t.handoffs) + '</span><div class="note">' + num(t.tickets) + " tickets and inquiries</div></div></div>";

    root.innerHTML = html;
  }

  function load() {
    return Shell.api("GET", "/tenant/overview").then(function (r) {
      if (!r.ok) return Shell.fail(r);
      data = r.data;
      render();
    });
  }

  // ---- WhatsApp Embedded Signup (Facebook SDK) ----
  window.fbAsyncInit = function () { FB.init({ appId: FB_APP_ID, autoLogAppEvents: true, xfbml: false, version: "v22.0" }); };
  var sdk = document.createElement("script");
  sdk.async = true; sdk.defer = true; sdk.crossOrigin = "anonymous"; sdk.src = "https://connect.facebook.net/en_US/sdk.js";
  document.head.appendChild(sdk);

  function connect() {
    if (typeof FB === "undefined") return WC.toast("Facebook is still loading. Try again in a moment.", "error");
    FB.login(function () { /* the result arrives as a message event below */ }, {
      config_id: FB_CONFIG_ID, response_type: "code", override_default_response_type: true,
      extras: { setup: {}, featureType: "whatsapp_business_app_onboarding" },
    });
  }

  var pending = null;
  window.addEventListener("message", function (event) {
    var host = ""; try { host = new URL(event.origin).hostname; } catch (e) { return; }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    var msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (!msg || msg.type !== "WA_EMBEDDED_SIGNUP") return;
    if (msg.event === "FINISH") {
      pending = msg.data;
      FB.getLoginStatus(function (r) {
        var code = r.authResponse && r.authResponse.code;
        if (!code || !pending) return WC.toast("Facebook did not return an authorisation code. Please try again.", "error");
        Shell.api("POST", "/whatsapp/connect", { code: code, wabaId: pending.waba_id, phoneNumberId: pending.phone_number_id }).then(function (res) {
          if (!res.ok) return Shell.fail(res);
          WC.toast("WhatsApp connected.", "ok");
          load();
        });
      });
    }
  });

  function pay() {
    Shell.api("POST", "/billing/checkout", { planId: 1 }).then(function (r) {
      if (!r.ok) return Shell.fail(r);
      WC.toast("Subscription activated.", "ok");
      load();
    });
  }

  function disconnect() {
    WC.confirm("Disconnect WhatsApp?", "Your assistant will stop answering on this number until you connect it again. Your chats are kept.", "Disconnect", "danger").then(function (yes) {
      if (!yes) return;
      Shell.api("POST", "/whatsapp/disconnect", {}).then(function (r) { if (!r.ok) return Shell.fail(r); WC.toast("Disconnected."); load(); });
    });
  }

  Shell.boot("dashboard", function (main) {
    root = main;
    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      ({ connect: connect, disconnect: disconnect, pay: pay })[b.dataset.act]();
    });
    load();
  });
})();