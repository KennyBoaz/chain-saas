/* Shop Desk - the Chats screen (list + WhatsApp-style thread + customer details). */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, R = WC.R, api = WC.api, icon = WC.icon, fmt = WC.fmt, setKids = WC.setKids;

  var FILTERS = [
    ["active", "Active"], ["unread", "Unread"], ["human", "Human"], ["escalated", "Escalated"],
    ["window_open", "Window open"], ["open_issue", "Open issue"], ["resolved", "Resolved"], ["all", "All"],
  ];

  // If admin-menu.js did not load, the chats still work, just without the right-click menus.
  // (When it does load, it replaces these placeholders.)
  ["attachChatMenu", "chatMenu", "messageMenu", "longPress", "closeMenu"].forEach(function (n) { WC[n] = WC[n] || function () {}; });
  WC.recentTouchOpen = WC.recentTouchOpen || function () { return false; };

  var listReq = 0; // lets us ignore answers that arrive after a newer request
  var threadReq = 0;
  var sending = false;
  var readInFlight = false;

  // ====================================================================
  // Build the (static) layout once
  // ====================================================================
  WC.buildChats = function () {
    var c = (R.chats = {});

    c.search = h("input", {
      class: "search", type: "search", placeholder: "Search name or phone", "aria-label": "Search chats",
      onInput: WC.debounce(function () { S.chats.search = c.search.value.trim(); WC.loadChats(true); }, 250),
    });
    c.chips = h("div", { class: "chips" });
    c.rows = h("div", { class: "rows", role: "list" });
    c.more = h("div", { class: "list-more hidden" },
      h("button", { class: "btn ghost wide", type: "button", onClick: function () { WC.loadChats(false); } }, "Load more"));

    var list = h("section", { class: "chat-list" },
      h("div", { class: "list-tools" }, h("div", { class: "search-wrap" }, icon("search"), c.search), c.chips),
      c.rows, c.more);

    c.head = h("header", { class: "thread-head" });
    c.alert = h("div", { class: "alert-bar hidden" });
    c.msgs = h("div", { class: "msgs" });
    c.scroll = h("div", { class: "thread-scroll" }, c.msgs);
    c.modebar = h("div", { class: "modebar" });
    c.input = h("textarea", {
      rows: 1, placeholder: "Type a message", "aria-label": "Message", onKeydown: onComposerKey, onInput: autoGrow,
    });
    c.send = h("button", { class: "send-btn", type: "button", "aria-label": "Send message", onClick: sendMessage }, icon("send"));
    c.attach = h("button", { class: "icon-btn attach", type: "button", "aria-label": "Attach a file", title: "Attach a photo or document", onClick: function () { if (WC.pickFile) WC.pickFile(); } }, icon("paperclip"));
    c.tpl = h("button", { class: "btn small gold hidden", type: "button", onClick: function () { if (WC.templateDialog) WC.templateDialog(); } }, icon("chat"), "Send a template");
    c.composer = h("footer", { class: "composer" }, c.attach, c.tpl, c.input, c.send);
    c.replybar = h("div", { class: "replybar hidden" });
    c.box = h("div", { class: "thread-box hidden" }, c.head, c.alert, c.scroll, c.modebar, c.replybar, c.composer);
    c.empty = h("div", { class: "thread-empty" },
      h("span", { class: "brand-mark" }, "Wina ", h("em", null, "Classic")),
      h("p", null, "Select a chat to read the conversation, reply to the customer and see their orders."));
    var thread = h("section", { class: "thread" }, c.empty, c.box);

    c.detailBody = h("div");
    c.details = h("aside", { class: "details", "aria-label": "Customer details" },
      h("div", { class: "details-head" }, h("b", null, "Customer"),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close details", onClick: toggleDetails }, icon("x"))),
      c.detailBody);

    c.layout = h("div", { class: "chats-layout" }, list, thread, c.details);
    renderChips();
    renderDetails();
    return c.layout;
  };

  // ====================================================================
  // Chat list
  // ====================================================================
  function renderChips() {
    var sm = S.summary || {};
    var counts = { unread: sm.unread_chats, human: sm.human_chats, escalated: sm.escalated_chats };
    setKids(R.chats.chips, FILTERS.map(function (f) {
      var n = counts[f[0]];
      return h("button", {
        class: "chip" + (S.chats.filter === f[0] ? " active" : ""), type: "button",
        onClick: function () { S.chats.filter = f[0]; renderChips(); WC.loadChats(true); },
      }, f[1], n ? h("span", { class: "n" }, n) : null);
    }));
  }
  WC.renderChips = renderChips;

  function emptyListText() {
    var cs = S.chats;
    if (cs.search) return "No chats match your search.";
    var map = {
      unread: "No unread chats.", human: "No chats are with the team right now.", escalated: "Nothing is waiting for a person.",
      window_open: "No chats are inside the 24-hour reply window.", open_issue: "No chats have open issues.",
      resolved: "No resolved chats yet.",
    };
    return map[cs.filter] || "No chats yet. When a customer messages the bot, the conversation appears here.";
  }

  function chatRow(c) {
    var name = c.name || WC.phone(c.phone);
    var tags = [];
    if (c.status === "escalated") tags.push(WC.statusPill("escalated"));
    if (c.status === "resolved") tags.push(WC.statusPill("resolved"));
    tags.push(c.mode === "human"
      ? WC.pill(c.assigned_name ? "Human · " + c.assigned_name : "Human", "p-human")
      : WC.pill("Bot", "p-bot"));
    if (c.open_orders) tags.push(WC.pill(c.open_orders + (c.open_orders > 1 ? " orders" : " order"), "p-type"));
    if (c.open_appointments) tags.push(WC.pill(c.open_appointments + (c.open_appointments > 1 ? " appts" : " appt"), "p-type"));
    if (c.open_issues) tags.push(WC.pill(c.open_issues + (c.open_issues > 1 ? " issues" : " issue"), "p-type"));

    var el = h("div", {
      class: "row" + (S.chats.selected === c.phone ? " selected" : "") + (c.unread_count ? " unread" : ""),
      role: "listitem", tabindex: "0",
      onClick: function () { WC.selectChat(c.phone); },
      onKeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); WC.selectChat(c.phone); } },
    },
      WC.avatar(c.name, c.phone),
      h("div", { class: "row-main" },
        h("div", { class: "row-top" }, h("span", { class: "row-name" }, c.pinned ? h("span", { class: "pin" }, icon("pin")) : null, name), h("span", { class: "row-time" }, fmt.listTime(c.last_message_at))),
        h("div", { class: "row-bottom" },
          h("span", { class: "row-preview" }, c.last_message_preview || "No messages yet"),
          c.unread_count ? h("span", { class: "badge" }, c.unread_count > 99 ? "99+" : c.unread_count) : null),
        h("div", { class: "row-tags" }, tags)));
    WC.attachChatMenu(el, c);
    return el;
  }

  function renderChatList() {
    var cs = S.chats, rows = R.chats.rows, top = rows.scrollTop;
    try {
      if (!cs.items.length) setKids(rows, [h("div", { class: "list-empty" }, emptyListText())]);
      else setKids(rows, cs.items.map(chatRow));
    } catch (err) {
      setKids(rows, [h("div", { class: "list-empty" },
        h("p", null, h("b", null, "The chats loaded but could not be shown.")),
        h("p", { class: "muted" }, String(err && err.message ? err.message : err)),
        h("p", { class: "muted" }, "A dashboard file may be missing or out of date. Re-upload the files in public/admin and refresh."))]);
    }
    rows.scrollTop = top;
    R.chats.more.classList.toggle("hidden", !cs.hasMore);
  }

  function chatsUrl(limit, offset) {
    var cs = S.chats;
    return "/conversations?filter=" + encodeURIComponent(cs.filter) + "&limit=" + limit + "&offset=" + offset +
      (cs.search ? "&search=" + encodeURIComponent(cs.search) : "");
  }

  /** The list could not be loaded: say so (instead of an empty panel) and offer a retry. */
  function listError(r) {
    WC.fail(r);
    if (S.chats.items.length) return;
    setKids(R.chats.rows, [h("div", { class: "list-empty" },
      h("p", null, h("b", null, "Couldn't load the chats.")),
      h("p", { class: "muted" }, (r.data && r.data.error) || "Please try again."),
      h("button", { class: "btn ghost small", type: "button", onClick: function () { WC.loadChats(true); } }, "Try again"))]);
    R.chats.more.classList.add("hidden");
  }

  /** reset=true: start from the first page. reset=false: add the next page. */
  WC.loadChats = function (reset) {
    var cs = S.chats, token = ++listReq;
    if (reset) cs.offset = 0;
    return api("GET", chatsUrl(30, cs.offset)).then(function (r) {
      if (token !== listReq) return;
      if (!r.ok) return listError(r);
      var rows = r.data.conversations || [];
      cs.items = reset ? rows : cs.items.concat(rows);
      cs.hasMore = !!r.data.has_more;
      cs.offset = cs.items.length;
      renderChatList();
    });
  };

  /** Re-read the list we already show (keeps as many pages as are loaded). Resolves { prev, now }. */
  WC.refreshChatList = function () {
    var cs = S.chats, token = ++listReq, prev = cs.items;
    var limit = Math.min(100, Math.max(30, cs.items.length));
    return api("GET", chatsUrl(limit, 0)).then(function (r) {
      if (token !== listReq || !r.ok) return { prev: prev, now: prev };
      cs.items = r.data.conversations || [];
      cs.hasMore = !!r.data.has_more;
      cs.offset = cs.items.length;
      renderChatList();
      return { prev: prev, now: cs.items };
    });
  };

  // ====================================================================
  // Opening / closing a chat
  // ====================================================================
  WC.selectChat = function (phone) {
    var cs = S.chats, token = ++threadReq;
    cs.selected = phone;
    cs.replyTo = null;
    cs.detail = null;
    cs.messages = [];
    cs.hasEarlier = false;

    R.chats.layout.classList.add("has-chat");
    R.chats.layout.classList.remove("details-open");
    document.body.classList.add("chat-open");
    R.chats.empty.classList.add("hidden");
    R.chats.box.classList.remove("hidden");
    renderChatList();
    renderAll(true);

    return Promise.all([
      api("GET", "/conversations/" + phone),
      api("GET", "/conversations/" + phone + "/messages?limit=60"),
    ]).then(function (res) {
      if (token !== threadReq) return;
      if (!res[0].ok || !res[1].ok) {
        WC.fail(!res[0].ok ? res[0] : res[1]);
        WC.closeChat();
        return;
      }
      cs.detail = res[0].data;
      cs.messages = res[1].data.messages || [];
      cs.hasEarlier = cs.messages.length >= 60;
      renderAll(true);
      WC.autoRead(true);
      if (window.matchMedia("(min-width: 821px)").matches) R.chats.input.focus();
    });
  };

  WC.openChat = function (phone) {
    WC.showTab("chats");
    return WC.selectChat(phone);
  };

  WC.closeChat = function () {
    var cs = S.chats;
    threadReq++;
    cs.replyTo = null;
    cs.selected = null;
    cs.detail = null;
    cs.messages = [];
    R.chats.layout.classList.remove("has-chat", "details-open");
    document.body.classList.remove("chat-open");
    R.chats.box.classList.add("hidden");
    R.chats.empty.classList.remove("hidden");
    renderChatList();
    renderDetails();
  };

  function toggleDetails() { R.chats.layout.classList.toggle("details-open"); }

  function renderAll(stickBottom) {
    renderThreadHeader();
    renderAlertBar();
    renderMessages(stickBottom);
    renderModebar();
    renderDetails();
    updateComposer();
    renderReplyBar();
  }

  // ====================================================================
  // Thread header, banners, mode bar
  // ====================================================================
  function windowState(conv) {
    if (!conv || !conv.window || !conv.window.expires_at) return { open: false, left: 0 };
    var left = new Date(conv.window.expires_at).getTime() - Date.now();
    return { open: left > 0, left: left };
  }

  function currentConv() { return S.chats.detail && S.chats.detail.conversation; }

  function renderThreadHeader() {
    var cs = S.chats, conv = currentConv();
    var name = (conv && conv.name) || WC.phone(cs.selected);
    var win = windowState(conv);

    var sub = [h("span", null, WC.phone(cs.selected))];
    if (conv) {
      sub.push(win.open
        ? WC.pill("Window open · " + fmt.left(win.left) + " left", "p-open")
        : WC.pill("Window closed", "p-closed"));
    }

    var pills = [];
    if (conv) {
      if (conv.status === "escalated") pills.push(WC.statusPill("escalated"));
      if (conv.status === "resolved") pills.push(WC.statusPill("resolved"));
      pills.push(conv.mode === "human" ? WC.pill("Human", "p-human") : WC.pill("Bot", "p-bot"));
    }

    var actions = [];
    if (conv) {
      actions.push(conv.mode === "human"
        ? h("button", { class: "btn ghost small", type: "button", title: "Hand back to bot", onClick: handBack }, icon("chat"), h("span", { class: "t" }, "Hand back to bot"))
        : h("button", { class: "btn ghost small", type: "button", title: "Take over from the bot", onClick: takeOver }, icon("user"), h("span", { class: "t" }, "Take over")));
      actions.push(conv.status === "resolved"
        ? h("button", { class: "btn ghost small", type: "button", title: "Reopen", onClick: reopenChat }, icon("clock"), h("span", { class: "t" }, "Reopen"))
        : h("button", { class: "btn small", type: "button", title: "Resolve chat", onClick: resolveChat }, icon("check"), h("span", { class: "t" }, "Resolve")));
    }
    if (conv) {
      actions.push(h("button", {
        class: "icon-btn", type: "button", "aria-label": "Chat options", title: "Chat options",
        onClick: function (e) { var r = e.currentTarget.getBoundingClientRect(); WC.chatMenu(cs.selected, conv, r.right - 250, r.bottom + 4); },
      }, icon("more")));
    }
    actions.push(h("button", { class: "icon-btn", type: "button", "aria-label": "Customer details", title: "Customer details", onClick: toggleDetails }, icon("info")));

    setKids(R.chats.head, [
      h("button", { class: "icon-btn back", type: "button", "aria-label": "Back to chats", onClick: WC.closeChat }, icon("back")),
      WC.avatar(conv && conv.name, cs.selected),
      h("div", { class: "th-main" }, h("div", { class: "th-name" }, h("span", { class: "nm" }, name), pills), h("div", { class: "th-sub" }, sub)),
      h("div", { class: "th-actions" }, actions),
    ]);
  }

  function renderAlertBar() {
    var d = S.chats.detail, bar = R.chats.alert;
    var esc = d && (d.issues || []).filter(function (i) { return i.type === "escalation" && i.status !== "resolved"; })[0];
    if (!esc) { bar.classList.add("hidden"); return; }
    setKids(bar, [icon("alert"), h("div", null, h("b", null, "Needs a person: "), esc.summary || "The customer asked to speak to the team.")]);
    bar.classList.remove("hidden");
  }

  function renderModebar() {
    var conv = currentConv(), mb = R.chats.modebar;
    if (!conv) { mb.classList.add("hidden"); return; }
    mb.classList.remove("hidden");

    if (conv.status === "resolved") {
      mb.className = "modebar resolved";
      setKids(mb, [h("span", null, "This chat is resolved. A new message from the customer will reopen it."),
        h("button", { class: "btn ghost small", type: "button", onClick: reopenChat }, "Reopen")]);
    } else if (conv.mode === "human") {
      mb.className = "modebar human";
      setKids(mb, [h("span", null, "You're handling this chat" + (conv.assigned_name ? " (" + conv.assigned_name + ")" : "") + ". The bot is paused."),
        h("button", { class: "btn ghost small", type: "button", onClick: handBack }, "Hand back to bot")]);
    } else {
      mb.className = "modebar";
      setKids(mb, [h("span", null, "The bot is answering this chat. Sending a message pauses the bot."),
        h("button", { class: "btn ghost small", type: "button", onClick: takeOver }, "Take over")]);
    }
  }

  /** Called every few seconds so the window countdown and the composer stay accurate. */
  WC.tickWindow = function () {
    if (!S.chats.selected || !S.chats.detail) return;
    renderThreadHeader();
    updateComposer();
  };

  // ====================================================================
  // Messages
  // ====================================================================
  function friendlyError(text) {
    var t = String(text || "");
    if (/131047|24 hours|re-engagement/i.test(t)) return "The 24-hour window had closed.";
    return t.replace(/^\d+:\s*/, "") || "WhatsApp did not accept it.";
  }

  function quoteBlock(m) {
    if (!m.reply_to_wa_id) return null;
    var who = m.quoted_direction === "in" ? "Customer" : m.quoted_sender === "bot" ? "Bot" : m.quoted_direction ? "Team" : "";
    var text = m.quoted_body ? String(m.quoted_body).replace(/\s+/g, " ").slice(0, 140) : "Original message not available";
    return h("div", { class: "quote " + (m.quoted_direction === "in" ? "q-in" : "q-out") }, who ? h("b", null, who) : null, h("span", null, text));
  }

  function bubble(m, tail) {
    var out = m.direction === "out";
    var kind = m.sender_type;
    var failed = m.delivery_status === "failed";
    var body = m.body || "";
    var isMedia = /^\[.*\]$/.test(body);

    var more = h("button", {
      class: "more-btn", type: "button", "aria-label": "Message options",
      onClick: function (e) { e.stopPropagation(); var r = e.currentTarget.getBoundingClientRect(); WC.messageMenu(m, r.left - 190, r.bottom + 2); },
    }, icon("more"));

    var bub = h("div", { class: "bubble" },
      more,
      out ? h("div", { class: "sender" }, kind === "bot" ? "Bot" : (m.staff_name || "Team")) : null,
      quoteBlock(m),
      WC.mediaBlock ? WC.mediaBlock(m) : null,
      (function () {
        var shown = (m.has_media && WC.mediaCaption) ? WC.mediaCaption(m) : body;
        return shown ? h("div", { class: "text" + (isMedia && !m.has_media ? " media" : "") }, WC.linkify(shown)) : null;
      })(),
      h("div", { class: "meta" },
        m.starred ? h("span", { class: "star", title: "Starred" }, icon("star")) : null,
        h("span", { class: "time" }, fmt.time(m.created_at)),
        out && !failed ? WC.ticks(m.delivery_status || "pending") : null));

    var reacts = (m.reaction || m.customer_reaction)
      ? h("div", { class: "reacts" },
          m.customer_reaction ? h("span", { title: "Customer's reaction" }, m.customer_reaction) : null,
          m.reaction ? h("span", { title: "Your reaction" }, m.reaction) : null)
      : null;

    var el = h("div", {
      class: "msg " + (out ? "out " : "in ") + kind + (tail ? " tail" : "") + (failed ? " failed" : "") + (reacts ? " has-reacts" : ""),
      "data-id": m.id,
      onContextmenu: function (e) {
        if (e.shiftKey) return; // Shift + right-click = the normal browser menu
        e.preventDefault();
        if (WC.recentTouchOpen()) return; // a long-press already opened it
        WC.messageMenu(m, e.clientX, e.clientY);
      },
    },
      bub,
      reacts,
      failed
        ? h("div", { class: "fail-row" }, icon("alert"), h("span", null, "Not delivered. " + friendlyError(m.error_text)),
            kind === "staff" ? h("button", { class: "link", type: "button", onClick: function () { retryMessage(m.id); } }, "Retry") : null)
        : null);
    WC.longPress(el, function (x, y) { WC.messageMenu(m, x, y); });
    return el;
  }

  function renderMessages(stickBottom, keepOffset) {
    var cs = S.chats, box = R.chats.scroll;
    var fromBottom = box.scrollHeight - box.scrollTop;
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    var nodes = [], lastDay = "", lastKey = "";

    if (cs.hasEarlier) {
      nodes.push(h("button", { class: "btn ghost small earlier", type: "button", onClick: loadEarlier }, "Load earlier messages"));
    }
    if (!cs.messages.length && cs.detail) nodes.push(h("div", { class: "day" }, h("span", null, "No messages yet")));

    var clearedUpTo = WC.clearedUpTo(cs.selected);
    if (clearedUpTo) {
      nodes.push(h("div", { class: "cleared" }, "Earlier messages are hidden on this device. ",
        h("button", { class: "link", type: "button", onClick: function () { WC.showAllMessages(cs.selected); } }, "Show all")));
    }
    cs.messages.filter(function (m) { return m.id > clearedUpTo; }).forEach(function (m) {
      var day = fmt.dayKey(m.created_at);
      if (day !== lastDay) {
        nodes.push(h("div", { class: "day" }, h("span", null, fmt.dayLabel(m.created_at))));
        lastDay = day;
        lastKey = "";
      }
      var key = m.direction + ":" + m.sender_type + ":" + (m.staff_id || "");
      nodes.push(bubble(m, key !== lastKey));
      lastKey = key;
    });

    setKids(R.chats.msgs, nodes);
    if (keepOffset) box.scrollTop = box.scrollHeight - fromBottom;
    else if (stickBottom || atBottom) box.scrollTop = box.scrollHeight;
  }

  function mergeMessages(incoming) {
    var cs = S.chats, index = {}, changed = false;
    cs.messages.forEach(function (m, i) { index[m.id] = i; });
    incoming.forEach(function (m) {
      var i = index[m.id];
      if (i === undefined) { cs.messages.push(m); changed = true; return; }
      var old = cs.messages[i];
      if (old.delivery_status !== m.delivery_status || old.body !== m.body || old.error_text !== m.error_text ||
          old.starred !== m.starred || old.reaction !== m.reaction || old.customer_reaction !== m.customer_reaction) {
        cs.messages[i] = m;
        changed = true;
      }
    });
    if (changed) cs.messages.sort(function (a, b) { return a.id - b.id; });
    return changed;
  }

  function loadEarlier() {
    var cs = S.chats, phone = cs.selected;
    if (!phone || !cs.messages.length) return;
    api("GET", "/conversations/" + phone + "/messages?limit=60&before=" + cs.messages[0].id).then(function (r) {
      if (!r.ok || phone !== cs.selected) return;
      var older = r.data.messages || [];
      cs.messages = older.concat(cs.messages);
      cs.hasEarlier = older.length >= 60;
      renderMessages(false, true);
    });
  }

  /** Called by the poller: fetch the newest messages and refresh ticks / add new bubbles. */
  WC.pollThread = function () {
    var cs = S.chats, phone = cs.selected, token = threadReq;
    if (!phone || !cs.detail) return Promise.resolve();
    return api("GET", "/conversations/" + phone + "/messages?limit=40").then(function (r) {
      if (!r.ok || phone !== cs.selected || token !== threadReq) return;
      if (mergeMessages(r.data.messages || [])) renderMessages(false);
    });
  };

  WC.refreshDetail = function () {
    var cs = S.chats, phone = cs.selected, token = threadReq;
    if (!phone) return Promise.resolve();
    return api("GET", "/conversations/" + phone).then(function (r) {
      if (!r.ok || phone !== cs.selected || token !== threadReq) return;
      cs.detail = r.data;
      renderThreadHeader();
      renderAlertBar();
      renderModebar();
      renderDetails();
      updateComposer();
    });
  };

  /** Mark the open chat as read (only if the dashboard is actually being looked at). */
  WC.autoRead = function (force) {
    var cs = S.chats, phone = cs.selected;
    if (!phone || readInFlight) return Promise.resolve();
    if (!force && !(document.visibilityState === "visible" && document.hasFocus())) return Promise.resolve();

    var item = cs.items.filter(function (i) { return i.phone === phone; })[0];
    var conv = currentConv();
    if (!((item && item.unread_count) || (conv && conv.unread_count))) return Promise.resolve();

    readInFlight = true;
    return api("POST", "/conversations/" + phone + "/read", {}).then(function (r) {
      readInFlight = false;
      if (!r.ok) return;
      if (item) item.unread_count = 0;
      if (conv) conv.unread_count = 0;
      renderChatList();
      if (WC.refreshSummary) WC.refreshSummary();
    });
  };

  // ====================================================================
  // Composer
  // ====================================================================
  function autoGrow() {
    var el = R.chats.input;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  function onComposerKey(e) {
    var touch = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) {
      e.preventDefault();
      sendMessage();
    }
  }

  function updateComposer() {
    var c = R.chats, conv = currentConv(), win = windowState(conv);
    var blocked = !conv || !win.open;
    c.input.disabled = blocked;
    c.send.disabled = blocked || sending;
    c.attach.disabled = blocked;
    c.tpl.classList.toggle("hidden", !(conv && blocked));
    c.input.placeholder = !conv ? "Loading..." : blocked ? "The 24-hour window has closed. Free-form replies are not allowed." : "Type a message";
  }

  function sendMessage() {
    var cs = S.chats, phone = cs.selected, input = R.chats.input;
    var text = input.value.trim();
    if (!phone || !text || sending) return;

    sending = true;
    updateComposer();
    api("POST", "/conversations/" + phone + "/messages", { text: text, reply_to: cs.replyTo ? cs.replyTo.id : null }).then(function (r) {
      sending = false;
      if (phone !== cs.selected) { updateComposer(); return; }

      if (r.status === 201 || r.status === 502) {
        input.value = "";
        autoGrow();
        cs.replyTo = null;
        renderReplyBar();
        mergeMessages(r.data.messages || []);
        renderMessages(true);
        if (r.status === 502) WC.toast(r.data.error || "WhatsApp did not accept the message.", "error");
      } else {
        WC.fail(r);
      }
      updateComposer();
      afterAction();
    });
  }

  function retryMessage(id) {
    api("POST", "/messages/" + id + "/retry", {}).then(function (r) {
      if (r.ok || r.status === 502) {
        if (r.data.message) mergeMessages([r.data.message]);
        renderMessages(false);
        if (!r.ok) WC.toast(r.data.error || "Still not accepted by WhatsApp.", "error");
        else WC.toast("Sent", "ok");
      } else {
        WC.fail(r);
      }
      afterAction();
    });
  }

  // ====================================================================
  // Chat actions
  // ====================================================================
  function afterAction() {
    return Promise.all([WC.refreshDetail(), WC.refreshChatList(), WC.refreshSummary ? WC.refreshSummary() : null]);
  }
  WC.afterChatAction = afterAction;

  function takeOver(p) {
    var phone = typeof p === "string" ? p : S.chats.selected;
    api("POST", "/conversations/" + phone + "/takeover", {}).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast("You're handling this chat. The bot is paused.", "ok");
      afterAction();
    });
  }

  function handBack(p) {
    var phone = typeof p === "string" ? p : S.chats.selected;
    api("POST", "/conversations/" + phone + "/handback", {}).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast("The bot is answering this chat again.", "ok");
      afterAction();
    });
  }

  function reopenChat(p) {
    var phone = typeof p === "string" ? p : S.chats.selected;
    api("POST", "/conversations/" + phone + "/reopen", {}).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast("Chat reopened.", "ok");
      afterAction();
    });
  }

  function resolveChat(p) {
    var phone = typeof p === "string" ? p : S.chats.selected;
    var note = h("textarea", { class: "input", placeholder: "Optional note, e.g. \"Called the customer, order confirmed\"" });
    WC.dialog({
      title: "Resolve this chat",
      body: [
        h("p", null, "The bot will answer this customer again and the request for a person is closed. Orders, appointments and tickets stay open until you resolve them one by one."),
        WC.field("Note (optional)", note),
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Resolve chat",
          onClick: function (dlg) {
            return api("POST", "/conversations/" + phone + "/resolve", { note: note.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not resolve the chat."); return false; }
              var open = r.data.still_open || {};
              var parts = [];
              if (open.orders) parts.push(open.orders + (open.orders > 1 ? " orders" : " order"));
              if (open.appointments) parts.push(open.appointments + (open.appointments > 1 ? " appointments" : " appointment"));
              if (open.issues) parts.push(open.issues + (open.issues > 1 ? " tickets" : " ticket"));
              WC.toast(parts.length ? "Chat resolved. Still open: " + parts.join(", ") + "." : "Chat resolved.", "ok");
              afterAction();
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // Customer details panel
  // ====================================================================
  function section(title, rows, kind, makeItem) {
    return h("div", { class: "d-section" },
      h("div", { class: "d-title" }, h("span", null, title), rows.length ? h("span", null, rows.length) : null),
      rows.length ? rows.map(function (it) { return makeItem(kind, it); }) : h("div", { class: "d-none" }, "None yet"));
  }

  function miniItem(kind, it) {
    var title, sub;
    if (kind === "orders") {
      title = (it.items || []).join(", ") || "Order";
      sub = [it.quantity ? "Qty " + it.quantity : "", it.delivery_address || "", it.delivery_date || ""].filter(Boolean).join(" · ");
    } else if (kind === "appointments") {
      title = [it.appt_date, it.appt_time].filter(Boolean).join(" at ") || "Appointment";
      sub = it.purpose || "";
    } else {
      title = it.summary || (it.type === "escalation" ? "Asked for a person" : "Ticket");
      sub = it.type;
    }
    return h("div", { class: "mini" },
      h("div", { class: "mini-top" }, h("span", { class: "mono" }, it.ref), WC.statusPill(it.status)),
      h("div", { class: "mini-title" }, title),
      sub ? h("div", { class: "mini-sub" }, sub) : null,
      h("div", { class: "mini-actions" }, WC.itemActions(kind, it, afterAction)));
  }

  function renderDetails() {
    var c = R.chats, d = S.chats.detail;

    // Don't wipe what the user is typing in the notes box.
    var active = document.activeElement;
    if (active && c.detailBody.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;

    if (!d) {
      setKids(c.detailBody, [h("div", { class: "details-empty" }, "Select a chat to see the customer, their notes and their orders.")]);
      return;
    }

    var cust = d.customer || {}, conv = d.conversation || {};
    var name = cust.display_name || cust.whatsapp_name || "";
    var notes = h("textarea", { class: "input notes-area", placeholder: "Notes about this customer (sizes, preferences...)" });
    notes.value = cust.notes || "";

    var card = h("div", { class: "cust-card" },
      WC.avatar(name, conv.phone),
      h("div", { class: "cust-name" }, h("span", null, name || WC.phone(conv.phone)),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Edit name", title: "Edit name", onClick: function () { editName(name); } }, icon("edit"))),
      h("div", { class: "cust-phone" }, WC.phone(conv.phone)),
      h("div", { class: "cust-links" },
        h("button", { class: "btn ghost small", type: "button", onClick: function () { WC.copy("+" + conv.phone); } }, icon("copy"), "Copy number"),
        h("a", { class: "btn ghost small", href: "https://wa.me/" + conv.phone, target: "_blank", rel: "noopener noreferrer", style: { textDecoration: "none" } }, icon("link"), "WhatsApp")),
      h("div", { class: "cust-facts" },
        cust.created_at ? "Customer since " + fmt.date(cust.created_at) : null,
        conv.assigned_name ? h("div", null, "Assigned to " + conv.assigned_name) : null));

    var notesSection = h("div", { class: "d-section" },
      h("div", { class: "d-title" }, h("span", null, "Notes")),
      notes,
      h("div", { style: { marginTop: "8px" } },
        h("button", { class: "btn ghost small", type: "button", onClick: function () { saveNotes(notes.value); } }, "Save notes")));

    setKids(c.detailBody, [
      card,
      section("Tickets & requests", d.issues || [], "issues", miniItem),
      section("Orders", d.orders || [], "orders", miniItem),
      section("Appointments", d.appointments || [], "appointments", miniItem),
      notesSection,
    ]);
  }

  function editName(current) {
    var phone = S.chats.selected;
    var input = h("input", { class: "input", type: "text", maxlength: "150", placeholder: "Customer name" });
    input.value = current || "";
    WC.dialog({
      title: "Customer name",
      body: WC.field("Name shown in the dashboard", input, "This only changes how the name appears here. It is not sent to the customer."),
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Save",
          onClick: function (dlg) {
            return api("PATCH", "/conversations/" + phone + "/customer", { display_name: input.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not save."); return false; }
              afterAction();
            });
          },
        },
      ],
    });
  }

  function saveNotes(text) {
    var phone = S.chats.selected;
    api("PATCH", "/conversations/" + phone + "/customer", { notes: text }).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast("Notes saved.", "ok");
      if (S.chats.detail && S.chats.detail.customer) S.chats.detail.customer.notes = text;
    });
  }

  // ====================================================================
  // Reply (quote) bar and hooks used by the menus (admin-menu.js)
  // ====================================================================
  WC.setReply = function (m) {
    S.chats.replyTo = m || null;
    renderReplyBar();
    if (m) R.chats.input.focus();
  };

  function renderReplyBar() {
    var bar = R.chats.replybar, m = S.chats.replyTo;
    if (!m) { bar.classList.add("hidden"); setKids(bar, []); return; }
    var who = m.direction === "in" ? ((currentConv() && currentConv().name) || "Customer") : m.sender_type === "bot" ? "Bot" : (m.staff_name || "You");
    setKids(bar, [
      h("div", { class: "rq" }, h("b", null, "Replying to " + who), h("span", null, String(m.body || "").replace(/\s+/g, " ").slice(0, 160))),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Cancel reply", onClick: function () { WC.setReply(null); } }, icon("x")),
    ]);
    bar.classList.remove("hidden");
  }

  WC.mergeMessages = mergeMessages;
  WC.rerenderMessages = function (stick) { renderMessages(!!stick); };
  WC.retryMessage = retryMessage;
  WC.takeOver = takeOver;
  WC.handBack = handBack;
  WC.reopenChat = reopenChat;
  WC.resolveChat = resolveChat;
})();