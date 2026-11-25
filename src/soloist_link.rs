//! Live connection to Spotify Soloist's local WebSocket: commands reach it
//! without a round trip through Spotify, and its state arrives as it changes.
use crate::api::PlayerAction;
use crate::model::{Album, Artist, Artwork, Track};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    net::TcpStream,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};

#[derive(Clone, Default)]
pub struct State {
    pub active: bool,
    pub playing: bool,
    pub track: Option<Track>,
    pub position_ms: u64,
    /// Unix time in milliseconds when `position_ms` was measured.
    pub measured_at: i64,
    pub context: Option<String>,
    pub shuffle: bool,
    pub repeat: String,
    pub volume: Option<u8>,
}

/// Soloist's upcoming songs and how many of them were queued by hand,
/// while Soloist is the active device.
static QUEUE: Mutex<Option<(Vec<Track>, usize)>> = Mutex::new(None);

pub fn queue() -> Option<(Vec<Track>, usize)> {
    QUEUE.lock().ok().and_then(|queue| queue.clone())
}

/// Songs looked up for the queue; Soloist names only the first few
/// upcoming songs fully.
static DESCRIBED: Mutex<BTreeMap<String, Track>> = Mutex::new(BTreeMap::new());

/// Fills in queue songs Soloist sent without a name, artists or artwork.
/// True when any changed.
pub fn describe(tracks: &mut [Track], lookup: impl Fn(&str) -> Option<Track> + Sync) -> bool {
    let missing: Vec<String> = {
        let described = DESCRIBED.lock().ok();
        let mut missing: Vec<String> = tracks
            .iter()
            .filter(|track| incomplete(track))
            .filter(|track| {
                !described
                    .as_ref()
                    .is_some_and(|described| described.contains_key(&track.uri))
            })
            .map(|track| track.uri.clone())
            .collect();
        missing.dedup();
        missing
    };
    // One at a time, a full queue took about 20 seconds to fill in.
    let found: Vec<Track> = thread::scope(|scope| {
        let lookup = &lookup;
        missing
            .chunks(missing.len().div_ceil(LOOKUPS).max(1))
            .map(|uris| {
                scope.spawn(move || {
                    uris.iter()
                        .filter_map(|uri| lookup(uri).map(|track| (uri, track)))
                        .map(|(uri, mut track)| {
                            track.uri.clone_from(uri);
                            track
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });
    let Ok(mut described) = DESCRIBED.lock() else {
        return false;
    };
    if described.len() + found.len() > 500 {
        described.clear();
    }
    for track in found {
        described.insert(track.uri.clone(), track);
    }
    let mut changed = false;
    for track in tracks.iter_mut().filter(|track| incomplete(track)) {
        if let Some(full) = described.get(&track.uri) {
            fill(track, full.clone());
            changed = true;
        }
    }
    changed
}

const LOOKUPS: usize = 8;

fn incomplete(track: &Track) -> bool {
    track.name.is_empty() || track.artists.is_empty() || track.album.images.is_empty()
}

fn fill(track: &mut Track, full: Track) {
    if track.name.is_empty() {
        track.name = full.name;
    }
    if track.artists.is_empty() {
        track.artists = full.artists;
    }
    if track.album.images.is_empty() {
        track.album.images = full.album.images;
    }
    if track.album.uri.is_empty() {
        track.album.uri = full.album.uri;
        track.album.id = full.album.id;
        track.album.name = full.album.name;
    }
    if track.duration_ms == 0 {
        track.duration_ms = full.duration_ms;
    }
}

fn set_queue(queue: Option<(Vec<Track>, usize)>) {
    if let Ok(mut current) = QUEUE.lock() {
        *current = queue;
    }
}

pub struct Link {
    commands: mpsc::Sender<Value>,
    live: Arc<AtomicBool>,
    /// Soloist is the account's active device.
    active: Arc<AtomicBool>,
    /// Soloist has a song loaded that Play can resume.
    loaded: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Link {
    pub fn start(
        data: PathBuf,
        mut on_state: impl FnMut(State) + Send + 'static,
        mut on_queue: impl FnMut() + Send + 'static,
    ) -> Self {
        let (commands, receive) = mpsc::channel();
        let live = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicBool::new(false));
        let loaded = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_live, thread_stop) = (live.clone(), stop.clone());
        let flags = Flags {
            active: active.clone(),
            loaded: loaded.clone(),
        };
        let _ = thread::Builder::new()
            .name("soloist-link".into())
            .spawn(move || {
                while !thread_stop.load(Ordering::Acquire) {
                    if let Ok(mut socket) = open(&data) {
                        thread_live.store(true, Ordering::Release);
                        run(
                            &mut socket,
                            &receive,
                            &thread_stop,
                            &flags,
                            &mut on_state,
                            &mut on_queue,
                        );
                        thread_live.store(false, Ordering::Release);
                        flags.set(false, false);
                        set_queue(None);
                        on_state(State::default());
                        on_queue();
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
        Self {
            commands,
            live,
            active,
            loaded,
            stop,
        }
    }

    pub fn live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    pub fn active(&self) -> bool {
        self.live() && self.active.load(Ordering::Acquire)
    }

    pub fn loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }

    /// Starts a song in Soloist at a position, for when it has none loaded.
    pub fn play_from(&self, uri: &str, position_ms: u64) -> bool {
        if !self.live() || !uri.starts_with("spotify:track:") {
            return false;
        }
        let mut sent = vec![command("play", json!({"uri": uri}))];
        if position_ms > 0 {
            sent.push(command("seek", json!({"position_ms": position_ms})));
        }
        sent.into_iter()
            .all(|command| self.commands.send(command).is_ok())
    }

    /// Starts what `action` picks, for a Spotify Free account, which has no
    /// Connect device of its own to send it through. Soloist plays one URI:
    /// a playlist or album starts from its top and skips forward to the
    /// chosen song once Soloist lists it; other lists play their chosen song
    /// with the rest queued after it.
    pub fn start_free(&self, action: &PlayerAction) -> bool {
        let Some(start) = FreeStart::from(action) else {
            return false;
        };
        if !self.live() {
            return false;
        }
        let before = queued_uris();
        if self
            .commands
            .send(command("play", json!({"uri": start.uri})))
            .is_err()
        {
            return false;
        }
        let commands = self.commands.clone();
        thread::spawn(move || start.finish(&commands, before));
        true
    }

    /// Makes Soloist the account's active device.
    pub fn activate(&self) -> bool {
        self.live() && self.commands.send(command("activate", json!({}))).is_ok()
    }

    /// Picks up where the account last stopped, as Spotify's own apps do
    /// when they become the active device; plays `uri` from `position_ms`
    /// when Spotify has nothing to hand over.
    pub fn resume(&self, uri: &str, position_ms: u64) -> bool {
        if !self.activate() {
            return false;
        }
        let (commands, live, active, loaded) = (
            self.commands.clone(),
            self.live.clone(),
            self.active.clone(),
            self.loaded.clone(),
        );
        let uri = uri.to_owned();
        thread::spawn(move || {
            let waited = Instant::now();
            while waited.elapsed() < Duration::from_millis(2500) {
                if live.load(Ordering::Acquire)
                    && active.load(Ordering::Acquire)
                    && loaded.load(Ordering::Acquire)
                {
                    let _ = commands.send(command("play", json!({})));
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if uri.starts_with("spotify:track:") {
                let _ = commands.send(command("play", json!({"uri": uri})));
                if position_ms > 0 {
                    let _ = commands.send(command("seek", json!({"position_ms": position_ms})));
                }
            }
        });
        true
    }

    /// Gives up Soloist's place as the account's active device.
    pub fn deactivate(&self) -> bool {
        self.live() && self.commands.send(command("deactivate", json!({}))).is_ok()
    }

    /// Sends the action straight to Soloist; false when it needs Connect.
    pub fn send(&self, action: &PlayerAction) -> bool {
        let commands = commands(action);
        if commands.is_empty() || !self.live() {
            return false;
        }
        commands
            .into_iter()
            .all(|command| self.commands.send(command).is_ok())
    }
}

struct Flags {
    active: Arc<AtomicBool>,
    loaded: Arc<AtomicBool>,
}

impl Flags {
    fn set(&self, active: bool, loaded: bool) {
        self.active.store(active, Ordering::Release);
        self.loaded.store(loaded, Ordering::Release);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn open(data: &std::path::Path) -> anyhow::Result<WebSocket<TcpStream>> {
    let port: u16 = fs::read_to_string(data.join("ws.port"))?.trim().parse()?;
    let stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))?;
    let (socket, _) = tungstenite::client(format!("ws://127.0.0.1:{port}"), stream)?;
    // Short reads let queued commands go out between Soloist's messages.
    socket
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(20)))?;
    Ok(socket)
}

fn run(
    socket: &mut WebSocket<TcpStream>,
    commands: &mpsc::Receiver<Value>,
    stop: &AtomicBool,
    flags: &Flags,
    on_state: &mut impl FnMut(State),
    on_queue: &mut impl FnMut(),
) {
    let ask_queue = command("get_queue", json!({"limit": QUEUE_LENGTH}));
    if socket.send(Message::text(ask_queue.to_string())).is_err() {
        return;
    }
    let mut playing: Option<String> = None;
    while !stop.load(Ordering::Acquire) {
        while let Ok(command) = commands.try_recv() {
            if socket.send(Message::text(command.to_string())).is_err() {
                return;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(message) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match message["type"].as_str() {
                    Some("auth_state") => {
                        let active = message["is_active"].as_bool().unwrap_or(false);
                        flags.active.store(active, Ordering::Release);
                        if !active {
                            flags.loaded.store(false, Ordering::Release);
                            set_queue(None);
                            on_state(State::default());
                            on_queue();
                        }
                    }
                    Some("playback_state") => {
                        if let Ok(playback) = serde_json::from_value::<Playback>(message) {
                            log_state(&playback);
                            let state = playback.state();
                            flags.set(state.active, state.track.is_some());
                            let uri = state.track.as_ref().map(|track| track.uri.clone());
                            if uri != playing {
                                playing = uri;
                                if socket.send(Message::text(ask_queue.to_string())).is_err() {
                                    return;
                                }
                            }
                            on_state(state);
                        }
                    }
                    Some("queue_changed") => {
                        if let Ok(reply) = serde_json::from_value::<QueueReply>(message) {
                            set_queue(
                                flags
                                    .active
                                    .load(Ordering::Acquire)
                                    .then(|| reply.upcoming()),
                            );
                            on_queue();
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
    let _ = socket.close(None);
}

const QUEUE_LENGTH: usize = 50;

#[derive(Deserialize)]
struct QueueReply {
    #[serde(default)]
    upcoming: Vec<QueueEntry>,
}

#[derive(Deserialize)]
struct QueueEntry {
    #[serde(default)]
    source: String,
    item: Option<Item>,
}

impl QueueReply {
    fn upcoming(self) -> (Vec<Track>, usize) {
        let queued = self
            .upcoming
            .iter()
            .take_while(|entry| entry.source == "queue")
            .count();
        let tracks = self
            .upcoming
            .into_iter()
            .filter_map(|entry| entry.item.and_then(track))
            .collect();
        (tracks, queued)
    }
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// Measured from a screen recording: when a song ends on its own, Soloist
/// cuts it about three seconds short, reports the next song as playing, and
/// that song's audio starts a second later. A picked song has no such gap.
const HANDOVER_DELAY_MS: i64 = 1_000;

/// How long the next song's audio trails its first reports after a song
/// ended on its own. Needs the ended song's length, which Soloist's
/// reports can lack.
pub fn handover_lag(previous: &State, next: &State) -> Option<i64> {
    let ended = previous.track.as_ref()?;
    let starting = next.track.as_ref()?;
    if !previous.playing
        || ended.uri == starting.uri
        || next.position_ms > 1000
        || ended.duration_ms == 0
    {
        return None;
    }
    let heard = previous.position_ms as i64 + (next.measured_at - previous.measured_at).max(0);
    let left = ended.duration_ms as i64 - heard;
    (left > 0 && left <= 5000).then_some(HANDOVER_DELAY_MS)
}

/// One line per report, to line Soloist's timing up with what was heard.
fn log_state(playback: &Playback) {
    let now = unix_ms();
    let song = playback
        .item
        .as_ref()
        .and_then(|item| item.uri.rsplit(':').next())
        .unwrap_or("-");
    crate::native::diagnostic(&format!(
        "soloist state {} {song} at {} ms, stamped {} ms ago",
        playback.status,
        playback.position.position_ms,
        now - playback.position.timestamp_ms
    ));
}

fn command(name: &str, fields: Value) -> Value {
    let mut command = json!({"type": "command", "command": name});
    if let (Some(command), Value::Object(fields)) = (command.as_object_mut(), fields) {
        command.extend(fields);
    }
    command
}

fn commands(action: &PlayerAction) -> Vec<Value> {
    match action {
        PlayerAction::Play(None) => vec![command("play", json!({}))],
        PlayerAction::Pause => vec![command("pause", json!({}))],
        PlayerAction::Next => vec![command("skip_next", json!({}))],
        PlayerAction::Previous => vec![command("skip_prev", json!({}))],
        PlayerAction::Seek(position) => vec![command("seek", json!({"position_ms": position}))],
        PlayerAction::Volume(volume) => {
            vec![command("set_volume", json!({"volume": (*volume).min(100)}))]
        }
        PlayerAction::Shuffle(enabled) => {
            vec![command("set_shuffle", json!({"enabled": enabled}))]
        }
        PlayerAction::Repeat(mode) => match mode.as_str() {
            "track" => vec![command("set_repeat_track", json!({"enabled": true}))],
            "context" => vec![
                command("set_repeat_track", json!({"enabled": false})),
                command("set_repeat_context", json!({"enabled": true})),
            ],
            _ => vec![
                command("set_repeat_track", json!({"enabled": false})),
                command("set_repeat_context", json!({"enabled": false})),
            ],
        },
        PlayerAction::Enqueue(uri) if uri.starts_with("spotify:track:") => {
            vec![command("add_to_queue", json!({"uri": uri}))]
        }
        PlayerAction::SkipTo(uri) => {
            skips_to(uri, &queue().map(|(tracks, _)| tracks).unwrap_or_default())
        }
        _ => Vec::new(),
    }
}

/// How a Spotify Free account starts a pick in Soloist.
#[derive(Debug, PartialEq)]
struct FreeStart {
    /// What Soloist plays: a song, playlist or album.
    uri: String,
    /// The song to skip forward to after a playlist or album starts.
    skip_to: Option<String>,
    /// Songs to queue after it.
    queue: Vec<String>,
    position_ms: u64,
}

impl FreeStart {
    fn from(action: &PlayerAction) -> Option<Self> {
        let playable = |uri: &str| {
            [
                "spotify:track:",
                "spotify:album:",
                "spotify:playlist:",
                "spotify:episode:",
            ]
            .iter()
            .any(|prefix| uri.starts_with(prefix))
        };
        let list = |uris: &[String], offset: usize, context: Option<&String>, position_ms| {
            let chosen = uris.get(offset)?.clone();
            if let Some(context) = context.filter(|context| playable(context)) {
                return Some(Self {
                    uri: context.clone(),
                    skip_to: Some(chosen),
                    queue: Vec::new(),
                    position_ms,
                });
            }
            Some(Self {
                queue: uris[offset + 1..]
                    .iter()
                    .filter(|uri| uri.starts_with("spotify:track:"))
                    .take(QUEUE_LENGTH)
                    .cloned()
                    .collect(),
                uri: chosen,
                skip_to: None,
                position_ms,
            })
        };
        let start = match action {
            PlayerAction::Play(Some(uri)) => Self {
                uri: uri.clone(),
                skip_to: None,
                queue: Vec::new(),
                position_ms: 0,
            },
            PlayerAction::PlayContext { context, offset } => Self {
                uri: context.clone(),
                skip_to: offset.clone(),
                queue: Vec::new(),
                position_ms: 0,
            },
            PlayerAction::PlayUris {
                uris,
                offset,
                context,
            } => list(uris, *offset, context.as_ref(), 0)?,
            PlayerAction::Resume {
                uris,
                offset,
                position_ms,
                context,
                ..
            } => list(uris, *offset, context.as_ref(), *position_ms)?,
            _ => return None,
        };
        playable(&start.uri).then_some(start)
    }

    fn finish(self, commands: &mpsc::Sender<Value>, before: Option<Vec<String>>) {
        if let Some(target) = &self.skip_to {
            // Soloist lists the new queue once the playlist or album loads.
            let waited = Instant::now();
            let upcoming = loop {
                if let Some(now) = queued_uris().filter(|now| Some(now) != before.as_ref()) {
                    break now;
                }
                if waited.elapsed() > Duration::from_secs(5) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            };
            for skip in skip_commands(target, &upcoming) {
                let _ = commands.send(skip);
            }
        }
        for uri in &self.queue {
            let _ = commands.send(command("add_to_queue", json!({"uri": uri})));
        }
        if self.position_ms > 0 {
            thread::sleep(Duration::from_millis(400));
            let _ = commands.send(command("seek", json!({"position_ms": self.position_ms})));
        }
    }
}

fn queued_uris() -> Option<Vec<String>> {
    queue().map(|(tracks, _)| tracks.into_iter().map(|track| track.uri).collect())
}

fn skip_commands(uri: &str, upcoming: &[String]) -> Vec<Value> {
    upcoming
        .iter()
        .position(|queued| queued == uri)
        .map_or_else(Vec::new, |index| {
            vec![command("skip_next", json!({})); index + 1]
        })
}

/// Skips forward to a song in Soloist's queue. Connect's skip to a named
/// song makes Soloist stop instead.
fn skips_to(uri: &str, upcoming: &[Track]) -> Vec<Value> {
    let uris: Vec<String> = upcoming.iter().map(|track| track.uri.clone()).collect();
    skip_commands(uri, &uris)
}

#[derive(Deserialize)]
struct Playback {
    #[serde(default)]
    status: String,
    item: Option<Item>,
    context: Option<Entity>,
    #[serde(default)]
    position: Position,
    volume: Option<u8>,
    #[serde(default)]
    is_active: bool,
    #[serde(default)]
    options: Options,
}

#[derive(Default, Deserialize)]
struct Position {
    #[serde(default)]
    position_ms: u64,
    #[serde(default)]
    timestamp_ms: i64,
}

#[derive(Default, Deserialize)]
struct Options {
    #[serde(default)]
    shuffle: bool,
    #[serde(default)]
    repeat: String,
}

#[derive(Default, Deserialize)]
struct Entity {
    #[serde(default)]
    uri: String,
    #[serde(default)]
    decorations: Decorations,
}

#[derive(Default, Deserialize)]
struct Decorations {
    #[serde(default)]
    identity: Identity,
    #[serde(default)]
    visual_identity: Visual,
}

#[derive(Default, Deserialize)]
struct Identity {
    #[serde(default)]
    name: String,
}

#[derive(Default, Deserialize)]
struct Visual {
    #[serde(default)]
    cover: Vec<Cover>,
}

#[derive(Deserialize)]
struct Cover {
    url: String,
    #[serde(default)]
    size: String,
}

#[derive(Deserialize)]
struct Item {
    uri: String,
    #[serde(default)]
    decorations: Decorations,
    parent: Option<Wrapped>,
    #[serde(default)]
    creators: Vec<Wrapped>,
    playback: Option<ItemPlayback>,
}

#[derive(Deserialize)]
struct Wrapped {
    entity: Entity,
}

#[derive(Deserialize)]
struct ItemPlayback {
    #[serde(default)]
    duration_ms: u64,
}

fn id(uri: &str) -> Option<String> {
    uri.rsplit(':').next().map(str::to_owned)
}

fn size(cover: &Cover) -> Option<u32> {
    match cover.size.as_str() {
        "small" => Some(64),
        "default" => Some(300),
        "large" | "xlarge" => Some(640),
        _ => None,
    }
}

fn track(item: Item) -> Option<Track> {
    if !item.uri.starts_with("spotify:track:") {
        return None;
    }
    let mut covers = item.decorations.visual_identity.cover;
    if let Some(parent) = item.parent.as_ref() {
        covers.extend(
            parent
                .entity
                .decorations
                .visual_identity
                .cover
                .iter()
                .map(|cover| Cover {
                    url: cover.url.clone(),
                    size: cover.size.clone(),
                }),
        );
    }
    let mut images = Vec::new();
    for cover in &covers {
        let width = size(cover);
        if width == Some(640) && images.iter().any(|image: &Artwork| image.width == width) {
            continue;
        }
        if !images.iter().any(|image: &Artwork| image.url == cover.url) {
            images.push(Artwork {
                url: cover.url.clone(),
                width,
            });
        }
    }
    images.sort_by_key(|image| std::cmp::Reverse(image.width));
    let artists: Vec<Artist> = item
        .creators
        .iter()
        .map(|creator| Artist {
            id: id(&creator.entity.uri),
            uri: creator.entity.uri.clone(),
            name: creator.entity.decorations.identity.name.clone(),
            ..Default::default()
        })
        .collect();
    let album = item
        .parent
        .map(|parent| Album {
            id: id(&parent.entity.uri),
            uri: parent.entity.uri,
            name: parent.entity.decorations.identity.name,
            images: images.clone(),
            artists: artists.clone(),
            ..Default::default()
        })
        .unwrap_or_else(|| Album {
            images,
            ..Default::default()
        });
    Some(Track {
        id: id(&item.uri),
        uri: item.uri,
        name: item.decorations.identity.name,
        artists,
        album,
        duration_ms: item.playback.map_or(0, |playback| playback.duration_ms),
        ..Default::default()
    })
}

impl Playback {
    fn state(self) -> State {
        let track = self.item.and_then(track);
        State {
            active: self.is_active,
            playing: self.status == "playing",
            track,
            position_ms: self.position.position_ms,
            measured_at: self.position.timestamp_ms,
            context: self
                .context
                .map(|context| context.uri)
                .filter(|uri| !uri.is_empty()),
            shuffle: self.options.shuffle,
            repeat: if self.options.repeat.is_empty() {
                "off".into()
            } else {
                self.options.repeat
            },
            volume: self.volume,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_accounts_start_playlists_at_the_picked_song_and_queue_other_lists() {
        let songs: Vec<String> = (0..4).map(|n| format!("spotify:track:{n}")).collect();
        let playlist = "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M".to_owned();
        assert_eq!(
            FreeStart::from(&PlayerAction::PlayUris {
                uris: songs.clone(),
                offset: 2,
                context: Some(playlist.clone()),
            }),
            Some(FreeStart {
                uri: playlist.clone(),
                skip_to: Some("spotify:track:2".into()),
                queue: Vec::new(),
                position_ms: 0,
            })
        );
        // Soloist cannot play Liked Songs as a whole.
        assert_eq!(
            FreeStart::from(&PlayerAction::Resume {
                uris: songs.clone(),
                offset: 1,
                position_ms: 30_000,
                context: Some("spotify:user:someone:collection".into()),
                queued: Vec::new(),
                listed: false,
            }),
            Some(FreeStart {
                uri: "spotify:track:1".into(),
                skip_to: None,
                queue: vec!["spotify:track:2".into(), "spotify:track:3".into()],
                position_ms: 30_000,
            })
        );
        assert_eq!(
            FreeStart::from(&PlayerAction::PlayContext {
                context: playlist.clone(),
                offset: Some("spotify:track:9".into()),
            })
            .and_then(|start| start.skip_to),
            Some("spotify:track:9".into())
        );
        assert!(FreeStart::from(&PlayerAction::Play(Some("spotify:artist:x".into()))).is_none());
        assert!(FreeStart::from(&PlayerAction::Pause).is_none());
        assert_eq!(
            skip_commands("spotify:track:3", &songs).len(),
            4,
            "skips past every song before it"
        );
    }

    #[test]
    fn queue_reply_keeps_upcoming_songs_and_counts_queued_ones() {
        let entry = |source: &str, id: &str| {
            json!({"uid": id, "source": source, "item": {
                "uri": format!("spotify:track:{id}"),
                "entity_type": "track",
                "decorations": {"identity": {"name": id}},
                "creators": [{"entity": {"uri": "spotify:artist:a", "decorations": {"identity": {"name": "Rihanna"}}}}],
                "playback": {"duration_ms": 243000}
            }})
        };
        let reply: QueueReply = serde_json::from_value(json!({
            "type": "queue_changed",
            "previous": [entry("context", "old")],
            "upcoming": [entry("queue", "picked"), entry("context", "next"), {"source": "context", "item": {"uri": "spotify:episode:x"}}],
        }))
        .unwrap();
        let (tracks, queued) = reply.upcoming();
        assert_eq!(queued, 1);
        assert_eq!(
            tracks
                .iter()
                .map(|track| track.name.as_str())
                .collect::<Vec<_>>(),
            ["picked", "next"]
        );
        assert_eq!(tracks[1].artists[0].name, "Rihanna");
        assert_eq!(tracks[1].duration_ms, 243000);
    }

    #[test]
    fn playback_state_becomes_a_track_and_position() {
        let message = json!({
            "type": "playback_state",
            "status": "playing",
            "item": {
                "uri": "spotify:track:0l4DTppOxy7NUaEcwXuOb6",
                "decorations": {
                    "identity": {"name": "Animal"},
                    "visual_identity": {"cover": [
                        {"url": "https://i.scdn.co/image/small", "size": "small"},
                        {"url": "https://i.scdn.co/image/large", "size": "large"},
                        {"url": "https://i.scdn.co/image/xlarge", "size": "xlarge"}
                    ]}
                },
                "parent": {"entity": {"uri": "spotify:album:6oZ5iDw1LT25svEK0g5OqT",
                    "decorations": {"identity": {"name": "Habits"}}}},
                "creators": [{"entity": {"uri": "spotify:artist:0RpddSzUHfncUWNJXKOsjy",
                    "decorations": {"identity": {"name": "Neon Trees"}}}}],
                "playback": {"duration_ms": 212306}
            },
            "context": {"uri": ""},
            "position": {"position_ms": 74713, "timestamp_ms": 1793951134685i64, "speed": 1},
            "volume": 100,
            "is_active": true,
            "options": {"shuffle": false, "repeat": "context"}
        });
        let state = serde_json::from_value::<Playback>(message).unwrap().state();
        let track = state.track.unwrap();
        assert_eq!(track.name, "Animal");
        assert_eq!(track.artist(), "Neon Trees");
        assert_eq!(track.album.name, "Habits");
        assert_eq!(track.duration_ms, 212306);
        assert_eq!(track.album.images[0].url, "https://i.scdn.co/image/large");
        assert_eq!(track.album.images.len(), 2);
        assert!(state.playing && state.active);
        assert_eq!(
            (state.position_ms, state.measured_at),
            (74713, 1793951134685)
        );
        assert_eq!(state.context, None);
        assert_eq!(state.repeat, "context");
    }

    #[test]
    fn transport_actions_become_soloist_commands() {
        assert_eq!(
            commands(&PlayerAction::Seek(5000)),
            vec![json!({"type":"command","command":"seek","position_ms":5000})]
        );
        assert_eq!(
            commands(&PlayerAction::Next),
            vec![json!({"type":"command","command":"skip_next"})]
        );
        assert_eq!(commands(&PlayerAction::Repeat("context".into())).len(), 2);
        assert!(commands(&PlayerAction::Play(Some("spotify:track:x".into()))).is_empty());
        assert!(commands(&PlayerAction::Enqueue("spotify:episode:x".into())).is_empty());
    }

    #[test]
    fn queue_songs_sent_bare_get_their_names_and_artists() {
        let bare = |id: &str| Track {
            uri: format!("spotify:track:describe{id}"),
            ..Default::default()
        };
        let mut queue: Vec<Track> = (0..20).map(|id| bare(&id.to_string())).collect();
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let lookup = |uri: &str| {
            asked.fetch_add(1, Ordering::Relaxed);
            Some(Track {
                uri: uri.into(),
                name: format!("name of {uri}"),
                artists: vec![Artist {
                    name: "Artist".into(),
                    ..Default::default()
                }],
                ..Default::default()
            })
        };
        assert!(describe(&mut queue, lookup));
        assert!(
            queue
                .iter()
                .all(|track| track.name == format!("name of {}", track.uri))
        );
        assert!(queue.iter().all(|track| track.artists[0].name == "Artist"));
        let mut again = vec![bare("3")];
        assert!(describe(&mut again, lookup));
        assert_eq!(asked.load(Ordering::Relaxed), 20);
    }

    #[test]
    fn a_song_ending_on_its_own_holds_the_next_until_its_audio_ends() {
        let song = |id: &str, duration_ms| Track {
            uri: format!("spotify:track:{id}"),
            duration_ms,
            ..Default::default()
        };
        let ending = State {
            playing: true,
            track: Some(song("old", 257_800)),
            position_ms: 255_352,
            measured_at: 1_000_000,
            ..Default::default()
        };
        let next = State {
            track: Some(song("new", 200_000)),
            measured_at: 1_000_400,
            ..Default::default()
        };
        // Reported 400 ms after the old song's last report: 2 s of it left.
        assert_eq!(handover_lag(&ending, &next), Some(HANDOVER_DELAY_MS));
        let picked = next.clone();
        // Picked a minute before the end: nothing was read ahead to wait on.
        let early = State {
            position_ms: 195_352,
            ..ending.clone()
        };
        assert_eq!(handover_lag(&early, &picked), None);
        let paused = State {
            playing: false,
            ..ending.clone()
        };
        assert_eq!(handover_lag(&paused, &next), None);
    }

    #[test]
    fn skipping_to_a_queued_song_skips_up_to_it() {
        let upcoming: Vec<Track> = ["a", "b", "c"]
            .iter()
            .map(|id| Track {
                uri: format!("spotify:track:{id}"),
                ..Default::default()
            })
            .collect();
        assert_eq!(skips_to("spotify:track:c", &upcoming).len(), 3);
        assert_eq!(
            skips_to("spotify:track:a", &upcoming),
            vec![json!({"type":"command","command":"skip_next"})]
        );
        assert!(skips_to("spotify:track:z", &upcoming).is_empty());
    }
}
