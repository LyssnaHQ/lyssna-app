import { useEffect, useRef, useState } from "react";
import { ExternalLink, Link2, LogOut } from "lucide-react";
import { SettingRow } from "./setting-row";

interface IsrcBackfill {
  songs: number;
  added: number;
  already: number;
  no_spotify: number;
  no_isrc: number;
  taken: string[];
  failed: string[];
}

interface Account {
  id: string;
  username: string;
  role: string;
  reputation: number;
  tier_name: string;
  /** The reputation tier's number; 3 is Trusted. */
  tier?: number;
  email_verified: boolean;
}

/** Lyssna account for submitting and reviewing lyrics. Sign-in happens on
 *  lyssna.org in the browser; the tokens stay in the credential store. */
export function LyssnaAccount({
  onCall,
  onNotice,
}: {
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    let active = true;
    void onCall<Account | null>("lyssna_account")
      .then((value) => {
        if (active) setAccount(value ?? null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onCall]);
  const signIn = async () => {
    setSigningIn(true);
    try {
      const found = await onCall<Account>("lyssna_sign_in");
      if (found) {
        setAccount(found);
        onNotice(`Signed in to Lyssna as ${found.username}`);
      }
    } finally {
      setSigningIn(false);
    }
  };
  const [backfilling, setBackfilling] = useState(false);
  const backfill = async () => {
    setBackfilling(true);
    try {
      const report = await onCall<IsrcBackfill>("lyssna_backfill_isrc");
      if (!report) return;
      const extra = [
        report.already && `${report.already} already had one`,
        report.no_isrc && `${report.no_isrc} without an ISRC on Spotify`,
        report.no_spotify && `${report.no_spotify} without a Spotify link`,
        report.taken.length &&
          `${report.taken.length} with an ISRC already on another song: ${report.taken.join(", ")}`,
        report.failed.length &&
          `${report.failed.length} failed: ${report.failed.join("; ")}`,
      ].filter(Boolean);
      onNotice(
        `Added ISRC links to ${report.added} of ${report.songs} songs${extra.length ? `. ${extra.join(". ")}` : ""}`,
        report.failed.length > 0,
      );
    } finally {
      setBackfilling(false);
    }
  };
  const signOut = async () => {
    await onCall("lyssna_sign_out");
    window.dispatchEvent(new Event(ACT_AS_CHANGED));
    setAccount(null);
    onNotice("Signed out of Lyssna");
  };
  const role =
    account && account.role !== "user"
      ? `${account.role[0].toUpperCase()}${account.role.slice(1)} · `
      : "";
  return (
    <>
      <SettingRow
        label={account ? account.username : "Lyssna account"}
        help={
          loading
            ? "Checking…"
            : account
              ? `${role}${account.tier_name} · ${account.reputation} reputation${account.email_verified ? "" : " · confirm your email on lyssna.org to submit lyrics"}`
              : signingIn
                ? "Finish signing in in your browser."
                : "Sign in to submit lyrics, review them and get notified when yours are approved."
        }
        keywords="lyssna account sign in log in submit lyrics review profile"
      >
        {account ? (
          <div className="inline-actions">
            {account.role === "admin" && (
              <button
                className="pill outline"
                disabled={backfilling}
                title="Look up each Lyssna song's ISRC on Spotify and add it as a link"
                onClick={() => void backfill()}
              >
                <Link2 size={14} />
                {backfilling ? "Adding ISRCs…" : "Add ISRC links"}
              </button>
            )}
            <button
              className="pill outline"
              onClick={() =>
                void onCall("open_link", { url: "https://lyssna.org/u/me" })
              }
            >
              Profile
              <ExternalLink size={13} />
            </button>
            <button className="pill outline" onClick={() => void signOut()}>
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        ) : signingIn ? (
          <button
            className="pill outline"
            onClick={() => void onCall("lyssna_cancel_sign_in")}
          >
            Cancel
          </button>
        ) : (
          <button
            className="pill"
            disabled={loading}
            onClick={() => void signIn()}
          >
            Sign in
            <ExternalLink size={13} />
          </button>
        )}
      </SettingRow>
      {account?.role === "admin" && <ActAsSetting onCall={onCall} />}
    </>
  );
}

interface ActAs {
  id: string;
  username: string;
  /** When it ends, Unix milliseconds. */
  until: number;
}

interface ActAsMatch {
  id: string;
  username: string;
  reserved: boolean;
}

const ACT_AS_CHANGED = "lyssna:act-as";
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Admins only: uploads go to the chosen account until it is cleared, the
 *  app closes or four hours pass. The API refuses it for anyone else. */
function ActAsSetting({
  onCall,
}: {
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
}) {
  const [active, setActive] = useState<ActAs | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ActAsMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef(0);
  useEffect(() => {
    const update = () =>
      void onCall<ActAs | null>("lyssna_act_as").then((value) =>
        setActive(value ?? null),
      );
    update();
    window.addEventListener(ACT_AS_CHANGED, update);
    return () => window.removeEventListener(ACT_AS_CHANGED, update);
  }, [onCall]);
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setMatches([]);
      return;
    }
    const mine = ++latest.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void onCall<ActAsMatch[]>("lyssna_act_as_find", { query: text })
        .then((found) => {
          if (mine === latest.current) setMatches(found ?? []);
        })
        .finally(() => {
          if (mine === latest.current) setSearching(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, onCall]);
  const choose = async (match: ActAsMatch) => {
    const chosen = await onCall<ActAs>("lyssna_act_as_set", {
      id: match.id,
      username: match.username,
    });
    if (!chosen) return;
    setActive(chosen);
    setQuery("");
    setMatches([]);
  };
  const stop = async () => {
    await onCall("lyssna_act_as_clear");
    setActive(null);
  };
  const empty = query.trim() && !searching && matches.length === 0;
  return (
    <SettingRow
      label={
        active ? `Uploading as ${active.username}` : "Upload as another account"
      }
      stacked
      help={
        active
          ? `Lyrics you submit go to ${active.username} until ${clock.format(active.until)}, or until you stop or close Lyssna.`
          : "Admins only. Type part of an account's name, or paste its user ID, to submit lyrics as it for a while."
      }
      keywords="admin upload as another account reserved act as impersonate user id"
    >
      {active ? (
        <button className="pill outline" onClick={() => void stop()}>
          Stop uploading as {active.username}
        </button>
      ) : (
        <div className="act-as-search">
          <input
            type="text"
            aria-label="Account name or user ID"
            placeholder="Name or user ID"
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {matches.map((match) => (
            <button
              key={match.id}
              className="pill outline"
              title={match.reserved ? "Reserved account" : undefined}
              onClick={() => void choose(match)}
            >
              {match.username}
            </button>
          ))}
          {empty && <span className="act-as-none">No account matches</span>}
        </div>
      )}
    </SettingRow>
  );
}
