import { toBlob } from "html-to-image";
import { useEffect, useState, type RefObject } from "react";
import { parseList } from "../../../shared/schemas";
import type { ShownAnalysis } from "../analysisState";
import { downloadBlob } from "../download";
import { exportFilename, toExportJson } from "../export";

interface ExportActionsProps {
  shown: ShownAnalysis;
  // The results area the PNG captures. This bar sits inside it, so the summary line makes
  // the image self-describing; the buttons carry data-export-exclude and stay out of it.
  captureRef: RefObject<HTMLElement | null>;
}

const buttonClass =
  "inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors disabled:cursor-not-allowed disabled:opacity-60";

function ButtonIcon({ d }: { d: string }) {
  return (
    <svg
      className="w-3.5 h-3.5 mr-1.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const DOWNLOAD_ICON = "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4";
const COPY_ICON =
  "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z";

// The capture area itself is transparent, so the image takes the first background an
// ancestor paints: the page's, in the current light or dark mode.
function paintedBackground(node: HTMLElement): string | undefined {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
  }
  return undefined;
}

function downloadJson(shown: ShownAnalysis) {
  downloadBlob(
    new Blob([toExportJson(shown)], { type: "application/json" }),
    exportFilename(shown, "json"),
  );
}

export function ExportActions({ shown, captureRef }: ExportActionsProps) {
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [pngError, setPngError] = useState<string | null>(null);
  const { since, until } = shown.result.timeRange;
  const label = shown.values.label.trim();
  const repos = parseList(shown.values.repo);
  // The PNG shows the selected repository's metrics but leaves the switcher out, so the
  // line names that repository, with the query it was picked from.
  const repoText =
    shown.repo === null ? repos.join(", ") : `${shown.repo} (of ${repos.length} repositories)`;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(toExportJson(shown));
      setCopied(true);
    } catch {
      // No clipboard outside a secure context, or the browser refused: save the file instead.
      downloadJson(shown);
    }
  }

  async function downloadPng() {
    const node = captureRef.current;
    if (!node) return;
    setRendering(true);
    setPngError(null);
    try {
      const blob = await toBlob(node, {
        pixelRatio: 2,
        backgroundColor: paintedBackground(node),
        cacheBust: true,
        filter: (el) => !(el instanceof HTMLElement && el.hasAttribute("data-export-exclude")),
      });
      if (!blob) throw new Error("The browser returned no image");
      downloadBlob(blob, exportFilename(shown, "png"));
    } catch (error: unknown) {
      setPngError(
        `Could not render the PNG: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 px-6 py-4">
      <p className="text-sm text-gray-600 dark:text-slate-300">
        <span className="font-semibold text-gray-900 dark:text-slate-100">{repoText}</span>
        {" · "}
        {since || "all time"} → {until || "today"}
        {label && ` · label ${label}`}
        {shown.team.length > 0 && ` · team ${shown.team.join(", ")}`}
        {shown.values.includeBots && " · bots included"}
      </p>
      <div data-export-exclude className="flex flex-wrap items-center gap-2">
        {pngError && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {pngError}
          </p>
        )}
        <button type="button" onClick={copyJson} className={buttonClass}>
          <ButtonIcon d={COPY_ICON} />
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button type="button" onClick={() => downloadJson(shown)} className={buttonClass}>
          <ButtonIcon d={DOWNLOAD_ICON} />
          Download JSON
        </button>
        <button type="button" onClick={downloadPng} disabled={rendering} className={buttonClass}>
          <ButtonIcon d={DOWNLOAD_ICON} />
          {rendering ? "Rendering…" : "Download PNG"}
        </button>
      </div>
    </div>
  );
}
