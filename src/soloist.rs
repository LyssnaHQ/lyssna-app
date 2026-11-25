//! Spotify Soloist, Spotify's own headless Connect player, plays for accounts
//! whose audio keys Spotify refuses to Lyssna's engine (librespot #1649).
//! Spotify asks that it is not redistributed, so Lyssna fetches the official
//! build from Spotify's CDN on the user's machine, checks that Spotify signed
//! it, and swaps in a fresh build before the 90-day expiry stops it. Spotify
//! builds it for x86_64 Windows and Apple Silicon Macs on macOS 13 or newer.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub const DEVICE_NAME: &str = "Lyssna Player";
#[cfg(not(target_os = "macos"))]
const DOWNLOAD_URL: &str =
    "https://soloist-builds.spotifycdn.com/soloist_release_windows_x86_64.zip";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str = "https://soloist-builds.spotifycdn.com/soloist_release_osx_arm64.tar.gz";
const EXE: &str = if cfg!(windows) {
    "soloist.exe"
} else {
    "soloist"
};
const STAGED: &str = if cfg!(windows) {
    "soloist.next.exe"
} else {
    "soloist.next"
};
const KEY_TARGET: &str = "Lyssna/Soloist";
const KEY_USER: &str = "api-key";
#[cfg(windows)]
const SIGNER: &str = "Spotify AB";
/// The Apple team that signs Spotify's Mac apps, Soloist included.
#[cfg(target_os = "macos")]
const TEAM: &str = "2FNC3A47ZF";
const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
/// Soloist exits with this once its build is older than 90 days.
const EXPIRED: i32 = 10;
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "message", rename_all = "snake_case")]
pub enum Status {
    Unsupported,
    NeedsKey,
    Installing,
    Starting,
    /// Running, but not signed in: pick the device once in a Spotify app.
    NeedsPairing,
    Ready,
    Failed(String),
}

/// Whether Spotify builds Soloist for this computer.
pub fn supported() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| cfg!(windows) || apple_silicon_on_13())
}

/// Lyssna may run under Rosetta, so ask the hardware rather than the build.
#[cfg(target_os = "macos")]
fn apple_silicon_on_13() -> bool {
    let read = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let arm = read("/usr/sbin/sysctl", &["-n", "hw.optional.arm64"]).as_deref() == Some("1");
    let major = read("/usr/bin/sw_vers", &["-productVersion"])
        .and_then(|version| version.split('.').next()?.parse::<u32>().ok());
    arm && major.is_some_and(|major| major >= 13)
}

#[cfg(not(target_os = "macos"))]
fn apple_silicon_on_13() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn key_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new_with_target(
        KEY_TARGET, KEY_TARGET, KEY_USER,
    )?)
}

#[cfg(target_os = "macos")]
fn key_entry() -> Result<crate::credential::Entry> {
    Ok(crate::credential::Entry::new(KEY_TARGET, KEY_USER)?)
}

pub fn api_key() -> Result<Option<String>> {
    match key_entry()?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(Some(key.trim().to_owned())),
        Ok(_) | Err(crate::credential::Error::NoEntry) => Ok(None),
        Err(_) => bail!("Cannot read the Soloist key from the secure credential store"),
    }
}

pub fn valid_key(key: &str) -> bool {
    (16..=256).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

pub fn set_api_key(key: &str) -> Result<()> {
    let key = key.trim();
    ensure!(valid_key(key), "That doesn't look like a Soloist API key");
    ensure!(
        supported(),
        "Spotify Soloist needs Windows, or an Apple Silicon Mac on macOS 13 or newer"
    );
    key_entry()?
        .set_password(key)
        .context("Cannot save the Soloist key to the secure credential store")
}

fn root() -> Result<PathBuf> {
    Ok(crate::config::data_dir()?.join("soloist"))
}

static ACCOUNT: Mutex<Option<String>> = Mutex::new(None);

/// The Spotify account Soloist plays for. Each account keeps its own
/// Soloist sign-in, so switching accounts never undoes another's pairing.
/// True when the account changed.
pub fn set_account(id: &str) -> bool {
    let Ok(mut account) = ACCOUNT.lock() else {
        return false;
    };
    if account.as_deref() == Some(id) {
        return false;
    }
    *account = Some(id.to_owned());
    true
}

fn account() -> Option<String> {
    ACCOUNT.lock().ok().and_then(|account| account.clone())
}

fn account_data(root: &Path, account: Option<&str>) -> PathBuf {
    match account.filter(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) {
        Some(id) => {
            let dir = root.join("accounts").join(id);
            // The single sign-in from before accounts had their own moves to
            // the first account Soloist plays for.
            let shared = root.join("data");
            if !dir.exists() && shared.is_dir() {
                let _ = fs::create_dir_all(root.join("accounts"));
                if let Err(error) = fs::rename(&shared, &dir) {
                    log::warn!("Soloist: cannot move its sign-in to the account folder: {error}");
                }
            }
            dir
        }
        None => root.join("data"),
    }
}

pub fn data_dir() -> Result<PathBuf> {
    Ok(account_data(&root()?, account().as_deref()))
}

#[derive(Default, Serialize, Deserialize)]
struct Release {
    etag: String,
}

fn release_path(bin: &Path) -> PathBuf {
    bin.join("release.json")
}

fn read_release(bin: &Path) -> Release {
    fs::read(release_path(bin))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent(concat!("Lyssna/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()?)
}

/// The `soloist` program in Spotify's Mac archive, a gzipped tar.
fn tar_member(archive: &[u8], wanted: &str) -> Result<Vec<u8>> {
    let mut unpacked = Vec::new();
    flate2::read::GzDecoder::new(archive)
        .take(MAX_ARCHIVE + 1)
        .read_to_end(&mut unpacked)?;
    ensure!(
        unpacked.len() as u64 <= MAX_ARCHIVE,
        "Soloist download is too large"
    );
    let text = |field: &[u8]| {
        let end = field
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(field.len());
        String::from_utf8_lossy(&field[..end]).trim().to_owned()
    };
    let mut offset = 0;
    while offset + 512 <= unpacked.len() {
        let header = &unpacked[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let mut name = text(&header[..100]);
        if &header[257..263] == b"ustar\0" {
            let prefix = text(&header[345..500]);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        let size = usize::from_str_radix(&text(&header[124..136]), 8)
            .context("Soloist download has a damaged entry")?;
        let start = offset + 512;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= unpacked.len())
            .context("Soloist download is cut short")?;
        if matches!(header[156], b'0' | 0) && name.trim_start_matches("./") == wanted {
            return Ok(unpacked[start..end].to_vec());
        }
        offset = start + size.div_ceil(512) * 512;
    }
    bail!("Soloist download has no {wanted}")
}

fn program(archive: Vec<u8>) -> Result<Vec<u8>> {
    if cfg!(target_os = "macos") {
        return tar_member(&archive, EXE);
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))?;
    let mut entry = zip
        .by_name(EXE)
        .with_context(|| format!("Soloist download has no {EXE}"))?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Downloads the current build when it differs from the installed one and
/// stages it. True when a new build is staged.
fn fetch(bin: &Path) -> Result<bool> {
    let client = client()?;
    let head = client
        .head(DOWNLOAD_URL)
        .send()
        .context("Cannot reach Spotify's Soloist downloads")?;
    ensure!(
        head.status().is_success(),
        "Soloist download returned HTTP {}",
        head.status().as_u16()
    );
    let etag = head
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let installed = bin.join(EXE).is_file();
    if installed && !etag.is_empty() && read_release(bin).etag == etag {
        return Ok(false);
    }
    let response = client.get(DOWNLOAD_URL).send()?;
    ensure!(
        response.status().is_success(),
        "Soloist download returned HTTP {}",
        response.status().as_u16()
    );
    let mut archive = Vec::new();
    response.take(MAX_ARCHIVE + 1).read_to_end(&mut archive)?;
    ensure!(
        archive.len() as u64 <= MAX_ARCHIVE,
        "Soloist download is too large"
    );
    let bytes = program(archive)?;
    fs::create_dir_all(bin)?;
    let partial = bin.join("soloist.download");
    let mut file = fs::File::create(&partial)?;
    std::io::Write::write_all(&mut file, &bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o755))?;
    }
    let staged = bin.join(STAGED);
    let result = verify_signature(&partial).and_then(|()| {
        let output = Command::new(&partial)
            .arg("--version")
            .creation_flags_hidden()
            .output()?;
        ensure!(
            output.status.success() && output.stdout.starts_with(b"soloist "),
            "Downloaded Soloist did not start"
        );
        Ok(())
    });
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, &staged)?;
    fs::write(
        bin.join("release.next.json"),
        serde_json::to_vec(&Release { etag })?,
    )?;
    Ok(true)
}

/// Moves a staged build into place; only while Soloist is not running.
fn swap_in(bin: &Path) -> Result<()> {
    let staged = bin.join(STAGED);
    if !staged.is_file() {
        return Ok(());
    }
    fs::rename(&staged, bin.join(EXE))?;
    let _ = fs::rename(bin.join("release.next.json"), release_path(bin));
    Ok(())
}

trait HiddenCommand {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}
impl HiddenCommand for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(windows)]
fn verify_signature(path: &Path) -> Result<()> {
    signature::signer(path).and_then(|signer| {
        ensure!(
            signer == SIGNER,
            "Soloist download is signed by {signer}, not {SIGNER}"
        );
        Ok(())
    })
}

/// Signed with a Developer ID from Spotify's team, as Apple checks it.
#[cfg(target_os = "macos")]
fn verify_signature(path: &Path) -> Result<()> {
    let requirement = format!(
        "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
         and certificate leaf[subject.OU] = \"{TEAM}\""
    );
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "-R", &requirement])
        .arg(path)
        .output()
        .context("Cannot check who signed the Soloist download")?;
    ensure!(
        output.status.success(),
        "Soloist download is not signed by Spotify: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn verify_signature(_: &Path) -> Result<()> {
    bail!("Soloist is not set up on this system")
}

#[cfg(windows)]
mod signature {
    use anyhow::{Result, bail};
    use std::{os::windows::ffi::OsStrExt, path::Path};
    use windows::{
        Win32::{
            Foundation::{HANDLE, HWND},
            Security::{
                Cryptography::{CERT_NAME_SIMPLE_DISPLAY_TYPE, CertGetNameStringW},
                WinTrust::{
                    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
                    WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
                    WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvSignerFromChain,
                    WTHelperProvDataFromStateData, WinVerifyTrust,
                },
            },
        },
        core::PCWSTR,
    };

    /// The display name of the certificate that validly signed `path`.
    pub fn signer(path: &Path) -> Result<String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = unsafe {
            WinVerifyTrust(
                HWND(std::ptr::null_mut()),
                &mut action,
                (&raw mut data).cast(),
            )
        };
        let name = (status == 0).then(|| unsafe { signer_name(data.hWVTStateData) });
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            WinVerifyTrust(
                HWND(std::ptr::null_mut()),
                &mut action,
                (&raw mut data).cast(),
            );
        }
        match name {
            Some(Some(name)) => Ok(name),
            Some(None) => bail!("Cannot read who signed the Soloist download"),
            None => bail!("Soloist download is not validly signed (0x{status:08x})"),
        }
    }

    unsafe fn signer_name(state: HANDLE) -> Option<String> {
        unsafe {
            let provider = WTHelperProvDataFromStateData(state);
            if provider.is_null() {
                return None;
            }
            let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if signer.is_null() || (*signer).csCertChain == 0 {
                return None;
            }
            let certificate = (*(*signer).pasCertChain).pCert;
            let mut name = [0u16; 256];
            let length = CertGetNameStringW(
                certificate,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                0,
                None,
                Some(&mut name),
            );
            (length > 1).then(|| String::from_utf16_lossy(&name[..length as usize - 1]))
        }
    }
}

#[derive(Deserialize)]
struct AuthState {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    logged_in: bool,
}

/// Whether the running Soloist is signed in, asked over its local WebSocket.
fn signed_in(data: &Path) -> Result<bool> {
    let port = fs::read_to_string(data.join("ws.port"))?;
    let port: u16 = port.trim().parse()?;
    let stream = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_secs(2),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    let (mut socket, _) = tungstenite::client(format!("ws://127.0.0.1:{port}"), stream)?;
    for _ in 0..8 {
        if let tungstenite::Message::Text(text) = socket.read()?
            && let Ok(state) = serde_json::from_str::<AuthState>(&text)
            && state.kind == "auth_state"
        {
            let _ = socket.close(None);
            return Ok(state.logged_in);
        }
    }
    bail!("Soloist sent no sign-in state")
}

/// Runs Soloist while Lyssna runs; reports its state and keeps its build fresh.
pub struct Supervisor {
    status: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Supervisor {
    pub fn start() -> Self {
        crate::native::log_librespot();
        let status = Arc::new(Mutex::new(Status::Starting));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = supported().then(|| {
            let status = status.clone();
            let stop = stop.clone();
            thread::Builder::new()
                .name("soloist".into())
                .spawn(move || supervise(&status, &stop))
                .expect("spawn Soloist supervisor")
        });
        if thread.is_none() {
            *status.lock().unwrap() = Status::Unsupported;
        }
        Self {
            status,
            stop,
            thread,
        }
    }

    pub fn status(&self) -> Status {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| Status::Failed("Soloist state unavailable".into()))
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn set(status: &Mutex<Status>, next: Status) {
    if let Ok(mut current) = status.lock()
        && *current != next
    {
        log::info!("Soloist: {next:?}");
        *current = next;
    }
}

fn wait(stop: &AtomicBool, duration: Duration) -> bool {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        thread::sleep(Duration::from_millis(200));
    }
    !stop.load(Ordering::Acquire)
}

/// A Soloist left behind when Lyssna was killed holds the data folder, and
/// a new one exits at once. Windows closes it with Lyssna's job instead.
#[cfg(target_os = "macos")]
fn stop_stale(exe: &Path, data: &Path) {
    let Some(pid) = fs::read_to_string(data.join("soloist.pid"))
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1)
    else {
        return;
    };
    let Ok(output) = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    else {
        return;
    };
    if Path::new(String::from_utf8_lossy(&output.stdout).trim()) == exe {
        log::info!("Soloist: stopping one left running");
        unsafe { libc::kill(pid, libc::SIGTERM) };
        thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(not(target_os = "macos"))]
fn stop_stale(_: &Path, _: &Path) {}

fn spawn(exe: &Path, data: &Path, cache: &Path, key: &str) -> Result<Child> {
    stop_stale(exe, data);
    let _ = fs::remove_file(data.join("ws.port"));
    let child = Command::new(exe)
        .args([
            "--device-name",
            DEVICE_NAME,
            "--api-key",
            key,
            "--ws",
            "127.0.0.1:0",
        ])
        .arg("--data-dir")
        .arg(data)
        .arg("--cache-dir")
        .arg(cache)
        .args(["--cache-size", "500"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags_hidden()
        .spawn()
        .context("Cannot start Soloist")?;
    Ok(child)
}

const NORMALIZE: &str = "audio.normalize_v2";
const CROSSFADE: &str = "audio.crossfade_v2";
const CROSSFADE_MS: &str = "audio.crossfade.time_v2";
// Spotify moved crossfade out of prefs and ignores the key once migrated;
// clearing the flag makes it migrate the "off" value in again on start.
const CROSSFADE_MIGRATED: &str = "audio.crossfade_migrated_to_ps";
const PLAY_BITRATE: &str = "audio.play_bitrate_enumeration";
const PLAY_BITRATE_UNMETERED: &str = "audio.play_bitrate_non_metered_enumeration";
const SEEDED_MARKER: &str = ".soloist-prefs-seeded";

static QUALITY: AtomicU8 = AtomicU8::new(4);

/// Lyssna's streaming quality as Spotify's prefs level, applied when Soloist
/// next starts.
pub fn set_quality(level: u8) {
    if QUALITY.swap(level, Ordering::AcqRel) != level {
        PREFS_CHANGED.store(true, Ordering::Release);
    }
}

static CROSSFADE_SECONDS: AtomicU8 = AtomicU8::new(0);

/// Lyssna's Crossfade songs setting, applied when Soloist next starts.
pub fn set_crossfade(seconds: u8) {
    if CROSSFADE_SECONDS.swap(seconds, Ordering::AcqRel) != seconds {
        PREFS_CHANGED.store(true, Ordering::Release);
    }
}

pub fn crossfades() -> bool {
    CROSSFADE_SECONDS.load(Ordering::Acquire) > 0
}

static PREFS_CHANGED: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);

/// Soloist reads its prefs only at start, so a changed setting restarts it
/// once nothing is playing; Play then resumes the last song.
pub fn set_playing(playing: bool) {
    PLAYING.store(playing, Ordering::Release);
}

/// Updates `existing` prefs with volume normalization off and crossfade
/// from Lyssna's setting (0 seconds is off), preserving every other key.
pub fn merge_prefs(existing: &str) -> String {
    merge_prefs_with(
        existing,
        CROSSFADE_SECONDS.load(Ordering::Acquire),
        QUALITY.load(Ordering::Acquire),
    )
}

fn merge_prefs_with(existing: &str, crossfade: u8, quality: u8) -> String {
    let on = if crossfade > 0 { "true" } else { "false" };
    let length = (u32::from(crossfade.max(1)) * 1000).to_string();
    let quality = quality.to_string();
    let wanted = [
        (NORMALIZE, "false"),
        (CROSSFADE, on),
        (CROSSFADE_MS, length.as_str()),
        (CROSSFADE_MIGRATED, "false"),
        (PLAY_BITRATE, quality.as_str()),
        (PLAY_BITRATE_UNMETERED, quality.as_str()),
    ];
    let mut lines: Vec<String> = existing
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let key = line.split('=').next().unwrap_or_default();
            !wanted.iter().any(|(wanted, _)| *wanted == key)
        })
        .map(str::to_string)
        .collect();
    lines.extend(wanted.iter().map(|(key, value)| format!("{key}={value}")));
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn users_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("settings").join("Users")
}

pub fn user_dirs(data_dir: &Path) -> BTreeSet<String> {
    let Ok(entries) = fs::read_dir(users_dir(data_dir)) else {
        return BTreeSet::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("prefs").is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

pub fn write_normalization(data_dir: &Path) -> std::io::Result<usize> {
    let mut written = 0;
    for user in user_dirs(data_dir) {
        let path = users_dir(data_dir).join(user).join("prefs");
        let existing = fs::read_to_string(&path)?;
        let merged = merge_prefs(&existing);
        if merged != existing {
            fs::write(&path, merged.as_bytes())?;
            written += 1;
        }
    }
    Ok(written)
}

pub fn seeded(data_dir: &Path) -> BTreeSet<String> {
    fs::read_to_string(data_dir.join(SEEDED_MARKER))
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn mark_seeded(data_dir: &Path, users: &BTreeSet<String>) -> std::io::Result<()> {
    let text: String = users.iter().map(|user| format!("{user}\n")).collect();
    fs::write(data_dir.join(SEEDED_MARKER), text)
}

fn supervise(status: &Mutex<Status>, stop: &AtomicBool) {
    let Ok(root) = root() else {
        set(
            status,
            Status::Failed("Cannot find Lyssna's data folder".into()),
        );
        return;
    };
    let (bin, data, cache) = (
        root.join("bin"),
        account_data(&root, account().as_deref()),
        root.join("cache"),
    );
    let job = job::Job::new().ok();
    let mut checked: Option<Instant> = None;
    let mut failures = 0u32;
    while !stop.load(Ordering::Acquire) {
        let key = match api_key() {
            Ok(Some(key)) => key,
            Ok(None) => {
                set(status, Status::NeedsKey);
                if !wait(stop, Duration::from_secs(2)) {
                    return;
                }
                continue;
            }
            Err(error) => {
                set(status, Status::Failed(error.to_string()));
                if !wait(stop, Duration::from_secs(10)) {
                    return;
                }
                continue;
            }
        };
        let exe = bin.join(EXE);
        if !exe.is_file() || checked.is_none_or(|at| at.elapsed() >= UPDATE_EVERY) {
            if !exe.is_file() {
                set(status, Status::Installing);
            }
            match fetch(&bin) {
                Ok(_) => checked = Some(Instant::now()),
                Err(error) if !exe.is_file() => {
                    set(
                        status,
                        Status::Failed(format!("Cannot install Soloist: {error:#}")),
                    );
                    if !wait(stop, Duration::from_secs(60)) {
                        return;
                    }
                    continue;
                }
                Err(error) => log::warn!("Soloist update check failed: {error:#}"),
            }
            if let Err(error) = swap_in(&bin) {
                log::warn!("Cannot install the new Soloist build: {error:#}");
            }
        }
        let _ = fs::create_dir_all(&data);
        match write_normalization(&data) {
            Ok(count) if count > 0 => {
                log::info!(
                    "Soloist: turned off volume normalization and crossfade in {count} account prefs"
                )
            }
            Ok(_) => {}
            Err(error) => log::warn!("Soloist: could not write normalization prefs: {error}"),
        }
        let users_before = user_dirs(&data);
        let _ = mark_seeded(&data, &users_before);

        set(status, Status::Starting);
        let mut child = match spawn(&exe, &data, &cache, &key) {
            Ok(child) => child,
            Err(error) => {
                set(status, Status::Failed(format!("{error:#}")));
                if !wait(stop, Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };
        if let Some(job) = &job {
            job.assign(&child);
        }
        let started = Instant::now();
        let mut seed_restart = false;
        PREFS_CHANGED.store(false, Ordering::Release);
        let code = loop {
            if stop.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            if let Ok(Some(exit)) = child.try_wait() {
                break exit.code();
            }
            match signed_in(&data) {
                Ok(true) => {
                    failures = 0;
                    set(status, Status::Ready);
                    let present = user_dirs(&data);
                    let seeded_users = seeded(&data);
                    if present.difference(&seeded_users).next().is_some() {
                        let _ = write_normalization(&data);
                        let _ = mark_seeded(&data, &present);
                        log::info!(
                            "Soloist: new login detected; restarting Soloist once to disable normalization"
                        );
                        seed_restart = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                }
                Ok(false) => set(status, Status::NeedsPairing),
                Err(_) => {}
            }
            if !PLAYING.load(Ordering::Acquire) && PREFS_CHANGED.swap(false, Ordering::AcqRel) {
                log::info!("Soloist: restarting to apply crossfade");
                seed_restart = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            // A newer build waits in staging; Soloist swaps it in next start.
            if checked.is_some_and(|at| at.elapsed() >= UPDATE_EVERY) {
                checked = Some(Instant::now());
                if let Err(error) = fetch(&bin) {
                    log::warn!("Soloist update check failed: {error:#}");
                }
            }
            if !wait(stop, Duration::from_secs(3)) {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        };
        if seed_restart {
            continue;
        }
        if code == Some(EXPIRED) {
            log::info!("Soloist build expired; fetching the current one");
            checked = None;
            let _ = fs::remove_file(release_path(&bin));
            continue;
        }
        failures += 1;
        let message = format!(
            "Soloist stopped (exit {})",
            code.map_or("unknown".into(), |code| code.to_string())
        );
        set(status, Status::Failed(message));
        let backoff = if started.elapsed() > Duration::from_secs(60) {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(5 * u64::from(failures.min(12)))
        };
        if !wait(stop, backoff) {
            return;
        }
    }
}

#[cfg(windows)]
mod job {
    use anyhow::Result;
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
        },
        core::PCWSTR,
    };

    /// Closes Soloist with Lyssna, even when Lyssna is killed.
    pub struct Job(HANDLE);

    impl Job {
        pub fn new() -> Result<Self> {
            let job = unsafe { CreateJobObjectW(None, PCWSTR::null())? };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )?;
            }
            Ok(Self(job))
        }

        pub fn assign(&self, child: &std::process::Child) {
            let process = HANDLE(child.as_raw_handle());
            if let Err(error) = unsafe { AssignProcessToJobObject(self.0, process) } {
                log::warn!("Soloist runs outside its job: {error}");
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub struct Job;
    impl Job {
        pub fn new() -> anyhow::Result<Self> {
            Ok(Self)
        }
        pub fn assign(&self, _: &std::process::Child) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_plain_tokens() {
        assert!(valid_key("abcdefghijklmnop-1234_5678.90"));
        assert!(!valid_key("short"));
        assert!(!valid_key("has spaces in the key value"));
    }

    #[test]
    fn staged_builds_replace_the_installed_one() {
        let dir = std::env::temp_dir().join(format!("lyssna-soloist-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("soloist.exe"), b"old").unwrap();
        fs::write(dir.join("soloist.next.exe"), b"new").unwrap();
        fs::write(dir.join("release.next.json"), br#"{"etag":"\"b\""}"#).unwrap();
        swap_in(&dir).unwrap();
        assert_eq!(fs::read(dir.join("soloist.exe")).unwrap(), b"new");
        assert!(!dir.join("soloist.next.exe").exists());
        assert_eq!(read_release(&dir).etag, "\"b\"");
        swap_in(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    fn tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        let size = format!("{:011o}\0", body.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        let mut entry = header.to_vec();
        entry.extend_from_slice(body);
        entry.resize(512 + body.len().div_ceil(512) * 512, 0);
        entry
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn mac_archives_yield_the_soloist_program() {
        let mut tar = tar_entry("CHANGELOG.md", &[b'x'; 700]);
        tar.extend(tar_entry("soloist", b"program"));
        tar.extend([0u8; 1024]);
        assert_eq!(tar_member(&gzip(&tar), "soloist").unwrap(), b"program");
        assert!(tar_member(&gzip(&tar), "missing").is_err());
        let mut cut = tar_entry("soloist", &[b'y'; 600]);
        cut.truncate(700);
        assert!(tar_member(&gzip(&cut), "soloist").is_err());
    }

    #[test]
    #[ignore = "needs Spotify's Mac archive in LYSSNA_SOLOIST_MAC_ARCHIVE"]
    fn spotifys_mac_archive_has_the_program() {
        let path = std::env::var("LYSSNA_SOLOIST_MAC_ARCHIVE").unwrap();
        let program = tar_member(&fs::read(path).unwrap(), "soloist").unwrap();
        assert_eq!(&program[..4], &[0xcf, 0xfa, 0xed, 0xfe]);
    }

    #[test]
    fn merge_prefs_sets_normalization_off() {
        let sample =
            "audio.play_bitrate_non_metered_migrated=true\naudio.crossfade_migrated_to_ps=true\n";
        let merged = merge_prefs(sample);
        assert!(merged.contains("audio.normalize_v2=false\n"));
        assert!(merged.contains("audio.play_bitrate_non_metered_migrated=true\n"));
        assert_eq!(merged.matches("audio.normalize_v2=false").count(), 1);
    }

    #[test]
    fn merge_prefs_turns_crossfade_off() {
        let sample = "audio.crossfade_v2=true\naudio.crossfade_migrated_to_ps=true\n";
        let merged = merge_prefs_with(sample, 0, 4);
        assert!(merged.contains("audio.crossfade_v2=false\n"));
        assert!(merged.contains("audio.crossfade_migrated_to_ps=false\n"));
        assert!(!merged.contains("=true"));
        let on = merge_prefs_with(&merged, 6, 4);
        assert!(on.contains("audio.crossfade_v2=true\n"));
        assert!(on.contains("audio.crossfade.time_v2=6000\n"));
    }

    #[test]
    fn merge_prefs_sets_streaming_quality() {
        let sample = "audio.play_bitrate_enumeration=1\n";
        let merged = merge_prefs_with(sample, 0, 3);
        assert!(merged.contains("audio.play_bitrate_enumeration=3\n"));
        assert!(merged.contains("audio.play_bitrate_non_metered_enumeration=3\n"));
        assert_eq!(merged.matches("audio.play_bitrate_enumeration=").count(), 1);
    }

    #[test]
    fn merge_prefs_replaces_existing_normalization_flag() {
        let sample = "audio.normalize_v2=true\naudio.gapless=true\n";
        let merged = merge_prefs(sample);
        assert!(!merged.contains("audio.normalize_v2=true"));
        assert!(merged.contains("audio.normalize_v2=false\n"));
        assert!(merged.contains("audio.gapless=true\n"));
    }

    #[test]
    fn merge_prefs_is_idempotent() {
        let sample = "audio.play_bitrate_non_metered_migrated=true\n";
        let once = merge_prefs(sample);
        assert_eq!(merge_prefs(&once), once);
    }

    #[test]
    fn merge_prefs_handles_crlf() {
        let sample = "a=1\r\nb=2\r\n";
        let merged = merge_prefs(sample);
        assert!(!merged.contains('\r'));
        assert!(merged.contains("audio.normalize_v2=false\n"));
    }

    #[test]
    fn each_account_keeps_its_own_soloist_sign_in() {
        let root =
            std::env::temp_dir().join(format!("lyssna-soloist-accounts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data").join("session"), "first").unwrap();

        let first = account_data(&root, Some("first"));
        assert_eq!(first, root.join("accounts").join("first"));
        assert_eq!(fs::read_to_string(first.join("session")).unwrap(), "first");
        assert!(!root.join("data").exists());

        let second = account_data(&root, Some("second"));
        assert_eq!(second, root.join("accounts").join("second"));
        assert!(!second.exists());
        assert_eq!(account_data(&root, Some("../up")), root.join("data"));
        assert_eq!(account_data(&root, None), root.join("data"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_normalization_updates_account_prefs() {
        let root = std::env::temp_dir().join(format!("lyssna-prefs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.as_path();
        let user_prefs = dir
            .join("settings")
            .join("Users")
            .join("test_user")
            .join("prefs");
        fs::create_dir_all(user_prefs.parent().unwrap()).unwrap();
        fs::write(&user_prefs, "audio.normalize_v2=true\n").unwrap();

        assert_eq!(write_normalization(dir).unwrap(), 1);
        assert_eq!(write_normalization(dir).unwrap(), 0);

        let content = fs::read_to_string(&user_prefs).unwrap();
        assert!(content.contains("audio.normalize_v2=false\n"));

        let users = user_dirs(dir);
        assert_eq!(users, ["test_user".to_string()].into());
        mark_seeded(dir, &users).unwrap();
        assert_eq!(seeded(dir), users);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a Spotify-signed soloist.exe in LYSSNA_SOLOIST_EXE"]
    fn spotify_signed_builds_pass() {
        let path = std::env::var("LYSSNA_SOLOIST_EXE").unwrap();
        verify_signature(Path::new(&path)).unwrap();
        assert!(verify_signature(&std::env::current_exe().unwrap()).is_err());
    }
}
