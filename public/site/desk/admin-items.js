/* Shop Desk - Tickets, Orders, Appointments, Staff access, change password. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, R = WC.R, api = WC.api, icon = WC.icon, fmt = WC.fmt, setKids = WC.setKids;

  var STATUS_TABS = {
    issues: [["open", "Open"], ["new", "New"], ["in_progress", "In progress"], ["resolved", "Resolved"], ["all", "All"]],
    orders: [["open", "Open"], ["new", "New"], ["in_progress", "In progress"], ["resolved", "Resolved"], ["cancelled", "Cancelled"], ["all", "All"]],
    appointments: [["open", "Open"], ["new", "New"], ["in_progress", "In progress"], ["resolved", "Resolved"], ["cancelled", "Cancelled"], ["all", "All"]],
  };

  var KINDS = {
    issues: {
      headA: "Tickets & ", headB: "requests",
      sub: "Support tickets and requests for a person that the bot passed to the team.",
      noun: "ticket", noteLabel: "Resolution note", canCancel: false,
    },
    orders: {
      headA: "Customer ", headB: "orders",
      sub: "Orders captured by the bot. Confirm stock, payment and delivery with the customer.",
      noun: "order", noteLabel: "Staff note", canCancel: true,
    },
    appointments: {
      headA: "Private ", headB: "appointments",
      sub: "Visits and fittings booked through WhatsApp.",
      noun: "appointment", noteLabel: "Staff note", canCancel: true,
    },
  };

  var listReq = { issues: 0, orders: 0, appointments: 0 };

  function noteOf(kind, it) { return kind === "issues" ? it.resolution_note : it.staff_note; }

  // ====================================================================
  // Generic list screen
  // ====================================================================
  WC.buildItems = function (kind) {
    var cfg = KINDS[kind], st = S.items[kind], ref = (R[kind] = {});

    ref.seg = h("div", { class: "seg", role: "tablist" });
    ref.search = h("input", {
      class: "search", type: "search", placeholder: "Search", "aria-label": "Search " + kind,
      onInput: WC.debounce(function () { st.search = ref.search.value.trim(); WC.loadItems(kind, true); }, 250),
    });
    ref.type = null;
    if (kind === "issues") {
      ref.type = h("select", { class: "input", "aria-label": "Type", onChange: function () { st.type = ref.type.value; WC.loadItems(kind, true); } },
        h("option", { value: "" }, "All types"), h("option", { value: "escalation" }, "Asked for a person"),
        h("option", { value: "support" }, "Support tickets"), h("option", { value: "inquiry" }, "Inquiries"));
    }
    ref.cards = h("div", { class: "cards" });
    ref.more = h("div", { class: "hidden", style: { marginTop: "14px" } },
      h("button", { class: "btn ghost wide", type: "button", onClick: function () { WC.loadItems(kind, false); } }, "Load more"));

    renderSeg(kind);

    return h("div", { class: "items-view" },
      h("div", { class: "items-inner" },
        h("div", { class: "view-head" },
          h("div", null, h("h2", null, cfg.headA, h("em", null, cfg.headB)), h("p", null, cfg.sub))),
        h("div", { class: "toolbar" },
          ref.seg,
          h("div", { class: "search-wrap" }, icon("search"), ref.search),
          ref.type,
          h("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", title: "Refresh", onClick: function () { WC.loadItems(kind, true); } }, icon("clock"))),
        ref.cards, ref.more));
  };

  function renderSeg(kind) {
    var st = S.items[kind];
    setKids(R[kind].seg, STATUS_TABS[kind].map(function (t) {
      return h("button", {
        class: st.status === t[0] ? "active" : "", type: "button",
        onClick: function () { st.status = t[0]; renderSeg(kind); WC.loadItems(kind, true); },
      }, t[1]);
    }));
  }

  function url(kind, limit, offset) {
    var st = S.items[kind];
    return "/" + kind + "?status=" + encodeURIComponent(st.status) + "&limit=" + limit + "&offset=" + offset +
      (st.type ? "&type=" + encodeURIComponent(st.type) : "") +
      (st.search ? "&search=" + encodeURIComponent(st.search) : "");
  }

  WC.loadItems = function (kind, reset) {
    var st = S.items[kind], token = ++listReq[kind];
    if (reset) st.offset = 0;
    return api("GET", url(kind, 30, st.offset)).then(function (r) {
      if (token !== listReq[kind]) return;
      if (!r.ok) return WC.fail(r);
      var rows = r.data[kind] || [];
      st.rows = reset ? rows : st.rows.concat(rows);
      st.hasMore = !!r.data.has_more;
      st.offset = st.rows.length;
      st.loaded = true;
      renderItems(kind);
    });
  };

  /** Re-read what is on screen (used by the poller and after an action). */
  WC.refreshItems = function (kind) {
    var st = S.items[kind];
    if (!st.loaded || !R[kind]) return Promise.resolve();
    var token = ++listReq[kind];
    var limit = Math.min(100, Math.max(30, st.rows.length));
    return api("GET", url(kind, limit, 0)).then(function (r) {
      if (token !== listReq[kind] || !r.ok) return;
      st.rows = r.data[kind] || [];
      st.hasMore = !!r.data.has_more;
      st.offset = st.rows.length;
      renderItems(kind);
    });
  };

  function emptyText(kind) {
    var st = S.items[kind], cfg = KINDS[kind];
    if (st.search) return "Nothing matches your search.";
    if (st.status === "open") return "No open " + cfg.noun + "s. New ones from WhatsApp will appear here.";
    return "No " + cfg.noun + "s with this status.";
  }

  function renderItems(kind) {
    var st = S.items[kind], ref = R[kind], top = ref.cards.parentNode.parentNode.scrollTop;
    if (!st.rows.length) {
      setKids(ref.cards, [h("div", { class: "empty-state" }, h("h3", null, st.status === "open" ? "All caught up" : "Nothing here"), h("p", null, emptyText(kind)))]);
    } else {
      setKids(ref.cards, st.rows.map(function (it) { return itemCard(kind, it); }));
    }
    ref.more.classList.toggle("hidden", !st.hasMore);
    ref.cards.parentNode.parentNode.scrollTop = top;
  }

  function kv(label, value) {
    if (value === null || value === undefined || value === "") return null;
    return h("div", null, h("b", null, label), h("span", null, value));
  }

  function typeLabel(t) {
    return t === "escalation" ? "Asked for a person" : t === "support" ? "Support ticket" : t === "inquiry" ? "Inquiry" : t;
  }

  function itemCard(kind, it) {
    var head = [];
    if (kind === "issues") head.push(WC.pill(typeLabel(it.type), it.type === "escalation" ? "p-escalated" : "p-type"));
    head.push(WC.statusPill(it.status), h("span", { class: "ref" }, it.ref), h("span", { class: "when" }, fmt.stamp(it.created_at)));

    var title, body = null, facts = [];
    var person = it.customer_name || it.chat_name || "";
    var whatsapp = it.chat_name && it.customer_name && it.chat_name !== it.customer_name ? it.chat_name : "";

    if (kind === "orders") {
      title = (it.items || []).join(", ") || "Order";
      facts = [kv("Quantity", it.quantity), kv("Delivery address", it.delivery_address), kv("Delivery date", it.delivery_date),
        kv("Customer", person), kv("WhatsApp profile", whatsapp), kv("Phone", WC.phone(it.phone))];
    } else if (kind === "appointments") {
      title = [it.appt_date, it.appt_time].filter(Boolean).join(" at ") || "Appointment";
      facts = [kv("Purpose", it.purpose), kv("Customer", person), kv("WhatsApp profile", whatsapp), kv("Phone", WC.phone(it.phone))];
    } else {
      title = it.summary || typeLabel(it.type);
      body = it.details ? h("div", { class: "card-body" }, it.details) : null;
      facts = [kv("Order", it.order_ref), kv("Customer", person), kv("WhatsApp profile", whatsapp), kv("Phone", WC.phone(it.phone))];
    }

    var who = "";
    var owner = kind === "issues" ? it.assigned_name : it.handled_by_name;
    if (it.status === "resolved" || it.status === "cancelled") {
      var by = kind === "issues" ? it.resolved_by_name : it.handled_by_name;
      who = (it.status === "resolved" ? "Resolved" : "Cancelled") + (by ? " by " + by : "") + (it.resolved_at ? " · " + fmt.stamp(it.resolved_at) : "");
    } else if (owner) {
      who = (kind === "issues" ? "Assigned to " : "Handled by ") + owner;
    }

    var note = noteOf(kind, it);
    var foot = [h("span", { class: "who" }, who)];
    WC.itemActions(kind, it).forEach(function (b) { foot.push(b); });
    foot.push(h("button", { class: "btn ghost small", type: "button", onClick: function () { editNote(kind, it); } }, icon("edit"), note ? "Edit note" : "Add note"));
    if (it.phone) foot.push(h("button", { class: "btn ghost small", type: "button", onClick: function () { WC.openChat(it.phone); } }, icon("chat"), "Open chat"));

    return h("article", { class: "card" + (it.status === "new" ? " is-new" : "") },
      h("div", { class: "card-head" }, head),
      h("div", { class: "card-title" }, title),
      body,
      h("div", { class: "kv" }, facts),
      note ? h("div", { class: "note-quote" }, note) : null,
      h("div", { class: "card-foot" }, foot));
  }

  // ====================================================================
  // Status changes (shared by the lists and the chat's details panel)
  // ====================================================================
  function btn(label, kind, fn) {
    return h("button", { class: "btn small " + (kind || ""), type: "button", onClick: fn }, label);
  }

  /** Buttons that fit this item's current status. onDone() runs after a successful change. */
  WC.itemActions = function (kind, it, onDone) {
    var cfg = KINDS[kind];
    function after() {
      WC.refreshItems(kind);
      if (onDone) onDone();
      if (WC.refreshSummary) WC.refreshSummary();
    }
    var out = [];
    if (it.status === "new") out.push(btn("Start", "ghost", function () { setStatus(kind, it, "in_progress", after); }));
    if (it.status === "new" || it.status === "in_progress") {
      out.push(btn("Resolve", "", function () { statusDialog(kind, it, "resolved", after); }));
      if (cfg.canCancel) out.push(btn("Cancel", "ghost", function () { statusDialog(kind, it, "cancelled", after); }));
    }
    if (it.status === "resolved" || it.status === "cancelled") {
      out.push(btn("Reopen", "ghost", function () { setStatus(kind, it, "in_progress", after); }));
    }
    return out;
  };

  function setStatus(kind, it, status, after) {
    api("PATCH", "/" + kind + "/" + it.id, { status: status }).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast(status === "in_progress" ? "Marked as in progress." : "Updated.", "ok");
      after();
    });
  }

  function statusDialog(kind, it, status, after) {
    var cfg = KINDS[kind];
    var verb = status === "resolved" ? "Resolve" : "Cancel";
    var note = h("textarea", { class: "input", placeholder: status === "resolved" ? "Optional, e.g. \"Delivered on Friday by courier\"" : "Optional, e.g. \"Customer changed their mind\"" });
    note.value = noteOf(kind, it) || "";
    WC.dialog({
      title: verb + " " + cfg.noun + " " + it.ref,
      body: [
        h("p", { class: "muted" }, status === "resolved"
          ? "Mark this " + cfg.noun + " as handled. It moves out of the open list but stays in your records."
          : "Cancel this " + cfg.noun + ". It stays in your records as cancelled."),
        WC.field(cfg.noteLabel, note),
      ],
      actions: [
        { label: "Back", kind: "ghost" },
        {
          label: verb + " " + cfg.noun, kind: status === "cancelled" ? "danger" : "",
          onClick: function (dlg) {
            return api("PATCH", "/" + kind + "/" + it.id, { status: status, note: note.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not update."); return false; }
              WC.toast(status === "resolved" ? "Marked as resolved." : "Cancelled.", "ok");
              after();
            });
          },
        },
      ],
    });
  }

  function editNote(kind, it) {
    var cfg = KINDS[kind];
    var note = h("textarea", { class: "input" });
    note.value = noteOf(kind, it) || "";
    WC.dialog({
      title: cfg.noteLabel,
      body: WC.field(it.ref, note, "Only the team sees this. It is never sent to the customer."),
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Save note",
          onClick: function (dlg) {
            return api("PATCH", "/" + kind + "/" + it.id, { note: note.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not save."); return false; }
              WC.toast("Note saved.", "ok");
              WC.refreshItems(kind);
              if (S.chats.selected) WC.refreshDetail();
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // Staff access (admin only)
  // ====================================================================
  WC.buildStaff = function () {
    R.staff = { body: h("div") };
    return h("div", { class: "items-view" },
      h("div", { class: "items-inner" },
        h("div", { class: "view-head" },
          h("div", null, h("h2", null, "Team ", h("em", null, "access")), h("p", null, "Who can sign in to the Shop Desk.")),
          h("button", { class: "btn", type: "button", onClick: addStaff }, icon("plus"), "Add staff member")),
        R.staff.body));
  };

  WC.loadStaff = function () {
    return api("GET", "/staff").then(function (r) {
      if (!r.ok) return WC.fail(r);
      S.staff.rows = r.data.staff || [];
      renderStaff();
    });
  };

  function renderStaff() {
    var rows = S.staff.rows.map(function (u) {
      var self = S.user && u.id === S.user.id;
      return h("tr", null,
        h("td", null, h("b", null, u.name), self ? h("span", { class: "muted" }, "  (you)") : null),
        h("td", null, u.email),
        h("td", null, WC.pill(u.role === "admin" ? "Admin" : "Staff", u.role === "admin" ? "p-human" : "p-bot")),
        h("td", null, u.active ? WC.pill("Active", "p-open") : WC.pill("Disabled", "p-closed")),
        h("td", { class: "muted" }, u.last_login_at ? fmt.stamp(u.last_login_at) : "Never"),
        h("td", { class: "actions" },
          btn("Edit", "ghost", function () { editStaff(u, self); }),
          btn("Reset password", "ghost", function () { resetPassword(u); }),
          self ? null : btn(u.active ? "Disable" : "Enable", u.active ? "danger" : "ghost", function () { toggleActive(u); })));
    });
    setKids(R.staff.body, [
      h("div", { class: "table-wrap" },
        h("table", { class: "table" },
          h("thead", null, h("tr", null, ["Name", "Email", "Role", "Status", "Last sign-in", ""].map(function (t) { return h("th", null, t); }))),
          h("tbody", null, rows))),
    ]);
  }

  function roleSelect(value, disabled) {
    var sel = h("select", { class: "input", disabled: disabled ? true : null },
      h("option", { value: "staff" }, "Staff - chats, orders, tickets"), h("option", { value: "admin" }, "Admin - also manages the team"));
    sel.value = value;
    return sel;
  }

  function addStaff() {
    var name = h("input", { class: "input", type: "text", maxlength: "100", placeholder: "Full name" });
    var email = h("input", { class: "input", type: "email", maxlength: "190", placeholder: "name@example.com", autocomplete: "off" });
    var pass = h("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
    var role = roleSelect("staff");
    WC.dialog({
      title: "Add staff member",
      body: [WC.field("Name", name), WC.field("Email (used to sign in)", email), WC.field("Starting password", pass, "Share it with them privately. They can change it after signing in."), WC.field("Role", role)],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Add",
          onClick: function (dlg) {
            return api("POST", "/staff", { name: name.value, email: email.value, password: pass.value, role: role.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not add the staff member."); return false; }
              WC.toast("Staff member added.", "ok");
              WC.loadStaff();
            });
          },
        },
      ],
    });
  }

  function editStaff(u, self) {
    var name = h("input", { class: "input", type: "text", maxlength: "100" });
    name.value = u.name;
    var role = roleSelect(u.role, self);
    WC.dialog({
      title: "Edit " + u.name,
      body: [WC.field("Name", name), WC.field("Role", role, self ? "You can't change your own role." : "")],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Save",
          onClick: function (dlg) {
            var body = { name: name.value };
            if (!self) body.role = role.value;
            return api("PATCH", "/staff/" + u.id, body).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not save."); return false; }
              WC.toast("Saved.", "ok");
              WC.loadStaff();
            });
          },
        },
      ],
    });
  }

  function resetPassword(u) {
    var pass = h("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
    WC.dialog({
      title: "Reset password for " + u.name,
      body: [h("p", { class: "muted" }, "They will be signed out everywhere and must use the new password."), WC.field("New password", pass)],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Reset password",
          onClick: function (dlg) {
            return api("PATCH", "/staff/" + u.id, { password: pass.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not reset the password."); return false; }
              WC.toast("Password reset.", "ok");
              WC.loadStaff();
            });
          },
        },
      ],
    });
  }

  function toggleActive(u) {
    var disabling = u.active;
    WC.confirm(
      disabling ? "Disable " + u.name + "?" : "Enable " + u.name + "?",
      disabling ? "They will be signed out immediately and will not be able to sign in until you enable them again." : "They will be able to sign in again.",
      disabling ? "Disable" : "Enable", disabling ? "danger" : ""
    ).then(function (yes) {
      if (!yes) return;
      api("PATCH", "/staff/" + u.id, { active: !u.active }).then(function (r) {
        if (!r.ok) return WC.fail(r);
        WC.toast(disabling ? "Disabled." : "Enabled.", "ok");
        WC.loadStaff();
      });
    });
  }

  // ====================================================================
  // Change my password
  // ====================================================================
  WC.changePasswordDialog = function () {
    var current = h("input", { class: "input", type: "password", autocomplete: "current-password" });
    var next = h("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
    var again = h("input", { class: "input", type: "password", autocomplete: "new-password" });
    WC.dialog({
      title: "Change password",
      body: [WC.field("Current password", current), WC.field("New password", next), WC.field("Repeat new password", again)],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Change password",
          onClick: function (dlg) {
            if (next.value !== again.value) { dlg.error("The new passwords don't match."); return false; }
            return api("POST", "/auth/change-password", { currentPassword: current.value, newPassword: next.value }).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not change the password."); return false; }
              WC.toast("Password changed. Other devices were signed out.", "ok");
            });
          },
        },
      ],
    });
  };
})();
