// A server-sent event as read off the stream. `event` defaults to "message", per the spec.
export interface ServerSentEvent {
  event: string;
  data: string;
}

// Splits a text/event-stream into events, chunk by chunk, since a chunk can end anywhere.
// Comment lines (": ping") and fields other than event and data are skipped.
export function createSseParser(): (chunk: string) => ServerSentEvent[] {
  let buffer = "";
  let event = "";
  let data: string[] = [];

  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\r|\n/);
    // The last piece has no line end yet, unless the chunk ended exactly on one.
    buffer = lines.pop() ?? "";
    const events: ServerSentEvent[] = [];
    for (const line of lines) {
      if (line === "") {
        if (data.length > 0) events.push({ event: event || "message", data: data.join("\n") });
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return events;
  };
}
