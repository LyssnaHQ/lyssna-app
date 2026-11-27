import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { rpc } from "./bridge";
import { nightlyProgress } from "./nightly-dialog";
import type { AppState } from "./state";

/** What a dismissal hides: one version, before or after it is ready. */
const key = (version: string, ready: boolean) =>
  `${version}${ready ? " ready" : ""}`;

const PENDING_KEY = "lyssna.pending-update";
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

type Pending = { from: string; to: string; notes: string };

function readPending(): Pending | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
    return value &&
      typeof value.from === "string" &&
      typeof value.to === "string"
      ? { notes: "", ...value }
      : null;
  } catch {
    return null;
  }
}

function writePending(pending: Pending | null) {
  try {
    if (pending) localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* Storage can be unavailable; the after-update note is optional. */
  }
}

/** Grows a dialog out of the element that opened it. */
function morphFrom(element: HTMLElement, origin?: DOMRect) {
  if (!origin || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return undefined;
  const bounds = element.getBoundingClientRect();
  if (!bounds.width) return undefined;
  const x = origin.left + origin.width / 2 - bounds.left - bounds.width / 2;
  const y = origin.top + origin.height / 2 - bounds.top - bounds.height / 2;
  return element.animate(
    [
      {
        transform: `translate(${x}px, ${y}px) scale(${origin.width / bounds.width})`,
        opacity: 0,
      },
      { opacity: 1, offset: 0.35 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 420, easing: EASE },
  );
}

function UpdateToast({
  title,
  description,
  action,
  onAction,
  onDismiss,
  warning,
}: {
  title: string;
  description: string;
  action: string;
  onAction(origin: DOMRect | undefined): void;
  onDismiss(): void;
  warning?: boolean;
}) {
  const toast = useRef<HTMLElement>(null);
  return (
    <aside className="update-toast" ref={toast} aria-label="Lyssna update">
      {warning && <TriangleAlert size={18} aria-hidden="true" />}
      <div className="update-toast-copy" role="status">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        className="pill primary"
        onClick={() => onAction(toast.current?.getBoundingClientRect())}
      >
        {action}
      </button>
      <button
        type="button"
        className="update-toast-dismiss"
        aria-label="Dismiss update"
        onClick={onDismiss}
      >
        <X size={14} />
      </button>
    </aside>
  );
}

/** Says what changed, once, after Lyssna restarts on a new version. */
function UpdatedDialog({
  pending,
  onClose,
}: {
  pending: Pending;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const leave = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 160);
  };
  return (
    <dialog
      ref={dialog}
      className={`dialog update-dialog${closing ? " update-closing" : ""}`}
      aria-labelledby="updated-title"
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          leave();
      }}
    >
      <h2 id="updated-title">Updated to {pending.to}</h2>
      <p id="update-description">
        You were on <strong>{pending.from}</strong>. You're now on{" "}
        <strong>{pending.to}</strong>.
      </p>
      {pending.notes && <ReleaseNotes notes={pending.notes} />}
      <div className="inline-actions">
        <button className="pill primary" autoFocus onClick={leave}>
          Got it
        </button>
      </div>
    </dialog>
  );
}

/** Updates belong to the app, independently of the Spotify account. */
export function UpdatePrompt({
  state,
  enabled,
  current,
}: {
  state: Pick<
    AppState,
    "update_version" | "update_notes" | "update_status" | "settings" | "nightly"
  >;
  enabled: boolean;
  /** This copy's Nightly commit, when it is one. */
  current?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  // Nightly updates show on the top bar's button (blue when found, a
  // progress ring while building, then Restart to update); this opens only
  // when that is clicked.
  const [asked, setAsked] = useState(false);
  const [requested, setRequested] = useState<"download" | "install">();
  const [error, setError] = useState("");
  const version = state.update_version;
  const status = state.update_status;
  const ready = status === "Ready to install";
  // Nightly updates are built on this computer rather than downloaded.
  const nightly = !!version?.startsWith("Nightly");
  const downloading =
    status.startsWith("Downloading update") ||
    status.startsWith("Building update") ||
    (status === "Update available" && state.settings.auto_download_updates);
  const fetched = /^Downloading update(?:\D+(\d{1,3})%)?/.exec(status);
  const fetchedPercent = fetched?.[1]
    ? Math.min(100, Number(fetched[1]))
    : undefined;
  // A background Nightly build's progress, while it runs.
  const report = nightly && state.nightly?.running ? state.nightly : undefined;
  const step = report?.steps.find((item) => item.state === "running");
  const percent = report ? Math.round(nightlyProgress(report) * 100) : 0;
  const building =
    nightly &&
    !ready &&
    (!!report ||
      status.startsWith("Building update") ||
      requested === "download");
  const offered = enabled && !!version && status !== "Up to date";
  const open = offered && asked;
  // Release updates first show as a toast; its Details opens the dialog.
  const toast =
    offered && !nightly && !asked && key(version, ready) !== dismissed;
  const [staying, setStaying] = useState(false);
  const [updated, setUpdated] = useState<Pending | null>(null);
  const origin = useRef<DOMRect>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Checking for a Nightly by hand shows what was found again.
  useEffect(() => {
    const show = () => {
      setDismissed(undefined);
      setStaying(false);
      origin.current = undefined;
      setAsked(true);
    };
    window.addEventListener("lyssna:show-update", show);
    return () => window.removeEventListener("lyssna:show-update", show);
  }, []);
  useEffect(() => {
    setRequested(undefined);
    setError("");
  }, [status, version]);
  useEffect(() => {
    if (!staying) return;
    const timer = setTimeout(() => setStaying(false), 9000);
    return () => clearTimeout(timer);
  }, [staying]);
  useEffect(() => {
    // Nightly keeps its own flow on the top bar's button.
    if (!ready || !version || nightly) return;
    writePending({
      from: __APP_VERSION__,
      to: version,
      notes: state.update_notes ?? "",
    });
  }, [ready, version, nightly, state.update_notes]);
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    if (__APP_VERSION__ === pending.to) setUpdated(pending);
    if (__APP_VERSION__ !== pending.from) writePending(null);
  }, []);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      clearTimeout(closing.current);
      element.classList.remove("update-closing");
      element.showModal();
      element.focus();
      morphFrom(element, origin.current);
      origin.current = undefined;
    }
    if (!open && element?.open) element.close();
  }, [open]);
  const apply = async () => {
    const action = ready ? "install" : "download";
    setRequested(action);
    setError("");
    try {
      await rpc("app_update", { action });
    } catch (reason) {
      setRequested(undefined);
      setError(String(reason));
    }
  };
  const dismiss = () => {
    if (requested === "install" || closing.current !== undefined) return;
    // Hidden while it downloads or builds, it opens again once ready.
    if (version) setDismissed(key(version, ready));
    const element = dialog.current;
    const finish = () => {
      closing.current = undefined;
      setAsked(false);
    };
    if (
      !element?.open ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return finish();
    element.classList.add("update-closing");
    closing.current = setTimeout(finish, 160);
  };
  const installed = __APP_VERSION__;
  return (
    <>
      {toast && (
        <UpdateToast
          key={key(version, ready)}
          title={
            ready ? `Lyssna ${version} is ready` : `Lyssna ${version} is out`
          }
          description={
            ready
              ? "Restart Lyssna to finish updating."
              : `You're on ${installed}.`
          }
          action="Details"
          onAction={(rect) => {
            origin.current = rect;
            setAsked(true);
          }}
          onDismiss={() => {
            setDismissed(key(version, ready));
            setStaying(true);
          }}
        />
      )}
      {staying && !toast && !open && version && !nightly && (
        <UpdateToast
          warning
          title={`Staying on ${installed}`}
          description="Updates bring new features and fixes as soon as they're ready."
          action={ready ? "Restart" : "Update"}
          onAction={(rect) => {
            setStaying(false);
            if (ready) void apply();
            else {
              origin.current = rect;
              setDismissed(undefined);
              setAsked(true);
            }
          }}
          onDismiss={() => setStaying(false)}
        />
      )}
      {updated && enabled && !open && (
        <UpdatedDialog pending={updated} onClose={() => setUpdated(null)} />
      )}
      <dialog
        ref={dialog}
        className="dialog update-dialog"
        tabIndex={-1}
        aria-labelledby="update-title"
        aria-describedby="update-description"
        // Clicking outside it hides it, as Settings and creator profiles do.
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            dismiss();
        }}
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons =
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            );
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first) {
            event.preventDefault();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="update-title">
          Lyssna {version} {ready ? "is ready to install" : "is available"}
        </h2>
        <p id="update-description">
          You're using{" "}
          {nightly && current
            ? `Nightly ${current.slice(0, 7)}`
            : `version ${__APP_VERSION__}`}
          . Updating restarts Lyssna.
        </p>
        {state.update_notes &&
          (nightly ? (
            <NightlyChanges
              notes={state.update_notes}
              current={current}
              latest={version?.replace(/^Nightly /, "")}
            />
          ) : (
            <ReleaseNotes notes={state.update_notes} />
          ))}
        {fetched && !nightly && !ready && (
          <div className="update-progress">
            <div className="update-progress-label">
              <span>Downloading</span>
              {fetchedPercent !== undefined && <span>{fetchedPercent}%</span>}
            </div>
            <div
              className={`nightly-bar nightly-total${fetchedPercent === undefined ? " moving" : ""}`}
              role="progressbar"
              aria-label="Downloading update"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fetchedPercent}
            >
              <span
                style={
                  fetchedPercent === undefined
                    ? undefined
                    : { width: `${fetchedPercent}%` }
                }
              />
            </div>
          </div>
        )}
        {report && (
          <div className="update-progress">
            <div className="update-progress-label">
              <span>{step?.label ?? "Building"}</span>
              <span>{percent}%</span>
            </div>
            <div
              className="nightly-bar nightly-total"
              role="progressbar"
              aria-label="Building update"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            {step?.detail && (
              <p className="update-progress-detail">{step.detail}</p>
            )}
          </div>
        )}
        <p
          role="status"
          aria-live="polite"
          className="update-status"
          // The title and progress bar already say these.
          hidden={
            !error &&
            requested !== "install" &&
            (!!report ||
              (!!fetched && !nightly && !ready) ||
              status === "Update available")
          }
        >
          {requested === "install"
            ? "Installing update…"
            : error ||
              (ready
                ? nightly
                  ? "Built and checked. Ready to install."
                  : "Download verified. Ready to install."
                : status)}
        </p>
        <div className="inline-actions">
          {building && (
            <button
              className="pill outline"
              onClick={() => {
                void rpc("nightly_cancel");
                setRequested(undefined);
              }}
            >
              Cancel build
            </button>
          )}
          <button
            className="pill outline"
            disabled={requested === "install"}
            onClick={dismiss}
          >
            {downloading || requested === "download"
              ? "Keep in background"
              : "Not now"}
          </button>
          <button
            className="pill primary"
            disabled={!!requested || downloading}
            onClick={() => void apply()}
          >
            {requested === "install"
              ? "Installing…"
              : ready
                ? "Install and restart"
                : downloading || requested === "download"
                  ? nightly
                    ? "Building…"
                    : "Downloading…"
                  : nightly
                    ? "Build update"
                    : "Download update"}
          </button>
        </div>
      </dialog>
    </>
  );
}

/** Release notes, one change per line, as a list. */
function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes
    .split(NEWLINE)
    .map((line) => line.replace(/^\s*(?:[-*•]\s+)?/u, "").trim())
    .filter(Boolean);
  return (
    <section aria-label="Release notes" className="update-release">
      <h3>What's new</h3>
      {lines.length > 1 ? (
        <ul className="update-list">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="update-notes">{lines[0] ?? notes}</p>
      )}
    </section>
  );
}

const KINDS = [
  ["new", "New"],
  ["fixed", "Fixed"],
  ["other", "Improved"],
] as const;

/**
 * The commits a Nightly brings, grouped into new, fixed and improved, each
 * with its short hash, and how many there are since this copy.
 */
function NightlyChanges({
  notes,
  current,
  latest,
}: {
  notes: string;
  current?: string | null;
  latest?: string;
}) {
  const lines = notes.split(NEWLINE).filter(Boolean);
  const commits = lines.flatMap((line) => {
    const match = /^([0-9a-f]{7}) (?:(new|fixed|other) )?(.+)$/.exec(line);
    return match
      ? [{ sha: match[1], kind: match[2] ?? "other", text: match[3] }]
      : [];
  });
  if (!commits.length)
    return (
      <section aria-label="Release notes">
        <h3>What changed</h3>
        <p className="update-notes">{notes}</p>
      </section>
    );
  const more = Number(/^and (\d+) more$/.exec(lines.at(-1) ?? "")?.[1] ?? 0);
  const total = commits.length + more;
  return (
    <section aria-label="Release notes" className="update-changes">
      <h3>
        {total === 1 ? "1 commit" : `${total} commits`} since your Nightly
      </h3>
      {current && latest && (
        <p className="update-range">
          <code>{current.slice(0, 7)}</code>
          <span aria-label="to">→</span>
          <code>{latest}</code>
        </p>
      )}
      <div className="update-commits">
        {KINDS.map(([kind, label]) => {
          const group = commits.filter((commit) => commit.kind === kind);
          if (!group.length) return null;
          return (
            <section key={kind} aria-label={label}>
              <h4>
                {label}
                <span>{group.length}</span>
              </h4>
              <ul>
                {group.map((commit) => (
                  <li key={commit.sha}>
                    <span>{commit.text}</span>
                    <code>{commit.sha}</code>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {more > 0 && (
        <p className="update-notes">
          {more === 1 ? "and 1 older commit" : `and ${more} older commits`}
        </p>
      )}
    </section>
  );
}

const NEWLINE = String.fromCharCode(10);
