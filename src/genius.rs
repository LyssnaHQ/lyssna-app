//! Untimed lyrics from Genius for the TTML Creator: its public song search,
//! then the lyrics on the song's page.

use crate::model::Track;
use anyhow::{Context, Result, ensure};
use reqwest::blocking::Client;
use serde_json::Value;

/// Marks around italic and bold text when asked for: Genius sets the
/// second singer in italic and the third in bold.
pub const ITALIC: (char, char) = ('\u{E000}', '\u{E001}');
pub const BOLD: (char, char) = ('\u{E002}', '\u{E003}');

pub fn lyrics(client: &Client, track: &Track, styled: bool) -> Result<String> {
    fetch(client, track, "", pick, styled)
}

/// The song's lyrics as Genius Romanizations writes them out in Latin letters.
pub fn romanized(client: &Client, track: &Track) -> Result<String> {
    fetch(client, track, " romanized", pick_romanized, false)
}

fn fetch(
    client: &Client,
    track: &Track,
    extra: &str,
    pick: fn(&Value, &str, &str) -> Option<String>,
    styled: bool,
) -> Result<String> {
    let artist = track
        .artists
        .first()
        .map(|artist| artist.name.as_str())
        .unwrap_or_default();
    ensure!(!track.name.is_empty(), "Genius needs the song's title");
    let found: Value = client
        .get("https://genius.com/api/search/song")
        .query(&[
            ("q", format!("{} {artist}{extra}", track.name)),
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
    let text = clean(&extract(&page, styled));
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

fn genius_hits(found: &Value) -> Option<Vec<&Value>> {
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
    Some(hits)
}

/// The hit whose title and main artist match; otherwise the first by the
/// artist. Only genius.com song pages are followed.
fn pick(found: &Value, title: &str, artist: &str) -> Option<String> {
    let hits = genius_hits(found)?;
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

/// Genius Romanizations titles its pages "Artist - Title ft. Guest (Romanized)".
fn pick_romanized(found: &Value, title: &str, artist: &str) -> Option<String> {
    let letters = |text: &str| -> String {
        text.chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    };
    let (title, artist) = (normalize(title), letters(artist));
    genius_hits(found)?
        .into_iter()
        .find(|result| {
            let Some((by, song)) = result["title"]
                .as_str()
                .and_then(|name| name.strip_suffix(" (Romanized)"))
                .and_then(|name| name.split_once(" - "))
            else {
                return false;
            };
            let song = [" ft. ", " feat. ", " (ft. ", " (feat. "]
                .iter()
                .fold(song, |song, mark| song.split(mark).next().unwrap_or(song));
            result["primary_artist"]["name"] == "Genius Romanizations"
                && normalize(song) == title
                && (artist.is_empty() || letters(by).contains(&artist))
        })
        .and_then(|result| result["url"].as_str())
        .map(str::to_owned)
}

const VOID: [&str; 6] = ["br", "img", "hr", "input", "meta", "link"];

/// Text inside the page's lyrics containers, leaving out the parts Genius
/// marks as not lyrics (contributors, translations and the like).
fn extract(html: &str, styled: bool) -> String {
    let marks = |name: &str| match name {
        "i" | "em" if styled => Some(ITALIC),
        "b" | "strong" if styled => Some(BOLD),
        _ => None,
    };
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
                if let Some((_, close)) = marks(&name)
                    && !open.iter().any(|(_, skip)| *skip)
                {
                    out.push(close);
                }
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
            let skip = tag.contains("data-exclude-from-selection=\"true\"");
            if let Some((start, _)) = marks(&name)
                && !skip
                && !open.iter().any(|(_, skip)| *skip)
            {
                out.push(start);
            }
            open.push((name, skip));
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
    lines[skip..]
        .iter()
        .map(|line| latin_twins(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Genius swaps some letters of Latin words for Cyrillic ones that look
/// the same ("diе"), which breaks matching and imports the wrong letters.
/// Words with no Latin letters, such as Russian lyrics, stay as they are.
fn latin_twins(line: &str) -> String {
    let twin = |letter: char| match letter {
        'а' => 'a',
        'е' => 'e',
        'о' => 'o',
        'р' => 'p',
        'с' => 'c',
        'у' => 'y',
        'х' => 'x',
        'і' => 'i',
        'ј' => 'j',
        'ѕ' => 's',
        'ԁ' => 'd',
        'ӏ' => 'l',
        'А' => 'A',
        'В' => 'B',
        'Е' => 'E',
        'К' => 'K',
        'М' => 'M',
        'Н' => 'H',
        'О' => 'O',
        'Р' => 'P',
        'С' => 'C',
        'Т' => 'T',
        'Х' => 'X',
        'Ѕ' => 'S',
        'І' => 'I',
        'Ј' => 'J',
        other => other,
    };
    let mut out = String::with_capacity(line.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.chars().any(|letter| letter.is_ascii_alphabetic()) {
            out.extend(word.chars().map(twin));
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for letter in line.chars() {
        if letter.is_alphabetic() {
            word.push(letter);
        } else {
            flush(&mut word, &mut out);
            out.push(letter);
        }
    }
    flush(&mut word, &mut out);
    out
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
    fn cyrillic_letters_in_latin_words_are_put_back() {
        assert_eq!(
            clean("Rip th\u{0435} fabric, di\u{0435}\nвсе равно"),
            "Rip the fabric, die\nвсе равно"
        );
    }

    #[test]
    fn lyrics_come_from_the_containers_with_section_headers() {
        let page = r#"<html><div data-lyrics-container="true" class="a"><div data-exclude-from-selection="true"><span>26 Contributors</span><div>Translations</div></div>[Verse 1]<br/>I wish I was <i>more</i> than just<br>Someone you&#x27;d walk by &amp; forget<br></div><p>Not lyrics</p><div data-lyrics-container="true">[Chorus]<br><a href="/x"><span>Drunk text</span></a><br/></div></html>"#;
        assert_eq!(
            clean(&extract(page, false)),
            "[Verse 1]\nI wish I was more than just\nSomeone you'd walk by & forget\n[Chorus]\nDrunk text"
        );
    }

    #[test]
    fn italic_and_bold_are_marked_when_asked_for() {
        let page = r#"<div data-lyrics-container="true">[Verse 1: Ashnikko, <i>Konomi</i>]<br>Plain <i>soft</i> and <b>loud</b><br></div>"#;
        assert_eq!(
            clean(&extract(page, true)),
            "[Verse 1: Ashnikko, \u{E000}Konomi\u{E001}]\nPlain \u{E000}soft\u{E001} and \u{E002}loud\u{E003}"
        );
        assert_eq!(
            clean(&extract(page, false)),
            "[Verse 1: Ashnikko, Konomi]\nPlain soft and loud"
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

    #[test]
    fn the_romanized_page_is_picked_by_title_and_either_artist_name() {
        let found = json!({"response":{"sections":[{"hits":[
            {"result":{"title":"Recollect","primary_artist":{"name":"鈴木このみ (Konomi Suzuki)"},"url":"https://genius.com/original"}},
            {"result":{"title":"鈴木このみ (Konomi Suzuki) - Recollect ft. Ashnikko (English Translation)","primary_artist":{"name":"Genius English Translations"},"url":"https://genius.com/english"}},
            {"result":{"title":"鈴木このみ (Konomi Suzuki) - Recollect ft. Ashnikko (Romanized)","primary_artist":{"name":"Genius Romanizations"},"url":"https://genius.com/romanized"}}
        ]}]}});
        for artist in ["Konomi Suzuki", "鈴木このみ"] {
            assert_eq!(
                pick_romanized(&found, "Recollect", artist).as_deref(),
                Some("https://genius.com/romanized")
            );
        }
        assert_eq!(pick_romanized(&found, "Recollect", "Someone Else"), None);
        assert_eq!(pick_romanized(&found, "Other Song", "Konomi Suzuki"), None);
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
        let text = lyrics(&client, &track, false).unwrap();
        println!("{}", text.lines().take(4).collect::<Vec<_>>().join(" / "));
        assert!(text.lines().count() > 10);
    }
}
