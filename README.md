# Goa Register

A shared expense register for a 13-person trip — open the link, pick your name,
log what you spent and who it was for. Everyone sees the same ledger live.

Built as a single static page so it can sit on GitHub Pages with no server.
Firestore holds the data so the page can be shared with people who have no
account anywhere.

## Setup

### 1. Firebase (once, ~5 minutes)

Already done. The project is `goa-register`, Firestore lives in `asia-south1`
(Mumbai), and the keys are in [`firebase-config.js`](firebase-config.js). To
point this at a different project, replace that file's `firebase` object with
the one from **Project settings → Your apps → Web**.

### 2. Firestore rules

Published and live. Reads and writes are confined to one trip id, and every
write is validated — the name must be one of the 13, the amount a positive
integer, and the document must carry exactly the expected fields and nothing
else. Updates are refused outright; the app only ever creates and deletes.

```
rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
match /trips/{tripId}/entries/{entryId} {
function people() { return ['Karan','Vidhi','Vatsal','Dhwani','Diksha','Rohan','Sakshi','Jeet','Dhruvina','Yash','Minal','Vinay','Varun']; }
function base(d) { return d.ts is int && d.addedBy in people() && d.amountPaise is int && d.amountPaise > 0 && d.amountPaise <= 100000000; }
function expense(d) { return d.type == 'expense' && d.keys().hasOnly(['type','desc','category','amountPaise','paidBy','participants','sharesPaise','addedBy','ts']) && d.desc is string && d.desc.size() > 0 && d.desc.size() <= 80 && d.category is string && d.paidBy in people() && d.participants is list && d.participants.size() > 0 && d.participants.hasOnly(people()) && d.sharesPaise is map && d.sharesPaise.keys().hasOnly(people()); }
function payment(d) { return d.type == 'settlement' && d.keys().hasOnly(['type','from','to','amountPaise','addedBy','ts']) && d.from in people() && d.to in people() && d.from != d.to; }
allow read: if tripId == 'goa-2026-x7k2';
allow create: if tripId == 'goa-2026-x7k2' && base(request.resource.data) && (expense(request.resource.data) || payment(request.resource.data));
allow delete: if tripId == 'goa-2026-x7k2';
allow update: if false;
}
}
}
```

Verified against seven cases: a valid expense and a valid payment were accepted;
a stranger's name, a negative amount, a bare junk document, an extra field, and
a payment from someone to themselves were all refused.

Adding or removing a person means editing `people()` here **and** the `PEOPLE`
array in `app.js`. They have to agree or the write is rejected.

The rules are not a wall. Anyone holding the link can still read the register
and add or delete plausible-looking entries — that is the design, since there
are no logins. What they stop is junk, mistakes, and anyone scribbling under a
name that is not on the trip.

### 3. GitHub Pages

Already on: **Deploy from a branch**, `main`, `/ (root)`. Live at
<https://research-cwc.github.io/research-karan-personal/>. Every push to `main`
redeploys it within a minute or two.

## How it works

- **Who you are** is kept in `localStorage` per device, switchable from the header.
  There are no passwords — it is a register among friends, not a bank.
- **Money is integer paise** end to end. An equal split hands the leftover paise
  out one at a time, so shares always add back to the exact total.
- **Settle up** runs a greedy largest-creditor / largest-debtor match, which
  clears every balance in at most 12 transfers instead of 78.
- **Payments** (someone actually transferring money) are entries of their own,
  so the register keeps the full history rather than editing balances in place.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and page shell |
| `styles.css` | Tokens, light and dark themes, layout |
| `app.js` | Ledger maths, rendering, Firestore sync |
| `firebase-config.js` | Project keys and trip id |
| `goa-crew.jpg` | The group photo on the welcome screen |
| `robots.txt` | Asks search engines not to index the site |

## Changing the people

Edit the `PEOPLE` array at the top of `app.js`. Expenses already logged keep the
names they were saved with.
