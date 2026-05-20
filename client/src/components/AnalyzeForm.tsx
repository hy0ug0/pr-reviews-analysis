import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { analyzeFormSchema, timeRangePresets } from "../../../shared/schemas";
import { fetchSuggestions } from "../api";
import type { AnalyzeFormValues, AppDefaults, AppSuggestion, TimeRangePreset } from "../types";

const timeRangeSet: ReadonlySet<string> = new Set(timeRangePresets);

function isTimeRangePreset(value: string): value is TimeRangePreset {
  return timeRangeSet.has(value);
}

interface AnalyzeFormProps {
  onSubmit: (values: AnalyzeFormValues) => void;
  loading: boolean;
  defaults?: AppDefaults;
}

const baseInputClass =
  "w-full px-3 py-2 border rounded-lg shadow-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm";
const inputClass = `${baseInputClass} border-gray-300 dark:border-slate-700`;
const inputErrorClass = `${baseInputClass} border-red-400 dark:border-red-600`;

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-500 dark:text-red-400 mt-1">{message}</p>;
}

type SuggestionKind = "repos" | "labels" | "users";

interface TokenInfo {
  query: string;
  replaceStart: number;
  replaceEnd: number;
}

function getTokenInfo(value: string, cursor: number): TokenInfo {
  const beforeCursor = value.slice(0, cursor);
  const previousComma = beforeCursor.lastIndexOf(",");
  const nextComma = value.indexOf(",", cursor);
  const rawStart = previousComma + 1;
  const rawEnd = nextComma === -1 ? value.length : nextComma;
  const rawToken = value.slice(rawStart, rawEnd);
  const leadingSpaces = rawToken.match(/^\s*/)?.[0].length ?? 0;
  const trailingSpaces = rawToken.match(/\s*$/)?.[0].length ?? 0;

  return {
    query: rawToken.trim(),
    replaceStart: rawStart + leadingSpaces,
    replaceEnd: rawEnd - trailingSpaces,
  };
}

interface AutocompleteInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className: string;
  kind: SuggestionKind;
  repo?: string;
  multi?: boolean;
}

function AutocompleteInput({
  id,
  value,
  onChange,
  placeholder,
  className,
  kind,
  repo,
  multi = false,
}: AutocompleteInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<AppSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const token = multi ? getTokenInfo(value, cursor) : null;
  const activeQuery = multi ? (token?.query ?? "") : value.trim();
  const showMenu = focused && (loadingSuggestions || suggestions.length > 0);

  useEffect(() => {
    setSuggestions([]);
    setHighlightedIndex(0);
  }, [activeQuery, kind, repo]);

  useEffect(() => {
    if (!focused) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setLoadingSuggestions(true);
      fetchSuggestions(kind, { query: activeQuery, repo }, controller.signal)
        .then((items) => {
          setSuggestions(items);
          setHighlightedIndex(0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingSuggestions(false);
        });
    }, 180);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [activeQuery, focused, kind, repo]);

  const syncCursor = (target: HTMLInputElement) => {
    setCursor(target.selectionStart ?? target.value.length);
  };

  const commitSuggestion = (suggestion: AppSuggestion) => {
    let nextValue = suggestion.value;
    let nextCursor = suggestion.value.length;

    if (multi) {
      const latestCursor = inputRef.current?.selectionStart ?? cursor;
      const latestToken = getTokenInfo(value, latestCursor);
      nextValue =
        value.slice(0, latestToken.replaceStart) +
        suggestion.value +
        value.slice(latestToken.replaceEnd);
      nextCursor = latestToken.replaceStart + suggestion.value.length;
    }

    onChange(nextValue);
    setCursor(nextCursor);
    setFocused(false);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    syncCursor(event.target);
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showMenu) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && suggestions[highlightedIndex]) {
      event.preventDefault();
      commitSuggestion(suggestions[highlightedIndex]);
    } else if (event.key === "Escape") {
      setFocused(false);
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        id={id}
        value={value}
        onChange={handleChange}
        onFocus={(event) => {
          syncCursor(event.currentTarget);
          setFocused(true);
        }}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onClick={(event) => syncCursor(event.currentTarget)}
        onKeyUp={(event) => syncCursor(event.currentTarget)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
        role="combobox"
        aria-expanded={showMenu}
        aria-autocomplete="list"
        aria-controls={`${id}-suggestions`}
      />
      {showMenu && (
        <div
          id={`${id}-suggestions`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500 dark:text-slate-400">Loading...</div>
          ) : (
            suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.value}-${index}`}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitSuggestion(suggestion)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  index === highlightedIndex
                    ? "bg-gray-100 text-gray-950 dark:bg-slate-800 dark:text-slate-50"
                    : "text-gray-800 hover:bg-gray-50 dark:text-slate-200 dark:hover:bg-slate-800"
                }`}
              >
                {suggestion.color && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${suggestion.color}` }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{suggestion.value}</span>
                  {suggestion.detail && (
                    <span className="block truncate text-xs text-gray-500 dark:text-slate-400">
                      {suggestion.detail}
                    </span>
                  )}
                </span>
                {suggestion.isPrivate && (
                  <span className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">
                    Private
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function AnalyzeForm({ onSubmit, loading, defaults }: AnalyzeFormProps) {
  const [form, setForm] = useState<AnalyzeFormValues>({
    repo: "",
    label: "",
    timeRange: "month",
    since: "",
    until: "",
    team: "",
    skipCache: false,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof AnalyzeFormValues, string>>>({});

  useEffect(() => {
    if (defaults) {
      setForm((prev) => ({
        ...prev,
        repo: defaults.repos || prev.repo,
        label: defaults.label || prev.label,
        team: defaults.team || prev.team,
      }));
    }
  }, [defaults]);

  const update = <K extends keyof AnalyzeFormValues>(field: K, value: AnalyzeFormValues[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = analyzeFormSchema.safeParse(form);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    onSubmit(form);
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 p-6 mb-8">
      <form onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="repo"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
            >
              Repository
            </label>
            <AutocompleteInput
              id="repo"
              value={form.repo}
              onChange={(value) => update("repo", value)}
              placeholder="owner/repo"
              className={errors.repo ? inputErrorClass : inputClass}
              kind="repos"
              multi
            />
            <FieldError message={errors.repo} />
            {!errors.repo && (
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                Comma-separated for multiple repos
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="label"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
            >
              Label{" "}
              <span className="text-gray-400 dark:text-slate-500 font-normal">(optional)</span>
            </label>
            <AutocompleteInput
              id="label"
              value={form.label}
              onChange={(value) => update("label", value)}
              placeholder='e.g. "bug"'
              className={errors.label ? inputErrorClass : inputClass}
              kind="labels"
              repo={form.repo}
            />
            <FieldError message={errors.label} />
          </div>

          <div>
            <label
              htmlFor="timeRange"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
            >
              Time Range
            </label>
            <select
              id="timeRange"
              value={form.timeRange}
              onChange={(e) => {
                const v = e.target.value;
                if (isTimeRangePreset(v)) update("timeRange", v);
              }}
              className={errors.timeRange ? inputErrorClass : inputClass}
            >
              <option value="week">Last Week</option>
              <option value="month">Last Month</option>
              <option value="quarter">Last Quarter</option>
              <option value="year">Last Year</option>
              <option value="all">All Time</option>
              <option value="custom">Custom Range</option>
            </select>
            <FieldError message={errors.timeRange} />
          </div>

          <div>
            <label
              htmlFor="team"
              className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
            >
              Team Members{" "}
              <span className="text-gray-400 dark:text-slate-500 font-normal">(optional)</span>
            </label>
            <AutocompleteInput
              id="team"
              value={form.team}
              onChange={(value) => update("team", value)}
              placeholder="user1, user2, ..."
              className={errors.team ? inputErrorClass : inputClass}
              kind="users"
              repo={form.repo}
              multi
            />
            <FieldError message={errors.team} />
            {!errors.team && (
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                Filter reviewers to these GitHub handles
              </p>
            )}
          </div>
        </div>

        {form.timeRange === "custom" && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="since"
                className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
              >
                From
              </label>
              <input
                type="date"
                id="since"
                value={form.since}
                onChange={(e) => update("since", e.target.value)}
                className={errors.since ? inputErrorClass : inputClass}
              />
              <FieldError message={errors.since} />
            </div>
            <div>
              <label
                htmlFor="until"
                className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1"
              >
                To
              </label>
              <input
                type="date"
                id="until"
                value={form.until}
                onChange={(e) => update("until", e.target.value)}
                className={errors.until ? inputErrorClass : inputClass}
              />
              <FieldError message={errors.until} />
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.skipCache}
              onChange={(e) => update("skipCache", e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            Skip cache (force refresh)
          </label>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-slate-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg
              className="w-4 h-4 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            Analyze
          </button>
        </div>
      </form>
    </div>
  );
}
