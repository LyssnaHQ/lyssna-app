import { describe, expect, it } from "vitest";
import {
  romajiSyllables,
  readingsFrom,
  splitBrackets,
  type CreatorLine,
} from "./ttml-creator-model";
import type { Lyrics } from "./types";

const lyricsOf = (lines: string[][]): Lyrics => ({
  source: "x",
  instrumental: false,
  synced: true,
  lines: lines.map((words) => ({
    start_ms: 0,
    end_ms: 0,
    text: words.join(""),
    translation: "",
    romanization: "",
    background: false,
    opposite: false,
    words: words.map((text) => ({ start_ms: 0, end_ms: 0, text })),
  })),
});

describe("readingsFrom", () => {
  it("takes the whole Genius word at a line's edges", () => {
    const request = lyricsOf([["「零」", "戻", "り", "ま", "た", "再", "生"]]);
    const ours = lyricsOf([["\"Rei\"", " modo", "ri", " ma", "ta", " sai", "sei"]]);
    const { lyrics } = readingsFrom(
      request,
      ours,
      '"Zero" modori mata saiseiyo',
    );
    expect(lyrics.lines[0].words.map((word) => word.text)).toEqual([
      '"Zero"',
      " modo",
      "ri",
      " ma",
      "ta",
      " sai",
      "seiyo",
    ]);
  });


  it("spreads a romanized line over the syllables", () => {
    const request = lyricsOf([
      ["濁", "る", "呼", "吸", "の", "奥", "で"],
      ["金", "輪", "際", " big", " juicer,"],
      ["Hello", " there"],
    ]);
    const ours = lyricsOf([
      ["Nigo", "ru", " ko", "kyuu", " no", " oku", " de"],
      ["Kon", "rin", "zai", " big", " juicer,"],
      ["Hello", " there"],
    ]);
    const genius =
      "[Verse 2]\nNigoru kokyū no oku de\n(Konrinzai) Big juicer, and I'm ready to crush\nHello there";
    const { lyrics, matched } = readingsFrom(request, ours, genius);
    expect(matched).toBe(2);
    expect(
      lyrics.lines.map((line) => line.words.map((word) => word.text)),
    ).toEqual([
      ["Nigo", "ru", " ko", "kyū", " no", " oku", " de"],
      ["Kon", "rin", "zai", " big", " juicer,"],
      ["Hello", " there"],
    ]);
  });
});

const lineOf = (words: string[]): CreatorLine => ({
  units: words.map((text, index) => ({
    text,
    joined: false,
    start: index * 100,
    end: index * 100 + 100,
  })),
  background: false,
  opposite: false,
});

describe("splitBrackets", () => {
  it("moves bracketed runs to background lines with their timings", () => {
    const lines = splitBrackets(
      lineOf(["Let", "magic", "(oh-", "oh)", "stitch", "(yeah!)"]),
    );
    expect(
      lines.map((line) => [
        line.background,
        line.units.map((unit) => unit.text),
      ]),
    ).toEqual([
      [false, ["Let", "magic", "stitch"]],
      [true, ["Oh-", "oh"]],
      [true, ["Yeah!"]],
    ]);
    expect(lines[1].units[0].start).toBe(200);
  });

  it("keeps brackets that open the line, and unbalanced ones", () => {
    const opening = lineOf(["(Konrinzai)", "Big", "juicer"]);
    expect(splitBrackets(opening)).toEqual([opening]);
    const open = lineOf(["Hey", "(la", "la"]);
    expect(splitBrackets(open)).toEqual([open]);
  });
});

describe("romajiSyllables", () => {
  const split = (reading: string) => {
    const cuts = romajiSyllables(reading);
    return Array.from(reading)
      .map((char, index) => (cuts.includes(index) ? `|${char}` : char))
      .join("");
  };
  it("cuts a reading where each syllable starts", () => {
    expect(split("inochi")).toBe("i|no|chi");
    expect(split("Konrinzai")).toBe("Kon|rin|zai");
    expect(split("chotto")).toBe("chot|to");
    expect(split("kyuu")).toBe("kyuu");
    expect(split("Zero")).toBe("Ze|ro");
  });
});
