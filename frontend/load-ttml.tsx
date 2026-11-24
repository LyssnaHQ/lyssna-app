import { clippedTitle } from "./clipped-title";
import { useEffect, useMemo, useRef, useState } from "react";
import { BulkTtml, type BulkFile, type BulkLyric } from "./bulk-ttml";
import type { Track } from "./types";
import {
  BookOpen,
  Files,
  ChevronLeft,
  Database,
  Download,
  Music2,
  Play,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ReviewerMode } from "./ttml-reviewer";

export type LoadMode = "persistent" | "temporary" | "session";

export interface SavedLyrics {
  key: string;
  uri: string;
  name: string;
  artists: string;
  kind: string;
  saved_at: number;
  image?: string;
}

const TITLES = {
  load: "Load TTML",
  database: "TTML Database",
  bulk: "Bulk Load",
} as const;

const MODES: { mode: LoadMode; title: string; detail: string }[] = [
  {
    mode: "persistent",
    title: "Persistent Load",
    detail: "Saved on this computer, survives restarts",
  },
  {
    mode: "temporary",
    title: "Temporary Load",
    detail: "Applied only to the current song until lyrics reload",
  },
  {
    mode: "session",
    title: "Session Load",
    detail: "Used for this song until Lyssna restarts",
  },
];

/**
 * Spicy Lyrics' "Load TTML" window (iPixelGalaxy/spicy-lyrics,
 * UploadTTMLModal and LyricsManager, AGPL-3.0), reimplemented: three ways to
 * load a lyric file, a reset back to provider lyrics, and the saved files.
 */
export function LoadTtml({
  song,
  onLoad,
  onReset,
  onGuide,
  listSaved,
  deleteSaved,
  onPlay,
  onDownload,
  onClose,
  onBulk,
  searchSongs,
  attachSong,
  onSubmit,
  submitBlocked,
  initialView = "load",
  reviewer,
  onReviewer,
  sources,
  songSource,
  onSongSource,
}: {
  /** Every lyrics source, in the user's order. */
  sources: { id: string; name: string }[];
  /** The source chosen for the playing song, or null for the usual order. */
  songSource: string | null;
  onSongSource: (source: string | null) => void;
  reviewer: ReviewerMode;
  onReviewer: (mode: ReviewerMode) => void;
  onSubmit: (file: File) => Promise<void>;
  /** Why "Submit to Lyssna" is greyed out, or null when it can be used. */
  submitBlocked: string | null;
  onBulk: (files: BulkFile[]) => Promise<BulkLyric[]>;
  searchSongs: (query: string) => Promise<Track[]>;
  attachSong: (file: BulkFile, song: Track) => Promise<void>;
  initialView?: "load" | "database";
  song: string;
  onLoad: (file: File, mode: LoadMode) => Promise<void>;
  onReset: () => void;
  onGuide: () => void;
  listSaved: () => Promise<SavedLyrics[]>;
  deleteSaved: (key: string) => Promise<void>;
  onPlay: (uri: string) => void;
  onDownload: (item: SavedLyrics) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"load" | "database" | "bulk">(initialView);
  const [bulkFiles, setBulkFiles] = useState<BulkFile[]>([]);
  const [bulkResults, setBulkResults] = useState<BulkLyric[] | null>(null);
  const many = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [reviewerInfo, setReviewerInfo] = useState(false);
  const [saved, setSaved] = useState<SavedLyrics[] | null>(null);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const words = filter.trim().toLocaleLowerCase();
    return (saved ?? []).filter(
      (item) =>
        !words ||
        `${item.name} ${item.artists}`.toLocaleLowerCase().includes(words),
    );
  }, [saved, filter]);
  const input = useRef<HTMLInputElement>(null);
  const submitInput = useRef<HTMLInputElement>(null);
  const pending = useRef<LoadMode>("persistent");
  useEffect(() => {
    if (view !== "database") return;
    let live = true;
    void listSaved().then((items) => live && setSaved(items ?? []));
    return () => {
      live = false;
    };
  }, [view, listSaved]);
  const pick = (mode: LoadMode) => {
    if (busy) return;
    pending.current = mode;
    if (input.current) {
      input.current.value = "";
      input.current.click();
    }
  };
  return (
    <div className="modal-backdrop load-ttml-backdrop" onClick={onClose}>
      <section
        className="dialog load-ttml"
        role="dialog"
        aria-label={TITLES[view]}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="load-ttml-head">
          <h2>{TITLES[view]}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {view === "load" ? (
          <div className="load-ttml-body">
            <div className="load-ttml-row">
              <p>For: {song}</p>
              <div className="load-ttml-actions">
                <button onClick={onGuide} disabled={busy}>
                  <BookOpen size={14} />
                  Guide
                </button>
                <button onClick={onReset} disabled={busy}>
                  <RotateCcw size={14} />
                  Reset TTML
                </button>
                <button
                  title="Load many lyric files at once, each saved for its own song"
                  onClick={() => {
                    if (busy || !many.current) return;
                    many.current.value = "";
                    many.current.click();
                  }}
                  disabled={busy}
                >
                  <Files size={14} />
                  Bulk Load
                </button>
                <button onClick={() => setView("database")} disabled={busy}>
                  <Database size={14} />
                  TTML Database
                </button>
              </div>
            </div>
            <input
              ref={input}
              type="file"
              accept=".ttml,.xml,.lrc"
              hidden
              aria-label="Lyric file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                void onLoad(file, pending.current).finally(() =>
                  setBusy(false),
                );
              }}
            />
            <div className="load-ttml-modes">
              {MODES.map(({ mode, title, detail }) => (
                <button
                  key={mode}
                  className="load-ttml-mode"
                  onClick={() => pick(mode)}
                  disabled={busy}
                >
                  <span className="load-ttml-icon">
                    <Upload size={15} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                </button>
              ))}
              <button
                className="load-ttml-mode load-ttml-submit"
                title={submitBlocked ?? undefined}
                onClick={() => {
                  if (busy || submitBlocked || !submitInput.current) return;
                  submitInput.current.value = "";
                  submitInput.current.click();
                }}
                disabled={busy || !!submitBlocked}
              >
                <span className="load-ttml-icon">
                  <Send size={15} />
                </span>
                <span>
                  <strong>Submit to Lyssna</strong>
                  <small>
                    {submitBlocked ??
                      "Upload a TTML for this song to Lyssna for everyone"}
                  </small>
                </span>
              </button>
            </div>
            <section
              className="load-ttml-reviewer"
              aria-labelledby="ttml-song-source-title"
            >
              <div className="load-ttml-reviewer-row">
                <span>
                  <strong id="ttml-song-source-title">Lyrics source</strong>
                  <small>
                    Show this song's lyrics from one source whenever it has
                    them, instead of your usual order.
                  </small>
                </span>
                <Picker
                  label="Lyrics source for this song"
                  options={[
                    ["", "Your order"],
                    ...sources.map(
                      (source) => [source.id, source.name] as [string, string],
                    ),
                  ]}
                  value={songSource ?? ""}
                  disabled={busy}
                  onChange={(source) => onSongSource(source || null)}
                />
              </div>
            </section>
            <section
              className="load-ttml-reviewer"
              aria-labelledby="ttml-reviewer-title"
            >
              <div className="load-ttml-reviewer-row">
                <span>
                  <strong id="ttml-reviewer-title">TTML Reviewer</strong>
                  <small>
                    Apply a consistent review profile, then restore your
                    settings when it stops.
                  </small>
                </span>
                <button
                  className="load-ttml-reviewer-info"
                  aria-expanded={reviewerInfo}
                  aria-controls="ttml-reviewer-changes"
                  onClick={() => setReviewerInfo((open) => !open)}
                >
                  What does it change?
                </button>
                <Picker
                  label="TTML Reviewer"
                  options={REVIEWER_MODES}
                  value={reviewer}
                  disabled={busy}
                  onChange={onReviewer}
                />
              </div>
              {reviewerInfo && (
                <ul id="ttml-reviewer-changes">
                  <li>
                    Lyric size, font and timing offsets go back to default
                  </li>
                  <li>
                    Early and smooth scrolling, simple and minimal lyrics use
                    their defaults
                  </li>
                  <li>
                    Space Gravity, Highlighter, romanization, translations and
                    word sync turn off
                  </li>
                  <li>Up next and the visualiser are hidden</li>
                  <li>Your own settings stay saved and come back after</li>
                </ul>
              )}
            </section>
            <input
              ref={submitInput}
              type="file"
              accept=".ttml,.xml"
              hidden
              aria-label="TTML file to submit"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                void onSubmit(file).finally(() => setBusy(false));
              }}
            />
            <input
              ref={many}
              type="file"
              accept=".ttml,.xml,.lrc"
              multiple
              hidden
              aria-label="Lyric files"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                if (!picked.length) return;
                setView("bulk");
                setBulkResults(null);
                void Promise.all(
                  picked.map(async (file) => ({
                    filename: file.name,
                    contents: await file.text(),
                  })),
                ).then(async (files) => {
                  setBulkFiles(files);
                  setBulkResults(await onBulk(files));
                });
              }}
            />
          </div>
        ) : view === "bulk" ? (
          <div className="load-ttml-body">
            <div className="load-ttml-tools">
              <button
                className="load-ttml-back"
                aria-label="Back to Load TTML"
                onClick={() => setView("load")}
              >
                <ChevronLeft size={16} />
                Back
              </button>
            </div>
            <BulkTtml
              files={bulkFiles}
              results={bulkResults}
              search={searchSongs}
              attach={attachSong}
              onDone={onClose}
            />
          </div>
        ) : (
          <div className="load-ttml-body">
            <div className="load-ttml-tools">
              <button
                className="load-ttml-back"
                aria-label="Back to Load TTML"
                onClick={() => setView("load")}
              >
                <ChevronLeft size={16} />
                Back
              </button>
              <label className="load-ttml-search">
                <Search size={15} />
                <input
                  type="search"
                  placeholder="Search saved lyrics…"
                  aria-label="Search saved lyrics"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <button className="load-ttml-reset" onClick={onReset}>
                <RotateCcw size={14} />
                Reset TTML
              </button>
            </div>
            {saved === null ? (
              <p className="load-ttml-empty">Loading saved lyrics…</p>
            ) : saved.length === 0 ? (
              <p className="load-ttml-empty">
                No saved lyrics yet. Persistent loads appear here.
              </p>
            ) : shown.length === 0 ? (
              <p className="load-ttml-empty">No saved lyrics match.</p>
            ) : (
              <ul className="load-ttml-saved">
                {shown.map((item) => {
                  const name = item.name || "Unknown song";
                  return (
                    <li key={item.key}>
                      {item.image ? (
                        <img src={item.image} alt="" loading="lazy" />
                      ) : (
                        <span className="load-ttml-art" aria-hidden="true">
                          <Music2 size={18} />
                        </span>
                      )}
                      <span className="load-ttml-song">
                        <strong onMouseEnter={clippedTitle}>{name}</strong>
                        {item.artists && (
                          <small title={item.artists}>{item.artists}</small>
                        )}
                      </span>
                      <span className="load-ttml-row-actions">
                        <button
                          aria-label={`Play ${name}`}
                          title="Play"
                          disabled={!item.uri.startsWith("spotify:track:")}
                          onClick={() => onPlay(item.uri)}
                        >
                          <Play size={14} fill="currentColor" />
                        </button>
                        <button
                          aria-label={`Download lyrics for ${name}`}
                          title={`Download ${item.kind.toUpperCase()}`}
                          onClick={() => onDownload(item)}
                        >
                          <Download size={14} />
                        </button>
                        <button
                          aria-label={`Delete saved lyrics for ${name}`}
                          title="Delete"
                          onClick={() =>
                            void deleteSaved(item.key).then(() =>
                              setSaved((items) =>
                                (items ?? []).filter(
                                  (entry) => entry.key !== item.key,
                                ),
                              ),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const REVIEWER_MODES: [ReviewerMode, string][] = [
  ["off", "Off"],
  ["temporary", "Temporary loads"],
  ["always", "All loaded TTML"],
];

function Picker<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const index = Math.max(
    0,
    options.findIndex(([option]) => option === value),
  );
  const pick = (option: T) => {
    onChange(option);
    setOpen(false);
  };
  return (
    <div
      className="sort-menu-root reviewer-picker"
      ref={root}
      data-owns-escape={open || undefined}
    >
      <button
        className="settings-select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((shown) => !shown)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          onChange(
            options[(index + step + options.length) % options.length][0],
          );
        }}
      >
        {options[index]?.[1]}
      </button>
      {open && (
        <div className="sort-menu" role="listbox" aria-label={label}>
          {options.map(([option, name]) => (
            <button
              key={option}
              role="option"
              aria-selected={option === value}
              className={option === value ? "active" : ""}
              onClick={() => pick(option)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
