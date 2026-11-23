/* Shop Desk - photos, voice notes and documents in the thread, sending files, and template messages. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, icon = WC.icon, api = WC.api;

  var LIMIT = 16 * 1024 * 1024;
  var TYPES = {
    pdf: "application/pdf", doc: "application/msword", txt: "text/plain",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  function src(m) { return WC.apiBase + "/media/" + m.id; }
  function sizeText(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

  // ====================================================================
  // Files inside the thread
  // ====================================================================

  /** The text to show with a file: the customer's caption only, not the "[Customer sent a image]" placeholder. */
  WC.mediaCaption = function (m) {
    var body = String(m.body || "");
    var placeholder = body.match(/^\[Customer sent an? \w+(?:: ([\s\S]*))?\]$/);
    if (placeholder) return placeholder[1] || "";
    if (/^\[(Photo|Video|Audio)\]$/.test(body) || /^\[Document: .*\]$/.test(body)) return "";
    return body;
  };

  WC.mediaBlock = function (m) {
    if (!m.has_media) return null;
    var mime = String(m.media_mime || "");
    if (mime.indexOf("image/") === 0) {
      var img = h("img", { class: "mimg", src: src(m), alt: "Photo", loading: "lazy" });
      img.addEventListener("click", function () { lightbox(m); });
      return img;
    }
    if (mime.indexOf("audio/") === 0) return h("audio", { class: "maudio", controls: true, preload: "none", src: src(m) });
    if (mime === "video/mp4") return h("video", { class: "mvid", controls: true, preload: "metadata", src: src(m) });
    return h("a", { class: "mfile", href: src(m), target: "_blank", rel: "noopener noreferrer" },
      icon("file"), h("span", null, h("b", null, m.media_name || "Document"), h("small", null, sizeText(m.media_size || 0))));
  };

  function lightbox(m) {
    var overlay = h("div", { class: "lightbox", role: "dialog", "aria-label": "Photo" });
    function close() { overlay.remove(); document.removeEventListener("keydown", onKey, true); }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
    overlay.appendChild(h("img", { src: src(m), alt: "Photo" }));
    overlay.appendChild(h("div", { class: "lb-bar" },
      h("a", { class: "btn small", href: src(m), download: m.media_name || "photo" }, icon("download"), "Download"),
      h("button", { class: "btn ghost small", type: "button", onClick: close }, icon("x"), "Close")));
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
  }

  // ====================================================================
  // Sending a file
  // ====================================================================
  WC.pickFile = function () {
    var input = h("input", {
      type: "file", style: { display: "none" },
      accept: "image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.txt,video/mp4,audio/mpeg,audio/ogg,audio/mp4,audio/aac",
    });
    input.addEventListener("change", function () {
      var file = input.files[0];
      input.remove();
      if (file) uploadDialog(file);
    });
    document.body.appendChild(input);
    input.click();
  };

  function uploadDialog(file) {
    var phone = S.chats.selected;
    if (!phone) return;
    if (file.size > LIMIT) { WC.toast("That file is over 16 MB. Choose a smaller one.", "error"); return; }

    var ext = (file.name.split(".").pop() || "").toLowerCase();
    var blob = file.type ? file : new Blob([file], { type: TYPES[ext] || "" });
    var isImage = /^image\//.test(blob.type);
    var isAudio = /^audio\//.test(blob.type);
    var caption = h("input", { class: "input", type: "text", maxlength: "1000", placeholder: "Add a caption (optional)" });

    WC.dialog({
      title: "Send a file",
      body: [
        isImage ? h("img", { class: "up-preview", src: URL.createObjectURL(file), alt: "" })
                : h("div", { class: "mfile" }, icon("file"), h("span", null, h("b", null, file.name), h("small", null, sizeText(file.size)))),
        isAudio ? null : WC.field("Caption", caption),
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Send",
          onClick: function (dlg) {
            return WC.upload("/conversations/" + phone + "/media", blob, {
              "X-Filename": encodeURIComponent(file.name), "X-Caption": encodeURIComponent(caption.value),
            }).then(function (r) {
              if (r.ok || r.status === 502) {
                if (phone === S.chats.selected) { WC.mergeMessages(r.data.messages || []); WC.rerenderMessages(true); }
                if (!r.ok) WC.toast(r.data.error || "WhatsApp did not accept the file.", "error");
                WC.afterChatAction();
                return;
              }
              dlg.error((r.data && r.data.error) || "Could not send the file.");
              return false;
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // Template messages (for after the 24-hour window)
  // ====================================================================
  WC.templateDialog = function () {
    var phone = S.chats.selected;
    if (!phone) return;
    var select = h("select", { class: "input" });
    var fields = h("div");
    var preview = h("div", { class: "tpl-preview" });
    var templates = [], inputs = [], current = null;

    function render() {
      current = templates[Number(select.value)];
      inputs = [];
      WC.setKids(fields, []);
      if (!current) return;
      for (var i = 1; i <= current.variables; i += 1) {
        (function (n) {
          var input = h("input", { class: "input", type: "text", maxlength: "500", placeholder: "Value for {{" + n + "}}" });
          input.addEventListener("input", draw);
          inputs.push(input);
          fields.appendChild(WC.field("{{" + n + "}}", input));
        })(i);
      }
      draw();
    }
    function draw() {
      if (!current) return;
      var text = current.body.replace(/\{\{(\d+)\}\}/g, function (_, n) { var v = inputs[Number(n) - 1]; return v && v.value.trim() ? v.value.trim() : "{{" + n + "}}"; });
      WC.setKids(preview, [current.header ? h("b", null, current.header) : null, h("div", { class: "text" }, text), current.footer ? h("small", null, current.footer) : null]);
    }
    select.addEventListener("change", render);

    var dlg = WC.dialog({
      title: "Send a template",
      wide: true,
      body: [
        h("p", { class: "muted" }, "The 24-hour window has closed, so WhatsApp only allows an approved template message. Pick one and fill in the blanks."),
        WC.field("Template", select), fields, preview,
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Send template",
          onClick: function (d) {
            if (!current) { d.error("Choose a template first."); return false; }
            var params = inputs.map(function (i) { return i.value; });
            if (params.some(function (p) { return !p.trim(); })) { d.error("Fill in every blank."); return false; }
            return api("POST", "/conversations/" + phone + "/template", { name: current.name, language: current.language, params: params }).then(function (r) {
              if (r.ok || r.status === 502) {
                if (phone === S.chats.selected) { WC.mergeMessages(r.data.messages || []); WC.rerenderMessages(true); }
                if (!r.ok) WC.toast(r.data.error || "WhatsApp did not accept the template.", "error");
                WC.afterChatAction();
                return;
              }
              d.error((r.data && r.data.error) || "Could not send the template.");
              return false;
            });
          },
        },
      ],
    });

    api("GET", "/templates").then(function (r) {
      if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not load your templates."); return; }
      if (!r.data.configured) {
        dlg.error("Templates are not set up yet. Add WHATSAPP_BUSINESS_ACCOUNT_ID to your .env file and restart the app. Your WhatsApp token also needs the whatsapp_business_management permission.");
        return;
      }
      templates = r.data.templates || [];
      if (!templates.length) {
        dlg.error("You have no approved templates yet. Create one in Meta Business Manager (WhatsApp Manager, Message templates) and wait for approval.");
        return;
      }
      templates.forEach(function (t, i) {
        select.appendChild(h("option", { value: String(i), disabled: t.supported ? null : true }, t.name + " (" + t.language + ")" + (t.supported ? "" : " - not supported here")));
      });
      var first = templates.findIndex(function (t) { return t.supported; });
      select.value = String(first < 0 ? 0 : first);
      render();
    });
  };
})();
