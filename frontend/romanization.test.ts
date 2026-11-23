import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./bridge", () => ({ rpc }));

import { romanizeLyrics, withReadings } from "./romanization";
import { displayLyrics } from "./word-sync";
import type { Lyrics } from "./types";

function sample(text: string, romanization = ""): Lyrics {
  return {
    source: "test",
    synced: true,
    instrumental: false,
    lines: [
      {
        text,
        romanization,
        translation: "Translation",
        start_ms: 1000,
        end_ms: 3000,
        words: [{ text, start_ms: 1000, end_ms: 3000, sung_by: "second" }],
        background: false,
        opposite: true,
      },
    ],
  };
}

const reading = (text: string, words = [text], estimated = false) => [
  {
    text,
    words: words.map((word, index) => ({
      text: word,
      start_ms: 1000 + index * 1000,
      end_ms: 2000 + index * 1000,
      from: estimated ? null : index,
      estimated,
    })),
  },
];

beforeEach(() => rpc.mockReset());

/** Lyrics as shown once romanization has converted them. */
async function shown(source: Lyrics, wordSync = false) {
  displayLyrics(source, wordSync, true);
  await vi.waitFor(() => {
    const display = displayLyrics(source, wordSync, true);
    if (display === displayLyrics(source, wordSync, false))
      throw new Error("not converted yet");
  });
  return displayLyrics(source, wordSync, true);
}

it("sends each line's text, reading and word timing to the app", async () => {
  rpc.mockResolvedValue([null]);
  const source = sample("Hello");
  expect(await romanizeLyrics(source, { romajiAsWritten: false })).toBe(source);
  expect(rpc).toHaveBeenCalledWith("romanize_lyrics", {
    lines: [
      {
        text: "Hello",
        romanization: "",
        words: [{ text: "Hello", start_ms: 1000, end_ms: 3000 }],
      },
    ],
    options: { romaji_as_written: false },
  });
});

it("replaces lyric text without mutating the original, keeping word details", async () => {
  rpc.mockResolvedValue(reading("Tokyo"));
  const source = sample("東京", "Tokyo");
  const original = structuredClone(source);
  const display = await shown(source);
  const line = display.lines[0];
  expect(line.text).toBe("Tokyo");
  expect(line.romanization).toBe("");
  expect(line.words[0]).toEqual({
    text: "Tokyo",
    start_ms: 1000,
    end_ms: 2000,
    sung_by: "second",
  });
  expect(line.translation).toBe("Translation");
  expect(line.opposite).toBe(true);
  expect(source).toEqual(original);
  expect(displayLyrics(source, false, false)).toBe(source);
  expect(displayLyrics(source, false, true)).toBe(display);
});

it("marks estimated word timing", async () => {
  rpc.mockResolvedValue(reading("hello friend", ["hello", " friend"], true));
  const display = await romanizeLyrics(sample("안녕하세요", "hello friend"));
  expect(display.estimated_words).toBe(true);
  expect(display.lines[0].words.every((word) => word.estimated)).toBe(true);
  expect(display.lines[0].words[0].sung_by).toBeUndefined();
});

it("romanizes line-synced text before estimating words for Space Gravity", async () => {
  rpc.mockResolvedValue([{ text: "annyeonghaseyo", words: [] }]);
  const source = sample("안녕하세요", "annyeonghaseyo");
  source.lines[0].words = [];
  const display = await shown(source, true);
  expect(display.lines[0].text).toBe("annyeonghaseyo");
  expect(display.lines[0].words.length).toBeGreaterThan(0);
  expect(display.estimated_words).toBe(true);
});

it("adds no reading that only repeats a Latin line", () => {
  const lyrics = sample("Walking home along the river, late at night");
  const same = sample("walking home along the river late at night ");
  expect(withReadings(lyrics, same).lines[0].reading).toBeUndefined();
  const accented = sample("Café");
  expect(
    withReadings(accented, sample("Cafe")).lines[0].reading,
  ).toBeUndefined();
  const korean = sample("사랑해");
  expect(withReadings(korean, sample("saranghae")).lines[0].reading?.text).toBe(
    "saranghae",
  );
});
