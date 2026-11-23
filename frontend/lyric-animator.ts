import type { Lyrics } from "./types";
import * as engine from "./lyric-engine";
import { goalsOf, vocalEnd, type SyllableGoal } from "./lyric-motion";
import { frameDue } from "./frame-cap";

/** Simple lyrics mode: no scale or glow, a wider soft edge
 *  starting further back, and a small steady rise across each word. */
export const simpleGoal = (
  start: number,
  end: number,
  time: number,
): SyllableGoal => goalsOf(engine.simpleGoal(start, end, time))[0];

interface Piece {
  element: HTMLElement;
  /** Last value written per style property, to skip redundant writes. */
  written: Map<string, string>;
}
interface Syllable {
  /** Steps this syllable's springs in Rust; the word comes first in
   * `pieces`, then the held word's letters. */
  motion: engine.Syllable;
  pieces: Piece[];
}
const LAYERED_LINES = 4;
/** Values per piece from the engine: fill, scale, lift, glow radius and
 * glow opacity. */
const VALUES = 5;
const STYLES = [
  "scale",
  "translate",
  "--gradient-position",
  "--gradient-ratio",
  "--glow",
];
function write(target: Piece, property: string, value: string) {
  if (target.written.get(property) === value) return;
  target.written.set(property, value);
  target.element.style.setProperty(property, value);
}
function clear(target: Piece) {
  for (const property of STYLES) target.element.style.removeProperty(property);
  target.written.clear();
}
function show(target: Piece, values: Float64Array, at: number) {
  const fill = values[at],
    scale = values[at + 1],
    lift = values[at + 2],
    radius = values[at + 3],
    opacity = values[at + 4];
  if (!Number.isNaN(fill)) {
    write(target, "--gradient-position", `${fill}%`);
    write(target, "--gradient-ratio", `${fill / 100}`);
  }
  if (!Number.isNaN(scale)) write(target, "scale", scale.toFixed(4));
  if (!Number.isNaN(lift)) write(target, "translate", `0 ${lift.toFixed(4)}em`);
  if (!Number.isNaN(radius))
    write(
      target,
      "--glow",
      `0 0 ${radius.toFixed(2)}px rgb(255 255 255 / ${opacity.toFixed(1)}%)`,
    );
}

/** Drives syllable springs on rendered lyric lines. Lines being sung, and
 * lines whose springs are still settling, are stepped every frame by the Rust
 * lyric engine and written straight to the DOM. Other lines rest on static
 * styles. */
export class LyricAnimator {
  private live = new Map<number, Syllable[]>();
  /** Finished lines whose words still hold their layers. */
  private layered = new Set<number>();
  private wiping = new Map<number, string>();
  private ends: number[];
  private time = 0;
  private last = performance.now();
  private frame = 0;
  constructor(
    private lyrics: Lyrics,
    private line: (index: number) => HTMLElement | null,
    private reduceMotion: boolean,
    private simple = false,
  ) {
    this.ends = lyrics.lines.map(vocalEnd);
  }
  /** Sets song time and steps. Keeps stepping on its own while springs
   * settle, such as after a pause or a seek. */
  update(time: number) {
    this.time = time;
    this.run();
  }
  /** Drops all motion so text snaps to its resting state, as after a jump
   * in song time. */
  reset() {
    for (const [index, syllables] of this.live) this.release(index, syllables);
    for (const index of this.layered) this.unlayer(index);
    for (const index of [...this.wiping.keys()]) this.wipe(index, Number.NaN);
  }
  /** A line without word timing fills top to bottom while it is sung. It
   *  turns active slightly early, so it rests unfilled until it starts. */
  private wipe(index: number, position: number) {
    const element = this.line(index);
    if (Number.isNaN(position)) {
      element?.style.removeProperty("--line-wipe");
      this.wiping.delete(index);
      return;
    }
    const value = `${position.toFixed(2)}%`;
    if (this.wiping.get(index) === value) return;
    element?.style.setProperty("--line-wipe", value);
    this.wiping.set(index, value);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.reset();
  }
  private run = () => {
    cancelAnimationFrame(this.frame);
    const now = performance.now();
    // Under a frame rate cap, wait for the next allowed frame.
    if (!frameDue(this.last, now)) {
      this.frame = requestAnimationFrame(this.run);
      return;
    }
    const seconds = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.frame = this.step(seconds) ? requestAnimationFrame(this.run) : 0;
  };
  /** Rests a line's words. A finished line keeps their layers: dropping
   * them redraws the text a fraction of a pixel off, so its words visibly
   * snap. They go once the line is a few lines back. */
  private release(index: number, syllables: Syllable[], finished = false) {
    if (finished) this.layered.add(index);
    else this.unlayer(index);
    for (const syllable of syllables) {
      syllable.pieces.forEach(clear);
      syllable.motion.free();
    }
    this.live.delete(index);
  }
  private unlayer(index: number) {
    this.line(index)?.removeAttribute("data-settling");
    this.layered.delete(index);
  }
  private dropOldLayers() {
    if (!this.layered.size) return;
    let reached = -1;
    this.lyrics.lines.forEach((line, index) => {
      if (line.start_ms <= this.time) reached = index;
    });
    for (const index of this.layered)
      if (index < reached - LAYERED_LINES || index > reached)
        this.unlayer(index);
  }
  private build(index: number): Syllable[] | undefined {
    const element = this.line(index),
      words = this.lyrics.lines[index].words;
    const nodes = element?.querySelectorAll<HTMLElement>(".lyric-syllable");
    if (!nodes?.length) return undefined;
    // Syllables may carry their own timing (Space Gravity splits words
    // across floating pieces); otherwise they match the line's words.
    const timed = nodes[0].dataset.start !== undefined;
    if (!timed && nodes.length !== words.length) return undefined;
    return Array.from(nodes, (node, part) => {
      const emphasis = node.classList.contains("emphasis");
      const start = timed ? Number(node.dataset.start) : words[part].start_ms,
        end = timed ? Number(node.dataset.end) : words[part].end_ms;
      const letters = emphasis
        ? Array.from(node.querySelectorAll<HTMLElement>(".lyric-letter"))
        : [];
      const pieces = [node, ...letters].map((element) => ({
        element,
        written: new Map<string, string>(),
      }));
      return {
        pieces,
        motion: new engine.Syllable(
          start,
          end,
          emphasis,
          letters.length,
          Number(node.dataset.letterOffset ?? 0),
          Number(node.dataset.letterCount ?? letters.length),
          // The reading under a line moves less.
          node.closest(".lyric-romanization") ? 0.35 : 1,
          this.simple,
        ),
      };
    });
  }
  private step(seconds: number): boolean {
    const time = this.time,
      simple = this.simple;
    let moving = false;
    this.lyrics.lines.forEach((line, index) => {
      if (line.words.length) return;
      const position = engine.lineWipe(
        line.start_ms,
        this.ends[index],
        time,
        simple,
      );
      if (!Number.isNaN(position) || this.wiping.has(index))
        this.wipe(index, position);
    });
    if (!simple) this.dropOldLayers();
    this.lyrics.lines.forEach((line, index) => {
      if (!line.words.length) return;
      const active = line.start_ms <= time && time < this.ends[index];
      let syllables = this.live.get(index);
      if (!active && !syllables) return;
      // After a seek back, lines not reached yet snap to their resting
      // styles instead of settling.
      if (syllables && time < line.start_ms) {
        this.release(index, syllables);
        return;
      }
      if (!syllables) {
        syllables = this.build(index);
        if (!syllables) return;
        this.live.set(index, syllables);
        if (!simple) {
          this.layered.delete(index);
          // Its text keeps its own layer until it rests, as a line ending
          // otherwise redraws mid-spring and its words jump.
          this.line(index)?.setAttribute("data-settling", "");
        }
      }
      let awake = false;
      for (const syllable of syllables) {
        awake = syllable.motion.step(time, seconds, this.reduceMotion) || awake;
        const values = syllable.motion.values();
        syllable.pieces.forEach((piece, part) =>
          show(piece, values, part * VALUES),
        );
      }
      moving ||= awake;
      if (!awake && !active) this.release(index, syllables, !simple);
    });
    return moving;
  }
}
