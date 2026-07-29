// ---- EDIT THIS FILE with your own values, then redeploy. ----
//
// 1) Firebase console -> Project settings -> "Your apps" -> Web app -> SDK setup
//    Copy the config object and paste it below (replace the placeholders).
// 2) Put the two Google account emails that are allowed to use the ledger.
//    These must ALSO match the emails in firestore.rules and storage.rules.

export const shoppingListConfig = {
    apiKey: "AIzaSyCK2MWo6RrRopJY6Yaw91_sYRrs3B8BvuA",
    authDomain: "expenses-b87fc.firebaseapp.com",
    projectId: "expenses-b87fc",
    storageBucket: "expenses-b87fc.firebasestorage.app",
    messagingSenderId: "860141640810",
    appId: "1:860141640810:web:72f3d46a4a5a14c250be13"
  };

// The only two accounts allowed to sign in. Lowercase.
export const ALLOWED_EMAILS = [
  "shubhamsaxena1492@gmail.com", "shubhangi9237@gmail.com"
];

// Your existing Cloudflare Worker (receipt vision). Leave "" to enter fields by hand.
export const WORKER_URL = "https://shoppinglist.shubhamsaxena1492.workers.dev";
