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

**Firestore Database → Rules**, replace everything with this, then **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trips/{tripId}/entries/{entryId} {
      allow read, write: if tripId == 'goa-2026-x7k2';
    }
  }
}
```

The database was created in production mode, so nothing could be read or
written until these rules went live — there was never an open window, and
unlike test mode they do not expire after 30 days.

They allow anyone holding the page to read and write that one trip's entries,
which is the point — there are no logins. The trip id is the only thing gating
it, so treat it like the link itself. Changing it means changing both the rules
and `firebase-config.js`; the register goes blank if they disagree.

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
| `firebase-config.js` | Your project keys and trip id |

## Changing the people

Edit the `PEOPLE` array at the top of `app.js`. Expenses already logged keep the
names they were saved with.
