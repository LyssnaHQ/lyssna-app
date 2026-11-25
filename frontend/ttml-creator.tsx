import { clippedTitle } from "./clipped-title";
import { voicesOf } from "./song-parts";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Copy,
  Download,
  Eye,
  FileInput,
  EyeOff,
  History,
  ClipboardCheck,
  AudioWaveform,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Send,
  Settings,
  Tags,
  Trash2,
  Type,
  Upload,
  Languages,
  Undo2,
  Wand2,
  Globe,
  Layers,
  X,
} from "lucide-react";
import {
  ReviewPanel,
  isFreshPick,
  reviewInProgress,
  type ReviewOpen,
} from "./review-panel";
import type { ReviewSubmission } from "./review-api";
import { Cover, usePlaybackClock } from "./components";
import type { AppState } from "./state";
import type { AppleOriginal, Lyrics, PlayerRequest, Track } from "./types";
import {
  forgetWorking,
  markWorking,
  setShowsPreview,
  showLive,
  showsPreview,
} from "./ttml-working";
import { IS_MAC, MODIFIER } from "./platform";
import { TOUR_KEY, TtmlTour } from "./ttml-tour";
import {
  type CreatorLine,
  type Cursor,
  type MetaEntry,
  type SongMeta,
  AUTHOR_KEYS,
  defaultMetadata,
  withSongwriters,
  breakLine,
  clampCursor,
  clearAll,
  toLyrics,
  clearTiming,
  duplicateLine,
  editUnit,
  appendWords,
  fileName,
  formatTime,
  fromLyrics,
  geniusBackgrounds,
  geniusChanges,
  addMissing,
  fixFromGenius,
  type GeniusChanges,
  bracketsToBackground,
  splitAllWords,
  readingsFrom,
  insertBlankLine,
  joinHyphenated,
  cursorAt,
  keepTimings,
  lineSpan,
  singingAt,
  markEnd,
  markNext,
  timingCursor,
  markStart,
  moveLine,
  moveWord,
  moveWords,
  deletePicked,
  applyRomanized,
  nextCursor,
  romanizeRequest,
  sameReadings,
  setUnitRoman,
  splitReadings,
  romanParts,
  romanPieces,
  hasWordRoman,
  parseText,
  applySections,
  unknownSections,
  previousCursor,
  problems,
  progress,
  removeLine,
  setLineText,
  splitMatching,
  replaceMatching,
  splitUnit,
  timed,
  toText,
  toTtml,
  toggleJoin,
  toggleLine,
  wordBounds,
  moveSpace,
  setLineFlag,
  shiftLines,
  clearLines,
  removeLines,
  canSeed,
  sectionVoices,
  lineVoice,
  unitVoice,
  setLineVoice,
  setSection,
  setSectionSinger,
  setUnitVoice,
} from "./ttml-creator-model";
import { romanizeLyrics } from "./romanization";
import { MetadataDialog } from "./ttml-metadata";
import { CreatorSpeed, TtmlBar, TtmlWave } from "./ttml-bar";
import { PauseIcon, PlayIcon } from "./player-icons";
import { TtmlSpectrogram } from "./ttml-spectrogram";
import { createPortal } from "react-dom";
import { rpc } from "./bridge";
import {
  hasLyrics,
  MarkInstrumental,
  markedInstrumental,
} from "./mark-instrumental";
import { creatorTransport, direct, useCreatorPlayer } from "./creator-player";
import { SOLOIST_DEVICE } from "./soloist-settings";
import {
  type ExportFormat,
  type WordFormat,
  EXPORT_FORMATS,
  WORD_FORMATS,
  exportLyrics,
  formatOf,
  parseWordFormat,
} from "./ttml-formats";

const FORMAT_NAMES: Record<ExportFormat | "ttml", string> = {
  ttml: "TTML",
  lrc: "LRC (lines only)",
  qrc: "QRC",
  yrc: "YRC",
  lys: "Lyricify Syllable",
  eslrc: "ESLyric",
};
import {
  type KeyAction,
  type KeyMap,
  KeysDialog,
  actionFor,
  loadKeys,
  saveKeys,
} from "./ttml-keys";
import {
  type DraftVersion,
  type SavedSong,
  addVersion,
  deleteSaves,
  listDrafts,
  listVersions,
  loadDraft,
  newVersionDue,
  savedLabel,
  writeDraft,
} from "./ttml-saves";
import { type LearnedSplits, cutAt, suggestSplit } from "./ttml-syllables";
import {
  type MenuAction,
  type SplitChoice,
  SplitDialog,
  GeniusReview,
  ReadingSplitDialog,
  ReplaceDialog,
  type ReplaceChoice,
  WordMenu,
} from "./ttml-word-menu";
import "./ttml-creator.css";

const MIN_SPEED = 0.25;
const MAX_SPEED = 1.5;
const clampSpeed = (value: number) =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value * 20) / 20));
const SPLITS_KEY = "lyssna.ttml-splits";
const SPECTROGRAM_KEY = "lyssna.ttml-spectrogram";
const SYNC_ROMAN_KEY = "lyssna.ttml-sync-roman";
const GLIDE_MS = 550;
const OFFSET_KEY = "lyssna.ttml-offset";
const CLASSIC_KEY = "lyssna.ttml-classic-tabs";
const WORD_ROMAN_KEY = "lyssna.ttml-word-roman";
const VOICE_CLASS = ["", " sung-second", " sung-third"];
const WORD_VOICE_CLASS = [" sung-first", " sung-second", " sung-third"];
type Tab = "write" | "sync" | "preview";
const HISTORY_LIMIT = 200;

type Drag =
  | { kind: "line"; line: number }
  | { kind: "word" | "space"; at: Cursor; group?: Cursor[] };

const firstHalf = (event: ReactDragEvent, vertical: boolean) => {
  const box = event.currentTarget.getBoundingClientRect();
  return vertical
    ? event.clientY < box.top + box.height / 2
    : event.clientX < box.left + box.width / 2;
};

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private storage is a convenience; settings still apply this session.
  }
}

const AUTHOR_KEY = "lyssna.ttml-author";
const loadAuthor = (): MetaEntry[] => {
  try {
    const author = JSON.parse(readStorage(AUTHOR_KEY) ?? "[]");
    return Array.isArray(author) ? author : [];
  } catch {
    return [];
  }
};
const contentOf = (
  lines: CreatorLine[],
  text: string,
  metadata: MetaEntry[] | undefined,
) => JSON.stringify({ lines, text, metadata });

interface LyssnaSubmission {
  id: string;
  song_title: string;
  kind: "new" | "edit";
  status: string;
}

const meta = (track: Track): SongMeta => ({
  name: track.name,
  artists: track.artists.map((artist) => artist.name),
  album: track.album?.name,
  spotifyId: track.id,
  durationMs: track.duration_ms,
  songwriters: track.songwriters,
});

function TimePill({ ms, end }: { ms?: number; end?: boolean }) {
  const pill = useRef<HTMLSpanElement>(null);
  const shown = useRef(ms);
  useEffect(() => {
    if (shown.current === ms) return;
    shown.current = ms;
    if (ms === undefined || document.querySelector(".reduce-motion")) return;
    pill.current?.animate([{ background: "#1ed76073", color: "#fff" }, {}], {
      duration: 500,
      easing: "ease-out",
    });
  }, [ms]);
  return (
    <span
      ref={pill}
      className={`ttml-pill${end ? " end" : ""}${ms === undefined ? " empty" : ""}`}
    >
      {ms === undefined ? "--:--.---" : formatTime(ms)}
    </span>
  );
}

// The submission in the editor and how it opened, kept while the creator is
// closed so fixes are still told apart from the original afterwards.
const rememberedEdit: {
  current?: { id: string; uri: string; baseline?: string };
} = {};

/** Section names offered when naming a section; any other can be typed. */
const SECTION_NAMES = [
  "Intro",
  "Verse",
  "Pre-Chorus",
  "Chorus",
  "Post-Chorus",
  "Hook",
  "Bridge",
  "Breakdown",
  "Interlude",
  "Instrumental",
  "Drop",
  "Outro",
];

/** Edits a section header's name or singers in place; Escape keeps it. */
function SectionField({
  label,
  value,
  onDone,
}: {
  label: string;
  value: string;
  onDone: (value: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      className="ttml-part-field"
      aria-label={label}
      defaultValue={value}
      size={Math.max(8, value.length + 2)}
      spellCheck={false}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

/** "Differs from Genius" items waved off, where Genius has it wrong. */
const IGNORED_GENIUS = "lyssna.ttml.genius-ignored";
const ignoreKey = (each: { text: string; genius: string }) =>
  `${each.text}\u0000${each.genius}`;

export function TtmlCreator({
  state,
  onPlayer,
  onToggle,
  onSpeed,
  onApply,
  onParse,
  notify,
  renderPreview,
  barSlot,
  playbar,
  onSpectrogramBar,
  onClose,
  reviewer = false,
  marksInstrumental = false,
  unmarksInstrumental = false,
  reviewPick,
  reviewRestore = 0,
  onReviewOpen,
  onReviewed,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onToggle: () => void;
  onSpeed: (rate: number) => Promise<void>;
  onApply: (filename: string, ttml: string) => Promise<boolean>;
  onParse: (
    filename: string,
    contents: string,
    durationMs: number,
  ) => Promise<Lyrics>;
  notify: (message: string, error?: boolean) => void;
  renderPreview?: (lyrics: Lyrics, live?: Partial<AppState>) => ReactNode;
  /** Where the creator's own bar replaces the player bar. */
  barSlot?: HTMLElement | null;
  /** Slots in the app's player bar for the waveform, speed and spectrogram
   *  button, while the spectrogram is hidden. */
  playbar?: Record<"wave" | "speed" | "extras" | "play", HTMLElement | null>;
  /** The spectrogram needs the creator's own full-width bar. */
  onSpectrogramBar?: (on: boolean) => void;
  onClose?: () => void;
  /** The signed-in Lyssna account may review submissions. */
  reviewer?: boolean;
  /** Signed in to Lyssna, so the song can be sent as instrumental. */
  marksInstrumental?: boolean;
  /** Trusted and up may also take an instrumental mark back. */
  unmarksInstrumental?: boolean;
  /** Picked on the Review page, to open for review here. */
  reviewPick?: ReviewSubmission;
  /** Bumped to bring back the review panel, minimised or not. */
  reviewRestore?: number;
  /** The review panel opened or closed. */
  onReviewOpen?: (open: boolean) => void;
  /** A review decision was made, so waiting counts can refresh. */
  onReviewed?: () => void;
}) {
  const playing = state.playback.item;
  const [track, setTrack] = useState<Track | undefined>(playing);
  useEffect(() => {
    if (!track && playing) setTrack(playing);
  }, [track, playing]);

  const [lines, setLinesRaw] = useState<CreatorLine[]>([]);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState<Cursor>({ line: 0, unit: 0 });
  const history = useRef<{ past: CreatorLine[][]; future: CreatorLine[][] }>({
    past: [],
    future: [],
  });
  const [offset, setOffset] = useState(
    () => Number(readStorage(OFFSET_KEY)) || 0,
  );
  const clock = usePlaybackClock(state);
  // The Lyrics page shifts by the listener's timing offset to match what
  // they hear; the creator follows suit so taps and its preview agree.
  const heard = state.settings.lyric_offset_ms ?? 0;
  const native = state.playback.device.name === state.local_device_name;
  const here = !!track && playing?.uri === track.uri;
  // Soloist can briefly show no device, so once the creator holds the song
  // it keeps it until another device or song takes over.
  const holding = useRef(false);
  const device = state.playback.device.name;
  // After a restart a paused song shows on this computer until played, and
  // Play then goes to Soloist.
  const soloist =
    !!state.settings.soloist &&
    (device === SOLOIST_DEVICE ||
      (holding.current && !device) ||
      (device === state.local_device_name && !state.playback.is_playing));
  const keeps =
    !!track && (playing ? playing.uri === track.uri : holding.current);
  const [ownFailed, setOwnFailed] = useState(false);
  const ownFailedRef = useRef(false);
  holding.current = soloist && keeps && !ownFailed;
  const own = useCreatorPlayer({
    active: holding.current,
    uri: track?.uri,
    durationMs: track?.duration_ms ?? 0,
    volume: state.settings.volume_percent ?? 100,
    onFailed: (error) => {
      ownFailedRef.current = true;
      setOwnFailed(true);
      notify(
        `Lyssna couldn't play this song itself, so Spotify Soloist plays it at 1×: ${error}`,
        true,
      );
    },
  });
  // Spotify Soloist cannot change speed and reports its position late, so
  // the creator plays the song itself while it is open over Soloist.
  const local = own.active;
  const position = (local ? own.position : clock.position) + heard;
  const readClock = local ? own.read : clock.read;
  const read = useCallback(
    (at?: number) => readClock(at) + heard,
    [readClock, heard],
  );
  const rate = local ? own.rate : (state.playback_rate ?? 1);
  const isPlaying = local ? own.playing : state.playback.is_playing;

  const [savedAt, setSavedAt] = useState<number | undefined>();
  // Apple Music's sync the draft was seeded from: uploading names it, so
  // Lyssna keeps Apple's credit for the timing it did.
  const [appleOriginal, setAppleOriginal] = useState<AppleOriginal>();
  // The content last written for `uri`, so loading or seeding a song is not
  // mistaken for an edit and only real changes get a new save time.
  const [metadata, setMetadata] = useState<MetaEntry[] | undefined>();
  const saved = useRef({ uri: "", content: "", loading: false });
  const current = useRef({ uri: "", lines, text, metadata });
  const versions = useRef<{ at?: number; changed: boolean }>({
    changed: false,
  });
  const snapshot = useCallback((leaving: boolean) => {
    const { uri, lines, text, metadata } = current.current;
    const now = Date.now();
    if (
      !uri ||
      !versions.current.changed ||
      !newVersionDue(versions.current.at, now, leaving)
    )
      return;
    versions.current = { at: now, changed: false };
    void addVersion({ uri, savedAt: now, lines, text, metadata }).catch(
      () => {},
    );
  }, []);

  useEffect(() => {
    if (!track) return;
    const draft = loadDraft(track.uri);
    const loaded = joinHyphenated(draft?.lines ?? []);
    setLinesRaw(loaded);
    setText(draft?.text ?? "");
    setMetadata(draft?.metadata);
    setSavedAt(draft?.savedAt);
    setAppleOriginal(draft?.appleOriginal);
    saved.current = {
      uri: track.uri,
      content: contentOf(
        draft?.lines ?? [],
        draft?.text ?? "",
        draft?.metadata,
      ),
      loading: true,
    };
    versions.current = { changed: false };
    // Opening at the song's position keeps a line picked elsewhere, such
    // as one clicked in the Lyrics page preview.
    setCursor(cursorAt(loaded, read()));
    history.current = { past: [], future: [] };
    setTextMode(false);
    return () => snapshot(true);
  }, [track, snapshot]);

  useEffect(() => {
    const leave = () => snapshot(true);
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [snapshot]);

  const editedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const lyrics = state.lyrics;
    if (
      !track ||
      !here ||
      editedFor.current === track.uri ||
      state.lyrics_uri !== track.uri ||
      !lyrics?.lines.length ||
      lyrics.instrumental ||
      !canSeed(lyrics)
    )
      return;
    if (lines.length || text.trim() || loadDraft(track.uri)) return;
    const seeded = joinHyphenated(fromLyrics(lyrics));
    if (!seeded.length) return;
    setLinesRaw(seeded);
    setAppleOriginal(lyrics.apple_original);
    setCursor(cursorAt(seeded, read()));
    setText(toText(seeded));
    saved.current.content = contentOf(seeded, toText(seeded), metadata);
  }, [
    track,
    here,
    state.lyrics,
    state.lyrics_uri,
    lines.length,
    text,
    metadata,
  ]);

  useEffect(() => {
    if (!track) return;
    current.current = { uri: track.uri, lines, text, metadata };
    // The load above ran in this same commit; these are the previous song's.
    if (saved.current.loading) {
      saved.current.loading = false;
      return;
    }
    const content = contentOf(lines, text, metadata);
    if (saved.current.uri !== track.uri || saved.current.content === content)
      return;
    saved.current.content = content;
    versions.current.changed = true;
    if (!lines.length && !text.trim()) {
      writeDraft(track.uri, null);
      forgetWorking(track.uri);
      setSavedAt(undefined);
      setAppleOriginal(undefined);
      return;
    }
    const now = Date.now();
    writeDraft(track.uri, {
      lines,
      text,
      metadata,
      savedAt: now,
      song: track,
      appleOriginal,
    });
    setSavedAt(now);
    markWorking(track.uri);
    snapshot(false);
  }, [track, lines, text, metadata, snapshot, appleOriginal]);

  useEffect(() => () => void onSpeed(1), [onSpeed]);

  const ownRef = useRef(own);
  ownRef.current = own;
  const soloistRef = useRef({
    read: clock.read,
    playing: state.playback.is_playing,
    uri: playing?.uri,
  });
  soloistRef.current = {
    read: clock.read,
    playing: state.playback.is_playing,
    uri: playing?.uri,
  };
  const onPlayerRef = useRef(onPlayer);
  onPlayerRef.current = onPlayer;
  const handBack = useRef(0);
  const tookPlaying = useRef(false);
  useEffect(() => {
    if (!local) return;
    // A remount at once (React's development double run) keeps the song
    // where it is instead of handing it back and taking it again.
    if (handBack.current) {
      clearTimeout(handBack.current);
      handBack.current = 0;
    } else {
      const taken = soloistRef.current;
      const from = taken.read();
      tookPlaying.current = taken.playing;
      if (taken.playing) {
        direct(onPlayerRef.current, { command: "pause" });
        ownRef.current.play(from);
      } else ownRef.current.seek(from);
    }
    const uri = track?.uri;
    creatorTransport.current = {
      handle: (request) => {
        if (creatorTransport.passing) return false;
        const mine = ownRef.current;
        switch (request.command) {
          case "pause":
            mine.pause();
            return true;
          case "play":
            if (
              request.uris ||
              request.context ||
              (request.uri && request.uri !== uri)
            ) {
              mine.pause();
              return false;
            }
            mine.play(request.uri ? 0 : undefined);
            return true;
          case "next":
            mine.pause();
            return false;
          case "seek":
            mine.seek(request.positionMs ?? 0);
            return true;
          case "previous":
            // As Spotify does: early on it goes to the previous song.
            if (mine.read() < 3000) {
              mine.pause();
              return false;
            }
            mine.seek(0);
            return true;
          case "volume":
            if (request.volume !== undefined) mine.setVolume(request.volume);
            return false;
          default:
            return false;
        }
      },
      toggle: () => ownRef.current.toggle(),
    };
    return () => {
      creatorTransport.current = null;
      // Soloist carries on from where the creator left the song, playing
      // if the creator was, or if the creator never managed to start.
      const mine = ownRef.current;
      const sounding =
        mine.playing || (ownFailedRef.current && tookPlaying.current);
      const at = mine.read();
      handBack.current = window.setTimeout(() => {
        handBack.current = 0;
        if (soloistRef.current.uri !== uri) return;
        const finished = at >= (track?.duration_ms ?? 0) - 1000;
        direct(onPlayerRef.current, {
          command: "seek",
          positionMs: finished ? 0 : Math.round(at),
        });
        if (sounding && !finished)
          direct(onPlayerRef.current, { command: "play" });
      });
    };
    // Taking over happens once per song and Soloist session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  // The Preview tab's lyrics follow the creator's own playback.
  const anchors = useRef(0);
  const previewLive = useMemo((): Partial<AppState> | undefined => {
    if (!local) return undefined;
    const { anchor } = own;
    anchors.current += 1;
    return {
      playback: {
        ...state.playback,
        is_playing: anchor.playing,
        progress_ms: Math.round(anchor.position),
        device: { ...state.playback.device, name: state.local_device_name },
      },
      observed_at: Date.now() - (performance.now() - anchor.at),
      clock_revision: state.clock_revision + anchors.current,
      playback_rate: anchor.rate,
    };
    // Rebuilt only when the creator's clock re-anchors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, own.anchor]);
  // Soloist resumed elsewhere would play over the creator's own playback.
  const soloistPlayed = useRef(state.playback.is_playing);
  useEffect(() => {
    const resumed = state.playback.is_playing && !soloistPlayed.current;
    soloistPlayed.current = state.playback.is_playing;
    if (local && resumed) direct(onPlayerRef.current, { command: "pause" });
  }, [local, state.playback.is_playing]);

  const repeatRef = useRef(state.playback.repeat_state);
  repeatRef.current = state.playback.repeat_state;
  const playerRef = useRef(onPlayer);
  playerRef.current = onPlayer;
  useEffect(() => {
    if (!here) return;
    void rpc("hold_crossfade", { held: true }).catch(() => undefined);
    const release = () =>
      void rpc("hold_crossfade", { held: false }).catch(() => undefined);
    const before = repeatRef.current ?? "off";
    if (before === "track") return release;
    playerRef.current({ command: "repeat", repeat: "track" });
    return () => {
      release();
      playerRef.current({ command: "repeat", repeat: before });
    };
  }, [here]);

  const lastPosition = useRef(0);
  useEffect(() => {
    const duration = track?.duration_ms ?? 0;
    const wrapped =
      here &&
      isPlaying &&
      duration > 5000 &&
      lastPosition.current > duration - 2500 &&
      position < 2000;
    lastPosition.current = position;
    if (!wrapped) return;
    onPlayer({ command: "pause" });
    onPlayer({ command: "seek", positionMs: 0 });
  }, [position, here, isPlaying, track, onPlayer]);

  const setLines = useCallback(
    (next: CreatorLine[] | ((previous: CreatorLine[]) => CreatorLine[])) =>
      setLinesRaw((previous) => {
        const value = joinHyphenated(
          typeof next === "function" ? next(previous) : next,
        );
        if (value !== previous) {
          history.current.past = [
            ...history.current.past.slice(-HISTORY_LIMIT),
            previous,
          ];
          history.current.future = [];
        }
        return value;
      }),
    [],
  );
  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    setLinesRaw((current) => {
      history.current.future.push(current);
      return previous;
    });
  }, []);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    setLinesRaw((current) => {
      history.current.past.push(current);
      return next;
    });
  }, []);

  const [textMode, setTextMode] = useState(false);
  const [fetching, setFetching] = useState(false);
  const geniusFor = useRef(track?.uri);
  geniusFor.current = track?.uri;
  const fromGenius = () => {
    if (!track || fetching) return;
    const asked = track.uri;
    setFetching(true);
    rpc<string>("genius_lyrics", { track })
      .then((found) => {
        if (geniusFor.current !== asked) return;
        // Lands in the text editor, so nothing is replaced until Done.
        editedFor.current = asked;
        setText(geniusBackgrounds(found));
        setTextMode(true);
      })
      .catch((error) =>
        notify(`Couldn't get lyrics from Genius: ${error}`, true),
      )
      .finally(() => setFetching(false));
  };
  const sectionsFromGenius = () => {
    if (!track || fetching) return;
    const asked = track.uri;
    setFetching(true);
    rpc<string>("genius_lyrics", { track, styled: true })
      .then((found) => {
        if (geniusFor.current !== asked) return;
        const tagged = applySections(lines, found);
        if (!tagged) {
          notify("Genius has no sections that match these lines.", true);
          return;
        }
        setLines(tagged);
        setReview({
          before: lines,
          genius: found,
          changes: geniusChanges(lines, tagged, found),
        });
      })
      .catch((error) =>
        notify(`Couldn't get sections from Genius: ${error}`, true),
      )
      .finally(() => setFetching(false));
  };
  // What Sections from Genius changed, open until it's kept, undone or
  // the draft is edited (which keeps it).
  const [ignoredGenius, setIgnoredGenius] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(IGNORED_GENIUS) ?? "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [review, setReview] = useState<{
    before: CreatorLine[];
    genius: string;
    changes: GeniusChanges;
    shown?: CreatorLine[];
    /** Edited by hand since; Undo would throw that away, Ctrl+Z won't. */
    edited?: boolean;
  } | null>(null);
  // The panel stays open through edits and follows them.
  useEffect(() => {
    if (!review || review.shown === lines) return;
    setReview(
      review.shown
        ? {
            ...review,
            shown: lines,
            edited: true,
            changes: geniusChanges(review.before, lines, review.genius),
          }
        : { ...review, shown: lines },
    );
  }, [lines, review]);
  const [geniusOpen, setGeniusOpen] = useState(false);
  const geniusMenu = (
    <span className="ttml-export ttml-genius">
      <button
        onClick={() => setGeniusOpen(!geniusOpen)}
        disabled={!track || fetching}
        aria-expanded={geniusOpen}
        aria-busy={fetching}
        title="Lyrics or sections from Genius. Sends the title and artist to Genius."
      >
        <Globe size={15} />
        <span className="ttml-label">
          {fetching ? "Asking Genius…" : "Genius"}
        </span>
      </button>
      {geniusOpen && (
        <div className="ttml-meta-menu" role="menu">
          <button
            role="menuitem"
            title="Plain lyrics, without timing, into the text editor"
            onClick={() => {
              setGeniusOpen(false);
              fromGenius();
            }}
          >
            Lyrics from Genius
          </button>
          <button
            role="menuitem"
            disabled={!lines.length}
            title="Names sections like Chorus and Bridge on these lines and keeps every timing"
            onClick={() => {
              setGeniusOpen(false);
              sectionsFromGenius();
            }}
          >
            Sections from Genius
          </button>
        </div>
      )}
    </span>
  );
  const [previewOn, setPreviewOn] = useState(showsPreview);
  useEffect(() => {
    if (track) showLive(track.uri, lines);
  }, [track, lines]);
  const previewToggle = (
    <button
      aria-pressed={previewOn}
      className={previewOn ? "active" : ""}
      title="Show this draft on the Lyrics page, even before anything is saved"
      onClick={() => {
        setShowsPreview(!previewOn);
        setPreviewOn(!previewOn);
      }}
    >
      {previewOn ? <Eye size={15} /> : <EyeOff size={15} />}
      Show preview
    </button>
  );
  const [classic, setClassic] = useState(
    () => readStorage(CLASSIC_KEY) === "1",
  );
  const [tab, setTab] = useState<Tab>("write");
  const showSync = !classic || tab === "sync";
  const showEdit = !classic || tab === "write";
  // The separate Lyrics tab edits words as chips, with no timing in sight.
  const writing = classic && tab === "write";
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const [wordRoman, setWordRoman] = useState(
    () => readStorage(WORD_ROMAN_KEY) === "1",
  );
  const previewing = classic && tab === "preview";
  const preview = useMemo(
    () => (previewing ? toLyrics(lines) : null),
    [previewing, lines],
  );
  // Word starts picked with Ctrl or Shift, dragged as one bunch.
  const [group, setGroup] = useState<Cursor[]>([]);
  const groupRef = useRef(group);
  groupRef.current = group;
  // Picked Space blocks, each named by the word after it.
  const [spaces, setSpaces] = useState<Cursor[]>([]);
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  useEffect(() => {
    setGroup([]);
    setSpaces([]);
  }, [lines]);
  // Picks are single syllables, so one syllable of a word can be picked
  // without the rest.
  const inGroup = (at: Cursor) =>
    group.some((each) => each.line === at.line && each.unit === at.unit);
  const isSpace = (at: Cursor) =>
    spaces.some((each) => each.line === at.line && each.unit === at.unit);
  const pickSpace = (event: ReactMouseEvent, at: Cursor) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey)
      return setSpaces(
        isSpace(at)
          ? spaces.filter(
              (each) => each.line !== at.line || each.unit !== at.unit,
            )
          : [...spaces, at],
      );
    setSpaces([at]);
    setGroup([]);
  };
  const pickWord = (at: Cursor, range: boolean) => {
    const start = at;
    const base = group.length ? group : [cursor];
    if (range) {
      const from = cursor;
      const [first, last] =
        from.line < start.line ||
        (from.line === start.line && from.unit <= start.unit)
          ? [from, start]
          : [start, from];
      const picked: Cursor[] = [];
      for (let line = first.line; line <= last.line; line++)
        lines[line]?.units.forEach((unit, index) => {
          if (line === first.line && index < first.unit) return;
          if (line === last.line && index > last.unit) return;
          picked.push({ line, unit: index });
        });
      setGroup(picked);
      setSpaces(
        picked
          .slice(1)
          .filter(
            (at) => at.unit > 0 && !lines[at.line]?.units[at.unit]?.joined,
          ),
      );
      return;
    }
    const has = base.some(
      (each) => each.line === start.line && each.unit === start.unit,
    );
    setGroup(
      has
        ? base.filter(
            (each) => each.line !== start.line || each.unit !== start.unit,
          )
        : [...base, start],
    );
    setCursor(at);
  };
  const moveDragged = (
    dragged: { at: Cursor; group?: Cursor[] },
    to: Cursor,
  ) =>
    dragged.group
      ? moveWords(lines, dragged.group, to)
      : moveWord(lines, dragged.at, to);
  // A new blank line's Type word here box takes focus once it renders.
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const addBlankLine = (after: number) => {
    setLines(insertBlankLine(lines, after));
    setCursor({ line: after + 1, unit: 0 });
    setFocusLine(after + 1);
  };
  useEffect(() => {
    if (focusLine === null) return;
    list.current
      ?.querySelector<HTMLInputElement>(
        `[data-line="${focusLine}"] .ttml-chip-add`,
      )
      ?.focus();
    setFocusLine(null);
  }, [focusLine, lines]);
  // Word and line drags cancel the press, which would leave the box focused.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const box = document.activeElement;
      if (
        box instanceof HTMLInputElement &&
        box.classList.contains("ttml-chip-add") &&
        !box.contains(event.target as Node)
      )
        box.blur();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const applyText = () => {
    const unknown = unknownSections(text);
    if (unknown.length)
      notify(
        `Not a Genius section, so left out: ${[...new Set(unknown)].slice(0, 3).join(", ")}`,
        true,
      );
    const parsed = keepTimings(lines, parseText(text));
    setLines(parsed);
    // Timing picks up at the first word still waiting for a tap.
    const line = parsed.findIndex((each) =>
      each.units.some((unit) => unit.start === undefined),
    );
    setCursor((at) =>
      line < 0
        ? clampCursor(parsed, at)
        : {
            line,
            unit: parsed[line].units.findIndex(
              (unit) => unit.start === undefined,
            ),
          },
    );
    setTextMode(false);
  };
  const openText = () => {
    setText(toText(lines));
    setTextMode(true);
  };
  // The word being retyped in its own box after a double-click.
  const [inline, setInline] = useState<Cursor | null>(null);
  const commitWord = (at: Cursor, value: string) => {
    const next = editUnit(lines, at, value);
    if (next === lines) return;
    setLines(next);
    setCursor((cursor) => clampCursor(next, cursor));
  };

  const [learned, setLearned] = useState<LearnedSplits>(() => {
    try {
      return JSON.parse(readStorage(SPLITS_KEY) ?? "{}") as LearnedSplits;
    } catch {
      return {};
    }
  });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    at: Cursor;
    line?: boolean;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    x: number;
    y: number;
    line: number;
  } | null>(null);
  const [editingSection, setEditingSection] = useState<{
    line: number;
    field: "part" | "singer";
  } | null>(null);
  const [splitting, setSplitting] = useState<Cursor | null>(null);
  const [splittingReading, setSplittingReading] = useState<Cursor | null>(
    null,
  );
  const [replacing, setReplacing] = useState<Cursor | null>(null);
  const openMenu = (event: ReactMouseEvent, at: Cursor) => {
    event.preventDefault();
    if (at.line !== cursor.line) clickedLine.current = true;
    setCursor(at);
    setMenu({ x: event.clientX, y: event.clientY, at });
  };
  const openLineMenu = (event: ReactMouseEvent, line: number) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (line !== cursor.line) clickedLine.current = true;
    setCursor(clampCursor(lines, { line, unit: 0 }));
    setMenu({
      x: event.clientX,
      y: event.clientY,
      at: { line, unit: 0 },
      line: true,
    });
  };
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const pickedFrom = useRef(0);
  useEffect(() => setPicked(new Set()), [lines.length, track]);
  const pick = (index: number, range: boolean) => {
    const anchor = picked.size ? pickedFrom.current : cursor.line;
    const [from, to] = [anchor, index].sort((a, b) => a - b);
    pickedFrom.current = index;
    setPicked((old) => {
      const next = new Set(old);
      if (range) for (let at = from; at <= to; at++) next.add(at);
      else if (!next.delete(index)) next.add(index);
      return next;
    });
  };
  // Like AMLL: Ctrl-click adds or removes a line, Shift-click adds a range,
  // and a plain click on a line's empty space drops the selection.
  const pickProps = (index: number) => ({
    onMouseDown: (event: ReactMouseEvent) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey)
        event.preventDefault();
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (
        (event.shiftKey || event.ctrlKey || event.metaKey) &&
        !(event.target as Element).closest(
          ".ttml-unit, .ttml-chip, .ttml-space",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        pick(index, event.shiftKey);
      } else if (
        picked.size &&
        !(event.target as Element).closest("button, input, textarea")
      )
        setPicked(new Set());
    },
  });
  const flagLine = (index: number, key: "background" | "opposite") =>
    setLines(
      picked.has(index)
        ? setLineFlag(lines, picked, key, !lines[index][key])
        : toggleLine(lines, index, key),
    );
  const [shiftBy, setShiftBy] = useState(0);
  const allPicked = (key: "background" | "opposite") =>
    [...picked].every((index) => lines[index]?.[key]);
  const pickBar = picked.size > 0 && (
    <div className="ttml-pick-bar" role="toolbar" aria-label="Selected lines">
      <strong>
        {picked.size} line{picked.size === 1 ? "" : "s"} selected
      </strong>
      <button
        className={allPicked("background") ? "active" : ""}
        aria-pressed={allPicked("background")}
        onClick={() =>
          setLines(
            setLineFlag(lines, picked, "background", !allPicked("background")),
          )
        }
      >
        Background
      </button>
      <button
        className={allPicked("opposite") ? "active" : ""}
        aria-pressed={allPicked("opposite")}
        onClick={() =>
          setLines(
            setLineFlag(lines, picked, "opposite", !allPicked("opposite")),
          )
        }
      >
        Second singer
      </button>
      <label className="ttml-offset">
        Shift
        <input
          type="number"
          step={10}
          value={shiftBy}
          aria-label="Shift selected lines by milliseconds"
          onChange={(event) => setShiftBy(Number(event.target.value) || 0)}
        />
        ms
      </label>
      <button
        disabled={!shiftBy}
        onClick={() => setLines(shiftLines(lines, picked, shiftBy))}
      >
        Shift timing
      </button>
      <button onClick={() => setLines(clearLines(lines, picked))}>
        Clear timing
      </button>
      <button
        className="danger"
        onClick={() => restructure(removeLines(lines, picked))}
      >
        <Trash2 size={14} />
        Delete
      </button>
      <span className="ttml-pick-end">
        <button
          onClick={() => setPicked(new Set(lines.map((_, index) => index)))}
        >
          Select all
        </button>
        <button onClick={() => setPicked(new Set())}>Deselect</button>
      </span>
    </div>
  );
  const restructure = (next: CreatorLine[]) => {
    if (next === lines) return;
    setLines(next);
    setCursor((cursor) => clampCursor(next, cursor));
  };
  const [romanNote, setRomanNote] = useState("");
  const [syncRoman, setSyncRoman] = useState(
    () => readStorage(SYNC_ROMAN_KEY) === "1",
  );
  const romanJob = useRef(0);
  const autoRomanize = async () => {
    const job = ++romanJob.current;
    setRomanNote("Romanizing…");
    const request = romanizeRequest(lines);
    // Genius Romanizations, written by people, beats Lyssna's own reading
    // wherever one of its lines matches.
    const [ours, genius] = await Promise.all([
      romanizeLyrics(request).catch(() => null),
      track
        ? rpc<string>("genius_romanized", { track }).catch(() => "")
        : Promise.resolve(""),
    ]);
    if (job !== romanJob.current) return;
    if (!ours) {
      setRomanNote("Romanization failed.");
      return;
    }
    const fromGenius = genius
      ? readingsFrom(request, ours, genius)
      : { lyrics: ours, matched: 0 };
    const result = fromGenius.lyrics;
    // The worker hands back a copy, so compare readings rather than objects.
    const found = result.lines.some((line, lineIndex) =>
      line.words.some(
        (word, index) =>
          word.text.trim() !==
          request.lines[lineIndex]?.words[index]?.text.trim(),
      ),
    );
    setRomanNote(
      found
        ? ""
        : "Nothing to romanize: these lyrics are already in Latin letters.",
    );
    if (!found) return;
    setLines((current) => applyRomanized(current, request, result));
    if (fromGenius.matched)
      notify(
        `Romanized ${fromGenius.matched} ${fromGenius.matched === 1 ? "line" : "lines"} from Genius; Lyssna read the rest.`,
      );
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState("");
  const dragScroll = useRef({ speed: 0, frame: 0 });
  useEffect(() => {
    const scroll = dragScroll.current;
    return () => cancelAnimationFrame(scroll.frame);
  }, []);
  const endDrag = () => {
    setDrag(null);
    setDrop("");
    dragScroll.current.speed = 0;
  };
  const scrollWhileDragging = (event: ReactDragEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const edge = Math.min(90, box.height / 4);
    const reach = (distance: number) =>
      Math.min(1, 1 - distance / edge) ** 2 * 22;
    const scroll = dragScroll.current;
    scroll.speed =
      event.clientY - box.top < edge
        ? -reach(event.clientY - box.top)
        : box.bottom - event.clientY < edge
          ? reach(box.bottom - event.clientY)
          : 0;
    if (!scroll.speed || scroll.frame) return;
    const element = event.currentTarget;
    const step = () => {
      if (!scroll.speed) {
        scroll.frame = 0;
        return;
      }
      element.scrollTop += scroll.speed;
      scroll.frame = requestAnimationFrame(step);
    };
    scroll.frame = requestAnimationFrame(step);
  };
  const startDrag = (event: ReactDragEvent, next: Drag) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "");
    if (next.kind === "word") {
      // Shows every word being moved, not just the block under the pointer.
      const units = lines[next.at.line]?.units ?? [];
      const { start, end } = wordBounds(units, next.at.unit);
      const text = next.group
        ? [...next.group]
            .sort((a, b) => a.line - b.line || a.unit - b.unit)
            .map((at) => lines[at.line]?.units[at.unit]?.text ?? "")
            .join(" ")
        : units
            .slice(start, end)
            .map((unit) => unit.text)
            .join("");
      const ghost = document.createElement("div");
      ghost.className = "ttml-drag-ghost";
      ghost.textContent = text;
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 12, 16);
      setTimeout(() => ghost.remove());
    }
    setDrag(next);
  };
  // The picked words, or the selected word when none are picked.
  const pickedWords = () => (group.length ? group : [cursor]);
  const dragWords = (event: ReactDragEvent, at: Cursor) => {
    const words = pickedWords();
    const carry = words.some(
      (each) => each.line === at.line && each.unit === at.unit,
    );
    startDrag(
      event,
      carry && words.length > 1
        ? { kind: "word", at, group: words }
        : { kind: "word", at },
    );
  };
  const over = (event: ReactDragEvent, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDrop(key);
  };
  const land = (event: ReactDragEvent, next: CreatorLine[]) => {
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    restructure(next);
  };
  const dropClass = (key: string) =>
    drop.startsWith(`${key}:`) ? ` drop-${drop.slice(key.length + 1)}` : "";
  const voiceGroup = (index: number): MenuAction[][] => {
    const voices = sectionVoices(lines, index);
    if (!voices.length) return [];
    const current = lineVoice(lines, index);
    const targets = picked.has(index) ? picked : [index];
    return [
      voices.map((voice, at) => ({
        label: `Sung by ${voice}`,
        checked: at === current,
        run: () => setLines(setLineVoice(lines, targets, voice)),
      })),
    ];
  };
  const wordVoiceGroup = (at: Cursor, targets: Cursor[]): MenuAction[][] => {
    const voices = sectionVoices(lines, at.line);
    if (!voices.length) return [];
    const own = unitVoice(lines, at);
    const current = own >= 0 ? own : lineVoice(lines, at.line);
    return [
      voices.map((voice, index) => ({
        label: `${targets.length > 1 ? "Words" : "Word"} sung by ${voice}`,
        checked: index === current,
        run: () => setLines(setUnitVoice(lines, targets, voice)),
      })),
    ];
  };
  const sectionMenuGroups = (index: number): MenuAction[][] => {
    const line = lines[index];
    if (!line) return [];
    return [
      SECTION_NAMES.map((name) => ({
        label: name,
        checked: line.part === name,
        run: () => setLines(setSection(lines, index, name)),
      })),
      [
        {
          label: "Other name…",
          run: () => setEditingSection({ line: index, field: "part" }),
        },
        ...(line.part
          ? [
              {
                label: "Edit singers…",
                run: () => setEditingSection({ line: index, field: "singer" }),
              },
            ]
          : []),
      ],
      ...(line.part
        ? [
            [
              {
                label: "Remove section",
                run: () => setLines(setSection(lines, index)),
              },
            ],
          ]
        : []),
    ];
  };
  const lineMenuGroups = (index: number): MenuAction[][] => {
    const line = lines[index];
    if (!line) return [];
    const addAt = (after: number) => {
      setLines(insertBlankLine(lines, after));
      setCursor({ line: after + 1, unit: 0 });
      setFocusLine(after + 1);
    };
    const span = lineSpan(line);
    return [
      [
        { label: "Insert line above", run: () => addAt(index - 1) },
        { label: "Insert line below", run: () => addAt(index) },
        {
          label: "Duplicate line",
          run: () => setLines(duplicateLine(lines, index)),
        },
      ],
      [
        {
          label: "Background vocal",
          checked: line.background,
          run: () => flagLine(index, "background"),
        },
        ...(sectionVoices(lines, index).length
          ? []
          : [
              {
                label: "Second singer",
                checked: line.opposite,
                run: () => flagLine(index, "opposite"),
              },
            ]),
      ],
      ...voiceGroup(index),
      [
        {
          label: line.part ? "Edit section…" : "Start a section here…",
          run: () =>
            menu && setSectionMenu({ x: menu.x, y: menu.y, line: index }),
        },
      ],
      [
        {
          label: "Play from this line",
          disabled: !span,
          run: () => span && seek(span.start),
        },
        {
          label: "Clear line timing",
          disabled: !span,
          run: () => setLines(clearLines(lines, new Set([index]))),
        },
      ],
      [
        {
          label: "Delete line",
          run: () => restructure(removeLine(lines, index)),
        },
      ],
    ];
  };
  const menuGroups = (at: Cursor): MenuAction[][] => {
    const line = lines[at.line];
    const unit = line?.units[at.unit];
    if (!line || !unit) return [];
    const suggestion = suggestSplit(unit.text, learned);
    const chosen =
      group.length > 1 &&
      group.some((each) => each.line === at.line && each.unit === at.unit);
    const firstChosen = Math.min(
      ...group.filter((each) => each.line === at.line).map((each) => each.unit),
    );
    return [
      [
        {
          label: "Split word…",
          // In the romanization view the reading is what's on screen.
          run: () =>
            syncRoman && unit.roman
              ? setSplittingReading(at)
              : setSplitting(at),
        },
        {
          label: "Auto-segment word",
          disabled: !suggestion.length,
          run: () =>
            restructure(splitUnit(lines, at, cutAt(unit.text, suggestion))),
        },
        {
          label: "Replace word…",
          run: () => setReplacing(at),
        },
        ...(at.unit > 0
          ? [
              {
                label: unit.joined
                  ? "Space before this syllable"
                  : "Join to the word before",
                run: () => setLines(toggleJoin(lines, at)),
              },
            ]
          : []),
        { label: "Delete word", run: () => commitWord(at, "") },
      ],
      [
        {
          label: "Move following words to new line",
          disabled: (chosen ? firstChosen : at.unit) === 0,
          run: () => restructure(breakLine(lines, at, false, group)),
        },
        {
          label: chosen
            ? "Move selected words to new line"
            : "Move this word to new line",
          disabled: !chosen && line.units.length < 2,
          run: () => restructure(breakLine(lines, at, true, group)),
        },
      ],
      [
        {
          label: "Background line",
          checked: line.background,
          run: () => setLines(toggleLine(lines, at.line, "background")),
        },
        ...(sectionVoices(lines, at.line).length
          ? []
          : [
              {
                label: "Duet line",
                checked: line.opposite,
                run: () => setLines(toggleLine(lines, at.line, "opposite")),
              },
            ]),
      ],
      ...wordVoiceGroup(at, chosen ? group : [at]),
      ...voiceGroup(at.line),
      [
        {
          label: "Insert new line before",
          run: () => {
            addBlankLine(at.line - 1);
          },
        },
        {
          label: "Insert new line after",
          run: () => {
            addBlankLine(at.line);
          },
        },
        {
          label: "Duplicate line",
          run: () => restructure(duplicateLine(lines, at.line)),
        },
        {
          label: "Delete line",
          run: () => restructure(removeLine(lines, at.line)),
        },
      ],
    ];
  };
  const confirmReplace = (at: Cursor, choice: ReplaceChoice) => {
    const unit = lines[at.line]?.units[at.unit];
    setReplacing(null);
    if (!unit) return;
    if (!choice.replaceAll) return commitWord(at, choice.value);
    restructure(
      replaceMatching(lines, unit.text, choice.value, choice.matchCase),
    );
  };
  const confirmSplit = (at: Cursor, choice: SplitChoice) => {
    const unit = lines[at.line]?.units[at.unit];
    setSplitting(null);
    if (!unit) return;
    if (choice.learned) {
      const next = { ...learned, [choice.learned.key]: choice.learned.offsets };
      setLearned(next);
      writeStorage(SPLITS_KEY, JSON.stringify(next));
    }
    restructure(
      choice.applyAll
        ? splitMatching(
            lines,
            unit.text,
            (text) =>
              cutAt(
                text,
                text === unit.text
                  ? choice.offsets
                  : choice.offsets.filter((at) => at < Array.from(text).length),
              ),
            choice.ignoreCase,
          )
        : splitUnit(lines, at, cutAt(unit.text, choice.offsets)),
    );
  };
  const seedBlocked =
    state.lyrics && !canSeed(state.lyrics)
      ? "Spicy Lyrics lyrics, and Apple Music lyrics that don't come through Lyssna, can't be used as a starting point"
      : undefined;
  const seedable = here && !!state.lyrics?.lines.length && !seedBlocked;
  // A second click within a few seconds clears, so one stray click can't.
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = window.setTimeout(() => setClearArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [clearArmed]);
  const clearDraft = () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    // An empty draft is otherwise filled from the song's lyrics again.
    if (track) editedFor.current = track.uri;
    setLines([]);
    setText("");
    setMetadata(undefined);
    setAppleOriginal(undefined);
    setCursor({ line: 0, unit: 0 });
    notify("Draft cleared. Earlier saves are still under Saves.");
  };
  const splitBackingVocals = () => {
    const next = bracketsToBackground(lines);
    if (next === lines) {
      notify("No words in brackets to move.");
      return;
    }
    setLines(next);
    notify(
      `Moved ${next.length - lines.length} bracketed ${next.length - lines.length === 1 ? "part" : "parts"} to background lines.`,
    );
  };
  const splitAll = () => {
    const next = splitAllWords(lines, (text) =>
      cutAt(text, suggestSplit(text, learned)),
    );
    if (next === lines) {
      notify("No words to split into syllables.");
      return;
    }
    const added =
      next.reduce((sum, line) => sum + line.units.length, 0) -
      lines.reduce((sum, line) => sum + line.units.length, 0);
    restructure(next);
    notify(
      `Split words into ${added} more ${added === 1 ? "syllable" : "syllables"}. ${MODIFIER}+Z undoes it.`,
    );
  };
  const splitAllButton = (
    <button
      onClick={splitAll}
      disabled={!lines.length}
      title="Split every word into syllables. Words you already split stay as they are."
    >
      <Wand2 size={15} />
      Split all syllables
    </button>
  );
  const bracketsButton = (
    <button
      onClick={splitBackingVocals}
      disabled={!lines.length}
      title="Move words in brackets to background vocal lines. Brackets that open a line stay."
    >
      <Layers size={15} />
      Brackets to background
    </button>
  );
  const clearButton = (
    <button
      className={clearArmed ? "danger" : ""}
      onClick={clearDraft}
      disabled={!lines.length && !text.trim() && !metadata}
      title="Remove every line, word and timing from this draft"
    >
      <Trash2 size={15} />
      {clearArmed ? "Click again to clear" : "Clear draft"}
    </button>
  );
  const [resettingSource, setResettingSource] = useState(false);
  const resetToSource = async () => {
    if (!track || !here || resettingSource) return;
    const uri = track.uri;
    setResettingSource(true);
    try {
      const lyrics = await rpc<Lyrics>("source_lyrics", { track });
      if (current.current.uri !== uri) return;
      const seeded = lyrics?.lines.length ? fromLyrics(lyrics) : [];
      if (!seeded.length) {
        notify("No source lyrics found for this song.");
        return;
      }
      editedFor.current = uri;
      setLines(seeded);
      setText(toText(seeded));
      setMetadata(undefined);
      setAppleOriginal(lyrics.apple_original);
      setCursor(cursorAt(seeded, read()));
      notify(`Reset to ${lyrics.source}. ${MODIFIER}+Z brings the lines back.`);
    } catch {
      if (current.current.uri === uri)
        notify("Couldn't load source lyrics. Try again.");
    } finally {
      setResettingSource(false);
    }
  };
  const startFromLyrics = () => {
    if (!state.lyrics || !seedable) return;
    const seeded = fromLyrics(state.lyrics);
    setAppleOriginal(state.lyrics.apple_original);
    setLines(seeded);
    setText(toText(seeded));
    setCursor({ line: 0, unit: 0 });
  };

  const tap = useCallback(
    (at?: number) => Math.round(read(at) + offset),
    [read, offset],
  );
  const seek = useCallback(
    (ms: number) =>
      onPlayer({ command: "seek", positionMs: Math.max(0, Math.round(ms)) }),
    [onPlayer],
  );
  // Right-clicking a word on the spectrogram plays only that word, as in
  // AMLL's tool. Seeking and pausing the player is late by its buffering,
  // so Lyssna's own output plays the word's decoded samples, cut at its
  // exact edges, at the player's volume.
  const clipAsked = useRef(0);
  const [clipping, setClipping] = useState<{
    start: number;
    end: number;
    began: number;
  } | null>(null);
  const [clipNow, setClipNow] = useState(0);
  useEffect(() => {
    if (!clipping) return;
    let frame = 0;
    const tick = (time: number) => {
      setClipNow(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // The song waits where the word ends, as the playhead does.
    const done = window.setTimeout(() => {
      seek(clipping.end);
      setClipping(null);
    }, clipping.end - clipping.start);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [clipping, seek]);
  const shownPosition = clipping
    ? Math.min(
        clipping.end,
        clipping.start + Math.max(0, clipNow - clipping.began),
      )
    : position;
  const playUnit = useCallback(
    (at: Cursor) => {
      const unit = lines[at.line]?.units[at.unit];
      const range =
        unit?.start !== undefined && unit.end !== undefined
          ? { start: unit.start, end: unit.end }
          : lines[at.line] && lineSpan(lines[at.line]);
      if (!track || !range || range.end <= range.start) return;
      setCursor(at);
      if (local) {
        own.play(range.start, range.end);
        return;
      }
      setClipping(null);
      if (state.playback.is_playing) onPlayer({ command: "pause" });
      seek(range.start);
      const asked = ++clipAsked.current;
      rpc("play_clip", {
        uri: track.uri,
        fromMs: range.start,
        toMs: range.end,
      })
        .then(() => {
          if (asked !== clipAsked.current) return;
          const began = performance.now();
          setClipNow(began);
          setClipping({ ...range, began });
        })
        .catch((error) => notify(`Couldn't play the word: ${error}`, true));
    },
    [
      lines,
      seek,
      track,
      state.playback.is_playing,
      onPlayer,
      notify,
      local,
      own,
    ],
  );
  useEffect(() => {
    if (!state.playback.is_playing || local) return;
    clipAsked.current++;
    setClipping(null);
    void rpc("stop_clip").catch(() => undefined);
  }, [state.playback.is_playing, local]);
  // The creator's own player stops itself, after React's development remount.
  useEffect(
    () => () => {
      if (!ownRef.current.active) void rpc("stop_clip").catch(() => undefined);
    },
    [],
  );
  const changeSpeed = useCallback(
    (next: number) => {
      if (local) own.setRate(next);
      else if (native)
        void onSpeed(next).catch((error) => notify(String(error), true));
    },
    [onSpeed, notify, local, native, own],
  );
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const speedTimer = useRef(0);
  const slideSpeed = (value: number) => {
    setSpeedDraft(value);
    clearTimeout(speedTimer.current);
    speedTimer.current = window.setTimeout(() => {
      changeSpeed(value);
      speedTimer.current = window.setTimeout(() => setSpeedDraft(null), 1000);
    }, 120);
  };
  useEffect(() => () => clearTimeout(speedTimer.current), []);
  const shownSpeed = speedDraft ?? rate;
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const volumeTimer = useRef(0);
  const changeVolume = (percent: number) => {
    setVolumeDraft(percent);
    clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => {
      onPlayer({ command: "volume", volume: Math.round(percent) });
      volumeTimer.current = window.setTimeout(() => setVolumeDraft(null), 1500);
    }, 80);
  };
  useEffect(() => () => clearTimeout(volumeTimer.current), []);
  const barVolume =
    volumeDraft ??
    state.playback.device.volume_percent ??
    state.settings.volume_percent ??
    70;

  const [keys, setKeys] = useState<KeyMap>(loadKeys);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [editingKeys, setEditingKeys] = useState(false);
  const [touring, setTouring] = useState(false);
  // The list holds still during the walkthrough so its highlights stay put.
  const touringRef = useRef(touring);
  touringRef.current = touring;
  const changeKeys = useCallback((next: KeyMap) => {
    setKeys(next);
    saveKeys(next);
  }, []);
  // Drafts already save on every edit; Ctrl+S keeps a version now and
  // confirms it.
  const saveNow = useRef(() => {});
  saveNow.current = () => {
    if (!current.current.uri || !savedAt) return;
    snapshot(true);
    setSavedAt(Date.now());
  };
  const stateRef = useRef({ lines, cursor });
  stateRef.current = { lines, cursor };
  const wordField = useRef<HTMLInputElement>(null);
  const editable = !textMode && lines.length > 0 && !previewing;
  useEffect(() => {
    if (!editable || readStorage(TOUR_KEY)) return;
    // Seen once is enough, even if the walkthrough is never finished.
    writeStorage(TOUR_KEY, "1");
    setTouring(true);
  }, [editable]);
  const endTour = useCallback(() => {
    setTouring(false);
    writeStorage(TOUR_KEY, "1");
  }, []);
  const selectedLine = lines[cursor.line];
  const selectedUnit = selectedLine?.units[cursor.unit];
  // Enter keeps an edit and Escape drops it; either way the keys go back
  // to timing.
  const leaveField = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape")
      event.currentTarget.value = event.currentTarget.defaultValue;
    event.currentTarget.blur();
  };
  useEffect(() => {
    if (!editable) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector(".ttml-menu, .ttml-dialog")) return;
      if (
        (IS_MAC ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        saveNow.current();
        return;
      }
      // Shortcuts take Cmd on macOS, where Ctrl is no modifier of ours.
      if (
        target?.closest("input, textarea, select, [contenteditable=true]") ||
        event.altKey ||
        (IS_MAC ? event.ctrlKey : event.metaKey)
      )
        return;
      const { lines, cursor } = stateRef.current;
      const ctrl = IS_MAC ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const erase = event.key === "Delete" || event.key === "Backspace";
      const words = groupRef.current,
        gaps = spacesRef.current;
      const linesPicked = pickedRef.current.size > 0 && !words.length;
      let handled = true;
      if (ctrl && key === "z") (event.shiftKey ? redo : undo)();
      else if (ctrl && key === "y") redo();
      else if (
        (ctrl && erase) ||
        (!ctrl && event.key === "Delete" && !linesPicked)
      ) {
        const next =
          words.length || gaps.length
            ? deletePicked(lines, words, gaps)
            : editUnit(lines, cursor, "");
        setLines(next);
        setCursor(clampCursor(next, cursor));
        setGroup([]);
        setSpaces([]);
      } else if (ctrl && key === "e") {
        if (writingRef.current) setInline(cursor);
        else wordField.current?.focus();
      } else if (ctrl && key === "a") {
        // First the current line's words, then every line.
        const all =
          lines[cursor.line]?.units.map((_, unit) => ({
            line: cursor.line,
            unit,
          })) ?? [];
        const whole =
          all.length > 0 &&
          words.length === all.length &&
          words.every((each) => each.line === cursor.line);
        setSpaces([]);
        if (whole || !all.length) {
          setGroup([]);
          setPicked(new Set(lines.map((_, index) => index)));
        } else {
          setPicked(new Set());
          setGroup(all);
        }
      } else if (ctrl && key === "d" && lines[cursor.line]) {
        setLines(duplicateLine(lines, cursor.line));
        setCursor({ line: cursor.line + 1, unit: cursor.unit });
      } else if (ctrl) handled = false;
      else if (erase && linesPicked) {
        const next = removeLines(lines, pickedRef.current);
        setLines(next);
        setCursor(clampCursor(next, cursor));
        setPicked(new Set());
      } else if (writingRef.current && erase) {
        const next =
          words.length || gaps.length
            ? deletePicked(lines, words, gaps)
            : editUnit(lines, cursor, "");
        setLines(next);
        setCursor(clampCursor(next, cursor));
        setGroup([]);
        setSpaces([]);
      } else if (event.key === "F2") {
        if (writingRef.current) setInline(cursor);
        else wordField.current?.focus();
      } else if (event.key === "Enter") {
        // Enter on a focused button presses it.
        if (target?.closest("button, a")) handled = false;
        else if (writingRef.current && lines[cursor.line]?.units[cursor.unit])
          setInline(cursor);
        else {
          setLines(insertBlankLine(lines, cursor.line));
          setCursor({ line: cursor.line + 1, unit: 0 });
          setFocusLine(cursor.line + 1);
        }
      } else if (event.key === "Escape") {
        setGroup([]);
        setSpaces([]);
        setPicked(new Set());
      } else if (event.key === "ArrowLeft" && event.shiftKey)
        seek(read() - 3000);
      else if (event.key === "ArrowRight" && event.shiftKey)
        seek(read() + 3000);
      else if (!showSync && !event.key.startsWith("Arrow")) handled = false;
      else {
        const arrows: Record<string, KeyAction> = {
          ArrowLeft: "previous",
          ArrowRight: "following",
          ArrowUp: "lineUp",
          ArrowDown: "lineDown",
          Backspace: "clear",
        };
        const action = arrows[event.key] ?? actionFor(keysRef.current, key);
        const timing = ["start", "next", "end"].includes(action ?? "");
        if (action === "previous")
          setCursor(previousCursor(lines, cursor) ?? cursor);
        else if (action === "following")
          setCursor(nextCursor(lines, cursor) ?? cursor);
        else if (action === "lineUp")
          setCursor(clampCursor(lines, { line: cursor.line - 1, unit: 0 }));
        else if (action === "lineDown")
          setCursor(clampCursor(lines, { line: cursor.line + 1, unit: 0 }));
        else if (action === "normalSpeed") changeSpeed(1);
        else if (action === "slower") changeSpeed(clampSpeed(rate - 0.05));
        else if (action === "faster") changeSpeed(clampSpeed(rate + 0.05));
        else if (!action || !here || !lines.length) handled = false;
        else if (action === "jumpBack" || action === "jumpForward") {
          const to =
            (action === "jumpBack"
              ? previousCursor(lines, cursor)
              : nextCursor(lines, cursor)) ?? cursor;
          setCursor(to);
          const start = lines[to.line]?.units[to.unit]?.start;
          if (start !== undefined) seek(start);
        } else if (event.repeat && timing) handled = true;
        else if (timing) {
          const time = tap(event.timeStamp);
          const at = timingCursor(lines, cursor, time);
          if (action === "start") {
            setLines(markStart(lines, at, time));
            if (at !== cursor) setCursor(at);
          } else {
            const result = (action === "next" ? markNext : markEnd)(
              lines,
              at,
              time,
            );
            setLines(result.lines);
            setCursor(result.cursor);
          }
        } else if (action === "replay") {
          const line = lines[cursor.line];
          const before = lines[cursor.line - 1];
          const from =
            (line && lineSpan(line)?.start) ??
            (before && lineSpan(before)?.end) ??
            read();
          seek(from - 2000);
        } else if (action === "clear") setLines(clearTiming(lines, cursor));
        else handled = false;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    editable,
    showSync,
    here,
    tap,
    read,
    seek,
    undo,
    redo,
    setLines,
    changeSpeed,
    rate,
  ]);

  const list = useRef<HTMLDivElement>(null);
  const glide = useRef(0);
  const reduceMotion = !!state.settings.reduce_motion;
  const centre = useCallback(
    (index: number, instant = false) => {
      const container = list.current;
      const line = container?.querySelector<HTMLElement>(
        `[data-line="${index}"]`,
      );
      if (!container || !line) return;
      cancelAnimationFrame(glide.current);
      const box = container.getBoundingClientRect();
      const row = line.getBoundingClientRect();
      const from = container.scrollTop;
      const to = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          from + row.top - box.top - (box.height - row.height) / 2,
        ),
      );
      if (instant || reduceMotion || Math.abs(to - from) < 1) {
        container.scrollTop = to;
        return;
      }
      const start = performance.now();
      const step = (time: number) => {
        const t = Math.min(1, (time - start) / GLIDE_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        container.scrollTop = from + (to - from) * eased;
        if (t < 1) glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    },
    [reduceMotion],
  );
  useEffect(() => () => cancelAnimationFrame(glide.current), []);
  // A line picked with the mouse is already in view; scrolling it to the
  // middle would move the word away from the pointer.
  const clickedLine = useRef(false);
  useEffect(() => {
    if (clickedLine.current) {
      clickedLine.current = false;
      return;
    }
    if (touringRef.current) return;
    centre(cursor.line);
  }, [cursor.line, centre]);

  const shownWord = useRef<(Cursor & { start: number }) | null>(null);
  const liveWord = useMemo(() => {
    let next: (Cursor & { start: number }) | null = null;
    lines.forEach((line, lineIndex) =>
      line.units.forEach((unit, unitIndex) => {
        if (
          unit.start !== undefined &&
          unit.end !== undefined &&
          position >= unit.start &&
          position < unit.end
        )
          next = { line: lineIndex, unit: unitIndex, start: unit.start };
      }),
    );
    const shown = shownWord.current;
    const found = next as (Cursor & { start: number }) | null;
    // The clock can step back a few ms; only a real seek lights an earlier word.
    if (
      shown &&
      found &&
      found.start < shown.start &&
      shown.start - position < 250
    )
      return shown;
    shownWord.current = found;
    return found;
  }, [lines, position]);
  // Overlapping lines, like a second singer or background vocals, sing
  // together, so every word under the playhead lights up.
  const liveWords = useMemo(
    () => singingAt(lines, position),
    [lines, position],
  );
  const [peaks, setPeaks] = useState<{
    uri: string;
    values: Uint8Array;
  } | null>(null);
  const trackUri = track?.uri;
  const [spectrogram, setSpectrogram] = useState(
    () => readStorage(SPECTROGRAM_KEY) === "1",
  );
  const showSpectrogram = (on: boolean) => {
    setSpectrogram(on);
    writeStorage(SPECTROGRAM_KEY, on ? "1" : null);
  };
  useEffect(() => {
    if (!(barSlot || playbar?.wave) || !trackUri || peaks?.uri === trackUri)
      return;
    let current = true;
    rpc<number[]>("track_waveform", { uri: trackUri, buckets: 2400 })
      .then(
        (values) =>
          current &&
          Array.isArray(values) &&
          setPeaks({ uri: trackUri, values: Uint8Array.from(values) }),
      )
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [barSlot, playbar?.wave, trackUri, peaks?.uri]);
  const spectral = spectrogram && !!track;
  useEffect(() => {
    onSpectrogramBar?.(spectral);
  }, [spectral, onSpectrogramBar]);
  useEffect(() => () => onSpectrogramBar?.(false), [onSpectrogramBar]);
  const barSpans = useMemo(
    () =>
      lines.flatMap((line, index) => {
        if (index !== cursor.line && !picked.has(index)) return [];
        const span = lineSpan(line);
        return span ? [{ ...span, current: true }] : [];
      }),
    [lines, cursor.line, picked],
  );
  const playingLine = useMemo(() => {
    let found = -1;
    lines.forEach((line, index) => {
      const span = lineSpan(line);
      if (span && span.start <= position) found = index;
    });
    return found;
  }, [lines, position]);
  // Clicking a line in the preview seeks there, so coming back from it
  // picks up at the line and word the song is on.
  const selectPlaying = () => {
    if (playingLine >= 0) setCursor(cursorAt(lines, position));
  };
  const scrolledAt = useRef(0);
  const typingInCreator = () => {
    const box = document.activeElement;
    return (
      (box instanceof HTMLTextAreaElement ||
        (box instanceof HTMLInputElement &&
          /^(text|search|number|)$/.test(box.type))) &&
      !!box.closest(".ttml-creator")
    );
  };
  // Playback doesn't pull the list away from words being worked on.
  const working =
    inline !== null ||
    menu !== null ||
    splitting !== null ||
    replacing !== null ||
    picked.size > 0 ||
    group.length > 0 ||
    spaces.length > 0 ||
    drag !== null;
  const workingRef = useRef(working);
  workingRef.current = working;
  // A double-click replays from just before a word, which can start in the
  // line above; the view stays put until playback reaches the word's line.
  const holdLine = useRef<number | null>(null);
  // The Genius review panel holds the view still while it's open, so the
  // lines it points at stay put; following picks up 3s after it closes.
  const geniusPanel = !!review;
  const geniusPanelRef = useRef(geniusPanel);
  geniusPanelRef.current = geniusPanel;
  const following = useRef({ playingLine, isPlaying });
  following.current = { playingLine, isPlaying };
  const geniusPanelWas = useRef(false);
  useEffect(() => {
    if (geniusPanel) {
      geniusPanelWas.current = true;
      return;
    }
    if (!geniusPanelWas.current) return;
    geniusPanelWas.current = false;
    const timer = window.setTimeout(() => {
      const { playingLine, isPlaying } = following.current;
      if (isPlaying && playingLine >= 0 && !geniusPanelRef.current)
        centre(playingLine);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [geniusPanel, centre]);
  useEffect(() => {
    if (
      playingLine < 0 ||
      touringRef.current ||
      !isPlaying ||
      workingRef.current ||
      geniusPanelRef.current ||
      typingInCreator() ||
      Date.now() - scrolledAt.current < 3000
    )
      return;
    if (holdLine.current !== null) {
      if (playingLine < holdLine.current) return;
      holdLine.current = null;
    }
    centre(playingLine);
  }, [playingLine, isPlaying, centre]);
  const toured = useRef(false);
  useEffect(() => {
    if (touring) {
      toured.current = true;
      return;
    }
    if (!toured.current) return;
    toured.current = false;
    centre(isPlaying && playingLine >= 0 ? playingLine : cursor.line);
    // Only the walkthrough closing moves the list here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touring]);

  const issues = useMemo(() => problems(lines), [lines]);
  const { done, total } = progress(lines);
  const entries = useMemo(
    () =>
      track
        ? metadata
          ? withSongwriters(metadata, meta(track))
          : defaultMetadata(meta(track), loadAuthor())
        : (metadata ?? []),
    [metadata, track],
  );
  const ttml = () => (track ? toTtml(lines, meta(track), entries) : "");

  const [reviewing, setReviewing] = useState(false);
  const [reviewOpening, setReviewOpening] = useState<ReviewSubmission>();
  useEffect(() => {
    if (reviewer && reviewInProgress()) setReviewing(true);
  }, [reviewer]);
  useEffect(() => {
    if (reviewRestore && reviewer) setReviewing(true);
  }, [reviewRestore, reviewer]);
  const reviewOpen = reviewer && reviewing;
  useEffect(() => {
    onReviewOpen?.(reviewOpen);
  }, [reviewOpen, onReviewOpen]);
  useEffect(() => () => onReviewOpen?.(false), [onReviewOpen]);
  useEffect(() => {
    if (!reviewPick || !reviewer || !isFreshPick(reviewPick)) return;
    setReviewOpening(reviewPick);
    setReviewing(true);
  }, [reviewPick, reviewer]);
  const [reviewEdit, setReviewEdit] = useState(() => rememberedEdit.current);
  useEffect(() => {
    rememberedEdit.current = reviewEdit;
  }, [reviewEdit]);
  const pendingReview = useRef<ReviewOpen | undefined>(undefined);
  const [reviewTick, setReviewTick] = useState(0);
  const openReview = (open: ReviewOpen) => {
    pendingReview.current = open;
    if (playing?.uri !== open.uri) onPlayer({ command: "play", uri: open.uri });
    setReviewTick((tick) => tick + 1);
  };
  // A submission opens once its song plays, so the editor holds that song;
  // after the song's own draft loads, its lines give way to the submission's.
  useEffect(() => {
    const open = pendingReview.current;
    if (!open || playing?.uri !== open.uri) return;
    if (track?.uri !== open.uri) {
      setTrack(playing);
      return;
    }
    pendingReview.current = undefined;
    void onParse("review.ttml", open.ttml, track.duration_ms)
      .then((lyrics) => {
        const loaded = fromLyrics(lyrics);
        setLines(loaded);
        setText(toText(loaded));
        setCursor({ line: 0, unit: 0 });
        setReviewEdit({ id: open.submission.id, uri: open.uri });
        notify(
          `Opened ${open.submission.song_title} for review. Ctrl+Z goes back to your draft.`,
        );
      })
      .catch((error) =>
        notify(`Couldn't open the submission: ${String(error)}`, true),
      );
  }, [reviewTick, playing, track]);
  // What the editor makes of the submission untouched, to tell real fixes apart.
  useEffect(() => {
    if (
      reviewEdit &&
      reviewEdit.baseline === undefined &&
      track?.uri === reviewEdit.uri
    )
      setReviewEdit({ ...reviewEdit, baseline: ttml() });
  }, [reviewEdit, lines]);
  const submitFix = async (fixed: string) => {
    if (!track || track.uri !== reviewEdit?.uri)
      throw new Error("Play the submission's song to submit your fixes.");
    await rpc<LyssnaSubmission>("lyssna_submit", { ttml: fixed, track });
    setReviewEdit(undefined);
  };
  const reviewButton = reviewer && (
    <button
      onClick={() => setReviewing(!reviewing)}
      title="Review submissions"
      aria-pressed={reviewing}
    >
      <ClipboardCheck size={15} />
      <span className="ttml-label">Review</span>
    </button>
  );
  const reviewPanel = reviewer && reviewing && (
    <ReviewPanel
      initial={reviewOpening}
      restore={reviewRestore}
      playing={playing}
      editing={
        reviewEdit?.baseline !== undefined && track?.uri === reviewEdit.uri
          ? { id: reviewEdit.id, baseline: reviewEdit.baseline }
          : undefined
      }
      editorTtml={ttml}
      onPlay={(uri) => onPlayer({ command: "play", uri })}
      onOpen={openReview}
      onParse={(text) =>
        onParse(
          "review.ttml",
          text,
          track?.duration_ms ?? playing?.duration_ms ?? 0,
        )
      }
      onSubmitFix={submitFix}
      onDecided={() => onReviewed?.()}
      notify={notify}
      onClose={() => {
        setReviewing(false);
        setReviewOpening(undefined);
      }}
    />
  );
  const [editingMeta, setEditingMeta] = useState(false);
  const changeMetadata = (next: MetaEntry[]) => {
    setMetadata(next);
    const author = next.filter(
      (entry) =>
        AUTHOR_KEYS.includes(entry.key) &&
        entry.values.some((value) => value.trim()),
    );
    // Clearing one song's fields keeps the author for the next song.
    if (author.length) writeStorage(AUTHOR_KEY, JSON.stringify(author));
  };

  const [exporting, setExporting] = useState(false);
  const download = (format: ExportFormat | "ttml" = "ttml") => {
    if (!track) return;
    setExporting(false);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([format === "ttml" ? ttml() : exportLyrics(format, lines)], {
        type: format === "ttml" ? "application/ttml+xml" : "text/plain",
      }),
    );
    link.download = fileName(meta(track)).replace(/\.ttml$/, `.${format}`);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };
  const importFile = async (file: File) => {
    if (file.size > 2_000_000) return notify("Lyric file exceeds 2 MB", true);
    const format = formatOf(file.name);
    const source = await file.text();
    try {
      const parsed = (WORD_FORMATS as readonly string[]).includes(format)
        ? parseWordFormat(format as WordFormat, source)
        : fromLyrics(await onParse(file.name, source, track?.duration_ms ?? 0));
      if (!parsed.length)
        return notify(`No lyrics found in ${file.name}.`, true);
      setLines(parsed);
      setText(toText(parsed));
      setCursor({ line: 0, unit: 0 });
      notify(
        `Imported ${parsed.length} line${parsed.length === 1 ? "" : "s"} from ${file.name}. Ctrl+Z undoes it.`,
      );
    } catch (error) {
      notify(`Couldn't read ${file.name}: ${String(error)}`, true);
    }
  };
  // A lyric file dropped anywhere while the creator is open belongs in the
  // creator, not in the song's saved lyrics, where the app sends drops.
  const importRef = useRef(importFile);
  importRef.current = importFile;
  useEffect(() => {
    const carriesFile = (event: DragEvent) =>
      !!event.dataTransfer?.types.includes("Files");
    const over = (event: DragEvent) => {
      if (!carriesFile(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const drop = (event: DragEvent) => {
      if (!carriesFile(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer?.files[0];
      if (file) void importRef.current(file);
    };
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, []);
  const importPicker = useRef<HTMLInputElement>(null);
  const pickImport = () => importPicker.current?.click();
  const importInput = (
    <input
      ref={importPicker}
      type="file"
      hidden
      accept=".ttml,.xml,.lrc,.qrc,.yrc,.lys,.eslrc"
      aria-label="Lyric file to import"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFile(file);
      }}
    />
  );
  const copy = () =>
    void navigator.clipboard.writeText(ttml()).then(
      () => notify("TTML copied."),
      () => notify("Couldn't copy the TTML.", true),
    );
  const apply = () => {
    if (!track || !here) return;
    void onApply(fileName(meta(track)), ttml());
  };
  const [submitting, setSubmitting] = useState(false);
  // A local file goes to Lyssna under its recording's ISRC, from its tag, a
  // search by title, artist and length, or a match made here by hand.
  const [localIsrc, setLocalIsrc] = useState<string | null>(null);
  const [isrcInput, setIsrcInput] = useState("");
  const [matching, setMatching] = useState(false);
  useEffect(() => {
    setLocalIsrc(null);
    if (!track?.is_local) return;
    let active = true;
    void rpc<string | null>("local_track_isrc", { track }).then(
      (isrc) => {
        if (active) setLocalIsrc(isrc ?? null);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [track]);
  const matchIsrc = async () => {
    if (!track || matching || !isrcInput.trim()) return;
    setMatching(true);
    try {
      const isrc = await rpc<string>("local_match_isrc", {
        track,
        value: isrcInput,
      });
      setLocalIsrc(isrc);
      setIsrcInput("");
      notify(`Matched this file to ${isrc}.`);
    } catch (error) {
      notify(String(error), true);
    } finally {
      setMatching(false);
    }
  };
  const submittable = !!track && (track.is_local ? !!localIsrc : !!track.id);
  const submit = async () => {
    if (!track || submitting) return;
    setSubmitting(true);
    try {
      const result = await rpc<LyssnaSubmission>("lyssna_submit", {
        ttml: ttml(),
        track,
        authoredAt: savedAt ? new Date(savedAt).toISOString() : undefined,
        appleOriginal,
      });
      notify(
        result.status === "approved"
          ? `${result.song_title} is live on Lyssna.`
          : `${result.kind === "edit" ? "Your edit to " : ""}${result.song_title} is waiting for review on Lyssna.`,
      );
    } catch (error) {
      notify(String(error), true);
    } finally {
      setSubmitting(false);
    }
  };

  const [saves, setSaves] = useState<{
    songs: SavedSong[];
    versions: DraftVersion[];
  } | null>(null);
  const [olderSaves, setOlderSaves] = useState(false);
  const openSaves = () => {
    setOlderSaves(false);
    setSaves({ songs: listDrafts(), versions: [] });
    if (track)
      void listVersions(track.uri).then(
        (versions) => setSaves((open) => open && { ...open, versions }),
        () => {},
      );
  };
  const restore = (version: DraftVersion) => {
    setLines(version.lines);
    setText(version.text);
    if (version.metadata) setMetadata(version.metadata);
    setCursor({ line: 0, unit: 0 });
    setSaves(null);
    notify(`Restored the save from ${savedLabel(version.savedAt)}.`);
  };
  const forget = (song: SavedSong) => {
    void deleteSaves(song.uri).finally(() =>
      setSaves(
        (open) =>
          open && {
            songs: open.songs.filter((saved) => saved.uri !== song.uri),
            versions: song.uri === track?.uri ? [] : open.versions,
          },
      ),
    );
    if (song.uri === track?.uri) setSavedAt(undefined);
  };
  const savesDialog = saves && (
    <div className="ttml-dialog-backdrop" onClick={() => setSaves(null)}>
      <div
        className="ttml-dialog ttml-saves"
        role="dialog"
        aria-label="TTML saves"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h3>Saves</h3>
          <button onClick={() => setSaves(null)} aria-label="Close saves">
            <X size={16} />
          </button>
        </header>
        <p className="ttml-hint">
          Drafts save on every change. A dated version is kept every 10 minutes,
          whenever you leave a song and when you press {IS_MAC ? "Cmd" : "Ctrl"}
          +S, up to 10 per song.
        </p>
        {track && (
          <section>
            <h4>Versions of {track.name}</h4>
            {saves.versions.length ? (
              <ul>
                {saves.versions
                  .slice(0, olderSaves ? undefined : 2)
                  .map((version) => (
                    <li key={version.id ?? version.savedAt}>
                      <span>
                        <strong>{savedLabel(version.savedAt)}</strong>
                        <small>
                          {version.lines.length} line
                          {version.lines.length === 1 ? "" : "s"}
                        </small>
                      </span>
                      <button onClick={() => restore(version)}>Restore</button>
                    </li>
                  ))}
                {saves.versions.length > 2 && (
                  <li className="ttml-saves-more">
                    <button
                      aria-expanded={olderSaves}
                      onClick={() => setOlderSaves(!olderSaves)}
                    >
                      {olderSaves
                        ? "Hide older versions"
                        : `${saves.versions.length - 2} older version${saves.versions.length === 3 ? "" : "s"}`}
                      <ChevronDown
                        size={15}
                        className={olderSaves ? "open" : ""}
                      />
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <p className="ttml-hint">No earlier versions yet.</p>
            )}
          </section>
        )}
        <section>
          <h4>Saved songs</h4>
          {saves.songs.length ? (
            <ul>
              {saves.songs.map((saved) => (
                <li
                  key={saved.uri}
                  className={saved.uri === track?.uri ? "current" : ""}
                >
                  <span>
                    <strong>{saved.song?.name ?? saved.uri}</strong>
                    <small>
                      {saved.song &&
                        `${saved.song.artists.map((artist) => artist.name).join(", ")} · `}
                      {saved.savedAt
                        ? `Saved ${savedLabel(saved.savedAt)}`
                        : "Saved before save times were kept"}
                    </small>
                  </span>
                  {saved.uri !== track?.uri && (
                    <button
                      disabled={!saved.song}
                      title={
                        saved.song
                          ? undefined
                          : "Play this song to open its draft"
                      }
                      onClick={() => {
                        if (saved.song) setTrack(saved.song);
                        setSaves(null);
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => forget(saved)}
                    aria-label={`Delete saves for ${saved.song?.name ?? saved.uri}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ttml-hint">Nothing saved yet.</p>
          )}
        </section>
      </div>
    </div>
  );

  if (!track)
    return (
      <section className="ttml-creator empty" aria-label="TTML Creator">
        <Wand2 size={32} />
        <h2>TTML Creator</h2>
        <p>Play a song, then come back here to time its lyrics.</p>
        <button onClick={openSaves}>
          <History size={15} />
          Saves
        </button>
        {reviewer && (
          <button onClick={() => setReviewing(true)}>
            <ClipboardCheck size={15} />
            Review submissions
          </button>
        )}
        {savesDialog}
        {reviewPanel}
      </section>
    );

  return (
    <section className="ttml-creator" aria-label="TTML Creator">
      <header className="ttml-head">
        <div className="ttml-song">
          <small>TTML Creator</small>
          <strong onMouseEnter={clippedTitle}>{track.name}</strong>
          <span>{track.artists.map((artist) => artist.name).join(", ")}</span>
        </div>
        {classic && (
          <div className="ttml-tabs" role="tablist">
            {(
              [
                ["write", "Lyrics"],
                ["sync", "Sync"],
                ["preview", "Preview"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? "active" : ""}
                disabled={value !== "write" && !lines.length}
                onClick={() => {
                  setTextMode(false);
                  if (tab === "preview" && value !== "preview") selectPlaying();
                  setTab(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="ttml-actions">
          <span className="ttml-saved">
            {savedAt ? `Saved ${savedLabel(savedAt)}` : "Not saved yet"}
          </span>
          <button onClick={openSaves} title="Saves and earlier versions">
            <History size={15} />
            <span className="ttml-label">Saves</span>
          </button>
          {reviewButton}
          <button onClick={() => setEditingKeys(true)} title="Controls">
            <Settings size={15} />
            <span className="ttml-label">Controls</span>
          </button>
          <button onClick={() => setEditingMeta(true)} title="Metadata">
            <Tags size={15} />
            <span className="ttml-label">Metadata</span>
          </button>
          <button onClick={copy} disabled={!done} title="Copy TTML">
            <Copy size={15} />
            <span className="ttml-label">Copy</span>
          </button>
          {geniusMenu}
          <button
            onClick={pickImport}
            title="Import lyrics file (TTML, LRC, QRC, YRC, Lyricify Syllable or ESLyric)"
          >
            <Upload size={15} />
            <span className="ttml-label">Import</span>
          </button>
          {importInput}
          <span className="ttml-export">
            <button
              onClick={() => setExporting(!exporting)}
              disabled={!done}
              title="Save lyrics file"
              aria-expanded={exporting}
            >
              <Download size={15} />
              <span className="ttml-label">Export</span>
            </button>
            {exporting && (
              <div className="ttml-meta-menu" role="menu">
                {(["ttml", ...EXPORT_FORMATS] as const).map((format) => (
                  <button
                    key={format}
                    role="menuitem"
                    onClick={() => download(format)}
                  >
                    {FORMAT_NAMES[format]}
                    <code>.{format}</code>
                  </button>
                ))}
              </div>
            )}
          </span>
          {marksInstrumental &&
            here &&
            (markedInstrumental(state, track) || !hasLyrics(state, track)) && (
              <MarkInstrumental
                track={track}
                marked={markedInstrumental(state, track)}
                canUnmark={unmarksInstrumental}
                notify={notify}
              />
            )}
          <button
            onClick={() => void submit()}
            disabled={!done || !submittable || submitting}
            aria-busy={submitting}
            title={
              submittable
                ? "Send these lyrics to Lyssna so everyone gets them"
                : track?.is_local
                  ? "Match this local file to an ISRC first"
                  : "Only Spotify songs can be sent to Lyssna"
            }
          >
            <Send size={15} />
            <span className="ttml-label">Submit to Lyssna</span>
          </button>
          <button
            className="primary"
            onClick={apply}
            disabled={!done || !here}
            title={
              here
                ? "Save these lyrics for this song in Lyssna"
                : "Play this song to use the lyrics for it"
            }
          >
            <Save size={15} />
            Use for this song
          </button>
        </div>
      </header>

      {track?.is_local && !localIsrc && (
        <form
          className="ttml-banner ttml-isrc-match"
          onSubmit={(event) => {
            event.preventDefault();
            void matchIsrc();
          }}
        >
          <span>
            Lyssna knows songs by their ISRC, and this file's couldn't be found.
            Paste its ISRC or the song's Spotify link to match it.
          </span>
          <input
            type="text"
            aria-label="ISRC or Spotify link"
            placeholder="ISRC or Spotify link"
            spellCheck={false}
            autoComplete="off"
            value={isrcInput}
            onChange={(event) => setIsrcInput(event.target.value)}
          />
          <button type="submit" disabled={matching || !isrcInput.trim()}>
            {matching ? "Checking…" : "Match"}
          </button>
        </form>
      )}
      {!here && (
        <div className="ttml-banner" role="status">
          <span>
            This draft is for <strong>{track.name}</strong>
            {playing ? (
              <>
                , but <strong>{playing.name}</strong> is playing.
              </>
            ) : (
              "."
            )}{" "}
            Timing needs the draft's song playing.
          </span>
          <button onClick={() => onPlayer({ command: "play", uri: track.uri })}>
            Play {track.name}
          </button>
          {playing && (
            <button onClick={() => setTrack(playing)}>
              Work on {playing.name}
            </button>
          )}
        </div>
      )}

      {(textMode || !lines.length) && (
        <div className="ttml-write">
          {!lines.length && !text.trim() && (
            <div className="ttml-sources" role="group" aria-label="Start from">
              <button onClick={startFromLyrics} disabled={!seedable}>
                <Wand2 size={20} />
                <strong>Current lyrics</strong>
                <small>
                  {seedBlocked ?? "The lyrics Lyssna found for this song"}
                </small>
              </button>
              <button onClick={fromGenius} disabled={!track || fetching}>
                <Globe size={20} />
                <strong>
                  {fetching ? "Getting lyrics…" : "Lyrics from Genius"}
                </strong>
                <small>Plain lyrics without timing, by title and artist</small>
              </button>
            </div>
          )}
          <p className="ttml-hint">
            One lyric line per line. Split a word into syllables with{" "}
            <kbd>|</kbd>, like <code>beau|ti|ful</code>. Wrap a background vocal
            in parentheses. Start a line with <code>v2:</code> for the second
            singer. Optionally, name a section on its own line with a Genius
            section name, like <code>[Chorus]</code> or <code>[Bridge]</code>;
            it is never sung as a lyric.
          </p>
          <textarea
            aria-label="Lyrics text"
            value={text}
            spellCheck={false}
            placeholder={
              "First line of the song\n(background vocal)\nv2: a line the other singer takes"
            }
            onChange={(event) => {
              editedFor.current = track?.uri;
              setText(event.target.value);
            }}
          />
          <div className="ttml-write-actions">
            {previewToggle}
            {(lines.length > 0 || !!text.trim()) && (
              <>
                <button
                  onClick={startFromLyrics}
                  disabled={!seedable}
                  title={
                    seedBlocked ??
                    "Use the lyrics Lyssna found for this song as a start"
                  }
                >
                  <Wand2 size={15} />
                  Start from current lyrics
                </button>
              </>
            )}
            <button
              onClick={pickImport}
              title="TTML, LRC, QRC, YRC, Lyricify Syllable or ESLyric"
            >
              <Upload size={15} />
              Import file
            </button>
            <div className="ttml-row">
              {lines.length > 0 && (
                <button onClick={() => setTextMode(false)}>Cancel</button>
              )}
              <button
                className="primary"
                onClick={applyText}
                disabled={!text.trim()}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {previewing && !textMode && (
        <div className="ttml-preview">
          {preview?.lines.length && renderPreview ? (
            renderPreview(preview, previewLive)
          ) : (
            <p className="ttml-hint">Time some words to see them here.</p>
          )}
        </div>
      )}
      {editable && (
        <>
          {showSync && (
            <div className="ttml-transport">
              <button
                className="ttml-play"
                onClick={onToggle}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <Pause size={16} fill="currentColor" />
                ) : (
                  <Play size={16} fill="currentColor" />
                )}
              </button>
              <span className="ttml-time">{formatTime(position)}</span>
              <label
                className="ttml-offset"
                title="Shift every tap by this much. Negative taps earlier."
              >
                Offset
                <input
                  type="number"
                  step={10}
                  value={offset}
                  aria-label="Tap offset in milliseconds"
                  onChange={(event) => {
                    const value = Math.max(
                      -2000,
                      Math.min(2000, Number(event.target.value) || 0),
                    );
                    setOffset(value);
                    writeStorage(OFFSET_KEY, String(value));
                  }}
                />
                ms
              </label>
              <button
                className={`ttml-roman-toggle${syncRoman ? " active" : ""}`}
                aria-pressed={syncRoman}
                disabled={!lines.some(hasWordRoman)}
                onClick={() => {
                  setSyncRoman(!syncRoman);
                  writeStorage(SYNC_ROMAN_KEY, syncRoman ? null : "1");
                }}
                title={
                  lines.some(hasWordRoman)
                    ? "Show each word's romanization instead of its text"
                    : "Fill in word readings or use Auto romanize first"
                }
              >
                <Languages size={15} />
                Romanization
              </button>
              <span className="ttml-progress">
                {done}/{total} timed
              </span>
              <button
                onClick={undo}
                title={`Undo (${MODIFIER}+Z)`}
                aria-label="Undo"
              >
                <Undo2 size={15} />
                <span className="ttml-label">Undo</span>
              </button>
              <button
                onClick={redo}
                title={IS_MAC ? "Redo (Cmd+Shift+Z)" : "Redo (Ctrl+Y)"}
                aria-label="Redo"
              >
                <Redo2 size={15} />
                <span className="ttml-label">Redo</span>
              </button>
              <button
                onClick={() => setLines(clearAll(lines))}
                disabled={!done}
                title="Clear every timing"
                aria-label="Clear every timing"
              >
                <RotateCcw size={15} />
                <span className="ttml-label">Clear timings</span>
              </button>
              <button
                onClick={() => void resetToSource()}
                disabled={!here || resettingSource}
                aria-busy={resettingSource}
                title="Replace this draft with the best lyrics from your sources"
              >
                <FileInput size={15} />
                <span className="ttml-label">
                  {resettingSource ? "Finding source…" : "Reset to source"}
                </span>
              </button>
            </div>
          )}
          {writing && (
            <div className="ttml-write-actions">
              <div className="ttml-row">
                <button
                  onClick={startFromLyrics}
                  disabled={!seedable}
                  title={
                    seedBlocked ??
                    "Use the lyrics Lyssna found for this song as a start"
                  }
                >
                  <Wand2 size={15} />
                  Start from current lyrics
                </button>
                {clearButton}
                <button onClick={openText}>
                  <Type size={15} />
                  Edit as text
                </button>
                {bracketsButton}
                {splitAllButton}
                <button
                  className={wordRoman ? "active" : ""}
                  aria-pressed={wordRoman}
                  onClick={() => {
                    setWordRoman(!wordRoman);
                    writeStorage(WORD_ROMAN_KEY, wordRoman ? null : "1");
                  }}
                  title="Show a reading under each word"
                >
                  Word romanization
                </button>
                <button
                  onClick={() => void autoRomanize()}
                  disabled={romanNote === "Romanizing…"}
                  title="Fill empty word readings for lyrics in any non-Latin script. Uses Genius's romanized lyrics when it has them, which sends the title and artist to Genius."
                >
                  <Languages size={15} />
                  Auto romanize
                </button>
              </div>
              <button className="primary" onClick={() => setTab("sync")}>
                Continue to Sync
              </button>
            </div>
          )}
          {showEdit && !writing && (
            <div
              className="ttml-edit-bar"
              role="toolbar"
              aria-label="Edit lyrics"
            >
              <label className="ttml-field ttml-field-word">
                <span>
                  Word <kbd>{IS_MAC ? "⌘E" : "F2"}</kbd>
                  {!IS_MAC && <kbd>Ctrl+E</kbd>}
                </span>
                <input
                  ref={wordField}
                  key={`word:${cursor.line}:${cursor.unit}:${selectedUnit?.text ?? ""}`}
                  aria-label="Selected word"
                  defaultValue={selectedUnit?.text ?? ""}
                  placeholder="No word selected"
                  disabled={!selectedUnit}
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) =>
                    selectedUnit &&
                    event.target.value !== selectedUnit.text &&
                    commitWord(cursor, event.target.value)
                  }
                  onKeyDown={leaveField}
                />
              </label>
              <label className="ttml-field">
                <span>Reading</span>
                <input
                  key={`reading:${cursor.line}:${cursor.unit}:${selectedUnit?.roman ?? ""}`}
                  aria-label="Reading of the selected word"
                  defaultValue={selectedUnit?.roman ?? ""}
                  placeholder={
                    selectedUnit &&
                    /[^\p{Script=Latin}\P{L}]/u.test(selectedUnit.text)
                      ? "e.g. i|no|chi"
                      : "–"
                  }
                  title="Split a reading with | to time each piece, like i|no|chi"
                  disabled={!selectedUnit}
                  spellCheck={false}
                  onBlur={(event) =>
                    selectedUnit &&
                    event.target.value !== (selectedUnit.roman ?? "") &&
                    setLines(setUnitRoman(lines, cursor, event.target.value))
                  }
                  onKeyDown={leaveField}
                />
              </label>
              {(["translation", "romanization"] as const).map((key) => (
                <label key={key} className="ttml-field">
                  <span>
                    {key === "translation"
                      ? "Translation"
                      : "Line romanization"}
                  </span>
                  <input
                    key={`${key}:${cursor.line}:${selectedLine?.[key] ?? ""}`}
                    aria-label={`${key === "translation" ? "Translation" : "Romanization"} of line ${cursor.line + 1}`}
                    defaultValue={selectedLine?.[key] ?? ""}
                    placeholder="None"
                    disabled={!selectedLine}
                    spellCheck={false}
                    onBlur={(event) =>
                      selectedLine &&
                      event.target.value.trim() !== (selectedLine[key] ?? "") &&
                      setLines(
                        setLineText(
                          lines,
                          cursor.line,
                          key,
                          event.target.value.trim(),
                        ),
                      )
                    }
                    onKeyDown={leaveField}
                  />
                </label>
              ))}
              <span className="ttml-edit-tools">
                {previewToggle}
                <button
                  onClick={startFromLyrics}
                  disabled={!seedable}
                  title={
                    seedBlocked ??
                    "Use the lyrics Lyssna found for this song as a start"
                  }
                >
                  <Wand2 size={15} />
                  Start from current lyrics
                </button>
                {clearButton}
                <button onClick={openText}>
                  <Type size={15} />
                  Edit as text
                </button>
                {bracketsButton}
                {splitAllButton}
                <button
                  onClick={() => void autoRomanize()}
                  disabled={romanNote === "Romanizing…"}
                  title="Fill empty word readings for lyrics in any non-Latin script. Uses Genius's romanized lyrics when it has them, which sends the title and artist to Genius."
                >
                  <Languages size={15} />
                  Auto romanize
                </button>
              </span>
            </div>
          )}
          {romanNote && (
            <p className="ttml-hint" role="status">
              {romanNote}
            </p>
          )}
          {pickBar}
          <div
            className="ttml-lines"
            ref={list}
            onClick={(event) => {
              if (
                (event.target as Element).closest(
                  ".ttml-unit, .ttml-chip, .ttml-space",
                )
              )
                return;
              setGroup([]);
              setSpaces([]);
            }}
            onDragEnd={endDrag}
            onDragOverCapture={(event) => drag && scrollWhileDragging(event)}
            onWheel={() => {
              scrolledAt.current = Date.now();
              cancelAnimationFrame(glide.current);
            }}
            onTouchMove={() => {
              scrolledAt.current = Date.now();
              cancelAnimationFrame(glide.current);
            }}
          >
            {lines.map((line, lineIndex) => {
              const adder = (
                <input
                  className="ttml-chip-add"
                  aria-label={`Add words to line ${lineIndex + 1}`}
                  placeholder="Type word here"
                  spellCheck={false}
                  onFocus={() =>
                    setCursor((at) =>
                      at.line === lineIndex ? at : { line: lineIndex, unit: 0 },
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.currentTarget.blur();
                    const box = event.currentTarget;
                    const key = event.key.toLowerCase();
                    // An empty box hands undo to the creator, so a line
                    // just added with Enter can be taken back.
                    if (
                      !box.value &&
                      (IS_MAC ? event.metaKey : event.ctrlKey) &&
                      (key === "z" || key === "y")
                    ) {
                      event.preventDefault();
                      box.blur();
                      (key === "y" || event.shiftKey ? redo : undo)();
                      return;
                    }
                    if (
                      !box.value &&
                      event.key === "Backspace" &&
                      !line.units.length &&
                      lines.length > 1
                    ) {
                      event.preventDefault();
                      const next = removeLine(lines, lineIndex);
                      setLines(next);
                      setCursor(
                        clampCursor(next, {
                          line: Math.max(0, lineIndex - 1),
                          unit: 0,
                        }),
                      );
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    event.stopPropagation();
                    const next = appendWords(
                      lines,
                      lineIndex,
                      event.currentTarget.value,
                    );
                    event.currentTarget.value = "";
                    if (next !== lines) setLines(next);
                  }}
                />
              );
              return (
                <Fragment key={lineIndex}>
                  {(line.part || editingSection?.line === lineIndex) && (
                    <p
                      className="ttml-part"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSectionMenu({
                          x: event.clientX,
                          y: event.clientY,
                          line: lineIndex,
                        });
                      }}
                    >
                      {editingSection?.line === lineIndex &&
                      editingSection.field === "part" ? (
                        <SectionField
                          label="Section name"
                          value={line.part ?? ""}
                          onDone={(value) => {
                            setEditingSection(null);
                            if (value !== null)
                              setLines(setSection(lines, lineIndex, value));
                          }}
                        />
                      ) : (
                        line.part
                      )}
                      {(line.singer ||
                        (editingSection?.line === lineIndex &&
                          editingSection.field === "singer")) &&
                        " - "}
                      {editingSection?.line === lineIndex &&
                      editingSection.field === "singer" ? (
                        <SectionField
                          label="Section singers"
                          value={line.singer ?? ""}
                          onDone={(value) => {
                            setEditingSection(null);
                            if (value !== null)
                              setLines(
                                setSectionSinger(lines, lineIndex, value),
                              );
                          }}
                        />
                      ) : (
                        line.singer &&
                        (voicesOf(line.singer).length > 1
                          ? // Styled as Genius sets the voices apart.
                            voicesOf(line.singer).map((voice, index) => (
                              <Fragment key={index}>
                                {index > 0 && ", "}
                                <span
                                  className={`ttml-voice${WORD_VOICE_CLASS[index] ?? ""}`}
                                >
                                  {voice}
                                </span>
                              </Fragment>
                            ))
                          : line.singer)
                      )}
                    </p>
                  )}
                  <div
                    data-line={lineIndex}
                    {...pickProps(lineIndex)}
                    onContextMenu={(event) => openLineMenu(event, lineIndex)}
                    className={`ttml-card ttml-line${VOICE_CLASS[lineVoice(lines, lineIndex)] ?? ""}${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}${cursor.line === lineIndex ? " current" : ""}${line.units.length ? "" : " empty"}${playingLine === lineIndex || liveWords.singing.has(lineIndex) ? " playing" : ""}${picked.has(lineIndex) ? " picked" : ""}${drag?.kind === "line" && drag.line === lineIndex ? " dragging" : ""}${dropClass(`line:${lineIndex}`)}`}
                    onClick={(event) => {
                      const target = event.target as Element;
                      if (
                        cursor.line !== lineIndex &&
                        !target.closest("button, input")
                      ) {
                        clickedLine.current = true;
                        setCursor(
                          clampCursor(lines, { line: lineIndex, unit: 0 }),
                        );
                      }
                      if (
                        target.closest(".ttml-card-number") &&
                        !event.shiftKey &&
                        !event.ctrlKey &&
                        !event.metaKey
                      ) {
                        pickedFrom.current = lineIndex;
                        setPicked(new Set([lineIndex]));
                      }
                    }}
                    onPointerDown={(event) => {
                      event.currentTarget.draggable = !(
                        event.target as Element
                      ).closest("button, input");
                    }}
                    onDragStart={(event) =>
                      event.target === event.currentTarget &&
                      startDrag(event, { kind: "line", line: lineIndex })
                    }
                    onDragOver={(event) => {
                      if (drag?.kind === "line")
                        over(
                          event,
                          `line:${lineIndex}:${firstHalf(event, true) ? "before" : "after"}`,
                        );
                      else if (drag?.kind === "word")
                        over(event, `line:${lineIndex}:end`);
                    }}
                    onDrop={(event) => {
                      if (drag?.kind === "line")
                        land(
                          event,
                          moveLine(
                            lines,
                            drag.line,
                            firstHalf(event, true) ? lineIndex : lineIndex + 1,
                          ),
                        );
                      else if (drag?.kind === "word")
                        land(
                          event,
                          moveDragged(drag, {
                            line: lineIndex,
                            unit: line.units.length,
                          }),
                        );
                    }}
                  >
                    <span className="ttml-card-number">{lineIndex + 1}</span>
                    {writing ? (
                      <div className="ttml-card-body">
                        <div className="ttml-chips">
                          {line.units.map((unit, unitIndex) => {
                            const at = { line: lineIndex, unit: unitIndex };
                            const editing =
                              inline?.line === lineIndex &&
                              inline.unit === unitIndex;
                            const chosen =
                              (cursor.line === lineIndex &&
                                cursor.unit === unitIndex &&
                                !spaces.length) ||
                              inGroup(at);
                            return (
                              <Fragment key={unitIndex}>
                                {unitIndex > 0 && !unit.joined && (
                                  <button
                                    className={`ttml-space${isSpace(at) ? " chosen" : ""}${dropClass(`gap:${lineIndex}:${unitIndex}`)}`}
                                    draggable
                                    onClick={(event) => pickSpace(event, at)}
                                    onDragStart={(event) => {
                                      // A picked space drags the picked words with it.
                                      const words = pickedWords();
                                      if (isSpace(at) && words.length)
                                        startDrag(event, {
                                          kind: "word",
                                          at: words[0],
                                          ...(words.length > 1 && {
                                            group: words,
                                          }),
                                        });
                                      else
                                        startDrag(event, { kind: "space", at });
                                    }}
                                    onDragOver={(event) =>
                                      drag?.kind === "word" &&
                                      over(
                                        event,
                                        `gap:${lineIndex}:${unitIndex}:word`,
                                      )
                                    }
                                    onDrop={(event) =>
                                      drag?.kind === "word" &&
                                      land(event, moveDragged(drag, at))
                                    }
                                  >
                                    Space
                                  </button>
                                )}
                                <span
                                  className={
                                    wordRoman
                                      ? "ttml-chip-stack"
                                      : "ttml-chip-plain"
                                  }
                                >
                                  {editing ? (
                                    <input
                                      className="ttml-chip-edit"
                                      aria-label={`Edit ${unit.text}`}
                                      autoFocus
                                      defaultValue={unit.text}
                                      size={Math.max(2, unit.text.length + 1)}
                                      spellCheck={false}
                                      onFocus={(event) =>
                                        event.currentTarget.select()
                                      }
                                      onInput={(event) => {
                                        const box = event.currentTarget;
                                        box.size = Math.max(
                                          2,
                                          box.value.length + 1,
                                        );
                                      }}
                                      onBlur={(event) => {
                                        const value =
                                          event.currentTarget.value.trim();
                                        setInline(null);
                                        if (value !== unit.text)
                                          commitWord(at, value);
                                      }}
                                      onKeyDown={(event) => {
                                        event.stopPropagation();
                                        if (event.key === "Escape") {
                                          event.preventDefault();
                                          event.currentTarget.value = unit.text;
                                          event.currentTarget.blur();
                                        } else if (event.key === "Enter") {
                                          event.preventDefault();
                                          event.currentTarget.blur();
                                        }
                                      }}
                                    />
                                  ) : (
                                    <button
                                      className={`ttml-chip${unit.joined ? " joined" : ""}${chosen ? " chosen" : ""}${drag?.kind === "word" && ((drag.at.line === lineIndex && drag.at.unit === unitIndex) || (drag.group && inGroup(at))) ? " dragging" : ""}${dropClass(`unit:${lineIndex}:${unitIndex}`)}`}
                                      title={
                                        unit.joined
                                          ? "Syllable. Double-click to edit; right-click to make it its own word."
                                          : "Double-click to edit; drag to move"
                                      }
                                      draggable
                                      onDragStart={(event) =>
                                        dragWords(event, at)
                                      }
                                      onDragOver={(event) => {
                                        if (drag?.kind === "word")
                                          over(
                                            event,
                                            `unit:${lineIndex}:${unitIndex}:${firstHalf(event, false) ? "before" : "after"}`,
                                          );
                                        else if (
                                          drag?.kind === "space" &&
                                          unit.joined &&
                                          drag.at.line === lineIndex
                                        )
                                          over(
                                            event,
                                            `unit:${lineIndex}:${unitIndex}:space`,
                                          );
                                      }}
                                      onDrop={(event) => {
                                        if (drag?.kind === "word") {
                                          const word = wordBounds(
                                            line.units,
                                            unitIndex,
                                          );
                                          land(
                                            event,
                                            moveDragged(drag, {
                                              line: lineIndex,
                                              unit: firstHalf(event, false)
                                                ? word.start
                                                : word.end,
                                            }),
                                          );
                                        } else if (
                                          drag?.kind === "space" &&
                                          unit.joined
                                        )
                                          land(
                                            event,
                                            moveSpace(lines, drag.at, at),
                                          );
                                      }}
                                      onClick={(event) => {
                                        if (
                                          event.shiftKey ||
                                          event.ctrlKey ||
                                          event.metaKey
                                        )
                                          return pickWord(at, event.shiftKey);
                                        setGroup([]);
                                        setSpaces([]);
                                        setPicked(new Set());
                                        setCursor(at);
                                      }}
                                      onDoubleClick={() => {
                                        setCursor(at);
                                        setInline(at);
                                      }}
                                      onContextMenu={(event) =>
                                        openMenu(event, at)
                                      }
                                    >
                                      {unit.text}
                                    </button>
                                  )}
                                  {wordRoman && (
                                    <input
                                      className="ttml-roman"
                                      key={unit.roman ?? ""}
                                      aria-label={`Romanization of ${unit.text}`}
                                      defaultValue={unit.roman ?? ""}
                                      placeholder="–"
                                      spellCheck={false}
                                      onBlur={(event) =>
                                        event.target.value !==
                                          (unit.roman ?? "") &&
                                        setLines(
                                          setUnitRoman(
                                            lines,
                                            at,
                                            event.target.value,
                                          ),
                                        )
                                      }
                                      onKeyDown={(event) =>
                                        event.key === "Enter" &&
                                        event.currentTarget.blur()
                                      }
                                    />
                                  )}
                                </span>
                              </Fragment>
                            );
                          })}
                          {line.spaceAfter && (
                            <button
                              className={`ttml-space${isSpace({ line: lineIndex, unit: line.units.length }) ? " chosen" : ""}`}
                              onClick={(event) =>
                                pickSpace(event, {
                                  line: lineIndex,
                                  unit: line.units.length,
                                })
                              }
                            >
                              Space
                            </button>
                          )}
                          {adder}
                        </div>
                        {(["translation", "romanization"] as const).map(
                          (key) => (
                            <label key={key} className="ttml-card-extra">
                              {key === "translation"
                                ? "Translation:"
                                : "Romanization:"}
                              <input
                                key={line[key] ?? ""}
                                defaultValue={line[key] ?? ""}
                                aria-label={`${key === "translation" ? "Translation" : "Romanization"} of line ${lineIndex + 1}`}
                                placeholder="None"
                                spellCheck={false}
                                onBlur={(event) =>
                                  event.target.value.trim() !==
                                    (line[key] ?? "") &&
                                  setLines(
                                    setLineText(
                                      lines,
                                      lineIndex,
                                      key,
                                      event.target.value.trim(),
                                    ),
                                  )
                                }
                                onKeyDown={(event) =>
                                  event.key === "Enter" &&
                                  event.currentTarget.blur()
                                }
                              />
                            </label>
                          ),
                        )}
                      </div>
                    ) : (
                      <div className="ttml-cells">
                        {line.units.map((unit, unitIndex, all) => {
                          const at = { line: lineIndex, unit: unitIndex };
                          const selected =
                            cursor.line === lineIndex &&
                            cursor.unit === unitIndex;
                          const parts = romanParts(unit);
                          const livePiece =
                            parts.length > 1
                              ? romanPieces(unit).findIndex(
                                  (piece) =>
                                    position >= piece.start &&
                                    position < piece.end,
                                )
                              : -1;
                          const pieces = (
                            <span
                              className={`ttml-pieces${syncRoman ? " large" : ""}`}
                            >
                              {parts.map((part, index) => (
                                <span
                                  key={index}
                                  className={`ttml-piece${selected && (cursor.part ?? 0) === index ? " current" : ""}${livePiece === index ? " live" : ""}`}
                                >
                                  {part}
                                </span>
                              ))}
                            </span>
                          );
                          const live =
                            (liveWord?.line === lineIndex &&
                              liveWord.unit === unitIndex) ||
                            // The lit word's own line keeps its steadied pick.
                            (liveWord?.line !== lineIndex &&
                              liveWords.live.has(`${lineIndex}:${unitIndex}`));
                          // In the romanization view the reading is what's
                          // on screen, so that's what gets edited.
                          const editsReading = syncRoman && !!unit.roman;
                          const shownText = editsReading
                            ? unit.roman!
                            : unit.text;
                          if (
                            inline?.line === lineIndex &&
                            inline.unit === unitIndex
                          )
                            return (
                              <div
                                key={unitIndex}
                                className={`ttml-unit selected editing${unit.joined ? " joined" : ""}${timed(unit) ? " timed" : ""}`}
                              >
                                <TimePill ms={unit.start} />
                                <input
                                  className="ttml-inline-word"
                                  aria-label={
                                    editsReading
                                      ? `Edit the reading of ${unit.text}`
                                      : `Edit ${unit.text}`
                                  }
                                  defaultValue={shownText}
                                  size={Math.max(2, shownText.length + 1)}
                                  spellCheck={false}
                                  autoFocus
                                  onFocus={(event) =>
                                    event.currentTarget.select()
                                  }
                                  onInput={(event) => {
                                    const box = event.currentTarget;
                                    box.size = Math.max(
                                      2,
                                      box.value.length + 1,
                                    );
                                  }}
                                  onBlur={(event) => {
                                    const value =
                                      event.currentTarget.value.trim();
                                    setInline(null);
                                    if (value === shownText) return;
                                    if (editsReading)
                                      setLines(setUnitRoman(lines, at, value));
                                    else commitWord(at, value);
                                  }}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      event.currentTarget.value = shownText;
                                      event.currentTarget.blur();
                                    } else if (event.key === "Enter") {
                                      event.preventDefault();
                                      event.currentTarget.blur();
                                    }
                                  }}
                                />
                                <TimePill ms={unit.end} end />
                              </div>
                            );
                          return (
                            <button
                              key={unitIndex}
                              className={`ttml-unit${unit.joined ? " joined" : ""}${timed(unit) ? " timed" : unit.start !== undefined ? " started" : ""}${selected ? " selected" : ""}${live ? " live" : ""}${inGroup(at) ? " chosen" : ""}${drag?.kind === "word" && ((drag.at.line === lineIndex && drag.at.unit === unitIndex) || (drag.group && inGroup(at))) ? " dragging" : ""}${dropClass(`unit:${lineIndex}:${unitIndex}`)}`}
                              aria-label={unit.text}
                              title={`Double-click to edit, or to replay while playing, right-click for word options, ${IS_MAC ? "Cmd+E" : "F2"} to edit, drag to move`}
                              draggable
                              onDragStart={(event) => dragWords(event, at)}
                              onDragOver={(event) =>
                                drag?.kind === "word" &&
                                over(
                                  event,
                                  `unit:${lineIndex}:${unitIndex}:${firstHalf(event, false) ? "before" : "after"}`,
                                )
                              }
                              onDrop={(event) => {
                                if (drag?.kind !== "word") return;
                                land(
                                  event,
                                  moveDragged(drag, {
                                    line: lineIndex,
                                    unit: firstHalf(event, false)
                                      ? unitIndex
                                      : unitIndex + 1,
                                  }),
                                );
                              }}
                              onClick={(event) => {
                                if (lineIndex !== cursor.line)
                                  clickedLine.current = true;
                                if (
                                  event.shiftKey ||
                                  event.ctrlKey ||
                                  event.metaKey
                                )
                                  return pickWord(at, event.shiftKey);
                                setGroup([]);
                                setSpaces([]);
                                setPicked(new Set());
                                setCursor(at);
                              }}
                              onDoubleClick={() => {
                                if (!isPlaying) {
                                  setCursor(at);
                                  setInline(at);
                                  return;
                                }
                                if (unit.start === undefined) return;
                                holdLine.current = lineIndex;
                                seek(unit.start - 1000);
                              }}
                              onContextMenu={(event) => openMenu(event, at)}
                            >
                              <TimePill ms={unit.start} />
                              <span
                                className={`ttml-word${WORD_VOICE_CLASS[unitVoice(lines, at)] ?? ""}`}
                                title={
                                  syncRoman && unit.roman
                                    ? unit.text
                                    : undefined
                                }
                              >
                                {syncRoman && parts.length > 1
                                  ? pieces
                                  : syncRoman && unit.roman
                                    ? unit.roman
                                    : unit.text}
                              </span>
                              {!syncRoman &&
                                (parts.length > 1 ||
                                  // Every word of a line with split readings
                                  // keeps the row, blank unless split, so
                                  // the end times line up.
                                  all.some(
                                    (each) => romanParts(each).length > 1,
                                  )) &&
                                (parts.length > 1 ? (
                                  pieces
                                ) : (
                                  <span
                                    className="ttml-pieces"
                                    aria-hidden="true"
                                    style={{ visibility: "hidden" }}
                                  >
                                    <span className="ttml-piece">-</span>
                                  </span>
                                ))}
                              <TimePill ms={unit.end} end />
                            </button>
                          );
                        })}
                        {adder}
                      </div>
                    )}
                    {!writing && (
                      <div className="ttml-line-side">
                        <TimePill ms={lineSpan(line)?.start} />
                        <TimePill
                          ms={
                            line.units.some((unit) => unit.end !== undefined)
                              ? lineSpan(line)?.end
                              : undefined
                          }
                          end
                        />
                      </div>
                    )}
                    <div className="ttml-line-tools">
                      <button
                        className={line.background ? "active" : ""}
                        aria-pressed={line.background}
                        title="Background vocal"
                        onClick={() => flagLine(lineIndex, "background")}
                      >
                        BG
                      </button>
                      <button
                        className={line.opposite ? "active" : ""}
                        aria-pressed={line.opposite}
                        title="Second singer"
                        onClick={() => flagLine(lineIndex, "opposite")}
                      >
                        v2
                      </button>
                      <button
                        title="Delete line"
                        aria-label="Delete line"
                        onClick={() => {
                          const next = removeLine(lines, lineIndex);
                          setLines(next);
                          setCursor((at) => clampCursor(next, at));
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                      <button
                        title="Add line below"
                        aria-label="Add line below"
                        onClick={() => addBlankLine(lineIndex)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
          {issues.length > 0 && (
            <p className="ttml-issues">{issues.join(" ")}</p>
          )}
        </>
      )}
      {sectionMenu && lines[sectionMenu.line] && (
        <WordMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          groups={sectionMenuGroups(sectionMenu.line)}
          label="Section actions"
          onClose={() => setSectionMenu(null)}
        />
      )}
      {menu && (
        <WordMenu
          x={menu.x}
          y={menu.y}
          groups={
            menu.line ? lineMenuGroups(menu.at.line) : menuGroups(menu.at)
          }
          label={menu.line ? "Line actions" : "Word actions"}
          onClose={() => setMenu(null)}
        />
      )}
      {splitting && lines[splitting.line]?.units[splitting.unit] && (
        <SplitDialog
          word={lines[splitting.line].units[splitting.unit].text}
          learned={learned}
          onClose={() => setSplitting(null)}
          onConfirm={(choice) => confirmSplit(splitting, choice)}
        />
      )}
      {review && (
        <GeniusReview
          changes={{
            ...review.changes,
            differs: review.changes.differs.filter(
              (each) => !ignoredGenius.includes(ignoreKey(each)),
            ),
          }}
          onIgnore={(each) => {
            const next = [...ignoredGenius, ignoreKey(each)].slice(-500);
            setIgnoredGenius(next);
            try {
              localStorage.setItem(IGNORED_GENIUS, JSON.stringify(next));
            } catch {
              // Still ignored for now when storage is off.
            }
          }}
          onGo={(line) => {
            setCursor({ line, unit: 0 });
            centre(line);
          }}
          onKeep={() => setReview(null)}
          canUndo={!review.edited}
          onMakeLeads={(chosen, background) => {
            const next = lines.map((line, index) =>
              chosen.includes(index) ? { ...line, background } : line,
            );
            setLines(next);
            setReview({
              ...review,
              changes: geniusChanges(review.before, next, review.genius),
              shown: undefined,
            });
          }}
          onFix={(at, genius) => {
            const fixed = fixFromGenius(lines[at], genius);
            if (!fixed) return;
            const next = lines.map((line, index) =>
              index === at ? fixed : line,
            );
            setLines(next);
            setReview({
              ...review,
              changes: geniusChanges(review.before, next, review.genius),
              shown: undefined,
            });
          }}
          onAddMissing={() => {
            const next = addMissing(lines, review.changes.missing);
            setLines(next);
            setReview({
              ...review,
              changes: geniusChanges(review.before, next, review.genius),
              shown: undefined,
            });
          }}
          onUndo={() => {
            setLines(review.before);
            setReview(null);
            notify("Undid the changes from Genius.");
          }}
        />
      )}
      {splittingReading &&
        lines[splittingReading.line]?.units[splittingReading.unit]?.roman && (
          <ReadingSplitDialog
            word={lines[splittingReading.line].units[splittingReading.unit].text}
            reading={
              lines[splittingReading.line].units[splittingReading.unit].roman!
            }
            matches={sameReadings(lines, splittingReading)}
            onClose={() => setSplittingReading(null)}
            onConfirm={(reading, everywhere) => {
              setLines(
                everywhere
                  ? splitReadings(
                      setUnitRoman(lines, splittingReading, reading),
                      reading,
                    )
                  : setUnitRoman(lines, splittingReading, reading),
              );
              setSplittingReading(null);
            }}
          />
        )}
      {replacing && lines[replacing.line]?.units[replacing.unit] && (
        <ReplaceDialog
          word={lines[replacing.line].units[replacing.unit].text}
          onClose={() => setReplacing(null)}
          onConfirm={(choice) => confirmReplace(replacing, choice)}
        />
      )}
      {savesDialog}
      {touring && editable && <TtmlTour keys={keys} onClose={endTour} />}
      {editingKeys && (
        <KeysDialog
          onTour={() => {
            setEditingKeys(false);
            setTextMode(false);
            setTab("write");
            setTouring(true);
          }}
          classic={classic}
          onClassic={(on) => {
            setClassic(on);
            setTab("write");
            writeStorage(CLASSIC_KEY, on ? "1" : null);
          }}
          keys={keys}
          onChange={changeKeys}
          onClose={() => setEditingKeys(false)}
        />
      )}
      {editingMeta && (
        <MetadataDialog
          entries={entries}
          onChange={changeMetadata}
          onReset={() => setMetadata(undefined)}
          onClose={() => setEditingMeta(false)}
        />
      )}
      {barSlot &&
        createPortal(
          <TtmlBar
            position={shownPosition}
            duration={track.duration_ms}
            playing={isPlaying}
            peaks={peaks?.uri === track.uri ? peaks.values : null}
            spectrum={
              <TtmlSpectrogram
                uri={track.uri}
                duration={track.duration_ms}
                position={shownPosition}
                playing={isPlaying || !!clipping}
                lines={lines}
                cursor={cursor}
                picked={picked}
                onSeek={seek}
                onLines={setLines}
                onCursor={setCursor}
                onPlayUnit={playUnit}
              />
            }
            spectrogram={spectrogram}
            onSpectrogram={showSpectrogram}
            spans={barSpans}
            onToggle={onToggle}
            onSeek={seek}
            onShowPlayer={() => showSpectrogram(false)}
            onClose={onClose}
            speed={shownSpeed}
            minSpeed={MIN_SPEED}
            maxSpeed={MAX_SPEED}
            speedEnabled={native || local}
            onSpeed={(value) => slideSpeed(clampSpeed(value))}
            volume={barVolume}
            onVolume={changeVolume}
            song={
              <>
                <Cover images={track.album.images} />
                <span>
                  <strong onMouseEnter={clippedTitle}>{track.name}</strong>
                  <small>
                    {formatTime(track.duration_ms).replace(/\.\d+$/, "")}
                  </small>
                </span>
              </>
            }
          />,
          barSlot,
        )}
      {playbar?.wave &&
        createPortal(
          <TtmlWave
            position={shownPosition}
            duration={track.duration_ms}
            peaks={peaks?.uri === track.uri ? peaks.values : null}
            spans={barSpans}
            onSeek={seek}
          />,
          playbar.wave,
        )}
      {playbar?.speed &&
        createPortal(
          <CreatorSpeed
            speed={shownSpeed}
            min={MIN_SPEED}
            max={MAX_SPEED}
            enabled={native || local}
            onSpeed={(value) => slideSpeed(clampSpeed(value))}
          />,
          playbar.speed,
        )}
      {playbar?.play &&
        createPortal(
          <button
            className="play-toggle"
            aria-label={isPlaying ? "Pause" : "Play"}
            title="Play / pause · Space"
            onClick={onToggle}
          >
            {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>,
          playbar.play,
        )}
      {playbar?.extras &&
        createPortal(
          <button
            className="icon-button"
            aria-label="Spectrogram"
            aria-pressed={false}
            title="Show the spectrogram"
            onClick={() => showSpectrogram(true)}
          >
            <AudioWaveform size={19} />
          </button>,
          playbar.extras,
        )}
      {reviewPanel}
    </section>
  );
}
