/* Ledger maths for Goa Hisaab — pure functions, no DOM.
   Kept separate so it can be run and tested outside the browser.

   Money is integer paise everywhere. Every division uses largest-remainder
   allocation so the parts add back to the exact total. */

const DEFAULT_PEOPLE = [
  "Karan", "Vidhi", "Vatsal", "Dhwani", "Diksha", "Rohan", "Sakshi",
  "Jeet", "Dhruvina", "Yash", "Minal", "Vinay", "Varun",
];

/* Five couples travel as one wallet; the other three settle for themselves.
   This only ever affects settling up — every expense, share and balance below
   is still worked out person by person. */
const DEFAULT_HOUSEHOLDS = [
  ["Karan", "Vidhi"],
  ["Vatsal", "Dhwani"],
  ["Yash", "Dhruvina"],
  ["Sakshi", "Jeet"],
  ["Vinay", "Minal"],
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

const SPLIT_HINTS = {
  exact:   { label: "Exact amount each", unit: "₹", hint: "These must add up to the full amount." },
  percent: { label: "Percentage each",   unit: "%", hint: "These must add up to 100%." },
  shares:  { label: "Shares each",       unit: "×", hint: "Relative weights — a couple might take 2, one person 1." },
  adjust:  { label: "Extra on top each", unit: "₹", hint: "The rest is split equally. Use this when one person had the extra drink." },
};


/* ── Money ─────────────────────────────────────────────────── */
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(paise, { sign = false } = {}) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const body = abs % 100 === 0 ? inr.format(abs / 100) : inr2.format(abs / 100);
  return `${sign ? (neg ? "−" : "+") : neg ? "−" : ""}₹${body}`;
}

function parseRupees(text) {
  const clean = String(text ?? "").trim().replace(/[^0-9.\-]/g, "");
  if (!clean || clean === "-" || clean.split(".").length > 2) return NaN;
  const value = Number(clean);
  return isFinite(value) ? Math.round(value * 100) : NaN;
}

function parseNumber(text) {
  const clean = String(text ?? "").trim().replace(/[^0-9.\-]/g, "");
  if (!clean || clean === "-" || clean.split(".").length > 2) return NaN;
  const value = Number(clean);
  return isFinite(value) ? value : NaN;
}

/** Split `total` across `weights` so the integer parts sum to exactly `total`. */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k].i] += 1;
  return out;
}

/** Work out each participant's share. Returns {shares} or {error}. */
function computeShares(method, total, names, input) {
  if (!names.length) return { error: "Pick at least one person to split this between." };
  const val = (n) => (input && input[n] !== undefined ? input[n] : 0);

  if (method === "equal") {
    const parts = allocate(total, names.map(() => 1));
    return { shares: Object.fromEntries(names.map((n, i) => [n, parts[i]])) };
  }

  if (method === "exact") {
    const sum = names.reduce((a, n) => a + val(n), 0);
    if (names.some((n) => val(n) < 0)) return { error: "Exact amounts cannot be negative." };
    if (sum !== total) {
      return { error: `Exact amounts add up to ${money(sum)}, but the expense is ${money(total)} — ${money(Math.abs(total - sum))} ${sum > total ? "too much" : "short"}.` };
    }
    return { shares: Object.fromEntries(names.map((n) => [n, val(n)])) };
  }

  if (method === "percent") {
    if (names.some((n) => val(n) < 0)) return { error: "Percentages cannot be negative." };
    const sum = names.reduce((a, n) => a + val(n), 0);
    if (Math.abs(sum - 100) > 0.001) {
      return { error: `Percentages add up to ${Math.round(sum * 100) / 100}%, not 100%.` };
    }
    const parts = allocate(total, names.map((n) => val(n)));
    return { shares: Object.fromEntries(names.map((n, i) => [n, parts[i]])) };
  }

  if (method === "shares") {
    if (names.some((n) => val(n) < 0)) return { error: "Shares cannot be negative." };
    const sum = names.reduce((a, n) => a + val(n), 0);
    if (sum <= 0) return { error: "Give at least one person a share above zero." };
    const parts = allocate(total, names.map((n) => val(n)));
    return { shares: Object.fromEntries(names.map((n, i) => [n, parts[i]])) };
  }

  if (method === "adjust") {
    const extras = names.reduce((a, n) => a + val(n), 0);
    const base = total - extras;
    if (base < 0) return { error: `The extras come to ${money(extras)}, more than the expense itself.` };
    const parts = allocate(base, names.map(() => 1));
    const shares = Object.fromEntries(names.map((n, i) => [n, parts[i] + val(n)]));
    const bad = names.find((n) => shares[n] < 0);
    if (bad) return { error: `That leaves ${bad} with a negative share.` };
    return { shares };
  }

  return { error: "Unknown split method." };
}

/* ── Entry shape ───────────────────────────────────────────── */
function normalize(e) {
  const out = { ...e };
  if (out.type !== "settlement") {
    if (!out.payersPaise) out.payersPaise = out.paidBy ? { [out.paidBy]: out.amountPaise } : {};
    if (!out.sharesPaise) out.sharesPaise = {};
    if (!out.splitMethod) out.splitMethod = "equal";
  }
  if (!out.date) out.date = new Date(out.ts || Date.now()).toLocaleDateString("en-CA");
  return out;
}

const payerNames = (e) => Object.keys(e.payersPaise || {}).filter((n) => e.payersPaise[n] > 0);
const shareNames = (e) => Object.keys(e.sharesPaise || {}).filter((n) => e.sharesPaise[n] !== 0);

function involves(e, who) {
  if (e.type === "settlement") return e.from === who || e.to === who;
  return payerNames(e).includes(who) || shareNames(e).includes(who);
}

/* ── Households ──────────────────────────────── */

/** Groups the people into households: each listed couple who are both here,
 *  then everyone else on their own. A couple with only one person present is
 *  not a household — there is nobody to combine with. */
function householdsFor(people, pairs = DEFAULT_HOUSEHOLDS) {
  const taken = new Set();
  const groups = [];
  for (const pair of pairs) {
    const members = pair.filter((n) => people.includes(n));
    if (members.length < 2) continue;
    members.forEach((n) => taken.add(n));
    groups.push({ key: members.join("+"), label: members.join(" & "), members, couple: true });
  }
  for (const n of people) {
    if (taken.has(n)) continue;
    groups.push({ key: n, label: n, members: [n], couple: false });
  }
  return groups;
}

/** A household's position is simply its members' positions added together, so
 *  a spouse who is owed cancels a spouse who owes before anything leaves the
 *  family. `inside` is what they would square between themselves; it is shown
 *  for information and never asks anyone to move money. */
function householdLedger(L, pairs = DEFAULT_HOUSEHOLDS) {
  return householdsFor(L.people, pairs).map((g) => {
    const net = g.members.reduce((a, n) => a + (L.net[n] || 0), 0);
    const paid = g.members.reduce((a, n) => a + (L.paid[n] || 0), 0);
    const share = g.members.reduce((a, n) => a + (L.share[n] || 0), 0);
    const inside = g.members.length > 1
      ? minTransfers(Object.fromEntries(g.members.map((n) => [n, L.net[n] || 0])))
      : [];
    return { ...g, net, paid, share, inside };
  });
}

/** Who in a household should actually send or receive the money: the member
 *  carrying most of it, so the named person is the one it belongs to. */
function facesFor(group, net, wantOwing) {
  const sorted = [...group.members].sort((a, b) => (wantOwing ? (net[a] || 0) - (net[b] || 0) : (net[b] || 0) - (net[a] || 0)));
  return sorted[0] || group.members[0];
}

/* ── Ledger ────────────────────────────────────────────────── */

/** Within one expense, whoever underpaid owes whoever overpaid.
 *
 *  Each person's position on an expense is what they put in minus what they
 *  owe. Those positions sum to zero, so matching the biggest debtor to the
 *  biggest creditor and working down clears them exactly, with no rounding
 *  drift. Someone who paid and also owes is netted against themselves first
 *  and never appears owing themselves. With a single payer this is simply
 *  "everyone owes the payer their share". */
function expenseDebts(paidMap, shareMap) {
  const names = new Set([...Object.keys(paidMap || {}), ...Object.keys(shareMap || {})]);
  const position = {};
  for (const n of names) position[n] = (paidMap[n] || 0) - (shareMap[n] || 0);

  const bySize = (a, b) => b.v - a.v || a.n.localeCompare(b.n);
  const creditors = Object.entries(position).filter(([, v]) => v > 0).map(([n, v]) => ({ n, v })).sort(bySize);
  const debtors = Object.entries(position).filter(([, v]) => v < 0).map(([n, v]) => ({ n, v: -v })).sort(bySize);

  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].v, creditors[j].v);
    if (amount > 0) out.push({ from: debtors[i].n, to: creditors[j].n, amount });
    debtors[i].v -= amount;
    creditors[j].v -= amount;
    if (debtors[i].v === 0) i += 1;
    if (creditors[j].v === 0) j += 1;
  }
  return out;
}

/** Every name the entries actually mention, so a person removed from the
 *  roster while still carrying a balance keeps appearing until they are square. */
function peopleInEntries(list) {
  const seen = new Set();
  for (const e of list || []) {
    if (e.deleted) continue;
    if (e.type === "settlement") { seen.add(e.from); seen.add(e.to); continue; }
    for (const n of Object.keys(e.payersPaise || {})) seen.add(n);
    for (const n of Object.keys(e.sharesPaise || {})) seen.add(n);
  }
  seen.delete(undefined);
  return [...seen];
}

/** The roster plus anyone the entries mention, in roster order first. */
function ledgerPeople(roster, list) {
  const names = (roster && roster.length ? roster : DEFAULT_PEOPLE).slice();
  for (const n of peopleInEntries(list)) if (!names.includes(n)) names.push(n);
  return names;
}

function buildLedger(list, roster) {
  const PEOPLE = ledgerPeople(roster, list);
  const zero = () => Object.fromEntries(PEOPLE.map((p) => [p, 0]));
  const paid = zero();
  const share = zero();
  const settledOut = zero();
  const settledIn = zero();
  const debt = Object.fromEntries(PEOPLE.map((p) => [p, zero()])); // debt[a][b]: a owes b

  for (const e of list) {
    // A deleted entry is kept so it can be restored, but it must not touch a
    // single balance while it is in the bin.
    if (e.deleted) continue;
    if (e.type === "settlement") {
      if (!(e.from in paid) || !(e.to in paid)) continue;
      settledOut[e.from] += e.amountPaise;
      settledIn[e.to] += e.amountPaise;
      debt[e.to][e.from] += e.amountPaise; // paying cancels what you owed
      continue;
    }

    const paidMap = {};
    for (const [n, v] of Object.entries(e.payersPaise || {})) {
      if (!(n in paid) || !v) continue;
      paidMap[n] = v;
      paid[n] += v;
    }
    const shareMap = {};
    for (const [n, v] of Object.entries(e.sharesPaise || {})) {
      if (!(n in share) || !v) continue;
      shareMap[n] = v;
      share[n] += v;
    }
    for (const d of expenseDebts(paidMap, shareMap)) debt[d.from][d.to] += d.amount;
  }

  const net = zero();
  for (const p of PEOPLE) net[p] = paid[p] - share[p] + settledOut[p] - settledIn[p];

  // Net each pair against each other so only one direction survives.
  const pair = Object.fromEntries(PEOPLE.map((p) => [p, zero()]));
  for (const a of PEOPLE) {
    for (const b of PEOPLE) {
      if (a === b) continue;
      const v = debt[a][b] - debt[b][a];
      if (v > 0) pair[a][b] = v;
    }
  }

  return { paid, share, settledOut, settledIn, net, pair, people: PEOPLE };
}

/** Greedy largest-creditor / largest-debtor matching — at most n−1 transfers. */
function minTransfers(net) {
  const owed = Object.entries(net).filter(([, v]) => v > 0).map(([n, v]) => ({ n, v }));
  const owes = Object.entries(net).filter(([, v]) => v < 0).map(([n, v]) => ({ n, v: -v }));
  owed.sort((a, b) => b.v - a.v || a.n.localeCompare(b.n));
  owes.sort((a, b) => b.v - a.v || a.n.localeCompare(b.n));
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

function directTransfers(pair, people) {
  const out = [];
  const names = people || Object.keys(pair);
  for (const a of names) for (const b of names) if (pair[a] && pair[a][b] > 0) out.push({ from: a, to: b, amount: pair[a][b] });
  return out.sort((x, y) => y.amount - x.amount);
}

export {
  DEFAULT_PEOPLE, DEFAULT_HOUSEHOLDS, CATEGORIES, CAT, SETTLE_COLOR, SPLIT_HINTS,
  money, parseRupees, parseNumber, allocate, computeShares,
  normalize, payerNames, shareNames, involves,
  buildLedger, minTransfers, directTransfers, peopleInEntries, ledgerPeople,
  householdsFor, householdLedger, facesFor,
};
