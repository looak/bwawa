// Number & text formatting shared by the views.

export function formatEval(cp, mate) {
  if (mate != null) return mate > 0 ? `#${mate}` : `#-${-mate}`;
  if (cp == null) return "";
  const pawns = cp / 100;
  return (pawns > 0 ? "+" : pawns < 0 ? "−" : "") + Math.abs(pawns).toFixed(2);
}

// white's winning share 0..1 for the eval bar
export function evalShare(cp, mate) {
  if (mate != null) return mate > 0 ? 1 : 0;
  if (cp == null) return 0.5;
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

export function formatClock(ms) {
  if (ms == null) return "–";
  const negative = ms < 0;
  ms = Math.abs(ms);
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60), seconds = total % 60;
  let text;
  if (minutes >= 60) text = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  else if (total < 20) text = `${seconds}.${Math.floor((ms % 1000) / 100)}`;
  else text = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return (negative ? "−" : "") + text;
}

export function formatMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  return formatClock(ms);
}

export function formatCount(n) {
  if (n == null) return "–";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}G`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function resultText(result) {
  return result === "1/2-1/2" ? "½–½" : result ? result.replace("-", "–") : "*";
}
