import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";
import { sendChatMessage, DEFAULT_MODEL } from "../lib/gemini.js";

const SETTINGS_KEY = "geminiSettings"; // { apiKey, model }

const SYSTEM_PREAMBLE =
  "You are a portfolio assistant inside a personal investing desktop app. " +
  "Answer using the portfolio/price context given below, as of the timestamp given. " +
  "You are not a licensed financial advisor and this is not financial advice -- " +
  "say so if asked for a recommendation, and stick to describing what the data shows.";

// Gemini BYOK chat. Only { apiKey, model } is persisted (same getStore()
// file as trades/watchlist/portfolio) -- the message transcript is
// intentionally kept in React state only, so it resets on a full app
// reload but survives switching tabs, since this hook lives in App.jsx
// (same reasoning as watchlistAlarms/strategySignals: App.jsx's Suspense
// block only mounts the active tab's panel, so a hook owned by ChatPanel
// itself would be wiped on every tab switch).
export function useGeminiChat() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | sending | error
  const [error, setError] = useState(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(SETTINGS_KEY);
      if (cancelled) return;
      if (saved?.apiKey) setApiKey(saved.apiKey);
      if (saved?.model) setModel(saved.model);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(SETTINGS_KEY, { apiKey, model });
      store.save();
    });
  }, [apiKey, model]);

  // Registered by ChatPanel (which owns the live portfolio/price data) on
  // every render via a bare effect -- same fresh-closure trick as
  // useSignalPolling's runCheckRef, so sendMessage always reads the latest
  // context without needing it in a dependency array.
  const contextProviderRef = useRef(() => "");
  const setContextProvider = useCallback((fn) => {
    contextProviderRef.current = fn;
  }, []);

  const sendMessage = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!apiKey) {
        setError("Set a Gemini API key first.");
        setStatus("error");
        return;
      }

      const userMsg = { id: crypto.randomUUID(), role: "user", text: trimmed, createdAt: new Date().toISOString() };
      const history = [...messages, userMsg];
      setMessages(history);
      setStatus("sending");
      setError(null);

      try {
        const contextText = contextProviderRef.current();
        const { text: replyText } = await sendChatMessage({
          apiKey,
          model,
          systemInstruction: `${SYSTEM_PREAMBLE}\n\n${contextText}`,
          messages: history,
        });
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: replyText, createdAt: new Date().toISOString() }]);
        setStatus("idle");
      } catch (err) {
        setError(err.message || "Gemini request failed.");
        setStatus("error");
      }
    },
    [apiKey, model, messages]
  );

  const clearConversation = useCallback(() => {
    setMessages([]);
    setError(null);
    setStatus("idle");
  }, []);

  return { messages, status, error, apiKey, setApiKey, model, setModel, sendMessage, clearConversation, setContextProvider };
}
