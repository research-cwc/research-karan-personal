/* Goa Register — shared trip expense ledger.

   Money is integer paise everywhere; rupees exist only at the edges (parsing
   input, printing). Every division uses largest-remainder allocation, so the
   parts always add back to the exact total — no paise appears or vanishes.

   An expense records who put money in (one payer or several) and who the cost
   falls on (equally, exact, percentage, shares, or equally-plus-extras). Debts
   are tracked pairwise: each participant owes each payer in proportion to what
   that payer put in. Net balance per person always equals paid − share. */

import {
  DEFAULT_PEOPLE, CATEGORIES, CAT, SETTLE_COLOR, SPLIT_HINTS,
  money, parseRupees, parseNumber, computeShares,
  normalize, payerNames, shareNames, involves, peopleInEntries,
  buildLedger, minTransfers, directTransfers,
} from "./ledger.js?v=5";

const LS_NAME = "goa.me";
const cfg = window.GOA_CONFIG || {};
const TRIP_ID = cfg.tripId || "goa-trip";

/* ── State ─────────────────────────────────────────────────── */
let me = null;
let entries = [];
let store = null;
let selectedCat = "food";
/* The roster lives in the database, not in this file. DEFAULT_PEOPLE is only
   the starting point for a trip that has not saved one yet. */
let PEOPLE = DEFAULT_PEOPLE.slice();
let participants = new Set(PEOPLE);
let payers = new Set();
let payerMode = "one";
let settleMode = false;
let editingId = null;
let openEntryId = null;
let openPerson = null;
let pendingDelete = null;
let settleView = "simple";

const $ = (id) => document.getElementById(id);

/* A viewer can be holding a cached index.html while running a newer app.js, so
   an element this code knows about may not be on their page yet. Wiring through
   these means the page loses that one feature instead of failing to start. */
const on = (id, event, fn) => { const el = $(id); if (el) el.addEventListener(event, fn); };

/* ── Storage ───────────────────────────────────────────────── */
function localStore() {
  const KEY = `goa.entries.${TRIP_ID}`;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { list = []; }
  let notify = () => {};
  let rosterNotify = () => {};
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota or private mode */ }
    notify(list.slice());
  };
  return {
    mode: "local",
    subscribe(fn) { notify = fn; fn(list.slice()); },
    subscribeRoster(fn) {
      let names = null;
      try { names = JSON.parse(localStorage.getItem(`goa.roster.${TRIP_ID}`) || "null"); } catch { names = null; }
      rosterNotify = fn;
      fn(names);
    },
    async saveRoster(names) {
      try { localStorage.setItem(`goa.roster.${TRIP_ID}`, JSON.stringify(names)); } catch { /* private mode */ }
      rosterNotify(names);
    },
    async add(entry) { list.unshift({ ...entry, id: `l${Date.now()}${Math.random().toString(36).slice(2, 7)}` }); save(); },
    async update(id, entry) { list = list.map((e) => (e.id === id ? { ...entry, id } : e)); save(); },
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
  const ref = (id) => fs.doc(db, "trips", TRIP_ID, "entries", id);

  return {
    mode: "cloud",
    subscribe(fn, onError) {
      fs.onSnapshot(fs.query(col, fs.orderBy("ts", "desc")),
        (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
    },
    subscribeRoster(fn, onError) {
      fs.onSnapshot(fs.doc(db, "trips", TRIP_ID, "meta", "roster"),
        (snap) => fn(snap.exists() ? snap.data().names : null), onError);
    },
    async saveRoster(names) {
      await fs.setDoc(fs.doc(db, "trips", TRIP_ID, "meta", "roster"),
        { names, updatedBy: me, updatedTs: Date.now() });
    },
    async add(entry) { await fs.addDoc(col, entry); },
    async update(id, entry) { await fs.setDoc(ref(id), entry); },
    async remove(id) { await fs.deleteDoc(ref(id)); },
  };
}

/* ── Form: reading the current state ───────────────────────── */
function selectedParticipants() { return PEOPLE.filter((p) => participants.has(p)); }
function selectedPayers() { return PEOPLE.filter((p) => payers.has(p)); }

function readAmountRows(container) {
  const out = {};
  let bad = null;
  for (const input of container.querySelectorAll("input")) {
    const raw = input.value.trim();
    const v = raw === "" ? 0 : (input.dataset.kind === "number" ? parseNumber(raw) : parseRupees(raw));
    if (isNaN(v)) bad = input.dataset.name;
    out[input.dataset.name] = isNaN(v) ? 0 : v;
  }
  return { values: out, bad };
}

function currentPayers(total) {
  if (payerMode === "one") {
    const who = $("paidBy").value;
    return { values: { [who]: total }, bad: null };
  }
  return readAmountRows($("payersRows"));
}

function currentSplitInput() {
  const method = $("splitMode").value;
  if (method === "equal") return { values: {}, bad: null };
  return readAmountRows($("splitRows"));
}

/* ── Form: rendering ───────────────────────────────────────── */
function renderCats() {
  const row = $("catRow");
  row.innerHTML = "";
  for (const c of CATEGORIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (c.id === selectedCat ? " is-on" : "");
    if (c.id === selectedCat) b.style.color = c.color;
    b.innerHTML = `<span class="chip-dot" style="background:${c.color}"></span>`;
    b.append(c.label);
    b.onclick = () => { selectedCat = c.id; renderCats(); };
    row.append(b);
  }
}

function renderParticipantChips() {
  const row = $("partRow");
  row.innerHTML = "";
  for (const p of PEOPLE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (participants.has(p) ? " is-on" : "");
    b.textContent = p === me ? `${p} (you)` : p;
    b.onclick = () => {
      if (participants.has(p)) participants.delete(p); else participants.add(p);
      renderParticipantChips();
      renderSplitRows();
    };
    row.append(b);
  }
  $("partCount").textContent = participants.size;
}

function renderPayerRows() {
  const box = $("payersBox");
  box.hidden = payerMode !== "many";
  $("paidBy").hidden = payerMode === "many";
  if (payerMode !== "many") { updatePreview(); return; }

  const rows = $("payersRows");
  const prev = Object.fromEntries([...rows.querySelectorAll("input")].map((i) => [i.dataset.name, i.value]));
  rows.innerHTML = "";
  for (const p of PEOPLE) {
    const row = document.createElement("label");
    row.className = "amount-row" + (payers.has(p) ? " is-on" : "");
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = "row-toggle" + (payers.has(p) ? " is-on" : "");
    tick.textContent = p === me ? `${p} (you)` : p;
    tick.onclick = () => {
      if (payers.has(p)) payers.delete(p); else payers.add(p);
      renderPayerRows();
    };
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "0";
    input.dataset.name = p;
    input.dataset.kind = "money";
    input.value = prev[p] || "";
    input.disabled = !payers.has(p);
    input.oninput = updatePreview;
    row.append(tick, input);
    if (payers.has(p)) row.append(restButton(input));
    rows.append(row);
  }
  updatePreview();
}

/** Appears only while its row has focus: drops whatever is still unassigned
 *  into this box, so the last payer never has to do the subtraction. */
function restButton(input) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rest-btn";
  btn.tabIndex = -1;
  btn.textContent = "rest";
  btn.onmousedown = (ev) => ev.preventDefault();
  btn.onclick = () => {
    const left = Number(btn.dataset.left || 0);
    const own = parseRupees(input.value) || 0;
    input.value = ((own + left) / 100).toString();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  return btn;
}

function renderSplitRows() {
  const method = $("splitMode").value;
  const box = $("splitBox");
  const needsInputs = method !== "equal" && !settleMode;
  box.hidden = !needsInputs;

  if (needsInputs) {
    const meta = SPLIT_HINTS[method];
    $("splitHint").textContent = meta.hint;
    const rows = $("splitRows");
    const prev = Object.fromEntries([...rows.querySelectorAll("input")].map((i) => [i.dataset.name, i.value]));
    rows.innerHTML = "";
    const isMoney = method === "exact" || method === "adjust";
    for (const p of selectedParticipants()) {
      const row = document.createElement("label");
      row.className = "amount-row is-on";
      const tag = document.createElement("span");
      tag.className = "row-name";
      tag.textContent = p === me ? `${p} (you)` : p;
      const wrap = document.createElement("span");
      wrap.className = "unit-wrap";
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = meta.unit;
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.placeholder = "0";
      input.dataset.name = p;
      input.dataset.kind = isMoney ? "money" : "number";
      input.value = prev[p] || "";
      input.oninput = updatePreview;
      wrap.append(unit, input);
      row.append(tag, wrap);
      if (method === "exact" || method === "percent") row.append(restButton(input));
      rows.append(row);
    }
  }
  updatePreview();
}

/** Says what is still missing rather than what has been entered, because the
 *  number you need next is the difference, not the running total. */
function remainderLine(sum, total, fmt) {
  if (total <= 0) return { text: "Enter the amount first", cls: "" };
  if (sum === total) return { text: `All ${fmt(total)} accounted for`, cls: "is-ok" };
  if (sum < total) return { text: `${fmt(total - sum)} left to put in`, cls: "is-wait" };
  return { text: `${fmt(sum - total)} too much`, cls: "is-off" };
}

function applyRemainder(rows, left, fmt) {
  for (const input of rows.querySelectorAll("input")) {
    const empty = !input.value.trim() || Number(input.value) === 0;
    input.placeholder = !input.disabled && empty && left > 0 ? fmt(left) : "0";
  }
  for (const btn of rows.querySelectorAll(".rest-btn")) {
    btn.dataset.left = String(left);
    btn.hidden = left <= 0;
    btn.textContent = `+${fmt(left)}`;
  }
}

function updatePreview() {
  if (settleMode) { $("preview").hidden = true; return; }
  const total = parseRupees($("amount").value) || 0;
  const names = selectedParticipants();
  const asMoney = (v) => money(v);
  const asPlain = (v) => String(Math.round(v * 100) / 100);

  if (payerMode === "many") {
    const { values } = currentPayers(total);
    const sum = selectedPayers().reduce((a, n) => a + (values[n] || 0), 0);
    const line = remainderLine(sum, total, asMoney);
    const el = $("payersSum");
    el.textContent = line.text;
    el.className = "sub-sum " + line.cls;
    applyRemainder($("payersRows"), total - sum, (v) => asMoney(v).replace("₹", ""));
  }

  const method = $("splitMode").value;
  const { values } = currentSplitInput();
  const result = total > 0 ? computeShares(method, total, names, values) : { error: "" };

  if (method !== "equal") {
    const el = $("splitSum");
    const sum = names.reduce((a, n) => a + (values[n] || 0), 0);
    if (method === "exact") {
      const line = remainderLine(sum, total, asMoney);
      el.textContent = line.text;
      el.className = "sub-sum " + line.cls;
      applyRemainder($("splitRows"), total - sum, (v) => asMoney(v).replace("₹", ""));
    } else if (method === "percent") {
      const line = remainderLine(Math.round(sum * 100), 10000, (v) => `${Math.round(v) / 100}%`);
      el.textContent = line.text;
      el.className = "sub-sum " + line.cls;
      applyRemainder($("splitRows"), Math.round((100 - sum) * 100) / 100, asPlain);
    } else if (method === "shares") {
      el.textContent = sum > 0 ? `${sum} share${sum === 1 ? "" : "s"} between ${names.length}` : "Give someone at least one share";
      el.className = "sub-sum " + (sum > 0 ? "is-ok" : "is-wait");
    } else {
      const base = total - sum;
      el.textContent = total <= 0 ? "Enter the amount first"
        : base < 0 ? `${asMoney(-base)} more than the expense`
        : `${asMoney(base)} split equally on top`;
      el.className = "sub-sum " + (total > 0 && base >= 0 ? "is-ok" : "is-off");
    }
  }

  const box = $("preview");
  const rows = $("previewRows");
  if (!total || !names.length || result.error || !result.shares) { box.hidden = true; return; }
  box.hidden = false;
  rows.innerHTML = "";
  for (const n of names) {
    const item = document.createElement("div");
    item.className = "preview-item";
    const a = document.createElement("span");
    a.textContent = n === me ? `${n} (you)` : n;
    const b = document.createElement("span");
    b.textContent = money(result.shares[n]);
    item.append(a, b);
    rows.append(item);
  }
}

/* ── Form: modes ───────────────────────────────────────────── */
function setPayerMode(mode) {
  payerMode = mode;
  for (const btn of document.querySelectorAll("[data-payers]")) {
    btn.classList.toggle("is-on", btn.dataset.payers === mode);
  }
  if (mode === "many" && !payers.size && me) payers.add(me);
  renderPayerRows();
}

function setSettleMode(on) {
  settleMode = on;
  $("settleBox").hidden = !on;
  $("descField").hidden = on;
  $("catField").hidden = on;
  $("paidField").hidden = on;
  $("splitField").hidden = on;
  $("desc").required = !on;
  if (!editingId) {
    $("formTitle").textContent = on ? "Record a payment" : "Add an expense";
    $("submitBtn").textContent = on ? "Record payment" : "Add expense";
  }
  $("settleToggle").textContent = on ? "Back to adding an expense" : "Record a payment instead";
  renderSplitRows();
}

function resetForm() {
  editingId = null;
  $("amount").value = "";
  $("desc").value = "";
  $("note").value = "";
  $("date").value = new Date().toLocaleDateString("en-CA");
  selectedCat = "food";
  participants = new Set(PEOPLE);
  payers = new Set(me ? [me] : []);
  $("splitMode").value = "equal";
  $("paidBy").value = me || PEOPLE[0];
  $("cancelEdit").hidden = true;
  $("formTitle").textContent = settleMode ? "Record a payment" : "Add an expense";
  $("submitBtn").textContent = settleMode ? "Record payment" : "Add expense";
  $("splitRows").innerHTML = "";
  $("payersRows").innerHTML = "";
  showError("");
  setPayerMode("one");
  renderCats();
  renderParticipantChips();
  renderSplitRows();
}

function loadForEdit(e) {
  editingId = e.id;
  showError("");
  $("amount").value = (e.amountPaise / 100).toString();
  $("date").value = e.date;
  $("note").value = e.note || "";

  if (e.type === "settlement") {
    setSettleMode(true);
    $("payFrom").value = e.from;
    $("payTo").value = e.to;
  } else {
    setSettleMode(false);
    $("desc").value = e.desc;
    selectedCat = CAT[e.category] ? e.category : "other";
    participants = new Set(Object.keys(e.sharesPaise));
    const pn = payerNames(e);
    if (pn.length <= 1) {
      setPayerMode("one");
      $("paidBy").value = pn[0] || me;
    } else {
      payers = new Set(pn);
      setPayerMode("many");
      for (const input of $("payersRows").querySelectorAll("input")) {
        if (e.payersPaise[input.dataset.name]) input.value = (e.payersPaise[input.dataset.name] / 100).toString();
      }
    }
    $("splitMode").value = e.splitMethod || "equal";
    renderCats();
    renderParticipantChips();
    renderSplitRows();
    if (e.splitInput) {
      for (const input of $("splitRows").querySelectorAll("input")) {
        const v = e.splitInput[input.dataset.name];
        if (v === undefined) continue;
        input.value = (input.dataset.kind === "money" ? v / 100 : v).toString();
      }
    }
  }

  $("formTitle").textContent = e.type === "settlement" ? "Edit this payment" : "Edit this expense";
  $("submitBtn").textContent = "Save changes";
  $("cancelEdit").hidden = false;
  updatePreview();
  $("expenseForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Submit ────────────────────────────────────────────────── */
async function onSubmit(ev) {
  ev.preventDefault();
  showError("");

  const amountPaise = parseRupees($("amount").value);
  if (isNaN(amountPaise) || amountPaise <= 0) return showError("Enter an amount greater than zero.");
  const date = $("date").value;
  if (!date) return showError("Pick a date.");
  const note = $("note").value.trim();

  let entry;

  if (settleMode) {
    const from = $("payFrom").value;
    const to = $("payTo").value;
    if (from === to) return showError("A payment needs two different people.");
    entry = { type: "settlement", from, to, amountPaise, date, addedBy: me, ts: Date.now() };
  } else {
    const desc = $("desc").value.trim();
    if (!desc) return showError("Add a short description.");

    const pay = currentPayers(amountPaise);
    if (pay.bad) return showError(`That is not a number for ${pay.bad}.`);
    const payerList = payerMode === "one" ? [$("paidBy").value] : selectedPayers();
    if (!payerList.length) return showError("Pick who paid.");
    const payersPaise = {};
    for (const n of payerList) if (pay.values[n] > 0) payersPaise[n] = pay.values[n];
    const paidSum = Object.values(payersPaise).reduce((a, b) => a + b, 0);
    if (!Object.keys(payersPaise).length) return showError("Enter what each payer put in.");
    if (paidSum !== amountPaise) {
      return showError(`The payers put in ${money(paidSum)}, but the expense is ${money(amountPaise)} — ${money(Math.abs(amountPaise - paidSum))} ${paidSum > amountPaise ? "too much" : "short"}.`);
    }

    const method = $("splitMode").value;
    const names = selectedParticipants();
    const inp = currentSplitInput();
    if (inp.bad) return showError(`That is not a number for ${inp.bad}.`);
    const result = computeShares(method, amountPaise, names, inp.values);
    if (result.error) return showError(result.error);

    const sharesPaise = {};
    for (const [n, v] of Object.entries(result.shares)) if (v !== 0) sharesPaise[n] = v;
    if (!Object.keys(sharesPaise).length) return showError("Nobody ends up owing anything — check the split.");

    entry = {
      type: "expense",
      desc,
      category: selectedCat,
      amountPaise,
      date,
      payersPaise,
      sharesPaise,
      splitMethod: method,
      addedBy: me,
      ts: Date.now(),
    };
    if (method !== "equal") entry.splitInput = Object.fromEntries(names.map((n) => [n, inp.values[n] || 0]));
  }

  if (note) entry.note = note;

  const btn = $("submitBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    if (editingId) {
      const old = entries.find((e) => e.id === editingId);
      entry.addedBy = old.addedBy;
      entry.ts = old.ts;
      entry.editedBy = me;
      entry.editedTs = Date.now();
      await store.update(editingId, entry);
      openEntryId = editingId;
      resetForm();
      if (settleMode) setSettleMode(false);
    } else {
      await store.add(entry);
      const keepSettle = settleMode;
      resetForm();
      if (keepSettle) setSettleMode(false);
    }
  } catch (err) {
    showError(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = editingId ? "Save changes" : label;
  }
}

/* ── Entry list ────────────────────────────────────────────── */
function sortedEntries() {
  return entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
}

function dayLabel(dateStr) {
  const today = new Date().toLocaleDateString("en-CA");
  const yest = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
  if (dateStr === today) return "Today";
  if (dateStr === yest) return "Yesterday";
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

function payerLabel(e) {
  const names = payerNames(e);
  if (names.length === 1) return `${names[0]} paid`;
  if (names.length === 2) return `${names[0]} and ${names[1]} paid`;
  return `${names[0]} and ${names.length - 1} others paid`;
}

function splitLabel(e) {
  const n = shareNames(e).length;
  const how = { equal: "equally", exact: "by exact amounts", percent: "by percentage", shares: "by shares", adjust: "equally plus extras" }[e.splitMethod] || "";
  if (n === PEOPLE.length) return `split ${how} between everyone`;
  return `split ${how} ${n} way${n === 1 ? "" : "s"}`;
}

function renderEntries() {
  const list = $("entryList");
  const filter = $("filterPerson").value;
  list.innerHTML = "";

  const shown = sortedEntries().filter((e) => !filter || involves(e, filter));
  $("emptyState").hidden = shown.length > 0;
  if (!shown.length) return;

  let currentDay = null;
  let group = null;
  for (const e of shown) {
    if (e.date !== currentDay) {
      currentDay = e.date;
      group = document.createElement("div");
      group.className = "daygroup";
      const h = document.createElement("p");
      h.className = "daylabel";
      h.textContent = dayLabel(e.date);
      group.append(h);
      list.append(group);
    }
    group.append(entryCard(e));
  }
}

function yourImpact(e) {
  if (!me) return { tone: "none", text: "" };
  if (e.type === "settlement") {
    if (e.from === me) return { tone: "plus", text: `you paid ${money(e.amountPaise)}` };
    if (e.to === me) return { tone: "minus", text: `you received ${money(e.amountPaise)}` };
    return { tone: "none", text: "not involved" };
  }
  const put = (e.payersPaise || {})[me] || 0;
  const owes = (e.sharesPaise || {})[me] || 0;
  const diff = put - owes;
  if (!put && !owes) return { tone: "none", text: "not involved" };
  if (diff > 0) return { tone: "plus", text: `you lent ${money(diff)}` };
  if (diff < 0) return { tone: "minus", text: `you owe ${money(-diff)}` };
  return { tone: "none", text: "square on this" };
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
    meta.textContent = `${payerLabel(e)} · ${splitLabel(e)}`;
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

function entryDetail(e) {
  const box = document.createElement("div");
  box.className = "entry-detail";

  if (e.type !== "settlement") {
    const pn = payerNames(e);
    if (pn.length > 1) {
      const head = document.createElement("p");
      head.className = "detail-head";
      head.textContent = "Put in";
      const grid = document.createElement("div");
      grid.className = "split-grid";
      for (const p of pn) {
        const item = document.createElement("div");
        item.className = "split-item is-payer";
        const a = document.createElement("span");
        a.textContent = p;
        const b = document.createElement("span");
        b.textContent = money(e.payersPaise[p]);
        item.append(a, b);
        grid.append(item);
      }
      box.append(head, grid);
    }

    const head2 = document.createElement("p");
    head2.className = "detail-head";
    head2.textContent = "Owes";
    const grid2 = document.createElement("div");
    grid2.className = "split-grid";
    for (const p of Object.keys(e.sharesPaise || {})) {
      const s = e.sharesPaise[p];
      if (s === undefined) continue;
      const item = document.createElement("div");
      item.className = "split-item" + (pn.includes(p) ? " is-payer" : "");
      const a = document.createElement("span");
      a.textContent = pn.includes(p) ? `${p} (paid)` : p;
      const b = document.createElement("span");
      b.textContent = money(s);
      item.append(a, b);
      grid2.append(item);
    }
    box.append(head2, grid2);
  }

  if (e.note) {
    const n = document.createElement("p");
    n.className = "detail-note";
    n.textContent = e.note;
    box.append(n);
  }

  const foot = document.createElement("div");
  foot.className = "entry-foot";
  const when = document.createElement("span");
  const added = new Date(e.ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const bits = [e.type === "settlement" ? "Payment" : (CAT[e.category] || CAT.other).label, `added by ${e.addedBy} on ${added}`];
  if (e.editedBy) bits.push(`edited by ${e.editedBy}`);
  when.textContent = bits.join(" · ");
  foot.append(when);

  const actions = document.createElement("div");
  actions.className = "confirm";
  if (pendingDelete === e.id) {
    const q = document.createElement("span");
    q.className = "confirm-q";
    q.textContent = "Delete for everyone?";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-danger btn-xs";
    yes.textContent = "Delete";
    yes.onclick = async () => { pendingDelete = null; if (editingId === e.id) resetForm(); await store.remove(e.id); };
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn btn-ghost btn-xs";
    no.textContent = "Keep";
    no.onclick = () => { pendingDelete = null; renderEntries(); };
    actions.append(q, yes, no);
  } else {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost btn-xs";
    edit.textContent = "Edit";
    edit.onclick = () => loadForEdit(e);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost btn-xs";
    del.textContent = "Delete";
    del.onclick = () => { pendingDelete = e.id; renderEntries(); };
    actions.append(edit, del);
  }
  foot.append(actions);
  box.append(foot);
  return box;
}

/* ── Balances ──────────────────────────────────────────────── */
function renderBalances(L) {
  const list = $("balanceList");
  list.innerHTML = "";
  const max = Math.max(1, ...L.people.map((p) => Math.abs(L.net[p])));
  const sorted = [...L.people].sort((a, b) => L.net[b] - L.net[a] || a.localeCompare(b));

  for (const p of sorted) {
    const v = L.net[p];
    const row = document.createElement("div");
    row.className = "bal";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "bal-head";
    head.onclick = () => { openPerson = openPerson === p ? null : p; renderAll(); };

    const name = document.createElement("span");
    name.className = "bal-name";
    name.textContent = p;
    if (p === me) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "you";
      name.append(tag);
    }
    const amt = document.createElement("span");
    amt.className = "bal-amt " + (v > 0 ? "plus" : v < 0 ? "minus" : "zero");
    amt.textContent = v === 0 ? "settled" : money(v, { sign: true });
    head.append(name, amt);

    const bar = document.createElement("div");
    bar.className = "bal-bar";
    const fill = document.createElement("i");
    fill.style.width = `${(Math.abs(v) / max) * 50}%`;
    if (v >= 0) { fill.style.left = "50%"; fill.style.background = "var(--plus)"; }
    else { fill.style.right = "50%"; fill.style.background = "var(--minus)"; }
    bar.append(fill);

    const note = document.createElement("div");
    note.className = "bal-note";
    note.textContent = `paid ${money(L.paid[p])} · share ${money(L.share[p])}`
      + (L.settledOut[p] ? ` · settled out ${money(L.settledOut[p])}` : "")
      + (L.settledIn[p] ? ` · received ${money(L.settledIn[p])}` : "");

    row.append(head, bar, note);

    if (openPerson === p) {
      const detail = document.createElement("div");
      detail.className = "bal-detail";
      const lines = [];
      for (const other of L.people) {
        if (L.pair[p][other] > 0) lines.push({ text: `owes ${other}`, amt: L.pair[p][other], tone: "minus" });
        if (L.pair[other][p] > 0) lines.push({ text: `gets back from ${other}`, amt: L.pair[other][p], tone: "plus" });
      }
      if (!lines.length) {
        const q = document.createElement("p");
        q.className = "bal-quiet";
        q.textContent = "Square with everyone.";
        detail.append(q);
      }
      for (const l of lines.sort((a, b) => b.amt - a.amt)) {
        const d = document.createElement("div");
        d.className = "bal-line";
        const t = document.createElement("span");
        t.textContent = l.text;
        const v2 = document.createElement("span");
        v2.className = l.tone;
        v2.textContent = money(l.amt);
        d.append(t, v2);
        detail.append(d);
      }
      row.append(detail);
    }
    list.append(row);
  }

  const sum = L.people.reduce((a, p) => a + L.net[p], 0);
  if (!$("balanceCheck")) return;
  $("balanceCheck").textContent = sum === 0
    ? `All ${L.people.length} balances add up to exactly ₹0 — the books are consistent.`
    : `Balances are off by ${money(sum)} — please tell Karan.`;
  $("balanceCheck").className = "check " + (sum === 0 ? "is-ok" : "is-off");

  // Category breakdown
  const totals = {};
  let grand = 0;
  for (const e of entries) {
    if (e.type === "settlement") continue;
    const c = CAT[e.category] ? e.category : "other";
    totals[c] = (totals[c] || 0) + e.amountPaise;
    grand += e.amountPaise;
  }
  const bd = $("catBreakdown");
  bd.innerHTML = "";
  const rows = CATEGORIES.filter((c) => totals[c.id]).sort((a, b) => totals[b.id] - totals[a.id]);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "bal-quiet";
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

/* ── The roster ────────────────────────────────────────────── */
function applyRoster(names) {
  const keep = {
    who: $("whoSelect").value, paidBy: $("paidBy").value,
    payFrom: $("payFrom").value, payTo: $("payTo").value, filter: $("filterPerson").value,
  };
  PEOPLE = names.slice();
  const withMe = me && !PEOPLE.includes(me) ? [...PEOPLE, me] : PEOPLE;

  fillSelect($("gateSelect"), PEOPLE, "Select your name…");
  fillSelect($("whoSelect"), withMe);
  fillSelect($("paidBy"), PEOPLE);
  fillSelect($("payFrom"), PEOPLE);
  fillSelect($("payTo"), PEOPLE);
  fillSelect($("filterPerson"), PEOPLE, "Everyone");

  const restore = (id, value, fallback) => {
    const el = $(id);
    el.value = [...el.options].some((o) => o.value === value) ? value : fallback;
  };
  restore("whoSelect", keep.who, me || PEOPLE[0]);
  restore("paidBy", keep.paidBy, me || PEOPLE[0]);
  restore("payFrom", keep.payFrom, me || PEOPLE[0]);
  restore("payTo", keep.payTo, PEOPLE.find((p) => p !== me) || PEOPLE[0]);
  restore("filterPerson", keep.filter, "");

  participants = new Set([...participants].filter((p) => PEOPLE.includes(p)));
  payers = new Set([...payers].filter((p) => PEOPLE.includes(p)));
  if (!payers.size && me) payers.add(me);

  renderParticipantChips();
  renderPayerRows();
  renderAll();
}

function showRosterError(msg) {
  const el = $("rosterError");
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
}

function renderRoster(L) {
  const box = $("rosterList");
  if (!box) return;
  box.innerHTML = "";
  const withHistory = new Set(peopleInEntries(entries));

  for (const p of L.people) {
    const row = document.createElement("div");
    row.className = "roster-row";

    const name = document.createElement("span");
    name.className = "roster-name";
    name.textContent = p;
    if (p === me) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "you";
      name.append(tag);
    }
    if (!PEOPLE.includes(p)) {
      const tag = document.createElement("span");
      tag.className = "gone-tag";
      tag.textContent = "removed";
      name.append(tag);
    }

    const note = document.createElement("span");
    note.className = "roster-note";

    row.append(name, note);

    if (withHistory.has(p)) {
      note.textContent = L.net[p] === 0 ? "has expenses · settled" : `has expenses · ${L.net[p] > 0 ? "is owed" : "owes"} ${money(Math.abs(L.net[p]))}`;
    } else if (PEOPLE.includes(p)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-xs";
      btn.textContent = "Remove";
      btn.onclick = async () => {
        showRosterError("");
        btn.disabled = true;
        try { await store.saveRoster(PEOPLE.filter((n) => n !== p)); }
        catch (err) { btn.disabled = false; showRosterError(`Could not save: ${err.message}`); }
      };
      note.textContent = "nothing logged yet";
      row.append(btn);
    }
    box.append(row);
  }
}

async function onAddPerson(ev) {
  ev.preventDefault();
  showRosterError("");
  if (!$("rosterName")) return;
  const raw = $("rosterName").value.trim().replace(/\s+/g, " ");
  if (!raw) return showRosterError("Type a name first.");
  if (raw.length > 24) return showRosterError("That name is too long.");
  if (PEOPLE.some((p) => p.toLowerCase() === raw.toLowerCase())) return showRosterError(`${raw} is already on the trip.`);
  if (PEOPLE.length >= 50) return showRosterError("That is as many people as this register takes.");
  try {
    await store.saveRoster([...PEOPLE, raw]);
    $("rosterName").value = "";
  } catch (err) {
    showRosterError(`Could not save: ${err.message}`);
  }
}

/* ── Settle up ─────────────────────────────────────────────── */
function renderSettle(L) {
  const box = $("settleList");
  box.innerHTML = "";
  const transfers = settleView === "simple" ? minTransfers(L.net) : directTransfers(L.pair, L.people);

  $("settleSub").textContent = settleView === "simple"
    ? "Make these transfers and every balance lands at zero. Fewest possible payments, so money may move between people who never shared an expense."
    : "Exactly who owes whom, straight from the expenses. More payments, but each one traces to something real.";

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
    const from = document.createElement("strong");
    from.textContent = t.from === me ? "You" : t.from;
    const arrow = document.createElement("span");
    arrow.textContent = " → ";
    const to = document.createElement("strong");
    to.textContent = t.to === me ? "you" : t.to;
    text.append(from, arrow, to);

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
          type: "settlement", from: t.from, to: t.to, amountPaise: t.amount,
          date: new Date().toLocaleDateString("en-CA"), addedBy: me, ts: Date.now(),
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

/* ── Summary & shell ───────────────────────────────────────── */
function renderSummary(L) {
  let total = 0;
  for (const e of entries) if (e.type !== "settlement") total += e.amountPaise;
  $("sumTotal").textContent = money(total);
  $("sumYouPaid").textContent = money(L.paid[me] || 0);
  $("sumYourShare").textContent = money(L.share[me] || 0);

  const v = L.net[me] || 0;
  const el = $("sumNet");
  el.textContent = v === 0 ? "settled" : money(Math.abs(v));
  el.className = "summary-value " + (v > 0 ? "plus" : v < 0 ? "minus" : "");
  $("sumNetLabel").textContent = v > 0 ? "You get back" : v < 0 ? "You owe" : "Your balance";

  const count = entries.filter((e) => e.type !== "settlement").length;
  $("tripSub").textContent = `${PEOPLE.length} people · ${count} expense${count === 1 ? "" : "s"}`;
}

function renderAll() {
  const L = buildLedger(entries, PEOPLE);
  renderSummary(L);
  renderEntries();
  renderBalances(L);
  renderSettle(L);
  renderRoster(L);
}

function showError(msg) {
  const el = $("formError");
  el.hidden = !msg;
  el.textContent = msg || "";
  if (msg) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showStatus(msg, isError = false) {
  const el = $("statusBar");
  el.hidden = !msg;
  el.className = "statusbar" + (isError ? " is-error" : "");
  el.textContent = msg || "";
}

/* ── CSV ───────────────────────────────────────────────────── */
function exportCsv() {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ["Date", "Type", "Description", "Category", "Amount (INR)", "Split method", "Paid by", "Owed by", "Note", "Added by"];
  const rows = sortedEntries().map((e) => {
    if (e.type === "settlement") {
      return [e.date, "Payment", `${e.from} paid ${e.to}`, "", (e.amountPaise / 100).toFixed(2), "", `${e.from}: ${(e.amountPaise / 100).toFixed(2)}`, `${e.to}: ${(e.amountPaise / 100).toFixed(2)}`, e.note || "", e.addedBy];
    }
    const pay = Object.entries(e.payersPaise || {}).map(([n, v]) => `${n}: ${(v / 100).toFixed(2)}`).join("; ");
    const owe = Object.entries(e.sharesPaise || {}).map(([n, v]) => `${n}: ${(v / 100).toFixed(2)}`).join("; ");
    return [e.date, "Expense", e.desc, (CAT[e.category] || CAT.other).label, (e.amountPaise / 100).toFixed(2), e.splitMethod, pay, owe, e.note || "", e.addedBy];
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
function fillSelect(el, names, placeholder) {
  el.innerHTML = "";
  if (placeholder) el.append(new Option(placeholder, ""));
  for (const n of names) el.append(new Option(n, n));
}

function setMe(name) {
  me = name;
  try { localStorage.setItem(LS_NAME, name); } catch { /* private mode */ }
  $("whoSelect").value = name;
  if (!editingId) {
    $("paidBy").value = name;
    $("payFrom").value = name;
    if ($("payTo").value === name) $("payTo").value = PEOPLE.find((p) => p !== name);
    payers = new Set([name]);
  }
  renderCats();
  renderParticipantChips();
  renderPayerRows();
  renderAll();
}

function wireUi() {
  fillSelect($("gateSelect"), PEOPLE, "Select your name…");
  fillSelect($("whoSelect"), PEOPLE);
  fillSelect($("paidBy"), PEOPLE);
  fillSelect($("payFrom"), PEOPLE);
  fillSelect($("payTo"), PEOPLE);
  fillSelect($("filterPerson"), PEOPLE, "Everyone");
  $("payTo").value = PEOPLE[1];
  $("date").value = new Date().toLocaleDateString("en-CA");

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
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", String(active));
      }
      for (const v of ["expenses", "balances", "settle"]) $(`view-${v}`).hidden = v !== tab.dataset.tab;
    };
  }

  for (const btn of document.querySelectorAll("[data-payers]")) {
    btn.onclick = () => setPayerMode(btn.dataset.payers);
  }
  for (const btn of document.querySelectorAll("[data-settle]")) {
    btn.onclick = () => {
      settleView = btn.dataset.settle;
      for (const b of document.querySelectorAll("[data-settle]")) b.classList.toggle("is-on", b === btn);
      renderAll();
    };
  }
  for (const btn of document.querySelectorAll("[data-select]")) {
    btn.onclick = () => {
      const kind = btn.dataset.select;
      if (kind === "all") participants = new Set(PEOPLE);
      else if (kind === "none") participants = new Set();
      else participants = new Set(me ? [me] : []);
      renderParticipantChips();
      renderSplitRows();
    };
  }

  $("splitMode").onchange = renderSplitRows;
  $("amount").addEventListener("input", updatePreview);
  $("settleToggle").onclick = () => { if (editingId) resetForm(); setSettleMode(!settleMode); };
  $("cancelEdit").onclick = () => { const was = settleMode; resetForm(); if (was) setSettleMode(false); };
  $("expenseForm").addEventListener("submit", onSubmit);
  $("filterPerson").onchange = renderEntries;
  $("exportBtn").onclick = exportCsv;
  on("rosterForm", "submit", onAddPerson);
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

  const onData = (list) => { entries = list.map(normalize); renderAll(); };
  // No saved roster yet means this trip has never had one — fall back to the
  // names the register shipped with rather than showing an empty picker.
  const onRoster = (names) => applyRoster(names && names.length ? names : DEFAULT_PEOPLE);

  if (cfg.firebase && cfg.firebase.projectId) {
    try {
      store = await firebaseStore();
      $("syncNote").textContent = `Live · everyone on this link shares one register (trip: ${TRIP_ID})`;
      store.subscribeRoster(onRoster, () => onRoster(null));
      store.subscribe(onData, (err) => showStatus(`Lost the live connection: ${err.message}`, true));
      return;
    } catch (err) {
      showStatus(`Could not reach Firebase (${err.message}) — running on this device only.`, true);
    }
  } else {
    showStatus("Not connected yet: expenses save to this device only. Add your Firebase keys to firebase-config.js to share the register.");
  }

  store = localStore();
  $("syncNote").textContent = "Local mode · saved in this browser only";
  store.subscribeRoster(onRoster);
  store.subscribe(onData);
}

start();
