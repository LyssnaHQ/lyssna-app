import { useState } from "react";
import { Music2 } from "lucide-react";
import { rpc } from "./bridge";
import type { AppState } from "./state";
import type { Track } from "./types";

type Notify = (message: string, error?: boolean) => void;

/** Lyssna answered this song's lookup with an instrumental mark. */
/** The playing song already has lyrics lines, so it can't be instrumental. */
export function hasLyrics(state: AppState, track?: Track) {
  return (
    !!track &&
    state.playback.item?.uri === track.uri &&
    !state.lyrics?.instrumental &&
    !!state.lyrics?.lines.length
  );
}

export function markedInstrumental(state: AppState, track?: Track) {
  return (
    !!track &&
    state.playback.item?.uri === track.uri &&
    !!state.lyrics?.instrumental &&
    state.lyrics.source === "lyssna"
  );
}

const spotifySong = (track: Track) => !track.is_local && !!track.id;

/** Tells Lyssna a Spotify song has no lyrics. It goes to review like
 *  lyrics do (a reviewer's applies at once) and, once approved, the song
 *  gets its page. Trusted members and up can also take a mark back. */
export function MarkInstrumental({
  track,
  marked,
  canUnmark = false,
  direct = false,
  confirm = false,
  notify,
  className,
  plain = false,
}: {
  track: Track;
  marked: boolean;
  canUnmark?: boolean;
  /** Lyssna has lyrics for the song, which a submission can't replace, so a
   *  Trusted member marks it at once instead. */
  direct?: boolean;
  /** Lyrics are showing, so ask once more: the mark hides them for everyone. */
  confirm?: boolean;
  notify: Notify;
  className?: string;
  /** Text only, for a row of quiet links. */
  plain?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  if (!spotifySong(track) || (marked && !canUnmark)) return null;
  const asking = confirm && !marked && confirming === track.uri;
  const toggle = async () => {
    if (confirm && !marked && !asking) {
      setConfirming(track.uri);
      window.setTimeout(
        () => setConfirming((uri) => (uri === track.uri ? undefined : uri)),
        5000,
      );
      return;
    }
    setConfirming(undefined);
    setBusy(true);
    try {
      if (marked) {
        await rpc("lyssna_mark_instrumental", { track, instrumental: null });
        notify("Instrumental mark taken back.");
      } else if (direct) {
        await rpc("lyssna_mark_instrumental", { track, instrumental: true });
        notify("Marked instrumental on Lyssna. Its lyrics are no longer shown.");
      } else {
        const sent = await rpc<{ status: string }>("lyssna_submit", { track });
        notify(
          sent.status === "approved"
            ? "Marked instrumental on Lyssna."
            : "Sent to Lyssna for review as instrumental.",
        );
      }
    } catch (error) {
      notify(String(error), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={className}
      onClick={() => void toggle()}
      disabled={busy}
      aria-busy={busy}
      title={
        marked
          ? "Take back the instrumental mark on Lyssna"
          : confirm
            ? "This song has no lyrics any more: stop showing its lyrics for everyone"
            : "Tell Lyssna this song has no lyrics"
      }
    >
      {!plain && <Music2 size={15} />}
      {marked
        ? "Unmark instrumental"
        : asking
          ? "Hide its lyrics for everyone?"
          : "Mark instrumental"}
    </button>
  );
}

/** Asks Lyssna for lyrics for a Spotify song, once per account or install. */
export function RequestLyrics({
  track,
  notify,
}: {
  track: Track;
  notify: Notify;
}) {
  const [wanted, setWanted] = useState<{ uri: string; count: number }>();
  const [busy, setBusy] = useState(false);
  if (!spotifySong(track)) return null;
  const count = wanted?.uri === track.uri ? wanted.count : undefined;
  const ask = async () => {
    setBusy(true);
    try {
      const requests = await rpc<number>("lyssna_request_lyrics", { track });
      setWanted({ uri: track.uri, count: requests });
      notify(
        requests > 1
          ? `Requested. ${requests} people want lyrics for this song.`
          : "Requested. Syncers on Lyssna can see it now.",
      );
    } catch (error) {
      notify(String(error), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={() => void ask()}
      disabled={busy || count !== undefined}
      aria-busy={busy}
      title="Ask the Lyssna community to sync this song"
    >
      {count === undefined
        ? "Request lyrics"
        : count > 1
          ? `Requested · ${count} want it`
          : "Requested"}
    </button>
  );
}
