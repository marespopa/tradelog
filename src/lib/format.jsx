import { useEffect, useState } from "react";

export const fmt = (n, decimals) => {
  if (n == null || isNaN(n)) return "—";
  if (decimals != null) return n.toFixed(decimals);
  const abs = Math.abs(n);
  if (abs < 0.0001) return n.toFixed(8);
  if (abs < 1) return n.toFixed(4);
  if (abs < 100) return n.toFixed(3);
  return n.toFixed(2);
};

export const fmtUsd = (n) => {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
};

export const timeAgo = (iso) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// timeAgo() only recomputes when the caller re-renders, so a component that
// only re-renders on polling intervals would otherwise show frozen text
// between polls. This re-renders itself every second, in isolation.
export function TimeAgo({ date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return timeAgo(date);
}

export function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function pnlClass(value) {
  if (value == null || isNaN(value)) return "text-dim";
  return value >= 0 ? "text-position-long" : "text-position-short";
}

// Turns a duration in ms into a rough human ETA (hours/days/weeks) — used
// for the setup panel's "~time to target" estimate, which is deliberately
// coarse since it's derived from average volatility, not a real forecast.
export function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const hours = ms / 3.6e6;
  if (hours < 1) return "<1h";
  if (hours < 48) return `~${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `~${Math.round(days)}d`;
  return `~${Math.round(days / 7)}w`;
}

// Exact (non-rounded-to-"~") duration, e.g. "22h 39m" or "3d 2h" — used for
// a closed trade's actual holding time, where precision matters more than
// the coarse ETA framing of fmtDuration().
export function fmtDurationExact(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return "—";
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const datePart = d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${datePart}, ${timePart}`;
}

export function fmtPrice(n) {
  if (n == null || isNaN(n)) return "—";
  return `$${fmt(n)}`;
}

// Planned reward:risk ratio from entry/stop-loss/target — independent of
// side, since risk and reward are both measured as distance from entry.
export function riskRewardRatio(entryPrice, stopLoss, targetPrice) {
  if (entryPrice == null || stopLoss == null || targetPrice == null) return null;
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(targetPrice - entryPrice);
  if (risk === 0) return null;
  return reward / risk;
}

export function fmtRiskReward(entryPrice, stopLoss, targetPrice) {
  const rr = riskRewardRatio(entryPrice, stopLoss, targetPrice);
  if (rr == null) return "—";
  return `1:${rr.toFixed(2)}`;
}
