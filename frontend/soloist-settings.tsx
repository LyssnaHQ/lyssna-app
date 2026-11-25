import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { SettingRow, Toggle } from "./setting-row";
import type { Settings, SoloistStatus } from "./types";
import { IS_MAC } from "./platform";

const DASHBOARD = "https://developer.spotify.com/dashboard/soloist";
export const SOLOIST_DEVICE = "Lyssna Player";

export const SOLOIST_MAC_ONLY =
  "Spotify Soloist only works on Apple Silicon Macs (M1 or newer) running macOS 13 or newer.";

export const SOLOIST_PLAYS =
  "Unavailable while Spotify Soloist plays your music: Soloist uses the system default output and its own playback settings.";

export function soloistMessage(status: SoloistStatus | null | undefined) {
  switch (status?.state) {
    case undefined:
      return "Starting…";
    case "unsupported":
      return IS_MAC
        ? SOLOIST_MAC_ONLY
        : "Spotify Soloist isn't available on this computer.";
    case "needs_key":
      return "Add your Soloist API key to finish setting up.";
    case "installing":
      return "Downloading Spotify Soloist from Spotify…";
    case "starting":
      return "Starting Spotify Soloist…";
    case "needs_pairing":
      return `One last step: on your phone, open the Spotify app on the same Wi-Fi, tap the devices icon and pick “${SOLOIST_DEVICE}”. You only do this once.`;
    case "ready":
      return "Ready. Songs play through Spotify Soloist.";
    case "failed":
      return status.message;
  }
}

export function SoloistRows({
  settings,
  status,
  keysRefused,
  onSettings,
  onCall,
  onOpen,
  onNotice,
}: {
  settings: Settings;
  status: SoloistStatus | null | undefined;
  keysRefused: boolean;
  onSettings: (settings: Partial<Settings>) => void;
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onOpen: (url: string) => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    void onCall<boolean>("soloist_supported").then((value) => {
      if (value === false) setSupported(false);
    });
  }, [onCall]);
  const [saving, setSaving] = useState(false);
  const on = !!settings.soloist;
  const save = async () => {
    setSaving(true);
    try {
      if (await onCall<boolean>("soloist_key", { key: key.trim() })) {
        setKey("");
        onNotice("Soloist API key saved");
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SettingRow
        label="Play through Spotify Soloist"
        help={
          keysRefused && !on ? (
            <span className="soloist-refused">
              Spotify won't unlock songs for this account in Lyssna's own
              player. Turn this on to play through Spotify Soloist instead.
            </span>
          ) : (
            "Spotify's official background player plays your music, for accounts Spotify won't unlock in Lyssna's own player. Needs a free Soloist API key, made with Spotify Premium. Spotify Free accounts play only through Soloist."
          )
        }
        keywords="soloist spotify player refused audio key connect"
        unavailable={
          supported
            ? undefined
            : IS_MAC
              ? SOLOIST_MAC_ONLY
              : "Spotify Soloist isn't available on this computer."
        }
      >
        <Toggle
          label="Play through Spotify Soloist"
          checked={on}
          onChange={(checked) => onSettings({ soloist: checked })}
        />
      </SettingRow>
      {on && supported && (
        <SettingRow
          label="Soloist status"
          help={soloistMessage(status)}
          keywords="soloist status pairing"
        />
      )}
      {on && supported && status?.state !== "unsupported" && (
        <SettingRow
          label="Soloist API key"
          help={`Create one at Spotify for Developers under Soloist, then paste it here. It is kept in ${IS_MAC ? "Lyssna's encrypted credential store" : "Windows Credential Manager"}.`}
          keywords="soloist api key developer dashboard"
          stacked
        >
          <div className="settings-key-form">
            <input
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Soloist API key"
              placeholder={
                status?.state === "needs_key"
                  ? "Paste your API key"
                  : "Saved. Paste a new key to replace it"
              }
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && key.trim()) void save();
              }}
            />
            <div className="inline-actions">
              <button
                className="pill"
                disabled={!key.trim() || saving}
                onClick={() => void save()}
              >
                Save key
              </button>
              <button
                className="pill outline"
                onClick={() => onOpen(DASHBOARD)}
              >
                Get a key <ExternalLink size={13} />
              </button>
            </div>
          </div>
        </SettingRow>
      )}
    </>
  );
}
