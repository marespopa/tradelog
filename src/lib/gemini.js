import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 30000;

function mapErrorMessage(status, body) {
  const apiMsg = body?.error?.message;
  if (status === 400 || status === 403) return apiMsg || "Gemini rejected the request — check your API key.";
  if (status === 429) return "Gemini rate limit hit — wait a moment and try again.";
  if (status >= 500) return "Gemini is temporarily unavailable — try again shortly.";
  return apiMsg || `Gemini request failed (${status}).`;
}

// Same CORS-bypass reason as krakenSpot.js's use of tauriFetch: routes the
// request through the Rust backend instead of the webview's own fetch.
// Not built on httpBatch.js's createFetchJson -- that helper is GET-only
// with no header support, and generateContent needs a POST + JSON body +
// API key header (listModels below is GET, but still needs the header).
async function geminiFetch(url, apiKey, init = {}) {
  if (!apiKey) throw new Error("No Gemini API key set.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await tauriFetch(url, { ...init, headers: { "x-goog-api-key": apiKey, ...init.headers }, signal: controller.signal });
  } catch (err) {
    throw new Error(err.name === "AbortError" ? `Gemini request timed out after ${TIMEOUT_MS / 1000}s.` : "Network error contacting Gemini.");
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(mapErrorMessage(res.status, json));
  return json;
}

// messages: [{ role: "user"|"assistant", text }]. systemInstruction: a
// plain string (persona + injected live context), sent fresh on every call
// -- Gemini has no server-side session, so context has to ride along with
// the whole request each time.
export async function sendChatMessage({ apiKey, model = DEFAULT_MODEL, systemInstruction, messages }) {
  const body = {
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
  };
  const json = await geminiFetch(`${API_BASE}/${model}:generateContent`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    const reason = candidate?.finishReason;
    throw new Error(reason && reason !== "STOP" ? `Gemini didn't return a usable reply (${reason}).` : "Gemini returned an empty reply.");
  }
  return { text };
}

// Live catalog of models this key can use, straight from the API instead of
// a hardcoded list that inevitably goes stale as Google ships new models --
// this is what backs the model picker in ChatPanel's settings dialog.
// Filtered to models that actually support generateContent (the catalog
// also includes embedding/other-purpose models that would just 400 if
// picked here), and the "models/" resource-name prefix is stripped since
// sendChatMessage's URL already supplies it.
export async function listModels(apiKey) {
  const json = await geminiFetch(`${API_BASE}?pageSize=1000`, apiKey, { method: "GET" });
  return (json?.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ name: m.name.replace(/^models\//, ""), displayName: m.displayName || m.name }));
}
