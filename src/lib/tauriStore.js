import { load } from "@tauri-apps/plugin-store";

let storePromise = null;

// Single on-disk store shared by useTrades/useWatchlist, so both hooks
// read/write the same app-data.json file instead of opening one each.
export function getStore() {
  if (!storePromise) storePromise = load("app-data.json", { autoSave: false });
  return storePromise;
}
