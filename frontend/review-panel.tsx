import { clippedTitle } from "./clipped-title";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  MessageSquareWarning,
  Play,
  RefreshCw,
  SquarePen,
  X,
} from "lucide-react";
import type { Lyrics, Track } from "./types";
import { Cover } from "./components";
import {
  GRADES,
  REJECT_REASONS,
  addReviewComment,
  decideReview,
  diffLines,
  editKinds,
  reviewComments,
  reviewPublished,
  reviewQueue,
  reviewSong,
  reviewSubmission,
  reviewTrackUri,
  revisionTtml,
  type DiffRow,
  type EditKind,
  type RejectReason,
  type ReviewAction,
  type ReviewComment,
  type ReviewLane,
  type ReviewSubmission,
} from "./review-api";
import { reviewEditor, type ReviewOpen } from "./review-editor";
import { formatTime } from "./ttml-creator-model";
import "./review-panel.css";

// Switching the sidebar to Now Playing or the queue keeps the open review.
const remembered: { picked?: ReviewSubmission; lane: ReviewLane } = {
  lane: "priority",
};

const ago = (iso: string) => {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
};
const who = (submission: ReviewSubmission) =>
  submission.submitter_name ? `@${submission.submitter_name}` : "Deleted user";
const QUOTE_TYPE = "application/x-lyssna-review-quote";
const NOTE_LIMIT = 2000;

function useReviewSong(submission: ReviewSubmission) {
  const [song, setSong] = useState<Track | null>();
  useEffect(() => {
    let live = true;
    void reviewSong(submission).then((found) => live && setSong(found ?? null));
    return () => {
      live = false;
    };
  }, [submission]);
  return song;
}

function ReviewQueue({
  lane,
  onLane,
  onPick,
  onClose,
  onRefresh,
}: {
  lane: ReviewLane;
  onLane: (lane: ReviewLane) => void;
  onPick: (submission: ReviewSubmission) => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [items, setItems] = useState<ReviewSubmission[] | null>(null);
  const [failed, setFailed] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [opening, setOpening] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const request = useRef(0);
  useEffect(() => {
    let live = true;
    setFailed(undefined);
    setItems(null);
    reviewQueue(lane).then(
      (list) => live && setItems(list ?? []),
      (error) => live && setFailed(String(error)),
    );
    return () => {
      live = false;
      request.current++;
    };
  }, [lane, refresh]);
  // The queue can be minutes old, so a pick opens the latest revision.
  const pick = async (item: ReviewSubmission) => {
    if (opening) return;
    const id = ++request.current;
    setOpening(item.id);
    setOpenError(undefined);
    try {
      const latest = await reviewSubmission(item.id);
      if (request.current === id) onPick(latest);
    } catch (error) {
      if (request.current === id) setOpenError(String(error));
    } finally {
      if (request.current === id) setOpening(undefined);
    }
  };
  return (
    <>
      <header className="review-head">
        <h3>Review</h3>
        <button
          className="review-icon"
          disabled={!!opening}
          onClick={() => {
            setOpenError(undefined);
            setRefresh((count) => count + 1);
            onRefresh();
          }}
          title="Refresh"
          aria-label="Refresh queue"
        >
          <RefreshCw size={15} />
        </button>
        <button
          className="review-icon"
          onClick={onClose}
          aria-label="Close review"
        >
          <X size={16} />
        </button>
      </header>
      <div className="review-queue">
        <div className="review-lanes" role="tablist" aria-label="Review queues">
          {(
            [
              ["priority", "Priority"],
              ["backlog", "Backlog"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={lane === value}
              disabled={!!opening}
              className={lane === value ? "active" : ""}
              onClick={() => {
                setOpenError(undefined);
                onLane(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {openError && (
          <p className="review-empty" role="alert">
            {openError}
          </p>
        )}
        {failed ? (
          <p className="review-empty">{failed}</p>
        ) : items === null ? (
          <p className="review-empty">Loading…</p>
        ) : !items.length ? (
          <p className="review-empty">Nothing waiting here.</p>
        ) : (
          <ul className="review-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  disabled={!!opening}
                  aria-busy={opening === item.id}
                  onClick={() => void pick(item)}
                >
                  <ReviewSongRow submission={item} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ReviewSongRow({ submission }: { submission: ReviewSubmission }) {
  const song = useReviewSong(submission);
  return (
    <>
      <Cover images={song?.album.images ?? []} className="review-cover" />
      <span className="review-song">
        <strong>{song?.name ?? submission.song_title}</strong>
        {song && (
          <span>{song.artists.map((artist) => artist.name).join(", ")}</span>
        )}
        <small>
          {submission.instrumental
            ? "Instrumental"
            : submission.kind === "edit"
              ? "Edit"
              : "New"}{" "}
          · {who(submission)} · Tier {submission.submitter_tier} ·{" "}
          {ago(submission.submitted_at)}
          {submission.major_rewrite
            ? " · Major rewrite"
            : submission.light_review
              ? " · Light review"
              : ""}
        </small>
      </span>
    </>
  );
}

/** The right sidebar's review queue, and a picked submission's changes,
 *  comments and decision. */
export function ReviewPanel({
  playing,
  onPlay,
  onOpen,
  onParse,
  onDecided,
  notify,
  onClose,
}: {
  playing?: Track;
  onPlay: (uri: string) => void;
  /** Loads a submission into the TTML Creator. */
  onOpen: (open: ReviewOpen) => void;
  onParse: (ttml: string, durationMs: number) => Promise<Lyrics>;
  /** A decision was made or the queue changed, so waiting counts refresh. */
  onDecided: () => void;
  notify: (message: string, error?: boolean) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(remembered.picked);
  const [lane, setLane] = useState(remembered.lane);
  const [notice, setNotice] = useState("");
  const editing = useSyncExternalStore(
    reviewEditor.subscribe,
    reviewEditor.draft,
  );
  const opening = useSyncExternalStore(
    reviewEditor.subscribe,
    reviewEditor.request,
  );
  useEffect(() => {
    remembered.picked = picked;
    remembered.lane = lane;
  }, [picked, lane]);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => panel.current?.focus({ preventScroll: true }), []);
  const back = () => {
    const request = reviewEditor.request();
    if (request && request.submission.id === picked?.id)
      reviewEditor.cancel(request);
    setPicked(undefined);
  };
  return (
    <div
      className="review-panel"
      role="region"
      aria-label="Review"
      ref={panel}
      tabIndex={-1}
    >
      {picked ? (
        <ReviewDetail
          key={picked.id}
          submission={picked}
          playing={playing}
          editing={editing?.id === picked.id ? editing : undefined}
          opening={opening?.submission.id === picked.id}
          onPlay={onPlay}
          onOpen={onOpen}
          onParse={onParse}
          notify={notify}
          onBack={back}
          onClose={onClose}
          onChanged={onDecided}
          onDecided={(message) => {
            setNotice(message);
            setPicked(undefined);
            onDecided();
          }}
        />
      ) : (
        <ReviewQueue
          lane={lane}
          onLane={setLane}
          onPick={(submission) => {
            setNotice("");
            setPicked(submission);
          }}
          onClose={onClose}
          onRefresh={onDecided}
        />
      )}
      {notice && (
        <p className="review-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function ReviewDetail({
  submission,
  playing,
  editing,
  opening,
  onPlay,
  onOpen,
  onParse,
  notify,
  onBack,
  onClose,
  onChanged,
  onDecided,
}: {
  submission: ReviewSubmission;
  playing?: Track;
  editing?: { changed: boolean; submit(): Promise<void> };
  opening: boolean;
  onPlay: (uri: string) => void;
  onOpen: (open: ReviewOpen) => void;
  onParse: (ttml: string, durationMs: number) => Promise<Lyrics>;
  notify: (message: string, error?: boolean) => void;
  onBack: () => void;
  onClose: () => void;
  onChanged: () => void;
  onDecided: (message: string) => void;
}) {
  const song = useReviewSong(submission);
  const [uri, setUri] = useState<string | null>();
  const [ttml, setTtml] = useState<string | null>();
  const [preview, setPreview] = useState<Lyrics>();
  const [showPreview, setShowPreview] = useState(false);
  const [diff, setDiff] = useState<DiffRow[] | null>();
  const [kinds, setKinds] = useState<{ kind: EditKind; lines: number }[]>([]);
  const [comments, setComments] = useState<ReviewComment[]>();
  const [commentError, setCommentError] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [grade, setGrade] = useState<1 | 2 | 3>(3);
  const [note, setNote] = useState("");
  const [quoteTooLong, setQuoteTooLong] = useState(false);
  const [reason, setReason] = useState<RejectReason>("low_effort");
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [fixPending, setFixPending] = useState(false);
  const [outcome, setOutcome] = useState<ReviewAction>("approve");
  const id = submission.id;
  const instrumental = !!submission.instrumental;
  // Callers pass fresh callbacks each render; the fetches below run once.
  const parse = useRef(onParse);
  parse.current = onParse;
  const tell = useRef(notify);
  tell.current = notify;
  const duration = song?.duration_ms ?? 0;
  useEffect(() => {
    let live = true;
    void reviewTrackUri(submission).then(
      (found) => live && setUri(found ?? null),
    );
    if (submission.head_revision_id && !instrumental)
      revisionTtml(submission.head_revision_id).then(
        (text) => live && setTtml(text),
        (error) => {
          if (!live) return;
          setTtml(null);
          tell.current(String(error), true);
        },
      );
    reviewComments(id).then(
      (list) => live && setComments(list),
      () => live && setCommentError(true),
    );
    return () => {
      live = false;
    };
  }, [submission, id, instrumental]);
  useEffect(() => {
    if (!ttml) return;
    let live = true;
    parse.current(ttml, duration).then(
      (lyrics) => live && setPreview(lyrics),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ttml, duration]);
  useEffect(() => {
    if (!ttml || submission.kind !== "edit" || !submission.base_revision_id)
      return setDiff(null);
    let live = true;
    const lines = (lyrics: Lyrics) =>
      lyrics.lines
        .filter((line) => !line.background)
        .map((line) => ({ text: line.text, startMs: line.start_ms }));
    revisionTtml(submission.base_revision_id)
      .then((base) =>
        Promise.all([parse.current(base, 0), parse.current(ttml, 0)]),
      )
      .then(
        ([before, after]) => {
          if (!live) return;
          setDiff(diffLines(lines(before), lines(after)));
          setKinds(editKinds(before, after));
        },
        () => live && setDiff(null),
      );
    return () => {
      live = false;
    };
  }, [ttml, submission]);

  const playingIt = !!uri && playing?.uri === uri;
  const canDecide = instrumental || !!ttml;
  const submitFix = async () => {
    try {
      await editing!.submit();
      onDecided(
        `Approved ${submission.song_title}. Your edit was submitted too.`,
      );
    } catch (error) {
      setFixPending(true);
      setDecisionError(String(error));
      notify(`Original approved. Couldn't submit your edit. ${error}`, true);
    }
  };
  const decide = async (action: ReviewAction, withEdits = false) => {
    if (busy || submission.status !== "pending" || !canDecide) return;
    if (withEdits && !editing?.changed) return;
    setBusy(true);
    setDecisionError("");
    try {
      const latest = await reviewSubmission(id);
      if (
        latest.status !== "pending" ||
        latest.head_revision_id !== submission.head_revision_id ||
        !!latest.instrumental !== instrumental
      ) {
        notify("This submission changed. Open it again from the queue.", true);
        onChanged();
        onBack();
        return;
      }
      await decideReview(id, action, {
        grade: action === "approve" && !instrumental ? grade : undefined,
        reason: action === "reject" ? reason : undefined,
        note: note.trim() || undefined,
      });
      if (withEdits) {
        onChanged();
        await submitFix();
        return;
      }
      if (action === "approve") void reviewPublished(submission);
      onDecided(
        action === "approve"
          ? `Approved ${submission.song_title}.`
          : action === "reject"
            ? `Rejected ${submission.song_title}.`
            : `Asked for changes to ${submission.song_title}.`,
      );
    } catch (error) {
      setDecisionError(String(error));
      notify(String(error), true);
    } finally {
      setBusy(false);
    }
  };
  const retryFix = async () => {
    if (busy || !editing) return;
    setBusy(true);
    setDecisionError("");
    try {
      await submitFix();
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const comment = await addReviewComment(id, body);
      setComments((list) => [...(list ?? []), comment]);
      setReply((current) => (current.trim() === body ? "" : current));
    } catch (error) {
      notify(String(error), true);
    } finally {
      setSending(false);
    }
  };
  const changed = diff?.filter((row) => row.kind !== "same" || row.retimed);
  // Lines drag into the decision note as quotes.
  const quoteDrag = (text: string, startMs?: number) => {
    if (submission.status !== "pending" || fixPending || busy || !text.trim())
      return {};
    return {
      draggable: true,
      title: "Drag into the decision note to quote",
      onDragStart(event: DragEvent<HTMLLIElement>) {
        const time = startMs !== undefined ? `${formatTime(startMs)} ` : "";
        event.dataTransfer.setData(QUOTE_TYPE, `${time}“${text.trim()}”`);
        event.dataTransfer.effectAllowed = "copy";
      },
    };
  };
  const dropQuote = (event: DragEvent<HTMLTextAreaElement>) => {
    delete event.currentTarget.dataset.quoteOver;
    const quote = event.dataTransfer.getData(QUOTE_TYPE);
    if (!quote) return;
    event.preventDefault();
    event.stopPropagation();
    const separator = note && !note.endsWith("\n") ? "\n" : "";
    const next = note + separator + quote;
    setQuoteTooLong(next.length > NOTE_LIMIT);
    if (next.length <= NOTE_LIMIT) setNote(next);
    event.currentTarget.focus({ preventScroll: true });
  };

  return (
    <div className="review-detail">
      <header className="review-head">
        <button
          className="review-icon"
          disabled={busy}
          onClick={onBack}
          aria-label="Back to the queue"
        >
          <ArrowLeft size={16} />
        </button>
        <Cover images={song?.album.images ?? []} className="review-cover" />
        <h3 onMouseEnter={clippedTitle}>{submission.song_title}</h3>
        <button
          className="review-icon"
          onClick={onClose}
          aria-label="Close review"
        >
          <X size={16} />
        </button>
      </header>
      <p className="review-meta">
        {instrumental
          ? "Marked instrumental"
          : submission.kind === "edit"
            ? "Edit"
            : "New lyrics"}{" "}
        by {who(submission)} · Tier {submission.submitter_tier} ·{" "}
        {ago(submission.submitted_at)}
      </p>
      <div className="review-buttons">
        <button
          disabled={
            !uri ||
            opening ||
            busy ||
            (!instrumental &&
              !!submission.head_revision_id &&
              ttml === undefined)
          }
          title={uri === null ? "No Spotify link for this song" : undefined}
          onClick={() => {
            if (!uri) return;
            // Playing a submission opens it, unless it already is open.
            if (ttml && !editing && !instrumental && !fixPending)
              onOpen({ submission, uri, ttml });
            else onPlay(uri);
          }}
        >
          <Play size={14} /> {playingIt ? "Playing" : "Play song"}
        </button>
        {!instrumental && !fixPending && (
          <button
            disabled={!uri || !ttml || !!editing || opening || busy}
            onClick={() => uri && ttml && onOpen({ submission, uri, ttml })}
          >
            <SquarePen size={14} />{" "}
            {opening
              ? "Opening…"
              : editing
                ? "Opened in editor"
                : "Open in editor"}
          </button>
        )}
      </div>
      {instrumental && (
        <p className="review-instrumental">
          No lyrics sent. The submitter says this song is instrumental. Play it
          and approve if nobody sings in it.
        </p>
      )}
      {preview && (
        <section className="review-section">
          <div className="review-buttons">
            <button
              aria-expanded={showPreview}
              onClick={() => setShowPreview(!showPreview)}
            >
              {showPreview ? "Hide submitted lyrics" : "Show submitted lyrics"}
            </button>
          </div>
          {showPreview && (
            <ol className="review-diff review-lyrics">
              {preview.lines
                .filter((line) => !line.background)
                .map((line, index) => (
                  <li
                    key={index}
                    {...quoteDrag(
                      line.text,
                      preview.synced ? line.start_ms : undefined,
                    )}
                  >
                    {line.text || "(empty line)"}
                  </li>
                ))}
            </ol>
          )}
        </section>
      )}
      {submission.kind === "edit" && !instrumental && (
        <section className="review-section">
          <h4>Changes</h4>
          {!!kinds.length && (
            <ul className="review-kinds">
              {kinds.map(({ kind, lines }) => (
                <li key={kind}>
                  {kind}{" "}
                  <span>
                    {lines} {lines === 1 ? "line" : "lines"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {diff === undefined ? (
            <p className="review-empty">Comparing…</p>
          ) : diff === null ? (
            <p className="review-empty">
              Couldn't compare with the live lyrics.
            </p>
          ) : !changed?.length ? (
            !kinds.length && (
              <p className="review-empty">
                No line changes; only song details differ.
              </p>
            )
          ) : (
            <ol className="review-diff">
              {diff.map((row, index) =>
                row.kind === "same" && !row.retimed ? null : (
                  <li
                    key={index}
                    data-kind={row.kind === "same" ? "retimed" : row.kind}
                    {...quoteDrag(row.text)}
                  >
                    {row.text || "(empty line)"}
                  </li>
                ),
              )}
            </ol>
          )}
        </section>
      )}
      <section className="review-section">
        <h4>Comments</h4>
        {commentError && !comments ? (
          <p className="review-empty">Couldn't load comments.</p>
        ) : comments === undefined ? (
          <p className="review-empty">Loading…</p>
        ) : !comments.length ? (
          <p className="review-empty">No comments yet.</p>
        ) : (
          <ul className="review-comments">
            {comments.map((comment) => (
              <li key={comment.id}>
                <strong>
                  {comment.author_name
                    ? `@${comment.author_name}`
                    : "Deleted user"}
                </strong>
                <p>{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="review-reply">
          <input
            value={reply}
            placeholder="Comment to the submitter"
            aria-label="Comment"
            maxLength={2000}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void send()}
          />
          <button
            onClick={() => void send()}
            disabled={!reply.trim() || sending}
          >
            Send
          </button>
        </div>
      </section>
      {fixPending ? (
        <section className="review-section">
          <h4>Original approved</h4>
          {decisionError && <p role="alert">{decisionError}</p>}
          <div className="review-buttons">
            <button
              disabled={busy || !editing}
              title={editing ? undefined : "Open it in the editor again first"}
              onClick={() => void retryFix()}
            >
              Retry submitting your edit
            </button>
          </div>
        </section>
      ) : submission.status !== "pending" ? (
        <p className="review-empty">
          This submission is no longer waiting for review.
        </p>
      ) : (
        <section
          className="review-section review-decide"
          data-outcome={outcome}
        >
          <h4>Decision</h4>
          {decisionError && (
            <p className="review-empty" role="alert">
              {decisionError}
            </p>
          )}
          <div
            className="review-outcomes"
            role="radiogroup"
            aria-label="Decision"
          >
            {(
              [
                ["approve", "Approve", CircleCheck],
                ["request-changes", "Changes", MessageSquareWarning],
                ["reject", "Reject", CircleX],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                role="radio"
                aria-checked={outcome === value}
                data-outcome={value}
                onClick={() => setOutcome(value)}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
          {outcome === "approve" && !instrumental && (
            <>
              <small className="review-label">Quality</small>
              <div
                className="review-choice"
                role="radiogroup"
                aria-label="Quality"
              >
                {GRADES.map(([value, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={grade === value}
                    className={grade === value ? "active" : ""}
                    onClick={() => setGrade(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          {outcome === "reject" && (
            <>
              <small className="review-label">Reason</small>
              <div
                className="review-choice"
                role="radiogroup"
                aria-label="Reject reason"
              >
                {REJECT_REASONS.map(([value, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={reason === value}
                    className={reason === value ? "active" : ""}
                    onClick={() => setReason(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          <textarea
            value={note}
            placeholder={
              outcome === "request-changes"
                ? "What should the submitter change?"
                : "Note for the submitter (optional)"
            }
            aria-label="Decision note"
            maxLength={NOTE_LIMIT}
            onChange={(event) => {
              setNote(event.target.value);
              setQuoteTooLong(false);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(QUOTE_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              event.currentTarget.dataset.quoteOver = "";
            }}
            onDragLeave={(event) => {
              delete event.currentTarget.dataset.quoteOver;
            }}
            onDrop={dropQuote}
          />
          {quoteTooLong && (
            <p className="review-empty" role="alert">
              This quote would go over the 2,000-character note limit.
            </p>
          )}
          <div className="review-buttons">
            {outcome === "approve" ? (
              <>
                <button
                  className="review-confirm"
                  disabled={busy || !canDecide}
                  onClick={() => void decide("approve")}
                >
                  <CircleCheck size={14} />{" "}
                  {instrumental ? "Approve as instrumental" : "Approve"}
                </button>
                {!instrumental && (
                  <button
                    disabled={busy || !ttml || !editing?.changed}
                    title={
                      editing?.changed
                        ? "Approve, then submit your corrections as an edit credited to you"
                        : "Open it in the editor and make corrections first"
                    }
                    onClick={() => void decide("approve", true)}
                  >
                    <SquarePen size={14} /> Fix and approve
                  </button>
                )}
              </>
            ) : outcome === "request-changes" ? (
              <button
                className="review-confirm"
                disabled={busy || !canDecide || !note.trim()}
                title={
                  note.trim() ? undefined : "Write a note saying what to change"
                }
                onClick={() => void decide("request-changes")}
              >
                <MessageSquareWarning size={14} /> Ask for changes
              </button>
            ) : (
              <button
                className="review-confirm"
                disabled={busy || !canDecide}
                onClick={() => void decide("reject")}
              >
                <CircleX size={14} /> Reject
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
