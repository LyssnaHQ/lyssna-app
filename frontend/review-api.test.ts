import { describe, expect, it } from "vitest";
import { canReview, diffLines, editKinds } from "./review-api";

describe("diffLines", () => {
  it("marks added, removed and retimed lines", () => {
    const rows = diffLines(
      [
        { text: "Hello there", startMs: 1000 },
        { text: "Old line", startMs: 2000 },
        { text: "Same time", startMs: 3000 },
      ],
      [
        { text: "hello there ", startMs: 1200 },
        { text: "Same time", startMs: 3010 },
        { text: "New line", startMs: 4000 },
      ],
    );
    expect(rows).toEqual([
      { kind: "same", text: "hello there ", retimed: true },
      { kind: "removed", text: "Old line" },
      { kind: "same", text: "Same time", retimed: false },
      { kind: "added", text: "New line" },
    ]);
  });

  it("handles an empty side", () => {
    expect(diffLines([], [{ text: "a" }])).toEqual([
      { kind: "added", text: "a" },
    ]);
    expect(diffLines([{ text: "a" }], [])).toEqual([
      { kind: "removed", text: "a" },
    ]);
  });
});

describe("canReview", () => {
  it("allows reviewers and above", () => {
    expect(canReview("reviewer")).toBe(true);
    expect(canReview("admin")).toBe(true);
    expect(canReview("uploader")).toBe(false);
    expect(canReview(null)).toBe(false);
  });
});

describe("editKinds", () => {
  const word = (text: string, start: number) => ({
    text,
    start_ms: start,
    end_ms: start + 300,
  });
  const line = (words: [string, number][], extra = {}) => ({
    start_ms: words[0][1],
    end_ms: words[words.length - 1][1] + 300,
    text: words.map(([text]) => text).join(""),
    translation: "",
    romanization: "",
    words: words.map(([text, start]) => word(text, start)),
    background: false,
    opposite: false,
    ...extra,
  });
  const lyrics = (lines: ReturnType<typeof line>[]) =>
    ({ lines, source: "", instrumental: false, synced: true }) as never;
  const base = [
    line(
      [
        ["Placeholder ", 0],
        ["one", 400],
      ],
      { section: "Verse" },
    ),
    line([
      ["walk", 1000],
      ["ing", 1200],
      [" home", 1500],
    ]),
    line([
      ["Placeholder ", 2000],
      ["three", 2400],
    ]),
  ];

  it("names a sections-only edit", () => {
    const head = base.map((item, index) =>
      index === 2 ? { ...item, section: "Chorus" } : item,
    );
    expect(editKinds(lyrics(base), lyrics(head))).toEqual([
      { kind: "Sections", lines: 1 },
    ]);
  });

  it("tells syllable splits from timing and text", () => {
    const head = [
      line(
        [
          ["Placeholder ", 0],
          ["one", 600],
        ],
        { section: "Verse" },
      ),
      line([
        ["walking", 1000],
        [" home", 1500],
      ]),
      line([
        ["Something ", 2000],
        ["new", 2400],
      ]),
    ];
    expect(editKinds(lyrics(base), lyrics(head))).toEqual([
      { kind: "Lyrics", lines: 2 },
      { kind: "Syllables", lines: 1 },
      { kind: "Timing", lines: 1 },
    ]);
  });
});
