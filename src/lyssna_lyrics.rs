//! Lyssna's own community lyrics from api.lyssna.org: the served TTML, who
//! made it, and a play count when the lyrics show.

use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reqwest::{StatusCode, blocking::Client};
use serde::Deserialize;

use crate::lyrics::{Credit, Lyrics, parse_ttml};
use crate::model::Track;

#[derive(Deserialize)]
struct LyricsView {
    song: Song,
    #[serde(default)]
    offset_ms: i64,
    #[serde(default)]
    contributors: Vec<Credit>,
    ttml: String,
}

#[derive(Deserialize)]
struct Song {
    id: String,
}

pub(crate) fn spotify_id(track: &Track) -> Option<&str> {
    track.id.as_deref().filter(|id| {
        !track.is_local && id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

// The API's lyrics answers sit in Cloudflare's edge cache for this long, so a
// song refetched right after an upload would get the old answer back.
const EDGE_CACHE: Duration = Duration::from_secs(300);

static CHANGED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Skips the edge cache for this song's lookups until the cached answer has expired.
pub(crate) fn mark_changed(track: &Track) {
    let Some(id) = spotify_id(track) else {
        return;
    };
    if let Ok(mut changed) = CHANGED.lock() {
        let changed = changed.get_or_insert_with(HashMap::new);
        changed.retain(|_, at| at.elapsed() < EDGE_CACHE);
        changed.insert(id.to_owned(), Instant::now());
    }
}

fn recently_changed(id: &str) -> bool {
    CHANGED.lock().ok().is_some_and(|changed| {
        changed
            .as_ref()
            .and_then(|changed| changed.get(id))
            .is_some_and(|at| at.elapsed() < EDGE_CACHE)
    })
}

/// The ISRC rides along, so the server can fall back to it in the same request.
fn lyrics_url(platform: &str, id: &str, isrc: Option<&str>, fresh: bool) -> String {
    let mut url = format!("{}/v1/lyrics/{platform}/{id}", crate::lyssna_account::API);
    let mut separator = '?';
    if let Some(isrc) = isrc {
        url.push_str(&format!("{separator}isrc={isrc}"));
        separator = '&';
    }
    if fresh {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        url.push_str(&format!("{separator}fresh={nonce}"));
    }
    url
}

/// `None` when Lyssna has no lyrics under this platform ID.
fn view(client: &Client, platform: &str, id: &str, isrc: Option<&str>, fresh: bool) -> Result<Option<LyricsView>> {
    let url = lyrics_url(platform, id, isrc, fresh);
    let mut response = crate::lyssna_account::keyed(client.get(&url))
        .send()
        .context("Cannot reach Lyssna")?;
    if response.status() == StatusCode::UNAUTHORIZED {
        // the API may have forgotten this install: register a new one and ask again
        crate::lyssna_install::forget();
        response = crate::lyssna_account::keyed(client.get(&url))
            .send()
            .context("Cannot reach Lyssna")?;
    }
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!("Lyssna lyrics failed: HTTP {}", response.status().as_u16());
    }
    Ok(Some(response.json().context("Unreadable Lyssna lyrics")?))
}

/// Looks the song up by its Spotify ID, falling back to its ISRC in the same request: the same
/// recording is often on Spotify several times (singles, albums, compilations), and lyrics are
/// uploaded for one. One song is one lookup.
pub fn fetch(
    client: &Client,
    isrc: impl FnOnce() -> Option<String>,
    track: &Track,
) -> Result<Lyrics> {
    let Some(id) = spotify_id(track) else {
        bail!("Lyssna has no lyrics for local songs");
    };
    let fresh = recently_changed(id);
    let isrc = isrc().map(|isrc| isrc.trim().to_ascii_uppercase());
    let found = view(client, "spotify", id, isrc.as_deref(), fresh)?;
    let Some(view) = found else {
        bail!("No Lyssna lyrics for this song");
    };
    let mut lyrics = parse_ttml(&view.ttml, track.duration_ms)?;
    shift(&mut lyrics, view.offset_ms);
    lyrics.source = "lyssna".into();
    lyrics.credits = view.contributors;
    lyrics.song_id = Some(view.song.id);
    Ok(lyrics)
}

/// The song's offset for this platform moves every timestamp.
fn shift(lyrics: &mut Lyrics, offset_ms: i64) {
    let moved = |time: &mut u64| *time = time.saturating_add_signed(offset_ms);
    for line in &mut lyrics.lines {
        moved(&mut line.start_ms);
        moved(&mut line.end_ms);
        for word in &mut line.words {
            moved(&mut word.start_ms);
            moved(&mut word.end_ms);
        }
    }
}

/// A random ID kept on this computer, so plays count once per listener
/// without signing in.
fn client_id() -> Option<String> {
    let file = crate::config::data_dir().ok()?.join("lyssna-client-id");
    if let Ok(id) = fs::read_to_string(&file)
        && id.trim().len() >= 16
    {
        return Some(id.trim().to_owned());
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let _ = fs::write(&file, &id);
    Some(id)
}

/// Counts a play while Lyssna's lyrics show; the server keeps one per
/// listener per song every 30 minutes.
pub fn record_play(client: &Client, song_id: &str) {
    if !song_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return;
    }
    let mut request = crate::lyssna_account::keyed(client.post(format!(
        "{}/v1/songs/{song_id}/play",
        crate::lyssna_account::API
    )));
    if let Some(id) = client_id() {
        request = request.json(&serde_json::json!({ "client_id": id }));
    }
    let _ = request.send();
}

/// Counts a lyrics view for the website's stats; the server keeps one per
/// install per song each day.
pub fn record_view(client: &Client, song_id: &str) {
    if !song_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return;
    }
    let _ = crate::lyssna_account::keyed(client.post(format!(
        "{}/v1/songs/{song_id}/views",
        crate::lyssna_account::API
    )))
    .json(&serde_json::json!({ "client": "app" }))
    .send();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_lyrics_view_and_applies_the_offset() {
        let view: LyricsView = serde_json::from_value(serde_json::json!({
            "song": {"id": "0193", "title": "T", "artists": ["A"]},
            "channel": "curated", "status": "approved", "revision_id": "r", "timing_kind": "word",
            "offset_ms": -250, "score": 0, "vote_count": 0,
            "contributors": [
                {"user_id": "u1", "username": "Arashii", "avatar_url": "https://api.lyssna.org/v1/images/a.png",
                 "units": 10, "share": 75.0, "text_share": 100.0, "timing_share": 50.0, "original": true},
                {"units": 3, "share": 25.0, "text_share": 0.0, "timing_share": 50.0, "original": false}
            ],
            "ttml": r#"<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.000" end="2.000"><span begin="1.000" end="2.000">Hi</span></p></div></body></tt>"#
        }))
        .unwrap();
        assert_eq!(view.contributors[0].username.as_deref(), Some("Arashii"));
        assert!(view.contributors[1].username.is_none());
        let mut lyrics = parse_ttml(&view.ttml, 3000).unwrap();
        shift(&mut lyrics, view.offset_ms);
        assert_eq!(lyrics.lines[0].start_ms, 750);
        assert_eq!(lyrics.lines[0].words[0].end_ms, 1750);
        shift(&mut lyrics, -5000);
        assert_eq!(lyrics.lines[0].start_ms, 0);
    }

    #[test]
    fn a_just_submitted_song_skips_the_edge_cache() {
        let track = Track {
            id: Some("0VjIjW4GlUZAMYd2vXMi3b".into()),
            ..Track::default()
        };
        assert!(!recently_changed("0VjIjW4GlUZAMYd2vXMi3b"));
        assert!(!lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", None, false).contains('?'));
        mark_changed(&track);
        assert!(recently_changed("0VjIjW4GlUZAMYd2vXMi3b"));
        assert!(lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", None, true).contains("?fresh="));
    }

    #[test]
    fn the_isrc_travels_in_the_same_request() {
        let url = lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", Some("USUM71900001"), false);
        assert!(url.ends_with("/v1/lyrics/spotify/0VjIjW4GlUZAMYd2vXMi3b?isrc=USUM71900001"));
        let url = lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", Some("USUM71900001"), true);
        assert!(url.contains("?isrc=USUM71900001&fresh="));
    }

    #[test]
    fn only_spotify_tracks_are_looked_up() {
        let mut track = Track {
            id: Some("4cOdK2wGLETKBW3PvgPWqT".into()),
            ..Track::default()
        };
        assert!(spotify_id(&track).is_some());
        track.is_local = true;
        assert!(spotify_id(&track).is_none());
        track.is_local = false;
        track.id = Some("../etc".into());
        assert!(spotify_id(&track).is_none());
    }
}
