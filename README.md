# Goa Hisaab

A shared expense register for a 13-person trip — open the link, pick your name,
log what you spent and who it was for. Everyone sees the same ledger live.

Live at <https://research-cwc.github.io/research-karan-personal/>.

Built as a single static page so it can sit on GitHub Pages with no server.
Firestore holds the data so the link works for people who have no account
anywhere.

## What it covers

Everything a trip actually throws at a split, which is more than "divide by 13".

**Who paid.** One person, or several people paying parts of the same bill — the
₹8,000 dinner where Karan put in ₹5,000 and Rohan ₹3,000 is one expense, not
two. The payer does not have to be in the split: paying for someone else's
ticket is just a split they are not part of.

**How it divides.** Five methods:

| Method | For |
| --- | --- |
| Equally | The default — the shack lunch everyone ate |
| Exact amounts | Everyone's order was different and you have the bill |
| Percentage | "I'll take 40% of this" |
| Shares / weights | A couple counts 2, a single counts 1; the big room takes 3 |
| Equally, plus extras | Split the base equally, then add the extra drink onto whoever had it |

Whichever you pick, the page shows **what each person ends up owing, live,
before you save it**. No saving and hoping.

**Who's in it.** Any subset of the trip, toggled per expense.

**Who's on the trip.** The roster is managed in the app, under Balances — add
or remove someone and every open page updates at once. Nobody edits code, and
nobody edits the security rules; the rules read the roster from the database.
Someone who already has expenses logged cannot be removed, because they are
part of the history. If a name does get dropped while still carrying a balance,
the ledger keeps showing them until they are square.

**When.** Each expense carries its own date, so you can log Tuesday's lunch on
Thursday without it landing in the wrong day.

**Fixing things.** Any entry can be edited in place — amount, date, payers,
split method, who was in it — and the register keeps both who added it and who
edited it. No delete-and-retype.

**Settling.** Payments between any two people, partial or full, at any time.
Overpaying flips the balance rather than breaking it.

**Settling as a family.** Five of the thirteen are couples who travel on one
wallet, so Balances and Settle up both offer a **By family** view: a spouse who
is owed cancels a spouse who owes, and the family makes one payment instead of
two. It only affects settling — every expense, share and balance underneath is
still worked out person by person, and **By person** shows exactly that.

A family row names the two people the payment will be recorded against, because
a couple is not a person and nothing should be logged as if it were. A family
whose two balances cancel out is asked for nothing at all; what they would
square between themselves is shown, not demanded.

The couples live in `DEFAULT_HOUSEHOLDS` at the top of `ledger.js`. Anyone not
listed settles for themselves, so a person added mid-trip needs no change.

**Getting the answer.** Three views, because they answer different questions:

- **By family** — couples combined, one payment each.
- **By person** — the smallest set of transfers that clears everyone.
  Twelve payments at most instead of seventy-eight. Money may move between
  people who never shared an expense; the totals still come out right.
- **Who owes whom** — the direct debts as they actually arose. More payments,
  but each one traces to a real expense.

Tap any name in Balances to see what they paid, what their share was, and who
their balance is with. Export the whole register to CSV at any point.

## The maths

Money is integer paise end to end; rupees only exist when parsing input and
printing. Every division uses largest-remainder allocation, so the parts always
add back to the exact total — ₹4,500 across 13 becomes five shares of ₹346.16
and eight of ₹346.15, not thirteen of ₹346.15 and five lost paise.

Debts are tracked **pairwise**, not only as a net number. Within one expense,
each person's position is what they put in minus what they owe; those positions
sum to zero, so matching the biggest debtor to the biggest creditor and working
down clears them exactly. Someone who both paid and owes is netted against
themselves first and never appears owing themselves.

An earlier version allocated each person's share across the payers in
proportion to what each put in. That reads well but is wrong: each allocation
rounds on its own, so the columns drift a few paise from what the payers
actually handed over, and the pairwise debts stop agreeing with the net
balances. The property test below caught it.

### Tests

```
node tests/ledger.test.mjs
```

15,708 assertions, including 400 randomly generated trips — random amounts,
random participants, random split methods, multiple payers, settlements thrown
in. Each asserts that shares and payer amounts sum to the exact total, that the
pairwise debts agree with the net balances to the paisa, that nobody owes
themselves, that all 13 balances sum to zero, and that applying the suggested
transfers leaves every balance at exactly zero.

The app shows this check too: Balances ends with a line confirming all 13
balances add up to ₹0.

## Setup

### 1. Firebase

Done. Project `goa-register`, Firestore in `asia-south1` (Mumbai), free Spark
plan. Keys are in [`firebase-config.js`](firebase-config.js) — they identify the
project, they do not grant access on their own.

### 2. Firestore rules

Published and live. Reads and writes are confined to one trip id, and every
write is validated: names must be among the 13, amounts positive integers, dates
well-formed, and the document must carry exactly the expected fields and nothing
else. Edits may change content but not who added an entry or when.

```
rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
match /trips/{tripId}/meta/roster {
allow read: if tripId == 'goa-2026-x7k2';
allow write: if tripId == 'goa-2026-x7k2' && request.resource.data.keys().hasOnly(['names','updatedBy','updatedTs']) && request.resource.data.names is list && request.resource.data.names.size() > 0 && request.resource.data.names.size() <= 50;
}
match /trips/{tripId}/entries/{entryId} {
function roster() { return get(/databases/$(database)/documents/trips/$(tripId)/meta/roster).data.names; }
function people() { return exists(/databases/$(database)/documents/trips/$(tripId)/meta/roster) ? roster() : ['Karan','Vidhi','Vatsal','Dhwani','Diksha','Rohan','Sakshi','Jeet','Dhruvina','Yash','Minal','Vinay','Varun']; }
function base(d) { return d.ts is int && d.addedBy in people() && d.amountPaise is int && d.amountPaise > 0 && d.amountPaise <= 100000000 && d.date is string && d.date.size() == 10 && (!d.keys().hasAny(['note']) || (d.note is string && d.note.size() <= 200)) && (!d.keys().hasAny(['editedBy']) || d.editedBy in people()) && (!d.keys().hasAny(['deleted']) || d.deleted is bool) && (!d.keys().hasAny(['deletedBy']) || d.deletedBy in people()); }
function expense(d) { return d.type == 'expense' && d.keys().hasAll(['type','desc','category','amountPaise','date','payersPaise','sharesPaise','splitMethod','addedBy','ts']) && d.keys().hasOnly(['type','desc','category','amountPaise','date','payersPaise','sharesPaise','splitMethod','splitInput','note','addedBy','ts','editedBy','editedTs','deleted','deletedBy','deletedTs']) && d.desc is string && d.desc.size() > 0 && d.desc.size() <= 80 && d.category is string && d.category.size() <= 20 && d.splitMethod in ['equal','exact','percent','shares','adjust'] && d.payersPaise is map && d.payersPaise.size() > 0 && d.payersPaise.keys().hasOnly(people()) && d.sharesPaise is map && d.sharesPaise.size() > 0 && d.sharesPaise.keys().hasOnly(people()); }
function payment(d) { return d.type == 'settlement' && d.keys().hasAll(['type','from','to','amountPaise','date','addedBy','ts']) && d.keys().hasOnly(['type','from','to','amountPaise','date','note','addedBy','ts','editedBy','editedTs','deleted','deletedBy','deletedTs']) && d.from in people() && d.to in people() && d.from != d.to; }
function valid(d) { return base(d) && (expense(d) || payment(d)); }
allow read: if tripId == 'goa-2026-x7k2';
allow create: if tripId == 'goa-2026-x7k2' && valid(request.resource.data);
allow update: if tripId == 'goa-2026-x7k2' && valid(request.resource.data) && request.resource.data.type == resource.data.type && request.resource.data.addedBy == resource.data.addedBy && request.resource.data.ts == resource.data.ts;
allow delete: if tripId == 'goa-2026-x7k2';
}
}
}
```

`people()` reads the roster document rather than a hardcoded list, so adding
someone in the app immediately lets them appear on expenses. The hardcoded
names remain only as a fallback for a trip whose roster has never been saved —
if the roster document is missing, the register still works instead of locking
everyone out.

Checked against 23 cases. Accepted: every split method, multiple payers, a payer
outside the split, notes, backdated expenses, settlements, and edits. Refused: a
stranger's name as payer or in the split, an unknown split method, a missing or
malformed date, no payers, a negative amount, an oversized note, an extra field,
a payment to oneself, and any edit rewriting who added an entry or when.

**What the rules cannot check.** Firestore rules cannot sum the values of a map,
so "the shares add up to the total" is enforced by the page, not the database.
Anyone writing to Firestore directly could store an internally inconsistent
expense. The balance check at the bottom of Balances is what would surface it.

The rules are not a wall. Anyone holding the link can read the register and add,
edit or delete plausible entries — that is the design, since there are no
logins. What they stop is junk, mistakes, and anyone writing under a name that
is not on the trip.

### 3. GitHub Pages

Already on: **Deploy from a branch**, `main`, `/ (root)`. Every push to `main`
redeploys within a minute or two.

## What was hardened before the trip

A pass looking for the things that bite when real money is involved:

- **A write made offline no longer hangs.** Firestore applies a write locally
  at once but settles its promise only when the server acknowledges it, so on a
  weak signal the button sat on "Saving…" for an entry that had in fact already
  been recorded on that phone — and people would add it a second time. The app
  now waits a few seconds, then says it will sync and carries on.
- **Recording a payment asks first.** "Mark paid" moves real money in the
  ledger, and two people tapping the same suggested transfer would settle a
  debt twice. It now asks whether the money has actually moved.
- **Settling with someone who left.** The settle-up and filter pickers are
  built from the roster plus anyone still carrying a balance. Removing a person
  is blocked once they have expenses, but two people acting at the same moment
  could still slip past that; if it happens their repayment can still be
  recorded.
- **Negative amounts are refused** rather than being quietly dropped and
  reported as a confusing mismatch. A negative is still allowed as a discount
  under "equally, plus extras", where it means something.
- **An upper limit is checked in the page**, with a sentence that explains it,
  instead of letting the database refuse it with "permission denied".
- **Dates are bounded** at the input, so a mistyped year cannot pin an entry to
  the top of the register forever.
- **Database errors are translated.** "Missing or insufficient permissions"
  became a sentence about what to check.
- **A trip cannot be emptied** below two people.
- **Clicking a payer's name no longer double-fires**: those rows were `<label>`
  elements wrapping a button, so a click toggled the payer and stole focus.

### Deleting is reversible

Deleting marks an entry rather than destroying it. It leaves the register and
every balance at once, an Undo appears straight away, and it also drops into a
**Deleted** section at the foot of the Expenses tab that any of the thirteen
can restore from. It survives a reload, so an undo is still there tomorrow.
Erasing one for good is a second, separate confirmation.

This needs the `deleted`, `deletedBy` and `deletedTs` fields allowed by the
rules below. Until they are, the app falls back to deleting outright and says
so in as many words, rather than offering an undo it cannot honour.

### Known limits, deliberately left
- **Names are an honour system.** Anyone can pick any name; there are no
  logins. That was the point.
- **Two people editing one entry**: the later save wins, silently.

## On an iPhone

Everyone on this trip is on iOS, so the page is tuned for it rather than merely
working there.

- **Every field is 16px on a touch device.** Safari zooms the whole page when a
  smaller field takes focus, which it then will not undo — the single most
  irritating thing about a web form on an iPhone.
- **Targets are Apple's 44px**, and Edit sits well clear of Delete, because a
  thumb catching the wrong one here costs real money.
- **Add to Home Screen** gives it an icon, its own name, and no Safari chrome.
  The status bar then sits over the page, which is why every edge is padded
  from `env(safe-area-inset-*)` rather than a fixed number — it also keeps the
  content clear of the notch in landscape.
- Amount fields raise the number pad, the tap highlight and double-tap zoom are
  gone, text does not inflate in landscape, and selects now carry a chevron so
  they read as something you can tap.

## Deploys and stale caches

`index.html` loads `styles.css`, `app.js` and `firebase-config.js` with a `?v=`
query, and `app.js` imports `ledger.js` the same way. Bump that number when
shipping a change, or a phone holding yesterday's cached script will keep
running it.

That is belt and braces, not the only guard. A viewer can still be holding an
older `index.html` than the script it loads, so code that wires up a control
goes through a helper that quietly skips anything not on the page. A page one
version behind loses that one feature; it does not fail to start. This is
tested by serving a stripped page against the current script.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and page shell |
| `styles.css` | Tokens, light and dark themes, layout |
| `ledger.js` | Split methods and ledger maths — pure, no DOM |
| `app.js` | Form, rendering, Firestore sync |
| `firebase-config.js` | Project keys and trip id |
| `tests/ledger.test.mjs` | The maths tests |
| `goa-crew.jpg` | The group photo on the welcome screen |
| `apple-touch-icon.png`, `icon-*.png` | Home Screen icons |
| `manifest.webmanifest` | Name and icons when installed |
| `robots.txt` | Asks search engines not to index the site |

## Changing the people

In the app: **Balances → Who's on this trip**. Add or remove, and every open
page follows within a second. No code, no rules, no deploy.

`DEFAULT_PEOPLE` in `ledger.js` is only the starting roster for a trip that has
never saved one. Once the roster document exists it is the single source of
truth, for the app and the security rules alike.
