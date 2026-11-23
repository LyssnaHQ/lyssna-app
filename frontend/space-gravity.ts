/*
 * Space Gravity physics: words drift as bodies in zero gravity.
 *
 * The physics runs in the Rust lyric engine (crates/lyric-engine/src/gravity.rs),
 * ported from the pixels-spicy-lyrics fork's Space Gravity mode
 * (src/utils/Lyrics/SpaceGravity.ts, 100.10.54, AGPL-3.0). This module only
 * moves bodies to and from the engine. No DOM access lives here.
 */

import * as engine from "./lyric-engine";
import type { AnimatedWord } from "./lyric-motion";
import type { Word } from "./types";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Bounds {
  width: number;
  height: number;
}
/** Where words may float: the stage, the play area inside it, the artwork
 * they shrink beside, other blockers, and the credits footer below. */
export interface Field {
  bounds: Bounds;
  area?: Rect;
  /** Where lines are laid out before their words float: the lyrics column,
   * even when words may roam the whole page over Canvas. */
  layout?: Rect;
  cover?: Rect;
  blockers?: Rect[];
  footer?: Rect;
}
export interface Body {
  seed: number;
  /** Line start and position across shown words, for seeded bounces. */
  lineStart: number;
  order: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  bounces: number;
  speed: number;
  width: number;
  height: number;
  baseRadius: number;
  radius: number;
  scale: number;
  naturalX: number;
  naturalY: number;
}

/** Values the view itself lays out with; the rest live in the engine. */
export const GRAVITY = {
  edgePadding: 18,
  maxWpmMultiplier: 1.75,
  minVisibleWords: 12,
  maxVisibleWords: 120,
  presenceFadeMs: 180,
};

const KEYS = [
  "seed",
  "lineStart",
  "order",
  "x",
  "y",
  "vx",
  "vy",
  "angle",
  "spin",
  "bounces",
  "speed",
  "width",
  "height",
  "baseRadius",
  "radius",
  "scale",
  "naturalX",
  "naturalY",
] as const satisfies readonly (keyof Body)[];
const VALUES = KEYS.length;

function pack(bodies: Body[]) {
  const values = new Float64Array(bodies.length * VALUES);
  bodies.forEach((body, index) => {
    for (let key = 0; key < VALUES; key += 1)
      values[index * VALUES + key] = body[KEYS[key]];
  });
  return values;
}

/** Writes engine values back in place, keeping any extra view state. */
function unpack(bodies: Body[], values: ArrayLike<number>, from = 0) {
  bodies.forEach((body, index) => {
    for (let key = 0; key < VALUES; key += 1)
      body[KEYS[key]] = values[from + index * VALUES + key];
  });
}

const rectValues = (rect: Rect | undefined) =>
  rect ? [rect.left, rect.top, rect.right, rect.bottom] : [NaN, NaN, NaN, NaN];

function fieldValues(field: Field) {
  return Float64Array.from([
    field.bounds.width,
    field.bounds.height,
    ...rectValues(field.area),
    ...rectValues(field.layout),
    ...rectValues(field.cover),
    ...rectValues(field.footer),
    ...(field.blockers ?? []).flatMap(rectValues),
  ]);
}

/** FNV-1a string hash, for stable per-word randomness. */
export const hash = (value: string) => engine.gravityHash(value);

/** Deterministic random number in [0, 1) from a seed. */
export const random = (seed: number) => engine.gravityRandom(seed);

/** Faster lines drift faster: 1x up to 60 wpm, 1.75x from 180 wpm. */
export const speedMultiplier = (wordStartsMs: number[]) =>
  engine.speedMultiplier(Float64Array.from(wordStartsMs));

export function createBody(
  seed: number,
  speed: number,
  lineStart = 0,
  order = 0,
): Body {
  const body = {} as Body;
  unpack([body], engine.createBody(seed, speed, lineStart, order));
  return body;
}

/** Collision circle for a word box, with room for glyph overhang. */
export function measure(body: Body, width: number, height: number) {
  unpack([body], engine.measureBody(pack([body]), width, height));
}

export const intersects = (body: Body, rect: Rect | undefined) =>
  !!rect &&
  engine.bodyIntersects(pack([body]), Float64Array.from(rectValues(rect)));

/** Keeps a body inside the play area, beside the artwork and blockers and
 * above the footer. */
export function constrain(body: Body, field: Field) {
  unpack([body], engine.constrainBody(pack([body]), fieldValues(field)));
}

/** Smoothed window velocity in CSS pixels per second. */
export interface WindowMotion {
  x?: number;
  y?: number;
  vx: number;
  vy: number;
}
export function trackWindow(
  motion: WindowMotion,
  position: { x: number; y: number } | undefined,
  dt: number,
) {
  if (!position) return;
  const [x, y, vx, vy] = engine.trackWindow(
    Float64Array.from([motion.x ?? NaN, motion.y ?? NaN, motion.vx, motion.vy]),
    position.x,
    position.y,
    dt,
  );
  Object.assign(motion, { x, y, vx, vy });
}

/** Advances shown words by dt seconds. Words fading out still feel window
 * throws but otherwise stay where they are. */
export function step(
  bodies: Body[],
  dt: number,
  field: Field,
  window: WindowMotion = { vx: 0, vy: 0 },
  exiting: Body[] = [],
) {
  const values = engine.stepBodies(
    pack(bodies),
    dt,
    fieldValues(field),
    window.vx,
    window.vy,
    pack(exiting),
  );
  unpack(bodies, values);
  unpack(exiting, values, bodies.length * VALUES);
}

/** How deep two rotated word boxes overlap. */
export const spawnOverlap = (body: Body, other: Body) =>
  engine.spawnOverlap(pack([body]), pack([other]));

/** Places a new word near its spot in the line, clear of words already on
 * screen where there is room. */
export function spawn(
  body: Body,
  occupied: Body[],
  field: Field,
  reduced = false,
  rand = Math.random,
) {
  const across = rand(),
    down = rand(),
    phase = rand();
  unpack(
    [body],
    engine.spawnBody(
      pack([body]),
      pack(occupied),
      fieldValues(field),
      reduced,
      across,
      down,
      phase,
    ),
  );
}

/** Reduced motion: shown lines sit centred and still, one row each. */
export function staticLayout(lines: Body[][], field: Field) {
  const all = lines.flat();
  unpack(
    all,
    engine.staticLayout(
      pack(all),
      Uint32Array.from(lines, (line) => line.length),
      fieldValues(field),
    ),
  );
}

/** How many lead words fit the play area left free by artwork and credits. */
export const visibleWordCount = (field: Field) =>
  engine.visibleWordCount(fieldValues(field));

/** The run of `count` words centred on `anchor` within `total`. */
export function wordWindow(anchor: number, total: number, count: number) {
  const values = engine.wordWindow(anchor, total, count);
  return values.length ? { first: values[0], last: values[1] } : undefined;
}

/** Each word's place when its line is laid out in the play area: rows wrap
 * at the area's width and duet lines sit at the right. Returns centres
 * relative to the line top. */
export function lineLayout(
  sizes: { width: number; height: number }[],
  width: number,
  opposite = false,
  /** Space between words and rows; spread lines are also centred. */
  gap = 0,
) {
  const values = engine.lineLayout(
    Float64Array.from(sizes.flatMap((size) => [size.width, size.height])),
    width,
    opposite,
    gap,
  );
  return {
    places: sizes.map((_, index) => ({
      x: values[index * 2],
      y: values[index * 2 + 1],
    })),
    height: values[sizes.length * 2],
  };
}

const PIECE_VALUES = 9;

/**
 * One floating piece per hyphen-joined part, like Spicy Lyrics: "eye-eye-eyes"
 * floats as three words. Pieces sung as one timed word share its time by
 * letter count.
 */
export function gravityPieces(group: Word[]) {
  const split = new engine.GravityPieces(
    group.map((word) => word.text),
    Float64Array.from(
      group.flatMap((word) => [
        word.start_ms,
        word.end_ms,
        word.estimated ? 1 : 0,
      ]),
    ),
  );
  const texts = split.texts(),
    values = split.values();
  split.free();
  return texts.map((text, index) => {
    const at = index * PIECE_VALUES;
    const [
      start,
      end,
      first,
      count,
      parted,
      wordStart,
      wordEnd,
      offset,
      letters,
    ] = values.slice(at, at + PIECE_VALUES);
    const words: AnimatedWord[] = parted
      ? [
          {
            ...group[first],
            text,
            start_ms: wordStart,
            end_ms: wordEnd,
            letterOffset: offset < 0 ? undefined : offset,
            letterCount: letters < 0 ? undefined : letters,
          },
        ]
      : group
          .slice(first, first + count)
          .map((word, part) =>
            part ? word : { ...word, text: word.text.trimStart() },
          );
    return { text, start, end, words };
  });
}
