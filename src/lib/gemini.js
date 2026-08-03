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
// (no method/body/headers), and generateContent needs a POST + JSON body +
// API key header.
//
// messages: [{ role: "user"|"assistant", text }]. systemInstruction: a
// plain string (persona + injected live context), sent fresh on every call
// -- Gemini has no server-side session, so context has to ride along with
// the whole request each time.
export async function sendChatMessage({ apiKey, model = DEFAULT_MODEL, systemInstruction, messages }) {
  if (!apiKey) throw new Error("No Gemini API key set.");
  const url = `${API_BASE}/${model}:generateContent`;
  const body = {
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await tauriFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === "AbortError" ? `Gemini request timed out after ${TIMEOUT_MS / 1000}s.` : "Network error contacting Gemini.");
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(mapErrorMessage(res.status, json));

  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    const reason = candidate?.finishReason;
    throw new Error(reason && reason !== "STOP" ? `Gemini didn't return a usable reply (${reason}).` : "Gemini returned an empty reply.");
  }
  return { text };
}
