/* Paste your Firebase web config between the braces below, then save.
   Until you do, the page runs in local mode (expenses stay on one device).

   Where to get it:
     1. console.firebase.google.com  ->  Add project  (any name, Analytics off)
     2. Build -> Firestore Database -> Create database -> Start in test mode
     3. Project settings (gear) -> Your apps -> Web (</>) -> Register app
     4. Copy the object it shows after `const firebaseConfig =` and paste it here.

   These keys are not secrets — they identify your project, they don't grant
   access on their own. Access is controlled by the Firestore rules in README.md. */

window.GOA_CONFIG = {
  // Everyone sharing one trip must use the same tripId.
  tripId: "goa-2026",

  firebase: {
    // apiKey: "AIza...",
    // authDomain: "your-project.firebaseapp.com",
    // projectId: "your-project",
    // storageBucket: "your-project.firebasestorage.app",
    // messagingSenderId: "000000000000",
    // appId: "1:000000000000:web:abcdef",
  },
};
