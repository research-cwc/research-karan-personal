# Goa Register

A shared expense register for a 13-person trip — open the link, pick your name,
log what you spent and who it was for. Everyone sees the same ledger live.

Built as a single static page so it can sit on GitHub Pages with no server.
Firestore holds the data so the page can be shared with people who have no
account anywhere.

## Setup

### 1. Firebase (once, ~5 minutes)

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
   Any name. Google Analytics can be off.
2. **Build → Firestore Database → Create database**. Pick a region near India
   (`asia-south1`). Start in **test mode** — the rules below replace it.
3. **Project settings** (gear icon) → **Your apps** → web icon `</>` →
   register an app. Copy the `firebaseConfig` object it shows.
4. Paste it into [`firebase-config.js`](firebase-config.js), inside `firebase: { … }`.

### 2. Firestore rules

**Firestore Database → Rules**, replace everything with this, then **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trips/{tripId}/entries/{entryId} {
      allow read, write: if tripId == 'goa-2026';
    }
  }
}
```

Test mode expires after 30 days and the register stops working; these rules do
not expire. They allow anyone who has the page to read and write that one trip's
entries, which is the point — there are no logins. Change `goa-2026` in both the
rules and `firebase-config.js` to something less guessable if that matters.

### 3. GitHub Pages

Repo **Settings → Pages → Build and deployment**, source **Deploy from a
branch**, branch `main`, folder `/ (root)`. Save. The URL appears there in a
minute or two. Share that link.

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
