/* Firebase project: goa-register (asia-south1 / Mumbai).

   These keys are not secrets — they identify the project, they don't grant
   access on their own. Access is controlled by the Firestore rules, which only
   allow reads and writes under the tripId below. Change the tripId here and in
   the rules together, or the register goes blank. */

window.GOA_CONFIG = {
  // Everyone sharing one trip must use the same tripId.
  tripId: "goa-2026-x7k2",

  firebase: {
    apiKey: "AIzaSyC0_hqeqmteHPIVlAnVwF-ca9Et1jxenQo",
    authDomain: "goa-register.firebaseapp.com",
    projectId: "goa-register",
    storageBucket: "goa-register.firebasestorage.app",
    messagingSenderId: "949344257684",
    appId: "1:949344257684:web:7009fad6d7f6c71b33d681",
  },
};
