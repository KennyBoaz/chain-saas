/* Step 1: compare the two ways to connect WhatsApp and choose one. */
(function () {
  "use strict";
  var WC = window.WC, Shell = window.Shell, esc = Shell.esc, BASE = WC.base;

  function list(items) { return "<ul>" + items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>"; }

  function card(m) {
    return '<article class="opt"><h3>' + esc(m.name) + '</h3><p class="tag">' + esc(m.tagline) + '</p>' +
      '<div class="best"><b>Best for:</b> ' + esc(m.bestFor) + "</div>" +
      "<h4>What you get</h4>" + list(m.features) +
      '<h4>What you need</h4><div class="needs">' + list(m.requirements.map(function (r) { return r.text; })) + "</div>" +
      '<div class="pc"><div class="pro"><h4>Advantages</h4>' + list(m.pros) + '</div><div class="con"><h4>Trade-offs</h4>' + list(m.cons) + "</div></div>" +
      '<div class="go"><a class="btn" href="requirements.html?type=' + esc(m.id) + '">Choose: ' + esc(m.name) + "</a></div></article>";
  }

  Shell.boot("dashboard", function (main) {
    main.innerHTML = '<ol class="stepper"><li class="on"><b>1</b>Choose</li><li><b>2</b>Check requirements</li><li><b>3</b>Connect</li></ol>' +
      '<div class="view-head"><div><h2>Connect <em>WhatsApp</em></h2><p>Pick how your number will work with Chain. Read both options: this decision affects how your team and your customers use the number.</p></div></div><div id="body"></div>';
    var body = main.querySelector("#body");

    Promise.all([Shell.api("GET", "/whatsapp/status"), Shell.api("GET", "/whatsapp/modes")]).then(function (r) {
      var st = r[0], md = r[1];
      if (!md.ok) { body.innerHTML = '<div class="empty-state"><h3>Could not load the options</h3><p>' + esc((md.data && md.data.error) || "Please refresh.") + "</p></div>"; return; }
      var connected = st.ok && st.data.connected;
      body.innerHTML = (connected
          ? '<div class="hint">A WhatsApp number is already connected (' + esc(st.data.connection.display_phone || "number ID " + st.data.connection.phone_number_id) + ", " + (st.data.connection.mode === "api" ? "API only" : "Business app kept") + '). To switch, disconnect it from the <a href="' + BASE + '/site/dashboard.html">Dashboard</a> first.</div>'
          : '<div class="hint"><b>Not sure?</b> If you already chat with customers in the WhatsApp Business app every day, choose <b>Keep my WhatsApp Business app</b>. If you are starting fresh, have high volume, or want everything in Chain, choose <b>API only</b>.</div>') +
        '<div class="opts">' + md.data.modes.map(card).join("") + "</div>" +
        '<p class="muted" style="text-align:center"><a href="' + BASE + '/site/dashboard.html">Back to the Dashboard</a></p>';
      if (connected) body.querySelectorAll(".opt .btn").forEach(function (b) { b.classList.add("ghost"); b.removeAttribute("href"); b.setAttribute("aria-disabled", "true"); b.textContent = "Disconnect first to change"; });
    });
  });
})();