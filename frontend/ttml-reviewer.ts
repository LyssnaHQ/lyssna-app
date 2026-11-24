import { emptyState } from "./state";
import type { Settings } from "./types";

export type ReviewerMode = "off" | "temporary" | "always";

const DEFAULT_KEYS = [
  "lyric_size",
  "lyric_font",
  "lyric_offset_ms",
  "lyrics_early_scroll",
  "lyrics_early_scroll_ms",
  "lyrics_smooth_scroll",
  "lyrics_simple",
  "lyrics_minimal",
  "lyrics_keep_overlaps",
  "lyrics_line_hover",
  "lyrics_wide_duet",
  "lyrics_credits_follow",
  "space_gravity",
  "lyrics_highlighter",
  "lyrics_word_filter",
  "experimental_word_sync",
  "romanized",
  "lyrics_translations",
] as const satisfies readonly (keyof Settings)[];

const PROFILE: Partial<Settings> = {
  ...Object.fromEntries(
    DEFAULT_KEYS.map((key) => [key, emptyState.settings[key]]),
  ),
  lyric_song_offsets: {},
  lyrics_seek_compensation: false,
  lyrics_visualiser: false,
  lyrics_up_next: false,
};

// Temporary and session loads leave no trace on the lyrics themselves, so the
// window remembers which song it loaded one for.
let temporaryUri: string | undefined;

export function markTemporaryLoad(uri: string | undefined) {
  temporaryUri = uri;
}

export function clearTemporaryLoad(uri: string | undefined) {
  if (uri && uri === temporaryUri) temporaryUri = undefined;
}

/** Display settings for reviewing a TTML: defaults for everything that
 *  changes how lyrics are timed or drawn. */
export function reviewerSettings(
  settings: Settings,
  uri: string | undefined,
  source: string | undefined,
  draft = false,
  /** Reviewer mode turned on or off from the draft banner. */
  forced?: boolean,
): Settings {
  if (forced !== undefined)
    return forced ? { ...settings, ...PROFILE } : settings;
  const mode = settings.ttml_reviewer ?? "off";
  const temporary =
    draft || (!!uri && uri === temporaryUri && !!source?.startsWith("Local "));
  const active =
    mode === "temporary"
      ? temporary
      : mode === "always" && (draft || !!source?.startsWith("Local "));
  return active ? { ...settings, ...PROFILE } : settings;
}
