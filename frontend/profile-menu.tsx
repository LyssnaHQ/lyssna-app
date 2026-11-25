import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import type { Profile } from "./types";

export type ProfileAction =
  "account" | "profile" | "recents" | "settings" | "sign-out";

/** Avatar button with Spotify's account dropdown. */
export function ProfileMenu({
  name,
  image,
  hidden = [],
  current,
  loadAccounts,
  onSwitch,
  onAddAccount,
  onRemoveAccount,
  onAction,
}: {
  name: string;
  image?: string;
  /** Items removed through Spotify+; Settings always stays. */
  hidden?: ProfileAction[];
  /** The signed-in account's ID. */
  current?: string;
  /** Accounts signed in on this computer. */
  loadAccounts: () => Promise<Profile[]>;
  onSwitch: (id: string) => void;
  onAddAccount: () => void;
  onRemoveAccount: (id: string) => Promise<void>;
  onAction: (action: ProfileAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Profile[]>([]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadAccounts()
      .then((list) => live && setAccounts(list ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, loadAccounts]);
  const others = accounts.filter((account) => account.id !== current);
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
  const item = (action: ProfileAction, label: ReactNode, end?: ReactNode) =>
    !hidden.includes(action) && (
    <button
      role="menuitem"
      onClick={() => {
        setOpen(false);
        onAction(action);
      }}
    >
      <span>{label}</span>
      {end}
    </button>
    );
  return (
    <div className="profile-menu-root" ref={root}>
      <button
        className={`avatar ${open ? "open" : ""}`}
        title={name}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {image ? (
          <img src={image} alt="Your Spotify profile" />
        ) : (
          name.slice(0, 1).toUpperCase()
        )}
      </button>
      {open && (
        <div className="profile-menu" role="menu" aria-label="Account">
          {others.map((account) => {
            const label = account.display_name || account.id;
            const picture = account.images?.at(-1)?.url;
            return (
              <div className="profile-account" key={account.id}>
                <button
                  role="menuitem"
                  title={`Switch to ${label}`}
                  onClick={() => {
                    setOpen(false);
                    onSwitch(account.id);
                  }}
                >
                  <span className="profile-account-avatar" aria-hidden="true">
                    {picture ? (
                      <img src={picture} alt="" />
                    ) : (
                      label.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="profile-account-name">{label}</span>
                </button>
                <button
                  className="profile-account-remove"
                  title={`Remove ${label} from Lyssna`}
                  aria-label={`Remove ${label} from Lyssna`}
                  onClick={() =>
                    void onRemoveAccount(account.id).then(
                      () =>
                        setAccounts((list) =>
                          list.filter((entry) => entry.id !== account.id),
                        ),
                      () => {},
                    )
                  }
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddAccount();
            }}
          >
            <span>Add account</span>
            <Plus size={17} />
          </button>
          <hr />
          {item("account", "Account", <ExternalLink size={17} />)}
          {item("profile", "Profile")}
          {item("recents", "Recents")}
          {item("settings", "Settings")}
          {!hidden.includes("sign-out") && <hr />}
          {item("sign-out", "Log out")}
        </div>
      )}
    </div>
  );
}
