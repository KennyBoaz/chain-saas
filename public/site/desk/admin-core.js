/* Shop Desk - core helpers (loaded first). No libraries, no build step.
 * Everything that comes from the database is inserted as TEXT (never as HTML),
 * so a customer cannot inject anything into the dashboard. */
(function () {
  "use strict";

  var WC = (window.WC = window.WC || {});

  // ------------------------------------------------------------------
  // Settings you may want to change
  // ------------------------------------------------------------------
  WC.config = {
    TIMEZONE: "Africa/Kampala",
    // Leave empty to show the text logo. To use the website logo, put its address here,
    // e.g. "https://winaclassic.ug/wp-content/uploads/....png" (only winaclassic.ug images are allowed).
    LOGO_URL: "",
    POLL_MS: 4000, // how often the open dashboard checks for news
    POLL_HIDDEN_MS: 20000, // ...when the browser tab is in the background
  };

  // Works whether the app is reached at /admin/... or /winaclassic/admin/...
  var BASE = location.pathname.replace(/\/admin\/[^/]*$/, "");
  var API = BASE + "/api";
  WC.apiBase = API;

  // ------------------------------------------------------------------
  // Shared state and element references
  // ------------------------------------------------------------------
  var S = (WC.S = {
    user: null,
    csrf: "",
    tab: "chats",
    summary: null,
    chats: {
      filter: "active", search: "", items: [], hasMore: false, offset: 0,
      selected: null, detail: null, messages: [], hasEarlier: false,
    },
    items: {
      issues: { status: "open", type: "", search: "", rows: [], hasMore: false, offset: 0, loaded: false },
      orders: { status: "open", type: "", search: "", rows: [], hasMore: false, offset: 0, loaded: false },
      appointments: { status: "open", type: "", search: "", rows: [], hasMore: false, offset: 0, loaded: false },
    },
    staff: { rows: [] },
  });
  WC.R = {};

  // ------------------------------------------------------------------
  // DOM helper:  h("div", { class: "x", onClick: fn }, child, child...)
  // ------------------------------------------------------------------
  function append(el, kids) {
    kids.forEach(function (k) {
      if (Array.isArray(k)) return append(el, k);
      if (k === null || k === undefined || k === false) return;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
  }

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      });
    }
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  WC.h = h;
  WC.$ = function (sel, root) { return (root || document).querySelector(sel); };

  /** Replace everything inside `el` with the given nodes. */
  WC.setKids = function (el, kids) {
    while (el.firstChild) el.removeChild(el.firstChild);
    append(el, kids);
    return el;
  };

  // ------------------------------------------------------------------
  // Icons (static, trusted markup)
  // ------------------------------------------------------------------
  var ICONS = {
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    link: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ticket: '<path d="M15 5v2"/><path d="M15 11v2"/><path d="M15 17v2"/><path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
    eyeoff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    unread: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  };

  WC.icon = function (name) {
    var tpl = document.createElement("template");
    tpl.innerHTML =
      '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICONS[name] || "") + "</svg>";
    return tpl.content.firstChild;
  };

  /** WhatsApp-style delivery ticks. status: pending | sent | delivered | read */
  WC.ticks = function (status) {
    var tpl = document.createElement("template");
    var shape;
    var cls = "tick";
    if (status === "read") cls += " read";
    if (status === "delivered" || status === "read") {
      shape = '<polyline points="1 6.5 4.5 10 11.5 3"/><polyline points="6.2 8.8 7.5 10 14.5 3"/>';
    } else if (status === "sent") {
      shape = '<polyline points="3 6.5 6.5 10 13.5 3"/>';
    } else {
      shape = '<circle cx="8" cy="6" r="4"/><polyline points="8 4 8 6 9.6 6.8"/>';
    }
    tpl.innerHTML =
      '<svg class="' + cls + '" viewBox="0 0 17 12" aria-label="' + (status || "pending") + '">' + shape + "</svg>";
    return tpl.content.firstChild;
  };

  // ------------------------------------------------------------------
  // Dates (shown in the shop's time zone)
  // ------------------------------------------------------------------
  var TZ = WC.config.TIMEZONE;
  var fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  var fmtDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
  var fmtShortDate = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit" });
  var fmtWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  var fmtKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

  function toDate(v) { return v instanceof Date ? v : new Date(v); }
  function validDate(v) { var d = v ? toDate(v) : null; return d && !isNaN(d.getTime()) ? d : null; }
  function dayKey(d) { return fmtKey.format(d); }

  WC.fmt = {
    time: function (v) { var d = validDate(v); return d ? fmtTime.format(d) : ""; },
    date: function (v) { var d = validDate(v); return d ? fmtDate.format(d) : ""; },
    stamp: function (v) { var d = validDate(v); return d ? fmtDate.format(d) + ", " + fmtTime.format(d) : ""; },
    dayKey: function (v) { var d = validDate(v); return d ? dayKey(d) : ""; },
    /** "Today", "Yesterday" or "12 Oct 2026" - for the date chips inside a thread */
    dayLabel: function (v) {
      var d = validDate(v);
      if (!d) return "";
      var key = dayKey(d);
      if (key === dayKey(new Date())) return "Today";
      if (key === dayKey(new Date(Date.now() - 86400000))) return "Yesterday";
      return fmtDate.format(d);
    },
    /** compact time for the chat list: 14:05 / Yesterday / Mon / 03/10/26 */
    listTime: function (v) {
      var d = validDate(v);
      if (!d) return "";
      var key = dayKey(d);
      if (key === dayKey(new Date())) return fmtTime.format(d);
      if (key === dayKey(new Date(Date.now() - 86400000))) return "Yesterday";
      if (Date.now() - d.getTime() < 6 * 86400000) return fmtWeekday.format(d);
      return fmtShortDate.format(d);
    },
    /** "5h 12m" / "42m" for the 24-hour window countdown */
    left: function (ms) {
      if (ms <= 0) return "0m";
      var mins = Math.floor(ms / 60000);
      var hours = Math.floor(mins / 60);
      return hours > 0 ? hours + "h " + (mins % 60) + "m" : mins + "m";
    },
  };

  /** 256706196504 -> +256 706 196 504 */
  WC.phone = function (digits) {
    var d = String(digits || "");
    if (/^256\d{9}$/.test(d)) return "+256 " + d.slice(3, 6) + " " + d.slice(6, 9) + " " + d.slice(9);
    return d ? "+" + d : "";
  };

  var AVATAR_COLOURS = ["#243b32", "#8a6d2f", "#5b3a3a", "#3b4a63", "#4d5b3a", "#6b4a63", "#2f5555", "#6a5a3a"];
  WC.avatar = function (name, phone, extra) {
    var text = String(name || "").trim();
    var initials = text
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (w) { return (w.match(/[A-Za-z0-9]/) || [""])[0]; })
      .join("")
      .toUpperCase();
    if (!initials) initials = "#";
    var seed = 0;
    String(phone || text).split("").forEach(function (c) { seed = (seed * 31 + c.charCodeAt(0)) >>> 0; });
    return h("span", { class: "avatar" + (extra ? " " + extra : ""), style: { background: AVATAR_COLOURS[seed % AVATAR_COLOURS.length] } }, initials);
  };

  WC.pill = function (text, cls) { return h("span", { class: "pill " + (cls || "") }, text); };
  WC.statusPill = function (status) {
    var map = {
      new: ["New", "p-new"], in_progress: ["In progress", "p-progress"], resolved: ["Resolved", "p-resolved"],
      cancelled: ["Cancelled", "p-cancelled"], open: ["Open", "p-open"], escalated: ["Escalated", "p-escalated"],
    };
    var m = map[status] || [status, ""];
    return WC.pill(m[0], m[1]);
  };

  WC.debounce = function (fn, ms) {
    var t;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  /** Plain text -> nodes, with http(s) links made clickable (and nothing else). */
  WC.linkify = function (text) {
    var frag = document.createDocumentFragment();
    var re = /https?:\/\/[^\s<>"']+/g;
    var last = 0;
    var m;
    var str = String(text || "");
    while ((m = re.exec(str))) {
      var url = m[0].replace(/[.,;:!?)]+$/, "");
      if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
      frag.appendChild(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
    return frag;
  };

  WC.copy = function (text) {
    function done() { WC.toast("Copied", "ok"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { WC.toast("Couldn't copy", "error"); });
    } else {
      var ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { WC.toast("Couldn't copy", "error"); }
      ta.remove();
    }
  };

  // ------------------------------------------------------------------
  // API client
  // ------------------------------------------------------------------
  function setLive(ok) {
    if (WC.R.live) WC.R.live.classList.toggle("off", !ok);
    if (WC.R.liveText) WC.R.liveText.textContent = ok ? "Live" : "Offline";
  }

  /** Returns { ok, status, data } and never throws. A 401 sends the user back to sign-in. */
  WC.api = function (method, path, body, opts) {
    opts = opts || {};
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.headers["X-CSRF-Token"] = S.csrf || "";
      init.body = JSON.stringify(body || {});
    }
    return fetch(API + path, init).then(
      function (res) {
        setLive(true);
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 && !opts.keepOn401 && WC.onUnauthorized) WC.onUnauthorized();
          return { ok: res.ok, status: res.status, data: data || {} };
        });
      },
      function () {
        setLive(false);
        return { ok: false, status: 0, data: { error: "Can't reach the server. Check your internet connection." } };
      }
    );
  };

  /** Send a file as raw bytes (not JSON). Same result shape as WC.api. */
  WC.upload = function (path, file, headers) {
    return fetch(API + path, {
      method: "POST", credentials: "same-origin", body: file,
      headers: Object.assign({ "Content-Type": file.type || "application/octet-stream", "X-CSRF-Token": S.csrf || "", "X-Upload": "1" }, headers || {}),
    }).then(
      function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 && WC.onUnauthorized) WC.onUnauthorized();
          return { ok: res.ok, status: res.status, data: data || {} };
        });
      },
      function () { return { ok: false, status: 0, data: { error: "Can't reach the server. Check your internet connection." } }; }
    );
  };

  // ------------------------------------------------------------------
  // Toasts and dialogs
  // ------------------------------------------------------------------
  WC.toast = function (message, kind) {
    var el = h("div", { class: "toast " + (kind || ""), role: "status" }, message);
    document.getElementById("toasts").appendChild(el);
    setTimeout(function () { el.remove(); }, kind === "error" ? 6000 : 3500);
  };

  /**
   * dialog({ title, body, actions: [{ label, kind, onClick }], wide })
   * An action's onClick may be async; return false to keep the dialog open.
   * Returns { close, error(msg), el }.
   */
  WC.dialog = function (cfg) {
    var previous = document.activeElement;
    var overlay = h("div", { class: "overlay" });
    var errorBox = h("div", { class: "dialog-error hidden" });

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (previous && previous.focus) previous.focus();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    var buttons = (cfg.actions || []).map(function (a) {
      var btn = h("button", { class: "btn " + (a.kind || ""), type: "button" }, a.label);
      btn.addEventListener("click", function () {
        errorBox.classList.add("hidden");
        buttons.forEach(function (b) { b.disabled = true; });
        Promise.resolve(a.onClick ? a.onClick(api) : undefined)
          .then(function (keep) { if (keep !== false) close(); })
          .catch(function (err) { api.error(err && err.message ? err.message : "Something went wrong."); })
          .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
      });
      return btn;
    });

    var box = h(
      "div",
      { class: "dialog" + (cfg.wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": cfg.title },
      h("div", { class: "dialog-head" },
        h("h3", null, cfg.title),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onClick: close }, WC.icon("x"))),
      h("div", { class: "dialog-body" }, errorBox, cfg.body),
      buttons.length ? h("div", { class: "dialog-actions" }, buttons) : null
    );
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);

    var api = {
      close: close,
      el: box,
      error: function (msg) { errorBox.textContent = msg; errorBox.classList.remove("hidden"); },
    };
    var first = box.querySelector("input, textarea, select");
    if (first) first.focus();
    return api;
  };

  /** Resolves true if the user confirms. */
  WC.confirm = function (title, message, confirmLabel, kind) {
    return new Promise(function (resolve) {
      var done = false;
      var d = WC.dialog({
        title: title,
        body: h("p", null, message),
        actions: [
          { label: "Cancel", kind: "ghost", onClick: function () { done = true; resolve(false); } },
          { label: confirmLabel || "Confirm", kind: kind || "", onClick: function () { done = true; resolve(true); } },
        ],
      });
      // closing with Esc / clicking outside counts as "no"
      var watch = setInterval(function () {
        if (!document.body.contains(d.el)) { clearInterval(watch); if (!done) resolve(false); }
      }, 200);
    });
  };

  /** A labelled form row. */
  WC.field = function (label, input, hint) {
    return h("div", { class: "form-row" }, h("label", { class: "label" }, label), input, hint ? h("div", { class: "hint" }, hint) : null);
  };

  /** Show the right message for a failed API call. */
  WC.fail = function (res, fallback) {
    WC.toast((res && res.data && res.data.error) || fallback || "Something went wrong.", "error");
  };
})();