import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

// Shared native-OS-toast plumbing for both useWatchlistAlarms (price
// alarms) and useSignalPolling (strategy signals) -- the Tauri
// notification plugin respects OS notification settings and can be
// re-requested after a denial, unlike the webview's Web Notification API.

// No-ops on a cold/denied permission rather than prompting -- background
// pollers can't trigger a permission prompt (see ensureNotificationPermission
// below for the one path that can).
export async function notifyOS(title, body) {
  if (!(await isPermissionGranted())) return;
  sendNotification({ title, body });
}

// Must be called from inside a user-gesture handler (e.g. a checkbox
// onChange or a form submit) so the OS permission prompt actually surfaces.
export async function ensureNotificationPermission() {
  if (await isPermissionGranted()) return "granted";
  return requestPermission();
}
