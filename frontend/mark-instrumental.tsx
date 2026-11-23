import { useState } from "react";
import { Music2 } from "lucide-react";
import { rpc } from "./bridge";
import type { AppState } from "./state";
import type { Track } from "./types";

/** Lyssna answered this song's lookup with a reviewer's instrumental mark. */
export function markedInstrumental(state: AppState, track?: Track) {
  return (
    !!track &&
    state.playback.item?.uri === track.uri &&
    !!state.lyrics?.instrumental &&
    state.lyrics.source === "lyssna"
  );
}

/** A reviewer marks every recording of a Spotify song instrumental on
 *  Lyssna, or takes the mark back. */
export function MarkInstrumental({
  track,
  marked,
  notify,
  className,
  plain = false,
}: {
  track: Track;
  marked: boolean;
  notify: (message: string, error?: boolean) => void;
  className?: string;
  /** Text only, for a row of quiet links. */
  plain?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (track.is_local || !track.id) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      await rpc("lyssna_mark_instrumental", {
        track,
        instrumental: marked ? null : true,
      });
      notify(
        marked
          ? "Instrumental mark taken back."
          : "Marked instrumental on Lyssna.",
      );
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
          : "Mark every recording of this song instrumental on Lyssna"
      }
    >
      {!plain && <Music2 size={15} />}
      {marked ? "Unmark instrumental" : "Mark instrumental"}
    </button>
  );
}
