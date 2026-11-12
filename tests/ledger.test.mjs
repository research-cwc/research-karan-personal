/* Tests for the ledger maths.  Run:  node tests/ledger.test.mjs
   Nothing here touches the browser — ledger.js is deliberately DOM-free. */

import {
  DEFAULT_PEOPLE as PEOPLE, allocate, computeShares, buildLedger,
  minTransfers, directTransfers, ledgerPeople, money, parseRupees, parseNumber,
  householdsFor, householdLedger, facesFor, DEFAULT_HOUSEHOLDS,
} from "../ledger.js";

let passed = 0;
let failed = 0;
const fails = [];

function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failed += 1;
  fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, wanted ${want}`);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const strip = ({ deleted, deletedBy, deletedTs, ...rest }) => rest;

/* ── allocate ──────────────────────────────────────────────── */
{
  for (const total of [1, 7, 100, 4500_00, 1_00, 999_99, 123457]) {
    for (const n of [1, 2, 3, 7, 13]) {
      const parts = allocate(total, Array(n).fill(1));
      eq(`allocate ${total} over ${n} sums exactly`, parts.reduce((a, b) => a + b, 0), total);
      ok(`allocate ${total}/${n} spread is at most 1 paisa`,
        Math.max(...parts) - Math.min(...parts) <= 1);
    }
  }
  const w = allocate(1000, [1, 2, 7]);
  eq("weighted allocate sums", w.reduce((a, b) => a + b, 0), 1000);
  eq("weighted allocate respects ratio", `${w[0]},${w[1]},${w[2]}`, "100,200,700");
  eq("allocate with zero weights", allocate(500, [0, 0]).join(","), "0,0");
}

/* ── split methods ─────────────────────────────────────────── */
{
  const three = ["Karan", "Vidhi", "Vatsal"];

  const equal = computeShares("equal", 100_00, three, {});
  eq("equal splits 100 three ways", sum(equal.shares), 100_00);
  ok("equal split is within a paisa", Math.max(...Object.values(equal.shares)) - Math.min(...Object.values(equal.shares)) <= 1);

  const thirteen = computeShares("equal", 4500_00, PEOPLE, {});
  eq("equal 4500 over 13 sums exactly", sum(thirteen.shares), 4500_00);

  const exact = computeShares("exact", 100_00, three, { Karan: 50_00, Vidhi: 30_00, Vatsal: 20_00 });
  eq("exact split accepted", sum(exact.shares), 100_00);
  ok("exact split rejects a mismatch", !!computeShares("exact", 100_00, three, { Karan: 50_00, Vidhi: 30_00, Vatsal: 10_00 }).error);
  ok("exact split rejects negatives", !!computeShares("exact", 100_00, three, { Karan: 150_00, Vidhi: -50_00, Vatsal: 0 }).error);

  const pct = computeShares("percent", 100_00, three, { Karan: 50, Vidhi: 25, Vatsal: 25 });
  eq("percent split sums", sum(pct.shares), 100_00);
  eq("percent split halves correctly", pct.shares.Karan, 50_00);
  ok("percent rejects not-100", !!computeShares("percent", 100_00, three, { Karan: 50, Vidhi: 25, Vatsal: 20 }).error);
  const oddPct = computeShares("percent", 100_00, three, { Karan: 33.33, Vidhi: 33.33, Vatsal: 33.34 });
  eq("awkward percentages still sum exactly", sum(oddPct.shares), 100_00);

  const shares = computeShares("shares", 120_00, three, { Karan: 2, Vidhi: 1, Vatsal: 1 });
  eq("shares split sums", sum(shares.shares), 120_00);
  eq("a double share pays double", shares.shares.Karan, 60_00);
  ok("shares rejects all-zero", !!computeShares("shares", 100_00, three, { Karan: 0, Vidhi: 0, Vatsal: 0 }).error);

  const adj = computeShares("adjust", 130_00, three, { Karan: 10_00, Vidhi: 0, Vatsal: 0 });
  eq("adjust split sums", sum(adj.shares), 130_00);
  eq("adjust gives the extra to the right person", adj.shares.Karan, 50_00);
  eq("adjust splits the rest equally", adj.shares.Vidhi, 40_00);
  ok("adjust rejects extras above the total", !!computeShares("adjust", 100_00, three, { Karan: 200_00, Vidhi: 0, Vatsal: 0 }).error);

  ok("no participants is rejected", !!computeShares("equal", 100_00, [], {}).error);
}

/* ── one expense, one payer ────────────────────────────────── */
{
  const e = {
    type: "expense", amountPaise: 300_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 300_00 },
    sharesPaise: { Karan: 100_00, Vidhi: 100_00, Vatsal: 100_00 },
    splitMethod: "equal", addedBy: "Karan",
  };
  const L = buildLedger([e]);
  eq("payer net", L.net.Karan, 200_00);
  eq("borrower net", L.net.Vidhi, -100_00);
  eq("uninvolved net", L.net.Rohan, 0);
  eq("pairwise debt to payer", L.pair.Vidhi.Karan, 100_00);
  eq("payer owes nobody", L.pair.Karan.Vidhi, 0);
  eq("nets sum to zero", sum(L.net), 0);
}

/* ── one expense, several payers ───────────────────────────── */
{
  const e = {
    type: "expense", amountPaise: 1000_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 600_00, Rohan: 400_00 },
    sharesPaise: { Karan: 250_00, Rohan: 250_00, Vidhi: 250_00, Vatsal: 250_00 },
    splitMethod: "equal", addedBy: "Karan",
  };
  const L = buildLedger([e]);
  eq("multi-payer: first payer net", L.net.Karan, 350_00);
  eq("multi-payer: second payer net", L.net.Rohan, 150_00);
  eq("multi-payer: borrower net", L.net.Vidhi, -250_00);
  // Underpayers are matched to overpayers largest-first, so Vatsal (tie broken
  // alphabetically) clears against the biggest creditor and Vidhi covers the rest.
  eq("multi-payer: first debtor clears against the biggest payer", L.pair.Vatsal.Karan, 250_00);
  eq("multi-payer: second debtor spills onto both payers", L.pair.Vidhi.Karan, 100_00);
  eq("multi-payer: and the remainder to the second payer", L.pair.Vidhi.Rohan, 150_00);
  eq("multi-payer: each borrower's debts equal their share",
    L.pair.Vidhi.Karan + L.pair.Vidhi.Rohan, 250_00);
  eq("multi-payer: a payer who also owes never owes themselves", L.pair.Karan.Karan, 0);
  eq("multi-payer: and does not owe the other payer", L.pair.Karan.Rohan, 0);
  eq("multi-payer: nets sum to zero", sum(L.net), 0);
}

/* ── settlements ───────────────────────────────────────────── */
{
  const expense = {
    type: "expense", amountPaise: 200_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 200_00 },
    sharesPaise: { Karan: 100_00, Vidhi: 100_00 },
    splitMethod: "equal", addedBy: "Karan",
  };
  const part = { type: "settlement", from: "Vidhi", to: "Karan", amountPaise: 40_00, date: "2026-11-12", ts: 2, addedBy: "Vidhi" };
  const L = buildLedger([expense, part]);
  eq("partial settlement leaves the remainder", L.pair.Vidhi.Karan, 60_00);
  eq("partial settlement moves the net", L.net.Vidhi, -60_00);

  const rest = { type: "settlement", from: "Vidhi", to: "Karan", amountPaise: 60_00, date: "2026-11-12", ts: 3, addedBy: "Vidhi" };
  const L2 = buildLedger([expense, part, rest]);
  eq("full settlement clears the pair", L2.pair.Vidhi.Karan, 0);
  eq("full settlement clears the net", L2.net.Vidhi, 0);
  eq("full settlement clears the payer too", L2.net.Karan, 0);

  const over = { type: "settlement", from: "Vidhi", to: "Karan", amountPaise: 150_00, date: "2026-11-12", ts: 4, addedBy: "Vidhi" };
  const L3 = buildLedger([expense, over]);
  eq("overpaying flips the direction", L3.pair.Karan.Vidhi, 50_00);
  eq("overpaying leaves nothing the other way", L3.pair.Vidhi.Karan, 0);
}

/* ── payer not in the split ────────────────────────────────── */
{
  const e = {
    type: "expense", amountPaise: 500_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 500_00 },
    sharesPaise: { Vidhi: 500_00 },
    splitMethod: "exact", addedBy: "Karan",
  };
  const L = buildLedger([e]);
  eq("treating someone: payer is owed all of it", L.net.Karan, 500_00);
  eq("treating someone: the other owes all of it", L.net.Vidhi, -500_00);
  eq("treating someone: no self-debt", L.pair.Karan.Karan ?? 0, 0);
}

/* ── the awkward one: 4500 across 13 with multiple payers ──── */
{
  const shares = computeShares("equal", 4500_00, PEOPLE, {}).shares;
  const e = {
    type: "expense", amountPaise: 4500_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 2000_00, Rohan: 1500_00, Minal: 1000_00 },
    sharesPaise: shares, splitMethod: "equal", addedBy: "Karan",
  };
  const L = buildLedger([e]);
  eq("13-way with 3 payers: nets sum to zero", sum(L.net), 0);
  for (const p of PEOPLE) {
    const owes = PEOPLE.reduce((a, q) => a + L.pair[p][q], 0);
    const owed = PEOPLE.reduce((a, q) => a + L.pair[q][p], 0);
    eq(`13-way: ${p}'s pairwise matches their net`, owed - owes, L.net[p]);
  }
}

/* ── property test: random trips always balance ────────────── */
{
  let rng = 20261111;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const pick = (n) => PEOPLE.slice().sort(() => rand() - 0.5).slice(0, n);
  const methods = ["equal", "exact", "percent", "shares", "adjust"];

  let scenarios = 0;
  let worstTransfers = 0;

  for (let trial = 0; trial < 400; trial += 1) {
    const list = [];
    const count = 1 + Math.floor(rand() * 8);

    for (let k = 0; k < count; k += 1) {
      const total = 100 + Math.floor(rand() * 500000); // ₹1 to ₹5000, in paise
      const nPart = 1 + Math.floor(rand() * PEOPLE.length);
      const names = pick(nPart);
      const method = methods[Math.floor(rand() * methods.length)];

      let input = {};
      if (method === "exact") {
        const parts = allocate(total, names.map(() => 1 + rand()));
        names.forEach((n, i) => { input[n] = parts[i]; });
      } else if (method === "percent") {
        const parts = allocate(10000, names.map(() => 1 + rand()));
        names.forEach((n, i) => { input[n] = parts[i] / 100; });
      } else if (method === "shares") {
        names.forEach((n) => { input[n] = 1 + Math.floor(rand() * 4); });
      } else if (method === "adjust") {
        const room = Math.floor(total / (names.length + 1));
        names.forEach((n) => { input[n] = Math.floor(rand() * room); });
      }

      const res = computeShares(method, total, names, input);
      if (res.error) continue;

      const nPay = 1 + Math.floor(rand() * 3);
      const payerNames = pick(nPay);
      const payParts = allocate(total, payerNames.map(() => 1 + rand()));
      const payersPaise = {};
      payerNames.forEach((n, i) => { if (payParts[i] > 0) payersPaise[n] = payParts[i]; });
      if (!Object.keys(payersPaise).length) continue;

      const sharesPaise = {};
      for (const [n, v] of Object.entries(res.shares)) if (v !== 0) sharesPaise[n] = v;
      if (!Object.keys(sharesPaise).length) continue;

      ok("random: shares sum to the total", sum(sharesPaise) === total);
      ok("random: payers sum to the total", sum(payersPaise) === total);

      list.push({ type: "expense", amountPaise: total, date: "2026-11-11", ts: k, payersPaise, sharesPaise, splitMethod: method, addedBy: names[0] });
    }

    if (!list.length) continue;

    // Throw in a settlement or two.
    for (let s = 0; s < Math.floor(rand() * 3); s += 1) {
      const two = pick(2);
      if (two.length < 2) continue;
      list.push({ type: "settlement", from: two[0], to: two[1], amountPaise: 1 + Math.floor(rand() * 50000), date: "2026-11-12", ts: 100 + s, addedBy: two[0] });
    }

    scenarios += 1;
    const L = buildLedger(list);

    ok("random: nets sum to zero", sum(L.net) === 0, `off by ${sum(L.net)}`);

    for (const p of PEOPLE) {
      const owes = PEOPLE.reduce((a, q) => a + L.pair[p][q], 0);
      const owed = PEOPLE.reduce((a, q) => a + L.pair[q][p], 0);
      ok("random: pairwise agrees with net", owed - owes === L.net[p],
        `${p}: pairwise ${owed - owes} vs net ${L.net[p]}`);
      ok("random: no self-debt", L.pair[p][p] === 0);
    }

    // Applying the simplified transfers must zero everybody out.
    const transfers = minTransfers(L.net);
    worstTransfers = Math.max(worstTransfers, transfers.length);
    const after = { ...L.net };
    for (const t of transfers) { after[t.from] += t.amount; after[t.to] -= t.amount; }
    ok("random: simplified transfers clear every balance",
      PEOPLE.every((p) => after[p] === 0),
      PEOPLE.filter((p) => after[p] !== 0).map((p) => `${p}=${after[p]}`).join(" "));
    ok("random: never more than 12 transfers", transfers.length <= PEOPLE.length - 1, `${transfers.length}`);
    ok("random: no transfer is zero or negative", transfers.every((t) => t.amount > 0));

    // The direct view must settle everyone too.
    const direct = directTransfers(L.pair);
    const afterDirect = { ...L.net };
    for (const t of direct) { afterDirect[t.from] += t.amount; afterDirect[t.to] -= t.amount; }
    ok("random: direct transfers clear every balance", PEOPLE.every((p) => afterDirect[p] === 0));
  }

  console.log(`  ${scenarios} random trips exercised, worst case ${worstTransfers} transfers to settle`);
}

/* ── a roster that changes ─────────────────────────────────── */
{
  const roster = ["Ana", "Bo", "Cy"];
  const e = {
    type: "expense", amountPaise: 300_00, date: "2026-11-11", ts: 1,
    payersPaise: { Ana: 300_00 },
    sharesPaise: { Ana: 100_00, Bo: 100_00, Cy: 100_00 },
    splitMethod: "equal", addedBy: "Ana",
  };
  const L = buildLedger([e], roster);
  eq("a different roster works end to end", L.net.Ana, 200_00);
  eq("and only contains that roster", Object.keys(L.net).join(","), "Ana,Bo,Cy");
  eq("nets still sum to zero", sum(L.net), 0);

  // Someone added mid-trip simply appears.
  const grown = [...roster, "Di"];
  const e2 = {
    type: "expense", amountPaise: 400_00, date: "2026-11-12", ts: 2,
    payersPaise: { Di: 400_00 },
    sharesPaise: { Ana: 100_00, Bo: 100_00, Cy: 100_00, Di: 100_00 },
    splitMethod: "equal", addedBy: "Di",
  };
  const L2 = buildLedger([e, e2], grown);
  eq("a person added mid-trip is counted", L2.net.Di, 300_00);
  eq("and the books still balance", sum(L2.net), 0);

  // Someone dropped from the roster who still has entries must not vanish.
  const L3 = buildLedger([e, e2], ["Ana", "Bo", "Cy"]);
  ok("a dropped person with history still appears", L3.net.Di !== undefined);
  eq("their balance is intact", L3.net.Di, 300_00);
  eq("and the books still balance", sum(L3.net), 0);
  eq("ledgerPeople keeps roster order then stragglers",
    ledgerPeople(["Ana", "Bo", "Cy"], [e2]).join(","), "Ana,Bo,Cy,Di");

  // Transfers must still clear a roster that changed.
  const after = { ...L3.net };
  for (const t of minTransfers(L3.net)) { after[t.from] += t.amount; after[t.to] -= t.amount; }
  ok("transfers clear a changed roster", Object.values(after).every((v) => v === 0));
}

/* ── settling as households ─────────────────────── */
{
  // The real board as it stands on the trip, in paise.
  const net = {
    Vinay: 10067923, Yash: 1434523, Vatsal: 1401021, Jeet: 23, Sakshi: 23,
    Rohan: -23, Diksha: -1560623, Dhruvina: -1890477, Minal: -1890477,
    Varun: -1890477, Dhwani: -1890478, Karan: -1890479, Vidhi: -1890479,
  };
  eq("the live board balances", sum(net), 0);

  const L = { people: PEOPLE, net, paid: {}, share: {} };
  const H = householdLedger(L);
  const by = Object.fromEntries(H.map((g) => [g.key, g]));

  eq("thirteen people become eight households", H.length, 8);
  eq("five of them are couples", H.filter((g) => g.couple).length, 5);

  // One owed, one owing: the family nets before anything leaves it.
  eq("Vatsal and Dhwani net against each other", by["Vatsal+Dhwani"].net, 1401021 - 1890478);
  ok("and the family owes rather than receives", by["Vatsal+Dhwani"].net < 0);
  eq("what they would square at home", by["Vatsal+Dhwani"].inside[0].amount, 1401021);

  // Yash is owed, Dhruvina owes more: the family still pays.
  ok("a family can owe although one of them is owed", by["Yash+Dhruvina"].net < 0 && net.Yash > 0);

  // Both owing.
  eq("two debts become one", by["Karan+Vidhi"].net, -3780958);
  eq("nothing to square between them", by["Karan+Vidhi"].inside.length, 0);

  // Both sides of the big one.
  eq("the family that is owed", by["Vinay+Minal"].net, 10067923 - 1890477);

  // Singles are untouched.
  eq("a single keeps their own balance", by.Varun.net, -1890477);
  ok("and is not marked a couple", !by.Varun.couple);

  eq("households still sum to zero", H.reduce((a, g) => a + g.net, 0), 0);

  // Settling by household is fewer payments, and still clears everyone.
  const perPerson = minTransfers(net);
  const perHouse = minTransfers(Object.fromEntries(H.map((g) => [g.key, g.net])));
  ok("fewer payments than settling one by one", perHouse.length < perPerson.length,
    `${perHouse.length} vs ${perPerson.length}`);
  ok("never more than one less than the number of households", perHouse.length <= H.length - 1);
  const after = Object.fromEntries(H.map((g) => [g.key, g.net]));
  for (const t of perHouse) { after[t.from] += t.amount; after[t.to] -= t.amount; }
  ok("every household lands on zero", Object.values(after).every((v) => v === 0));

  // A family that is square between themselves asks for nothing.
  const quiet = householdLedger({ people: ["Karan", "Vidhi", "Varun"], net: { Karan: 500_00, Vidhi: -500_00, Varun: 0 }, paid: {}, share: {} });
  eq("a family that cancels out owes nothing", quiet.find((g) => g.couple).net, 0);
  eq("but it still shows what they would square", quiet.find((g) => g.couple).inside[0].amount, 500_00);
  eq("and no payment is suggested", minTransfers(Object.fromEntries(quiet.map((g) => [g.key, g.net]))).length, 0);

  // A spouse who is not on the trip leaves the other settling alone.
  const alone = householdsFor(["Karan", "Varun", "Diksha"]);
  eq("a couple with one person present is not a household", alone.length, 3);
  ok("and that person settles for themselves", alone.every((g) => !g.couple));

  // Somebody added mid-trip who is in no couple settles alone.
  const added = householdsFor([...PEOPLE, "Priya"]);
  eq("a newcomer becomes their own household", added.length, 9);
  ok("and is not quietly attached to anyone", added.find((g) => g.key === "Priya").members.length === 1);

  // The money is named to whoever is carrying it.
  eq("the one who owes most pays", facesFor(by["Karan+Vidhi"], net, true), "Karan");
  eq("the one who is owed most receives", facesFor(by["Vinay+Minal"], net, false), "Vinay");
  eq("in a mixed family the one owing pays", facesFor(by["Vatsal+Dhwani"], net, true), "Dhwani");
  eq("and the one owed receives", facesFor(by["Vatsal+Dhwani"], net, false), "Vatsal");
}

/* ── deleted entries ─────────────────────────── */
{
  const live = {
    type: "expense", amountPaise: 300_00, date: "2026-11-11", ts: 1,
    payersPaise: { Karan: 300_00 },
    sharesPaise: { Karan: 100_00, Vidhi: 100_00, Vatsal: 100_00 },
    splitMethod: "equal", addedBy: "Karan",
  };
  // Rohan paid for a villa the others share: deleting it must move real money.
  const binned = {
    type: "expense", amountPaise: 9000_00, date: "2026-11-11", ts: 2,
    payersPaise: { Rohan: 9000_00 },
    sharesPaise: { Rohan: 3000_00, Karan: 3000_00, Vidhi: 3000_00 },
    splitMethod: "equal", addedBy: "Rohan",
    deleted: true, deletedBy: "Rohan", deletedTs: 3,
  };

  const L = buildLedger([live, binned]);
  eq("a deleted expense changes nobody's balance", L.net.Rohan, 0);
  eq("and leaves the live one untouched", L.net.Karan, 200_00);
  eq("and the books still balance", sum(L.net), 0);
  ok("a deleted entry adds nobody to the ledger", !PEOPLE.includes("Ghost"));

  const ghost = { type: "settlement", from: "Ghost", to: "Karan", amountPaise: 100, date: "2026-11-11", ts: 4, addedBy: "Karan", deleted: true };
  const L2 = buildLedger([live, ghost]);
  ok("a deleted entry cannot drag a stranger into the ledger", L2.net.Ghost === undefined);

  // Restoring is the same entry without the flag, and the money comes back.
  const L3 = buildLedger([live, strip(binned)]);
  eq("restoring puts the payer back in credit", L3.net.Rohan, 6000_00);
  eq("and puts the others back in debt", L3.net.Vidhi, -100_00 - 3000_00);
  eq("and the books still balance", sum(L3.net), 0);
  ok("the deleted version moved nothing", L.net.Vidhi === -100_00);
}

/* ── reading what people type ──────────────────────── */
{
  eq("plain rupees", parseRupees("100"), 100_00);
  eq("rupees and paise", parseRupees("346.16"), 34616);
  eq("a typed comma is ignored", parseRupees("1,234"), 1234_00);
  eq("a rupee sign is ignored", parseRupees("₹450"), 450_00);
  eq("surrounding space is ignored", parseRupees("  931  "), 931_00);
  eq("a third decimal rounds", parseRupees("10.555"), 1056);
  eq("floating point does not bite", parseRupees("0.07"), 7);
  eq("a negative is read as negative, for the caller to reject", parseRupees("-50"), -50_00);
  ok("empty is not a number", Number.isNaN(parseRupees("")));
  ok("letters are not a number", Number.isNaN(parseRupees("abc")));
  ok("two decimal points are not a number", Number.isNaN(parseRupees("1.2.3")));
  ok("a lone minus is not a number", Number.isNaN(parseRupees("-")));
  eq("percentages keep their decimals", parseNumber("33.33"), 33.33);
  ok("blank percentage is not a number", Number.isNaN(parseNumber("")));

  // The smallest possible expense still has to land somewhere.
  const tiny = computeShares("equal", 1, PEOPLE, {});
  eq("one paisa across thirteen still sums to one paisa", sum(tiny.shares), 1);
  eq("and nobody gets a fraction", Object.values(tiny.shares).filter((v) => v > 0).length, 1);

  // The ceiling the rules enforce must behave.
  const big = computeShares("equal", 100000000, PEOPLE, {});
  eq("the largest allowed expense splits exactly", sum(big.shares), 100000000);
}

/* ── formatting ────────────────────────────────────────────── */
{
  eq("whole rupees print without decimals", money(450000), "₹4,500");
  eq("paise print with two decimals", money(34616), "₹346.16");
  eq("indian grouping", money(1234567_00), "₹12,34,567");
  eq("negative prints with a minus", money(-5000), "−₹50");
  eq("signed positive", money(5000, { sign: true }), "+₹50");
}

/* ── report ────────────────────────────────────────────────── */
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\n  Failures:");
  for (const f of fails.slice(0, 25)) console.log(`   · ${f}`);
  process.exit(1);
}
