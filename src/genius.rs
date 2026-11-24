//! Untimed lyrics from Genius for the TTML Creator: its public song search,
//! then the lyrics on the song's page.

use crate::model::Track;
use anyhow::{Context, Result, ensure};
use reqwest::blocking::Client;
use serde_json::Value;

pub fn lyrics(client: &Client, track: &Track) -> Result<String> {
    let artist = track
        .artists
        .first()
        .map(|artist| artist.name.as_str())
        .unwrap_or_default();
    ensure!(!track.name.is_empty(), "Genius needs the song's title");
    let found: Value = client
        .get("https://genius.com/api/search/song")
        .query(&[
            ("q", format!("{} {artist}", track.name)),
            ("per_page", "10".into()),
        ])
        .send()
        .context("Genius is unreachable")?
        .error_for_status()
        .context("Genius search failed")?
        .json()
        .context("Genius returned invalid data")?;
    let url = pick(&found, &track.name, artist).context("Genius has no lyrics for this song")?;
    let page = client
        .get(url)
        .send()
        .context("Genius is unreachable")?
        .error_for_status()
        .context("Genius song page failed")?
        .text()
        .context("Cannot read the Genius page")?;
    let text = clean(&extract(&page));
    ensure!(!text.is_empty(), "Genius has no lyrics for this song");
    Ok(text)
}

fn normalize(text: &str) -> String {
    let base = text.split(" (").next().unwrap_or(text);
    let base = base.split(" - ").next().unwrap_or(base);
    base.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Genius writes many artists as "宝鐘マリン (Houshou Marine)", either of
/// which Spotify may use.
fn names(artist: &str) -> Vec<String> {
    let mut names = vec![normalize(artist)];
    if let Some((_, alias)) = artist.split_once(" (") {
        names.push(normalize(alias.trim_end_matches(')')));
    }
    names
}

/// The hit whose title and main artist match; otherwise the first by the
/// artist. Only genius.com song pages are followed.
fn pick(found: &Value, title: &str, artist: &str) -> Option<String> {
    let hits: Vec<&Value> = found["response"]["sections"]
        .as_array()?
        .iter()
        .flat_map(|section| section["hits"].as_array().into_iter().flatten())
        .map(|hit| &hit["result"])
        .filter(|result| {
            result["url"]
                .as_str()
                .and_then(|url| url::Url::parse(url).ok())
                .is_some_and(|url| url.scheme() == "https" && url.host_str() == Some("genius.com"))
        })
        .collect();
    let (title, artist) = (normalize(title), normalize(artist));
    let by_artist = |result: &Value| {
        artist.is_empty()
            || names(
                result["primary_artist"]["name"]
                    .as_str()
                    .unwrap_or_default(),
            )
            .contains(&artist)
    };
    hits.iter()
        .find(|result| {
            by_artist(result) && normalize(result["title"].as_str().unwrap_or_default()) == title
        })
        .or_else(|| hits.iter().find(|result| by_artist(result)))
        .and_then(|result| result["url"].as_str())
        .map(str::to_owned)
}

const VOID: [&str; 6] = ["br", "img", "hr", "input", "meta", "link"];

/// Text inside the page's lyrics containers, leaving out the parts Genius
/// marks as not lyrics (contributors, translations and the like).
fn extract(html: &str) -> String {
    let mut out = String::new();
    // Each open element inside a container: its name and whether it is left out.
    let mut open: Vec<(String, bool)> = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        let text = &rest[..start];
        if !open.is_empty() && !open.iter().any(|(_, skip)| *skip) {
            out.push_str(&decode(text));
        }
        let Some(end) = rest[start..].find('>') else {
            break;
        };
        let tag = &rest[start + 1..start + end];
        rest = &rest[start + end + 1..];
        if tag.starts_with('!') {
            continue;
        }
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect();
        if name == "br" {
            if !open.is_empty() && !open.iter().any(|(_, skip)| *skip) {
                out.push('\n');
            }
            continue;
        }
        if closing {
            if let Some(index) = open.iter().rposition(|(open, _)| *open == name) {
                open.truncate(index);
                if open.is_empty() {
                    out.push('\n');
                }
            }
            continue;
        }
        if VOID.contains(&name.as_str()) || tag.ends_with('/') {
            continue;
        }
        if open.is_empty() {
            if tag.contains("data-lyrics-container=\"true\"") {
                open.push((name, false));
            }
        } else {
            open.push((name, tag.contains("data-exclude-from-selection=\"true\"")));
        }
    }
    out
}

fn decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let entity = rest[1..]
            .find(';')
            .filter(|&end| end <= 10)
            .map(|end| &rest[1..=end]);
        let character = entity.and_then(|entity| match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        });
        match (entity, character) {
            (Some(entity), Some(character)) => {
                out.push(character);
                rest = &rest[entity.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// One lyric per line, blank lines dropped. Section headers like [Chorus]
/// stay on their own lines; the TTML Creator reads them as section names.
fn clean(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    // Japanese pages open with a title card such as "[宝鐘マリン「曲」歌詞]",
    // which is neither a lyric nor a section.
    let skip = usize::from(
        lines
            .first()
            .is_some_and(|line| line.starts_with('[') && line.ends_with("歌詞]")),
    );
    lines[skip..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_japanese_title_card_is_left_out() {
        assert_eq!(
            clean(
                "[宝鐘マリン「A Horny Money World ～伝説の夜～」歌詞]\n[Intro]\n金ピカめっちゃちゅきぃ」"
            ),
            "[Intro]\n金ピカめっちゃちゅきぃ」"
        );
        assert_eq!(clean("[Intro]\nLine"), "[Intro]\nLine");
    }

    #[test]
    fn lyrics_come_from_the_containers_with_section_headers() {
        let page = r#"<html><div data-lyrics-container="true" class="a"><div data-exclude-from-selection="true"><span>26 Contributors</span><div>Translations</div></div>[Verse 1]<br/>I wish I was <i>more</i> than just<br>Someone you&#x27;d walk by &amp; forget<br></div><p>Not lyrics</p><div data-lyrics-container="true">[Chorus]<br><a href="/x"><span>Drunk text</span></a><br/></div></html>"#;
        assert_eq!(
            clean(&extract(page)),
            "[Verse 1]\nI wish I was more than just\nSomeone you'd walk by & forget\n[Chorus]\nDrunk text"
        );
    }

    #[test]
    fn the_matching_song_is_picked_over_translations() {
        let found = json!({"response":{"sections":[{"hits":[
            {"result":{"title":"Henry Moodie - drunk text (Tradução em Português)","primary_artist":{"name":"Genius Brasil Traduções"},"url":"https://genius.com/translation"}},
            {"result":{"title":"drunk text","primary_artist":{"name":"Henry Moodie"},"url":"https://genius.com/Henry-moodie-drunk-text-lyrics"}},
            {"result":{"title":"drunk text","primary_artist":{"name":"Henry Moodie"},"url":"https://evil.example/drunk"}}
        ]}]}});
        assert_eq!(
            pick(&found, "drunk text", "Henry Moodie").as_deref(),
            Some("https://genius.com/Henry-moodie-drunk-text-lyrics")
        );
        assert_eq!(
            pick(&found, "drunk text - Acoustic", "Henry Moodie").as_deref(),
            Some("https://genius.com/Henry-moodie-drunk-text-lyrics")
        );
        assert_eq!(pick(&found, "drunk text", "Someone Else"), None);
    }

    #[test]
    fn an_artist_matches_by_either_of_its_genius_names() {
        let found = json!({"response":{"sections":[{"hits":[
            {"result":{"title":"宝鐘マリン (Houshou Marine) - A Horny Money World ～伝説の夜～ (Romanized)","primary_artist":{"name":"Genius Romanizations"},"url":"https://genius.com/romanized"}},
            {"result":{"title":"A Horny Money World ～伝説の夜～","primary_artist":{"name":"宝鐘マリン (Houshou Marine)"},"url":"https://genius.com/marine"}}
        ]}]}});
        for artist in ["Houshou Marine", "宝鐘マリン"] {
            assert_eq!(
                pick(&found, "A Horny Money World ～伝説の夜～", artist).as_deref(),
                Some("https://genius.com/marine")
            );
        }
    }

    /// Live check: `cargo test genius_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn genius_live() {
        let client = crate::auth::http_client().unwrap();
        let track = Track {
            name: "drunk text".into(),
            artists: vec![crate::model::Artist {
                name: "Henry Moodie".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let text = lyrics(&client, &track).unwrap();
        println!("{}", text.lines().take(4).collect::<Vec<_>>().join(" / "));
        assert!(text.lines().count() > 10);
    }
}
