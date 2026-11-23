// Lyric timing and motion run in Rust (crates/lyric-engine), compiled to
// WebAssembly. This module keeps the shapes the lyrics views use.
import type { Word, Line } from "./types";
import {
  animatorValues,
  idleScale,
  presetOf,
  type AnimatorSettings,
} from "./animator-tuning";
import * as engine from "./lyric-engine";

export interface AnimatedWord extends Word {
  /** A floating fragment keeps its place in the original held word. */
  letterOffset?: number;
  letterCount?: number;
}

export function vocalEnd(line: Line) {
  return engine.vocalEnd(
    line.end_ms,
    Float64Array.from(line.words ?? [], (word) => word.end_ms),
  );
}

export interface VocalGap {
  opposite?: boolean;
  start: number;
  end: number;
  after: number;
}

/** A dot waiting its turn, outside Simple lyrics mode. */
export const DORMANT_DOT_OPACITY = 0.35;
/** The fork finishes dots before the next vocal, leaving time to contract. */
export const COUNTDOWN_TAIL_MS = 550;
export const countdownVisible = (gap: VocalGap, time: number) =>
  engine.countdownVisible(gap.start, gap.end, time);

export interface CountdownDot {
  opacity: number;
  scale: number;
  glow: number;
  lift: number;
}

const dotsOf = (values: ArrayLike<number>): CountdownDot[] =>
  Array.from({ length: Math.floor(values.length / 4) }, (_, index) => ({
    opacity: values[index * 4],
    scale: values[index * 4 + 1],
    glow: values[index * 4 + 2],
    lift: values[index * 4 + 3],
  }));

export function countdownDots(
  gap: VocalGap,
  time: number,
  reduceMotion = false,
): CountdownDot[] {
  return dotsOf(engine.countdownDots(gap.start, gap.end, time, reduceMotion));
}

/** Eases countdown dots toward their targets. Jumps in song time (a seek, a
 * new gap) and reduced motion snap straight to the target. */
export class CountdownSprings {
  private springs = new engine.Countdown();
  frame(
    targets: CountdownDot[],
    time: number,
    now: number,
    snap = false,
  ): CountdownDot[] {
    const flat = Float64Array.from(
      targets.flatMap((dot) => [dot.opacity, dot.scale, dot.glow, dot.lift]),
    );
    return dotsOf(this.springs.frame(flat, time, now, snap));
  }
}

// Views ask for the gap every frame; flattening a song's lines once is enough.
const flattened = new WeakMap<Line[], Float64Array>();
function flat(lines: Line[]) {
  let values = flattened.get(lines);
  if (!values) {
    const numbers: number[] = [];
    for (const line of lines) {
      const words = line.words ?? [];
      numbers.push(
        line.start_ms,
        line.end_ms,
        line.opposite === undefined ? -1 : line.opposite ? 1 : 0,
        words.length,
        ...words.map((word) => word.end_ms),
      );
    }
    values = Float64Array.from(numbers);
    flattened.set(lines, values);
  }
  return values;
}

const gapOf = (values: ArrayLike<number>, at: number): VocalGap => ({
  start: values[at],
  end: values[at + 1],
  after: values[at + 2],
  opposite: values[at + 3] < 0 ? undefined : values[at + 3] === 1,
});

export function vocalGaps(lines: Line[]): VocalGap[] {
  const values = engine.vocalGaps(flat(lines));
  return Array.from({ length: values.length / 4 }, (_, index) =>
    gapOf(values, index * 4),
  );
}

export function vocalGap(lines: Line[], time: number) {
  const values = engine.vocalGap(flat(lines), time);
  return values.length ? gapOf(values, 0) : undefined;
}

/** After a restart or long seek, lyrics slide to the new line over this long
 * instead of springing through the whole song. */
export const GLIDE_MS = 700;
export const glideScroll = (from: number, to: number, elapsed: number) =>
  engine.glideScroll(from, to, elapsed);
export interface ScrollSpring {
  position: number;
  velocity: number;
  target: number;
}
export function stepScroll(spring: ScrollSpring, seconds: number): number {
  const [position, velocity] = engine.stepScroll(
    spring.position,
    spring.velocity,
    spring.target,
    seconds,
  );
  spring.position = position;
  spring.velocity = velocity;
  return position;
}

export { Spring } from "./lyric-engine";

/** Natural cubic spline through `points`. */
export function naturalSpline(points: readonly (readonly [number, number])[]) {
  const spline = new engine.Spline(Float64Array.from(points.flat()));
  return (x: number) => spline.at(x);
}

const curve = (which: number) => (x: number) => engine.motionCurve(which, x);
const setting = (index: number) => engine.motionSettings()[index];

/** Animation curves over a syllable's progress and the springs that chase
 * them, as the engine holds them. `tuneMotion` changes them. */
export const MOTION = {
  scale: curve(0),
  letterScale: curve(1),
  lift: curve(2),
  letterLift: curve(3),
  glow: curve(4),
  /** Frequency in hertz and damping ratio. */
  get springs() {
    const values = engine.motionSettings();
    return {
      scale: [values[6], values[7]] as [number, number],
      lift: [values[8], values[9]] as [number, number],
      glow: [values[10], values[11]] as [number, number],
    };
  },
  get idleScale() {
    return setting(0);
  },
  get sungLetterGlow() {
    return setting(1);
  },
  get emphasisTailMs() {
    return setting(2);
  },
  get leadMs() {
    return setting(3);
  },
  get blurPerLine() {
    return setting(4);
  },
  get maxBlur() {
    return setting(5);
  },
};

/** Applies an animator preset as the fork's rebuildAnimatorTuning. */
export function tuneMotion(settings: AnimatorSettings = {}) {
  const tuning = animatorValues(settings);
  engine.tuneMotion(
    presetOf(settings) === "Legacy",
    idleScale(settings),
    tuning.wordPeakScale,
    tuning.letterPeakScale,
    tuning.verticalStrength,
    tuning.glowStrength,
    tuning.scaleFrequency,
    tuning.scaleDamping,
    tuning.verticalFrequency,
    tuning.verticalDamping,
    tuning.glowFrequency,
    tuning.glowDamping,
    tuning.blurStrength,
  );
}

export type SungState = "unsung" | "active" | "sung";
const STATES: SungState[] = ["unsung", "active", "sung"];
export const sungState = (start: number, end: number, time: number) =>
  STATES[engine.sungState(start, end, time)];

export interface SyllableGoal {
  scale: number;
  /** Vertical offset in em; negative is up. */
  lift: number;
  /** Glow strength, 0 to 1. */
  glow: number;
  /** Leading edge of the sung gradient, in percent of the syllable width. */
  gradient: number;
}
export const goalsOf = (values: ArrayLike<number>): SyllableGoal[] =>
  Array.from({ length: Math.floor(values.length / 4) }, (_, index) => ({
    scale: values[index * 4],
    lift: values[index * 4 + 1],
    glow: values[index * 4 + 2],
    gradient: values[index * 4 + 3],
  }));

export const wordGoal = (start: number, end: number, time: number) =>
  goalsOf(engine.wordGoal(start, end, time))[0];

/** Letters of a held word share its time evenly. The sung letter pops and its
 * neighbours follow with a steep falloff; letters lift twice as far. */
export const letterGoals = (
  start: number,
  end: number,
  time: number,
  count: number,
) => goalsOf(engine.letterGoals(start, end, time, count));

/** Text-shadow blur, in pixels, for a line `distance` lines from the active
 * one. */
export const lineBlur = (distance: number) => engine.lineBlur(distance);

/** Held syllables animate letter by letter. */
export const isEmphasis = (word: Word, text: string) =>
  engine.isEmphasis(word.start_ms, word.end_ms, text, word.estimated ?? false);

/** Preserve per-syllable timing while keeping split words in one layout box. */
export function wordGroups(words: Word[]): Word[][] {
  const sizes = engine.wordGroupSizes(words.map((word) => word.text));
  const groups: Word[][] = [];
  let at = 0;
  for (const size of sizes) {
    groups.push(words.slice(at, at + size));
    at += size;
  }
  return groups;
}
