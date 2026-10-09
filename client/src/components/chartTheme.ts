export interface ChartTheme {
  // Single-series mark color. indigo-600 on white and indigo-500 on slate-900 both
  // clear 3:1 against their surface and stay inside the readable lightness band.
  series: string;
  text: string;
  grid: string;
  surface: string;
  // Same fills as the page's own tooltips (gray-900, slate-700).
  tooltip: string;
}

export function chartTheme(isDark: boolean): ChartTheme {
  return isDark
    ? {
        series: "#6366f1",
        text: "#94a3b8",
        grid: "#1e293b",
        surface: "#0f172a",
        tooltip: "#334155",
      }
    : {
        series: "#4f46e5",
        text: "#6b7280",
        grid: "#f1f5f9",
        surface: "#ffffff",
        tooltip: "#111827",
      };
}
