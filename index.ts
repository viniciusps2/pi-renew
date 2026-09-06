// Extension entry point named in the `pi` manifest in package.json.
//
// The extension itself lives in pi-extensions/pi-renew/; this file only re-exports it. It exists
// for the Extensions list: pi's compact label collapses to the package name alone
// (`viniciusps2/pi-renew`) only when the manifest entry is an `index` file at the package root.
// Pointing the manifest straight at the real entry instead prints the whole path after a colon —
// `viniciusps2/pi-renew:pi-extensions/pi-renew/pi-renew.ts`.
export { default } from "./pi-extensions/pi-renew/pi-renew";
