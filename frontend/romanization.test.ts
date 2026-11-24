import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ rpc: vi.fn() }));

import { withReadings } from "./romanization";
import type { Line, Lyrics } from "./types";

const line = (text: string): Line => ({
  text,
  start_ms: 0,
  end_ms: 1000,
  translation: "",
  romanization: "",
  background: false,
  opposite: false,
  words: [],
});
const lyrics = (...texts: string[]): Lyrics =>
  ({
    source: "Test",
    synced: true,
    instrumental: false,
    lines: texts.map(line),
  }) as Lyrics;

describe("withReadings", () => {
  it("adds no reading to a Latin line with a look-alike letter", () => {
    const written = lyrics("Through fire and rain, his hеart set ablaze");
    const read = lyrics("Through fire and rain, his heart set ablaze");
    expect(withReadings(written, read).lines[0].reading).toBeUndefined();
  });
  it("keeps readings for lines in other scripts", () => {
    const written = lyrics("안녕하세요", "Hello 東京");
    const read = lyrics("Annyeonghaseyo", "Hello Toukyou");
    const shown = withReadings(written, read).lines;
    expect(shown[0].reading?.text).toBe("Annyeonghaseyo");
    expect(shown[1].reading?.text).toBe("Hello Toukyou");
  });
});
