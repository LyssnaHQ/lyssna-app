import { describe, expect, it, vi } from "vitest";

// The app's Rust core romanizes; here each non-ASCII word reads as a
// placeholder so the creator's handling of readings is what gets tested.
vi.mock("./bridge", () => ({
  rpc: async (
    _command: string,
    { lines }: { lines: { words: { text: string }[] }[] },
  ) =>
    lines.map(({ words }) => {
      const read = words.map((word, index) =>
        /^[ -~]*$/.test(word.text)
          ? word.text
          : `${index ? " " : ""}roman${index}`,
      );
      return read.every((text, index) => text === words[index].text)
        ? null
        : {
            text: read.join(""),
            words: read.map((text, from) => ({
              text,
              start_ms: 0,
              end_ms: 0,
              from,
              estimated: false,
            })),
          };
    }),
}));
import {
  geniusBackgrounds,
  breakLine,
  splitBrackets,
  timingCursor,
  sameReadings,
  splitReadings,
  geniusChanges,
  geniusLeads,
  geniusEchoes,
  geniusMissing,
  fixFromGenius,
  setSection,
  setSectionSinger,
  sectionStart,
  addMissing,
  clearLines,
  removeLines,
  setLineFlag,
  shiftLines,
  defaultMetadata,
  withSongwriters,
  metaProblem,
  duplicateLine,
  editUnit,
  replaceMatching,
  moveEdge,
  panUnit,
  appendWords,
  joinHyphenated,
  dropTrailingSpace,
  formatTime,
  fromLyrics,
  insertLines,
  keepTimings,
  markEnd,
  markNext,
  markStart,
  moveLine,
  moveSpace,
  moveWord,
  moveWords,
  removeSpaces,
  insertBlankLine,
  deletePicked,
  singingAt,
  nextCursor,
  parseText,
  problems,
  applyRomanized,
  romanizeRequest,
  setLineText,
  setUnitRoman,
  hasJapanese,
  splitAllWords,
  splitJapanese,
  splitMatching,
  splitUnit,
  toLyrics,
  toText,
  toTtml,
  toggleJoin,
  sectionName,
  applySections,
  canSeed,
  romanPieces,
} from "./ttml-creator-model";
import type { CreatorLine, Cursor } from "./ttml-creator-model";
import { romanizeLyrics } from "./romanization";
import type { Lyrics } from "./types";

const meta = { name: "Song & <Co>", artists: ["A", "B"], spotifyId: "abc" };

function timeAll(text: string) {
  let lines = markStart(parseText(text), { line: 0, unit: 0 }, 1000);
  let cursor = { line: 0, unit: 0 };
  let time = 1400;
  while (nextCursor(lines, cursor)) {
    ({ lines, cursor } = markNext(lines, cursor, time));
    time += 400;
  }
  return markEnd(lines, cursor, time).lines;
}

describe("TTML Creator model", () => {
  it("reads syllables, background vocals and the second singer from text", () => {
    const lines = parseText("beau|ti|ful day\n(oh yeah)\nv2: other  side\n\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].units.map((unit) => [unit.text, unit.joined])).toEqual([
      ["beau", false],
      ["ti", true],
      ["ful", true],
      ["day", false],
    ]);
    expect(lines[1]).toMatchObject({ background: true, opposite: false });
    expect(lines[2]).toMatchObject({ background: false, opposite: true });
    expect(parseText(toText(lines))).toEqual(lines);
  });

  it("taps start, chain and end words in order", () => {
    let lines = parseText("one two\nthree");
    lines = markStart(lines, { line: 0, unit: 0 }, 100);
    let step = markNext(lines, { line: 0, unit: 0 }, 300);
    expect(step.cursor).toEqual({ line: 0, unit: 1 });
    expect(step.lines[0].units[1].start).toBe(300);
    step = markEnd(step.lines, step.cursor, 500);
    expect(step.cursor).toEqual({ line: 1, unit: 0 });
    expect(step.lines[0].units.map((unit) => [unit.start, unit.end])).toEqual([
      [100, 300],
      [300, 500],
    ]);
    expect(step.lines[1].units[0].start).toBeUndefined();
  });

  it("a fresh start drops an end that would come before it", () => {
    let lines = markEnd(parseText("word"), { line: 0, unit: 0 }, 900).lines;
    lines = markStart(lines, { line: 0, unit: 0 }, 1200);
    expect(lines[0].units[0]).toMatchObject({ start: 1200, end: undefined });
  });

  it("reads [Section] lines as optional section names, never lyrics", () => {
    const lines = parseText(
      "[Verse 2: Someone]\none\n[]\ntwo\n[Chorus]\n(oh)\nthree",
    );
    expect(
      lines.map((line) => line.units.map((unit) => unit.text).join(" ")),
    ).toEqual(["one", "two", "oh", "three"]);
    expect(lines.map((line) => line.part)).toEqual([
      "Verse",
      undefined,
      "Chorus",
      undefined,
    ]);
    expect(sectionName("[]")).toBeUndefined();
    expect(toText(lines)).toBe(
      "[Verse - Someone]\none\ntwo\n[Chorus]\n(oh)\nthree",
    );
  });

  it("exports each section as its own tagged div, untagged songs as one", () => {
    const tagged = toTtml(timeAll("[Verse]\none\ntwo\n[Chorus]\nthree"), meta);
    expect(tagged.match(/<div [^>]*>/g)).toHaveLength(2);
    expect(tagged).toContain('itunes:songPart="Verse"');
    expect(tagged).toContain('itunes:songPart="Chorus"');
    expect(tagged).not.toContain("[Chorus]");
    const plain = toTtml(timeAll("one\ntwo"), meta);
    expect(plain.match(/<div [^>]*>/g)).toHaveLength(1);
    expect(plain).not.toContain("songPart");
  });

  it("keeps who sings a section and writes it so other players ignore it", () => {
    const lines = parseText(
      "[Verse 1: Nicki Minaj]\none\ntwo\n[Chorus - Drake & Nicki]\nthree",
    );
    expect(lines.map((line) => line.singer)).toEqual([
      "Nicki Minaj",
      undefined,
      "Drake & Nicki",
    ]);
    expect(toText(lines)).toBe(
      "[Verse - Nicki Minaj]\none\ntwo\n[Chorus - Drake & Nicki]\nthree",
    );
    const ttml = toTtml(timeAll(toText(lines)), meta);
    expect(ttml).toContain(
      'itunes:songPart="Verse" lyssna:singer="Nicki Minaj"',
    );
    expect(ttml).toContain('lyssna:singer="Drake &amp; Nicki"');
    expect(ttml).toContain('xmlns:lyssna="https://lyssna.org/ns/ttml"');
    expect(toTtml(timeAll("[Chorus]\nthree"), meta)).not.toContain("lyssna");
  });

  it("never marks sung lines Instrumental, which Spicy Lyrics would drop", () => {
    const ttml = toTtml(timeAll("[Instrumental]\nhum hmm\n[Chorus]\nla"), meta);
    expect(ttml).not.toContain("Instrumental");
    expect(ttml).toContain('itunes:songPart="Chorus"');
    expect(ttml.match(/<p /g)).toHaveLength(2);
  });

  it("takes sections from Genius onto synced lines and keeps timings", () => {
    const lines = timeAll("Hello there\nGeneral Kenobi\nYou are bold");
    const tagged = applySections(
      lines,
      "[Intro]\nHello there!\n[Verse 1]\nSomething else\nGeneral Kenobi\n[Chorus]\nYou are bold",
    )!;
    expect(tagged.map((line) => line.part)).toEqual([
      "Intro",
      "Verse",
      "Chorus",
    ]);
    expect(tagged[1].units[0].start).toBe(lines[1].units[0].start);
    expect(applySections(lines, "[Chorus]\nnothing alike")).toBeUndefined();
  });

  it("lands a tap on the earlier line still being timed", () => {
    const lines = parseText("die and live it\nrip the fabric");
    lines[0].units[0] = { ...lines[0].units[0], start: 1000, end: 1200 };
    lines[0].units[2] = { ...lines[0].units[2], start: 1400 };
    lines[1].units[0] = { ...lines[1].units[0], start: 3000 };
    lines[1].units[2] = { ...lines[1].units[2], end: 4000 };
    const away = { line: 1, unit: 2 };
    expect(timingCursor(lines, away, 1600)).toEqual({ line: 0, unit: 2 });
    expect(timingCursor(lines, away, 3500)).toBe(away);
    lines[0].units[2] = { ...lines[0].units[2], end: 1600 };
    expect(timingCursor(lines, away, 1700)).toEqual({ line: 0, unit: 3 });
  });

  it("splits every word with the same reading alike", () => {
    let lines = parseText("命 光\n命");
    lines = setUnitRoman(lines, { line: 0, unit: 0 }, "Inochi");
    lines = setUnitRoman(lines, { line: 1, unit: 0 }, "inochi");
    lines = setUnitRoman(lines, { line: 0, unit: 1 }, "hikari");
    expect(sameReadings(lines, { line: 0, unit: 0 })).toBe(1);
    const split = splitReadings(lines, "i|no|chi");
    expect(
      split.flatMap((line) => line.units.map((unit) => unit.roman)),
    ).toEqual(["I|no|chi", "hikari", "i|no|chi"]);
  });

  it("drops the comma left at the end of a line split in two", () => {
    const lines = parseText("Die and I reboot, everything I do, for you");
    const split = breakLine(lines, { line: 0, unit: 4 }, false);
    expect(split.map((line) => line.units.map((unit) => unit.text))).toEqual([
      ["Die", "and", "I", "reboot"],
      ["Everything", "I", "do,", "for", "you"],
    ]);
  });

  it("sets who sings from Genius's italic and bold", () => {
    const lines = timeAll(
      "Transforming the pain\nZero modori\nI'm lost unmei mawa re\nYuukyuu no",
    );
    const tagged = applySections(
      lines,
      "[Verse 1: Ashnikko, \uE000Konomi\uE001]\nTransforming the pain\n\uE000Zero modori\uE001\nI'm lost \uE000unmei mawa\nre\uE001\n\uE000Yuukyuu no\uE001",
    )!;
    expect(tagged[0].singer).toBe("Ashnikko, Konomi");
    expect(tagged.map((line) => line.sungBy)).toEqual([
      undefined,
      "Konomi",
      undefined,
      "Konomi",
    ]);
    expect(tagged[2].units.map((unit) => unit.sungBy)).toEqual([
      undefined,
      undefined,
      "Konomi",
      "Konomi",
      "Konomi",
    ]);
  });

  it("moves what Genius brackets to a backing line, with its own voice", () => {
    const lines = timeAll("Konrinzai big juicer ready to crush");
    const tagged = applySections(
      lines,
      "[Chorus: Konomi, \uE000Ashnikko\uE001]\n(Konrinzai) \uE000Big juicer ready to crush\uE001",
    )!;
    expect(
      tagged.map((line) => [
        line.units.map((unit) => unit.text).join(" "),
        line.background,
        line.sungBy,
      ]),
    ).toEqual([
      ["Big juicer ready to crush", false, "Ashnikko"],
      ["Konrinzai", true, undefined],
    ]);
    expect(tagged[0].part).toBe("Chorus");
    expect(tagged[0].units.every((unit) => !unit.sungBy)).toBe(true);
  });

  it("splits Genius brackets at both ends of a line apart from its lead", () => {
    const lines = timeAll("あの星が tell me where to go\n(Run it)");
    const tagged = applySections(
      lines,
      "[Chorus: Aiko, \uE000Mira\uE001]\n(あの星が) \uE000Tell me where to go\uE001 (\uE000Run it\uE001)",
    )!;
    const text = (line: CreatorLine) =>
      line.units
        .map((unit, index) => (index && !unit.joined ? " " : "") + unit.text)
        .join("");
    expect(
      tagged.map((line) => [text(line), line.background, line.sungBy]),
    ).toEqual([
      ["Tell me where to go", false, "Mira"],
      ["あの星が", true, undefined],
      ["Run it", true, "Mira"],
    ]);
  });

  it("capitalises a lead line that Genius starts with a capital", () => {
    const lines = timeAll("you're gonna be fine\nwe stay low");
    const tagged = applySections(
      lines,
      "[Verse: Aiko]\nYou're gonna be fine, we stay low",
    )!;
    expect(tagged.map((line) => line.units[0].text)).toEqual(["You're", "we"]);
  });

  it("capitalises what leads a line once its opening bracket moves out", () => {
    const [lead, echo] = splitBrackets(parseText("(Watch it) you're next")[0]);
    expect(lead.units.map((unit) => unit.text)).toEqual(["You're", "next"]);
    expect(echo.units.map((unit) => unit.text)).toEqual(["Watch", "it"]);
  });

  it("keeps a draft line that is all one Genius bracket as a lead", () => {
    const lines = timeAll("Ah, oh, whoa\nSomething old\nMake it new");
    const tagged = applySections(
      lines,
      "[Chorus: Aiko & Mira]\nAh (Something old), oh, whoa (Make it new)",
    )!;
    expect(tagged.map((line) => line.background)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("starts a section at lines the draft sings from its bracketed words", () => {
    const lines = timeAll("We fight on\nSomething old\nMake it new\nRise up high");
    const tagged = applySections(
      lines,
      "[Verse: Aiko]\nWe fight on\n[Pre-Chorus: Aiko, Mira]\nAh (Something old), oh (Make it new)\nRise up high",
    )!;
    expect(tagged.map((line) => line.part)).toEqual([
      "Verse",
      "Pre-Chorus",
      undefined,
      undefined,
    ]);
    expect(tagged.map((line) => line.sungBy)).toEqual([
      undefined,
      "Mira",
      "Mira",
      undefined,
    ]);
  });

  it("points out background lines Genius sings as lead", () => {
    const lines = timeAll("Break it, save it\n囚われ\nYeah!\nStay here").map(
      (line, index) => ({ ...line, background: index < 3 }),
    );
    expect(
      geniusLeads(lines, "[Chorus]\n(Break it, save it) 囚われ (Yeah)\nStay here"),
    ).toEqual([1]);
  });

  it("drops a comma Sections from Genius finds at the end of a line", () => {
    const lines = timeAll("I'm lost, 運命廻れ、\n悠久");
    const tagged = applySections(
      lines,
      "[Verse: Aiko, Mira]\nI'm lost, 運命廻れ\n悠久",
    )!;
    expect(tagged[0].units.at(-1)!.text).toBe("れ");
    expect(geniusChanges(lines, tagged).commas).toEqual([0]);
  });

  it("points out where the draft lacks characters Genius has", () => {
    const lines = timeAll("Start here\n悠久のパレー\nGo on");
    const genius = "[Verse]\nStart here\n悠久のパレード\nGo on";
    const tagged = applySections(lines, genius)!;
    expect(geniusChanges(lines, tagged, genius).differs).toEqual([
      { line: 1, text: "悠 久 の パ レー", genius: "悠久のパレード", fixable: true },
    ]);
    const fixed = fixFromGenius(tagged[1], "悠久のパレード")!;
    expect(fixed.units.map((unit) => unit.text).join("")).toBe("悠久のパレード");
    expect(fixed.units.at(-1)!.start).toBe(tagged[1].units.at(-1)!.start);
  });

  it("swaps whole words for Genius's but leaves split words alone", () => {
    const line = parseText("Break my neck, in-can-ta-tion, chess board")[0];
    const units = line.units.map((unit, index) => ({
      ...unit,
      start: index * 100,
      joined: index === 4 || index === 5,
    }));
    const fixed = fixFromGenius(
      { ...line, units },
      "Break neck incantation, chessboard, I",
    );
    expect(fixed).toBeUndefined();
    const same = fixFromGenius(
      { ...line, units: units.slice(0, 2) },
      "Brake my",
    )!;
    expect(same.units.map((unit) => unit.text)).toEqual(["Brake", "my"]);
    expect(same.units[0].start).toBe(0);
    const split = parseText("Wa king some")[0].units.map((unit, index) => ({
      ...unit,
      joined: index === 1,
    }));
    const kept = fixFromGenius(
      { ...line, units: split },
      "Walking sum",
    )!;
    expect(kept.units.map((unit) => unit.text)).toEqual(["Wa", "king", "sum"]);
  });

  it("starts, renames and removes sections, keeping their singers", () => {
    let lines = timeAll("one\ntwo\nthree\nfour");
    lines = lines.map((line, index) =>
      index === 0
        ? { ...line, part: "Chorus", singer: "Aiko, Mira, Mira & Aiko" }
        : line,
    );
    lines = setSection(lines, 2, "Bridge");
    expect([lines[2].part, lines[2].singer]).toEqual([
      "Bridge",
      "Aiko, Mira, Mira & Aiko",
    ]);
    expect(sectionStart(lines, 3)).toBe(2);
    lines = setSection(lines, 0, "Verse");
    expect([lines[0].part, lines[0].singer]).toEqual([
      "Verse",
      "Aiko, Mira, Mira & Aiko",
    ]);
    lines = setSectionSinger(lines, 2, " Mira ");
    expect(lines[2].singer).toBe("Mira");
    lines = setSection(lines, 2);
    expect([lines[2].part, lines[2].singer]).toEqual([undefined, undefined]);
    expect(sectionStart(lines, 3)).toBe(0);
  });

  it("leaves out of the review what the draft already had", () => {
    const lines = timeAll("Start here\nGo on\nGo on");
    const genius = "[Verse: Aiko & Mira]\nStart here\n[Chorus: Mira]\nGo on\nGo on";
    const once = applySections(lines, genius)!;
    expect(geniusChanges(lines, once).sections.length).toBe(2);
    const again = applySections(once, genius)!;
    const changes = geniusChanges(once, again);
    expect(changes.sections).toEqual([]);
    expect(changes.singers).toEqual([]);
    expect(changes.backgrounds).toEqual([]);
    expect(changes.earlier.map((each) => each.label)).toEqual([
      "Verse",
      "Chorus",
    ]);
  });

  it("fixes Genius's spellings but counts numbers either way the same", () => {
    const lines = timeAll("Start here\nWow, oh, whoa\n1, 2, 3, 4\n影 Whoa");
    const genius =
      "[Outro]\nStart here\nWow, oh, woah\nOne, two, three, four\n影 woah";
    const tagged = applySections(lines, genius)!;
    const { differs } = geniusChanges(lines, tagged, genius);
    expect(differs.map((each) => [each.line, each.fixable])).toEqual([
      [1, true],
      [3, true],
    ]);
    expect(
      fixFromGenius(tagged[1], "Wow, oh, woah")!.units.map((unit) => unit.text),
    ).toEqual(["Wow,", "oh,", "woah"]);
    expect(
      fixFromGenius(tagged[3], "影 woah")!.units.map((unit) => unit.text),
    ).toEqual(["影", "Woah"]);
  });

  it("points out lead lines Genius has all in brackets", () => {
    const lines = timeAll(
      "Giga yeah\nAh\nSomething old\nOh whoa\nMake it new",
    ).map((line, index) => ({ ...line, background: index === 3 }));
    const genius =
      "[Intro]\n(Giga yeah)\n[Pre-Chorus]\nAh (Something old), oh, whoa (Make it new)";
    expect(geniusEchoes(lines, genius)).toEqual([2, 4]);
    expect(geniusLeads(lines, genius)).toEqual([3]);
  });

  it("finds and adds what Genius sings that the draft leaves out", () => {
    const lines = timeAll("Start here\nWhoa oh whoa\nCheck it out");
    const genius =
      "[Outro: Aiko & Mira]\nStart here\nWhoa, oh, whoa (Hahaha)\nCheck it out";
    const tagged = applySections(lines, genius)!;
    const missing = geniusMissing(tagged, genius);
    expect(missing).toEqual([
      { after: 1, text: "Hahaha", background: true, voice: "Mira" },
    ]);
    const added = addMissing(tagged, missing);
    expect(
      added.map((line) => [
        line.units.map((unit) => unit.text).join(" "),
        line.background,
        line.sungBy,
        line.units[0].start,
      ]),
    ).toEqual([
      ["Start here", false, undefined, expect.any(Number)],
      ["Whoa oh whoa", false, undefined, expect.any(Number)],
      ["Hahaha", true, "Mira", undefined],
      ["Check it out", false, undefined, expect.any(Number)],
    ]);
    expect(geniusMissing(added, genius)).toEqual([]);
  });

  it("lists what Sections from Genius changed", () => {
    const lines = timeAll("Start here\nあの星が tell me where to go\n(Run it)");
    const tagged = applySections(
      lines,
      "[Chorus: Aiko, Mira]\nStart here\n(あの星が) Tell me where to go (Run it)",
    )!;
    expect(geniusChanges(lines, tagged, "Start here")).toEqual({
      sections: [{ line: 0, part: "Chorus" }],
      backgrounds: [{ line: 2, text: "あの星が" }],
      singers: [{ voice: "Mira", lines: [1, 3] }],
      mixed: [],
      leads: [],
      echoes: [],
      missing: [],
      commas: [],
      differs: [],
      earlier: [{ line: 3, label: "(Run it)" }],
    });
  });

  it("gives a background line back its lead when Genius brackets only part", () => {
    const lines = timeAll("Start here\nあの星が tell me where to go\nOh whoa").map(
      (line, index) => ({ ...line, background: index > 0 }),
    );
    const tagged = applySections(
      lines,
      "[Chorus: Aiko, Mira]\nStart here\n(あの星が) Tell me where to go\nOh, whoa",
    )!;
    expect(
      tagged.map((line) => [
        line.units.map((unit) => unit.text).join(" "),
        line.background,
        line.sungBy,
      ]),
    ).toEqual([
      ["Start here", false, undefined],
      ["Tell me where to go", false, "Mira"],
      ["あ の 星 が", true, undefined],
      ["Oh whoa", true, undefined],
    ]);
  });

  it("keeps the comma after a bracket mid-line on the lead", () => {
    const lines = timeAll("Ah (Something old), oh, whoa (Make it new)");
    const tagged = applySections(
      lines,
      "[Chorus: Aiko & \uE000Mira\uE001]\nAh (\uE000Something old\uE001), oh, whoa (\uE000Make it new\uE001)",
    )!;
    expect(
      tagged.map((line) => line.units.map((unit) => unit.text).join(" ")),
    ).toEqual([
      "Ah, oh, whoa",
      "Something old",
      "Make it new",
    ]);
  });

  it("matches kana one by one, however the draft spaces them", () => {
    const lines = timeAll("まだかな? Waiting in the rain").map((line) => ({
      ...line,
      units: line.units.map((unit) => ({ ...unit, joined: false })),
    }));
    const tagged = applySections(
      lines,
      "[Chorus: Aiko, \uE000Mira\uE001]\n(まだ かな？) \uE000Waiting in the rain\uE001",
    )!;
    expect(
      tagged.map((line) => [
        line.units.map((unit) => unit.text),
        line.background,
      ]),
    ).toEqual([
      [["Waiting", "in", "the", "rain"], false],
      [["ま", "だ", "か", "な?"], true],
    ]);
  });

  it("reads Genius words with Cyrillic letters swapped in", () => {
    const lines = timeAll("Face it, die and live");
    const tagged = applySections(
      lines,
      "[Chorus: Aiko, \uE000Mira\uE001, \uE002Mira & Aiko\uE003]\n\uE000Face it\uE001, \uE002diе and livе\uE003",
    )!;
    expect(tagged[0].sungBy).toBe("Mira");
    expect(tagged[0].units.map((unit) => unit.sungBy)).toEqual([
      undefined,
      undefined,
      "Mira & Aiko",
      "Mira & Aiko",
      "Mira & Aiko",
    ]);
  });

  it("leaves a lead word alone that only a stray match ties to a bracket", () => {
    const lines = timeAll("We go home tonight");
    const tagged = applySections(
      lines,
      "[Verse: Aiko, \uE000Mira\uE001]\nWe walk home tonight (go)",
    )!;
    expect(tagged).toHaveLength(1);
    expect(tagged[0].background).toBe(false);
  });

  it("reads a line opening and closing with two bracket pairs as a lead", () => {
    const [line] = parseText("(Ooh) we go (yeah)");
    expect(line.background).toBe(false);
    expect(line.units.map((unit) => unit.text)).toEqual([
      "(Ooh)",
      "we",
      "go",
      "(yeah)",
    ]);
  });

  it("gives plain lines to the first voice when the header sets it bold", () => {
    const lines = timeAll("Transforming the pain\nZero modori");
    const tagged = applySections(
      lines,
      "[Verse 1: \uE002Ashnikko\uE003, \uE000Konomi\uE001]\nTransforming the pain\n\uE000Zero modori\uE001",
    )!;
    expect(tagged.map((line) => line.sungBy)).toEqual([undefined, "Konomi"]);
  });

  it("places a Genius section of nothing but bracketed ad-libs", () => {
    const lines = timeAll("Giga, TeddyLoid\nTransforming the pain\nI'm lost");
    const tagged = applySections(
      lines,
      "[Intro]\n(Giga, TeddyLoid)\n\n[Verse 1]\nTransforming the pain\nI'm lost (oh)",
    )!;
    expect(tagged.map((line) => line.part)).toEqual([
      "Intro",
      "Verse",
      undefined,
    ]);
  });

  it("places Genius sections when Genius breaks lines elsewhere", () => {
    const lines = timeAll(
      "alpha river runs\nbravo stones under, charlie lantern\ndelta window\necho meadow foxtrot\ngolf tower",
    );
    const tagged = applySections(
      lines,
      "[Chorus]\nalpha river runs\nbravo stones\n\n[Verse 2]\ncharlie lanterns, delta window\n[Pre-Chorus]\necho meadow\nfoxtrot golf tower",
    )!;
    expect(tagged.map((line) => line.part)).toEqual([
      "Chorus",
      undefined,
      "Verse",
      "Pre-Chorus",
      undefined,
    ]);
  });

  it("editing text keeps timings of unchanged lines", () => {
    const timedLines = timeAll("keep me\nchange me");
    const edited = keepTimings(timedLines, parseText("keep me\nchanged me"));
    expect(edited[0].units[0].start).toBe(1000);
    expect(edited[1].units[0].start).toBeUndefined();
  });

  it("starts an exported line at its first exported word", () => {
    const lines = timeAll("No clubs" + String.fromCharCode(10) + "No cars");
    lines[1].units.push({ text: "", start: 0, joined: true });
    const ttml = toTtml(lines, meta);
    const second = [
      ...ttml.matchAll(/<p begin="([^"]+)"[^>]*><span begin="([^"]+)"/g),
    ][1];
    expect(second[1]).toBe(second[2]);
  });

  it("exports TTML with escaped text, word spacing and nested background", () => {
    const lines = timeAll("Rock & roll|ing\n(back)");
    expect(problems(lines)).toEqual([]);
    const ttml = toTtml(lines, meta);
    expect(ttml).toContain('itunes:timing="Word"');
    expect(ttml).toContain(
      '<amll:meta key="musicName" value="Song &amp; &lt;Co&gt;"/>',
    );
    expect(ttml).toContain('<amll:meta key="spotifyId" value="abc"/>');
    expect(ttml).toContain(
      '<span begin="00:01.000" end="00:01.400">Rock</span> <span begin="00:01.400" end="00:01.800">&amp;</span> <span begin="00:01.800" end="00:02.200">roll</span><span begin="00:02.200" end="00:02.600">ing</span>',
    );
    expect(ttml).toContain('<span ttm:role="x-bg" begin="00:02.600"');
    expect(ttml.match(/<p /g)).toHaveLength(1);
  });

  it("previews only timed words, with spaces between words", () => {
    const lines = timeAll("a b|c");
    const preview = toLyrics(lines);
    expect(preview.lines[0].words.map((word) => word.text)).toEqual([
      "a",
      " b",
      "c",
    ]);
    expect(preview.lines[0].text).toBe("a bc");
    expect(toLyrics(parseText("untimed")).lines).toEqual([]);
  });

  it("starts from shown lyrics, keeping authored word timing only", () => {
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [
        {
          start_ms: 0,
          end_ms: 900,
          text: "hello world",
          translation: "",
          romanization: "",
          background: false,
          opposite: true,
          words: [
            { start_ms: 0, end_ms: 400, text: "hel" },
            { start_ms: 400, end_ms: 500, text: "lo" },
            { start_ms: 500, end_ms: 900, text: " world" },
          ],
        },
        {
          start_ms: 900,
          end_ms: 1500,
          text: "guessed words",
          translation: "",
          romanization: "",
          background: false,
          opposite: false,
          words: [
            {
              start_ms: 900,
              end_ms: 1500,
              text: "guessed words",
              estimated: true,
            },
          ],
        },
      ],
    };
    const lines = fromLyrics(lyrics);
    expect(lines[0]).toMatchObject({ opposite: true });
    expect(
      lines[0].units.map((unit) => [unit.text, unit.joined, unit.start]),
    ).toEqual([
      ["hel", false, 0],
      ["lo", true, 400],
      ["world", false, 500],
    ]);
    expect(lines[1].units.map((unit) => [unit.start, unit.end])).toEqual([
      [900, undefined],
      [undefined, 1500],
    ]);
  });

  it("moves bracketed words of a line-timed line to a background line", () => {
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [
        {
          start_ms: 0,
          end_ms: 1000,
          text: "One, two, three (hold up)",
          translation: "",
          romanization: "",
          background: false,
          opposite: true,
          words: [],
        },
      ],
    };
    const lines = fromLyrics(lyrics);
    expect(lines.map((line) => line.units.map((unit) => unit.text))).toEqual([
      ["One,", "two,", "three"],
      ["Hold", "up"],
    ]);
    expect(lines.map((line) => [line.background, line.opposite])).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(lines[0].units[2].end).toBe(1000);
  });

  it("keeps a supplied reading per syllable", () => {
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [
        {
          start_ms: 0,
          end_ms: 1000,
          text: "未完成 命",
          translation: "",
          romanization: "mikansei inochi",
          romanization_words: [
            { start_ms: 0, end_ms: 200, text: "mi" },
            { start_ms: 200, end_ms: 500, text: "kan" },
            { start_ms: 500, end_ms: 800, text: "sei" },
            { start_ms: 800, end_ms: 850, text: " i" },
            { start_ms: 850, end_ms: 900, text: "no" },
            { start_ms: 900, end_ms: 1000, text: "chi" },
          ],
          background: false,
          opposite: false,
          words: [
            { start_ms: 0, end_ms: 200, text: "未" },
            { start_ms: 200, end_ms: 500, text: "完" },
            { start_ms: 500, end_ms: 800, text: "成" },
            { start_ms: 800, end_ms: 1000, text: " 命" },
          ],
        },
      ],
    };
    const [line] = fromLyrics(lyrics);
    expect(line.units.map((unit) => unit.roman)).toEqual([
      "mi",
      "kan",
      "sei",
      "i|no|chi",
    ]);
    expect(line.units[3].romanStarts).toEqual([850, 900]);
    expect(line.romanization).toBeUndefined();
  });

  it("times a split reading piece by piece inside its word", () => {
    let lines: CreatorLine[] = [
      {
        units: [
          { text: "命", joined: false, roman: "i|no|chi" },
          { text: "の", joined: false, roman: "no" },
        ],
        background: false,
        opposite: false,
      },
    ];
    let cursor: Cursor = { line: 0, unit: 0 };
    lines = markStart(lines, cursor, 1000);
    for (const time of [1200, 1400, 1800]) {
      const result = markNext(lines, cursor, time);
      lines = result.lines;
      cursor = result.cursor;
    }
    expect(cursor).toEqual({ line: 0, unit: 1 });
    lines = markEnd(lines, cursor, 2000).lines;
    const [word] = lines[0].units;
    expect([word.start, word.end]).toEqual([1000, 1800]);
    expect(romanPieces(word)).toEqual([
      { text: "i", start: 1000, end: 1200 },
      { text: "no", start: 1200, end: 1400 },
      { text: "chi", start: 1400, end: 1800 },
    ]);
    const ttml = toTtml(lines, meta);
    expect(ttml).toContain(
      '<span begin="00:01.000" end="00:01.800" lyssna:pieces="i|no|chi" lyssna:starts="00:01.200 00:01.400">inochi</span>',
    );
    expect(ttml).toContain('xmlns:lyssna="https://lyssna.org/ns/ttml"');
    expect(ttml).toContain('<span begin="00:01.000" end="00:01.800">命</span>');
    const shown = toLyrics(lines).lines[0];
    expect(shown.romanization).toBe("inochi no");
    expect(shown.romanization_words?.map((piece) => piece.text)).toEqual([
      "i",
      "no",
      "chi",
      " no",
    ]);
  });

  it("spreads untapped reading pieces evenly over their word", () => {
    expect(
      romanPieces({
        text: "命",
        joined: false,
        roman: "i|no|chi",
        start: 0,
        end: 900,
      }).map((piece) => [piece.start, piece.end]),
    ).toEqual([
      [0, 300],
      [300, 600],
      [600, 900],
    ]);
  });

  it("keeps real line times on a line's edges and leaves static lyrics untimed", () => {
    const line = {
      start_ms: 2000,
      end_ms: 3500,
      text: "line synced words",
      translation: "",
      romanization: "",
      background: false,
      opposite: false,
      words: [],
    };
    const edges = (lyrics: Lyrics) =>
      fromLyrics(lyrics)[0].units.map((unit) => [unit.start, unit.end]);
    const lyrics: Lyrics = {
      source: "x",
      instrumental: false,
      synced: true,
      lines: [line],
    };
    expect(edges(lyrics)).toEqual([
      [2000, undefined],
      [undefined, undefined],
      [undefined, 3500],
    ]);
    const untimed = [
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ];
    expect(edges({ ...lyrics, synced: false })).toEqual(untimed);
    expect(edges({ ...lyrics, estimated_lines: true })).toEqual(untimed);
  });

  it("formats times and reports untimed words", () => {
    expect(formatTime(61_234.4)).toBe("01:01.234");
    expect(problems(parseText("a b"))).toEqual([
      "2 of 2 words have no timing yet.",
    ]);
  });
});

describe("TTML Creator card editing", () => {
  const words = (lines: ReturnType<typeof parseText>) =>
    lines.map((line) => toText([line]));

  it("edits, splits and deletes words, keeping timing on a plain rename", () => {
    let lines = timeAll("one two");
    lines = editUnit(lines, { line: 0, unit: 1 }, "too");
    expect(lines[0].units[1]).toMatchObject({ text: "too", start: 1400 });
    lines = editUnit(lines, { line: 0, unit: 1 }, "t|o o");
    expect(words(lines)).toEqual(["one t|o o"]);
    expect(lines[0].units[1].start).toBeUndefined();
    lines = editUnit(lines, { line: 0, unit: 0 }, "");
    expect(words(lines)).toEqual(["t|o o"]);
    expect(editUnit(parseText("x"), { line: 0, unit: 0 }, " ")).toEqual([]);
  });

  it("drags a syllable edge and the neighbour sharing it", () => {
    const line = (units: [number, number][]): CreatorLine[] => [
      {
        background: false,
        opposite: false,
        units: units.map(([start, end], index) => ({
          text: `w${index}`,
          joined: false,
          start,
          end,
        })),
      },
    ];
    const times = (lines: CreatorLine[]) =>
      lines[0].units.map((unit) => [unit.start, unit.end]);
    const shared = line([
      [0, 500],
      [500, 900],
    ]);
    expect(
      times(moveEdge(shared, { line: 0, unit: 1 }, "start", 620.4)),
    ).toEqual([
      [0, 620],
      [620, 900],
    ]);
    expect(times(moveEdge(shared, { line: 0, unit: 0 }, "end", 2000))).toEqual([
      [0, 890],
      [890, 900],
    ]);
    const apart = line([
      [0, 400],
      [600, 900],
    ]);
    expect(times(moveEdge(apart, { line: 0, unit: 1 }, "start", 100))).toEqual([
      [0, 400],
      [400, 900],
    ]);
    expect(times(moveEdge(apart, { line: 0, unit: 0 }, "start", -50))).toEqual([
      [0, 400],
      [600, 900],
    ]);
    expect(moveEdge(apart, { line: 0, unit: 0 }, "start", -50)).toBe(apart);

    expect(
      times(moveEdge(shared, { line: 0, unit: 1 }, "start", 700, true)),
    ).toEqual([
      [0, 500],
      [700, 900],
    ]);
    expect(
      times(moveEdge(shared, { line: 0, unit: 1 }, "start", 300, true)),
    ).toEqual([
      [0, 500],
      [500, 900],
    ]);
    expect(
      times(moveEdge(shared, { line: 0, unit: 0 }, "end", 350, true)),
    ).toEqual([
      [0, 350],
      [500, 900],
    ]);
    expect(times(panUnit(shared, { line: 0, unit: 1 }, 650, true))).toEqual([
      [0, 500],
      [650, 1050],
    ]);
  });

  it("slides a syllable, stretching neighbours that share its edges", () => {
    const line = (units: [number, number][]): CreatorLine[] => [
      {
        background: false,
        opposite: false,
        units: units.map(([start, end], index) => ({
          text: `w${index}`,
          joined: false,
          start,
          end,
        })),
      },
    ];
    const times = (lines: CreatorLine[]) =>
      lines[0].units.map((unit) => [unit.start, unit.end]);
    const joined = line([
      [0, 500],
      [500, 900],
      [900, 1500],
    ]);
    expect(times(panUnit(joined, { line: 0, unit: 1 }, 650))).toEqual([
      [0, 650],
      [650, 1050],
      [1050, 1500],
    ]);
    expect(times(panUnit(joined, { line: 0, unit: 1 }, 5000))).toEqual([
      [0, 1090],
      [1090, 1490],
      [1490, 1500],
    ]);
    const apart = line([
      [0, 400],
      [600, 900],
      [1200, 1500],
    ]);
    expect(times(panUnit(apart, { line: 0, unit: 1 }, 100))).toEqual([
      [0, 400],
      [400, 700],
      [1200, 1500],
    ]);
    expect(panUnit(apart, { line: 0, unit: 1 }, 600)).toBe(apart);
  });

  it("replaces every identical word, with or without matching case", () => {
    const lines = timeAll("Hey hey you\nhey Hey");
    expect(words(replaceMatching(lines, "Hey", "Oh", true))).toEqual([
      "Oh hey you",
      "hey Oh",
    ]);
    const all = replaceMatching(lines, "Hey", "Oh", false);
    expect(words(all)).toEqual(["Oh Oh you", "Oh Oh"]);
    expect(all[0].units[1].start).toBe(lines[0].units[1].start);
    expect(words(replaceMatching(lines, "hey", "", false))).toEqual(["you"]);
  });

  it("makes a new line a background vocal when background words fill it", () => {
    const lines = insertBlankLine(parseText("Main line\n(oh yeah)"), 1);
    const one = moveWord(lines, { line: 1, unit: 1 }, { line: 2, unit: 0 });
    expect(one.map((line) => line.background)).toEqual([false, true, true]);
    const both = moveWords(
      lines,
      [
        { line: 1, unit: 0 },
        { line: 1, unit: 1 },
      ],
      { line: 2, unit: 0 },
    );
    expect(both.map((line) => line.background)).toEqual([false, true]);
    const mixed = moveWords(
      lines,
      [
        { line: 0, unit: 1 },
        { line: 1, unit: 1 },
      ],
      { line: 2, unit: 0 },
    );
    expect(mixed.at(-1)!.background).toBe(false);
    const onto = moveWord(lines, { line: 1, unit: 1 }, { line: 0, unit: 2 });
    expect(onto[0].background).toBe(false);
  });

  it("recases words moved to or from the start of a line", () => {
    const lines = parseText("Hello there friend\nNext line here");
    expect(
      words(moveWords(lines, [{ line: 0, unit: 2 }], { line: 1, unit: 0 })),
    ).toEqual(["Hello there", "Friend next line here"]);
    expect(
      words(moveWords(lines, [{ line: 1, unit: 0 }], { line: 0, unit: 3 })),
    ).toEqual(["Hello there friend next", "Line here"]);
    expect(
      words(moveWord(lines, { line: 0, unit: 2 }, { line: 1, unit: 0 })),
    ).toEqual(["Hello there", "Friend next line here"]);
    expect(
      words(moveWord(lines, { line: 1, unit: 0 }, { line: 0, unit: 3 })),
    ).toEqual(["Hello there friend next", "Line here"]);
    expect(
      words(moveWord(lines, { line: 0, unit: 0 }, { line: 0, unit: 3 })),
    ).toEqual(["There friend hello", "Next line here"]);
    const mine = parseText("Hold on\nI'm OK now");
    expect(
      words(moveWords(mine, [{ line: 1, unit: 0 }], { line: 0, unit: 2 })),
    ).toEqual(["Hold on I'm", "OK now"]);
    expect(
      words(moveWords(mine, [{ line: 1, unit: 1 }], { line: 0, unit: 0 })),
    ).toEqual(["OK hold on", "I'm now"]);
    const quiet = parseText("hello there\nnext");
    expect(
      words(moveWords(quiet, [{ line: 0, unit: 1 }], { line: 1, unit: 0 })),
    ).toEqual(["hello", "there next"]);
  });

  it("moves several picked words together in reading order", () => {
    const lines = parseText("a b|c d\ne f");
    expect(
      words(
        moveWords(
          lines,
          [
            { line: 0, unit: 2 },
            { line: 0, unit: 0 },
            { line: 0, unit: 1 },
          ],
          {
            line: 1,
            unit: 1,
          },
        ),
      ),
    ).toEqual(["d", "e a b|c f"]);
    expect(
      words(moveWords(lines, [{ line: 0, unit: 2 }], { line: 1, unit: 1 })),
    ).toEqual(["a b d", "e c f"]);
    expect(
      words(moveWords(lines, [{ line: 0, unit: 1 }], { line: 1, unit: 0 })),
    ).toEqual(["a c d", "b e f"]);
    expect(
      words(moveWords(lines, [{ line: 0, unit: 0 }], { line: 0, unit: 4 })),
    ).toEqual(["b|c d a", "e f"]);
    const gone = moveWords(
      lines,
      [
        { line: 1, unit: 0 },
        { line: 1, unit: 1 },
      ],
      {
        line: 0,
        unit: 0,
      },
    );
    expect(words(gone)).toEqual(["e f a b|c d"]);
    expect(moveWords(lines, [{ line: 0, unit: 1 }], { line: 0, unit: 2 })).toBe(
      lines,
    );
  });

  it("removes picked Space blocks, the trailing one included", () => {
    const lines = appendWords(parseText("a b c"), 0, " ");
    const next = removeSpaces(lines, [
      { line: 0, unit: 2 },
      { line: 0, unit: 3 },
    ]);
    expect(words(next)).toEqual(["a b|c"]);
    expect(next[0].spaceAfter).toBeUndefined();
    expect(removeSpaces(lines, [{ line: 0, unit: 1 }])[0].spaceAfter).toBe(
      true,
    );
  });

  it("adds a blank line that takes typed words and stays out of exports", () => {
    const lines = insertBlankLine(timeAll("one\ntwo"), 0);
    expect(lines[1].units).toEqual([]);
    expect(toLyrics(lines).lines).toHaveLength(2);
    expect(words(appendWords(lines, 1, "new"))[1]).toBe("new");
  });

  it("lights overlapping lines and words together", () => {
    const lines = parseText("whats my\n(whats my)\nnext");
    const time = (line: number, unit: number, start: number, end: number) =>
      Object.assign(lines[line].units[unit], { start, end });
    time(0, 0, 1000, 1500);
    time(0, 1, 1500, 2000);
    time(1, 0, 1030, 1520);
    time(1, 1, 1520, 2010);
    time(2, 0, 3000, 3500);
    const at = singingAt(lines, 1510);
    expect([...at.singing]).toEqual([0, 1]);
    expect([...at.live]).toEqual(["0:1", "1:0"]);
    expect(singingAt(lines, 2500).singing.size).toBe(0);
    lines[0].opposite = true;
    expect(toLyrics(lines).lines.map((line) => line.opposite)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("deletes picked words and spaces together", () => {
    const lines = parseText("yo when are\nlast");
    expect(
      words(
        deletePicked(lines, [{ line: 0, unit: 0 }], [{ line: 0, unit: 1 }]),
      ),
    ).toEqual(["when are", "last"]);
    expect(
      words(
        deletePicked(lines, [{ line: 0, unit: 0 }], [{ line: 0, unit: 2 }]),
      ),
    ).toEqual(["when|are", "last"]);
    expect(words(deletePicked(lines, [{ line: 1, unit: 0 }], []))).toEqual([
      "yo when are",
    ]);
  });

  it("adds typed words to the end of a line", () => {
    const lines = timeAll("one");
    const next = appendWords(lines, 0, " two th|ree");
    expect(words(next)).toEqual(["one two th|ree"]);
    expect(next[0].units[0].start).toBe(lines[0].units[0].start);
    expect(words(appendWords(lines, 0, "so"))).toEqual(["one so"]);
    expect(words(appendWords(lines, 0, "|ly"))).toEqual(["one|ly"]);
    const spaced = appendWords(lines, 0, " ");
    expect(spaced[0].spaceAfter).toBe(true);
    expect(appendWords(spaced, 0, " ")).toBe(spaced);
    const word = appendWords(spaced, 0, "two");
    expect(words(word)).toEqual(["one two"]);
    expect(word[0].spaceAfter).toBeUndefined();
    expect(appendWords(lines, 0, "two ")[0].spaceAfter).toBe(true);
    expect(dropTrailingSpace(spaced, 0)[0].spaceAfter).toBeUndefined();
    expect(appendWords(lines, 0, "")).toBe(lines);
  });

  it("joins words, inserts lines and exports translations", () => {
    let lines = toggleJoin(parseText("a b"), { line: 0, unit: 1 });
    expect(words(lines)).toEqual(["a|b"]);
    lines = insertLines(timeAll("first\nlast"), 0, "mid one\n(bg)");
    expect(words(lines)).toEqual(["first", "mid one", "(bg)", "last"]);
    lines = setLineText(timeAll("hola"), 0, "translation", "hello");
    lines = setLineText(lines, 0, "romanization", "");
    expect(lines[0].romanization).toBeUndefined();
    expect(toTtml(lines, meta)).toContain(
      '<span ttm:role="x-translation">hello</span></p>',
    );
    expect(toLyrics(lines).lines[0].translation).toBe("hello");
    expect(keepTimings(lines, parseText("hola"))[0].translation).toBe("hello");
  });

  it("keeps word romanization through export, import and auto fill", () => {
    let lines = timeAll("未完 成");
    expect(lines[0].units.map((unit) => unit.text)).toEqual(["未", "完", "成"]);
    lines = setUnitRoman(lines, { line: 0, unit: 0 }, " mi ");
    lines = setUnitRoman(lines, { line: 0, unit: 1 }, "kan");
    lines = setUnitRoman(lines, { line: 0, unit: 2 }, "sei");
    expect(toLyrics(lines).lines[0].romanization).toBe("mikan sei");
    const ttml = toTtml(lines, meta);
    expect(ttml).toContain('<text for="L1"><span begin=');
    expect(ttml).toContain(">mi</span><span");
    expect(ttml).toContain(">kan</span> <span");
    expect(ttml).not.toContain("x-roman");
    expect(
      fromLyrics(toLyrics(lines))[0].units.map((unit) => unit.roman),
    ).toEqual(["mi", "kan", "sei"]);
    expect(keepTimings(lines, parseText("未完 成"))[0].units[2].roman).toBe(
      "sei",
    );

    const blank = timeAll("мир hi да");
    const request = romanizeRequest(blank);
    const result = romanizeRequest(parseText("mir hi da"));
    const filled = applyRomanized(
      setUnitRoman(blank, { line: 0, unit: 2 }, "mine"),
      request,
      result,
    );
    expect(filled[0].units.map((unit) => unit.roman)).toEqual([
      "mir",
      undefined,
      "mine",
    ]);
    const again = applyRomanized(
      filled,
      request,
      romanizeRequest(parseText("mira hi dar")),
    );
    expect(again[0].units.map((unit) => unit.roman)).toEqual([
      "mira",
      undefined,
      "mine",
    ]);
    const edited = editUnit(blank, { line: 0, unit: 0 }, "мой");
    expect(applyRomanized(edited, request, result)[0].units[0].roman).toBe(
      undefined,
    );
  });

  it("auto romanizes words in any non-Latin script", async () => {
    const lines = parseText(
      "مرحبا สวัสดี नमस्ते שלום გამარჯობა 안녕 привет hi",
    );
    const request = romanizeRequest(lines);
    const filled = applyRomanized(
      lines,
      request,
      await romanizeLyrics(request),
    );
    const readings = filled[0].units.map((unit) => unit.roman);
    expect(readings.at(-1)).toBeUndefined();
    for (const reading of readings.slice(0, -1))
      expect(reading).toMatch(/^[ -~]+$/);
  });

  it("moves lines, whole words and spaces", () => {
    const lines = parseText("a\nb\nc");
    expect(words(moveLine(lines, 0, 3))).toEqual(["b", "c", "a"]);
    expect(words(moveLine(lines, 2, 0))).toEqual(["c", "a", "b"]);
    expect(moveLine(lines, 1, 2)).toBe(lines);
    const song = parseText("one t|wo three\nfour");
    expect(
      words(moveWord(song, { line: 0, unit: 2 }, { line: 0, unit: 4 })),
    ).toEqual(["one three t|wo", "four"]);
    expect(
      words(moveWord(song, { line: 0, unit: 3 }, { line: 0, unit: 0 })),
    ).toEqual(["three one t|wo", "four"]);
    expect(
      words(moveWord(song, { line: 1, unit: 0 }, { line: 0, unit: 1 })),
    ).toEqual(["one four t|wo three"]);
    expect(moveWord(song, { line: 0, unit: 1 }, { line: 0, unit: 3 })).toBe(
      song,
    );
    expect(
      words(moveSpace(song, { line: 0, unit: 1 }, { line: 0, unit: 2 })),
    ).toEqual(["one|t wo three", "four"]);
    expect(moveSpace(song, { line: 0, unit: 1 }, { line: 0, unit: 3 })).toBe(
      song,
    );
  });
});

describe("TTML Creator word menu", () => {
  it("splits a timed word evenly and an untimed one keeps its edges", () => {
    const lines = splitUnit(timeAll("go now"), { line: 0, unit: 0 }, [
      "g",
      "o",
    ]);
    expect(
      lines[0].units.map((unit) => [
        unit.text,
        unit.joined,
        unit.start,
        unit.end,
      ]),
    ).toEqual([
      ["g", false, 1000, 1200],
      ["o", true, 1200, 1400],
      ["now", false, 1400, 1800],
    ]);
    const started = markStart(parseText("abc"), { line: 0, unit: 0 }, 50);
    expect(
      splitUnit(started, { line: 0, unit: 0 }, ["a", "bc"])[0].units.map(
        (unit) => [unit.start, unit.end],
      ),
    ).toEqual([
      [50, undefined],
      [undefined, undefined],
    ]);
  });

  it("splits every matching word, optionally ignoring case", () => {
    const lines = parseText("Baby baby BABY");
    const cut = (text: string) => [text.slice(0, 2), text.slice(2)];
    expect(toText(splitMatching(lines, "baby", cut, false))).toBe(
      "Baby ba|by BABY",
    );
    expect(toText(splitMatching(lines, "baby", cut, true))).toBe(
      "Ba|by ba|by BA|BY",
    );
  });

  it("splits Japanese words per symbol, keeping small kana with their mora", () => {
    // Typed lyrics already split per symbol; imported ones arrive whole.
    const lines: CreatorLine[] = [
      {
        units: [
          { text: "引き抜くカセッ", joined: false, start: 1000, end: 1600 },
          { text: "ト", joined: true },
          { text: "hello", joined: false },
          { text: "迷路", joined: false, roman: "mei|ro" },
        ],
        background: false,
        opposite: false,
      },
    ];
    expect(hasJapanese(lines)).toBe(true);
    const split = splitJapanese(lines);
    expect(split[0].units.map((unit) => unit.text)).toEqual([
      "引", "き", "抜", "く", "カ", "セッ", "ト", "hello", "迷路",
    ]);
    expect(split[0].units[0]).toMatchObject({ start: 1000, end: 1100 });
    expect(split[0].units[6].joined).toBe(true);
    const english = parseText("hello there");
    expect(hasJapanese(english)).toBe(false);
    expect(splitJapanese(english)).toBe(english);
  });

  it("splits every whole word and leaves split words alone", () => {
    const lines = parseText("hello ba|by go\nwonder");
    const cut = (text: string) => [text.slice(0, 2), text.slice(2)];
    expect(toText(splitAllWords(lines, cut))).toBe("he|llo ba|by go\nwo|nder");
    const whole = parseText("go to");
    expect(splitAllWords(whole, cut)).toBe(whole);
  });

  it("moves words to a new line and duplicates lines", () => {
    const lines = parseText("(one two|x three)");
    expect(toText(breakLine(lines, { line: 0, unit: 1 }, false))).toBe(
      "(one)\n(two|x three)",
    );
    expect(toText(breakLine(lines, { line: 0, unit: 3 }, true))).toBe(
      "(one two|x)\n(three)",
    );
    expect(breakLine(lines, { line: 0, unit: 0 }, false)).toBe(lines);
    const song = parseText("Hello there my friend\nNext line");
    expect(toText(breakLine(song, { line: 0, unit: 2 }, false))).toBe(
      "Hello there\nMy friend\nNext line",
    );
    expect(toText(breakLine(song, { line: 0, unit: 0 }, true))).toBe(
      "There my friend\nHello\nNext line",
    );
    const picks = [
      { line: 0, unit: 1 },
      { line: 0, unit: 3 },
    ];
    expect(toText(breakLine(song, { line: 0, unit: 3 }, true, picks))).toBe(
      "Hello my\nThere friend\nNext line",
    );
    expect(toText(breakLine(song, { line: 0, unit: 3 }, false, picks))).toBe(
      "Hello\nThere my friend\nNext line",
    );
    expect(
      toText(
        breakLine(song, { line: 0, unit: 1 }, true, [
          { line: 0, unit: 0 },
          { line: 0, unit: 1 },
          { line: 1, unit: 0 },
        ]),
      ),
    ).toBe("My friend\nHello there next\nLine");
    const blank = insertBlankLine(song, 1);
    expect(
      toText(moveWords(blank, [{ line: 0, unit: 3 }], { line: 2, unit: 0 })),
    ).toBe("Hello there my\nNext line\nFriend");
    expect(
      toText(moveWord(blank, { line: 0, unit: 3 }, { line: 2, unit: 0 })),
    ).toBe("Hello there my\nNext line\nFriend");
    expect(
      toText(breakLine(parseText("hey you"), { line: 0, unit: 1 }, false)),
    ).toBe("hey\nyou");
    expect(toText(duplicateLine(parseText("a\nb"), 0))).toBe("a\na\nb");
  });

  it("splits typed repeated sounds into joined syllables", () => {
    const [line] = parseText("Ooh-ooh-ooh yeah");
    expect(line.units.map((unit) => [unit.text, unit.joined])).toEqual([
      ["Ooh-", false],
      ["ooh-", true],
      ["ooh", true],
      ["yeah", false],
    ]);
    expect(toText([line])).toBe("Ooh-|ooh-|ooh yeah");
  });

  it("drops a word between syllables as a syllable of that word", () => {
    const lines = parseText("Eigh-|eigh-|eighty oh in");
    expect(
      toText(moveWord(lines, { line: 0, unit: 3 }, { line: 0, unit: 1 })),
    ).toBe("Eigh-|oh|eigh-|eighty in");
    expect(
      toText(moveWord(lines, { line: 0, unit: 3 }, { line: 0, unit: 0 })),
    ).toBe("Oh eigh-|eigh-|eighty in");
    expect(
      toText(moveWords(lines, [{ line: 0, unit: 4 }], { line: 0, unit: 2 })),
    ).toBe("Eigh-|eigh-|in|eighty oh");
  });

  it("joins words saved with a space after a hyphen", () => {
    const old: CreatorLine[] = [
      {
        background: false,
        opposite: false,
        units: ["Ooh-", "ooh-", "ooh", "yeah"].map((text) => ({
          text,
          joined: false,
          start: 1,
          end: 2,
        })),
      },
    ];
    const fixed = joinHyphenated(old);
    expect(toText(fixed)).toBe("Ooh-|ooh-|ooh yeah");
    expect(fixed[0].units[1].start).toBe(1);
    expect(joinHyphenated(fixed)).toBe(fixed);
  });

  it("runs a word left open with a hyphen into the next", () => {
    expect(toText(parseText("eigh- eighty, ooh - yeah"))).toBe(
      "eigh-|eighty, ooh - yeah",
    );
    const typed = appendWords(parseText("Eigh-"), 0, "eighty");
    expect(toText(typed)).toBe("Eigh-|eighty");
    expect(toText(appendWords(typed, 0, "now"))).toBe("Eigh-|eighty now");
  });

  it("keeps a duplicated line apart from its original", () => {
    const copied = duplicateLine(parseText("one two three"), 0);
    const words = [
      { line: 1, unit: 0 },
      { line: 1, unit: 1 },
    ];
    expect(toText(deletePicked(copied, words, []))).toBe(
      "one two three\nthree",
    );
    expect(toText(moveWords(copied, words, { line: 0, unit: 0 }))).toBe(
      "one two one two three\nthree",
    );
  });
});

describe("TTML Creator metadata", () => {
  it("starts from the song and the remembered author", () => {
    const entries = defaultMetadata({ ...meta, songwriters: ["W"] }, [
      { key: "ttmlAuthorGithubLogin", values: ["someone"] },
      { key: "isrc", values: ["ignored"] },
    ]);
    const values = (key: string) =>
      entries.find((entry) => entry.key === key)?.values;
    expect(values("musicName")).toEqual(["Song & <Co>"]);
    expect(values("artists")).toEqual(["A", "B"]);
    expect(values("songwriters")).toEqual(["W"]);
    expect(values("ttmlAuthorGithubLogin")).toEqual(["someone"]);
    expect(values("isrc")).toEqual([]);
  });

  it("exports every filled value, custom keys and songwriters", () => {
    const ttml = toTtml(
      timeAll("Hi"),
      { ...meta, songwriters: ["Ann", "Bo"] },
      [
        { key: "musicName", values: ["Song", "曲", " ", "Song"] },
        { key: "isrc", values: ["USUM71703861", "GBUM71703861"] },
        { key: "qqMusicId", values: [""] },
        { key: "songwriters", values: ["Bo", "Cy"] },
        { key: "custom", values: ['x"y'] },
        { key: "spotifyId", values: ["edited"] },
        { key: "album", values: ["edited"] },
      ],
    );
    expect(ttml).not.toContain("edited");
    expect(ttml).toContain('<amll:meta key="spotifyId" value="abc"/>');
    expect(ttml).toContain(
      '<amll:meta key="musicName" value="Song"/><amll:meta key="musicName" value="曲"/><amll:meta key="isrc" value="USUM71703861"/><amll:meta key="isrc" value="GBUM71703861"/><amll:meta key="custom" value="x&quot;y"/>',
    );
    expect(ttml).not.toContain("qqMusicId");
    expect(ttml).not.toContain('key="artists"');
    expect(ttml).toContain(
      "<songwriters><songwriter>Bo</songwriter><songwriter>Cy</songwriter></songwriters>",
    );
  });

  it("fills songwriters from credits once, keeping a cleared row cleared", () => {
    const credited = { ...meta, songwriters: ["Ann"] };
    const filledIn = withSongwriters(
      [
        { key: "musicName", values: [] },
        { key: "artists", values: [] },
        { key: "isrc", values: [] },
      ],
      credited,
    );
    expect(filledIn.map((entry) => entry.key)).toEqual([
      "musicName",
      "artists",
      "songwriters",
      "isrc",
    ]);
    expect(filledIn[2].values).toEqual(["Ann"]);
    const cleared = [{ key: "songwriters", values: [] }];
    expect(withSongwriters(cleared, credited)).toBe(cleared);
    expect(withSongwriters([], meta)).toEqual([]);
  });

  it("flags values the AMLL TTML DB would reject", () => {
    expect(metaProblem("isrc", "USUM71703861")).toBeNull();
    expect(metaProblem("isrc", "usum7170")).not.toBeNull();
    expect(metaProblem("appleMusicId", "1440841766")).toBeNull();
    expect(metaProblem("appleMusicId", "album/1440841766")).not.toBeNull();
    expect(metaProblem("ttmlAuthorGithubLogin", "bad name")).not.toBeNull();
    expect(metaProblem("anything", "")).toBeNull();
  });
});

describe("TTML Creator line selection", () => {
  it("changes only the selected lines", () => {
    const lines = timeAll(["one", "two", "three"].join("\n"));
    const picked = new Set([0, 2]);
    expect(
      setLineFlag(lines, picked, "background", true).map((l) => l.background),
    ).toEqual([true, false, true]);
    const shifted = shiftLines(lines, picked, -1500);
    expect(shifted[0].units[0]).toMatchObject({ start: 0, end: 0 });
    expect(shifted[1].units[0].start).toBe(lines[1].units[0].start);
    expect(shifted[2].units[0].start).toBe(lines[2].units[0].start! - 1500);
    const cleared = clearLines(lines, picked);
    expect(cleared[0].units[0].start).toBeUndefined();
    expect(cleared[1].units[0].start).toBeDefined();
    expect(removeLines(lines, picked)).toEqual([lines[1]]);
  });
});

describe("TTML Creator deleting", () => {
  it("lets the next syllable start the word when the first one goes", () => {
    const lines = parseText("go ev|er");
    const units = editUnit(lines, { line: 0, unit: 1 }, "")[0].units;
    expect(units.map((unit) => [unit.text, unit.joined])).toEqual([
      ["go", false],
      ["er", false],
    ]);
    const middle = editUnit(parseText("a|b|c"), { line: 0, unit: 1 }, "")[0];
    expect(middle.units.map((unit) => [unit.text, unit.joined])).toEqual([
      ["a", false],
      ["c", true],
    ]);
  });
});

describe("geniusBackgrounds", () => {
  it("moves bracketed backing vocals to background lines, split at ;", () => {
    expect(
      geniusBackgrounds(
        "Who am I? (I'm a star; I'm a star)\n(Oh; oh)\nI (yeah) want it, (now)",
      ),
    ).toBe(
      "Who am I?\n(I'm a star)\n(I'm a star)\n(Oh)\n(oh)\nI want it,\n(yeah)\n(now)",
    );
  });

  it("keeps plain, unbalanced and nested lines intact", () => {
    expect(geniusBackgrounds("Just words\nOpen (bracket")).toBe(
      "Just words\nOpen (bracket",
    );
    expect(geniusBackgrounds("Hey (la (la) la)")).toBe("Hey\n(la (la) la)");
  });

  it("keeps the second singer on both", () => {
    expect(geniusBackgrounds("v2: Go (go)")).toBe("v2: Go\nv2: (go)");
    expect(parseText(geniusBackgrounds("Go (a; b)"))).toMatchObject([
      { background: false },
      { background: true, units: [{ text: "a" }] },
      { background: true, units: [{ text: "b" }] },
    ]);
  });
});

describe("voices in a section that names several singers", () => {
  const unit = (text: string, start: number) => ({
    text,
    joined: false,
    start,
    end: start + 500,
  });
  const lines: CreatorLine[] = [
    {
      units: [unit("Okay", 0), unit("go", 500)],
      background: false,
      opposite: false,
      part: "Chorus",
      singer: "The Kid LAROI & Juice WRLD",
    },
    {
      units: [unit("Go", 1000)],
      background: true,
      opposite: false,
    },
  ];

  it("writes a voice per artist on lines, words and backing vocals", async () => {
    const { setLineVoice, setUnitVoice, toTtml } =
      await import("./ttml-creator-model");
    let next = setLineVoice(lines, [1], "Juice WRLD");
    next = setUnitVoice(next, [{ line: 0, unit: 1 }], "Juice WRLD");
    const ttml = toTtml(next, { name: "GO", artists: [], album: "" } as never);
    // Voices are Lyssna's own detail; other readers see one lead side.
    expect(ttml).toContain(
      '<p begin="00:00.000" end="00:01.500" ttm:agent="v1" lyssna:voice="',
    );
    expect(ttml).toContain('lyssna:voice="Juice WRLD">go</span>');
    expect(ttml).toContain(
      '<span ttm:role="x-bg" begin="00:01.000" end="00:01.500" lyssna:voice="Juice WRLD">',
    );
    expect(ttml).not.toContain('ttm:agent="v2"');
    expect(ttml).not.toContain("ttm:name");
  });
});

describe("canSeed", () => {
  const lyrics = (source: string, credited = false) =>
    ({
      source,
      synced: true,
      instrumental: false,
      lines: [],
      ...(credited
        ? {
            source_credit: {
              text: "Lyrics provided by Apple Music via Lyssna",
              url: "https://lyssna.org",
            },
          }
        : {}),
    }) as unknown as Parameters<typeof canSeed>[0];

  it("lets Apple Music through Lyssna start a draft", () => {
    expect(canSeed(lyrics("apple_music", true))).toBe(true);
  });

  it("keeps other Apple Music and Spicy Lyrics out", () => {
    expect(canSeed(lyrics("apple_music"))).toBe(false);
    expect(canSeed(lyrics("aml"))).toBe(false);
    expect(canSeed(lyrics("spicy_lyrics"))).toBe(false);
    expect(canSeed(lyrics("spicy_lyrics", true))).toBe(false);
  });
});
