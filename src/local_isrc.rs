//! Local files have no Spotify ID, so Lyssna's lyrics for them are found by
//! the recording's ISRC: the file's own tag when it has one, a match made by
//! hand, or one found by title, artist and length. A found match counts only
//! when every candidate that fits agrees on one ISRC.

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use reqwest::{StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};

use crate::model::Track;

/// How far a candidate's length may be from the file's.
const LENGTH_SLACK_MS: u64 = 2_000;
/// More fitting candidates than this is too vague to pick from.
const MOST_CANDIDATES: usize = 5;
/// A miss is searched again after this; a find is kept longer.
const MISS_FOR: Duration = Duration::from_secs(60);
const FIND_FOR: Duration = Duration::from_secs(30 * 60);
const MATCHES_FILE: &str = "local-isrc.json";

/// `AA-BB1-23-45678` and `aabb12345678` read as `AABB12345678`.
pub fn normalize(value: &str) -> Option<String> {
    let code: String = value
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .collect::<String>()
        .to_ascii_uppercase();
    let bytes = code.as_bytes();
    (bytes.len() == 12
        && bytes[..2].iter().all(u8::is_ascii_alphabetic)
        && bytes[2..5].iter().all(u8::is_ascii_alphanumeric)
        && bytes[5..].iter().all(u8::is_ascii_digit))
    .then_some(code)
}

fn comparable(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn album_name(text: &str) -> String {
    let name = comparable(text);
    ["- single", "- ep"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .map(|name| name.trim_end().to_owned())
        .unwrap_or(name)
}

/// What a candidate must agree with.
struct Details {
    title: String,
    artist: String,
    album: String,
    length: u64,
    /// Changes when the file's details do, so a saved match is dropped.
    key: String,
}

impl Details {
    fn of(track: &Track) -> Option<Self> {
        let artist = track.artists.first()?.name.trim();
        if track.name.trim().is_empty() || artist.is_empty() || track.duration_ms == 0 {
            return None;
        }
        let (title, artist, album) = (
            comparable(&track.name),
            comparable(artist),
            album_name(&track.album.name),
        );
        let key = format!(
            "{title}\u{1f}{artist}\u{1f}{album}\u{1f}{}",
            track.duration_ms / 1000
        );
        Some(Self {
            title,
            artist,
            album,
            length: track.duration_ms,
            key,
        })
    }

    fn fits(&self, title: &str, artists: &[&str], length: Option<u64>) -> bool {
        comparable(title) == self.title
            && artists.iter().any(|name| comparable(name) == self.artist)
            && length.is_some_and(|length| length.abs_diff(self.length) <= LENGTH_SLACK_MS)
    }
}

/// One candidate recording: its albums and the ISRCs it carries.
struct Candidate {
    albums: Vec<String>,
    isrcs: Vec<String>,
}

/// The one ISRC the fitting candidates agree on. Candidates on the file's
/// album win when there are any; too many, or a disagreement, is no answer.
fn agreed(details: &Details, candidates: Vec<Candidate>) -> Option<String> {
    let same_album: Vec<&Candidate> = if details.album.is_empty() {
        Vec::new()
    } else {
        candidates
            .iter()
            .filter(|candidate| {
                candidate
                    .albums
                    .iter()
                    .any(|name| album_name(name) == details.album)
            })
            .collect()
    };
    let chosen: Vec<&Candidate> = if same_album.is_empty() {
        candidates.iter().collect()
    } else {
        same_album
    };
    if chosen.is_empty() || chosen.len() > MOST_CANDIDATES {
        return None;
    }
    let mut codes = chosen.iter().map(|candidate| {
        let mut own: Vec<String> = candidate
            .isrcs
            .iter()
            .filter_map(|code| normalize(code))
            .collect();
        own.sort();
        own.dedup();
        own
    });
    let first = codes.next()?;
    let [isrc] = first.as_slice() else {
        return None;
    };
    codes
        .all(|other| other.as_slice() == [isrc.clone()])
        .then(|| isrc.clone())
}

#[derive(Deserialize)]
struct Resolved {
    #[serde(default)]
    tracks: Vec<CatalogueTrack>,
}

#[derive(Deserialize)]
struct CatalogueTrack {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artists: Vec<String>,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    isrcs: Vec<String>,
}

/// Lyssna's catalogue: a Spotify link, an ISRC or words.
fn catalogue(client: &Client, query: &str) -> Result<Vec<CatalogueTrack>> {
    let response = crate::lyssna_account::keyed(
        client.get(format!("{}/v1/tracks/resolve", crate::lyssna_account::API)),
    )
    .query(&[("q", query)])
    .send()
    .context("Cannot reach Lyssna")?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        bail!(
            "Lyssna's catalogue answered HTTP {}",
            response.status().as_u16()
        );
    }
    Ok(response.json::<Resolved>()?.tracks)
}

#[derive(Deserialize)]
struct Recordings {
    #[serde(default)]
    recordings: Vec<Recording>,
}

#[derive(Deserialize)]
struct Recording {
    #[serde(default)]
    title: String,
    #[serde(default)]
    length: Option<u64>,
    #[serde(default)]
    isrcs: Vec<String>,
    #[serde(default, rename = "artist-credit")]
    credit: Vec<Credit>,
    #[serde(default)]
    releases: Vec<Release>,
}

#[derive(Deserialize)]
struct Credit {
    #[serde(default)]
    name: String,
    #[serde(default)]
    artist: Option<CreditArtist>,
}

#[derive(Deserialize)]
struct CreditArtist {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    title: String,
}

/// MusicBrainz's public search, for recordings that carry an ISRC.
fn musicbrainz(client: &Client, title: &str, artist: &str) -> Result<Vec<Recording>> {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!(
        "recording:\"{}\" AND artist:\"{}\" AND isrc:[* TO *]",
        quote(title),
        quote(artist)
    );
    let response = client
        .get("https://musicbrainz.org/ws/2/recording")
        .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "15")])
        .timeout(Duration::from_secs(5))
        .send()
        .context("Cannot reach MusicBrainz")?;
    if !response.status().is_success() {
        bail!("MusicBrainz answered HTTP {}", response.status().as_u16());
    }
    Ok(response.json::<Recordings>()?.recordings)
}

fn search(client: &Client, track: &Track, details: &Details) -> Option<String> {
    let artist = track.artists.first()?.name.trim();
    let query = format!("{} {artist}", track.name.trim());
    let found: Vec<Candidate> = catalogue(client, &query)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            let artists: Vec<&str> = item.artists.iter().map(String::as_str).collect();
            details.fits(&item.title, &artists, item.duration_ms)
        })
        .map(|item| Candidate {
            albums: item.album.into_iter().collect(),
            isrcs: item.isrcs,
        })
        .collect();
    if found.iter().any(|candidate| !candidate.isrcs.is_empty()) {
        return agreed(details, found);
    }
    let found: Vec<Candidate> = musicbrainz(client, track.name.trim(), artist)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            let artists: Vec<&str> = item
                .credit
                .iter()
                .flat_map(|credit| {
                    [
                        Some(credit.name.as_str()),
                        credit.artist.as_ref().map(|artist| artist.name.as_str()),
                    ]
                })
                .flatten()
                .collect();
            details.fits(&item.title, &artists, item.length)
        })
        .map(|item| Candidate {
            albums: item
                .releases
                .into_iter()
                .map(|release| release.title)
                .collect(),
            isrcs: item.isrcs,
        })
        .collect();
    agreed(details, found)
}

#[derive(Default, Deserialize, Serialize)]
struct Saved {
    key: String,
    isrc: String,
}

fn matches_path() -> Result<PathBuf> {
    Ok(crate::config::data_dir()?.join(MATCHES_FILE))
}

fn saved_matches() -> HashMap<String, Saved> {
    matches_path()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_match(uri: &str, saved: Saved) -> Result<()> {
    let path = matches_path()?;
    let mut all = saved_matches();
    all.insert(uri.to_owned(), saved);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(&all)?)?;
    Ok(())
}

/// Each search's answer and when it ends, by the file's details.
type Found = HashMap<String, (Option<String>, Instant)>;
static FOUND: Mutex<Option<Found>> = Mutex::new(None);

/// The ISRC Lyssna knows the local file by, if it can be told.
pub fn isrc(client: &Client, track: &Track) -> Option<String> {
    if !track.is_local {
        return None;
    }
    if let Some(tagged) = track.isrc.as_deref().and_then(normalize) {
        return Some(tagged);
    }
    let details = Details::of(track)?;
    if let Some(saved) = saved_matches().remove(&track.uri)
        && saved.key == details.key
        && let Some(isrc) = normalize(&saved.isrc)
    {
        return Some(isrc);
    }
    if let Ok(found) = FOUND.lock()
        && let Some((isrc, until)) = found.as_ref().and_then(|found| found.get(&details.key))
        && Instant::now() < *until
    {
        return isrc.clone();
    }
    let isrc = search(client, track, &details);
    if let Ok(mut found) = FOUND.lock() {
        let found = found.get_or_insert_with(HashMap::new);
        let now = Instant::now();
        found.retain(|_, (_, until)| now < *until);
        let keep = if isrc.is_some() { FIND_FOR } else { MISS_FOR };
        found.insert(details.key, (isrc.clone(), now + keep));
    }
    isrc
}

/// A match made by hand from an ISRC or a Spotify track link, kept only when
/// Lyssna's catalogue has that recording with the file's title, artist and
/// length.
pub fn match_by_hand(client: &Client, track: &Track, value: &str) -> Result<String> {
    if !track.is_local {
        bail!("Only local files are matched by hand");
    }
    let Some(details) = Details::of(track) else {
        bail!("The local file needs a title, artist and length to check a match");
    };
    let value = value.trim();
    let isrc = normalize(value);
    let spotify = spotify_track_id(value);
    let Some(query) = isrc.clone().or(spotify) else {
        bail!("Enter an ISRC or a Spotify song link");
    };
    let fitting: Vec<String> = catalogue(client, &query)?
        .into_iter()
        .filter(|item| {
            let artists: Vec<&str> = item.artists.iter().map(String::as_str).collect();
            details.fits(&item.title, &artists, item.duration_ms)
        })
        .flat_map(|item| item.isrcs)
        .filter_map(|code| normalize(&code))
        .collect();
    let matched = match isrc {
        Some(isrc) => fitting.contains(&isrc).then_some(isrc),
        None => {
            let mut codes = fitting;
            codes.sort();
            codes.dedup();
            (codes.len() == 1).then(|| codes.remove(0))
        }
    };
    let Some(matched) = matched else {
        bail!("Couldn't confirm one ISRC with this file's title, artist and length");
    };
    save_match(
        &track.uri,
        Saved {
            key: details.key,
            isrc: matched.clone(),
        },
    )?;
    Ok(matched)
}

fn spotify_track_id(value: &str) -> Option<String> {
    let rest = value
        .strip_prefix("spotify:track:")
        .or_else(|| {
            let path = value.split_once("open.spotify.com/")?.1;
            let path = path
                .split_once('/')
                .filter(|(first, _)| first.starts_with("intl-"))
                .map_or(path, |(_, rest)| rest);
            path.strip_prefix("track/")
        })
        .unwrap_or(value);
    let id: String = rest
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    (id.len() == 22).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Album, Artist};

    fn track() -> Track {
        Track {
            uri: "spotify:local:Panic:Pray:The+Greatest+Show:174".into(),
            name: "The Greatest Show".into(),
            artists: vec![Artist {
                name: "Panic! At The Disco".into(),
                ..Default::default()
            }],
            album: Album {
                name: "The Greatest Showman - Single".into(),
                ..Default::default()
            },
            duration_ms: 174_306,
            is_local: true,
            ..Track::default()
        }
    }

    fn candidate(album: &str, isrcs: &[&str]) -> Candidate {
        Candidate {
            albums: vec![album.into()],
            isrcs: isrcs.iter().map(|code| (*code).to_owned()).collect(),
        }
    }

    #[test]
    fn isrcs_read_the_same_however_written() {
        assert_eq!(
            normalize("us-at2-18-11534").as_deref(),
            Some("USAT21811534")
        );
        assert_eq!(normalize("USAT2181153"), None);
        assert_eq!(normalize("12AT21811534"), None);
    }

    #[test]
    fn only_a_candidate_with_the_same_title_artist_and_length_fits() {
        let details = Details::of(&track()).unwrap();
        assert!(details.fits(
            "the greatest  show",
            &["Panic! at the Disco"],
            Some(175_900)
        ));
        assert!(!details.fits("The Greatest Show", &["Panic! At The Disco"], Some(177_000)));
        assert!(!details.fits("The Greatest Show", &["Hugh Jackman"], Some(174_306)));
        assert!(!details.fits("The Greatest Show", &["Panic! At The Disco"], None));
    }

    #[test]
    fn a_match_needs_every_fitting_candidate_to_agree() {
        let details = Details::of(&track()).unwrap();
        assert_eq!(
            agreed(
                &details,
                vec![
                    candidate("Other", &["USAT21811547"]),
                    candidate("Other", &["usat21811547"])
                ]
            ),
            Some("USAT21811547".into())
        );
        assert_eq!(
            agreed(
                &details,
                vec![
                    candidate("Other", &["USAT21811547"]),
                    candidate("Other", &["USAT21811534"])
                ]
            ),
            None
        );
        // The file's own album decides between versions.
        assert_eq!(
            agreed(
                &details,
                vec![
                    candidate("The Greatest Showman", &["USAT21811534"]),
                    candidate("Deluxe", &["USAT21811547"])
                ]
            ),
            Some("USAT21811534".into())
        );
        assert_eq!(agreed(&details, Vec::new()), None);
    }

    #[test]
    fn spotify_links_give_their_track_id() {
        let id = "55PZSFcKQxXH5BOOcDA6yI";
        for value in [
            format!("spotify:track:{id}"),
            format!("https://open.spotify.com/track/{id}?si=abc"),
            format!("https://open.spotify.com/intl-de/track/{id}"),
            id.to_owned(),
        ] {
            assert_eq!(spotify_track_id(&value).as_deref(), Some(id), "{value}");
        }
        assert_eq!(
            spotify_track_id("https://open.spotify.com/album/55PZSFcKQxXH5BOOcDA6yI"),
            None
        );
    }
}
