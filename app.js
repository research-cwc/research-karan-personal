/* Goa Register — shared trip expense ledger.
   Money is handled as integer paise everywhere; rupees only appear at the edges
   (parsing input, printing). Splitting distributes the remainder paise one by
   one so the shares always add back to the exact total. */

const PEOPLE = [
  "Karan", "Vidhi", "Vatsal", "Dhwani", "Diksha", "Rohan", "Sakshi",
  "Jeet", "Dhruvina", "Yash", "Minal", "Vinay", "Varun",
];

const CATEGORIES = [
  { id: "food",     label: "Food",       color: "#C2561F" },
  { id: "stay",     label: "Stay",       color: "#1B5FA8" },
  { id: "travel",   label: "Travel",     color: "#0B7A63" },
  { id: "drinks",   label: "Drinks",     color: "#8E3B8E" },
  { id: "activity", label: "Activities", color: "#1F8FA8" },
  { id: "shopping", label: "Shopping",   color: "#9A6414" },
  { id: "other",    label: "Other",      color: "#5A6B7A" },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const SETTLE_COLOR = "#0B7A63";

const LS_NAME = "goa.me";
const cfg = window.GOA_CONFIG || {};
const TRIP_ID = cfg.tripId || "goa-trip";

/* ── State ─────────────────────────────────────────────────── */
let me = null;
let entries = [];
let store = null;
let selectedCat = "food";
let participants = new Set(PEOPLE);
let settleMode = false;
let openEntryId = null;
let pendingDelete = null;

const $ = (id) => document.getElementById(id);

/* ── Money helpers ─────────────────────────────────────────── */
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(paise, { sign = false } = {}) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = abs % 100 === 0;
  const body = whole ? inr.format(abs / 100) : inr2.format(abs / 100);
  const prefix = sign ? (neg ? "−" : "+") : neg ? "−" : "";
  return `${prefix}₹${body}`;
}

function parseRupees(text) {
  const clean = String(text).replace(/[^0-9.]/g, "");
  if (!clean || clean.split(".").length > 2) return NaN;
  const value = Number(clean);
  if (!isFinite(value)) return NaN;
  return Math.round(value * 100);
}

/** Split `total` paise across `names`, handing the leftover paise out one each. */
function equalShares(total, names) {
  const n = names.length;
  const base = Math.floor(total / n);
  let left = total - base * n;
  const out = {};
  for (const name of names) {
    out[name] = base + (left > 0 ? 1 : 0);
    if (left > 0) left -= 1;
  }
  return out;
}

/* ── Storage ───────────────────────────────────────────────── */
function localStore() {
  const KEY = `goa.entries.${TRIP_ID}`;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { list = []; }
  let notify = () => {};
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota or private mode */ }
    notify(list.slice());
  };
  return {
    mode: "local",
    subscribe(fn) { notify = fn; fn(list.slice()); },
    async add(entry) {
      list.unshift({ ...entry, id: `l${Date.now()}${Math.random().toString(36).slice(2, 7)}` });
      list.sort((a, b) => b.ts - a.ts);
      save();
    },
    async remove(id) { list = list.filter((e) => e.id !== id); save(); },
  };
}

async function firebaseStore() {
  const [{ initializeApp }, fs] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
  ]);
  const app = initializeApp(cfg.firebase);
  const db = fs.getFirestore(app);
  const col = fs.collection(db, "trips", TRIP_ID, "entries");

  return {
    mode: "cloud",
    subscribe(fn, onError) {
      fs.onSnapshot(
        fs.query(col, fs.orderBy("ts", "desc")),
        (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        onError,
      );
    },
    async add(entry) { await fs.addDoc(col, entry); },
    async remove(id) { await fs.deleteDoc(fs.doc(db, "trips", TRIP_ID, "entries", id)); },
  };
}

/* ── Ledger maths ──────────────────────────────────────────── */
function computeNet(list) {
  const net = Object.fromEntries(PEOPLE.map((p) => [p, 0]));
  for (const e of list) {
    if (e.type === "settlement") {
      if (net[e.from] !== undefined) net[e.from] += e.amountPaise;
      if (net[e.to] !== undefined) net[e.to] -= e.amountPaise;
    } else {
      if (net[e.paidBy] !== undefined) net[e.paidBy] += e.amountPaise;
      for (const [name, share] of Object.entries(e.sharesPaise || {})) {
        if (net[name] !== undefined) net[name] -= share;
      }
    }
  }
  return net;
}

/** Greedy largest-creditor / largest-debtor matching — never more than n-1 transfers. */
function minTransfers(net) {
  const owed = Object.entries(net).filter(([, v]) => v > 0).map(([n, v]) => ({ n, v }));
  const owes = Object.entries(net).filter(([, v]) => v < 0).map(([n, v]) => ({ n, v: -v }));
  owed.sort((a, b) => b.v - a.v);
  owes.sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < owes.length && j < owed.length) {
    const amount = Math.min(owes[i].v, owed[j].v);
    if (amount > 0) out.push({ from: owes[i].n, to: owed[j].n, amount });
    owes[i].v -= amount;
    owed[j].v -= amount;
    if (owes[i].v === 0) i += 1;
    if (owed[j].v === 0) j += 1;
  }
  return out;
}

/* ── Rendering ─────────────────────────────────────────────── */
function fillSelect(el, names, { placeholder } = {}) {
  el.innerHTML = "";
  if (placeholder) el.append(new Option(placeholder, ""));
  for (const n of names) el.append(new Option(n, n));
}

function renderChips() {
  const catRow = $("catRow");
  catRow.innerHTML = "";
  for (const c of CATEGORIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (c.id === selectedCat ? " is-on" : "");
    b.style.color = c.id === selectedCat ? c.color : "";
    b.innerHTML = `<span class="chip-dot" style="background:${c.color}"></span>`;
    b.append(c.label);
    b.onclick = () => { selectedCat = c.id; renderChips(); };
    catRow.append(b);
  }

  const partRow = $("partRow");
  partRow.innerHTML = "";
  for (const p of PEOPLE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (participants.has(p) ? " is-on" : "");
    b.textContent = p === me ? `${p} (you)` : p;
    b.onclick = () => {
      if (participants.has(p)) participants.delete(p); else participants.add(p);
      renderChips();
      renderExact();
    };
    partRow.append(b);
  }
  $("partCount").textContent = participants.size;
}

function renderExact() {
  const box = $("exactBox");
  const on = $("splitMode").value === "exact" && !settleMode;
  box.hidden = !on;
  if (!on) return;

  const rows = $("exactRows");
  const existing = Object.fromEntries(
    [...rows.querySelectorAll("input")].map((i) => [i.dataset.name, i.value]),
  );
  rows.innerHTML = "";
  for (const p of PEOPLE) {
    if (!participants.has(p)) continue;
    const row = document.createElement("label");
    row.className = "exact-row";
    const span = document.createElement("span");
    span.textContent = p;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "0";
    input.dataset.name = p;
    input.value = existing[p] || "";
    input.oninput = updateExactSum;
    row.append(span, input);
    rows.append(row);
  }
  updateExactSum();
}

function readExact() {
  const out = {};
  let sum = 0;
  for (const input of $("exactRows").querySelectorAll("input")) {
    const v = input.value.trim() === "" ? 0 : parseRupees(input.value);
    if (isNaN(v)) return { bad: input.dataset.name };
    out[input.dataset.name] = v;
    sum += v;
  }
  return { shares: out, sum };
}

function updateExactSum() {
  const total = parseRupees($("amount").value) || 0;
  const read = readExact();
  const el = $("exactSum");
  if (read.bad) { el.textContent = "Check the numbers"; el.className = "exact-sum is-off"; return; }
  el.textContent = `${money(read.sum)} of ${money(total)}`;
  el.className = "exact-sum " + (total > 0 && read.sum === total ? "is-ok" : "is-off");
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yest)) return "Yesterday";
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

function renderEntries() {
  const list = $("entryList");
  const filter = $("filterPerson").value;
  list.innerHTML = "";

  const shown = entries.filter((e) => {
    if (!filter) return true;
    if (e.type === "settlement") return e.from === filter || e.to === filter;
    return e.paidBy === filter || (e.participants || []).includes(filter);
  });

  $("emptyState").hidden = shown.length > 0;
  if (!shown.length) return;

  let currentDay = null;
  let group = null;
  for (const e of shown) {
    const label = dayLabel(e.ts);
    if (label !== currentDay) {
      currentDay = label;
      group = document.createElement("div");
      group.className = "daygroup";
      const h = document.createElement("p");
      h.className = "daylabel";
      h.textContent = label;
      group.append(h);
      list.append(group);
    }
    group.append(entryCard(e));
  }
}

function entryCard(e) {
  const wrap = document.createElement("article");
  wrap.className = "entry" + (e.type === "settlement" ? " is-settlement" : "");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "entry-main";

  const dot = document.createElement("span");
  dot.className = "entry-dot";
  dot.style.background = e.type === "settlement" ? SETTLE_COLOR : (CAT[e.category] || CAT.other).color;

  const body = document.createElement("div");
  body.className = "entry-body";
  const desc = document.createElement("p");
  desc.className = "entry-desc";
  const meta = document.createElement("p");
  meta.className = "entry-meta";

  if (e.type === "settlement") {
    desc.textContent = `${e.from} paid ${e.to}`;
    meta.textContent = `Settling up · logged by ${e.addedBy}`;
  } else {
    desc.textContent = e.desc;
    const n = (e.participants || []).length;
    meta.textContent = `${e.paidBy} paid · split ${n === PEOPLE.length ? "between everyone" : `${n} way${n === 1 ? "" : "s"}`}`;
  }
  body.append(desc, meta);

  const right = document.createElement("div");
  right.className = "entry-right";
  const amt = document.createElement("span");
  amt.className = "entry-amount";
  amt.textContent = money(e.amountPaise);
  const you = document.createElement("span");
  const impact = yourImpact(e);
  you.className = "entry-you " + impact.tone;
  you.textContent = impact.text;
  right.append(amt, you);

  main.append(dot, body, right);
  main.onclick = () => {
    openEntryId = openEntryId === e.id ? null : e.id;
    pendingDelete = null;
    renderEntries();
  };
  wrap.append(main);

  if (openEntryId === e.id) wrap.append(entryDetail(e));
  return wrap;
}

function yourImpact(e) {
  if (!me) return { tone: "none", text: "" };
  if (e.type === "settlement") {
    if (e.from === me) return { tone: "plus", text: `you paid ${money(e.amountPaise)}` };
    if (e.to === me) return { tone: "minus", text: `you received ${money(e.amountPaise)}` };
    return { tone: "none", text: "not involved" };
  }
  const share = (e.sharesPaise || {})[me] || 0;
  if (e.paidBy === me) {
    const lent = e.amountPaise - share;
    return lent > 0
      ? { tone: "plus", text: `you lent ${money(lent)}` }
      : { tone: "none", text: "just you" };
  }
  if (share > 0) return { tone: "minus", text: `you owe ${money(share)}` };
  return { tone: "none", text: "not involved" };
}

function entryDetail(e) {
  const box = document.createElement("div");
  box.className = "entry-detail";

  if (e.type !== "settlement") {
    const grid = document.createElement("div");
    grid.className = "split-grid";
    for (const p of PEOPLE) {
      const share = (e.sharesPaise || {})[p];
      if (share === undefined) continue;
      const item = document.createElement("div");
      item.className = "split-item" + (p === e.paidBy ? " is-payer" : "");
      const a = document.createElement("span");
      a.textContent = p === e.paidBy ? `${p} (paid)` : p;
      const b = document.createElement("span");
      b.textContent = money(share);
      item.append(a, b);
      grid.append(item);
    }
    box.append(grid);
  }

  const foot = document.createElement("div");
  foot.className = "entry-foot";
  const when = document.createElement("span");
  const d = new Date(e.ts);
  when.textContent = `${(CAT[e.category] || { label: "Payment" }).label} · ${d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · added by ${e.addedBy}`;
  foot.append(when);

  if (pendingDelete === e.id) {
    const c = document.createElement("div");
    c.className = "confirm";
    const q = document.createElement("span");
    q.className = "confirm-q";
    q.textContent = "Delete for everyone?";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-danger btn-xs";
    yes.textContent = "Delete";
    yes.onclick = async () => { pendingDelete = null; await store.remove(e.id); };
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn btn-ghost btn-xs";
    no.textContent = "Keep";
    no.onclick = () => { pendingDelete = null; renderEntries(); };
    c.append(q, yes, no);
    foot.append(c);
  } else {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost btn-xs";
    del.textContent = "Delete";
    del.onclick = () => { pendingDelete = e.id; renderEntries(); };
    foot.append(del);
  }

  box.append(foot);
  return box;
}

function renderBalances() {
  const net = computeNet(entries);
  const list = $("balanceList");
  list.innerHTML = "";

  const max = Math.max(1, ...Object.values(net).map((v) => Math.abs(v)));
  const sorted = [...PEOPLE].sort((a, b) => net[b] - net[a]);

  for (const p of sorted) {
    const v = net[p];
    const row = document.createElement("div");
    row.className = "bal";

    const name = document.createElement("div");
    name.className = "bal-name";
    name.textContent = p;
    if (p === me) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "you";
      name.append(tag);
    }

    const amt = document.createElement("div");
    amt.className = "bal-amt " + (v > 0 ? "plus" : v < 0 ? "minus" : "zero");
    amt.textContent = v === 0 ? "settled" : money(v, { sign: true });

    const bar = document.createElement("div");
    bar.className = "bal-bar";
    const fill = document.createElement("i");
    const pct = (Math.abs(v) / max) * 50;
    if (v >= 0) { fill.style.left = "50%"; fill.style.background = "var(--plus)"; }
    else { fill.style.right = "50%"; fill.style.background = "var(--minus)"; }
    fill.style.width = `${pct}%`;
    bar.append(fill);

    const note = document.createElement("div");
    note.className = "bal-note";
    note.textContent = v > 0 ? `gets back ${money(v)}` : v < 0 ? `owes ${money(-v)}` : "all square";

    row.append(name, amt, bar, note);
    list.append(row);
  }

  // Category breakdown
  const totals = {};
  let grand = 0;
  for (const e of entries) {
    if (e.type === "settlement") continue;
    const c = e.category || "other";
    totals[c] = (totals[c] || 0) + e.amountPaise;
    grand += e.amountPaise;
  }
  const bd = $("catBreakdown");
  bd.innerHTML = "";
  const rows = CATEGORIES.filter((c) => totals[c.id]).sort((a, b) => totals[b.id] - totals[a.id]);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "card-sub";
    p.style.marginTop = "0";
    p.textContent = "Nothing to break down yet.";
    bd.append(p);
  }
  for (const c of rows) {
    const row = document.createElement("div");
    row.className = "bd-row";
    const label = document.createElement("span");
    label.textContent = c.label;
    const track = document.createElement("div");
    track.className = "bd-track";
    const fill = document.createElement("i");
    fill.style.width = `${(totals[c.id] / grand) * 100}%`;
    fill.style.background = c.color;
    track.append(fill);
    const val = document.createElement("span");
    val.className = "bd-val";
    val.textContent = money(totals[c.id]);
    row.append(label, track, val);
    bd.append(row);
  }
}

function renderSettle() {
  const net = computeNet(entries);
  const transfers = minTransfers(net);
  const box = $("settleList");
  box.innerHTML = "";

  if (!transfers.length) {
    const p = document.createElement("p");
    p.className = "all-clear";
    p.textContent = entries.length ? "Everyone is square. Nothing to pay." : "No expenses yet.";
    box.append(p);
    return;
  }

  for (const t of transfers) {
    const row = document.createElement("div");
    row.className = "settle-row" + (t.from === me || t.to === me ? " is-yours" : "");

    const text = document.createElement("div");
    text.className = "settle-text";
    text.innerHTML = `<strong>${t.from === me ? "You" : t.from}</strong> → <strong>${t.to === me ? "you" : t.to}</strong>`;

    const amt = document.createElement("span");
    amt.className = "settle-amt";
    amt.textContent = money(t.amount);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.textContent = "Mark paid";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await store.add({
          type: "settlement",
          from: t.from, to: t.to,
          amountPaise: t.amount,
          addedBy: me,
          ts: Date.now(),
        });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Mark paid";
        showStatus(`Could not save that payment: ${err.message}`, true);
      }
    };

    row.append(text, amt, btn);
    box.append(row);
  }
}

function renderSummary() {
  const net = computeNet(entries);
  let total = 0;
  let yourShare = 0;
  for (const e of entries) {
    if (e.type === "settlement") continue;
    total += e.amountPaise;
    yourShare += (e.sharesPaise || {})[me] || 0;
  }
  $("sumTotal").textContent = money(total);
  $("sumYourShare").textContent = money(yourShare);

  const v = net[me] || 0;
  const el = $("sumNet");
  el.textContent = v === 0 ? "settled" : money(Math.abs(v));
  el.className = "summary-value " + (v > 0 ? "plus" : v < 0 ? "minus" : "");
  $("sumNetLabel").textContent = v > 0 ? "You get back" : v < 0 ? "You owe" : "Your balance";

  const count = entries.filter((e) => e.type !== "settlement").length;
  $("tripSub").textContent = `${PEOPLE.length} people · ${count} expense${count === 1 ? "" : "s"}`;
}

function renderAll() {
  renderSummary();
  renderEntries();
  renderBalances();
  renderSettle();
}

/* ── Form ──────────────────────────────────────────────────── */
function setSettleMode(on) {
  settleMode = on;
  $("settleBox").hidden = !on;
  $("submitBtn").textContent = on ? "Record payment" : "Add expense";
  $("settleToggle").textContent = on ? "Back to adding an expense" : "Record a payment instead";
  for (const id of ["desc", "paidBy", "splitMode"]) $(id).closest(".field").hidden = on;
  $("catRow").closest(".field").hidden = on;
  $("partRow").closest(".field").hidden = on;
  $("desc").required = !on;
  renderExact();
}

function showError(msg) {
  const el = $("formError");
  el.hidden = !msg;
  el.textContent = msg || "";
}

function showStatus(msg, isError = false) {
  const el = $("statusBar");
  el.hidden = !msg;
  el.className = "statusbar" + (isError ? " is-error" : "");
  el.textContent = msg || "";
}

async function onSubmit(ev) {
  ev.preventDefault();
  showError("");

  const amountPaise = parseRupees($("amount").value);
  if (!amountPaise || amountPaise <= 0 || isNaN(amountPaise)) {
    showError("Enter an amount greater than zero.");
    return;
  }

  let entry;
  if (settleMode) {
    const from = $("payFrom").value;
    const to = $("payTo").value;
    if (from === to) { showError("Pick two different people for a payment."); return; }
    entry = { type: "settlement", from, to, amountPaise, addedBy: me, ts: Date.now() };
  } else {
    const desc = $("desc").value.trim();
    if (!desc) { showError("Add a short description."); return; }
    const names = PEOPLE.filter((p) => participants.has(p));
    if (!names.length) { showError("Pick at least one person to split this between."); return; }

    let shares;
    if ($("splitMode").value === "exact") {
      const read = readExact();
      if (read.bad) { showError(`That is not a number for ${read.bad}.`); return; }
      if (read.sum !== amountPaise) {
        showError(`Shares add up to ${money(read.sum)}, but the expense is ${money(amountPaise)}.`);
        return;
      }
      shares = Object.fromEntries(Object.entries(read.shares).filter(([, v]) => v > 0));
      if (!Object.keys(shares).length) { showError("Give at least one person a share."); return; }
    } else {
      shares = equalShares(amountPaise, names);
    }

    entry = {
      type: "expense",
      desc,
      category: selectedCat,
      amountPaise,
      paidBy: $("paidBy").value,
      participants: Object.keys(shares),
      sharesPaise: shares,
      addedBy: me,
      ts: Date.now(),
    };
  }

  const btn = $("submitBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Saving…";
  try {
    await store.add(entry);
    $("amount").value = "";
    $("desc").value = "";
    $("exactRows").querySelectorAll("input").forEach((i) => { i.value = ""; });
    updateExactSum();
    if (settleMode) setSettleMode(false);
  } catch (err) {
    showError(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ── CSV ───────────────────────────────────────────────────── */
function exportCsv() {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ["Date", "Type", "Description", "Category", "Amount (INR)", "Paid by", "Split between", "Per person", "Added by"];
  const rows = entries.map((e) => {
    const when = new Date(e.ts).toLocaleString("en-IN");
    if (e.type === "settlement") {
      return [when, "Payment", `${e.from} paid ${e.to}`, "", (e.amountPaise / 100).toFixed(2), e.from, e.to, "", e.addedBy];
    }
    const shares = Object.entries(e.sharesPaise || {}).map(([n, v]) => `${n}: ${(v / 100).toFixed(2)}`).join("; ");
    return [when, "Expense", e.desc, (CAT[e.category] || CAT.other).label, (e.amountPaise / 100).toFixed(2), e.paidBy, (e.participants || []).join("; "), shares, e.addedBy];
  });
  const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `goa-register-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Boot ──────────────────────────────────────────────────── */
function setMe(name) {
  me = name;
  try { localStorage.setItem(LS_NAME, name); } catch { /* private mode */ }
  $("whoSelect").value = name;
  $("paidBy").value = name;
  $("payFrom").value = name;
  const other = PEOPLE.find((p) => p !== name);
  if ($("payTo").value === name) $("payTo").value = other;
  renderChips();
  renderAll();
}

function wireUi() {
  fillSelect($("gateSelect"), PEOPLE, { placeholder: "Select your name…" });
  fillSelect($("whoSelect"), PEOPLE);
  fillSelect($("paidBy"), PEOPLE);
  fillSelect($("payFrom"), PEOPLE);
  fillSelect($("payTo"), PEOPLE);
  fillSelect($("filterPerson"), PEOPLE, { placeholder: "Everyone" });
  $("payTo").value = PEOPLE[1];

  $("gateSelect").onchange = (e) => { $("gateGo").disabled = !e.target.value; };
  $("gateGo").onclick = () => {
    const name = $("gateSelect").value;
    if (!name) return;
    $("gate").hidden = true;
    $("app").hidden = false;
    setMe(name);
  };

  $("whoSelect").onchange = (e) => setMe(e.target.value);

  for (const tab of document.querySelectorAll(".tab")) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll(".tab")) {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", String(on));
      }
      for (const v of ["expenses", "balances", "settle"]) {
        $(`view-${v}`).hidden = v !== tab.dataset.tab;
      }
    };
  }

  for (const btn of document.querySelectorAll("[data-select]")) {
    btn.onclick = () => {
      const kind = btn.dataset.select;
      if (kind === "all") participants = new Set(PEOPLE);
      else if (kind === "none") participants = new Set();
      else participants = new Set(me ? [me] : []);
      renderChips();
      renderExact();
    };
  }

  $("splitMode").onchange = renderExact;
  $("amount").addEventListener("input", updateExactSum);
  $("settleToggle").onclick = () => setSettleMode(!settleMode);
  $("expenseForm").addEventListener("submit", onSubmit);
  $("filterPerson").onchange = renderEntries;
  $("exportBtn").onclick = exportCsv;
}

async function start() {
  wireUi();

  const saved = (() => { try { return localStorage.getItem(LS_NAME); } catch { return null; } })();
  if (saved && PEOPLE.includes(saved)) {
    $("app").hidden = false;
    setMe(saved);
  } else {
    $("gate").hidden = false;
  }

  const hasFirebase = cfg.firebase && cfg.firebase.projectId;
  if (hasFirebase) {
    try {
      store = await firebaseStore();
      $("syncNote").textContent = `Live · everyone on this link shares one register (trip: ${TRIP_ID})`;
      store.subscribe(
        (list) => { entries = list; renderAll(); },
        (err) => showStatus(`Lost the live connection: ${err.message}. Check the Firestore rules.`, true),
      );
      return;
    } catch (err) {
      showStatus(`Could not reach Firebase (${err.message}) — running on this device only.`, true);
    }
  } else {
    showStatus("Not connected yet: expenses save to this device only. Add your Firebase keys to firebase-config.js to share the register.");
  }

  store = localStore();
  $("syncNote").textContent = "Local mode · saved in this browser only";
  store.subscribe((list) => { entries = list; renderAll(); });
}

start();
