import { useEffect, useState } from "react";
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
  email_verified: boolean;
}

interface ActAs {
  id: string;
  username: string;
  seconds_left: number;
}

interface Reserved {
  id: string;
  username: string;
}

/** Admins only: upload as a reserved account (one made for someone who hasn't signed up yet) for a few hours.
 *  Type part of its name or paste its user ID. The choice stays in memory, so quitting the app or signing out ends it. */
function ActAsRow({
  onCall,
  onNotice,
}: {
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [active, setActive] = useState<ActAs | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Reserved[]>([]);
  const [searching, setSearching] = useState(false);
  const [none, setNone] = useState(false);
  useEffect(() => {
    let live = true;
    void onCall<ActAs | null>("lyssna_act_as").then((value) => {
      if (live) setActive(value ?? null);
    });
    return () => {
      live = false;
    };
  }, [onCall]);
  // The time left can run out while the window is open; check back now and then.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void onCall<ActAs | null>("lyssna_act_as").then((value) =>
        setActive(value ?? null),
      );
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [active, onCall]);
  useEffect(() => {
    const text = query.trim();
    setNone(false);
    if (!text) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void onCall<Reserved[]>("lyssna_find_reserved", { query: text })
        .then((found) => {
          if (!live) return;
          setMatches(found ?? []);
          setNone((found ?? []).length === 0);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, onCall]);
  const choose = async (who: Reserved) => {
    const chosen = await onCall<ActAs>("lyssna_set_act_as", {
      id: who.id,
      username: who.username,
    });
    if (!chosen) return;
    setActive(chosen);
    setQuery("");
    setMatches([]);
    onNotice(`Uploads now go to ${chosen.username}`);
  };
  const stop = async () => {
    await onCall("lyssna_clear_act_as");
    setActive(null);
    onNotice("Uploads go to your own account again");
  };
  const until = active
    ? new Date(Date.now() + active.seconds_left * 1000).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  return (
    <SettingRow
      label={active ? `Uploading as ${active.username}` : "Upload as another account"}
      help={
        active
          ? `Uploads from this app go to ${active.username} until ${until}, or until you quit the app.`
          : none
            ? "No reserved account matches."
            : "Admins only. Type part of a reserved account's name, or paste its user ID, to upload as it for a while."
      }
      keywords="admin upload as reserved account act as impersonate user uuid"
    >
      {active ? (
        <div className="inline-actions">
          <button className="pill outline" onClick={() => void stop()}>
            Stop uploading as {active.username}
          </button>
        </div>
      ) : (
        <div className="inline-actions">
          <input
            type="text"
            aria-label="Reserved account name or user ID"
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
              disabled={searching}
              onClick={() => void choose(match)}
            >
              {match.username}
            </button>
          ))}
        </div>
      )}
    </SettingRow>
  );
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
    {account?.role === "admin" && (
      <ActAsRow onCall={onCall} onNotice={onNotice} />
    )}
    </>
  );
}
