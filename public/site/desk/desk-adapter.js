/* Loads right after admin-core.js: points the Shop Desk modules at the Chain SaaS API. */
(function () {
  "use strict";
  var WC = window.WC, S = WC.S;

  WC.home = "/";                                                 // where Sign out sends people: the marketing site
  WC.base = location.pathname.replace(/\/site\/[^/]*$/, ""); // "/chain-saas"
  WC.apiBase = WC.base + "/api/chats";                          // chat, items, media, templates

  function url(path) { return path.indexOf("/auth/") === 0 ? WC.base + "/api" + path : WC.apiBase + path; }
  function setLive(ok) {
    if (WC.R.live) WC.R.live.classList.toggle("off", !ok);
    if (WC.R.liveText) WC.R.liveText.textContent = ok ? "Live" : "Offline";
  }
  var OFFLINE = { ok: false, status: 0, data: { error: "Can't reach the server. Check your internet connection." } };

  function finish(res, opts) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401 && !(opts && opts.keepOn401) && WC.onUnauthorized) WC.onUnauthorized();
      return { ok: res.ok, status: res.status, data: data || {} };
    });
  }

  WC.api = function (method, path, body, opts) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.headers["X-CSRF-Token"] = S.csrf || "";
      init.body = JSON.stringify(body || {});
    }
    return fetch(url(path), init).then(function (res) { setLive(true); return finish(res, opts); }, function () { setLive(false); return OFFLINE; });
  };

  WC.upload = function (path, file, headers) {
    return fetch(url(path), {
      method: "POST", credentials: "same-origin", body: file,
      headers: Object.assign({ "Content-Type": file.type || "application/octet-stream", "X-CSRF-Token": S.csrf || "" }, headers || {}),
    }).then(function (res) { return finish(res); }, function () { return OFFLINE; });
  };
})();