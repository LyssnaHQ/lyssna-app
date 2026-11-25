import type { Line, Lyrics, Word } from "./types";
import {
  romanizedLyrics,
  withReadings,
  type RomanizeOptions,
} from "./romanization";

/*
 * Experimental word sync: estimated timing for line-synced and static lyrics.
 *
 * Reimplements the behaviour of Spicy Lyrics' ExperimentalWordSync
 * (iPixelGalaxy/spicy-lyrics, AGPL-3.0) for Lyssna's lyric model. Each
 * line's time is spread over its words by letter weight, and a line whose
 * end runs straight into the next
 * line but lasts far longer than its words need is trimmed to a speech-rate
 * estimate. Static lyrics use the track duration and text weights to estimate
 * lines first. These estimates do not detect vocals or instrumental sections.
 * Apple Music syllables that hold several words are split into words.
 * Bracketed parts become background vocals: in estimated lines they take
 * their share of the line's time, and in word-timed lines they keep the
 * timing of the words they came from.
 */

type Segment = { background: boolean; text: string };
type Unit = { text: string; partOfWord: boolean };

const BRACKETED =
  /(\[[^[\]]+\]|\([^()]+\)|\{[^{}]+\}|\uFF08[^\uFF08\uFF09]+\uFF09|\u3010[^\u3010\u3011]+\u3011)/g;
const BRACKETED_ONLY =
  /^(\[[^[\]]+\]|\([^()]+\)|\{[^{}]+\}|\uFF08[^\uFF08\uFF09]+\uFF09|\u3010[^\u3010\u3011]+\u3011)$/;
const BRACKET_PAIRS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["\uFF08", "\uFF09"],
  ["\u3010", "\u3011"],
]);
const BRACKET_CHARACTERS = /[[\](){}\uFF08\uFF09\u3010\u3011]/g;
const OPEN_BRACKET = /[([{\uFF08\u3010]/;
/** A gap (ms) around a bracketed line that makes it a line of its own. */
const LONE_GAP_MS = 350;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;
const VOCABLE =
  /^(oh|ooh|oooh|whoa|woah|ah|aah|ha|hey|yeah|ya|na|la|da|dum|doo|wo)$/;
/** Line ends this close (ms) to the next start look auto-filled, not sung. */
const SUSPICIOUS_END_MS = 50;

const normalize = (text: string | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim();

/** Letters that take time to sing; punctuation and spaces do not. */
export function textWeight(text: string) {
  const compact = text
    .replace(/[.,!?;:'"()[\]{}\-—–…@#$%^&*~`]/g, "")
    .replace(/\s/g, "");
  return Math.max(1, compact.length || text.trim().length);
}

function segments(text: string): Segment[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  const result: Segment[] = [];
  for (const part of normalized.split(BRACKETED)) {
    const piece = normalize(part);
    if (!piece) continue;
    if (BRACKETED_ONLY.test(piece)) {
      const inner = normalize(piece.slice(1, -1));
      if (inner) result.push({ background: true, text: inner });
    } else result.push({ background: false, text: piece });
  }
  return result.length ? result : [{ background: false, text: normalized }];
}

const stripBrackets = (text: string) =>
  normalize(text.replace(BRACKET_CHARACTERS, " "));
const capitalize = (text: string) =>
  text.replace(/\p{L}/u, (letter) => letter.toUpperCase());
const allBackground = (text: string) => {
  const parts = segments(text);
  return parts.length > 0 && parts.every((part) => part.background);
};
/** Text without its bracketed parts, or as it is when it has none. */
function leadText(text: string) {
  const parts = segments(text);
  if (!parts.some((part) => part.background)) return text;
  return parts
    .filter((part) => !part.background)
    .map((part) => part.text)
    .join(" ");
}

/** A background vocal split off `line`, timed with its own words. */
function backingLine(line: Line, words: Word[]): Line {
  return {
    ...line,
    start_ms: words[0].start_ms,
    end_ms: words.at(-1)!.end_ms,
    text: words.map((word) => word.text).join(""),
    words,
    translation: "",
    romanization: "",
    romanization_words: undefined,
    reading: undefined,
    background: true,
    section: undefined,
    section_singer: undefined,
  };
}

/**
 * A line sung only in brackets stays a line of its own when its neighbours
 * are bracketed too, or when it stands apart in a gap.
 */
function keepsOwnLine(lines: Line[], index: number) {
  const previous = lines[index - 1],
    line = lines[index],
    next = lines[index + 1];
  if (
    (previous && allBackground(previous.text)) ||
    (next && allBackground(next.text))
  )
    return true;
  return (
    (!!previous && line.start_ms - previous.end_ms > LONE_GAP_MS) ||
    (!!next && next.start_ms - line.end_ms > LONE_GAP_MS)
  );
}

function hyphenUnits(token: string): Unit[] {
  const parts = token.split("-").map((part) => part.trim());
  if (parts.length === 1) return [{ text: token, partOfWord: false }];
  const units = parts.flatMap((part, index) =>
    part
      ? [
          {
            text: index < parts.length - 1 ? `${part}-` : part,
            partOfWord: index < parts.length - 1,
          },
        ]
      : [],
  );
  return units.length ? units : [{ text: token, partOfWord: false }];
}

function cjkUnits(token: string, splitHangul: boolean): Unit[] {
  if (!CJK.test(token)) return hyphenUnits(token);
  const pieces =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "word" }).segment(token),
          ({ segment }) => segment,
        )
      : Array.from(token);
  const units = pieces
    .flatMap((piece) =>
      splitHangul && HANGUL_ONLY.test(piece) ? Array.from(piece) : [piece],
    )
    .filter(Boolean);
  return units.map((text, index) => ({
    text,
    partOfWord: index < units.length - 1,
  }));
}

/** Splits text into timed units: words, hyphen parts and CJK words. */
export function splitUnits(text: string): Unit[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  const spaced = /\s/.test(normalized);
  return normalized
    .split(/\s+/)
    .flatMap((token) => cjkUnits(token, !spaced))
    .filter((unit) => unit.text);
}

/** Splits [start, end) in proportion to weights; the last part ends at end. */
export function distribute(start: number, end: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0);
  const duration = Math.max(0, end - start);
  let used = 0,
    cursor = start;
  return weights.map((weight, index) => {
    const from = cursor;
    if (index === weights.length - 1 || duration <= 0)
      return { start: from, end };
    used += Math.max(1, weight);
    cursor = start + Math.round((duration * used) / total);
    return { start: from, end: cursor };
  });
}

/** Words for `text`, using Lyssna's leading-space word convention. */
function buildWords(text: string, start: number, end: number): Word[] {
  const units = splitUnits(text);
  const ranges = distribute(
    start,
    end,
    units.map((unit) => textWeight(unit.text)),
  );
  return units.map((unit, index) => ({
    text: `${index > 0 && !units[index - 1].partOfWord ? " " : ""}${unit.text}`,
    start_ms: ranges[index].start,
    end_ms: ranges[index].end,
    estimated: true,
  }));
}

export function isVocableLine(text: string) {
  const normalized = normalize(text).toLowerCase();
  const words = splitUnits(normalized).map((unit) => unit.text);
  if (!words.length || words.length > 5) return false;
  const simple = normalized.split(/\s+/).filter(Boolean).length;
  const hyphens = (normalized.match(/-/g) ?? []).length >= 2;
  return (
    words.every((word) => {
      const letters = word.replace(/[^a-z]/g, "");
      return (
        letters.length >= 1 && letters.length <= 5 && VOCABLE.test(letters)
      );
    }) &&
    (hyphens || simple <= 3)
  );
}

/** How long (ms) a line of text usually takes to sing. */
export function spokenDuration(text: string) {
  const units = splitUnits(text);
  if (!units.length) return 400;
  const weight = units.reduce((sum, unit) => sum + textWeight(unit.text), 0);
  const normalized = normalize(text);
  const pause = /[.!?]$/.test(normalized)
    ? 0.12
    : /[,;:]$/.test(normalized)
      ? 0.07
      : 0;
  return (
    Math.max(0.4, 0.18 + units.length * 0.16 + weight * 0.045 + pause) * 1000
  );
}

/**
 * Line-synced sources often end every line exactly where the next begins.
 * When that end is far later than the words need, finish the words sooner so
 * they do not crawl through an instrumental gap.
 */
export function effectiveLineEnd(lines: Line[], index: number) {
  const line = lines[index],
    next = lines.slice(index + 1).find((item) => !item.background);
  if (!next || Math.abs(line.end_ms - next.start_ms) > SUSPICIOUS_END_MS)
    return line.end_ms;
  const background = segments(line.text).some((segment) => segment.background);
  const vocable = isVocableLine(line.text);
  const predicted =
    spokenDuration(line.text) * (background ? 1.2 : 1) * (vocable ? 1.65 : 1);
  const threshold = (background ? 1.95 : 1.6) * (vocable ? 1.42 : 1);
  if (line.end_ms - line.start_ms <= predicted * threshold) return line.end_ms;
  const trim = background ? 1.1 : vocable ? 1.62 : 1.22;
  return Math.min(line.end_ms, Math.round(line.start_ms + predicted * trim));
}

/** Untimed words need either authored line timing or a valid track duration. */
export function needsWordSync(
  lyrics: Lyrics | null | undefined,
  durationMs = 0,
) {
  return !!(
    lyrics &&
    !lyrics.instrumental &&
    (lyrics.synced || (Number.isFinite(durationMs) && durationMs > 0)) &&
    lyrics.lines.some((line) => normalize(line.text)) &&
    lyrics.lines.every((line) => !line.words.length)
  );
}

/** Break paragraphs into readable phrases before estimating their time. */
function timeStaticLyrics(lyrics: Lyrics, durationMs: number): Lyrics {
  const phrases = lyrics.lines.flatMap((line) => {
    const texts = line.text
      .split(/\r?\n/)
      .flatMap((row) =>
        row
          .split(/(?<=[.!?。！？])\s+|(?<=[。！？])(?=\S)/u)
          .flatMap((sentence) => {
            const units = splitUnits(sentence);
            const chunks: string[] = [];
            for (let index = 0; index < units.length; index += 10) {
              const group = units.slice(index, index + 10);
              chunks.push(
                group
                  .map(
                    (unit, i) =>
                      `${i && !group[i - 1].partOfWord ? " " : ""}${unit.text}`,
                  )
                  .join(""),
              );
            }
            return chunks;
          }),
      )
      .filter((text) => normalize(text));
    return texts.map((text) => ({
      ...line,
      text,
      // Translations cannot be aligned to newly split phrases reliably.
      translation: texts.length === 1 ? line.translation : "",
      romanization: texts.length === 1 ? line.romanization : "",
    }));
  });
  const start = Math.min(4000, durationMs * 0.05);
  const end = durationMs - Math.min(6000, durationMs * 0.05);
  const weights = phrases.flatMap((line, index) =>
    index < phrases.length - 1
      ? [spokenDuration(line.text), /[.!?。！？]$/.test(line.text) ? 350 : 150]
      : [spokenDuration(line.text)],
  );
  const ranges = distribute(start, end, weights);
  return {
    ...lyrics,
    synced: true,
    estimated_lines: true,
    lines: phrases.map((line, index) => ({
      ...line,
      start_ms: ranges[index * 2].start,
      end_ms: ranges[index * 2].end,
    })),
  };
}

/** Converts line-synced or static lyrics to estimated word timing. */
export function convertToWordSync(lyrics: Lyrics, durationMs = 0): Lyrics {
  if (!needsWordSync(lyrics, durationMs)) return lyrics;
  if (!lyrics.synced) lyrics = timeStaticLyrics(lyrics, durationMs);
  const source = lyrics.lines.filter((line) => normalize(line.text));
  const output: Line[] = [];
  source.forEach((line, index) => {
    const end = lyrics.estimated_lines
      ? line.end_ms
      : effectiveLineEnd(source, index);
    const parts = line.background ? [] : segments(line.text);
    if (!parts.some((part) => part.background)) {
      const words = buildWords(normalize(line.text), line.start_ms, end);
      if (!words.length) return;
      output.push({
        ...line,
        end_ms: end,
        text: words.map((word) => word.text).join(""),
        words,
      });
      return;
    }
    // Each part takes its share of the line; bracketed parts become
    // background vocals sung in that share.
    const ranges = distribute(
      line.start_ms,
      end,
      parts.map((part) => textWeight(part.text)),
    );
    const lead: Word[] = [];
    const backing: Line[] = [];
    parts.forEach((part, at) => {
      const range = ranges[at];
      if (part.background) {
        const words = buildWords(capitalize(part.text), range.start, range.end);
        if (words.length) backing.push(backingLine(line, words));
        return;
      }
      const words = buildWords(part.text, range.start, range.end);
      if (lead.length && words[0]) words[0].text = ` ${words[0].text}`;
      lead.push(...words);
    });
    const ownLine = (words: Word[]): Line => ({
      ...line,
      start_ms: words[0].start_ms,
      end_ms: words.at(-1)!.end_ms,
      text: words.map((word) => word.text).join(""),
      words,
      romanization: leadText(line.romanization),
      romanization_words: undefined,
      reading: line.reading && {
        ...line.reading,
        text: leadText(line.reading.text),
      },
    });
    if (lead.length) {
      output.push(ownLine(lead), ...backing);
      return;
    }
    if (!backing.length) return;
    const previous = [...output].reverse().find((item) => !item.background);
    if (
      !keepsOwnLine(source, index) &&
      previous &&
      previous.opposite === line.opposite &&
      !line.section
    ) {
      output.push(...backing);
      return;
    }
    output.push(
      ownLine(
        buildWords(
          capitalize(stripBrackets(line.text)),
          line.start_ms,
          end,
        ),
      ),
    );
  });
  return { ...lyrics, lines: output, estimated_words: true };
}

/** Apple Music lyrics through the Spicy Lyrics provider. */
const isAppleMusic = (lyrics: Lyrics) =>
  lyrics.source === "apple_music" || lyrics.source === "aml";

/** One timed word per sung word, timed by letter weight within the original. */
function splitWord(word: Word): Word[] {
  const units = normalize(word.text).split(/\s+/).flatMap(hyphenUnits);
  if (units.length <= 1) return [word];
  const ranges = distribute(
    word.start_ms,
    word.end_ms,
    units.map((unit) => textWeight(unit.text)),
  );
  const leading = /^\s/.test(word.text) ? " " : "",
    trailing = /\s$/.test(word.text) ? " " : "";
  return units.map((unit, index) => ({
    text: `${index === 0 ? leading : units[index - 1].partOfWord ? "" : " "}${unit.text}${index === units.length - 1 ? trailing : ""}`,
    start_ms: ranges[index].start,
    end_ms: ranges[index].end,
    estimated: true,
  }));
}

/**
 * Apple Music sometimes times several words as one syllable ("I want you").
 * Like Spicy Lyrics' Apple word splitting (pixels-spicy-lyrics,
 * SplitAppleMusicSyllableWords), each word gets its own share of that time
 * by letter weight, so the highlight moves word by word.
 */
export function splitMergedWords(lyrics: Lyrics): Lyrics {
  if (!isAppleMusic(lyrics)) return lyrics;
  let split = false;
  const lines = lyrics.lines.map((line) => {
    if (!line.words.some((word) => splitWord(word).length > 1)) return line;
    split = true;
    return { ...line, words: line.words.flatMap(splitWord) };
  });
  return split ? { ...lyrics, lines, split_words: true } : lyrics;
}

/** Where each outermost bracketed part of `text` starts and ends. */
function bracketRanges(text: string) {
  const ranges: { start: number; end: number }[] = [];
  const open: { start: number; close: string }[] = [];
  for (let index = 0; index < text.length; index++) {
    const close = BRACKET_PAIRS.get(text[index]);
    if (close) open.push({ start: index, close });
    else if (open.at(-1)?.close === text[index]) {
      const { start } = open.pop()!;
      if (!open.length && stripBrackets(text.slice(start, index + 1)))
        ranges.push({ start, end: index + 1 });
    }
  }
  return ranges;
}

/**
 * Splits a word-timed line's bracketed words from the rest. Words keep their
 * timing; one that holds both halves gives each half its whole time.
 */
function separateBrackets(words: Word[]) {
  const joined = words.map((word) => word.text).join("");
  const ranges = bracketRanges(joined);
  if (!ranges.length) return null;
  type Piece = { word: Word; text: string; from: number; to: number };
  const lead: Piece[] = [];
  const groups: Piece[][] = ranges.map(() => []);
  let offset = 0,
    at = 0;
  for (const word of words) {
    const end = offset + word.text.length;
    let start = offset;
    while (start < end) {
      const range = ranges[at];
      const background = !!range && start >= range.start;
      const limit = Math.min(
        end,
        range ? (background ? range.end : range.start) : end,
      );
      const slice = joined.slice(start, limit);
      const text = background ? stripBrackets(slice) : slice.trim();
      if (text) {
        const skip = slice.search(/[^\s[\](){}\uFF08\uFF09\u3010\u3011]/);
        (background ? groups[at] : lead).push({
          word,
          text,
          from: start + Math.max(0, skip),
          to: limit,
        });
      }
      if (range && limit === range.end) at++;
      start = limit;
    }
    offset = end;
  }
  // Pieces apart in the original, or with a bracketed part between them,
  // are separate words.
  const build = (pieces: Piece[], capital: boolean): Word[] =>
    pieces.map((piece, index) => {
      const gap = index ? joined.slice(pieces[index - 1].to, piece.from) : "";
      const spaced = index > 0 && /[\s[\](){}\uFF08\uFF09\u3010\u3011]/.test(gap);
      const text = index === 0 && capital ? capitalize(piece.text) : piece.text;
      return { ...piece.word, text: `${spaced ? " " : ""}${text}` };
    });
  return {
    lead: build(lead, false),
    backing: groups
      .filter((group) => group.length)
      .map((group) => build(group, true)),
  };
}

/** Sources whose word-timed lines mark backing vocals with brackets. */
const bracketsBacking = (lyrics: Lyrics) =>
  isAppleMusic(lyrics) || lyrics.source === "lrcred";

/**
 * Bracketed words in word-timed lines become background vocals. A line
 * sung only in brackets is usually a backing phrase before the next line,
 * so it goes with that line and keeps its own timing.
 */
export function extractBracketBacking(lyrics: Lyrics): Lyrics {
  if (!bracketsBacking(lyrics)) return lyrics;
  const marked = (line: Line) =>
    !line.background && line.words.some((word) => OPEN_BRACKET.test(word.text));
  if (!lyrics.lines.some(marked)) return lyrics;
  const lines: Line[] = [];
  let pending: Line[] = [];
  let section: Pick<Line, "section" | "section_singer"> | null = null;
  let changed = false;
  for (const line of lyrics.lines) {
    const split = marked(line) ? separateBrackets(line.words) : null;
    if (!split) {
      lines.push(line);
      if (!line.background && pending.length) {
        lines.push(...pending);
        pending = [];
      }
      continue;
    }
    changed = true;
    const backing = split.backing.map((words) => backingLine(line, words));
    if (!split.lead.length) {
      pending.push(...backing);
      if (line.section && !section)
        section = { section: line.section, section_singer: line.section_singer };
      continue;
    }
    const reading = line.reading && {
      ...line.reading,
      text: leadText(line.reading.text),
      words: line.reading.words.length
        ? (separateBrackets(line.reading.words)?.lead ?? line.reading.words)
        : line.reading.words,
    };
    lines.push(
      {
        ...line,
        ...(section && !line.section ? section : {}),
        start_ms: split.lead[0].start_ms,
        end_ms: split.lead.at(-1)!.end_ms,
        text: split.lead.map((word) => word.text).join(""),
        words: split.lead,
        romanization: leadText(line.romanization),
        romanization_words: undefined,
        reading,
      },
      ...pending,
      ...backing,
    );
    pending = [];
    section = null;
  }
  if (pending.length) {
    if (!lines.some((line) => !line.background)) return lyrics;
    lines.push(...pending);
  }
  return changed ? { ...lyrics, lines } : lyrics;
}

const merged = new WeakMap<Lyrics, Lyrics>();
const cache = new WeakMap<Lyrics, { durationMs: number; lyrics: Lyrics }>();
/** Lyrics as displayed: converted when word sync is on and applies. */
export function displayLyrics<T extends Lyrics | null | undefined>(
  lyrics: T,
  wordSync: boolean,
  romanized: boolean | RomanizeOptions = false,
  durationMs = 0,
): T {
  if (lyrics && romanized) {
    const options = romanized === true ? {} : romanized;
    const read = romanizedLyrics(lyrics, options);
    lyrics = (options.below ? withReadings(lyrics, read) : read) as T;
  }
  if (!lyrics || !wordSync) return lyrics;
  if (!needsWordSync(lyrics, durationMs)) {
    let split = merged.get(lyrics);
    if (!split)
      merged.set(
        lyrics,
        (split = splitMergedWords(extractBracketBacking(lyrics))),
      );
    return split as T;
  }
  const timingDuration = lyrics.synced ? 0 : durationMs;
  let converted = cache.get(lyrics);
  if (!converted || converted.durationMs !== timingDuration) {
    converted = {
      durationMs: timingDuration,
      lyrics: convertToWordSync(lyrics, durationMs),
    };
    cache.set(lyrics, converted);
  }
  return converted.lyrics as T;
}
