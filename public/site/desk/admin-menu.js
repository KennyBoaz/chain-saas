/* Shop Desk - WhatsApp-style right-click menus (long-press on a phone).
 *   right-click a MESSAGE  -> react, reply, copy, forward, star, save to notes, info, retry
 *   right-click a CHAT     -> take over, resolve, assign, pin, unread, export, clear view, reset bot, delete
 * Hold Shift while right-clicking to get the normal browser menu instead. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, api = WC.api, icon = WC.icon, fmt = WC.fmt, setKids = WC.setKids;

  WC.menuLoaded = true; // lets the dashboard notice if this file did not load

  WC.REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F64F}", "\u{1F60A}", "\u{1F602}", "\u{1F62E}", "\u{1F622}"];

  // ====================================================================
  // The menu itself
  // ====================================================================
  var current = null;
  var touchOpenAt = 0; // when a long-press last opened a menu (phones)
  WC.recentTouchOpen = function () { return Date.now() - touchOpenAt < 900; };

  WC.closeMenu = function () {
    if (current) { current.cleanup(); current = null; }
  };

  /** items: { label, icon, onClick, danger, hint } | { sep: true } | { reactions: true, active, onPick } */
  WC.openMenu = function (x, y, items) {
    WC.closeMenu();
    var openedAt = Date.now();
    // Only after a long-press: ignore the finger-lift that would otherwise tap an item.
    var guarded = WC.recentTouchOpen();
    var menu = h("div", { class: "ctx", role: "menu" });
    var buttons = [];

    items.forEach(function (it) {
      if (it.sep) { menu.appendChild(h("div", { class: "ctx-sep" })); return; }
      if (it.reactions) {
        menu.appendChild(h("div", { class: "ctx-react" }, WC.REACTIONS.map(function (e) {
          return h("button", {
            class: "ctx-emoji" + (it.active === e ? " on" : ""), type: "button", "aria-label": "React " + e,
            onClick: function (ev) { ev.stopPropagation(); if (guarded && Date.now() - openedAt < 350) return; WC.closeMenu(); it.onPick(e); },
          }, e);
        })));
        return;
      }
      var btn = h("button", {
        class: "ctx-item" + (it.danger ? " danger" : ""), type: "button", role: "menuitem",
        onClick: function (ev) {
          ev.stopPropagation();
          if (guarded && Date.now() - openedAt < 350) return;
          WC.closeMenu();
          it.onClick();
        },
      }, it.icon ? icon(it.icon) : h("span", { class: "ctx-gap" }), h("span", { class: "ctx-label" }, it.label), it.hint ? h("span", { class: "ctx-hint" }, it.hint) : null);
      buttons.push(btn);
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    var left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8));
    var top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    function onDown(e) { if (!menu.contains(e.target)) WC.closeMenu(); }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); WC.closeMenu(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var i = buttons.indexOf(document.activeElement);
        i = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
        if (buttons[i]) buttons[i].focus();
      }
    }
    function close() { WC.closeMenu(); }
    function onScroll() { if (Date.now() - openedAt > 300) WC.closeMenu(); } // ignore a scroll that was already under way
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", onScroll, true);

    current = {
      cleanup: function () {
        menu.remove();
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", close);
        window.removeEventListener("blur", close);
        document.removeEventListener("scroll", onScroll, true);
      },
    };
  };

  /** Touch screens: press and hold to open the menu. */
  WC.longPress = function (el, handler) {
    var timer = null, sx = 0, sy = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    el.addEventListener("touchstart", function (e) {
      var t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      cancel();
      timer = setTimeout(function () { timer = null; touchOpenAt = Date.now(); handler(sx, sy); }, 520);
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      var t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
    }, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchcancel", cancel);
  };

  // ====================================================================
  // Message menu
  // ====================================================================
  WC.messageMenu = function (m, x, y) {
    var conv = S.chats.detail && S.chats.detail.conversation;
    var windowOpen = !!(conv && conv.window && conv.window.expires_at && new Date(conv.window.expires_at).getTime() > Date.now());
    var selection = String((window.getSelection && window.getSelection()) || "").trim();
    var items = [];

    if (m.direction === "in" && windowOpen && m.wa_message_id) {
      items.push({ reactions: true, active: m.reaction, onPick: function (e) { react(m, e === m.reaction ? "" : e); } });
    }
    if (windowOpen) items.push({ label: "Reply", icon: "reply", onClick: function () { WC.setReply(m); } });
    items.push({ label: selection ? "Copy selected text" : "Copy text", icon: "copy", onClick: function () { WC.copy(selection || m.body || ""); } });
    if (m.direction === "out") items.push({ label: "Forward\u2026", icon: "forward", onClick: function () { forwardDialog(m); } });
    items.push({ label: m.starred ? "Remove star" : "Star message", icon: "star", onClick: function () { star(m); } });
    items.push({ label: "Save to customer notes", icon: "edit", onClick: function () { saveNote(m); } });
    items.push({ label: "Message info", icon: "info", onClick: function () { infoDialog(m); } });
    if (m.delivery_status === "failed" && m.sender_type === "staff") {
      items.push({ sep: true });
      items.push({ label: "Retry sending", icon: "refresh", onClick: function () { WC.retryMessage(m.id); } });
    }
    WC.openMenu(x, y, items);
  };

  function mergeOne(message) {
    if (!message) return;
    WC.mergeMessages([message]);
    WC.rerenderMessages(false);
  }

  function react(m, emoji) {
    api("POST", "/messages/" + m.id + "/react", { emoji: emoji }).then(function (r) {
      if (!r.ok) return WC.fail(r);
      mergeOne(r.data.message);
    });
  }

  function star(m) {
    api("POST", "/messages/" + m.id + "/star", { starred: !m.starred }).then(function (r) {
      if (!r.ok) return WC.fail(r);
      mergeOne(r.data.message);
    });
  }

  function saveNote(m) {
    api("POST", "/messages/" + m.id + "/save-note", {}).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast("Saved to the customer's notes.", "ok");
      if (S.chats.detail && S.chats.detail.customer) S.chats.detail.customer.notes = r.data.notes;
      WC.refreshDetail();
    });
  }

  function infoDialog(m) {
    function row(label, value) {
      return value ? h("div", { class: "info-row" }, h("b", null, label), h("span", null, value)) : null;
    }
    var by = m.direction === "in" ? "The customer" : m.sender_type === "bot" ? "The bot" : (m.staff_name || "A team member");
    var status = m.direction === "in" ? "Received" : ({ pending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read by the customer", failed: "Not delivered" }[m.delivery_status] || "");
    WC.dialog({
      title: "Message info",
      body: [
        h("div", { class: "info-quote" }, m.body || ""),
        row("From", by),
        row("Time", fmt.stamp(m.created_at)),
        row("Status", status),
        row("Problem", m.error_text),
        row("Replying to", m.quoted_body ? String(m.quoted_body).slice(0, 140) : (m.reply_to_wa_id ? "An earlier message" : "")),
        row("Starred", m.starred ? "Yes" : ""),
        h("div", { class: "info-row" }, h("b", null, "WhatsApp ID"), h("span", { class: "mono" }, m.wa_message_id || "none")),
      ],
      actions: [{ label: "Close", kind: "ghost" }],
    });
  }

  function forwardDialog(m) {
    var picked = null, rows = [];
    var list = h("div", { class: "pick-list" });
    var search = h("input", { class: "input", type: "search", placeholder: "Search a customer", "aria-label": "Search customers" });

    function draw() {
      setKids(list, rows.length ? rows.map(function (c) {
        return h("button", {
          class: "pick" + (picked === c.phone ? " on" : ""), type: "button",
          onClick: function () { picked = c.phone; draw(); },
        }, WC.avatar(c.name, c.phone), h("span", null, c.name || WC.phone(c.phone)), h("small", null, WC.phone(c.phone)));
      }) : [h("div", { class: "d-none" }, "No chats are inside the 24-hour reply window.")]);
    }
    function load() {
      api("GET", "/conversations?filter=window_open&limit=30" + (search.value.trim() ? "&search=" + encodeURIComponent(search.value.trim()) : "")).then(function (r) {
        rows = (r.data.conversations || []).filter(function (c) { return c.phone !== m.phone; });
        draw();
      });
    }
    search.addEventListener("input", WC.debounce(load, 250));
    load();

    WC.dialog({
      title: "Forward message",
      body: [
        h("div", { class: "info-quote" }, m.body || ""),
        h("p", { class: "muted" }, "It is sent as a message from you, and the bot pauses in that chat. Only chats inside the 24-hour window are listed."),
        search, list,
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Forward",
          onClick: function (dlg) {
            if (!picked) { dlg.error("Choose a chat first."); return false; }
            return api("POST", "/messages/" + m.id + "/forward", { to_phone: picked }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not forward."); return false; }
              WC.toast("Message forwarded.", "ok");
              WC.refreshChatList();
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // Chat menu
  // ====================================================================
  WC.attachChatMenu = function (el, c) {
    el.addEventListener("contextmenu", function (e) {
      if (e.shiftKey) return;
      e.preventDefault();
      if (WC.recentTouchOpen()) return; // a long-press already opened it
      WC.chatMenu(c.phone, c, e.clientX, e.clientY);
    });
    WC.longPress(el, function (x, y) { WC.chatMenu(c.phone, c, x, y); });
  };

  WC.chatMenu = function (phone, conv, x, y) {
    var admin = S.user && S.user.role === "admin";
    var selected = S.chats.selected === phone;
    var items = [];

    if (!selected) items.push({ label: "Open chat", icon: "chat", onClick: function () { WC.selectChat(phone); } });
    items.push(conv.mode === "human"
      ? { label: "Hand back to bot", icon: "chat", onClick: function () { WC.handBack(phone); } }
      : { label: "Take over from the bot", icon: "user", onClick: function () { WC.takeOver(phone); } });
    items.push(conv.status === "resolved"
      ? { label: "Reopen chat", icon: "clock", onClick: function () { WC.reopenChat(phone); } }
      : { label: "Resolve chat\u2026", icon: "check", onClick: function () { WC.resolveChat(phone); } });
    items.push({ sep: true });
    items.push({ label: "Assign to me", icon: "user", onClick: function () { assign(phone, S.user.id); } });
    items.push({ label: "Assign to\u2026", icon: "users", onClick: function () { assignDialog(phone, conv); } });
    items.push({ label: "Mark as unread", icon: "unread", onClick: function () { markUnread(phone, selected); } });
    items.push({ label: conv.pinned ? "Unpin from top" : "Pin to top", icon: "pin", onClick: function () { pin(phone, !conv.pinned); } });
    items.push({ sep: true });
    items.push({ label: "Export conversation (.txt)", icon: "download", onClick: function () { exportChat(phone); } });
    if (selected) items.push({ label: "Clear view (hide earlier messages)", icon: "eyeoff", onClick: function () { clearView(phone); } });
    items.push({ label: "Reset bot memory\u2026", icon: "refresh", onClick: function () { resetMemory(phone); } });
    if (selected) items.push({ label: "Close chat view", icon: "x", hint: "Esc", onClick: function () { WC.closeChat(); } });
    if (admin) {
      items.push({ sep: true });
      items.push({ label: "Delete conversation\u2026", icon: "trash", danger: true, onClick: function () { deleteDialog(phone, conv); } });
    }
    WC.openMenu(x, y, items);
  };

  function done(r, message) {
    if (!r.ok) return WC.fail(r);
    if (message) WC.toast(message, "ok");
    WC.afterChatAction();
  }

  function assign(phone, staffId) {
    api("POST", "/conversations/" + phone + "/assign", { staff_id: staffId }).then(function (r) { done(r, staffId ? "Chat assigned." : "Chat unassigned."); });
  }

  function assignDialog(phone, conv) {
    var select = h("select", { class: "input" }, h("option", { value: "" }, "Nobody (unassigned)"));
    api("GET", "/team").then(function (r) {
      (r.data.staff || []).forEach(function (u) { select.appendChild(h("option", { value: String(u.id) }, u.name)); });
      select.value = conv.assigned_to ? String(conv.assigned_to) : "";
    });
    WC.dialog({
      title: "Assign chat",
      body: WC.field("Who is looking after this customer?", select),
      actions: [
        { label: "Cancel", kind: "ghost" },
        { label: "Assign", onClick: function () { assign(phone, select.value ? Number(select.value) : null); } },
      ],
    });
  }

  function markUnread(phone, selected) {
    api("POST", "/conversations/" + phone + "/unread", {}).then(function (r) {
      if (!r.ok) return WC.fail(r);
      if (selected) WC.closeChat();
      WC.toast("Marked as unread.", "ok");
      WC.afterChatAction();
    });
  }

  function pin(phone, pinned) {
    api("POST", "/conversations/" + phone + "/pin", { pinned: pinned }).then(function (r) { done(r, pinned ? "Pinned to the top." : "Unpinned."); });
  }

  function exportChat(phone) {
    api("GET", "/conversations/" + phone + "/export").then(function (r) {
      if (!r.ok) return WC.fail(r);
      var url = URL.createObjectURL(new Blob([r.data.text], { type: "text/plain;charset=utf-8" }));
      var a = h("a", { href: url, download: r.data.filename, style: { display: "none" } });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // ---- clear view: hides messages on THIS device only, nothing is deleted ----
  WC.clearedUpTo = function (phone) {
    try { return Number(localStorage.getItem("wc_clear_" + phone)) || 0; } catch (e) { return 0; }
  };

  WC.showAllMessages = function (phone) {
    try { localStorage.removeItem("wc_clear_" + phone); } catch (e) { /* ignore */ }
    WC.rerenderMessages(false);
  };

  function clearView(phone) {
    var msgs = S.chats.messages;
    if (!msgs.length) return;
    try { localStorage.setItem("wc_clear_" + phone, String(msgs[msgs.length - 1].id)); } catch (e) { /* ignore */ }
    WC.rerenderMessages(true);
    WC.toast("Earlier messages are hidden on this device. Nothing was deleted.", "ok");
  }

  function resetMemory(phone) {
    WC.confirm(
      "Reset the bot's memory?",
      "The bot will forget what it knows about this customer and start the conversation fresh. All messages, orders and notes stay exactly as they are.",
      "Reset memory"
    ).then(function (yes) {
      if (!yes) return;
      api("POST", "/conversations/" + phone + "/reset-bot-memory", {}).then(function (r) { done(r, "The bot's memory of this customer was reset."); });
    });
  }

  function deleteDialog(phone, conv) {
    var also = h("input", { type: "checkbox" });
    var typed = h("input", { class: "input", type: "text", placeholder: phone, autocomplete: "off" });
    WC.dialog({
      title: "Delete conversation",
      body: [
        h("p", null, "This permanently erases every message with ", h("b", null, conv.name || WC.phone(phone)), ", the bot's memory of them and their saved notes. It cannot be undone."),
        h("label", { class: "check" }, also, " Also delete this customer's orders, appointments and tickets"),
        WC.field("Type " + phone + " to confirm", typed),
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Delete forever", kind: "danger",
          onClick: function (dlg) {
            return api("POST", "/conversations/" + phone + "/delete", { confirm: typed.value.trim(), also_records: also.checked }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not delete."); return false; }
              WC.toast("Conversation deleted.", "ok");
              if (S.chats.selected === phone) WC.closeChat();
              WC.refreshChatList();
              WC.refreshSummary();
              ["issues", "orders", "appointments"].forEach(function (k) { WC.refreshItems(k); });
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // Esc: cancel a reply, then close the open chat
  // ====================================================================
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || document.querySelector(".overlay")) return;
    var el = e.target;
    if (S.chats.replyTo) { WC.setReply(null); return; }
    if (el && el.closest && el.closest("input, textarea, select") && el.value) return;
    if (S.tab === "chats" && S.chats.selected) WC.closeChat();
  });
})();