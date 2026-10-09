import { z } from "zod";
import { analysisProgressSchema, analysisResultSchema } from "../../shared/schemas";
import { createSseParser } from "../../shared/sse";
import type { AnalysisProgress, AnalysisResult } from "./types";

const errorEventSchema = z.object({ message: z.string() });

const CLOSED_EARLY_MESSAGE =
  "The connection to the server closed before the analysis finished. The server keeps fetching in the background, so trying again picks up from the cache.";

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

// Reads /api/analyze's event stream: hands each `progress` snapshot to onProgress and
// resolves with the `result` event, or rejects with the `error` event's message. A stream
// that ends without either rejects, since the analysis did not finish.
export async function readAnalysisStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  const parse = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true keeps a character split across chunks for the next one.
      for (const { event, data } of parse(decoder.decode(value, { stream: true }))) {
        const payload = parseJson(data);
        switch (event) {
          case "progress": {
            // A snapshot this client cannot read is skipped; the next one may be fine.
            const progress = analysisProgressSchema.safeParse(payload);
            if (progress.success) onProgress(progress.data);
            break;
          }
          case "result": {
            const result = analysisResultSchema.safeParse(payload);
            if (!result.success) throw new Error("Unexpected response format from server");
            return result.data;
          }
          case "error": {
            const error = errorEventSchema.safeParse(payload);
            throw new Error(error.success ? error.data.message : "The analysis failed");
          }
          default:
            break;
        }
      }
    }
  } finally {
    // Stops reading once the result is in, or the stream failed.
    reader.cancel().catch(() => {});
  }
  throw new Error(CLOSED_EARLY_MESSAGE);
}
