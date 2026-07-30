// Copy to config.js and fill in. Keep config.js in the repo for GitHub Pages
// (the Firebase apiKey is not secret — Firestore rules + the email allowlist do the real security).
export const shoppingListConfig = {
  apiKey: "…",
  authDomain: "….firebaseapp.com",
  projectId: "…",
  storageBucket: "….appspot.com",
  messagingSenderId: "…",
  appId: "…",
};
export const ALLOWED_EMAILS = ["you@gmail.com", "wife@gmail.com"]; // must match firestore.rules
export const WORKER_URL = "https://cartpath-parse.YOURNAME.workers.dev";
