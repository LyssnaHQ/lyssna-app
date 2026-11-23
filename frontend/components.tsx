import { contextName } from "./playing-context";
import { fillFromKnown, knownTracks } from "./queue-fill";
import { IS_MAC } from "./platform";
import {
  memo,
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { artworkFor, isLocalCover } from "./artwork";
import { LyricsCanvas } from "./canvas-lyrics";
import { SpaceGravityLyrics } from "./space-gravity-lyrics";
import { displayLyrics } from "./word-sync";
import { romanizeFor, useRomanization } from "./romanization";
import { filterWords } from "./word-filter";
import { frameDue } from "./frame-cap";
import { useArtworkColor } from "./artwork-color";
import {
  Music2,
  Maximize2,
  Upload,
  RotateCw,
  Mic2,
  FilePenLine,
  MessagesSquare,
  CirclePlus,
  CircleCheck,
  ChevronUp,
  ChevronDown,
  X,
  PanelLeftOpen,
  UnfoldVertical,
  FoldVertical,
  Copy,
  UserRound,
} from "lucide-react";
import { Toggle } from "./setting-row";
import { VolumeControl } from "./volume-control";
import {
  FullscreenHeartIcon,
  FullscreenPauseIcon,
  FullscreenPlayIcon,
  FullscreenRepeatIcon,
  FullscreenShuffleIcon,
  FullscreenVolumeIcon,
  SkipNextIcon,
  SkipPreviousIcon,
} from "./fullscreen-icons";
import { DJArtwork, DJ_COVER } from "./brand";
import { DJVoiceRing } from "./dj-voice-ring";
import type {
  Album,
  Artist,
  Contributor,
  LyssnaCredit,
  Track,
  PlayerRequest,
  Lyrics,
  Settings,
  Line,
  Jam,
} from "./types";
import type { AppState } from "./state";
import { formatTime } from "./state";
import { PlaybackClock } from "./playback-clock";
import { rpc } from "./bridge";
import { useMotionCover } from "./motion-cover";
import { CreditsDialog } from "./credits-dialog";
import {
  PROFILE_WINDOW,
  creatorEmbed,
  useCreatorProfile,
} from "./creator-profile";
import {
  linesOf,
  vocalGaps,
  type VocalGap,
  wordGroups,
  vocalGap,
  lineBlur,
  tuneMotion,
} from "./lyric-motion";
import * as engine from "./lyric-engine";
import { LyricAnimator } from "./lyric-animator";
import { HighlighterWords, markerColour } from "./highlighter";
import { LyricWord } from "./lyric-word";
import { LyricCountdown } from "./lyric-countdown";
import { useDiscordUsername } from "./discord";
import { lyricOffset } from "./lyric-offset";

/** Artwork is HTTPS, a local JPEG preview of a cover being saved, or a
 * Local Files cover. */
export const usableImage = (url: string) =>
  url.startsWith("https://") ||
  url.startsWith("data:image/jpeg;base64,") ||
  isLocalCover(url);
export const imageOf = (images?: { url: string }[]) =>
  images?.find((image) => usableImage(image.url))?.url;
export const artistNames = (track?: Track) =>
  track?.artists.map((artist) => artist.name).join(", ") ?? "";
// Cover sizes are read during layout effects and applied together after
// them, so setting one image's src never forces layout for the next read.
const pendingSources: [HTMLImageElement, string][] = [];
function setSourceSoon(element: HTMLImageElement, url: string) {
  if (!pendingSources.length)
    queueMicrotask(() => {
      for (const [image, source] of pendingSources.splice(0))
        if (image.getAttribute("src") !== source) image.src = source;
    });
  pendingSources.push([element, url]);
}
/** Hero title size tier: longer names step down, like Spotify's headers. */
export const titleSize = (title: string) =>
  title.length > 28 ? "long-title" : title.length > 14 ? "medium-title" : "";

/** Whether track artwork crossfades on change: Cover Art Animation. */
export const coverFade = (settings: Settings) =>
  settings.cover_animation !== false && !settings.reduce_motion;

export function Cover({
  images,
  className = "",
  onClick,
  contextRoute,
  contextName,
  fade = false,
  motion,
}: {
  images?: { url: string; width?: number | null }[];
  className?: string;
  onClick?: () => void;
  contextRoute?: string;
  contextName?: string;
  /** Crossfade from the old artwork when it changes (Cover Art Animation). */
  fade?: boolean;
  /** An animated cover video that plays over the artwork once it can. */
  motion?: string | null;
}) {
  const src = imageOf(images);
  const picture = useRef<HTMLImageElement>(null);
  const attempted = useRef(new Set<string>());
  const [failed, setFailed] = useState(false);
  // The artwork being replaced, held over the new one until it has loaded.
  const [previous, setPrevious] = useState<{ url: string; fading: boolean }>();
  const sources = images?.map((image) => image.url).join(" ");
  // Load the smallest Spotify size that fills the laid-out cover. Set here,
  // not through srcset/sizes="auto": Chromium keeps every image with
  // sizes="auto" (and its page) alive after it leaves the page.
  useLayoutEffect(() => {
    attempted.current.clear();
    setFailed(false);
    const element = picture.current;
    if (!element) return;
    if (fade && element.complete && element.currentSrc)
      setPrevious({ url: element.currentSrc, fading: false });
    const parent = element.parentElement;
    const width = parent?.clientWidth ?? 0;
    let widest = width ? Math.ceil(width * devicePixelRatio) : 0;
    const url = artworkFor(images, widest || undefined);
    if (url) {
      attempted.current.add(url);
      setSourceSoon(element, url);
    }
    if (!parent) return;
    // A cover laid out small (a compact view) and then enlarged needs a
    // bigger size; it never steps down.
    const observer = new ResizeObserver(([entry]) => {
      const pixels = Math.ceil(entry.contentRect.width * devicePixelRatio);
      if (pixels <= widest) return;
      widest = pixels;
      const bigger = artworkFor(images, pixels);
      if (!bigger || element.getAttribute("src") === bigger) return;
      attempted.current.add(bigger);
      setSourceSoon(element, bigger);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [sources]);
  const inner = src ? (
    <>
      <img
        ref={picture}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        style={failed ? { display: "none" } : undefined}
        onLoad={() =>
          setPrevious((old) => old && { url: old.url, fading: true })
        }
        onError={(event) => {
          const next = images?.find(
            (image) =>
              usableImage(image.url) && !attempted.current.has(image.url),
          )?.url;
          if (next) {
            attempted.current.add(next);
            event.currentTarget.src = next;
          } else {
            setFailed(true);
            setPrevious(undefined);
          }
        }}
      />
      {previous && (
        <img
          className={`cover-previous ${previous.fading ? "fading" : ""}`}
          src={previous.url}
          alt=""
          draggable={false}
          onAnimationEnd={() => setPrevious(undefined)}
        />
      )}
      {failed && <Music2 aria-hidden="true" />}
      {motion && <MotionVideo key={motion} url={motion} />}
    </>
  ) : (
    <Music2 aria-hidden="true" />
  );
  return onClick ? (
    <button
      className={`cover ${className}`}
      onClick={onClick}
      aria-label="Open album"
      data-context-route={contextRoute}
      data-context-name={contextName}
    >
      {inner}
    </button>
  ) : (
    <div
      className={`cover ${className}`}
      data-context-route={contextRoute}
      data-context-name={contextName}
    >
      {inner}
    </div>
  );
}
import { Ambience } from "./ambience";
import { LyricsVisualiser } from "./lyrics-visualiser";
export { Ambience };

// Plays only while on screen and the window is visible, and stays hidden
// until its first frame so the still artwork never flashes black.
export function MotionVideo({ url }: { url: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    // Set here rather than as a prop so the cleanup's release can be undone.
    element.src = url;
    let visible = false;
    const update = () => {
      if (visible && !document.hidden) void element.play().catch(() => {});
      else element.pause();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  if (failed) return null;
  return (
    <video
      ref={video}
      className={`cover-motion${shown ? " shown" : ""}`}
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
      onPlaying={() => setShown(true)}
      onError={() => setFailed(true)}
    />
  );
}

export function Marquee({
  children,
  text,
  className = "",
  reduceMotion = false,
}: {
  children: ReactNode;
  text: string;
  className?: string;
  reduceMotion?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const update = () =>
      setOverflow(
        Math.max(
          0,
          (content.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0),
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    if (box.current) observer.observe(box.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div
      className={`marquee ${overflow > 2 && !reduceMotion ? "scrolling" : ""} ${className}`}
      ref={box}
      title={overflow > 2 ? text : undefined}
      style={
        {
          "--travel": `${overflow}px`,
          "--duration": `${Math.max(20, (overflow * 2) / 14 + 10)}s`,
        } as CSSProperties
      }
    >
      <div key={text} className="marquee-content" ref={content}>
        {children}
      </div>
    </div>
  );
}
// Load a page while the pointer rests on its link so opening it is instant.
// One background load at a time so it never delays a real click.
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let lastPrefetch = 0;
const prefetched = new Set<string>();
export function prefetchPage(key: string) {
  clearTimeout(hoverTimer);
  if (prefetched.has(key)) return;
  hoverTimer = setTimeout(() => {
    if (Date.now() - lastPrefetch < 1200) return;
    lastPrefetch = Date.now();
    prefetched.add(key);
    if (prefetched.size > 200) prefetched.clear();
    void rpc("prefetch_page", { key }).catch(() => prefetched.delete(key));
  }, 180);
}
export const cancelPrefetch = () => clearTimeout(hoverTimer);

const decodedImages = new Set<string>();
const imageLoads = new Map<string, Promise<boolean>>();
export function preloadImage(url?: string): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  if (decodedImages.has(url)) return Promise.resolve(true);
  const existing = imageLoads.get(url);
  if (existing) return existing;
  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    const finish = (success: boolean) => {
      image.onload = null;
      image.onerror = null;
      imageLoads.delete(url);
      if (success) {
        decodedImages.add(url);
        if (decodedImages.size > 512)
          decodedImages.delete(decodedImages.values().next().value!);
      }
      resolve(success);
    };
    image.onload = () => {
      void image
        .decode()
        .catch(() => {})
        .then(() => finish(true));
    };
    image.onerror = () => finish(false);
    image.src = url;
  });
  imageLoads.set(url, request);
  return request;
}
export function useLoadedImage(url?: string) {
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void preloadImage(url).then((success) => {
      if (success && !cancelled) setLoaded(url);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return loaded === url || (url && decodedImages.has(url)) ? url : undefined;
}

/**
 * Like useLoadedImage, but while a replacement for the same `key` decodes
 * (or the URL briefly disappears) it keeps returning the last decoded image,
 * so refreshed metadata does not flash an empty background.
 */
export function useStickyLoadedImage(url: string | undefined, key: string) {
  const loaded = useLoadedImage(url);
  const [last, setLast] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (loaded) setLast({ key, url: loaded });
  }, [loaded, key]);
  return loaded ?? (last?.key === key ? last.url : undefined);
}

export const ArtistLinks = memo(function ArtistLinks({
  artists,
  onArtist,
}: {
  artists: Artist[];
  onArtist: (artist: Artist) => void;
}) {
  return (
    <>
      {artists.map((artist, index) => (
        <span key={artist.id ?? `${artist.name}-${index}`}>
          {index > 0 && <span className="artist-separator">, </span>}
          <button
            className="text-link artist-link"
            data-context-route={artist.id ? `artist:${artist.id}` : undefined}
            data-context-name={artist.name}
            onClick={() => onArtist(artist)}
            onMouseEnter={() =>
              artist.id && prefetchPage(`artist:${artist.id}`)
            }
            onMouseLeave={cancelPrefetch}
          >
            {artist.name}
          </button>
        </span>
      ))}
    </>
  );
});
/** Songwriter credit as Spicy Lyrics shows it: a dim label, then the
 * names a little brighter. Without names, Spicy Lyrics omits the line. */
function WriterCredits({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <p className="writer-credits">
      <span className="credit-label">Written by</span>{" "}
      <span className="credit-names">{names.join(", ")}</span>
    </p>
  );
}
/** The badge's E is drawn, not typed: a font's ascent and pixel rounding
 * left a typed E off centre at small sizes. */
export const EXPLICIT_MARK = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.3 3.7h5.2v1.6H6.9v1.9h3.3v1.6H6.9v1.9h3.6v1.6H5.3z" />
  </svg>
);
/** Spotify's mint verified badge, its tick cut out so the background shows
 * through. */
export function VerifiedBadge({ label }: { label?: string }) {
  const mask = useId();
  return (
    <svg
      className="verified-badge"
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <mask id={mask}>
        <rect width="24" height="24" fill="#fff" />
        <path
          d="m8.5 12 2.5 2.5 4.5-5"
          fill="none"
          stroke="#000"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </mask>
      <path
        mask={`url(#${CSS.escape(mask)})`}
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
      />
    </svg>
  );
}

export function ExplicitBadge({ track }: { track: Track }) {
  return track.explicit ? (
    <span className="explicit-badge" aria-label="Explicit" title="Explicit">
      {EXPLICIT_MARK}
    </span>
  ) : null;
}
export const TrackTitle = memo(function TrackTitle({
  track,
  onAlbum,
  reduceMotion = false,
  className = "",
}: {
  track: Track;
  onAlbum: (album: Album) => void;
  reduceMotion?: boolean;
  className?: string;
}) {
  return (
    <Marquee
      text={track.name}
      className={className}
      reduceMotion={reduceMotion}
    >
      <button
        className="text-link song-title"
        data-context-route={track.id ? `track:${track.id}` : undefined}
        onClick={() => onAlbum(track.album)}
      >
        {track.name}
      </button>
    </Marquee>
  );
});

export function usePosition(
  state: Pick<AppState, "playback" | "observed_at" | "clock_revision"> &
    Partial<Pick<AppState, "local_device_name" | "playback_rate">>,
  stepMs = 0,
) {
  return usePlaybackClock(state, stepMs).position;
}

export function usePlaybackClock(
  state: Pick<AppState, "playback" | "observed_at" | "clock_revision"> &
    Partial<Pick<AppState, "local_device_name" | "playback_rate">>,
  stepMs = 0,
) {
  const clock = useRef(new PlaybackClock());
  const [time, setTime] = useState(performance.now());
  const native = state.local_device_name
    ? state.playback.device.name === state.local_device_name
    : true;
  const now = performance.now();
  clock.current.observe(
    state.playback,
    state.observed_at,
    state.clock_revision,
    now,
    Date.now(),
    native,
    native ? (state.playback_rate ?? 1) : 1,
  );
  useEffect(() => {
    setTime(performance.now());
    if (!state.playback.is_playing) return;
    let frame = 0,
      shown = 0,
      step = -1;
    const tick = (time: number) => {
      const due = stepMs
        ? Math.floor(clock.current.read(time) / stepMs) !== step
        : frameDue(shown, time);
      if (due) {
        shown = time;
        if (stepMs) step = Math.floor(clock.current.read(time) / stepMs);
        setTime(time);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.playback.is_playing, stepMs]);
  const read = useCallback((at?: number) => {
    const now = performance.now();
    return at === undefined
      ? clock.current.read(now)
      : clock.current.readAgo(now, now - at);
  }, []);
  const shown = Math.max(time, now);
  return {
    position: clock.current.read(shown),
    wait: clock.current.wait(shown),
    read,
  };
}

/** The song position lyrics follow: below zero while a held song waits. */
export function useLyricPosition(
  state: Parameters<typeof usePlaybackClock>[0] & Pick<AppState, "settings">,
) {
  const { position, wait } = usePlaybackClock(state);
  return (
    position - wait + lyricOffset(state.settings, state.playback.item?.uri)
  );
}

/** A clicked Space Gravity word starts this far early, so a device's
 *  fade-in after a seek ends as it begins. */
const SEEK_FADE_LEAD_MS = 300;
const lyricSeekTarget = (ms: number) => Math.max(0, ms - SEEK_FADE_LEAD_MS);
export function LyricsDisplay({
  lyrics,
  positionMs,
  playing = true,
  settings,
  onSeek,
  compact = false,
  writers = [],
  upNext,
}: {
  lyrics: Lyrics;
  positionMs: number;
  playing?: boolean;
  settings: Settings;
  onSeek: (ms: number) => void;
  compact?: boolean;
  writers?: string[];
  /** Sits beside the credits at the end of the lyrics. */
  upNext?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [returnDirection, setReturnDirection] = useState<"up" | "down">("down");
  const footerMode = compact ? "off" : (settings.lyrics_pinned_footer ?? "off");
  const writerCredits = (
    <WriterCredits
      names={lyrics.songwriters?.length ? lyrics.songwriters : writers}
    />
  );
  // As in Spicy Lyrics, browsing ends on its own once the user stops
  // scrolling with the current lyric still on screen; scrolled away from
  // it, browsing stays until they return or select a lyric.
  const scroller = useMemo(() => new engine.Scroller(), []);
  const browsedAt = useRef(0);
  const browse = () => {
    scroller.stopGlide();
    browsedAt.current = performance.now();
    setFollowing(false);
  };
  const lines = useRef<(HTMLButtonElement | null)[]>([]);
  const seek = useRef(onSeek);
  useLayoutEffect(() => {
    seek.current = onSeek;
  }, [onSeek]);
  // A line clicked while paused stays the current line, unsung, until play
  // resumes or the song moves elsewhere.
  const [pausedLine, setPausedLine] = useState<{
    line: Line;
    index: number;
    from: number;
  }>();
  const transport = useRef({ playing, positionMs });
  transport.current = { playing, positionMs };
  const selected =
    pausedLine &&
    lyrics.lines[pausedLine.index] === pausedLine.line &&
    engine.cueHolds(
      playing,
      positionMs,
      pausedLine.from,
      pausedLine.line.start_ms,
    )
      ? pausedLine.index
      : undefined;
  const cueLine = selected === undefined ? undefined : lyrics.lines[selected];
  const lyricTime = cueLine ? cueLine.start_ms - 1 : positionMs;
  useEffect(() => {
    if (pausedLine && selected === undefined) setPausedLine(undefined);
  }, [pausedLine, selected]);
  // Clock frames must not replace each button's native click listener or ref.
  const lineActions = useMemo(
    () =>
      lyrics.lines.map((line, index) => ({
        ref: (element: HTMLButtonElement | null) => {
          lines.current[index] = element;
        },
        click: () => {
          if (lyrics.synced) {
            seek.current(line.start_ms);
            const { playing, positionMs } = transport.current;
            if (!playing) setPausedLine({ line, index, from: positionMs });
            setFollowing(true);
          }
        },
      })),
    [lyrics],
  );
  const heldEnd = useRef<{ top: number; gap: number } | null>(null);
  /** The credits are in view at the scroll's target, so they hold. */
  const holdEnd = useRef(false);
  // Where held credits rest, noted wherever the scroll settles (not only
  // at the very end: the current line can hold the scroll above it), so
  // the first frames of the dots opening are corrected too. A scroll event
  // notes it only when none is known, and a spot the scroll still sits on
  // is kept, or growth read before it is corrected would be taken as rest.
  const noteHeldRest = (container: HTMLElement, settled: boolean) => {
    const above = container.querySelector(":scope > .lyric-end-credits")
      ?.previousElementSibling as HTMLElement | null | undefined;
    // Re-checked as the scroll moves: pinned credits left behind by a
    // scroll back up were drawn over the lines below them.
    if (above) {
      const rest = heldEnd.current;
      const anchored = !!rest && Math.abs(container.scrollTop - rest.top) < 2;
      container.toggleAttribute(
        "data-hold-end",
        holdEnd.current && (anchored || creditsInView(container, above)),
      );
    }
    if (!above || !container.hasAttribute("data-hold-end")) {
      heldEnd.current = null;
      return;
    }
    const held = heldEnd.current;
    if (held && (!settled || Math.abs(container.scrollTop - held.top) < 0.5))
      return;
    const viewport = container.getBoundingClientRect();
    const scale = viewport.height / container.clientHeight || 1;
    heldEnd.current = {
      top: container.scrollTop,
      gap: (viewport.bottom - above.getBoundingClientRect().bottom) / scale,
    };
  };
  const waiting = useRef<HTMLDivElement>(null);
  const gap =
    lyrics.synced && selected === undefined
      ? vocalGap(lyrics.lines, positionMs)
      : undefined;
  const gaps = useMemo(
    () => new Map(vocalGaps(lyrics.lines).map((item) => [item.after, item])),
    [lyrics],
  );
  const waitingDots = (item: VocalGap) => {
    const visible = gap?.start === item.start;
    return (
      <LyricCountdown
        key={item.start}
        ref={visible ? waiting : undefined}
        gap={item}
        // Song time only matters near the pause; held still elsewhere, a
        // countdown far off does not render again every frame.
        time={engine.countdownTime(item.start, item.end, positionMs)}
        reduceMotion={settings.reduce_motion}
        visible={visible}
      />
    );
  };
  // Early scroll follows the line about to be sung; highlighting still
  // follows the real song time.
  const scrollTime =
    lyricTime +
    (cueLine === undefined && settings.lyrics_early_scroll
      ? (settings.lyrics_early_scroll_ms ?? 200)
      : 0);
  const song = linesOf(lyrics.lines);
  const active = Array.from(song.activeLines(scrollTime));
  const primary = song.primaryLine(scrollTime, selected ?? -1);
  useEffect(() => {
    setFollowing(true);
  }, [lyrics]);
  // A restart, Previous or seek moves song time far in one step. Lyrics then
  // slide straight there instead of springing through the whole song.
  const lastPosition = useRef(lyricTime),
    jumped = useRef(false);
  const positionJumped = engine.positionJumped(lastPosition.current, lyricTime);
  if (positionJumped) jumped.current = true;
  lastPosition.current = lyricTime;
  const animator = useRef<LyricAnimator>(undefined);
  // New springs pick up the animator preset's curves and tuning.
  const tuning = JSON.stringify(settings.lyrics_animator ?? {});
  useLayoutEffect(() => {
    tuneMotion(JSON.parse(tuning));
    const instance = new LyricAnimator(
      lyrics,
      (index) => lines.current[index] ?? null,
      !!settings.reduce_motion,
      !!settings.lyrics_simple,
    );
    animator.current = instance;
    return () => instance.dispose();
  }, [lyrics, settings.reduce_motion, settings.lyrics_simple, tuning]);
  useLayoutEffect(() => {
    if (!lyrics.synced) return;
    if (positionJumped || cueLine) animator.current?.reset();
    animator.current?.update(lyricTime);
  }, [lyricTime, cueLine, lyrics, settings.reduce_motion]);
  // Romanization, translations or a word filter change only the words: the
  // view stays on the current line instead of sliding to where it rewraps.
  const timing = useMemo(
    () => lyrics.lines.map((line) => line.start_ms).join(","),
    [lyrics],
  );
  // The first placement, as the page opens or an effect switches, lands on
  // the current line at once rather than sliding up from the top.
  const placed = useRef(false);
  const wording = useRef({
    lyrics,
    timing,
    translations: settings.lyrics_translations,
  });
  useLayoutEffect(() => {
    const before = wording.current;
    let reworded =
      before.timing === timing &&
      (before.lyrics !== lyrics ||
        before.translations !== settings.lyrics_translations);
    wording.current = {
      lyrics,
      timing,
      translations: settings.lyrics_translations,
    };
    const container = scroll.current,
      line = gap ? waiting.current : lines.current[primary];
    if (!container || !line || !lyrics.synced) {
      scroller.velocity = 0;
      return;
    }
    let frame = 0,
      last = performance.now();
    scroller.position = container.scrollTop;
    const tick = (time: number) => {
      frame = 0;
      if (!frameDue(last, time)) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = time;
      container.scrollTop = scroller.tick(time);
      if (scroller.running) frame = requestAnimationFrame(tick);
      else noteHeldRest(container, true);
    };
    const retarget = () => {
      const stacked = container
        .closest(".lyrics-page")
        ?.classList.contains("narrow");
      // Playback follows the line's centre, independent of artwork. Wide
      // lyrics still begin above centre and stop at the padded credits.
      // The Now playing card starts right under its header and keeps one
      // faded line above the current one, as Spicy Lyrics' card does.
      // Expanded over the whole panel, it reads like the lyrics page: the
      // song starts a third down and the current line stays centred.
      const card = compact && !container.closest(".lyric-preview.expanded");
      const focus = engine.scrollFocus(card, container.clientHeight);
      const centred = !card;
      // Minimal lyrics in full screen begin lower, as in Spicy Lyrics.
      const opening =
        settings.lyrics_minimal && !compact && container.closest(".immersive")
          ? 0.4
          : 0.28;
      container.style.setProperty(
        "--lead-top",
        `${engine.leadTop(card, compact, !!stacked, container.clientHeight, opening, focus, lines.current[0]?.offsetHeight ?? 0)}px`,
      );
      scroller.target = engine.scrollTarget(
        line.offsetTop,
        line.offsetHeight,
        centred,
        focus,
        container.clientHeight,
        container.scrollHeight,
      );
      // Credits in view stay whole: when a pause's dots open near the end,
      // the lyrics move up rather than the credits being pushed off the
      // bottom. The current line still stays in view.
      const credits = container.querySelector<HTMLElement>(
        ":scope > .lyric-end-credits",
      );
      const end = container.scrollHeight - container.clientHeight;
      // Read from the row above: held credits are sticky, which moves
      // their own offsetTop.
      const above = credits?.previousElementSibling as HTMLElement | null;
      const holding =
        !!above &&
        above.offsetTop + above.offsetHeight <
          scroller.target + container.clientHeight;
      // The card keeps its faded line above the current one even here;
      // aiming at the line's top edge slid it to the very top and back.
      if (holding)
        scroller.target = engine.heldTarget(
          scroller.target,
          line.offsetTop,
          card,
          focus,
          end,
        );
      // The dots grow over half a second; a spring chasing them would let
      // the credits dip out of view first. Shifting in the same frame keeps
      // them still while the lyrics move up.
      // Measured from where the lyrics end, not the whole-pixel scroll
      // height, which lags the dots' fractional growth.
      const viewport = container.getBoundingClientRect();
      const scale = viewport.height / container.clientHeight || 1;
      const gap = () =>
        (viewport.bottom - above!.getBoundingClientRect().bottom) / scale;
      // The gap is kept from when the scroll rested, so rounding can't add
      // up while the dots keep growing.
      const held = heldEnd.current;
      const anchored =
        holding &&
        following &&
        !!held &&
        Math.abs(container.scrollTop - held.top) < 2;
      if (anchored) {
        const shift = held.gap - gap();
        if (shift > 0) {
          container.scrollTop += shift;
          scroller.position = container.scrollTop;
          scroller.shiftGlide(shift);
        }
      }
      // A pause opening above held credits only pushes the lyrics up; the
      // scroll stays where it rested rather than re-aiming at the dots.
      if (anchored && line === waiting.current)
        scroller.target = container.scrollTop;
      heldEnd.current = !holding
        ? null
        : anchored
          ? { top: container.scrollTop, gap: held.gap }
          : held;
      // Pinned only once the credits really sit in view: pinning them while
      // the scroll is still on its way, or in a card too short to reach
      // the target, drew them over the lines still below.
      holdEnd.current = holding;
      container.toggleAttribute(
        "data-hold-end",
        holding && (anchored || creditsInView(container, above!)),
      );
      if (!following) {
        scroller.velocity = 0;
        setReturnDirection(
          container.scrollTop > scroller.target ? "up" : "down",
        );
        return;
      }
      if (reworded || !placed.current) {
        placed.current = true;
        reworded = false;
        cancelAnimationFrame(frame);
        frame = 0;
        scroller.place();
        container.scrollTop = scroller.position;
        return;
      }
      // Smooth scrolling off: the browser's own smooth scroll, not the spring.
      const native = settings.lyrics_smooth_scroll === false;
      if (jumped.current && !settings.reduce_motion && !native)
        scroller.startGlide(container.scrollTop, performance.now());
      if (settings.reduce_motion || native) {
        container.scrollTo({
          top: scroller.target,
          behavior: native && !settings.reduce_motion ? "smooth" : "instant",
        });
        scroller.place();
      } else if (!frame) {
        last = performance.now();
        scroller.start(last);
        frame = requestAnimationFrame(tick);
      }
    };
    retarget();
    const observer = new ResizeObserver(retarget);
    observer.observe(container);
    observer.observe(line);
    container
      .querySelectorAll(".lyric-wait, :scope > .lyric-end-credits")
      .forEach((row) => observer.observe(row));
    const album = container
      .closest(".lyrics-page")
      ?.querySelector(".lyrics-album");
    if (album) observer.observe(album);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    primary,
    following,
    lyrics,
    settings.reduce_motion,
    settings.lyric_size,
    settings.romanized,
    settings.lyrics_translations,
    settings.lyrics_minimal,
    settings.lyrics_smooth_scroll,
    footerMode,
    gap?.start,
  ]);
  useLayoutEffect(() => {
    // Held until follow mode resumes, so a jump while browsing still glides.
    if (following) jumped.current = false;
  }, [positionMs, following]);
  useEffect(() => {
    if (following || !lyrics.synced) return;
    const container = scroll.current,
      line = lines.current[primary];
    if (!container || !line) return;
    const view = container.getBoundingClientRect(),
      box = line.getBoundingClientRect();
    if (
      engine.resumeFollowing(
        performance.now(),
        browsedAt.current,
        box.top,
        box.bottom,
        view.top,
        view.bottom,
      )
    )
      setFollowing(true);
  }, [positionMs, following, primary, lyrics.synced]);
  const highlighter = !!settings.lyrics_highlighter && lyrics.synced;
  if (lyrics.instrumental)
    return (
      <div className="lyrics-message">
        <Music2 />
        <h2>Instrumental</h2>
        <p>Enjoy the music</p>
        <LyricCredits
          lyrics={lyrics}
          discord={settings.lyrics_discord_usernames !== false}
        />
      </div>
    );
  return (
    <div
      className={`lyrics-display ${compact ? "compact" : ""} ${footerMode !== "off" ? "has-pinned-footer" : ""} ${!lyrics.synced ? "static-lyrics" : ""} ${settings.reduce_motion ? "reduce-motion" : ""} ${settings.lyrics_simple ? "simple-lyrics" : ""} ${settings.lyrics_right_align ? "lyrics-right" : ""} ${settings.lyrics_flip_duet ? "lyrics-flip-duet" : ""} ${settings.lyrics_wide_duet === false ? "" : "lyrics-wide-duet"} ${settings.lyrics_line_hover ? "lyrics-line-hover" : ""} ${lyrics.lines.some((line) => line.opposite) ? "has-duet" : ""} ${settings.lyrics_minimal && !compact ? "minimal" : ""} ${highlighter ? "highlighter" : ""} ${settings.lyrics_keep_overlaps !== false ? "keep-overlaps" : ""} ${lyrics.synced && song.allSung(lyricTime) ? "all-sung" : ""} ${settings.lyrics_credits_follow && song.endsOnRight(!!(settings.lyrics_flip_duet || settings.lyrics_right_align)) ? "credits-right" : ""}`}
      data-following={following}
      style={
        {
          ...(compact
            ? {}
            : {
                "--lyric-size": `${Math.round(settings.lyric_size * 1.6)}px`,
              }),
          ...(highlighter
            ? {
                "--highlighter-ink": markerColour(
                  settings.lyrics_highlighter_color,
                ),
              }
            : {}),
        } as CSSProperties
      }
    >
      <div
        className="lyric-scroll"
        data-at-end={atEnd}
        onScroll={(event) => {
          const node = event.currentTarget;
          // Only the Now playing card fades its top by scroll distance. The
          // value stops changing once the fade is whole, so scrolling does
          // not restyle the lyrics on every frame.
          if (compact) {
            const scrolled = `${Math.min(80, Math.round(node.scrollTop))}px`;
            if (node.style.getPropertyValue("--scrolled") !== scrolled)
              node.style.setProperty("--scrolled", scrolled);
          }
          setAtEnd(
            node.scrollTop + node.clientHeight >= node.scrollHeight - 24,
          );
          noteHeldRest(node, false);
          if (!following)
            setReturnDirection(
              node.scrollTop > scroller.target ? "up" : "down",
            );
        }}
        ref={scroll}
        onWheel={browse}
        onTouchStart={browse}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
            ].includes(event.key)
          )
            browse();
        }}
      >
        <div className="lyric-spacer" />
        {gaps.has(-1) && waitingDots(gaps.get(-1)!)}
        {lyrics.lines.map((line, index) => {
          const playing = active.includes(index);
          const distance = Math.abs(index - primary);
          return (
            <Fragment key={`${line.start_ms}-${index}`}>
              <LyricRow
                line={line}
                action={lineActions[index]}
                playing={playing}
                past={!playing && scrollTime >= song.vocalEnd(index)}
                blur={compact || playing ? 0 : lineBlur(distance)}
                synced={lyrics.synced}
                highlighter={highlighter}
                // A line keeps following the song until its last word ends,
                // even after the next line takes over, so the pen finishes
                // at the singing's pace; then it keeps all its ink. Lines
                // not being sung hold still, so they skip rendering.
                time={song.highlighterTime(
                  index,
                  highlighter,
                  playing,
                  lyricTime,
                )}
                translation={settings.lyrics_translations}
              />
              {gaps.has(index) && waitingDots(gaps.get(index)!)}
            </Fragment>
          );
        })}
        {footerMode !== "full" && (
          <div className="lyric-end-credits">
            {writerCredits}
            {footerMode === "off" && (
              <div className={upNext ? "lyric-credits-row" : undefined}>
                <LyricCredits
                  lyrics={lyrics}
                  expanded
                  discord={settings.lyrics_discord_usernames !== false}
                />
                {upNext}
              </div>
            )}
          </div>
        )}
      </div>
      {footerMode !== "off" && (
        <div
          className="lyric-end-credits lyric-pinned-footer"
          role="region"
          aria-label="Pinned lyrics footer"
        >
          {footerMode === "full" && writerCredits}
          <div className={upNext ? "lyric-credits-row" : undefined}>
            <LyricCredits
              lyrics={lyrics}
              expanded
              discord={settings.lyrics_discord_usernames !== false}
            />
            {upNext}
          </div>
        </div>
      )}
      {!following &&
        lyrics.synced &&
        settings.lyrics_follow_button !== false && (
          <button
            type="button"
            className="follow-lyrics"
            title="Return to current lyric"
            aria-label="Return to current lyric"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setFollowing(true)}
          >
            {returnDirection === "up" ? (
              <ChevronUp size={28} strokeWidth={2.5} />
            ) : (
              <ChevronDown size={28} strokeWidth={2.5} />
            )}
          </button>
        )}
    </div>
  );
}

/** The song's lyrics page in the in-app sheet; without a song, the person's
 *  profile in the browser. */
const openLyssnaCredit = (username: string, song?: string) =>
  void (
    song
      ? rpc("open_song_page", { songId: song })
      : rpc("open_link", {
          url: `https://lyssna.org/u/${encodeURIComponent(username)}`,
        })
  ).catch(() => {});

function ContributorAvatar({
  person,
  layer,
  song,
}: {
  person: LyssnaCredit;
  layer: number;
  song?: string;
}) {
  const [avatar, setAvatar] = useState(
    person.username && person.avatar_url?.startsWith("https://")
      ? person.avatar_url
      : undefined,
  );
  const name = person.username || "Deleted user";
  const share = `${name}: ${Math.round(person.share)}% of these lyrics (${Math.round(person.text_share)}% of the words, ${Math.round(person.timing_share)}% of the timing)`;
  const face = (
    <>
      <UserRound aria-hidden="true" />
      {avatar && (
        <img src={avatar} alt="" onError={() => setAvatar(undefined)} />
      )}
    </>
  );
  const style = { "--avatar-layer": layer } as CSSProperties;
  return person.username ? (
    <button
      className="contributor-avatar"
      style={style}
      title={share}
      aria-label={name}
      onClick={() => openLyssnaCredit(name, song)}
    >
      {face}
    </button>
  ) : (
    <span
      className="contributor-avatar"
      style={style}
      role="img"
      title={share}
      aria-label={name}
    >
      {face}
    </span>
  );
}

/** "Contributors:" with up to five stacked avatars, largest share first, and
 *  up to two of them named: only those with more than 30% of the lyrics. */
function LyssnaContributors({
  credits,
  song,
}: {
  credits: LyssnaCredit[];
  song?: string;
}) {
  const shown = [...credits].sort((a, b) => b.share - a.share).slice(0, 5);
  const named = shown.filter((person) => person.share > 30).slice(0, 2);
  return (
    <span className="lyssna-contributors">
      <span>Contributors:</span>
      <span className="contributor-avatars">
        {shown.map((person, index) => (
          <ContributorAvatar
            key={person.user_id ?? `deleted-${index}`}
            person={person}
            layer={shown.length - index}
            song={song}
          />
        ))}
      </span>
      {named.length > 0 && (
        <span className="contributor-names">
          {named.map((person, index) => (
            <span key={person.user_id ?? `deleted-${index}`}>
              {person.username ? (
                <button
                  className="contributor-name"
                  onClick={() => openLyssnaCredit(person.username!, song)}
                >
                  <Marquee text={person.username} className="community-name">
                    {person.username}
                  </Marquee>
                </button>
              ) : (
                "Deleted user"
              )}
              {index < named.length - 1 && ","}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

const LyricCredits = memo(function LyricCredits({
  lyrics,
  expanded = false,
  discord = true,
}: {
  lyrics: Lyrics;
  expanded?: boolean;
  /** Name people by Discord username when their profile gave one. */
  discord?: boolean;
}) {
  const lookup = discord && lyrics.source === "spicy_lyrics";
  const makerName = useDiscordUsername(lyrics.attribution?.maker?.id, lookup);
  const uploaderName = useDiscordUsername(
    lyrics.attribution?.uploader?.id,
    lookup,
  );
  const nameOf = (person: Contributor) => {
    const found = discord
      ? (person === lyrics.attribution?.maker
          ? makerName
          : person === lyrics.attribution?.uploader
            ? uploaderName
            : undefined) || person.discord
      : undefined;
    // A name that only recases the username keeps the casing it was given.
    if (found && found.toLowerCase() === person.username?.toLowerCase())
      return person.username;
    return found || person.username || person.id;
  };
  const source =
    (
      {
        lyssna: "Lyssna",
        spicy_lyrics: "Spicy Lyrics",
        apple_music: "Apple Music",
        spotify: "Spotify",
        musixmatch: "Musixmatch",
      } as Record<string, string>
    )[lyrics.source] ?? lyrics.source;
  const openCreator = useCreatorProfile();
  // Spicy Lyrics' developer terms require every community credit to link
  // the person's profile, preferring the url from the response.
  const linkOf = (person: Contributor, url?: string) =>
    PROFILE_WINDOW
      ? person.id || url
        ? () =>
            person.id && !url
              ? openCreator(person)
              : void rpc("open_link", { url }).catch(() => {})
        : undefined
      : (url ?? creatorEmbed(nameOf(person)))
        ? () =>
            void rpc("open_link", {
              url: url ?? creatorEmbed(nameOf(person)),
            }).catch(() => {})
        : undefined;
  const profileUrl = (url?: string) => {
    try {
      const parsed = new URL(url ?? "");
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "spicylyrics.org" &&
        !parsed.username &&
        !parsed.password
      )
        return parsed.href;
    } catch {
      /* Missing profile links remain plain credit text. */
    }
  };
  if (lyrics.source === "lyssna" && lyrics.credits?.length) {
    return (
      <div
        className={`lyric-source community-credits lyssna-credits ${expanded ? "expanded" : ""}`}
      >
        <span className="community-lead">Lyrics provided by: Lyssna</span>
        <LyssnaContributors credits={lyrics.credits} song={lyrics.song_id} />
      </div>
    );
  }
  const community =
    lyrics.source === "spicy_lyrics"
      ? (["maker", "uploader"] as const).flatMap((role) => {
          const person = lyrics.attribution?.[role];
          return person?.username || person?.id ? [{ role, person }] : [];
        })
      : [];
  // "Lyrics provided by: Spicy Lyrics", then "Made by (avatar) @name" on a
  // line of its own, as Spicy Lyrics asks to be credited.
  if (community.length)
    return (
      <div
        className={`lyric-source community-credits spicy-credits ${expanded ? "expanded" : ""}`}
      >
        <span className="community-lead">Lyrics provided by: Spicy Lyrics</span>
        <span className="community-people">
          {community.map(({ role, person }) => {
            const url = profileUrl(person.url);
            const label =
              role === "uploader" && community[0].role === "maker"
                ? "Uploaded by"
                : "Made by";
            const name = (
              <>
                {person.avatar?.startsWith("https://") && (
                  <img src={person.avatar} alt="" />
                )}
                <Marquee text={`@${nameOf(person)}`} className="community-name">
                  @{nameOf(person)}
                </Marquee>
              </>
            );
            return (
              <span key={role} className="community-person">
                <span className="community-label-name">
                  {label}{" "}
                  {linkOf(person, url) ? (
                    <button
                      className="community-profile"
                      onClick={linkOf(person, url)}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className="community-profile">{name}</span>
                  )}
                </span>
              </span>
            );
          })}
        </span>
      </div>
    );
  return (
    <div className={`lyric-source ${expanded ? "expanded" : ""}`}>
      {lyrics.source_credit ? (
        <button
          className="community-profile"
          onClick={() =>
            void rpc("open_link", { url: lyrics.source_credit!.url }).catch(
              () => {},
            )
          }
          disabled={!lyrics.source_credit.url.startsWith("https://")}
        >
          {lyrics.source_credit.text}
        </button>
      ) : (
        "Lyrics provided by: "
      )}
      {lyrics.source_credit ? null : lyrics.source === "lrc.red" ? (
        <button
          className="community-profile"
          onClick={() =>
            void rpc("open_link", { url: "https://lrc.red/" }).catch(() => {})
          }
        >
          lrc.red
        </button>
      ) : (
        source
      )}
      {lyrics.estimated_words
        ? lyrics.estimated_lines
          ? " (+ estimated line and word timing)"
          : " (+ estimated word timing)"
        : lyrics.split_words && " (+ extra splits)"}
      {lyrics.source === "spicy_lyrics" &&
        (
          [
            ["uploader", "Uploaded by"],
            ["maker", "Made by"],
          ] as const
        ).map(([role, label]) => {
          const person = lyrics.attribution?.[role];
          if (!person?.username) return null;
          let url: string | undefined;
          try {
            const parsed = new URL(person.url ?? "");
            if (
              parsed.protocol === "https:" &&
              parsed.hostname === "spicylyrics.org" &&
              !parsed.username &&
              !parsed.password
            )
              url = parsed.href;
          } catch {
            /* Missing profile links remain plain credit text. */
          }
          return (
            <span key={role}>
              {" "}
              · {label}{" "}
              {linkOf(person, url) ? (
                <button className="text-link" onClick={linkOf(person, url)}>
                  {expanded ? "@" : ""}
                  {nameOf(person)}
                </button>
              ) : (
                nameOf(person)
              )}
              {expanded && person.avatar?.startsWith("https://") && (
                <img className="credit-avatar" src={person.avatar} alt="" />
              )}
            </span>
          );
        })}
    </div>
  );
});

/** Static lyric markup. LyricAnimator moves the syllables and letters. */

/** One lyric line. Memoised: while a song plays only the lines whose role,
 *  blur or ink changes render again, not every word of every line. */
const LyricRow = memo(function LyricRow({
  line,
  action,
  playing,
  past,
  blur,
  synced,
  highlighter,
  time,
  translation,
}: {
  line: Line;
  action: {
    ref: (element: HTMLButtonElement | null) => void;
    click: () => void;
  };
  playing: boolean;
  past: boolean;
  blur: number;
  synced: boolean;
  highlighter: boolean;
  time: number;
  translation?: boolean;
}) {
  return (
    <button
      ref={action.ref}
      className={`lyric-line ${playing ? "active" : ""} ${line.background ? "background-vocal" : ""} ${line.opposite ? "opposite" : ""} ${line.sung_by ? `sung-${line.sung_by}` : ""} ${past ? "past" : ""}`}
      style={{ "--blur": `${blur}px` } as CSSProperties}
      onClick={action.click}
      disabled={!synced}
      // Clicking seeks without taking focus, so Space stays with play and
      // pause.
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="lyric-main">
        {highlighter ? (
          <HighlighterWords line={line} time={time} />
        ) : (
          <LyricWords line={line} />
        )}
      </span>
      {/* Lyrics can carry translations, such as Chinese under English; like
          Spicy Lyrics they stay hidden unless asked for. */}
      {line.reading && (
        // Sung like the line above it, with calmer motion.
        <span className="lyric-romanization sung">
          <LyricWords line={line.reading} />
        </span>
      )}
      {translation && line.translation && (
        <span className="lyric-translation">{line.translation}</span>
      )}
    </button>
  );
});

const LyricWords = memo(function LyricWords({ line }: { line: Line }) {
  const groups = useMemo(() => wordGroups(line.words), [line]);
  if (!line.words.length)
    return <span className="lyric-plain">{line.text}</span>;
  return (
    <>
      {groups.flatMap((group, index) => {
        // A long hyphenated run like "no-oh-oh-oh" wraps at its hyphens
        // instead of moving to a line of its own.
        const runs: (typeof group)[] = [[]];
        group.forEach((word, part) => {
          runs.at(-1)!.push(word);
          if (part < group.length - 1 && /[-‐]$/u.test(word.text))
            runs.push([]);
        });
        let offset = 0;
        return runs.map((run, piece) => {
          const at = offset;
          offset += run.length;
          return (
            <LyricWord
              key={`${index}-${piece}`}
              words={run}
              offset={at}
              total={group.length}
            />
          );
        });
      })}
    </>
  );
});

function TimedLyricsPreview({
  state,
  onPlayer,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
}) {
  const current = useLyricPosition(state);
  // Re-render when romanized lyrics finish converting.
  useRomanization();
  const lyrics = filterWords(
    displayLyrics(
      state.lyrics,
      !!state.settings.experimental_word_sync,
      romanizeFor(state.settings, false),
      state.playback.item?.duration_ms,
    ),
    state.settings.lyrics_word_filter,
  );
  return lyrics ? (
    <LyricsDisplay
      lyrics={lyrics}
      writers={state.playback.item?.songwriters}
      positionMs={current}
      playing={state.playback.is_playing}
      settings={state.settings}
      compact
      onSeek={(ms) => onPlayer({ command: "seek", positionMs: ms })}
    />
  ) : null;
}

const LYRICS_CARD_KEY = "lyssna.npv-lyrics-card";
type LyricsCardView = { open: boolean; expanded: boolean };
function savedCardView(): LyricsCardView {
  try {
    const saved = JSON.parse(localStorage.getItem(LYRICS_CARD_KEY) ?? "{}");
    return { open: saved.open !== false, expanded: saved.expanded === true };
  } catch {
    return { open: true, expanded: false };
  }
}
/** Spicy Lyrics' Now Playing lyrics card: open the lyrics page, expand the
 * card over the whole panel, or fold it down to its header. */
function LyricsCard({
  state,
  onPlayer,
  onLyrics,
  onExpand,
  folded = false,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onLyrics: () => void;
  onExpand: (expanded: boolean) => void;
  folded?: boolean;
}) {
  const [saved, setSaved] = useState(savedCardView);
  // While the TTML Creator is open the card folds without forgetting the
  // layout the listener chose; changes made meanwhile last until it closes.
  const [visit, setVisit] = useState<LyricsCardView | null>(
    folded ? { open: false, expanded: false } : null,
  );
  useEffect(() => {
    setVisit(folded ? { open: false, expanded: false } : null);
  }, [folded]);
  const view = visit ?? saved;
  const setView = visit ? setVisit : setSaved;
  const expanded = view.open && view.expanded;
  useEffect(() => {
    try {
      localStorage.setItem(LYRICS_CARD_KEY, JSON.stringify(saved));
    } catch {
      // A remembered layout is a convenience; the card works without it.
    }
  }, [saved]);
  useEffect(() => {
    onExpand(expanded);
    return () => onExpand(false);
  }, [expanded, onExpand]);
  return (
    <article
      className={`now-card lyric-preview ${view.open ? "" : "collapsed"} ${expanded ? "expanded" : ""}`}
    >
      <div className="card-heading">
        <span>Lyrics</span>
        <div className="lyric-card-controls">
          <button
            className="lyric-card-control"
            onClick={onLyrics}
            title="Open lyrics"
          >
            <PanelLeftOpen size={18} />
          </button>
          <button
            className="lyric-card-control"
            onClick={() =>
              // Expanding a folded card opens it in the same step.
              setView({ open: true, expanded: !expanded })
            }
            title={expanded ? "Exit expanded lyrics" : "Expand lyrics"}
            aria-pressed={expanded}
          >
            {expanded ? (
              <FoldVertical size={18} />
            ) : (
              <UnfoldVertical size={18} />
            )}
          </button>
          <button
            className="lyric-card-control lyric-card-toggle"
            onClick={() => setView({ open: !view.open, expanded: false })}
            title={view.open ? "Hide lyrics" : "Show lyrics"}
            aria-expanded={view.open}
          >
            <ChevronUp size={18} />
          </button>
        </div>
      </div>
      {view.open && <TimedLyricsPreview state={state} onPlayer={onPlayer} />}
    </article>
  );
}

type Links = {
  onAlbum: (album: Album) => void;
  onArtist: (artist: Artist) => void;
};
export { DJArtwork };
export function DJPresentation({ playing }: { playing: boolean }) {
  return (
    <div className="dj-presentation">
      <DJArtwork />
      <div>
        <h2>DJ</h2>
        <p>{playing ? "Speaking…" : "Paused"}</p>
      </div>
    </div>
  );
}
/** Lyric views narrower than this stack a small header above the lyrics.
 * Low enough that a 1440px laptop with Now playing open keeps the
 * side-by-side layout (about 730px). */
const NARROW_LYRICS_PX = 640;
function useNarrowLyrics() {
  const page = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < NARROW_LYRICS_PX),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [page, narrow] as const;
}
function DJLyricsPage({
  state,
  children,
}: {
  state: AppState;
  children?: ReactNode;
}) {
  const [page, narrow] = useNarrowLyrics();
  return (
    <section
      ref={page}
      className={`lyrics-page dj-view ${narrow ? "narrow" : ""} ${state.settings.reduce_motion ? "reduce-motion" : ""}`}
    >
      {children}
      <Ambience
        image={DJ_COVER}
        reduceMotion={state.settings.reduce_motion}
        animate={state.playback.is_playing}
      />
      <div className="lyrics-body dj-lyrics-message" role="status">
        <DJVoiceRing
          live={state.playback.is_playing && !state.settings.reduce_motion}
        />
        <h2>
          {state.playback.is_playing ? "DJ is speaking…" : "DJ is paused"}
        </h2>
        <p>
          Your DJ is setting up what plays next. Lyrics return when the next
          song starts.
        </p>
      </div>
    </section>
  );
}
export function LyricsPage(props: Parameters<typeof SongLyricsPage>[0]) {
  return props.state.narrating ? (
    <DJLyricsPage state={props.state}>{props.children}</DJLyricsPage>
  ) : (
    <SongLyricsPage {...props} />
  );
}
/** The credits fit whole where they would sit unpinned. Pinned, they would
 *  otherwise be pulled up over the lines above them. */
function creditsInView(container: HTMLElement, above: HTMLElement) {
  const credits = above.nextElementSibling as HTMLElement | null;
  const height = credits
    ? credits.offsetHeight + parseFloat(getComputedStyle(credits).marginTop)
    : 0;
  return (
    above.offsetTop + above.offsetHeight + height <=
    container.scrollTop + container.clientHeight + 2
  );
}
/** Up next pops in this long before the song ends. */
const UP_NEXT_LEAD_MS = 30_000;
/** The longest exit in the Up next styles; content is dropped after it. */
const UP_NEXT_EXIT_MS = 220;
type UpNextBody = { track: Track; leaving: boolean; first: boolean };
/** The next song beside the credits. It rises in, leaves the way it came,
 *  and crossfades when the queue changes while it shows. */
function UpNext({
  track,
  reduceMotion,
  onPlay,
}: {
  track?: Track;
  reduceMotion: boolean;
  onPlay: (track: Track) => void;
}) {
  const [bodies, setBodies] = useState<UpNextBody[]>([]);
  const [leaving, setLeaving] = useState(false);
  const latest = useRef(track);
  latest.current = track;
  const uri = track?.uri;
  useEffect(() => {
    const next = latest.current;
    if (!next) {
      setLeaving(true);
      const timer = setTimeout(() => {
        setBodies([]);
        setLeaving(false);
      }, UP_NEXT_EXIT_MS);
      return () => clearTimeout(timer);
    }
    setLeaving(false);
    setBodies((old) => {
      const live = old.filter((body) => !body.leaving);
      if (live.at(-1)?.track.uri === next.uri) return old;
      if (!live.length) return [{ track: next, leaving: false, first: true }];
      return [
        ...live.map((body) => ({ ...body, leaving: true })),
        { track: next, leaving: false, first: false },
      ];
    });
  }, [uri]);
  const swapping = bodies.some((body) => body.leaving);
  useEffect(() => {
    if (!swapping) return;
    const timer = setTimeout(
      () => setBodies((old) => old.filter((body) => !body.leaving)),
      UP_NEXT_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [swapping]);
  if (!bodies.length) return null;
  return (
    <div className={`lyrics-up-next${leaving ? " leaving" : ""}`}>
      {bodies.map((body) => {
        const song =
          !body.leaving && track?.uri === body.track.uri ? track : body.track;
        const artists = artistNames(song);
        return (
          <button
            key={song.uri}
            className={`lyrics-up-next-body${body.first ? " first" : ""}${body.leaving ? " leaving" : ""}`}
            tabIndex={body.leaving || leaving ? -1 : undefined}
            data-context-route={song.id ? `track:${song.id}` : undefined}
            onClick={() => onPlay(song)}
          >
            <Cover images={song.album.images} />
            <span className="lyrics-up-next-text">
              <small>Up Next</small>
              <Marquee
                className="lyrics-up-next-title"
                text={song.name}
                reduceMotion={reduceMotion}
              >
                {song.name}
              </Marquee>
              {artists && (
                <Marquee
                  className="lyrics-up-next-artist"
                  text={artists}
                  reduceMotion={reduceMotion}
                >
                  {artists}
                </Marquee>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
/** The song after this one, with details the queue report may lack filled
 *  from songs Lyssna already knows. */
function useUpNext(state: AppState) {
  const next = state.details.queue[0];
  const known = useMemo(
    () =>
      knownTracks([
        state.tracks,
        ...Object.values(state.pages).map((page) => page.tracks),
      ]),
    [state.tracks, state.pages],
  );
  const filled = useMemo(
    () => next && fillFromKnown(next, known),
    [next, known],
  );
  return state.settings.lyrics_up_next === false ||
    state.narrating ||
    // Repeat-one plays this song again, so nothing else is next.
    state.playback.repeat_state === "track" ||
    !next?.name ||
    next.uri === state.playback.item?.uri
    ? undefined
    : filled;
}

/** Over a Canvas, the shorter of the title and the year-and-artists line sits
 *  on top. Both lines keep their own bottom offsets, which differ between
 *  layouts, so they trade places by shifting past each other. */
function useShortestFirst(
  details: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  key: string,
) {
  useLayoutEffect(() => {
    const element = details.current;
    if (!element) return;
    const title = element.querySelector<HTMLElement>(":scope > .lyrics-title");
    const artists = element.querySelector<HTMLElement>(
      ":scope > .lyrics-artists",
    );
    const reset = () => {
      delete element.dataset.shortestFirst;
      element.style.removeProperty("--title-shift");
      element.style.removeProperty("--artists-shift");
    };
    if (!active || !title || !artists) return reset;
    const update = () => {
      const titleWidth =
        title.querySelector<HTMLElement>(".marquee-content")?.scrollWidth ??
        title.scrollWidth;
      const artistsWidth = [...artists.children].reduce((total, part) => {
        const content = part.querySelector<HTMLElement>(".marquee-content");
        return total + (content ?? (part as HTMLElement)).scrollWidth;
      }, 0);
      if (!artistsWidth || titleWidth <= artistsWidth) return reset();
      // Measured without transforms, so the swap never feeds back into itself.
      const titleBottom = title.offsetTop + title.offsetHeight;
      const artistsBottom = artists.offsetTop + artists.offsetHeight;
      element.dataset.shortestFirst = "";
      element.style.setProperty(
        "--artists-shift",
        `${title.offsetTop - artists.offsetTop}px`,
      );
      element.style.setProperty(
        "--title-shift",
        `${artistsBottom - titleBottom}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element.parentElement ?? element);
    observer.observe(title);
    observer.observe(artists);
    update();
    return () => {
      observer.disconnect();
      reset();
    };
  }, [details, active, key]);
}

function SongLyricsPage({
  state,
  onPlayer,
  onAlbum,
  onArtist,
  onImport,
  onRetry,
  onCreate,
  onSave,
  onCanvasActive,
  immersive = false,
  queueOpen = false,
  children,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onImport: () => void;
  onRetry: () => void;
  /** Opens the TTML Creator to sync this song. */
  onCreate?: () => void;
  onSave: (track: Track) => void;
  onCanvasActive?: (active: boolean) => void;
  immersive?: boolean;
  /** The open queue already lists the next song. */
  queueOpen?: boolean;
  children?: ReactNode;
} & Links) {
  const { position: songTime, wait } = usePlaybackClock(state),
    current =
      songTime - wait + lyricOffset(state.settings, state.playback.item?.uri),
    track = state.playback.item;
  const upNext = useUpNext(state);
  const upNextShown =
    !queueOpen &&
    !!track?.duration_ms &&
    track.duration_ms - songTime <= UP_NEXT_LEAD_MS;
  const upNextCard = (
    <UpNext
      track={upNextShown ? upNext : undefined}
      reduceMotion={state.settings.reduce_motion}
      onPlay={(song) =>
        onPlayer({ command: "skip_to", uri: song.uri, track: song })
      }
    />
  );
  // Full screen seek: preview while dragging, seek once on release.
  const [seeking, setSeeking] = useState<number | null>(null);
  // After release the bar holds the chosen spot until playback reports it,
  // instead of flicking back to the old time for a moment.
  const [landing, setLanding] = useState<{ to: number; at: number } | null>(
    null,
  );
  const landed =
    !landing ||
    Math.abs(songTime - landing.to) < 750 ||
    performance.now() - landing.at > 2000;
  useEffect(() => {
    if (landing && landed) setLanding(null);
  }, [landing, landed]);
  const seekShown = seeking ?? (landed ? songTime : landing!.to);
  // The lyrics need every frame; the bar only needs to move once it
  // would show, or it restyles the page on every frame.
  const seekStepMs = Math.min(
      250,
      Math.max(50, (track?.duration_ms ?? 0) / 1500),
    ),
    seekBar = seeking ?? Math.floor(seekShown / seekStepMs) * seekStepMs;
  const commitSeek = () => {
    if (seeking === null) return;
    onPlayer({ command: "seek", positionMs: seeking });
    setLanding({ to: seeking, at: performance.now() });
    setSeeking(null);
    wakeTools();
  };
  // This page renders every frame; stable click handlers stop React from
  // rewriting them each time.
  const playing = state.playback.is_playing;
  const motion = useMotionCover(
    track,
    state.settings.animated_covers !== false && !state.settings.reduce_motion,
  );
  const previousSong = useCallback(
    () => onPlayer({ command: "previous" }),
    [onPlayer],
  );
  const nextSong = useCallback(() => onPlayer({ command: "next" }), [onPlayer]);
  const togglePlay = useCallback(
    () => onPlayer({ command: playing ? "pause" : "play" }),
    [onPlayer, playing],
  );
  const shuffle = state.playback.shuffle_state;
  const toggleShuffle = useCallback(
    () => onPlayer({ command: "shuffle", enabled: !shuffle }),
    [onPlayer, shuffle],
  );
  const repeat = state.playback.repeat_state || "off";
  const cycleRepeat = useCallback(
    () =>
      onPlayer({
        command: "repeat",
        repeat:
          repeat === "off" ? "context" : repeat === "context" ? "track" : "off",
      }),
    [onPlayer, repeat],
  );
  const saved = !!(track && state.saved[track.uri]);
  const toggleSaved = useCallback(() => {
    if (track) onSave(track);
  }, [onSave, track]);
  const backdrop = useRef<HTMLCanvasElement>(null);
  const [page, measuredNarrow] = useNarrowLyrics();
  // The toolbar shows while the pointer moves over the lyrics and fades a
  // second after it stops. Kept as a data attribute so frequent re-renders
  // of this page do not reset it.
  const toolsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wakeTools = () => {
    const element = page.current;
    if (!element) return;
    element.dataset.tools = "awake";
    clearTimeout(toolsTimer.current);
    toolsTimer.current = setTimeout(() => {
      delete element.dataset.tools;
    }, 750);
  };
  const sleepTools = () => {
    clearTimeout(toolsTimer.current);
    if (page.current) delete page.current.dataset.tools;
  };
  useEffect(() => () => clearTimeout(toolsTimer.current), []);
  // The toolbar's compact toggle forces the stacked layout.
  const narrow = measuredNarrow || !!state.settings.lyrics_compact;
  const [canvasShown, setCanvasShown] = useState(false);
  const motionAllowed =
    !state.settings.reduce_motion &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = !!(
    track &&
    state.canvas_url &&
    state.settings.canvas_lyrics &&
    motionAllowed
  );
  const visibleCanvas =
    canvas && canvasShown && !state.settings.lyrics_hide_artwork;
  const details = useRef<HTMLDivElement>(null);
  useShortestFirst(
    details,
    canvas && !narrow,
    `${track?.uri}:${track?.name}:${state.settings.lyrics_year_position}`,
  );
  useEffect(() => {
    onCanvasActive?.(visibleCanvas);
    return () => onCanvasActive?.(false);
  }, [visibleCanvas, onCanvasActive]);
  const coverColour =
    useArtworkColor(imageOf(track?.album.images)) ?? "rgb(40 40 40)";
  // Space Gravity needs word timing, including estimates for static lyrics.
  const gravity = !!(
    state.settings.space_gravity &&
    state.lyrics &&
    !state.lyrics.instrumental &&
    (state.lyrics.synced || track?.duration_ms)
  );
  // Re-render when romanized lyrics finish converting.
  useRomanization();
  const lyrics = filterWords(
    displayLyrics(
      state.lyrics,
      !!state.settings.experimental_word_sync || gravity,
      romanizeFor(state.settings, !gravity),
      track?.duration_ms,
    ),
    state.settings.lyrics_word_filter,
  );
  const year = state.settings.lyrics_year_position ?? "left";
  // Cover art and Artist header put a plain image behind the lyrics; the
  // artist's header falls back to the cover until it is known.
  const background = state.settings.lyrics_background ?? "animated";
  const cover = artworkFor(track?.album.images, 1280);
  const backgroundImage =
    background === "cover"
      ? cover
      : background === "artist"
        ? [
            state.details.artists.find(
              (artist) => artist.id && artist.id === track?.artists[0]?.id,
            )?.header_image ?? "",
          ].find(usableImage) || cover
        : undefined;
  // Both time labels reserve the duration's width, so the seek bar between
  // them keeps its length as the elapsed time changes.
  const timeChars = {
    "--time-chars": track ? formatTime(track.duration_ms).length : 4,
  } as CSSProperties;
  const seekPart = track ? (
    <>
      {/* A frosted glass track with a white fill; a transparent range
          on top handles dragging and the keyboard. */}
      <div
        className="lyrics-glass-seek"
        style={
          {
            "--range": `${(seekBar / Math.max(1, track.duration_ms || 1)) * 100}%`,
          } as CSSProperties
        }
      >
        <span className="lyrics-glass-fill" />
        <input
          type="range"
          aria-label="Seek position"
          min="0"
          max={track.duration_ms || 1}
          value={Math.min(seekBar, track.duration_ms || 1)}
          onChange={(event) => setSeeking(Number(event.target.value))}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setSeeking(songTime);
            wakeTools();
          }}
          // Releasing the pointer lets go of focus, which commits once. A
          // focused slider would otherwise show its keyboard ring as soon as
          // Space toggles playback.
          onPointerUp={(event) => {
            if (document.activeElement === event.currentTarget)
              event.currentTarget.blur();
            else commitSeek();
          }}
          onKeyUp={commitSeek}
          onPointerCancel={() => setSeeking(null)}
          onBlur={commitSeek}
        />
      </div>
      <div className="lyrics-fullscreen-times">
        <time>{formatTime(seekShown)}</time>
        <time>{formatTime(track.duration_ms)}</time>
      </div>
    </>
  ) : null;
  const heartPart = track ? (
    <button
      className={`icon-button lyrics-fullscreen-like ${saved ? "is-saved" : ""}`}
      title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}
      onClick={toggleSaved}
    >
      <FullscreenHeartIcon />
    </button>
  ) : null;
  const transportPart = track ? (
    <>
      <button
        className={`icon-button lyrics-fullscreen-shuffle ${state.playback.shuffle_state ? "active" : ""}`}
        title="Shuffle"
        onClick={toggleShuffle}
      >
        <FullscreenShuffleIcon />
      </button>
      <button
        className="icon-button lyrics-fullscreen-skip"
        title="Previous song"
        onClick={previousSong}
      >
        <SkipPreviousIcon />
      </button>
      <button
        className="icon-button lyrics-fullscreen-play"
        aria-label={state.playback.is_playing ? "Pause" : "Play"}
        onClick={togglePlay}
      >
        {state.playback.is_playing ? (
          <FullscreenPauseIcon />
        ) : (
          <FullscreenPlayIcon />
        )}
      </button>
      <button
        className="icon-button lyrics-fullscreen-skip"
        title="Next song"
        onClick={nextSong}
      >
        <SkipNextIcon />
      </button>
      <button
        className={`icon-button lyrics-fullscreen-repeat ${repeat !== "off" ? "active" : ""}`}
        title="Repeat"
        onClick={cycleRepeat}
      >
        <FullscreenRepeatIcon one={repeat === "track"} />
      </button>
    </>
  ) : null;
  const volumePart = track ? (
    <>
      {state.settings.fullscreen_volume &&
        state.settings.fullscreen_volume !== "off" && (
          <FullscreenVolume
            state={state}
            onPlayer={onPlayer}
            side={state.settings.fullscreen_volume}
          />
        )}
    </>
  ) : null;
  // Over the cover, parts kept up by Always show in full screen, and all of
  // them when the song has no lyrics, sit outside the artwork as the fork's
  // do: the seek bar under the cover, the transport under the song details.
  const coverLayout =
    immersive && !canvas && !narrow && !state.settings.lyrics_hide_artwork;
  const noLyrics = !lyrics && !!state.lyric_error;
  const alwaysShow = state.settings.fullscreen_always_show ?? "none";
  const seekOutside =
    coverLayout && (noLyrics || alwaysShow === "time" || alwaysShow === "both");
  const transportOutside =
    coverLayout &&
    (noLyrics || alwaysShow === "controls" || alwaysShow === "both");
  const fullscreenControls = track ? (
    <div className="lyrics-fullscreen-controls" style={timeChars}>
      {!seekOutside && seekPart}
      <div className="lyrics-fullscreen-buttons">
        {heartPart}
        {!transportOutside && transportPart}
      </div>
      {volumePart}
    </div>
  ) : null;
  return (
    <section
      ref={page}
      className={`lyrics-page ${canvas ? "canvas-lyrics" : ""} ${narrow ? "narrow" : ""} ${state.settings.reduce_motion ? "reduce-motion" : ""} ${gravity ? "space-gravity" : ""} ${state.settings.lyrics_hide_artwork ? "no-artwork" : ""} ${state.settings.lyrics_artwork_right ? "artwork-right" : ""} ${state.settings.lyrics_background === "color" ? "colour-background" : ""} ${state.settings.lyrics_toolbar_bottom ? "toolbar-bottom" : ""} ${state.settings.glass_seek === false ? "flat-seek" : ""} ${coverLayout && noLyrics ? "no-lyrics" : ""}`}
      style={
        {
          // Shared by the lyric lines and, in Space Gravity, its countdown.
          "--lyric-size": `${Math.round(state.settings.lyric_size * 1.6)}px`,
          "--lyrics-cover-color": coverColour,
          ...(state.settings.lyrics_background === "color"
            ? { "--hero": coverColour }
            : {}),
        } as CSSProperties
      }
      data-seeking={seeking !== null || undefined}
      data-always-show={
        state.settings.fullscreen_always_show &&
        state.settings.fullscreen_always_show !== "none"
          ? state.settings.fullscreen_always_show
          : undefined
      }
      onMouseMove={wakeTools}
      onKeyDownCapture={wakeTools}
      onMouseLeave={sleepTools}
    >
      {(!immersive || canvas || narrow || state.settings.lyrics_hide_artwork) &&
        children}
      {(!canvas || !canvasShown) &&
        (background === "animated" || background === "static") && (
          <Ambience
            track={track}
            motion={background === "animated" ? motion : null}
            reduceMotion={state.settings.reduce_motion}
            animate={state.playback.is_playing && background !== "static"}
          />
        )}
      {(!canvas || !canvasShown) && backgroundImage && (
        <div
          className="lyrics-image-background"
          aria-hidden="true"
          style={
            {
              backgroundImage: `url("${backgroundImage.replace(/"/g, "%22")}")`,
              "--background-blur": `${state.settings.lyrics_background_blur ?? 0}px`,
            } as CSSProperties
          }
        />
      )}
      {canvas && background !== "none" && (
        <canvas
          className="lyrics-canvas-backdrop"
          data-css-blur={IS_MAC || undefined}
          ref={backdrop}
          width={128}
          height={128}
          aria-hidden="true"
        />
      )}
      {state.settings.lyrics_visualiser && (
        <LyricsVisualiser
          playing={state.playback.is_playing}
          opacity={state.settings.lyrics_visualiser_opacity ?? 40}
        />
      )}
      {track ? (
        <>
          <div
            className="lyrics-album"
            // The Canvas sits behind this box as a backdrop, so only the
            // title and artists open the song menu over it.
            data-context-route={
              track.id && !canvas ? `track:${track.id}` : undefined
            }
          >
            {canvas ? (
              <LyricsCanvas
                key={track.uri}
                url={state.canvas_url!}
                poster={imageOf(track.album.images)}
                playing={state.playback.is_playing}
                backdrop={backdrop}
                onActive={setCanvasShown}
              />
            ) : (
              <div className="lyrics-media">
                <Cover
                  images={track.album.images}
                  fade={coverFade(state.settings)}
                  motion={motion}
                  onClick={() => onAlbum(track.album)}
                />
                {immersive &&
                  !narrow &&
                  !state.settings.lyrics_hide_artwork &&
                  children}
                {!narrow &&
                  !state.settings.lyrics_hide_artwork &&
                  fullscreenControls}
              </div>
            )}
            {seekOutside && (
              <div
                className="lyrics-fullscreen-controls lyrics-outside-controls outside-seek"
                style={timeChars}
              >
                {seekPart}
              </div>
            )}
            <div
              className="lyrics-details"
              ref={details}
              data-context-route={track.id ? `track:${track.id}` : undefined}
            >
              <TrackTitle
                track={track}
                onAlbum={onAlbum}
                reduceMotion={state.settings.reduce_motion}
                className="lyrics-title"
              />
              {/* The year stays put; only the artist names scroll. */}
              <div className="lyrics-artists">
                {track.album.release_date && year === "left" && (
                  <span className="lyrics-year">
                    {track.album.release_date.slice(0, 4)}
                    {/* Spaced like the artist's own inset on the far side. */}
                    <span className="lyrics-year-dot">·</span>
                  </span>
                )}
                <Marquee
                  text={artistNames(track)}
                  reduceMotion={state.settings.reduce_motion}
                >
                  <ArtistLinks artists={track.artists} onArtist={onArtist} />
                </Marquee>
                {track.album.release_date && year === "right" && (
                  <span className="lyrics-year right">
                    <span className="lyrics-year-dot">·</span>
                    {track.album.release_date.slice(0, 4)}
                  </span>
                )}
              </div>
            </div>
            {transportOutside && (
              <div className="lyrics-fullscreen-controls lyrics-outside-controls outside-transport">
                <div className="lyrics-fullscreen-buttons">{transportPart}</div>
              </div>
            )}
            {(canvas || narrow || state.settings.lyrics_hide_artwork) &&
              fullscreenControls}
          </div>
          <div className="lyrics-body">
            {lyrics && gravity ? (
              <SpaceGravityLyrics
                lyrics={lyrics}
                time={current}
                reduceMotion={!motionAllowed}
                tuning={state.settings.lyrics_animator}
                highlighter={
                  state.settings.lyrics_highlighter && lyrics.synced
                    ? markerColour(state.settings.lyrics_highlighter_color)
                    : undefined
                }
                linkWidth={
                  state.settings.gravity_links === false
                    ? 0
                    : (state.settings.gravity_link_width ?? 100) / 100
                }
                onSeek={(positionMs) =>
                  onPlayer({
                    command: "seek",
                    positionMs:
                      state.settings.lyrics_seek_compensation !== false
                        ? lyricSeekTarget(positionMs)
                        : positionMs,
                  })
                }
                credits={
                  <>
                    <WriterCredits
                      names={
                        lyrics.songwriters?.length
                          ? lyrics.songwriters
                          : (track.songwriters ?? [])
                      }
                    />
                    <LyricCredits
                      lyrics={lyrics}
                      expanded
                      discord={
                        state.settings.lyrics_discord_usernames !== false
                      }
                    />
                    {upNextCard}
                  </>
                }
              />
            ) : lyrics ? (
              <LyricsDisplay
                lyrics={lyrics}
                writers={state.playback.item?.songwriters}
                positionMs={current}
                playing={state.playback.is_playing}
                settings={state.settings}
                upNext={upNextCard}
                onSeek={(ms) => onPlayer({ command: "seek", positionMs: ms })}
              />
            ) : !state.lyric_error &&
              state.settings.lyrics_skeleton !== false ? (
              <LyricsSkeleton />
            ) : state.lyric_error === NO_LYRICS &&
              state.settings.lyrics_no_lyrics_notice ===
                false ? null : state.lyric_error === NO_LYRICS ? (
              <div className="lyrics-message no-lyrics">
                <Mic2 />
                <h2>No lyrics yet</h2>
                <p>
                  Nobody has synced this song yet. Sync it in the TTML Creator,
                  or ask the community on Discord.
                </p>
                <div className="inline-actions">
                  {onCreate && (
                    <button className="pill primary" onClick={onCreate}>
                      <FilePenLine size={18} />
                      Open TTML Creator
                    </button>
                  )}
                  <button
                    className="pill"
                    onClick={() =>
                      void rpc("open_link", { url: DISCORD_INVITE }).catch(
                        () => {},
                      )
                    }
                  >
                    <MessagesSquare size={18} />
                    Join our Discord
                  </button>
                </div>
                <div className="lyrics-message-links">
                  <button onClick={onRetry}>Search again</button>
                  <span aria-hidden="true">·</span>
                  <button onClick={onImport}>Import a lyric file</button>
                </div>
              </div>
            ) : (
              <div className="lyrics-message">
                <Mic2 />
                <h2>
                  {state.lyric_error ? "Lyrics unavailable" : "Finding lyrics…"}
                </h2>
                <p>
                  {state.lyric_error
                    ? "Try another lyrics source or import your lyric file."
                    : "Synced lyrics will appear here."}
                </p>
                {state.lyric_error && (
                  <div className="inline-actions">
                    <button className="pill primary" onClick={onRetry}>
                      <RotateCw size={18} />
                      Retry
                    </button>
                    <button className="pill" onClick={onImport}>
                      <Upload size={18} />
                      Import lyrics
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="lyrics-message">
          <Music2 />
          <h2>Play something you love</h2>
          <p>Your lyrics will appear here.</p>
        </div>
      )}
    </section>
  );
}

/** The backend's answer when every source had no lyrics (not a failure). */
export const NO_LYRICS = "No lyrics found for this song";
/** Lyssna's community Discord, where people ask for and sync lyrics. */
const DISCORD_INVITE = "https://discord.gg/qfYAsFQawp";
/** Ragged placeholder widths, fixed so the lines never reshuffle. */
const SKELETON_WIDTHS = [71, 56, 87, 48, 76, 63, 90, 52, 69, 81, 59, 74];
/** Placeholder lines where the lyrics will land, while they are fetched. */
function LyricsSkeleton() {
  return (
    <div className="lyrics-skeleton" role="status">
      <div className="lyrics-skeleton-lines" aria-hidden="true">
        {SKELETON_WIDTHS.map((width, index) => (
          <span
            key={index}
            style={{ width: `${width}%`, "--line": index } as CSSProperties}
          />
        ))}
      </div>
      <p>
        Loading lyrics
        <span className="lyrics-skeleton-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
    </div>
  );
}

/** Volume beside or below the full screen controls, as the fork's
 *  Fullscreen Volume Slider. */
function FullscreenVolume({
  state,
  onPlayer,
  side,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  side: "left" | "right" | "below";
}) {
  const device = state.playback.device;
  const [volume, setVolume] = useState(
    device.volume_percent ?? state.settings.volume_percent ?? 100,
  );
  const send = useRef(onPlayer);
  send.current = onPlayer;
  const control = useMemo(
    () =>
      new VolumeControl(
        (value) => send.current({ command: "volume", volume: value }),
        setVolume,
      ),
    [],
  );
  useEffect(() => () => control.dispose(), [control]);
  useEffect(() => {
    control.observe(
      device.volume_percent ??
        (state.settings.soloist ? state.settings.volume_percent : undefined),
      device.id ?? device.name,
    );
  }, [
    device.volume_percent,
    device.id,
    device.name,
    state.settings.soloist,
    state.settings.volume_percent,
    control,
  ]);
  // The level a tap on the speaker brings back after muting.
  const audible = useRef(volume || 50);
  if (volume) audible.current = volume;
  // The wheel nudges the volume 5% a notch; React's wheel listener is
  // passive, so the page would scroll too.
  const bar = useRef<HTMLDivElement>(null);
  const level = useRef(volume);
  level.current = volume;
  useEffect(() => {
    const node = bar.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(100, level.current + (event.deltaY < 0 ? 5 : -5)),
      );
      control.edit(next);
      control.finish();
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [control]);
  // Like the fork's: a frosted pill filled white from the bottom (or the
  // left, below the controls), its speaker inside the end of the fill,
  // growing wider while used.
  return (
    <div className={`lyrics-fullscreen-volume ${side}`}>
      <div
        ref={bar}
        className="lyrics-volume-pill"
        data-level={volume <= 0 ? "muted" : volume < 50 ? "low" : "high"}
        style={{ "--range": `${volume}%` } as CSSProperties}
      >
        <span className="lyrics-volume-fill" />
        <input
          type="range"
          aria-label="Full screen volume"
          min="0"
          max="100"
          value={volume}
          onPointerDown={() => control.begin()}
          onPointerUp={(event) => {
            control.finish();
            event.currentTarget.blur();
          }}
          onPointerCancel={() => control.finish()}
          onKeyUp={() => control.finish()}
          onBlur={() => control.finish()}
          onChange={(event) => control.edit(Number(event.target.value))}
        />
        <button
          className="lyrics-volume-icon"
          title={volume ? "Mute" : "Unmute"}
          onClick={() => {
            control.edit(volume ? 0 : audible.current);
            control.finish();
          }}
        >
          <FullscreenVolumeIcon />
        </button>
      </div>
    </div>
  );
}

// Videos warmed before playback so a Canvas starts at once instead of
// showing its still poster while it downloads.
const warmCanvases = new Map<string, HTMLVideoElement>();
export function preloadCanvas(url: string) {
  if (!url.startsWith("https://") || warmCanvases.has(url)) return;
  if (warmCanvases.size >= 6) {
    const [oldest, video] = warmCanvases.entries().next().value!;
    video.removeAttribute("src");
    video.load();
    warmCanvases.delete(oldest);
  }
  const video = document.createElement("video");
  // Must match the players' CORS mode, or the cached answer fails them.
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  video.load();
  warmCanvases.set(url, video);
}
const canvasRequests = new Set<string>();
export function prefetchCanvas(uri: string) {
  if (canvasRequests.has(uri)) return;
  canvasRequests.add(uri);
  void rpc("prefetch_canvas", { uris: [uri] }).catch(() =>
    canvasRequests.delete(uri),
  );
}

function CanvasArtwork({
  track,
  url,
  playing,
  reduceMotion,
  motion,
  onOpen,
}: {
  track: Track;
  url?: string;
  playing: boolean;
  reduceMotion: boolean;
  motion?: string | null;
  onOpen: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let visible = true;
    const update = () => {
      if (playing && visible && !document.hidden && !reduceMotion)
        void element.play().catch(() => {});
      else element.pause();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      element.pause();
    };
  }, [url, playing, reduceMotion]);
  if (!url || failed || reduceMotion)
    return (
      <Cover
        images={track.album.images}
        className="now-artwork"
        motion={motion}
        onClick={onOpen}
      />
    );
  return (
    <button className="canvas-artwork" aria-label="Open album" onClick={onOpen}>
      <video
        ref={video}
        data-canvas-video
        crossOrigin="anonymous"
        src={url}
        muted
        loop
        playsInline
        autoPlay={playing && !reduceMotion}
        preload="auto"
        poster={imageOf(track.album.images)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export function NowPlaying({
  state,
  onPlayer,
  onAlbum,
  onArtist,
  onLyrics,
  onQueue,
  onFollow,
  onSave,
  showLyricsPreview,
  foldLyrics,
  canvasInLyrics = false,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onLyrics: () => void;
  onQueue: () => void;
  onFollow: (artist: Artist) => void;
  onSave: (track: Track) => void;
  showLyricsPreview: boolean;
  foldLyrics?: boolean;
  canvasInLyrics?: boolean;
} & Links) {
  const track = state.playback.item;
  // Local songs have no Spotify artist, so no About the artist card.
  const listed = track?.is_local
    ? undefined
    : (state.details.artists[0] ?? track?.artists[0]);
  // About details arrive by artist, often before the song's details, and
  // for upcoming songs ahead of time.
  const about = listed?.id ? state.artist_about[listed.id] : undefined;
  const artist: Artist | undefined =
    listed && about && !listed.about_loaded
      ? {
          ...listed,
          about_loaded: true,
          gallery_image: about.gallery_image || listed.gallery_image,
          header_image: about.header_image || listed.header_image,
          monthly_listeners:
            about.monthly_listeners ?? listed.monthly_listeners,
          verified: about.verified ?? listed.verified,
          biography: about.biography || listed.biography,
          images:
            listed.images?.length || !about.image
              ? listed.images
              : [{ url: about.image }],
        }
      : listed;
  const next = state.details.queue[0];
  const saved = track && state.saved[track.uri];
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const motion = useMotionCover(
    track,
    state.settings.animated_covers !== false && !state.settings.reduce_motion,
  );
  // Follow buttons read the library's answer, which only arrives when asked.
  const followable = [
    ...(artist ? [artist] : []),
    ...(track && !track.is_local
      ? trackCredits(track).map((credit) => credit.artist)
      : []),
  ]
    .map((each) =>
      !each ? "" : (each.uri ?? (each.id ? `spotify:artist:${each.id}` : "")),
    )
    .filter(Boolean)
    .join("|");
  useEffect(() => {
    if (followable)
      void rpc("saved_status", { uris: followable.split("|") }).catch(() => {});
  }, [followable]);
  if (state.narrating)
    return (
      <aside className="now-playing dj-view">
        <Ambience
          image={DJ_COVER}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
        />
        <div className="now-playing-scroll">
          <div className="section-heading">
            <h2>Now playing</h2>
          </div>
          <DJArtwork />
          <div className="now-track">
            <div className="now-track-text">
              <span className="song-title">DJ</span>
              <div className="now-artists">
                {state.playback.is_playing ? "Speaking…" : "Paused"}
              </div>
            </div>
          </div>
          <p className="dj-note">
            Your DJ picks music for you and talks between sets. Song details
            return when the next track starts.
          </p>
        </div>
      </aside>
    );
  // Spotify's Canvas layout: the video fills the panel top edge to edge with
  // the header and title laid over it.
  const canvas =
    !!track &&
    !!state.canvas_url &&
    !state.settings.reduce_motion &&
    !canvasInLyrics;
  // Like Spotify, the header names what the song plays from.
  const from = contextName(state.playback.context, {
    dj: !!state.dj_context,
    playlists: state.playlists,
    track,
  });
  const heading = (
    <div className={`section-heading ${canvas ? "canvas-hero-head" : ""}`}>
      <h2>{from || "Now playing"}</h2>
      <button className="icon-button" onClick={onLyrics} title="Open lyrics">
        <Maximize2 size={17} />
      </button>
    </div>
  );
  return (
    <aside
      className={`now-playing ${canvas ? "has-canvas" : ""} ${lyricsExpanded ? "lyrics-expanded" : ""}`}
    >
      {state.settings.npv_ambience !== false && (
        <Ambience
          track={track}
          motion={motion}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
          // Only while Now playing shows the Canvas itself; with it on the
          // lyrics page, the panel keeps the album artwork's ambience.
          followCanvas={canvas}
        />
      )}
      <div className="now-playing-scroll">
        {!canvas && heading}
        {track ? (
          <>
            {canvas ? (
              <div className="canvas-hero">
                <CanvasArtwork
                  key={track.uri}
                  track={track}
                  url={state.canvas_url}
                  playing={state.playback.is_playing}
                  reduceMotion={state.settings.reduce_motion}
                  motion={motion}
                  onOpen={() => onAlbum(track.album)}
                />
                <div className="canvas-hero-shade" />
                {heading}
              </div>
            ) : (
              <CanvasArtwork
                key={track.uri}
                track={track}
                url={canvasInLyrics ? undefined : state.canvas_url}
                playing={state.playback.is_playing}
                reduceMotion={state.settings.reduce_motion}
                motion={motion}
                onOpen={() => onAlbum(track.album)}
              />
            )}
            <div
              className={`now-track ${canvas ? "canvas-hero-track" : ""}`}
              data-context-route={track.id ? `track:${track.id}` : undefined}
            >
              <div className="now-track-text">
                <TrackTitle
                  track={track}
                  onAlbum={onAlbum}
                  reduceMotion={state.settings.reduce_motion}
                />
                <Marquee
                  text={artistNames(track)}
                  reduceMotion={state.settings.reduce_motion}
                  className="now-artists"
                >
                  <ArtistLinks artists={track.artists} onArtist={onArtist} />
                </Marquee>
              </div>
              <button
                className={`icon-button save-track ${saved ? "is-saved" : ""}`}
                title={saved ? "Saved to Liked Songs" : "Save to Liked Songs"}
                onClick={() => onSave(track)}
              >
                {saved ? (
                  <CircleCheck size={24} fill="currentColor" stroke="#000" />
                ) : (
                  <CirclePlus size={24} />
                )}
              </button>
            </div>
            {showLyricsPreview && state.lyrics && (
              <LyricsCard
                state={state}
                onPlayer={onPlayer}
                onLyrics={onLyrics}
                onExpand={setLyricsExpanded}
                folded={foldLyrics}
              />
            )}
            {artist && (
              <article className="now-card artist-card">
                {(() => {
                  const photo = artist.gallery_image || imageOf(artist.images);
                  const waiting = !artist.about_loaded;
                  return (
                    // Name, listeners and Follow sit on the photo, as on
                    // Spotify's About section, so the card has no empty band.
                    <div
                      className={`artist-portrait ${photo || waiting ? "" : "no-photo"}`}
                    >
                      {(photo || waiting) && (
                        <button
                          className="artist-portrait-open"
                          aria-label={`Open ${artist.name}`}
                          onClick={() => onArtist(artist)}
                        >
                          {/* Spotify's card shows the About section's photo;
                              until it is known, nothing, so the avatar never
                              flashes. */}
                          {!waiting && <img src={photo} alt={artist.name} />}
                        </button>
                      )}
                      <strong>About the artist</strong>
                      <div className="artist-card-row">
                        <div className="artist-card-who">
                          <button
                            className="text-link artist-card-name"
                            onClick={() => onArtist(artist)}
                          >
                            <span className="artist-card-name-text">
                              {artist.name}
                            </span>
                            {artist.verified && (
                              <VerifiedBadge label="Verified artist" />
                            )}
                          </button>
                          <p className="artist-stat">
                            {artist.monthly_listeners != null
                              ? `${artist.monthly_listeners.toLocaleString()} monthly listeners`
                              : artist.followers
                                ? `${artist.followers.total.toLocaleString()} followers`
                                : ""}
                          </p>
                        </div>
                        <button
                          className="pill outline"
                          onClick={() => onFollow(artist)}
                        >
                          {state.saved[
                            artist.uri ?? `spotify:artist:${artist.id}`
                          ]
                            ? "Following"
                            : state.can_follow
                              ? "Follow"
                              : "Enable following"}
                        </button>
                      </div>
                    </div>
                  );
                })()}
                {artist.biography ? (
                  <div className="card-content artist-card-about">
                    <p className="artist-bio">{artist.biography}</p>
                  </div>
                ) : (
                  !!artist.genres?.length && (
                    <div className="card-content artist-card-about">
                      <p className="artist-genres">
                        {artist.genres.slice(0, 3).join(" · ")}
                      </p>
                    </div>
                  )
                )}
              </article>
            )}
            <CreditsCard
              track={track}
              saved={state.saved}
              onArtist={onArtist}
              onFollow={onFollow}
            />
            {next && (
              <article className="now-card queue-card">
                <div className="card-heading">
                  <span>Next in queue</span>
                  <button className="text-link muted" onClick={onQueue}>
                    Open queue
                  </button>
                </div>
                <button
                  className="next-track"
                  onClick={() =>
                    onPlayer({ command: "play", uri: next.uri, track: next })
                  }
                >
                  <Cover images={next.album.images} />
                  <div>
                    <Marquee
                      text={next.name}
                      reduceMotion={state.settings.reduce_motion}
                    >
                      {next.name}
                    </Marquee>
                    <span>{artistNames(next)}</span>
                  </div>
                </button>
              </article>
            )}
            <div className="playing-on">
              <span className={state.native_ready ? "ready-dot" : ""} />
              <div>
                <small>Playing on</small>
                <strong>
                  {state.playback.device.name.startsWith("Lyssna")
                    ? "This computer"
                    : state.playback.device.name || "This computer"}
                </strong>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-now">
            <Music2 />
            <h3>Nothing playing yet</h3>
            <p>Pick a song to make yourself at home.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

/** The play queue, shown in the right panel in place of Now playing. */
/** The Jam this computer hosts or joined, above the queue as in Spotify. */
function JamCard({
  jam,
  invite,
  hostName,
  onInvite,
  onCopy,
  onEnd,
  onControl,
}: {
  jam: Jam;
  invite: boolean;
  hostName: string;
  onInvite: (open: boolean) => void;
  onCopy: () => void;
  onEnd: () => void;
  onControl: (allowed: boolean) => void;
}) {
  const host =
    jam.members.find((member) => member.id === jam.owner_id) ?? jam.members[0];
  const name = host?.display_name || host?.username || hostName;
  return (
    <section className="jam-card" aria-label="Jam">
      <h2>{name ? `${name}\u2019s Jam` : "Jam"}</h2>
      <div className="jam-actions">
        <div
          className="jam-members"
          title={`${jam.members.length} in this Jam`}
        >
          {jam.members.slice(0, 3).map((member) =>
            member.image_url ? (
              <img key={member.id} src={member.image_url} alt="" />
            ) : (
              <span key={member.id} className="jam-member-initial">
                {(member.display_name || member.username).slice(0, 1)}
              </span>
            ),
          )}
          {jam.members.length > 3 && (
            <span className="jam-member-more">+{jam.members.length - 3}</span>
          )}
        </div>
        <button className="jam-pill" onClick={() => onInvite(true)}>
          Invite
        </button>
        <button className="jam-pill" onClick={onEnd}>
          {jam.is_owner ? "End" : "Leave"}
        </button>
      </div>
      {invite && (
        <div className="jam-invite">
          <div className="jam-invite-head">
            <div>
              <strong>
                Invite friends to {jam.is_owner ? "your" : "this"} Jam
              </strong>
              <p>
                Copy and share the link with your friends, or ask them to scan
                the QR code.
              </p>
            </div>
            <button
              className="icon-button"
              onClick={() => onInvite(false)}
              aria-label="Close invite"
            >
              <X size={18} />
            </button>
          </div>
          <div className="jam-invite-body">
            <button className="jam-copy" onClick={onCopy}>
              <Copy size={18} />
              Copy link
            </button>
            {jam.qr_svg && (
              <img
                className="jam-qr"
                alt="Jam QR code"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(jam.qr_svg)}`}
              />
            )}
          </div>
        </div>
      )}
      {jam.is_owner && (
        <label className="jam-control">
          <span>Let others change what's playing</span>
          <Toggle
            label="Let others change what's playing"
            checked={!jam.queue_only}
            onChange={onControl}
          />
        </label>
      )}
    </section>
  );
}

export function QueuePanel({
  state,
  onPlayer,
  onClose,
  jam,
  jamInvite = false,
  onJamInvite,
  onJamJoin,
  onJamCopy,
  onJamEnd,
  onJamControl,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onClose: () => void;
  jam?: Jam | null;
  jamInvite?: boolean;
  onJamInvite?: (open: boolean) => void;
  onJamJoin?: () => void;
  onJamCopy?: () => void;
  onJamEnd?: () => void;
  onJamControl?: (allowed: boolean) => void;
}) {
  const track = state.playback.item;
  const motion = useMotionCover(
    track,
    state.settings.animated_covers !== false && !state.settings.reduce_motion,
  );
  const known = useMemo(
    () =>
      knownTracks([
        state.tracks,
        ...Object.values(state.pages).map((page) => page.tracks),
      ]),
    [state.tracks, state.pages],
  );
  const raw = useMemo(
    () => state.details.queue.map((item) => fillFromKnown(item, known)),
    [state.details.queue, known],
  );
  // Spotify can report the advanced queue a moment before the song changes.
  // The leaving song stays listed until then, so the list moves once.
  const hold = useRef({
    track: "",
    queue: [] as Track[],
    queued: 0,
    since: 0,
  });
  const holdTimer = useRef(0);
  const [, wake] = useState(0);
  const held = hold.current;
  const early =
    !!track &&
    held.track === track.uri &&
    raw.length > 0 &&
    held.queue.length > 1 &&
    held.queue[0].uri !== raw[0].uri &&
    held.queue[1].uri === raw[0].uri &&
    (!held.since || performance.now() - held.since < 1500);
  const queue = early ? [held.queue[0], ...raw] : raw;
  // Songs the listener queued play first, then the playing context's.
  const queued = Math.min(
    queue.length,
    early ? held.queued : (state.details.queued ?? 0),
  );
  const dj = !!state.dj_context;
  const from =
    contextName(state.playback.context, {
      dj,
      playlists: state.playlists,
      track,
    }) ?? "";
  useEffect(() => {
    if (!early) {
      hold.current = {
        track: track?.uri ?? "",
        queue: raw,
        queued: state.details.queued ?? 0,
        since: 0,
      };
      return;
    }
    if (held.since) return;
    held.since = performance.now();
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(
      () => wake((count) => count + 1),
      1600,
    );
  });
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  // Rows are keyed by song and repeat count, so the next song keeps its key
  // when it becomes Now playing and can slide up into that slot.
  const seen = new Map<string, number>();
  const keyOf = (item: Track) => {
    const count = seen.get(item.uri) ?? 0;
    seen.set(item.uri, count + 1);
    return `${item.uri}#${count}`;
  };
  const currentKey = track && !state.narrating ? keyOf(track) : "";
  const queueKeys = queue.map(keyOf);
  const rows = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const scroller = useRef<HTMLDivElement>(null);
  const order = [currentKey, ...queueKeys].join(" ");
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const origin = box.getBoundingClientRect().top - box.scrollTop;
    const previous = tops.current;
    const animate = previous.size > 0 && !state.settings.reduce_motion;
    const next = new Map<string, number>();
    const moves: [HTMLElement, number | undefined, number][] = [];
    for (const [key, element] of rows.current) {
      // A row still sliding is measured where it shows, then at rest, so a
      // new move continues from its place on screen instead of jumping.
      const shown = element.getBoundingClientRect().top - origin;
      for (const animation of element.getAnimations()) animation.cancel();
      const top = element.getBoundingClientRect().top - origin;
      next.set(key, top);
      const rest = previous.get(key);
      const before = rest === undefined ? undefined : rest + shown - top;
      if (animate && (before === undefined || Math.abs(before - top) > 0.5))
        moves.push([element, before, top]);
    }
    // Skip and Previous move the list by one place: rows slide that step
    // and songs joining the end fade in. Any other change (a reshuffle, a
    // new list) shows at once, since sliding or fading a whole list read as
    // the queue blanking and jumping.
    const moved = moves.filter(([, before]) => before !== undefined);
    const step = (element: HTMLElement, before: number, top: number) =>
      Math.abs(before - top) <= element.offsetHeight * 1.5;
    const stepped = moved.filter(([element, before, top]) =>
      step(element, before!, top),
    );
    const shifted = moved.length
      ? stepped.length >= moved.length * 0.8
      : moves.length <= 3;
    if (shifted)
      for (const [element, before, top] of moves) {
        if (before !== undefined && !step(element, before, top)) continue;
        element.animate(
          before !== undefined
            ? [
                { transform: `translateY(${before - top}px)` },
                { transform: "none" },
              ]
            : [{ opacity: 0 }, { opacity: 1 }],
          { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      }
    tops.current = next;
  }, [order, state.settings.reduce_motion]);
  const row = (item: Track, key: string, current = false, added = false) => (
    <button
      key={key}
      // Right-click opens the song menu; songs the listener queued can be
      // removed from it.
      data-context-route={item.id ? `track:${item.id}` : undefined}
      data-queued={added || undefined}
      ref={(element) => {
        if (element) rows.current.set(key, element);
        else rows.current.delete(key);
      }}
      className={`next-track queue-row ${current ? "current" : ""}`}
      onClick={
        current
          ? undefined
          : // Skip ahead to it, keeping the playlist and the rest of the queue.
            () => onPlayer({ command: "skip_to", uri: item.uri, track: item })
      }
      disabled={current}
    >
      <Cover images={item.album.images} />
      <div>
        <Marquee text={item.name} reduceMotion={state.settings.reduce_motion}>
          {item.name}
        </Marquee>
        <span>{artistNames(item)}</span>
      </div>
    </button>
  );
  return (
    <aside className="now-playing queue-panel">
      {/* Liquid Glass already draws this artwork behind the window. */}
      {!state.settings.liquid_glass && (
        <Ambience
          track={track}
          motion={motion}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
        />
      )}
      <div className="now-playing-scroll" ref={scroller}>
        <div className="section-heading">
          <h2>Queue</h2>
          <div className="queue-header-actions">
            {!jam && onJamJoin && (
              <button
                className="text-link muted"
                onClick={onJamJoin}
                title="Join a Jam from a link you copied"
              >
                Join a Jam
              </button>
            )}
            <button
              className="icon-button"
              onClick={onClose}
              title="Close queue"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        {jam && (
          <JamCard
            jam={jam}
            invite={jamInvite}
            hostName={state.profile?.display_name ?? ""}
            onInvite={(open) => onJamInvite?.(open)}
            onCopy={() => onJamCopy?.()}
            onEnd={() => onJamEnd?.()}
            onControl={(allowed) => onJamControl?.(allowed)}
          />
        )}
        {track && !state.narrating && (
          <section className="queue-section">
            <h3>Now playing</h3>
            {row(track, currentKey, true)}
          </section>
        )}
        {queued > 0 && (
          <section className="queue-section">
            <div className="queue-heading">
              <h3>Next in queue</h3>
              <button
                className="text-link muted"
                onClick={() => onPlayer({ command: "clear_queue" })}
              >
                Clear queue
              </button>
            </div>
            {queue
              .slice(0, queued)
              .map((item, index) => row(item, queueKeys[index], false, true))}
          </section>
        )}
        {/* DJ keeps its picks to itself, as in Spotify: only Now playing
            and songs the listener queued show. */}
        {!dj && (queued < queue.length || !queue.length) && (
          <section className="queue-section">
            <h3>{from ? `Next from: ${from}` : "Next up"}</h3>
            {queue.length ? (
              queue
                .slice(queued)
                .map((item, index) => row(item, queueKeys[queued + index]))
            ) : (
              <p className="queue-empty">Nothing is queued yet.</p>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

/** Performers plus songwriters, merged by name like Spotify's credits card. */
export function trackCredits(track: Track) {
  const credits = track.artists.map((artist) => ({
    name: artist.name,
    artist: artist as Artist | undefined,
    roles: ["Main Artist"],
  }));
  for (const writer of track.songwriters ?? []) {
    const existing = credits.find(
      (credit) => credit.name.toLowerCase() === writer.toLowerCase(),
    );
    if (existing) existing.roles.push("Writer");
    else credits.push({ name: writer, artist: undefined, roles: ["Writer"] });
  }
  return credits;
}

function CreditsCard({
  track,
  saved,
  onArtist,
  onFollow,
}: {
  track: Track;
  saved: Record<string, boolean>;
  onArtist: (artist: Artist) => void;
  onFollow: (artist: Artist) => void;
}) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [track.uri]);
  const credits = trackCredits(track);
  // Show all opens Spotify's full Credits dialog, when Spotify knows the song.
  return (
    <article className="now-card">
      <div className="card-heading">
        <span>Credits</span>
        {(track.id || credits.length > 3) && (
          <button className="text-link muted" onClick={() => setAll(true)}>
            Show all
          </button>
        )}
      </div>
      {all && track.id && (
        <CreditsDialog
          track={track}
          saved={saved}
          onArtist={onArtist}
          onFollow={onFollow}
          onClose={() => setAll(false)}
        />
      )}
      <div className="card-content credit-list">
        {(all && !track.id ? credits : credits.slice(0, 3)).map((credit) => (
          <div key={credit.name} className="credit">
            <div>
              {credit.artist ? (
                <button
                  className="text-link"
                  onClick={() => onArtist(credit.artist!)}
                >
                  {credit.name}
                </button>
              ) : (
                <span className="credit-name">{credit.name}</span>
              )}
              <p>{credit.roles.join(" • ")}</p>
            </div>
            {credit.artist?.id && (
              <button
                className="pill outline"
                onClick={() => onFollow(credit.artist!)}
              >
                {saved[
                  credit.artist.uri ?? `spotify:artist:${credit.artist.id}`
                ]
                  ? "Following"
                  : "Follow"}
              </button>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

export function HistoryChevron({ back }: { back: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="25"
      height="25"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={back ? "15 4 7 12 15 20" : "9 4 17 12 9 20"} />
    </svg>
  );
}
