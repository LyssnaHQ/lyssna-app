import { describe, expect, it } from "vitest";
import {
  convertToWordSync,
  displayLyrics,
  distribute,
  effectiveLineEnd,
  extractBracketBacking,
  needsWordSync,
  splitMergedWords,
  splitUnits,
} from "./word-sync";
import type { Line, Lyrics } from "./types";

const line = (text: string, start: number, end: number): Line => ({
  start_ms: start,
  end_ms: end,
  text,
  translation: "",
  romanization: "",
  words: [],
  background: false,
  opposite: false,
});
const lyrics = (...lines: Line[]): Lyrics => ({
  lines,
  source: "test",
  instrumental: false,
  synced: true,
});

describe("word sync", () => {
  it("estimates word timing for flat paragraph lyrics using track duration", () => {
    const plain = {
      ...lyrics(line("Hello there. Come back tonight! Stay with me.", 0, 0)),
      synced: false,
    };
    const converted = displayLyrics(plain, true, false, 180000);
    expect(converted.synced).toBe(true);
    expect(converted.estimated_words).toBe(true);
    expect(converted.lines.length).toBeGreaterThan(1);
    expect(converted.lines.every((item) => item.words.length > 0)).toBe(true);
    expect(converted.lines.at(-1)!.words.at(-1)!.end_ms).toBeLessThanOrEqual(
      180000,
    );
    expect(plain.synced).toBe(false);
    expect(plain.lines[0].words).toEqual([]);
  });
  it("splits time across words by letter weight", () => {
    const [converted] = convertToWordSync(
      lyrics(line("I love everything", 0, 1600)),
    ).lines;
    expect(converted.words.map((word) => word.text)).toEqual([
      "I",
      " love",
      " everything",
    ]);
    expect(converted.words[0].start_ms).toBe(0);
    expect(converted.words.at(-1)!.end_ms).toBe(1600);
    const durations = converted.words.map(
      (word) => word.end_ms - word.start_ms,
    );
    expect(durations[2]).toBeGreaterThan(durations[1]);
    expect(durations[1]).toBeGreaterThan(durations[0]);
    expect(converted.words.every((word) => word.estimated)).toBe(true);
  });

  it("recomputes static timing when track duration arrives or changes", () => {
    const plain = {
      ...lyrics(line("First line\nSecond line", 0, 0)),
      synced: false,
    };
    expect(displayLyrics(plain, true)).toBe(plain);
    expect(displayLyrics(plain, false, false, 180000)).toBe(plain);
    const short = displayLyrics(plain, true, false, 90000);
    const long = displayLyrics(plain, true, false, 180000);
    expect(short.lines.at(-1)!.end_ms).toBeLessThan(long.lines.at(-1)!.end_ms);
    expect(long).toBe(displayLyrics(plain, true, false, 180000));
    expect(long.lines.map((item) => item.text)).toEqual([
      "First line",
      "Second line",
    ]);
  });

  it("breaks an unpunctuated paragraph into timed phrases without dropping words", () => {
    const text = Array.from({ length: 31 }, (_, index) => `word${index}`).join(
      " ",
    );
    const plain = { ...lyrics(line(text, 0, 0)), synced: false };
    const converted = displayLyrics(plain, true, false, 180000);
    expect(converted.lines).toHaveLength(4);
    expect(converted.lines.map((item) => item.text).join(" ")).toBe(text);
    const words = converted.lines.flatMap((item) => item.words);
    expect(words).toHaveLength(31);
    expect(
      words.every(
        (word, index) =>
          word.start_ms >= (words[index - 1]?.end_ms ?? 0) &&
          word.end_ms >= word.start_ms &&
          word.end_ms <= 180000,
      ),
    ).toBe(true);
  });

  it("leaves instrumentals, blank lyrics and invalid durations unchanged", () => {
    const plain = { ...lyrics(line("Hello there", 0, 0)), synced: false };
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(displayLyrics(plain, true, false, duration)).toBe(plain);
    }
    const instrumental = { ...plain, instrumental: true };
    expect(displayLyrics(instrumental, true, false, 180000)).toBe(instrumental);
    const blank = { ...plain, lines: [line("\n  ", 0, 0)] };
    expect(displayLyrics(blank, true, false, 180000)).toBe(blank);
  });

  it("makes bracketed parts background vocals", () => {
    const converted = convertToWordSync(
      lyrics(
        line("Hold on (hold on)", 1000, 3000),
        line("(say it)", 3000, 3500),
      ),
    );
    expect(converted.lines.map((item) => [item.text, item.background])).toEqual(
      [
        ["Hold on", false],
        ["Hold on", true],
        ["Say it", true],
      ],
    );
    expect(converted.estimated_words).toBe(true);
  });

  it("trims a line that runs into the next far past its words", () => {
    const lines = [line("Go", 0, 9000), line("Next line", 9000, 10000)];
    expect(effectiveLineEnd(lines, 0)).toBeLessThan(2000);
    // A real gap before the next line is kept as authored.
    const gapped = [line("Go", 0, 9000), line("Next", 9500, 10000)];
    expect(effectiveLineEnd(gapped, 0)).toBe(9000);
  });

  it("keeps hyphen parts joined and splits connected CJK text", () => {
    expect(splitUnits("na-na-na")).toEqual([
      { text: "na-", partOfWord: true },
      { text: "na-", partOfWord: true },
      { text: "na", partOfWord: false },
    ]);
    expect(splitUnits("私の証").length).toBeGreaterThan(1);
  });

  it("only converts line-synced lyrics and caches the result", () => {
    const worded = lyrics({
      ...line("Hi", 0, 500),
      words: [{ text: "Hi", start_ms: 0, end_ms: 500 }],
    });
    expect(needsWordSync(worded)).toBe(false);
    expect(displayLyrics(worded, true)).toBe(worded);
    const plain = lyrics(line("Hello there", 0, 1000));
    expect(displayLyrics(plain, false)).toBe(plain);
    expect(displayLyrics(plain, true)).toBe(displayLyrics(plain, true));
    expect(needsWordSync({ ...plain, synced: false })).toBe(false);
  });

  it("distributes the remainder to the last part", () => {
    expect(distribute(0, 1000, [1, 1, 1]).at(-1)!.end).toBe(1000);
  });
});

describe("Apple Music merged words", () => {
  const apple = (words: Line["words"]): Lyrics => ({
    ...lyrics({
      ...line(words.map((word) => word.text).join(""), 1000, 3000),
      words,
    }),
    source: "apple_music",
  });
  const word = (text: string, start_ms: number, end_ms: number) => ({
    text,
    start_ms,
    end_ms,
  });

  it("splits a syllable holding several words by letter weight", () => {
    const result = splitMergedWords(
      apple([word("Hey", 1000, 1400), word(" I want you", 1400, 2400)]),
    );
    const words = result.lines[0].words;
    expect(words.map((item) => item.text)).toEqual([
      "Hey",
      " I",
      " want",
      " you",
    ]);
    // 1 + 4 + 3 letters share 1000 ms.
    expect(words.slice(1).map((item) => [item.start_ms, item.end_ms])).toEqual([
      [1400, 1525],
      [1525, 2025],
      [2025, 2400],
    ]);
    expect(words[1].estimated).toBe(true);
    expect(words[0].estimated).toBeUndefined();
    expect(result.split_words).toBe(true);
  });

  it("keeps hyphen joins, trailing spaces and separate syllables", () => {
    const result = splitMergedWords(
      apple([
        word("well-known ", 1000, 2000),
        word("lo", 2000, 2200),
        word("ver", 2200, 2400),
      ]),
    );
    expect(result.lines[0].words.map((item) => item.text)).toEqual([
      "well-",
      "known ",
      "lo",
      "ver",
    ]);
  });

  it("leaves other sources and single words alone", () => {
    const other = { ...apple([word("I want", 1000, 2000)]), source: "test" };
    expect(splitMergedWords(other)).toBe(other);
    const single = apple([word("Hello", 1000, 2000)]);
    expect(splitMergedWords(single)).toBe(single);
  });

  it("applies only while word sync is on", () => {
    const merged = apple([word("I want", 1000, 2000)]);
    expect(displayLyrics(merged, false)).toBe(merged);
    expect(displayLyrics(merged, true).lines[0].words).toHaveLength(2);
  });
describe("bracketed backing vocals", () => {
  const texts = (result: Lyrics) =>
    result.lines.map((item) => [item.text, item.background]);
  it("turns bracketed parts of an estimated line into background vocals", () => {
    const result = convertToWordSync(
      lyrics(line("I go (yeah) home", 0, 3000)),
    );
    expect(texts(result)).toEqual([
      ["I go home", false],
      ["Yeah", true],
    ]);
    const [lead, backing] = result.lines;
    expect(lead.words.map((word) => word.text)).toEqual(["I", " go", " home"]);
    expect(backing.start_ms).toBeGreaterThan(lead.start_ms);
    expect(backing.end_ms).toBeLessThan(lead.end_ms);
    expect(backing.words.every((word) => word.estimated)).toBe(true);
  });
  it("hangs a bracket-only line on the line before it", () => {
    const result = convertToWordSync(
      lyrics(
        line("Hello there", 0, 2000),
        line("(oh no)", 2000, 3000),
        line("Come back", 3000, 4000),
      ),
    );
    expect(texts(result)).toEqual([
      ["Hello there", false],
      ["Oh no", true],
      ["Come back", false],
    ]);
  });
  it("keeps a bracket-only line on its own when it stands apart", () => {
    const result = convertToWordSync(
      lyrics(line("(intro)", 0, 1000), line("Hello", 3000, 4000)),
    );
    expect(texts(result)).toEqual([
      ["Intro", false],
      ["Hello", false],
    ]);
  });
  it("splits bracketed words out of word-timed lines, keeping their timing", () => {
    const word = (text: string, start: number, end: number) => ({
      text,
      start_ms: start,
      end_ms: end,
    });
    const timed = {
      ...lyrics(
        { ...line("I go (yeah yeah)", 0, 2000), words: [word("I", 0, 400), word(" go", 400, 800), word(" (yeah", 800, 1400), word(" yeah)", 1400, 2000)] },
        { ...line("(Waking up)", 2500, 3000), words: [word("(Waking", 2500, 2800), word(" up)", 2800, 3000)] },
        { ...line("Go", 3000, 3500), words: [word("Go", 3000, 3500)] },
      ),
      source: "apple_music",
    };
    const result = extractBracketBacking(timed);
    expect(texts(result)).toEqual([
      ["I go", false],
      ["Yeah yeah", true],
      ["Go", false],
      ["Waking up", true],
    ]);
    expect(result.lines[0].end_ms).toBe(800);
    expect(result.lines[1].words.map((item) => [item.text, item.start_ms])).toEqual([
      ["Yeah", 800],
      [" yeah", 1400],
    ]);
    expect(result.lines[3].start_ms).toBe(2500);
    // Other sources keep their brackets.
    const other = { ...timed, source: "lyssna" };
    expect(extractBracketBacking(other)).toBe(other);
    expect(displayLyrics(timed, true).lines.map((item) => item.text)).toEqual([
      "I go",
      "Yeah yeah",
      "Go",
      "Waking up",
    ]);
  });
});
});
