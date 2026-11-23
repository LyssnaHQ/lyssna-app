import { expect, it } from "vitest";
import { songPart } from "./song-parts";
import { unknownSections } from "./ttml-creator-model";

it("names Genius sections in any language under the English name", () => {
  expect(songPart("Verse 2: Someone")).toBe("Verse");
  expect(songPart("Refrão")).toBe("Chorus");
  expect(songPart("Estribillo 2")).toBe("Chorus");
  expect(songPart("Pre-Chorus (Remix)")).toBe("Pre-Chorus");
  expect(songPart("サビ")).toBe("Chorus");
  expect(songPart("후렴")).toBe("Chorus");
  expect(songPart("Puente")).toBe("Bridge");
  expect(songPart("Refrain")).toBe("Refrain");
  expect(songPart("Couplet 1")).toBe("Verse");
  expect(songPart("Guitar Solo")).toBe("Guitar Solo");
  expect(songPart("Non-Lyrical Vocals")).toBe("Non-Lyrical Vocals");
});

it("knows the sections Genius's pages use beyond its guide", () => {
  expect(songPart("Pre-Drop")).toBe("Pre-Drop");
  expect(songPart("Post-Drop 2")).toBe("Post-Drop");
  expect(unknownSections("[Pre-Drop]\nla\n[Post-Drop]")).toEqual([]);
});

it("knows no section Genius doesn't use", () => {
  expect(songPart("")).toBeUndefined();
  expect(songPart("Produced by someone")).toBeUndefined();
  expect(songPart("Random words")).toBeUndefined();
  expect(songPart("Banana Solo")).toBeUndefined();
});

it("lists the bracketed lines that name no Genius section", () => {
  expect(
    unknownSections("[Chorus]\nla la\n[Banana Solo]\n[]\n[Refrão]\n[Dance]"),
  ).toEqual(["[Banana Solo]", "[Dance]"]);
});
