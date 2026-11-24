import { useSyncExternalStore } from "react";
import { rpc } from "./bridge";
import type { Line, Lyrics, Word } from "./types";

/* Romanization runs in the app's Rust core (crates/lyric-romanize), off
 * the UI thread: Japanese through the IPADIC dictionary, Chinese as pinyin,
 * Korean, Cyrillic and Greek by their own rules, and other non-Latin letters
 * through a general transliteration. Romanization supplied with the lyrics
 * always wins. */

export interface RomanizeOptions {
  /** Keep the line as written and show the reading under it. */
  below?: boolean;
  /** Japanese spelled as romanized lyrics usually are: kyou, koohii, wa. */
  romajiAsWritten?: boolean;
}

interface RomanizedWord {
  text: string;
  start_ms: number;
  end_ms: number;
  /** The source word this one keeps its other details from. */
  from: number | null;
  estimated: boolean;
}
type RomanizedLine = { text: string; words: RomanizedWord[] } | null;

/** Lyrics romanized: supplied romanization first, then the song's
 *  converters over each word (or each line without word timing). */
export async function romanizeLyrics(
  lyrics: Lyrics,
  options: RomanizeOptions = {},
): Promise<Lyrics> {
  const romanized = await rpc<RomanizedLine[]>("romanize_lyrics", {
    lines: lyrics.lines.map((line) => ({
      text: line.text,
      romanization: line.romanization,
      romanization_syllables: line.romanization_syllables ?? [],
      words: line.words.map(({ text, start_ms, end_ms }) => ({
        text,
        start_ms,
        end_ms,
      })),
    })),
    options: { romaji_as_written: options.romajiAsWritten !== false },
  });
  let changed = false;
  let estimated = !!lyrics.estimated_words;
  const lines = lyrics.lines.map((line, index) => {
    const out = romanized[index];
    if (!out) return line;
    changed = true;
    const words = out.words.map(
      ({ text, start_ms, end_ms, from, estimated: guessed }): Word => {
        estimated ||= guessed;
        return {
          ...(from === null ? {} : line.words[from]),
          text,
          start_ms,
          end_ms,
          ...(guessed ? { estimated: true } : {}),
        };
      },
    );
    return {
      ...line,
      text: out.text,
      words,
      romanization: "",
      romanization_syllables: undefined,
    };
  });
  return changed ? { ...lyrics, lines, estimated_words: estimated } : lyrics;
}

// One cache per spelling, so switching Romaji as Written converts again.
const ready = [new WeakMap<Lyrics, Lyrics>(), new WeakMap<Lyrics, Lyrics>()];
const started = [new WeakSet<Lyrics>(), new WeakSet<Lyrics>()];
const listeners = new Set<() => void>();
let version = 0;

/** Romanized lyrics once ready; until then the lyrics as they are, and the
 *  views re-render through `useRomanization` when the result lands. Each
 *  lyrics object is converted once and the result reused. */
export function romanizedLyrics(
  lyrics: Lyrics,
  options: RomanizeOptions = {},
): Lyrics {
  const slot = options.romajiAsWritten === false ? 1 : 0;
  const done = ready[slot].get(lyrics);
  if (done) return done;
  if (!started[slot].has(lyrics)) {
    started[slot].add(lyrics);
    void romanizeLyrics(lyrics, options)
      .catch(() => lyrics)
      .then((result) => {
        ready[slot].set(lyrics, result);
        if (result === lyrics) return;
        version += 1;
        listeners.forEach((listener) => listener());
      });
  }
  return lyrics;
}

/** What `displayLyrics` needs to romanize, or false when it is off. */
export function romanizeFor(
  settings: {
    romanized?: boolean;
    romaji_as_written?: boolean;
    romanization_below?: boolean;
  },
  below = true,
): RomanizeOptions | false {
  return settings.romanized
    ? {
        romajiAsWritten: settings.romaji_as_written !== false,
        below: below && settings.romanization_below !== false,
      }
    : false;
}

const letters = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
/** A reading that only repeats the line, as Latin lyrics come back, adds
 * nothing under it. */
// Word-timed lines can leave `text` out or word it differently, so their sung words count too.
const forms = (line: Line) =>
  [line.text, line.words.map((word) => word.text).join("")]
    .map(letters)
    .filter(Boolean);
// A Latin line with a stray look-alike letter, such as a Cyrillic "е" typed for "e", romanizes to itself.
const mostlyLatin = (line: Line) => {
  const all = forms(line)[0] ?? "";
  const latin = all.match(/\p{Script=Latin}|\p{N}/gu)?.length ?? 0;
  return all.length > 0 && latin / [...all].length >= 0.9;
};
const sameReading = (line: Line, reading: Line) => {
  const written = forms(line);
  return (
    mostlyLatin(line) || forms(reading).some((form) => written.includes(form))
  );
};
const readings = new WeakMap<Lyrics, Lyrics>();
/** The lyrics as written, each line carrying its romanized reading. */
export function withReadings(lyrics: Lyrics, romanized: Lyrics): Lyrics {
  if (romanized === lyrics) return lyrics;
  let done = readings.get(romanized);
  if (!done) {
    done = {
      ...lyrics,
      lines: lyrics.lines.map((line, index) => {
        const reading = romanized.lines[index];
        return reading && !sameReading(line, reading)
          ? { ...line, reading }
          : line;
      }),
    };
    readings.set(romanized, done);
  }
  return done;
}

/** Re-renders the caller when romanized lyrics finish converting. */
export function useRomanization() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
