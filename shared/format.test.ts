import { describe, expect, test } from "bun:test";
import { formatDuration, formatShortDate, pluralize } from "./format.ts";

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
