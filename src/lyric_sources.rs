//! Lyric sources and the order they are tried in, as chosen in Lyrics
//! settings → Sources. Reimplements the source manager of the Spicy Lyrics
//! fork (iPixelGalaxy/spicy-lyrics, `src/utils/Lyrics/Sources`, AGPL-3.0):
//! the same six sources, default order and quality-first selection, plus
//! lrc.red.
//!
//! What each source receives:
//! - Lyssna: the Spotify track ID and its ISRC (api.lyssna.org).
//! - Apple Music: the song's ISRC, looked up through Lyssna (api.lyssna.org).
//! - Spicy Lyrics: the configured Spicy Lyrics provider; its Apple Music
//!   answers are left to the Apple Music source.
//! - Spotify: the track ID, through the signed-in native Spotify session.
//! - LRCLIB: title, artist, album and length (lrclib.net).
//! - Netease: title and artist, through the third-party proxy the fork uses.
//! - lrc.red: the song's ISRC (lrc.red), with a User-Agent naming Lyssna and
//!   a contact address, as its terms require.
//!
//! No source receives Spotify access or refresh tokens.

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow, ensure};
use reqwest::blocking::Client;
use serde_json::Value;

use crate::credential as keyring;
use crate::lyrics::{Line, Lyrics};
use crate::model::Track;

/// Every known source, in default order.
pub const DEFAULT_ORDER: [&str; 7] = [
    "lyssna", "apple", "spicy", "lrcred", "spotify", "lrclib", "netease",
];
/// Raised when the default layout changes; saved sources older than this
/// are reset to it once.
pub const LAYOUT: u32 = 2;
/// Sources the fork leaves off until chosen.
pub const DEFAULT_DISABLED: [&str; 2] = ["lrclib", "netease"];

static ACTIVE: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// Sources added later that join saved orders right after another source
/// rather than at the end.
const JOIN_AFTER: [(&str, &str); 1] = [("lrcred", "spicy")];
/// Sources added later that go to the top of saved orders.
const JOIN_FIRST: [&str; 1] = ["lyssna"];

/// Known source IDs in the saved order, with any missing ones appended.
pub fn normalize_order(order: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for id in order.iter().map(String::as_str) {
        if DEFAULT_ORDER.contains(&id) && !result.iter().any(|known| known == id) {
            result.push(id.to_owned());
        }
    }
    for id in DEFAULT_ORDER {
        if result.iter().any(|known| known == id) {
            continue;
        }
        if JOIN_FIRST.contains(&id) {
            result.insert(0, id.to_owned());
            continue;
        }
        let after = JOIN_AFTER
            .iter()
            .find(|(new, _)| *new == id)
            .and_then(|(_, after)| result.iter().position(|known| known == after));
        match after {
            Some(at) => result.insert(at + 1, id.to_owned()),
            None => result.push(id.to_owned()),
        }
    }
    result
}

/// Sources added since the settings were saved start in their default
/// state: off when the fork leaves them off, otherwise on.
pub fn migrate(order: &[String], disabled: &mut Vec<String>) -> Vec<String> {
    for id in DEFAULT_DISABLED {
        if !order.iter().any(|known| known == id) && !disabled.iter().any(|off| off == id) {
            disabled.push(id.to_owned());
        }
    }
    disabled.retain(|id| DEFAULT_ORDER.contains(&id.as_str()));
    normalize_order(order)
}

/// Applies the saved order and the sources that are turned off.
pub fn configure(order: &[String], disabled: &[String]) {
    let enabled = normalize_order(order)
        .into_iter()
        .filter(|id| !disabled.contains(id))
        .collect();
    if let Ok(mut active) = ACTIVE.lock() {
        *active = Some(enabled);
    }
}

/// Sources to try, in order. Before settings load, the fork's defaults.
pub fn enabled() -> Vec<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.clone())
        .unwrap_or_else(|| {
            DEFAULT_ORDER
                .iter()
                .filter(|id| !DEFAULT_DISABLED.contains(id))
                .map(|id| (*id).to_owned())
                .collect()
        })
}

/// How good a result is: word-synced 3, line-synced 2, plain 1.
pub fn quality(lyrics: &Lyrics) -> u8 {
    if lyrics.instrumental || lyrics.lines.iter().any(|line| !line.words.is_empty()) {
        3
    } else if lyrics.synced && !lyrics.lines.is_empty() {
        2
    } else if !lyrics.lines.is_empty() {
        1
    } else {
        0
    }
}

/// The answer when every source was reached and none had lyrics. The
/// No lyrics notice setting can hide this one; real failures still show.
pub const NO_LYRICS: &str = "No lyrics found for this song";

/// A lyrics source could not be reached, as opposed to having no lyrics.
#[derive(Debug)]
pub struct Unreachable(pub String);
impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unreachable {}

/// Whether an error means a source could not be reached (offline, timed
/// out, connection refused) rather than that it had no lyrics.
pub fn unreachable(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<Unreachable>()
            || cause
                .downcast_ref::<reqwest::Error>()
                .is_some_and(|error| error.is_connect() || error.is_timeout() || error.is_request())
    })
}

const SONG_SOURCES_FILE: &str = "song-sources.json";
static SONG_SOURCES: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn song_sources_path() -> Result<std::path::PathBuf> {
    Ok(crate::config::data_dir()?
        .join("lyrics")
        .join(SONG_SOURCES_FILE))
}

fn with_song_sources<T>(
    read: impl FnOnce(&mut std::collections::HashMap<String, String>) -> T,
) -> T {
    let mut chosen = SONG_SOURCES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let chosen = chosen.get_or_insert_with(|| {
        song_sources_path()
            .ok()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    read(chosen)
}

/// The source chosen for one song, asked before the usual order.
pub fn song_source(uri: &str) -> Option<String> {
    with_song_sources(|chosen| chosen.get(uri).cloned())
}

/// Chooses a source for one song, or with `None` goes back to the usual order.
pub fn set_song_source(uri: &str, source: Option<&str>) -> Result<()> {
    ensure!(!uri.is_empty(), "No song to choose a source for");
    if let Some(source) = source {
        ensure!(DEFAULT_ORDER.contains(&source), "Unknown lyrics source");
    }
    let saved = with_song_sources(|chosen| {
        match source {
            Some(source) => chosen.insert(uri.to_owned(), source.to_owned()),
            None => chosen.remove(uri),
        };
        serde_json::to_vec_pretty(chosen)
    })?;
    let path = song_sources_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, saved)?;
    Ok(())
}

/// Asks one lyrics source by name; shared by the threads asking each.
pub type SourceFetch = Arc<dyn Fn(&str) -> Result<Lyrics> + Send + Sync>;

/// Queries every enabled source at once, then picks in the chosen order: the
/// first timed result wins, by line or by word; otherwise the first plain
/// one. Once a preferred source (Lyssna, Spicy, Apple) has lyrics,
/// LRCLIB and Netease are not consulted. Spicy's community syncs count only
/// when word-synced, and Apple Music and Spicy settle between themselves by
/// word timing (see `settle`).
pub fn fetch_best(sources: &[String], fetch: SourceFetch) -> Result<Lyrics> {
    // Answers arrive as each source replies. A pick is made once every
    // source ahead of it has answered, so a slow source further down never
    // holds back lyrics already found; it finishes on its own.
    let (sender, answers) = std::sync::mpsc::channel();
    for (index, source) in sources.iter().enumerate() {
        let (sender, fetch, source) = (sender.clone(), fetch.clone(), source.clone());
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fetch(&source)))
                .unwrap_or_else(|_| Err(anyhow!("Lyrics source failed")));
            let _ = sender.send((index, result));
        });
    }
    drop(sender);
    let mut results: Vec<Option<Result<Lyrics>>> = sources.iter().map(|_| None).collect();
    while let Ok((index, result)) = answers.recv() {
        results[index] = Some(result);
        if let Some(pick) = early_pick(sources, &results) {
            return Ok(pick);
        }
    }
    pick_best(sources, &results)
}

/// Whether the source is one whose lyrics stop LRCLIB and Netease counting.
fn preferred_source(source: &str) -> bool {
    matches!(source, "lyssna" | "spicy" | "apple")
}

/// Timed lyrics, by line or by word, rank alike, so the source order
/// decides between them; plain lyrics rank below.
fn rank(lyrics: &Lyrics) -> u8 {
    quality(lyrics).min(2)
}

/// Spicy's community syncs are only worth showing word-synced; by line,
/// the sources after it do as well or better.
fn usable(source: &str, lyrics: &Lyrics) -> bool {
    rank(lyrics) > 0 && (source != "spicy" || quality(lyrics) == 3)
}

/// The usable lyrics a source answered with: `None` while it hasn't
/// answered, `Some(None)` when it had none.
fn answer<'a>(
    sources: &[String],
    results: &'a [Option<Result<Lyrics>>],
    source: &str,
) -> Option<Option<&'a Lyrics>> {
    let index = sources.iter().position(|known| known == source)?;
    let result = results[index].as_ref()?;
    Some(result.as_ref().ok().filter(|lyrics| usable(source, lyrics)))
}

/// Apple Music and Spicy's community syncs settle between themselves by
/// word timing, whichever is listed first: word-synced Apple beats Spicy,
/// and word-synced Spicy beats Apple timed only by line. `None` while the
/// other's answer is still to come.
fn settle<'a>(
    sources: &[String],
    results: &'a [Option<Result<Lyrics>>],
    source: &str,
    pick: &'a Lyrics,
) -> Option<&'a Lyrics> {
    let other = match source {
        "apple" if quality(pick) < 3 => "spicy",
        "spicy" => "apple",
        _ => return Some(pick),
    };
    if !sources.iter().any(|known| known == other) {
        return Some(pick);
    }
    Some(match answer(sources, results, other)? {
        Some(lyrics) if quality(lyrics) == 3 => lyrics,
        _ => pick,
    })
}

/// The first timed pick in order, once every answer it depends on is in.
fn early_pick(sources: &[String], results: &[Option<Result<Lyrics>>]) -> Option<Lyrics> {
    let mut best: Option<(&str, &Lyrics)> = None;
    let mut preferred = false;
    for (source, result) in sources.iter().zip(results) {
        if preferred && matches!(source.as_str(), "lrclib" | "netease") {
            continue;
        }
        // An earlier source has not answered yet.
        let result = result.as_ref()?;
        let Ok(lyrics) = result else { continue };
        if !usable(source, lyrics) {
            continue;
        }
        if preferred_source(source) {
            preferred = true;
        }
        let score = rank(lyrics);
        if best.is_none_or(|(_, known)| score > rank(known)) {
            best = Some((source, lyrics));
        }
        if score == 2
            && let Some((source, pick)) = best
        {
            return settle(sources, results, source, pick).cloned();
        }
    }
    None
}

/// The pick once every source has answered.
fn pick_best(sources: &[String], results: &[Option<Result<Lyrics>>]) -> Result<Lyrics> {
    let mut best: Option<(&str, &Lyrics)> = None;
    let mut failure: Option<String> = None;
    let mut preferred = false;
    for (source, result) in sources.iter().zip(results) {
        if preferred && matches!(source.as_str(), "lrclib" | "netease") {
            continue;
        }
        let lyrics = match result {
            Some(Ok(lyrics)) => lyrics,
            Some(Err(error)) => {
                // Only an unreachable source is worth reporting; the rest
                // simply had no lyrics.
                if unreachable(error) {
                    failure = Some(error.to_string());
                }
                continue;
            }
            None => continue,
        };
        if !usable(source, lyrics) {
            continue;
        }
        if preferred_source(source) {
            preferred = true;
        }
        if best.is_none_or(|(_, known)| rank(lyrics) > rank(known)) {
            best = Some((source, lyrics));
        }
    }
    best.and_then(|(source, pick)| settle(sources, results, source, pick))
        .cloned()
        .ok_or_else(|| match failure {
            Some(message) => Unreachable(message).into(),
            None => anyhow!(NO_LYRICS),
        })
}

/// Keeps Apple Music's lyrics out of the Spicy Lyrics provider's answers:
/// Apple Music is its own source, through Lyssna.
pub fn split_provider(lyrics: &Lyrics, source: &str) -> Option<Lyrics> {
    let apple = matches!(lyrics.source.as_str(), "apple_music" | "aml");
    (apple == (source == "apple")).then(|| lyrics.clone())
}

fn first_artist(track: &Track) -> &str {
    track
        .artists
        .first()
        .map(|artist| artist.name.as_str())
        .unwrap_or_default()
}

fn track_id(track: &Track) -> Option<&str> {
    track
        .id
        .as_deref()
        .or_else(|| track.uri.strip_prefix("spotify:track:"))
        .filter(|id| id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

/// Lines with no end time end where the next starts, or at the song's end.
fn close_lines(lines: &mut [Line], duration_ms: u64) {
    for index in 0..lines.len() {
        if lines[index].end_ms > lines[index].start_ms {
            continue;
        }
        let next = lines
            .get(index + 1)
            .map(|line| line.start_ms)
            .unwrap_or(duration_ms.max(lines[index].start_ms + 4_000));
        lines[index].end_ms = next.max(lines[index].start_ms + 1);
    }
}

fn plain_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<Line> {
    lines
        .map(str::trim)
        .filter(|text| !text.is_empty() && !is_note_only(text))
        .take(2_000)
        .map(|text| Line {
            text: text.chars().take(500).collect(),
            ..Line::default()
        })
        .collect()
}

fn is_note_only(text: &str) -> bool {
    text.chars()
        .all(|char| char.is_whitespace() || "♪♫♬♩".contains(char))
}

/// Song titles compared without features, brackets or punctuation.
fn title_key(text: &str) -> String {
    let lower = text.to_lowercase();
    let main = lower.split(" - ").next().unwrap_or_default();
    let mut result = String::new();
    let mut depth = 0u32;
    for char in main.chars() {
        match char {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 && char.is_alphanumeric() => result.push(char),
            _ => {}
        }
    }
    result
}

// ---------------------------------------------------------------- LRCLIB

/// Looks the song up on LRCLIB, preferring time-synced lyrics.
pub fn lrclib(client: &Client, track: &Track) -> Result<Lyrics> {
    let artist = first_artist(track);
    ensure!(
        !track.name.is_empty() && !artist.is_empty(),
        "LRCLIB needs a title and artist"
    );
    let mut query = vec![
        ("track_name", track.name.clone()),
        ("artist_name", artist.to_owned()),
    ];
    if !track.album.name.is_empty() {
        query.push(("album_name", track.album.name.clone()));
    }
    if track.duration_ms > 0 {
        query.push(("duration", (track.duration_ms / 1000).to_string()));
    }
    let response = client
        .get("https://lrclib.net/api/get")
        .query(&query)
        .send()
        .context("LRCLIB is unreachable")?;
    ensure!(
        response.status().is_success(),
        "LRCLIB has no lyrics for this song"
    );
    let value: Value = response.json().context("LRCLIB returned invalid data")?;
    from_lrclib(&value, track.duration_ms)
}

/// Converts an LRCLIB record: synced LRC first, then plain text.
pub fn from_lrclib(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    if value["instrumental"].as_bool() == Some(true) {
        return Ok(Lyrics {
            instrumental: true,
            source: "LRCLIB".into(),
            ..Lyrics::default()
        });
    }
    if let Some(synced) = value["syncedLyrics"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        && let Ok(mut lyrics) = crate::lyrics::parse_lrc(synced, duration_ms)
    {
        lyrics.source = "LRCLIB".into();
        return Ok(lyrics);
    }
    let plain = value["plainLyrics"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .context("LRCLIB has no lyrics for this song")?;
    Ok(Lyrics {
        lines: plain_lines(plain.lines()),
        source: "LRCLIB".into(),
        synced: false,
        ..Lyrics::default()
    })
}

// ------------------------------------------------------------- Spotify

/// Converts Spotify's color-lyrics answer (line-synced or plain).
pub fn from_spotify(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    let lyrics = &value["lyrics"];
    let rows = lyrics["lines"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .context("Spotify has no lyrics for this song")?;
    let provider = lyrics["provider"].as_str().unwrap_or_default().trim();
    let source = if provider.eq_ignore_ascii_case("musixmatch") {
        "Spotify (through Musixmatch)".to_owned()
    } else if provider.is_empty() {
        "Spotify".to_owned()
    } else {
        format!("Spotify ({provider})")
    };
    let synced = lyrics["syncType"].as_str() == Some("LINE_SYNCED");
    let mut lines: Vec<Line> = Vec::new();
    for row in rows.iter().take(2_000) {
        let text = row["words"].as_str().unwrap_or_default().trim();
        if text.is_empty() || is_note_only(text) {
            continue;
        }
        let start_ms = row["startTimeMs"]
            .as_str()
            .and_then(|value| value.parse().ok())
            .or_else(|| row["startTimeMs"].as_u64())
            .unwrap_or(0);
        lines.push(Line {
            start_ms: if synced { start_ms } else { 0 },
            text: text.chars().take(500).collect(),
            ..Line::default()
        });
    }
    ensure!(!lines.is_empty(), "Spotify has no lyrics for this song");
    if synced {
        close_lines(&mut lines, duration_ms);
    }
    Ok(Lyrics {
        lines,
        source,
        synced,
        ..Lyrics::default()
    })
}

/// Fetches Spotify's own lyrics through the native session.
pub fn spotify(native: &crate::native::NativeControls, track: &Track) -> Result<Lyrics> {
    let id = track_id(track).context("Spotify lyrics need a Spotify track")?;
    let body = native.lyrics(id)?;
    let value: Value = serde_json::from_slice(&body).context("Spotify returned invalid lyrics")?;
    from_spotify(&value, track.duration_ms)
}

/// Musixmatch is no longer a source; a token saved for it is removed.
pub fn forget_musixmatch_token() {
    if let Ok(entry) = keyring::Entry::new("Lyssna/Musixmatch", "user-token") {
        let _ = entry.delete_credential();
    }
}

// ------------------------------------------------------------- Netease

/// Lines Netease adds for credits (lyricist, composer, mixing and so on).
fn netease_credit(text: &str) -> bool {
    let Some((label, _)) = text.split_once([':', '：']) else {
        return false;
    };
    let label = label.trim().to_lowercase();
    [
        "作词", "作曲", "编曲", "监制", "制作", "混音", "缩混", "录音", "和声", "吉他", "贝斯",
        "鼓", "弦乐", "钢琴", "出品", "发行", "原唱", "lrc", "publish", "vocal", "guitar",
        "program", "produce", "write", "mix",
    ]
    .iter()
    .any(|keyword| label.contains(keyword))
}

// -------------------------------------------------------------- lrc.red

/// lrc.red's terms: name the app, with a link and a contact address.
const LRC_RED_AGENT: &str = concat!(
    "Lyssna/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/LyssLabs/lyssna-app; 145221345+Stormanzanii@users.noreply.github.com)"
);

/// Looks the song up on lrc.red by its ISRC; its TTML carries word timing,
/// singers and background vocals where the song has them.
pub fn lrc_red(
    client: &Client,
    native: &crate::native::NativeControls,
    track: &Track,
) -> Result<Lyrics> {
    ensure!(!track.is_local, "lrc.red needs a Spotify song");
    let isrc = native
        .isrc(&track.uri)?
        .context("lrc.red needs the song's ISRC")?;
    let response = client
        .get(format!("https://lrc.red/s/{isrc}.ttml"))
        .header(reqwest::header::USER_AGENT, LRC_RED_AGENT)
        .send()
        .context("lrc.red is unreachable")?;
    ensure!(
        response.status() != reqwest::StatusCode::NOT_FOUND,
        "lrc.red has no lyrics for this song"
    );
    ensure!(
        response.status().is_success(),
        "lrc.red answered {}",
        response.status()
    );
    let mut lyrics = crate::lyrics::parse_ttml(
        &response.text().context("lrc.red returned invalid data")?,
        track.duration_ms,
    )?;
    lyrics.source = "lrc.red".into();
    Ok(lyrics)
}

/// Looks the song up through the Netease proxy the fork uses.
pub fn netease(client: &Client, track: &Track) -> Result<Lyrics> {
    const BASE: &str = "https://music.xianqiao.wang/neteaseapiv2/";
    const AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0";
    let query = format!("{} {}", track.name, first_artist(track));
    let search: Value = client
        .get(format!("{BASE}search"))
        .query(&[("limit", "10"), ("type", "1"), ("keywords", query.trim())])
        .header("user-agent", AGENT)
        .send()
        .context("Netease is unreachable")?
        .json()
        .context("Netease returned invalid data")?;
    let songs = search["result"]["songs"]
        .as_array()
        .filter(|songs| !songs.is_empty())
        .context("Netease has no match for this song")?;
    let album = title_key(&track.album.name);
    let title = title_key(&track.name);
    let song = songs
        .iter()
        .find(|song| {
            !album.is_empty() && title_key(song["album"]["name"].as_str().unwrap_or("")) == album
        })
        .or_else(|| {
            songs.iter().find(|song| {
                song["duration"]
                    .as_u64()
                    .is_some_and(|duration| duration.abs_diff(track.duration_ms) < 3_000)
            })
        })
        .or_else(|| {
            songs
                .iter()
                .find(|song| title_key(song["name"].as_str().unwrap_or("")) == title)
        })
        .unwrap_or(&songs[0]);
    let id = song["id"]
        .as_u64()
        .context("Netease has no match for this song")?;
    let body: Value = client
        .get(format!("{BASE}lyric"))
        .query(&[("id", id.to_string())])
        .header("user-agent", AGENT)
        .send()
        .context("Netease is unreachable")?
        .json()
        .context("Netease returned invalid data")?;
    from_netease(&body, track.duration_ms)
}

/// Converts a Netease lyric answer, dropping credit lines.
pub fn from_netease(value: &Value, duration_ms: u64) -> Result<Lyrics> {
    let text = value["lrc"]["lyric"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .context("Netease has no lyrics for this song")?;
    let mut lyrics =
        crate::lyrics::parse_lrc(text, duration_ms).or_else(|_| -> Result<Lyrics> {
            Ok(Lyrics {
                lines: plain_lines(text.lines()),
                ..Lyrics::default()
            })
        })?;
    lyrics
        .lines
        .retain(|line| !netease_credit(&line.text) && line.text.trim() != "纯音乐, 请欣赏");
    ensure!(
        !lyrics.lines.is_empty(),
        "Netease has no lyrics for this song"
    );
    lyrics.source = "Netease".into();
    Ok(lyrics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::Word;

    #[test]
    fn a_song_source_must_be_a_known_source() {
        assert!(set_song_source("spotify:track:x", Some("nowhere")).is_err());
        assert!(set_song_source("", Some("lyssna")).is_err());
    }
    use serde_json::json;

    fn timed(words: bool, synced: bool) -> Lyrics {
        Lyrics {
            lines: vec![Line {
                text: "Hi".into(),
                words: if words {
                    vec![Word {
                        start_ms: 0,
                        end_ms: 100,
                        text: "Hi".into(),
                        sung_by: None,
                    }]
                } else {
                    Vec::new()
                },
                ..Line::default()
            }],
            synced,
            ..Lyrics::default()
        }
    }

    #[test]
    fn order_keeps_known_sources_once_and_appends_missing() {
        assert_eq!(
            normalize_order(&["lrclib".into(), "bogus".into(), "lrclib".into()]),
            vec![
                "lyssna", "lrclib", "apple", "spicy", "lrcred", "spotify", "netease"
            ]
        );
        configure(&["lrclib".into(), "spicy".into()], &["spicy".into()]);
        assert_eq!(enabled()[..2], ["lyssna", "lrclib"]);
        assert!(!enabled().contains(&"spicy".to_owned()));
    }

    #[test]
    fn new_sources_start_in_the_forks_default_state() {
        let mut disabled = vec!["lrclib".to_owned()];
        let order = migrate(&["spicy".into(), "lrclib".into()], &mut disabled);
        assert_eq!(
            order,
            [
                "lyssna", "spicy", "lrcred", "lrclib", "apple", "spotify", "netease"
            ]
        );
        assert!(!disabled.contains(&"lrcred".to_owned()));
        assert!(disabled.contains(&"netease".to_owned()));
        // A source the user turned on is not turned back off.
        let mut chosen = Vec::new();
        migrate(&DEFAULT_ORDER.map(String::from), &mut chosen);
        assert!(chosen.is_empty());
    }

    #[test]
    fn first_timed_source_in_order_wins() {
        let order: Vec<String> = ["lyssna", "apple", "lrclib"].map(String::from).to_vec();
        let pick = |lyssna: Lyrics, apple: Lyrics| {
            fetch_best(
                &order,
                Arc::new(move |source: &str| match source {
                    "lyssna" => Ok(lyssna.clone()),
                    "apple" => Ok(apple.clone()),
                    _ => Ok(timed(true, true)),
                }),
            )
            .unwrap()
        };
        // Line-synced Lyssna, listed first, beats word-synced Apple Music.
        assert!(
            pick(timed(false, true), timed(true, true)).lines[0]
                .words
                .is_empty()
        );
        // Timed Apple Music beats plain Lyssna.
        assert!(pick(timed(false, false), timed(true, true)).synced);
        // A preferred source's answer stops LRCLIB being used.
        assert!(
            pick(timed(false, true), Lyrics::default()).lines[0]
                .words
                .is_empty()
        );
        let failing = fetch_best(&order, Arc::new(|_: &str| Err(anyhow!("down"))));
        assert!(failing.is_err());
    }

    #[test]
    fn a_slow_later_source_never_holds_back_word_synced_lyrics() {
        let order: Vec<String> = ["spicy", "netease"].map(String::from).to_vec();
        let started = std::time::Instant::now();
        let pick = fetch_best(
            &order,
            Arc::new(|source: &str| {
                if source == "netease" {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
                Ok(timed(true, true))
            }),
        )
        .unwrap();
        assert!(!pick.lines[0].words.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    fn gapped(source: &str, gap_ms: u64) -> Lyrics {
        let line = |start_ms: u64| Line {
            text: "Hi".into(),
            start_ms,
            end_ms: start_ms + 1000,
            words: vec![Word {
                start_ms,
                end_ms: start_ms + 1000,
                text: "Hi".into(),
                sung_by: None,
            }],
            ..Line::default()
        };
        Lyrics {
            lines: vec![line(0), line(1000 + gap_ms)],
            synced: true,
            source: source.into(),
            ..Lyrics::default()
        }
    }

    #[test]
    fn missing_lyrics_differ_from_unreachable_sources() {
        let order: Vec<String> = ["spicy", "apple"].map(String::from).to_vec();
        let missing = fetch_best(&order, Arc::new(|_: &str| Err(anyhow!("No match"))))
            .err()
            .unwrap();
        assert_eq!(missing.to_string(), NO_LYRICS);
        assert!(!unreachable(&missing));
        let offline = fetch_best(
            &order,
            Arc::new(|source: &str| match source {
                "spicy" => Err(Unreachable("Spicy Lyrics is unreachable".into()).into()),
                _ => Err(anyhow!("No match")),
            }),
        )
        .err()
        .unwrap();
        assert!(unreachable(&offline));
        assert_eq!(offline.to_string(), "Spicy Lyrics is unreachable");
    }

    fn by_line(source: &str) -> Lyrics {
        let mut lyrics = gapped(source, 0);
        lyrics.lines.iter_mut().for_each(|line| line.words.clear());
        lyrics
    }

    fn pick_between(order: &[&str], apple: Lyrics, spicy: Lyrics) -> String {
        let order: Vec<String> = order.iter().map(|id| (*id).to_owned()).collect();
        fetch_best(
            &order,
            Arc::new(move |source: &str| match source {
                "apple" => Ok(apple.clone()),
                "spicy" => Ok(spicy.clone()),
                _ => Ok(by_line(source)),
            }),
        )
        .unwrap()
        .source
    }

    #[test]
    fn apple_and_spicy_settle_by_word_timing() {
        let order = ["apple", "spicy", "lrcred"];
        // Word-synced Apple wins outright.
        assert_eq!(
            pick_between(&order, gapped("apple", 0), gapped("spicy", 0)),
            "apple"
        );
        // Apple timed by line gives way to word-synced Spicy.
        assert_eq!(
            pick_between(&order, by_line("apple"), gapped("spicy", 0)),
            "spicy"
        );
        // Spicy by line doesn't count, so Apple by line stays.
        assert_eq!(
            pick_between(&order, by_line("apple"), by_line("spicy")),
            "apple"
        );
        // Listed first, word-synced Spicy still gives way to word-synced Apple.
        let spicy_first = ["spicy", "apple", "lrcred"];
        assert_eq!(
            pick_between(&spicy_first, gapped("apple", 0), gapped("spicy", 0)),
            "apple"
        );
        assert_eq!(
            pick_between(&spicy_first, by_line("apple"), gapped("spicy", 0)),
            "spicy"
        );
        // Spicy by line is passed over for the next source.
        let no_apple = ["spicy", "lrcred"];
        assert_eq!(
            pick_between(&no_apple, Lyrics::default(), by_line("spicy")),
            "lrcred"
        );
    }

    #[test]
    fn apple_never_replaces_lyssna_lyrics() {
        let order: Vec<String> = ["lyssna", "apple"].map(String::from).to_vec();
        let started = std::time::Instant::now();
        let pick = fetch_best(
            &order,
            Arc::new(|source: &str| {
                if source == "apple" {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
                Ok(gapped(source, 0))
            }),
        )
        .unwrap();
        assert_eq!(pick.source, "lyssna");
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn provider_answers_split_between_spicy_and_apple() {
        let apple = Lyrics {
            source: "apple_music".into(),
            ..Lyrics::default()
        };
        assert!(split_provider(&apple, "apple").is_some());
        assert!(split_provider(&apple, "spicy").is_none());
        let community = Lyrics {
            source: "spicy_lyrics".into(),
            ..Lyrics::default()
        };
        assert!(split_provider(&community, "spicy").is_some());
    }

    #[test]
    fn lrclib_prefers_synced_lyrics_and_falls_back_to_plain() {
        let synced = from_lrclib(
            &json!({"syncedLyrics":"[00:01.00]Hello\n[00:03.50]World","plainLyrics":"Hello\nWorld"}),
            10_000,
        )
        .unwrap();
        assert!(synced.synced);
        assert_eq!(synced.lines[1].start_ms, 3_500);
        let plain = from_lrclib(&json!({"plainLyrics":"Hello\nWorld"}), 0).unwrap();
        assert!(!plain.synced);
        assert!(
            from_lrclib(&json!({"instrumental":true}), 0)
                .unwrap()
                .instrumental
        );
        assert!(from_lrclib(&json!({}), 0).is_err());
    }

    #[test]
    fn spotify_lines_end_where_the_next_begins() {
        let lyrics = from_spotify(
            &json!({"lyrics":{"syncType":"LINE_SYNCED","provider":"MusixMatch","lines":[
                {"startTimeMs":"1000","words":"Hello"},
                {"startTimeMs":"2000","words":"♪"},
                {"startTimeMs":"3000","words":"World"}]}}),
            10_000,
        )
        .unwrap();
        assert_eq!(lyrics.source, "Spotify (through Musixmatch)");
        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.lines[0].end_ms, 3_000);
        assert_eq!(lyrics.lines[1].end_ms, 10_000);
    }

    #[test]
    fn netease_drops_credit_lines() {
        let lyrics = from_netease(
            &json!({"lrc":{"lyric":"[00:00.00]作词 : Someone\n[00:01.00]Hello\n[00:02.00]World"}}),
            5_000,
        )
        .unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Hello", "World"]
        );
    }

    #[test]
    fn titles_match_without_features_or_brackets() {
        assert_eq!(
            title_key("Lose Yourself (feat. X) - Remastered"),
            "loseyourself"
        );
        assert_ne!(title_key("NOKIA"), title_key("Lose Yourself"));
    }

    /// Live check against the real services: `cargo test live_sources -- --ignored`.
    #[test]
    #[ignore]
    fn live_sources() {
        let client = crate::auth::http_client().unwrap();
        let track = Track {
            uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b".into(),
            id: Some("0VjIjW4GlUZAMYd2vXMi3b".into()),
            name: "Blinding Lights".into(),
            artists: vec![crate::model::Artist {
                name: "The Weeknd".into(),
                ..Default::default()
            }],
            album: crate::model::Album {
                name: "After Hours".into(),
                ..Default::default()
            },
            duration_ms: 200_040,
            ..Default::default()
        };
        for (name, result) in [
            ("lrclib", lrclib(&client, &track)),
            ("netease", netease(&client, &track)),
        ] {
            match result {
                Ok(lyrics) => println!(
                    "{name}: quality {} lines {}",
                    quality(&lyrics),
                    lyrics.lines.len()
                ),
                Err(error) => println!("{name}: {error}"),
            }
        }
    }
}
