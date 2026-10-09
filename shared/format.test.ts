import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatFetchTime,
  formatShortDate,
  formatTimeAgo,
  pluralize,
} from "./format.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  test("shows minutes under an hour", () => {
    expect(formatDuration(20 * 1000)).toBe("< 1m");
    expect(formatDuration(42 * MINUTE)).toBe("42m");
  });

  test("shows hours and minutes under a day, dropping zero minutes", () => {
    expect(formatDuration(3 * HOUR + 20 * MINUTE)).toBe("3h 20m");
    expect(formatDuration(5 * HOUR)).toBe("5h");
    expect(formatDuration(59.6 * MINUTE)).toBe("1h");
  });

  test("shows days with one decimal from a day, and whole days from ten", () => {
    expect(formatDuration(DAY)).toBe("1d");
    expect(formatDuration(2.44 * DAY)).toBe("2.4d");
    expect(formatDuration(12.6 * DAY)).toBe("13d");
  });
});

test("formatShortDate reads the date as a UTC day", () => {
  expect(formatShortDate("2026-09-07")).toBe("Sep 7");
});

test("pluralize picks the form from the count", () => {
  expect(pluralize(1, "PR")).toBe("1 PR");
  expect(pluralize(1200, "PR")).toBe("1,200 PRs");
});

test("formatTimeAgo counts whole minutes, hours, then days", () => {
  expect(formatTimeAgo(-5 * MINUTE)).toBe("just now");
  expect(formatTimeAgo(59 * 1000)).toBe("just now");
  expect(formatTimeAgo(5 * MINUTE)).toBe("5 min ago");
  expect(formatTimeAgo(2 * HOUR + 59 * MINUTE)).toBe("2 h ago");
  expect(formatTimeAgo(3 * DAY + 5 * HOUR)).toBe("3 d ago");
});

test("formatFetchTime keeps tenths under ten seconds only", () => {
  expect(formatFetchTime(380)).toBe("0.4 s");
  expect(formatFetchTime(3000)).toBe("3 s");
  expect(formatFetchTime(14_400)).toBe("14 s");
  expect(formatFetchTime(120_000)).toBe("2 min");
  expect(formatFetchTime(125_000)).toBe("2 min 5 s");
});
