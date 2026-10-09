import { expect, test } from "bun:test";
import { createSseParser } from "./sse.ts";

test("reads events split across chunks and skips comments", () => {
  const parse = createSseParser();

  expect(parse(": ping\n\nevent: progr")).toEqual([]);
  expect(parse('ess\ndata: {"a":1}\n')).toEqual([]);
  expect(parse("\nevent: result\ndata: done\n\n")).toEqual([
    { event: "progress", data: '{"a":1}' },
    { event: "result", data: "done" },
  ]);
});

test("joins multi-line data and defaults the event name to message", () => {
  const parse = createSseParser();

  expect(parse("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
});

test("accepts CRLF line ends", () => {
  const parse = createSseParser();

  expect(parse("event: error\r\ndata: boom\r\n\r\n")).toEqual([{ event: "error", data: "boom" }]);
});
