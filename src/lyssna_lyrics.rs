//! Lyrics from api.lyssna.org: Lyssna's own community lyrics (the served
//! TTML, who made it, and a play count when the lyrics show), and Apple
//! Music's lyrics, which Lyssna looks up for the app.

use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reqwest::{StatusCode, blocking::Client};
use serde::{Deserialize, de::DeserializeOwned};

use crate::lyrics::{Credit, Lyrics, SourceCredit, parse_ttml};
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

/// Apple Music's lyrics as Lyssna serves them: no song, revision or
/// contributors, since none of them is Lyssna's.
#[derive(Deserialize)]
struct AppleView {
    #[serde(default)]
    offset_ms: i64,
    ttml: String,
    #[serde(default)]
    credit: Option<SourceCredit>,
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

/// Names the one source asked, since the API otherwise falls back from
/// Lyssna's lyrics to Apple Music's and each is a source of its own here.
/// The ISRC rides along, so the server can fall back to it in the same request.
fn lyrics_url(platform: &str, id: &str, source: &str, isrc: Option<&str>, fresh: bool) -> String {
    let mut url = format!(
        "{}/v1/lyrics/{platform}/{id}?source={source}",
        crate::lyssna_account::API
    );
    if let Some(isrc) = isrc {
        url.push_str(&format!("&isrc={isrc}"));
    }
    if fresh {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        url.push_str(&format!("&fresh={nonce}"));
    }
    url
}

/// `None` when the source has no lyrics for this song.
fn view<T: DeserializeOwned>(client: &Client, url: &str) -> Result<Option<T>> {
    let mut response = crate::lyssna_account::keyed(client.get(url))
        .send()
        .context("Cannot reach Lyssna")?;
    if response.status() == StatusCode::UNAUTHORIZED {
        // the API may have forgotten this install: register a new one and ask again
        crate::lyssna_install::forget();
        response = crate::lyssna_account::keyed(client.get(url))
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
    let url = lyrics_url("spotify", id, "lyssna", isrc.as_deref(), fresh);
    let Some(view) = view::<LyricsView>(client, &url)? else {
        bail!("No Lyssna lyrics for this song");
    };
    let mut lyrics = parse_ttml(&view.ttml, track.duration_ms)?;
    shift(&mut lyrics, view.offset_ms);
    lyrics.source = "lyssna".into();
    lyrics.credits = view.contributors;
    lyrics.song_id = Some(view.song.id);
    Ok(lyrics)
}

/// Apple Music's lyrics for the recording, found by its ISRC. A 404, or a
/// 503 while Apple cannot be asked, leaves the song to the other sources.
pub fn fetch_apple(
    client: &Client,
    isrc: impl FnOnce() -> Option<String>,
    track: &Track,
) -> Result<Lyrics> {
    if spotify_id(track).is_none() {
        bail!("Apple Music lyrics need a Spotify song");
    }
    let Some(isrc) = isrc().map(|isrc| isrc.trim().to_ascii_uppercase()) else {
        bail!("No ISRC to find Apple Music lyrics with");
    };
    if isrc.len() != 12 || !isrc.bytes().all(|b| b.is_ascii_alphanumeric()) {
        bail!("No ISRC to find Apple Music lyrics with");
    }
    let url = lyrics_url("isrc", &isrc, "apple_music", None, false);
    let Some(view) = view::<AppleView>(client, &url)? else {
        bail!("No Apple Music lyrics for this song");
    };
    let mut lyrics = parse_ttml(&view.ttml, track.duration_ms)?;
    shift(&mut lyrics, view.offset_ms);
    lyrics.source = "apple_music".into();
    lyrics.source_credit = view.credit.filter(|credit| !credit.text.trim().is_empty());
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
        assert!(
            !lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", "lyssna", None, false)
                .contains("fresh")
        );
        mark_changed(&track);
        assert!(recently_changed("0VjIjW4GlUZAMYd2vXMi3b"));
        assert!(
            lyrics_url("spotify", "0VjIjW4GlUZAMYd2vXMi3b", "lyssna", None, true)
                .contains("&fresh=")
        );
    }

    #[test]
    fn the_isrc_travels_in_the_same_request() {
        let url = lyrics_url(
            "spotify",
            "0VjIjW4GlUZAMYd2vXMi3b",
            "lyssna",
            Some("USUM71900001"),
            false,
        );
        assert!(url.ends_with(
            "/v1/lyrics/spotify/0VjIjW4GlUZAMYd2vXMi3b?source=lyssna&isrc=USUM71900001"
        ));
        let url = lyrics_url(
            "spotify",
            "0VjIjW4GlUZAMYd2vXMi3b",
            "lyssna",
            Some("USUM71900001"),
            true,
        );
        assert!(url.contains("?source=lyssna&isrc=USUM71900001&fresh="));
    }

    #[test]
    fn apple_music_is_asked_by_isrc_alone() {
        assert!(
            lyrics_url("isrc", "USUM71900001", "apple_music", None, false)
                .ends_with("/v1/lyrics/isrc/USUM71900001?source=apple_music")
        );
    }

    #[test]
    fn reads_apple_musics_answer_and_its_credit() {
        let view: AppleView = serde_json::from_value(serde_json::json!({
            "source": "apple_music", "apple_id": "1440857781", "timing_kind": "line", "offset_ms": 0,
            "ttml": "<tt/>",
            "credit": {"text": "Lyrics provided by Apple Music via Lyssna", "url": "https://lyssna.org"}
        }))
        .unwrap();
        assert_eq!(view.offset_ms, 0);
        assert_eq!(
            view.credit.unwrap().text,
            "Lyrics provided by Apple Music via Lyssna"
        );
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
