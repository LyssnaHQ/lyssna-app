use std::{collections::HashMap, fs, path::Path};

use anyhow::{Context, Result, bail, ensure};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{config::data_dir, model::Track};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Lyrics {
    pub lines: Vec<Line>,
    pub source: String,
    pub instrumental: bool,
    pub synced: bool,
    #[serde(default)]
    pub attribution: Option<Attribution>,
    #[serde(default)]
    pub songwriters: Vec<String>,
    /// Lyssna community members credited for these lyrics, largest share first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credits: Vec<Credit>,
    /// The Lyssna song these lyrics belong to, for counting plays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song_id: Option<String>,
    /// The credit line a source asks to be shown with its lyrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_credit: Option<SourceCredit>,
    /// Apple Music's own sync, named so an edit of it can be uploaded as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apple_original: Option<AppleOriginal>,
}

/// Which Apple Music sync lyrics came from: its ID and the SHA-256 of the TTML as Lyssna served it.
#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct AppleOriginal {
    pub apple_id: String,
    pub sha256: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct SourceCredit {
    pub text: String,
    #[serde(default)]
    pub url: String,
}

/// A deleted account has no user ID, username or avatar.
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct Credit {
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub share: f64,
    #[serde(default)]
    pub text_share: f64,
    #[serde(default)]
    pub timing_share: f64,
    #[serde(default)]
    pub original: bool,
    /// Set for a credit that isn't an account: `apple_music` for Apple Music's original sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Attribution {
    #[serde(alias = "Uploader")]
    pub uploader: Option<Contributor>,
    #[serde(alias = "Maker")]
    pub maker: Option<Contributor>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Contributor {
    #[serde(default)]
    pub id: String,
    pub username: String,
    /// Discord username from the person's public profile, when the lyrics
    /// metadata named them by display name instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discord: Option<String>,
    pub url: Option<String>,
    pub avatar: Option<String>,
    #[serde(default, rename = "hasProfileBanner")]
    pub has_profile_banner: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Line {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub translation: String,
    pub romanization: String,
    pub words: Vec<Word>,
    pub background: bool,
    pub opposite: bool,
    /// In a section several voices sing, which one sings this line after the
    /// first: `second` (shown italic) or `third` (bold), like Genius.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sung_by: Option<String>,
    /// The song section this line starts (`itunes:songPart`), like "Chorus".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Who sings the section this line starts (`lyssna:singer`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_singer: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Word {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    /// Like the line's, for a word another voice sings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sung_by: Option<String>,
}

impl Lyrics {
    pub fn active_line(&self, position_ms: u64) -> Option<usize> {
        if !self.synced {
            return None;
        }
        let index = self
            .lines
            .partition_point(|line| line.start_ms <= position_ms);
        (0..index)
            .rev()
            .find(|index| !self.lines[*index].background && position_ms < self.lines[*index].end_ms)
    }
}

pub(crate) fn timestamp(value: &str) -> Option<u64> {
    let value = value.trim();
    let seconds = if let Some(value) = value.strip_suffix("ms") {
        value.parse::<f64>().ok()? / 1000.0
    } else if let Some(value) = value.strip_suffix('s') {
        value.parse::<f64>().ok()?
    } else {
        let parts: Vec<_> = value.split(':').collect();
        match parts.as_slice() {
            [seconds] => seconds.parse::<f64>().ok()?,
            [minutes, seconds] => {
                minutes.parse::<f64>().ok()? * 60.0 + seconds.parse::<f64>().ok()?
            }
            [hours, minutes, seconds] => {
                hours.parse::<f64>().ok()? * 3600.0
                    + minutes.parse::<f64>().ok()? * 60.0
                    + seconds.parse::<f64>().ok()?
            }
            _ => return None,
        }
    };
    (seconds.is_finite() && (0.0..=604_800.0).contains(&seconds))
        .then_some((seconds * 1000.0).round() as u64)
}

/// Some TTML editors write a paragraph or background container that ends
/// before it begins (e.g. `end="00:00.000"`), which Lyssna's API rejects.
/// Such a span takes its timing from the words inside it; everything else
/// in the file is left byte for byte.
pub fn repair_container_timing(source: &str) -> String {
    let Ok(document) = roxmltree::Document::parse(source) else {
        return source.to_owned();
    };
    let timed = |node: roxmltree::Node<'_, '_>| {
        Some((
            timestamp(node.attribute("begin")?)?,
            timestamp(node.attribute("end")?)?,
        ))
    };
    let mut edits = Vec::new();
    for node in document
        .descendants()
        .filter(|node| matches!(node.tag_name().name(), "p" | "span"))
    {
        let (Some(begin), Some(end)) = (node.attribute_node("begin"), node.attribute_node("end"))
        else {
            continue;
        };
        if timed(node).is_none_or(|(start, finish)| finish >= start) {
            continue;
        }
        let words: Vec<(u64, u64)> = node
            .descendants()
            .skip(1)
            .filter(|word| {
                word.tag_name().name() == "span" && !word.children().any(|child| child.is_element())
            })
            .filter_map(timed)
            .filter(|(start, finish)| finish >= start)
            .collect();
        let (Some(first), Some(last)) = (
            words.iter().map(|word| word.0).min(),
            words.iter().map(|word| word.1).max(),
        ) else {
            continue;
        };
        let clock = |ms: u64| format!("{:02}:{:02}.{:03}", ms / 60_000, ms / 1000 % 60, ms % 1000);
        edits.push((begin.range_value(), clock(first)));
        edits.push((end.range_value(), clock(last)));
    }
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut repaired = source.to_owned();
    for (range, value) in edits {
        repaired.replace_range(range, &value);
    }
    repaired
}

pub fn parse_lrc(source: &str, duration_ms: u64) -> Result<Lyrics> {
    let mut lines = Vec::new();
    let offset = source
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("[offset:")?
                .strip_suffix(']')?
                .parse::<i64>()
                .ok()
        })
        .unwrap_or(0);
    for raw in source.lines() {
        let mut remainder = raw.trim();
        let mut times = Vec::new();
        while let Some(start) = remainder.strip_prefix('[') {
            let Some(end) = start.find(']') else {
                break;
            };
            let tag = &start[..end];
            if let Some(time) = timestamp(tag)
                .filter(|_| !tag.trim().ends_with(char::is_numeric) || tag.contains(':'))
            {
                times.push(time.saturating_add_signed(offset));
            }
            remainder = &start[end + 1..];
        }
        if remainder.trim().is_empty() {
            continue;
        }
        for start_ms in times {
            lines.push(Line {
                start_ms,
                text: remainder.trim().to_owned(),
                ..Line::default()
            });
        }
    }
    ensure!(
        !lines.is_empty(),
        "No timestamped lyrics found in this LRC file"
    );
    lines.sort_by_key(|line| line.start_ms);
    for index in 0..lines.len() {
        lines[index].end_ms = lines[index + 1..]
            .iter()
            .find(|line| line.start_ms > lines[index].start_ms)
            .map_or(
                if duration_ms > lines[index].start_ms {
                    duration_ms
                } else {
                    lines[index].start_ms + 5000
                },
                |line| line.start_ms,
            );
    }
    Ok(Lyrics {
        lines,
        source: "Local LRC".into(),
        synced: true,
        ..Lyrics::default()
    })
}

fn attribute<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}

/// The singer a paragraph's section names (`lyssna:singer`), if any.
fn section_singer<'a>(paragraph: roxmltree::Node<'a, 'a>) -> Option<&'a str> {
    paragraph
        .ancestors()
        .find(|node| node.has_tag_name("div"))
        .and_then(|div| attribute(div, "singer"))
        .map(str::trim)
        .filter(|singer| !singer.is_empty())
}

/// "Kanye West, Kanye West & JAY-Z" as each artist once, in order.
fn artist_names(singer: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for piece in singer.split([',', '&']) {
        let lower = piece.to_lowercase();
        let mut rest = piece;
        let mut offset = 0;
        let mut parts = Vec::new();
        while let Some(at) = lower[offset..].find(" and ") {
            parts.push(&rest[..at]);
            rest = &rest[at + 5..];
            offset += at + 5;
        }
        parts.push(rest);
        for name in parts
            .into_iter()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            if !names.iter().any(|known| known == name) {
                names.push(name.to_owned());
            }
        }
    }
    names
}

/// Which artist each voice (`ttm:agent`) is, from the sections only one
/// artist sings: whoever sings most of that voice's lines there.
fn voice_artists(document: &roxmltree::Document) -> HashMap<String, String> {
    let mut counts: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for paragraph in document.descendants().filter(|node| node.has_tag_name("p")) {
        let (Some(agent), Some(singer)) =
            (attribute(paragraph, "agent"), section_singer(paragraph))
        else {
            continue;
        };
        let names = artist_names(singer);
        if let [name] = names.as_slice() {
            *counts
                .entry(agent.to_owned())
                .or_default()
                .entry(name.clone())
                .or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter_map(|(agent, tally)| {
            tally
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .map(|(name, _)| (agent, name))
        })
        .collect()
}

/// The voices a section heading lists, in order. Genius separates them
/// with commas when one is a group ("Kanye West, Kanye West & JAY-Z,
/// JAY-Z"); otherwise each artist is its own voice ("A & B").
fn voices(singer: &str) -> Vec<Vec<String>> {
    if singer.contains(',') {
        singer
            .split(',')
            .map(artist_names)
            .filter(|names| !names.is_empty())
            .collect()
    } else {
        artist_names(singer)
            .into_iter()
            .map(|name| vec![name])
            .collect()
    }
}

/// Genius styles a section's voices plain, italic, bold in the order its
/// heading lists them; `second` and `third` are the italic and bold ones.
fn voice_index(
    paragraph: roxmltree::Node<'_, '_>,
    agent: Option<&str>,
    artists: &HashMap<String, String>,
) -> Option<usize> {
    let voices = voices(section_singer(paragraph)?);
    if voices.len() < 2 {
        return None;
    }
    let agent = agent?;
    if agent == "v1000" {
        voices.iter().position(|voice| voice.len() > 1)
    } else {
        let artist = artists.get(agent)?;
        voices
            .iter()
            .position(|voice| voice.len() == 1 && &voice[0] == artist)
    }
}

const VOICE_STYLES: [&str; 3] = ["first", "second", "third"];

fn sung_by(
    paragraph: roxmltree::Node<'_, '_>,
    agent: Option<&str>,
    artists: &HashMap<String, String>,
) -> Option<String> {
    voice_index(paragraph, agent, artists)
        .filter(|index| *index > 0)
        .and_then(|index| VOICE_STYLES.get(index))
        .map(|style| (*style).to_owned())
}

/// The section a paragraph starts, when it is the first in a tagged div.
fn section_start(paragraph: roxmltree::Node<'_, '_>) -> Option<(String, Option<String>)> {
    let div = paragraph
        .ancestors()
        .find(|node| node.has_tag_name("div"))?;
    let part = attribute(div, "songPart").or_else(|| attribute(div, "song-part"))?;
    let first = div.descendants().find(|node| node.has_tag_name("p"))?;
    (first == paragraph).then(|| {
        (
            part.to_owned(),
            section_singer(paragraph).map(str::to_owned),
        )
    })
}

fn annotation(node: roxmltree::Node<'_, '_>) -> bool {
    attribute(node, "role").is_some_and(|role| {
        role.contains("translation") || role.contains("roman") || role.contains("transliteration")
    })
}

fn node_text(node: roxmltree::Node<'_, '_>, skip_annotations: bool) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter(|child| {
            !skip_annotations
                || !child
                    .ancestors()
                    .take_while(|parent| *parent != node)
                    .any(annotation)
        })
        .filter_map(|child| child.text())
        .collect::<String>()
}

/// Common lyric TTML uses absolute clock times, some (lrc.red) plain seconds
/// like `5.050`. Offset values with a unit like `500ms` within a paragraph
/// are relative to that paragraph's begin time.
fn child_time(node: roxmltree::Node<'_, '_>, name: &str, parent_start: u64) -> Option<u64> {
    let value = attribute(node, name)?;
    timestamp(value).map(|time| {
        if value.trim().ends_with('s') {
            parent_start.saturating_add(time)
        } else {
            time
        }
    })
}

/// Narrow a line's timing to its timed words, so background vocals light up
/// with their own syllables rather than with the whole lead line.
pub fn fit_to_words(line: &mut Line) {
    if let (Some(first), Some(last)) = (line.words.first(), line.words.last()) {
        line.start_ms = first.start_ms;
        line.end_ms = last.end_ms.max(first.start_ms);
    }
}

/// Background vocals already render smaller beneath the lead, so drop the
/// parentheses sources wrap them in, e.g. `(oh yeah)` becomes `oh yeah`.
/// Doubled brackets go too: hand-made TTML sometimes closes with a stray
/// `))` unit of its own.
pub fn strip_background_parentheses(line: &mut Line) {
    fn unwrap(text: &str) -> String {
        text.trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim()
            .to_owned()
    }
    line.text = unwrap(&line.text);
    line.romanization = unwrap(&line.romanization);
    if let Some(first) = line.words.first_mut() {
        let leading = first.text.len() - first.text.trim_start().len();
        let kept = first.text[leading..].trim_start_matches('(').to_owned();
        first.text.replace_range(leading.., &kept);
    }
    if let Some(last) = line.words.last_mut() {
        let trailing = &last.text[last.text.trim_end().len()..];
        last.text = format!("{}{trailing}", last.text.trim_end().trim_end_matches(')'));
    }
    line.words.retain(|word| !word.text.trim().is_empty());
}

/// Word-timed lines sing a bracketed aside inside a sentence, as in
/// `I was a girl (I was a girl)`, as background vocals: the bracketed words
/// move to a background line right after the lead. A line that is all in
/// brackets stands alone and stays a lead line, and line-timed lyrics are
/// left alone because their words carry no timing of their own.
pub fn split_bracketed_background(lyrics: &mut Lyrics) {
    if !lyrics.synced {
        return;
    }
    let mut lines = Vec::with_capacity(lyrics.lines.len());
    for line in std::mem::take(&mut lyrics.lines) {
        match split_bracketed_line(&line) {
            Some((lead, background)) => {
                lines.push(lead);
                lines.push(background);
            }
            None => lines.push(line),
        }
    }
    lyrics.lines = lines;
}

fn split_bracketed_line(line: &Line) -> Option<(Line, Line)> {
    if line.background || line.words.len() < 2 {
        return None;
    }
    let mut depth = 0usize;
    let bracketed: Vec<bool> = line
        .words
        .iter()
        .map(|word| {
            let text = word.text.trim();
            let inside = depth > 0 || text.starts_with('(');
            for character in text.chars() {
                match character {
                    '(' => depth += 1,
                    ')' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            inside
        })
        .collect();
    if bracketed.iter().all(|inside| *inside) || !bracketed.iter().any(|inside| *inside) {
        return None;
    }
    let mut lead = Vec::new();
    let mut background = Vec::new();
    for (word, inside) in line.words.iter().zip(&bracketed) {
        if *inside {
            let mut word = word.clone();
            word.text
                .retain(|character| character != '(' && character != ')');
            if background.is_empty() {
                word.text = word.text.trim_start().to_owned();
            }
            if !word.text.trim().is_empty() {
                background.push(word);
            }
        } else {
            let mut word = word.clone();
            let joined = lead
                .last()
                .is_none_or(|previous: &Word| previous.text.ends_with(char::is_whitespace));
            if joined {
                word.text = word.text.trim_start().to_owned();
            }
            lead.push(word);
        }
    }
    if lead.is_empty() || background.is_empty() {
        return None;
    }
    let joined = |words: &[Word]| {
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut background = Line {
        start_ms: 0,
        end_ms: 0,
        text: joined(&background),
        translation: String::new(),
        romanization: String::new(),
        words: background,
        background: true,
        opposite: line.opposite,
        sung_by: line.sung_by.clone(),
        ..Line::default()
    };
    fit_to_words(&mut background);
    let lead = Line {
        text: joined(&lead),
        words: lead,
        ..line.clone()
    };
    Some((lead, background))
}

/// Sort lines chronologically by their source group while keeping each
/// background vocal directly after the lead line it belongs to.
pub fn order_with_background(mut lines: Vec<(u64, Line)>) -> Vec<Line> {
    lines.sort_by_key(|(group_start, _)| *group_start);
    lines.into_iter().map(|(_, line)| line).collect()
}

pub fn parse_ttml(source: &str, duration_ms: u64) -> Result<Lyrics> {
    let document = roxmltree::Document::parse(source).context("Invalid TTML XML")?;
    // Duets: the first `person` agent declared in the head is the lead (else
    // `v1`); other single agents sing opposite. Group agents such as `v1000`
    // stay on the lead side.
    let lead_agent = document
        .descendants()
        .filter(|node| node.has_tag_name("agent") && attribute(*node, "type") == Some("person"))
        .find_map(|agent| attribute(agent, "id"))
        .unwrap_or("v1");
    // Apple-style heads carry per-line romanization and translation keyed by
    // the paragraph's `itunes:key`.
    let mut head_romanization = HashMap::new();
    let mut head_translation = HashMap::new();
    for text in document
        .descendants()
        .filter(|node| node.has_tag_name("text"))
    {
        let Some(key) = attribute(text, "for") else {
            continue;
        };
        let value = node_text(text, true).trim().to_owned();
        match text
            .ancestors()
            .find_map(|ancestor| match ancestor.tag_name().name() {
                "transliteration" => Some(true),
                "translation" => Some(false),
                _ => None,
            }) {
            Some(true) => head_romanization.insert(key, value),
            Some(false) => head_translation.insert(key, value),
            None => None,
        };
    }
    let artists = voice_artists(&document);
    let mut lines = Vec::new();
    for paragraph in document.descendants().filter(|node| node.has_tag_name("p")) {
        let Some(start_ms) = attribute(paragraph, "begin").and_then(timestamp) else {
            continue;
        };
        let end_ms = attribute(paragraph, "end")
            .and_then(timestamp)
            .or_else(|| {
                attribute(paragraph, "dur")
                    .and_then(timestamp)
                    .map(|time| start_ms + time)
            })
            .unwrap_or(if duration_ms > start_ms {
                duration_ms
            } else {
                start_ms + 5000
            });
        // Some exported files carry a bogus paragraph end (e.g. 00:00.000).
        // Recover from word timings below; drop the paragraph if it has none.
        let broken_end = end_ms < start_ms;
        let end_ms = end_ms.max(start_ms);
        let opposite = attribute(paragraph, "agent")
            .is_some_and(|agent| agent != lead_agent && !agent.ends_with("000"));
        let sung_by = sung_by(paragraph, attribute(paragraph, "agent"), &artists);
        let (section, section_singer) = section_start(paragraph).unzip();
        let mut line = Line {
            start_ms,
            end_ms,
            text: node_text(paragraph, true).trim().to_owned(),
            background: attribute(paragraph, "role") == Some("x-bg"),
            opposite,
            sung_by: sung_by.clone(),
            section,
            section_singer: section_singer.flatten(),
            ..Line::default()
        };
        let blank_background = Line {
            start_ms,
            end_ms,
            background: true,
            opposite,
            sung_by,
            ..Line::default()
        };
        // Each `x-bg` span is its own background vocal, not one merged line.
        let mut backgrounds: Vec<(roxmltree::NodeId, Line)> = Vec::new();
        for span in paragraph
            .descendants()
            .filter(|node| node.has_tag_name("span"))
        {
            let owner = span
                .ancestors()
                .take_while(|parent| *parent != paragraph)
                .find(|parent| attribute(*parent, "role") == Some("x-bg"));
            let target = match owner {
                Some(owner) => {
                    let id = owner.id();
                    if !backgrounds.iter().any(|(owner, _)| *owner == id) {
                        // A backing vocal can name its own voice.
                        let voice = attribute(owner, "agent")
                            .and_then(|agent| voice_index(paragraph, Some(agent), &artists))
                            .and_then(|index| VOICE_STYLES.get(index))
                            .filter(|style| **style != "first")
                            .map(|style| (*style).to_owned());
                        let own = attribute(owner, "agent").is_some();
                        backgrounds.push((
                            id,
                            Line {
                                sung_by: if own {
                                    voice
                                } else {
                                    blank_background.sung_by.clone()
                                },
                                ..blank_background.clone()
                            },
                        ));
                    }
                    &mut backgrounds
                        .iter_mut()
                        .find(|(owner, _)| *owner == id)
                        .expect("background just added")
                        .1
                }
                None => &mut line,
            };
            let role = attribute(span, "role").unwrap_or_default();
            if role.contains("translation") {
                target.translation = node_text(span, false).trim().into();
                continue;
            }
            if role.contains("roman") || role.contains("transliteration") {
                target.romanization = node_text(span, false).trim().into();
                continue;
            }
            if role == "x-bg" {
                // An untimed background span still shows as a static line.
                if !span
                    .descendants()
                    .any(|child| child != span && attribute(child, "begin").is_some())
                {
                    target.text = node_text(span, true).trim().into();
                }
                continue;
            }
            if span
                .ancestors()
                .take_while(|parent| *parent != paragraph)
                .any(annotation)
            {
                continue;
            }
            if span
                .children()
                .any(|child| child.is_element() && attribute(child, "begin").is_some())
            {
                continue;
            }
            if let Some(word_start) = child_time(span, "begin", start_ms) {
                let word_end = child_time(span, "end", start_ms).unwrap_or(end_ms);
                let mut text = node_text(span, true);
                // Syllables of one word sit in adjacent spans; whitespace text
                // between spans is what separates words.
                let spaced = span
                    .prev_sibling()
                    .and_then(|sibling| sibling.text())
                    .is_some_and(|between| between.chars().any(char::is_whitespace));
                if spaced
                    && target
                        .words
                        .last()
                        .is_some_and(|word| !word.text.ends_with(char::is_whitespace))
                    && !text.starts_with(char::is_whitespace)
                {
                    text.insert(0, ' ');
                }
                if !text.trim().is_empty() && word_end >= word_start {
                    let word_agent = attribute(span, "agent");
                    target.words.push(Word {
                        start_ms: word_start,
                        end_ms: word_end,
                        text,
                        // `first` too, so a word sung by the first voice in a
                        // line another voice sings shows plain.
                        sung_by: word_agent
                            .filter(|agent| Some(*agent) != attribute(paragraph, "agent"))
                            .and_then(|agent| voice_index(paragraph, Some(agent), &artists))
                            .and_then(|index| VOICE_STYLES.get(index))
                            .map(|style| (*style).to_owned()),
                    });
                }
            }
        }
        for target in std::iter::once(&mut line)
            .chain(backgrounds.iter_mut().map(|(_, background)| background))
        {
            if !target.words.is_empty() {
                target.text = target
                    .words
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<String>()
                    .trim()
                    .to_owned();
            }
            if target.background {
                strip_background_parentheses(target);
            }
            fit_to_words(target);
        }
        if broken_end && line.words.is_empty() {
            continue;
        }
        if let Some(key) = attribute(paragraph, "key") {
            if line.romanization.is_empty()
                && let Some(text) = head_romanization.get(key)
            {
                line.romanization = text.clone();
            }
            if line.translation.is_empty()
                && let Some(text) = head_translation.get(key)
            {
                line.translation = text.clone();
            }
        }
        // Order by the words, not the paragraph's `begin`: some files carry a
        // `begin` of 0 on lines sung much later, which floats them to the top.
        let group_start = std::iter::once(&line)
            .chain(backgrounds.iter().map(|(_, background)| background))
            .filter(|part| !part.words.is_empty())
            .map(|part| part.start_ms)
            .min()
            .unwrap_or(start_ms);
        if !line.text.is_empty() || !line.romanization.is_empty() {
            lines.push((group_start, line));
        }
        for (_, background) in backgrounds {
            if !background.text.is_empty() {
                lines.push((group_start, background));
            }
        }
    }
    ensure!(
        !lines.is_empty(),
        "No timed lyric paragraphs found in this TTML file"
    );
    let lines = order_with_background(lines);
    Ok(Lyrics {
        lines,
        source: "Local TTML".into(),
        songwriters: document
            .descendants()
            .filter(|node| {
                node.is_element() && node.tag_name().name().eq_ignore_ascii_case("songwriter")
            })
            .filter_map(|node| node.text())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .take(100)
            .map(str::to_owned)
            .collect(),
        synced: true,
        ..Lyrics::default()
    })
}

fn track_key(track: &Track) -> String {
    format!("{:x}", Sha256::digest(track.uri.as_bytes()))
}

pub fn import_file(path: &Path, track: &Track) -> Result<Lyrics> {
    ensure!(
        fs::metadata(path)?.len() <= 2_000_000,
        "Lyric file exceeds 2 MB"
    );
    let text = fs::read_to_string(path).context("Cannot read lyrics as UTF-8")?;
    import_text(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        &text,
        track,
    )
}

/// How an imported lyric file is kept, following Spicy Lyrics' Load TTML
/// modes (iPixelGalaxy/spicy-lyrics, UploadTTMLModal, AGPL-3.0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Saved on disk; used whenever the song plays.
    #[default]
    Persistent,
    /// Kept in memory until the app restarts.
    Session,
    /// Shown now only; the next lyrics load replaces it.
    Temporary,
}

static SESSION: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Lyrics>>> =
    std::sync::LazyLock::new(Default::default);

pub fn import_with_mode(
    filename: &str,
    text: &str,
    track: &Track,
    mode: ImportMode,
) -> Result<Lyrics> {
    match mode {
        ImportMode::Persistent => import_text(filename, text, track),
        ImportMode::Session => {
            let (lyrics, _) = parse_import(filename, text, track)?;
            if let Ok(mut session) = SESSION.lock() {
                if session.len() >= 256 {
                    session.clear();
                }
                session.insert(track_key(track), lyrics.clone());
            }
            Ok(lyrics)
        }
        ImportMode::Temporary => Ok(parse_import(filename, text, track)?.0),
    }
}

fn parse_import(filename: &str, text: &str, track: &Track) -> Result<(Lyrics, &'static str)> {
    ensure!(text.len() <= 2_000_000, "Lyric file exceeds 2 MB");
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(match extension.as_str() {
        "lrc" => (parse_lrc(text, track.duration_ms)?, "lrc"),
        "ttml" | "xml" => (parse_ttml(text, track.duration_ms)?, "ttml"),
        _ => bail!("Choose an .lrc, .ttml, or .xml lyric file"),
    })
}

/// A saved import, for the TTML database list.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SavedLyrics {
    pub key: String,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub artists: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub saved_at: u64,
    /// A small cover of the song's album.
    #[serde(default)]
    pub image: String,
}

pub fn saved_imports() -> Result<Vec<SavedLyrics>> {
    let directory = data_dir()?.join("lyrics").join("local");
    let mut saved = saved_in(&directory);
    // Imports from before song details were kept are named only by a hash
    // of the song's URI; match them against songs from cached pages, and
    // keep the details beside the file so the lookup happens once.
    if saved
        .iter()
        .any(|item| item.name.is_empty() || item.image.is_empty())
    {
        let known = crate::library_cache::known_tracks();
        complete_unknown(&directory, &mut saved, |key| known.get(key).cloned());
    }
    Ok(saved)
}

/// Fill in details for saved imports from looked-up songs and keep them.
pub fn complete_saved(saved: &mut [SavedLyrics], tracks: &[Track]) {
    let Ok(directory) = data_dir().map(|dir| dir.join("lyrics").join("local")) else {
        return;
    };
    complete_unknown(&directory, saved, |key| {
        tracks.iter().find(|track| track_key(track) == key).cloned()
    });
}

fn complete_unknown(
    directory: &Path,
    saved: &mut [SavedLyrics],
    lookup: impl Fn(&str) -> Option<Track>,
) {
    for item in saved
        .iter_mut()
        .filter(|item| item.name.is_empty() || item.image.is_empty())
    {
        let Some(track) = lookup(&item.key) else {
            continue;
        };
        let details = song_details(&track);
        let before = (item.name.clone(), item.image.clone());
        if item.name.is_empty() {
            item.name = details.name;
            item.artists = details.artists;
        }
        if item.uri.is_empty() {
            item.uri = details.uri;
        }
        if item.image.is_empty() {
            item.image = details.image;
        }
        if (item.name.clone(), item.image.clone()) != before
            && let Ok(bytes) = serde_json::to_vec(item)
        {
            let _ = fs::write(directory.join(format!("{}.meta.json", item.key)), bytes);
        }
    }
}

/// Name, artists, URI and a small album cover for a saved import.
fn song_details(track: &Track) -> SavedLyrics {
    let covers = || {
        track
            .album
            .images
            .iter()
            .filter(|image| image.url.starts_with("https://"))
    };
    // The smallest cover at least 64 px wide fills the 56 px list artwork.
    let image = covers()
        .filter(|image| image.width.is_some_and(|width| width >= 64))
        .min_by_key(|image| image.width)
        .or_else(|| covers().next())
        .map(|image| image.url.clone())
        .unwrap_or_default();
    SavedLyrics {
        key: track_key(track),
        uri: track.uri.clone(),
        name: track.name.clone(),
        artists: track
            .artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        image,
        ..SavedLyrics::default()
    }
}

/// A saved import's file, named after its song, for downloading.
pub fn saved_file(key: &str) -> Result<(String, String)> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid lyrics entry"
    );
    let directory = data_dir()?.join("lyrics").join("local");
    let (path, kind) = ["ttml", "lrc", "json"]
        .into_iter()
        .map(|kind| (directory.join(format!("{key}.{kind}")), kind))
        .find(|(path, _)| path.is_file())
        .context("Saved lyrics not found")?;
    ensure!(
        fs::metadata(&path)?.len() <= 2_000_000,
        "Lyric file exceeds 2 MB"
    );
    let contents = fs::read_to_string(&path)?;
    let meta = saved_in(&directory)
        .into_iter()
        .find(|item| item.key == key)
        .unwrap_or_default();
    Ok((download_name(&meta, kind), contents))
}

/// "Song - Artists.ttml", kept valid as a Windows file name.
fn download_name(meta: &SavedLyrics, kind: &str) -> String {
    let title = if meta.name.is_empty() {
        meta.key.chars().take(12).collect()
    } else if meta.artists.is_empty() {
        meta.name.clone()
    } else {
        format!("{} - {}", meta.name, meta.artists)
    };
    let safe: String = title
        .chars()
        .map(|c| {
            if r#"<>:"/\|?*"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    format!("{}.{kind}", safe.trim().trim_end_matches('.'))
}

fn saved_in(directory: &Path) -> Vec<SavedLyrics> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut saved: Vec<SavedLyrics> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let kind = path.extension()?.to_str()?.to_owned();
            if !matches!(kind.as_str(), "ttml" | "lrc" | "json") {
                return None;
            }
            let key = path.file_stem()?.to_str()?.to_owned();
            if key.contains('.') {
                return None;
            }
            let mut item = fs::read(directory.join(format!("{key}.meta.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<SavedLyrics>(&bytes).ok())
                .unwrap_or_default();
            item.key = key;
            item.kind = kind;
            if item.saved_at == 0 {
                item.saved_at = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |age| age.as_secs());
            }
            Some(item)
        })
        .take(10_000)
        .collect();
    saved.sort_by_key(|item| std::cmp::Reverse(item.saved_at));
    saved
}

/// Delete one saved import by its key.
pub fn delete_saved(key: &str) -> Result<()> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid lyrics entry"
    );
    let directory = data_dir()?.join("lyrics").join("local");
    for extension in ["ttml", "lrc", "json", "meta.json"] {
        let _ = fs::remove_file(directory.join(format!("{key}.{extension}")));
    }
    Ok(())
}

pub fn import_text(filename: &str, text: &str, track: &Track) -> Result<Lyrics> {
    ensure!(text.len() <= 2_000_000, "Lyric file exceeds 2 MB");
    let path = Path::new(filename);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (lyrics, kind) = match extension.as_str() {
        "lrc" => (parse_lrc(text, track.duration_ms)?, "lrc"),
        "ttml" | "xml" => (parse_ttml(text, track.duration_ms)?, "ttml"),
        _ => bail!("Choose an .lrc, .ttml, or .xml lyric file"),
    };
    // Keep the original file per track (keyed by the Spotify URI) so it is
    // re-parsed with the current parser every time the song plays again.
    let directory = data_dir()?.join("lyrics").join("local");
    fs::create_dir_all(&directory)?;
    forget_local_in(&directory, track);
    fs::write(
        directory.join(format!("{}.{kind}", track_key(track))),
        text.as_bytes(),
    )?;
    let meta = SavedLyrics {
        kind: kind.into(),
        saved_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_secs()),
        ..song_details(track)
    };
    let _ = fs::write(
        directory.join(format!("{}.meta.json", track_key(track))),
        serde_json::to_vec(&meta)?,
    );
    Ok(lyrics)
}

/// Lyrics imported for this track, if any.
pub fn load_local(track: &Track) -> Option<Lyrics> {
    let directory = data_dir().ok()?.join("lyrics").join("local");
    load_local_in(&directory, track)
}

fn load_local_in(directory: &Path, track: &Track) -> Option<Lyrics> {
    let key = track_key(track);
    if let Ok(text) = fs::read_to_string(directory.join(format!("{key}.ttml"))) {
        return parse_ttml(&text, track.duration_ms).ok();
    }
    if let Ok(text) = fs::read_to_string(directory.join(format!("{key}.lrc"))) {
        return parse_lrc(&text, track.duration_ms).ok();
    }
    // Imports from earlier versions stored parsed JSON only.
    fs::read(directory.join(format!("{key}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Remove lyrics imported for this track so provider lyrics are used again.
pub fn forget_local(track: &Track) -> Result<()> {
    forget_local_in(&data_dir()?.join("lyrics").join("local"), track);
    Ok(())
}

fn forget_local_in(directory: &Path, track: &Track) {
    let key = track_key(track);
    if let Ok(mut session) = SESSION.lock() {
        session.remove(&key);
    }
    for extension in ["ttml", "lrc", "json", "meta.json"] {
        let _ = fs::remove_file(directory.join(format!("{key}.{extension}")));
    }
}

/// Drop this track's saved source answers, so the next fetch asks every
/// source again and picks up newly uploaded lyrics. Imports are kept.
pub fn forget_cached(track: &Track) -> Result<()> {
    forget_cached_in(&data_dir()?.join("lyrics").join("cache"), track);
    Ok(())
}

fn forget_cached_in(directory: &Path, track: &Track) {
    let file = format!("{}.json", track_key(track));
    for namespace in fs::read_dir(directory).into_iter().flatten().flatten() {
        if namespace.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_file(namespace.path().join(&file));
        }
    }
}

/// Delete every saved source answer; imported lyrics stay.
pub fn clear_cache() -> Result<()> {
    let directory = data_dir()?.join("lyrics").join("cache");
    match fs::remove_dir_all(&directory) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

pub fn fetch(
    client: &Client,
    track: &Track,
    access_token: &str,
    native: &crate::native::NativeControls,
) -> Result<Lyrics> {
    fetch_from(client, track, access_token, native, true)
}

/// The best lyrics already on disk, in the chosen source order, without any
/// request or token: shown at once while the sources are asked again.
pub fn cached(
    client: &Client,
    track: &Track,
    native: &crate::native::NativeControls,
) -> Option<Lyrics> {
    fetch_from(client, track, "", native, false).ok()
}

fn fetch_from(
    client: &Client,
    track: &Track,
    access_token: &str,
    native: &crate::native::NativeControls,
    network: bool,
) -> Result<Lyrics> {
    let root = data_dir()?.join("lyrics");
    let key = track_key(track);
    if let Some(lyrics) = SESSION
        .lock()
        .ok()
        .and_then(|session| session.get(&key).cloned())
    {
        return Ok(lyrics);
    }
    if let Some(lyrics) = load_local_in(&root.join("local"), track) {
        return Ok(lyrics);
    }
    // A local song's lyrics can sit beside it: song.ttml next to song.mp3.
    if track.is_local
        && let Some((name, text)) = crate::local_files::sidecar_lyrics(&track.uri)
        && let Ok(lyrics) = if name.ends_with(".ttml") {
            parse_ttml(&text, track.duration_ms)
        } else {
            parse_lrc(&text, track.duration_ms)
        }
    {
        return Ok(lyrics);
    }
    // Every enabled source is asked at once; the best answer in the chosen
    // order wins as soon as it is known, while slower sources finish in the
    // background and keep their own three-day cache.
    let cache = std::sync::Arc::new(SourceCache { root, key, network });
    // Errors keep whether the provider was unreachable, as text and a flag.
    let provider: std::sync::Arc<std::sync::OnceLock<std::result::Result<Lyrics, (String, bool)>>> =
        Default::default();
    let (client, track, access_token, native) = (
        client.clone(),
        track.clone(),
        access_token.to_owned(),
        native.clone(),
    );
    let (sources, words) = (
        crate::lyric_sources::enabled(),
        crate::lyric_sources::musixmatch_words(),
    );
    let fetch = move |source: &str| -> Result<Lyrics> {
        match source {
            "apple" => cache.get("apple-lyssna-2", &|| {
                crate::lyssna_lyrics::fetch_apple(
                    &client,
                    || native.isrc(&track.uri).ok().flatten(),
                    &track,
                )
            }),
            "spicy" => {
                let answer = provider.get_or_init(|| {
                    crate::provider::cache_namespace()
                        .and_then(|namespace| {
                            cache.get_api(&namespace, &|| {
                                crate::provider::fetch(&client, &track, &access_token)
                            })
                        })
                        .map_err(|error| {
                            (error.to_string(), crate::lyric_sources::unreachable(&error))
                        })
                });
                let lyrics = answer.as_ref().map_err(|(message, unreachable)| {
                    if *unreachable {
                        crate::lyric_sources::Unreachable(message.clone()).into()
                    } else {
                        anyhow::anyhow!(message.clone())
                    }
                })?;
                crate::lyric_sources::split_provider(lyrics, source)
                    .with_context(|| format!("No {source} lyrics from the provider"))
            }
            // Line-only answers are cached apart, so switching shows the other.
            "musixmatch" => cache.get(
                if words {
                    "musixmatch"
                } else {
                    "musixmatch-lines"
                },
                &|| crate::lyric_sources::musixmatch(&client, &track, words),
            ),
            "spotify" => cache.get("spotify", &|| {
                crate::lyric_sources::spotify(&native, &track)
            }),
            "lrclib" => cache.get("lrclib", &|| crate::lyric_sources::lrclib(&client, &track)),
            // Renamed when background brackets parsing changed.
            "lyssna" => cache.get("lyssna-2", &|| {
                crate::lyssna_lyrics::fetch(
                    &client,
                    || native.isrc(&track.uri).ok().flatten(),
                    &track,
                )
            }),
            // Renamed when parsing changed: saved answers had dropped lines.
            "lrcred" => cache.get("lrcred-2", &|| {
                crate::lyric_sources::lrc_red(&client, &native, &track)
            }),
            "netease" => cache.get("netease", &|| {
                crate::lyric_sources::netease(&client, &track)
            }),
            _ => Err(anyhow::anyhow!("Unknown lyrics source")),
        }
    };
    crate::lyric_sources::fetch_best(&sources, std::sync::Arc::new(fetch))
}

/// One song's per-source lyrics cache.
struct SourceCache {
    root: std::path::PathBuf,
    key: String,
    network: bool,
}

const DAY: std::time::Duration = std::time::Duration::from_secs(86_400);

impl SourceCache {
    fn get(&self, namespace: &str, fetch: &dyn Fn() -> Result<Lyrics>) -> Result<Lyrics> {
        self.load(namespace, fetch, false)
    }

    /// The Spicy Lyrics API's terms: its answers are kept at most 30 days,
    /// and a refresh that fails or is refused drops the saved one.
    fn get_api(&self, namespace: &str, fetch: &dyn Fn() -> Result<Lyrics>) -> Result<Lyrics> {
        self.load(namespace, fetch, true)
    }

    fn load(
        &self,
        namespace: &str,
        fetch: &dyn Fn() -> Result<Lyrics>,
        api: bool,
    ) -> Result<Lyrics> {
        let cache = self.root.join("cache").join(namespace);
        let file = cache.join(format!("{}.json", self.key));
        let age = fs::metadata(&file)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok());
        if api && age.is_some_and(|age| age >= 30 * DAY) {
            let _ = fs::remove_file(&file);
        }
        let fresh = age.is_some_and(|age| age < 3 * DAY);
        let saved = || {
            fs::read(&file)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Lyrics>(&bytes).ok())
        };
        // Offline, any saved answer will do until the sources reply.
        if (fresh || !self.network)
            && let Some(lyrics) = saved()
        {
            return Ok(lyrics);
        }
        if !self.network {
            return Err(crate::lyric_sources::Unreachable("Offline and not saved".into()).into());
        }
        // A source that fails keeps its last answer, so the pick does not
        // fall to a lower source until it answers again.
        let lyrics = match fetch() {
            Ok(lyrics) => lyrics,
            Err(error) if api => {
                let _ = fs::remove_file(&file);
                return Err(error);
            }
            Err(error) => return saved().ok_or(error),
        };
        if fs::create_dir_all(&cache).is_ok() {
            let _ = fs::write(file, serde_json::to_vec(&lyrics)?);
        }
        Ok(lyrics)
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn ttml_lines_follow_their_words_when_the_paragraph_begin_is_wrong() {
        let lyrics = super::parse_ttml(
            r#"<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:02.000">First</span></p>
<p begin="00:00.000" end="00:18.637"><span begin="00:17.925" end="00:18.637">Later</span></p>
<p begin="00:05.000" end="00:06.000"><span begin="00:05.000" end="00:06.000">Middle</span></p>
</div></body></tt>"#,
            200_000,
        )
        .unwrap();
        let order: Vec<_> = lyrics.lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(order, ["First", "Middle", "Later"]);
        assert_eq!(lyrics.lines[2].start_ms, 17_925);
    }

    #[test]
    fn ttml_background_drops_a_stray_closing_bracket_unit() {
        let lyrics = super::parse_ttml(
            r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>
<p begin="00:48.706" end="00:53.945"><span begin="00:48.706" end="00:53.945">Lead</span><span ttm:role="x-bg" begin="00:00.000" end="01:00.267"><span begin="00:46.340" end="00:48.819">(Ooh-</span><span begin="00:48.819" end="00:50.391">ooh</span><span begin="00:00.000" end="01:00.267">))</span></span></p>
</div></body></tt>"#,
            200_000,
        )
        .unwrap();
        let background = lyrics.lines.iter().find(|line| line.background).unwrap();
        assert_eq!(background.text, "Ooh-ooh");
        assert_eq!(background.words.len(), 2);
        assert_eq!(background.end_ms, 50_391);
    }

    #[test]
    fn containers_that_end_before_they_begin_take_their_words_timing() {
        let source = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>
<p begin="02:16.775" end="00:00.000"><span begin="02:16.775" end="02:16.931">Can</span> <span begin="02:18.317" end="02:18.613">ger</span><span ttm:role="x-bg" begin="02:21.476" end="02:18.311"><span begin="02:18.311" end="02:19.175">(Oh</span> <span begin="02:20.896" end="02:21.476">hour)</span></span></p>
<p begin="02:19.047" end="02:21.127"><span begin="02:19.047" end="02:21.127">Fine</span></p>
</div></body></tt>"#;
        let repaired = super::repair_container_timing(source);
        assert!(repaired.contains(r#"<p begin="02:16.775" end="02:21.476">"#));
        assert!(repaired.contains(r#"ttm:role="x-bg" begin="02:18.311" end="02:21.476">"#));
        assert!(repaired.contains(r#"<p begin="02:19.047" end="02:21.127">"#));
        assert_eq!(super::repair_container_timing(&repaired), repaired);
    }

    fn timed_line(words: &[(&str, u64)]) -> Line {
        let words: Vec<Word> = words
            .iter()
            .map(|(text, start)| Word {
                start_ms: *start,
                end_ms: start + 400,
                text: (*text).to_owned(),
                sung_by: None,
            })
            .collect();
        Line {
            start_ms: words[0].start_ms,
            end_ms: words.last().unwrap().end_ms,
            text: words.iter().map(|word| word.text.as_str()).collect(),
            words,
            ..Line::default()
        }
    }

    fn synced(lines: Vec<Line>) -> Lyrics {
        Lyrics {
            lines,
            synced: true,
            ..Lyrics::default()
        }
    }

    #[test]
    fn ttml_keeps_separate_background_spans_as_separate_lines() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:06.000"><span begin="00:01.000" end="00:02.000">Goddamn</span><span ttm:role="x-bg"><span begin="00:02.000" end="00:02.500">(No</span> <span begin="00:02.500" end="00:03.000">limit)</span></span><span ttm:role="x-bg"><span begin="00:04.000" end="00:04.500">(Rewind,</span> <span begin="00:04.500" end="00:05.000">rewind)</span></span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 10_000).unwrap();
        let texts: Vec<_> = lyrics
            .lines
            .iter()
            .map(|line| (line.text.as_str(), line.background))
            .collect();
        assert_eq!(
            texts,
            [
                ("Goddamn", false),
                ("No limit", true),
                ("Rewind, rewind", true)
            ]
        );
    }

    #[test]
    fn bracketed_aside_in_a_timed_line_becomes_background() {
        let mut lyrics = synced(vec![timed_line(&[
            ("I", 0),
            (" was", 400),
            (" a", 800),
            (" girl", 1200),
            (" (I", 1600),
            (" was", 2000),
            (" a", 2400),
            (" girl)", 2800),
        ])]);
        split_bracketed_background(&mut lyrics);
        assert_eq!(lyrics.lines.len(), 2);
        let (lead, background) = (&lyrics.lines[0], &lyrics.lines[1]);
        assert_eq!(lead.text, "I was a girl");
        assert!(!lead.background);
        assert_eq!(lead.end_ms, 3200);
        assert_eq!(background.text, "I was a girl");
        assert!(background.background);
        assert_eq!(background.words[0].text, "I");
        assert_eq!((background.start_ms, background.end_ms), (1600, 3200));
    }

    #[test]
    fn bracketed_words_mid_sentence_leave_the_lead_spaced() {
        let mut lyrics = synced(vec![timed_line(&[
            ("Hold", 0),
            (" (oh)", 400),
            (" me", 800),
            (" close", 1200),
        ])]);
        split_bracketed_background(&mut lyrics);
        assert_eq!(lyrics.lines[0].text, "Hold me close");
        assert_eq!(lyrics.lines[0].words[1].text, " me");
        assert_eq!(lyrics.lines[1].text, "oh");
    }

    #[test]
    fn whole_bracketed_or_untimed_lines_stay_lead() {
        let alone = timed_line(&[("(I", 0), (" was", 400), (" a", 800), (" girl)", 1200)]);
        let untimed = Line {
            text: "I was a girl (I was a girl)".into(),
            ..Line::default()
        };
        let mut lyrics = synced(vec![alone, untimed]);
        split_bracketed_background(&mut lyrics);
        assert_eq!(lyrics.lines.len(), 2);
        assert!(lyrics.lines.iter().all(|line| !line.background));
        assert_eq!(lyrics.lines[0].text, "(I was a girl)");
    }

    use super::*;
    #[test]
    fn ttml_songwriters_survive_cache_serialization() {
        let lyrics=parse_ttml(r#"<tt><head><songwriters><songwriter>Credit Writer</songwriter></songwriters></head><body><div><p begin="1s" end="2s">you</p></div></body></tt>"#,2000).unwrap();
        let restored: Lyrics =
            serde_json::from_slice(&serde_json::to_vec(&lyrics).unwrap()).unwrap();
        assert_eq!(restored.songwriters, vec!["Credit Writer"]);
        let legacy: Lyrics = serde_json::from_value(
            serde_json::json!({"lines":[],"source":"cache","instrumental":false,"synced":true}),
        )
        .unwrap();
        assert!(legacy.songwriters.is_empty());
    }

    #[test]
    fn overlapping_background_does_not_replace_active_lead() {
        let lyrics = Lyrics {
            synced: true,
            lines: vec![
                Line {
                    start_ms: 1000,
                    end_ms: 5000,
                    text: "Lead".into(),
                    ..Line::default()
                },
                Line {
                    start_ms: 2000,
                    end_ms: 3000,
                    text: "Background".into(),
                    background: true,
                    ..Line::default()
                },
            ],
            ..Lyrics::default()
        };
        assert_eq!(lyrics.active_line(2500), Some(0));
        assert_eq!(lyrics.active_line(4000), Some(0));
        assert_eq!(lyrics.active_line(5000), None);
    }

    #[test]
    fn ttml_takes_plain_seconds_as_absolute_times() {
        let ttml = r#"<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="5.050" end="5.717">POP IN</p><p begin="59.5" end="1:00.217"><span begin="59.5" end="59.9">Late</span> <span begin="59.9" end="1:00.217">line</span></p><p begin="1:00.227" end="1:01.453">After</p></div></body></tt>"#;
        let lyrics = parse_ttml(ttml, 90_000).unwrap();
        let times: Vec<_> = lyrics
            .lines
            .iter()
            .map(|line| (line.start_ms, line.end_ms))
            .collect();
        assert_eq!(times, [(5050, 5717), (59_500, 60_217), (60_227, 61_453)]);
        assert_eq!(lyrics.lines[1].words[0].start_ms, 59_500);
    }

    #[test]
    fn lrc_handles_offsets_repeated_timestamps_and_seek_backwards() {
        let lyrics = parse_lrc(
            "[offset:-200]\n[00:01.00][00:05.500]Hello\n[00:03.25]World",
            10_000,
        )
        .unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.start_ms)
                .collect::<Vec<_>>(),
            vec![800, 3050, 5300]
        );
        assert_eq!(lyrics.active_line(0), None);
        assert_eq!(lyrics.active_line(4000), Some(1));
        assert_eq!(lyrics.active_line(1000), Some(0));
        assert_eq!(lyrics.active_line(10_001), None);
    }

    #[test]
    fn ttml_keeps_word_timing_translation_and_romanization_separate() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:04.000" ttm:agent="v2"><span begin="00:01.000" end="00:02.000">Hello </span><span begin="00:02.000" end="00:03.000">world</span><span ttm:role="x-translation">Bonjour</span><span ttm:role="x-roman">Roman</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 5000).unwrap();
        let line = &lyrics.lines[0];
        assert_eq!(line.text, "Hello world");
        assert_eq!(line.translation, "Bonjour");
        assert_eq!(line.romanization, "Roman");
        assert!(line.opposite);
        assert_eq!(line.words[1].start_ms, 2000);
    }

    #[test]
    fn ttml_reads_every_line_of_tagged_sections_with_singers() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:lyssna="https://lyssna.org/ns/ttml" itunes:timing="Word"><body dur="00:10.000"><div begin="00:01.000" end="00:03.000" itunes:songPart="Verse" lyssna:singer="Nicki Minaj"><p begin="00:01.000" end="00:02.000" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:02.000">One</span></p><p begin="00:02.000" end="00:03.000" ttm:agent="v1" itunes:key="L2"><span begin="00:02.000" end="00:03.000">Two</span></p></div><div begin="00:04.000" end="00:05.000" itunes:song-part="Chorus"><p begin="00:04.000" end="00:05.000" ttm:agent="v2" itunes:key="L3"><span begin="00:04.000" end="00:05.000">Three</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 10_000).unwrap();
        let words: Vec<&str> = lyrics.lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(words, ["One", "Two", "Three"]);
        assert_eq!(lyrics.lines[2].words[0].start_ms, 4000);
        assert!(lyrics.lines[2].opposite);
    }

    #[test]
    fn ttml_styles_lines_by_who_sings_them_when_sections_name_singers() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:lyssna="https://lyssna.org/ns/ttml"><body><div itunes:songPart="Verse" lyssna:singer="Kanye West"><p begin="00:01.000" end="00:02.000" ttm:agent="v1"><span begin="00:01.000" end="00:02.000">One</span></p></div><div itunes:songPart="Verse" lyssna:singer="JAY-Z"><p begin="00:03.000" end="00:04.000" ttm:agent="v2"><span begin="00:03.000" end="00:04.000">Two</span></p></div><div itunes:songPart="Chorus" lyssna:singer="Kanye West, Kanye West &amp; JAY-Z, JAY-Z"><p begin="00:05.000" end="00:06.000" ttm:agent="v1"><span begin="00:05.000" end="00:06.000">Three</span></p><p begin="00:06.000" end="00:07.000" ttm:agent="v1000"><span begin="00:06.000" end="00:07.000">Four</span></p><p begin="00:07.000" end="00:08.000" ttm:agent="v2"><span begin="00:07.000" end="00:08.000">Five</span><span ttm:role="x-bg"><span begin="00:07.500" end="00:08.000">(yeah)</span></span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 10_000).unwrap();
        let styles: Vec<(&str, Option<&str>)> = lyrics
            .lines
            .iter()
            .map(|line| (line.text.as_str(), line.sung_by.as_deref()))
            .collect();
        assert_eq!(
            styles,
            [
                ("One", None),
                ("Two", None),
                ("Three", None),
                ("Four", Some("second")),
                ("Five", Some("third")),
                ("yeah", Some("third")),
            ]
        );
        let sides: Vec<bool> = lyrics.lines.iter().map(|line| line.opposite).collect();
        assert_eq!(sides, [false, true, false, false, true, true]);
    }

    #[test]
    fn words_another_voice_sings_and_section_starts_are_kept() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:lyssna="https://lyssna.org/ns/ttml"><body><div itunes:songPart="Verse" lyssna:singer="A"><p begin="00:01.000" end="00:02.000" ttm:agent="v1"><span begin="00:01.000" end="00:02.000">One</span></p></div><div itunes:songPart="Verse" lyssna:singer="B"><p begin="00:03.000" end="00:04.000" ttm:agent="v2"><span begin="00:03.000" end="00:04.000">Two</span></p></div><div itunes:songPart="Outro" lyssna:singer="A &amp; B"><p begin="00:05.000" end="00:07.000" ttm:agent="v1"><span begin="00:05.000" end="00:06.000">Three</span> <span begin="00:06.000" end="00:07.000" ttm:agent="v2">four</span></p><p begin="00:08.000" end="00:09.000" ttm:agent="v1"><span begin="00:08.000" end="00:09.000">Five</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 10_000).unwrap();
        let outro = &lyrics.lines[2];
        assert_eq!(outro.section.as_deref(), Some("Outro"));
        assert_eq!(outro.section_singer.as_deref(), Some("A & B"));
        assert_eq!(outro.words[0].sung_by, None);
        assert_eq!(outro.words[1].sung_by.as_deref(), Some("second"));
        assert_eq!(lyrics.lines[3].section, None);
    }

    #[test]
    fn two_artists_joined_by_and_sign_are_plain_then_italic() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:lyssna="https://lyssna.org/ns/ttml"><body><div lyssna:singer="Justin Vernon"><p begin="00:01.000" end="00:02.000" ttm:agent="v1"><span begin="00:01.000" end="00:02.000">One</span></p></div><div lyssna:singer="Charlie Wilson"><p begin="00:03.000" end="00:04.000" ttm:agent="v2"><span begin="00:03.000" end="00:04.000">Two</span></p></div><div lyssna:singer="Justin Vernon &amp; Charlie Wilson"><p begin="00:05.000" end="00:06.000" ttm:agent="v1"><span begin="00:05.000" end="00:06.000">Three</span></p><p begin="00:06.000" end="00:07.000" ttm:agent="v2"><span begin="00:06.000" end="00:07.000">Four</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 10_000).unwrap();
        let styles: Vec<Option<&str>> = lyrics
            .lines
            .iter()
            .map(|line| line.sung_by.as_deref())
            .collect();
        assert_eq!(styles, [None, None, None, Some("second")]);
    }

    #[test]
    fn ttml_splits_background_vocals_syllables_and_duets() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:06.000" ttm:agent="v1"><span begin="00:01.000" end="00:01.500">Hel</span><span begin="00:01.500" end="00:02.000">lo</span> <span begin="00:02.000" end="00:03.000">there</span><span ttm:role="x-bg"><span begin="00:04.000" end="00:04.500">(oh</span> <span begin="00:04.500" end="00:05.000">yeah)</span></span></p><p begin="00:07.000" end="00:08.000" ttm:agent="v2"><span begin="00:07.000" end="00:08.000">Duet</span></p><p begin="00:09.000" end="00:10.000" ttm:agent="v2000"><span begin="00:09.000" end="00:10.000">Both</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 12_000).unwrap();
        let lead = &lyrics.lines[0];
        assert_eq!(lead.text, "Hello there");
        assert_eq!(lead.words.len(), 3);
        assert_eq!(lead.words[1].text, "lo");
        assert_eq!(lead.words[2].text, " there");
        assert!(!lead.background && !lead.opposite);
        let background = &lyrics.lines[1];
        assert!(background.background);
        assert_eq!(background.text, "oh yeah");
        assert_eq!(background.words[0].text, "oh");
        assert_eq!(background.words[1].text, " yeah");
        assert_eq!((background.start_ms, background.end_ms), (4000, 5000));
        assert!(lyrics.lines[2].opposite);
        assert!(!lyrics.lines[3].opposite);
    }

    #[test]
    fn ttml_reads_head_transliterations_by_key() {
        let text = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><transliterations><transliteration><text for="L1"><span begin="00:01.000" end="00:01.500">mi</span><span begin="00:01.500" end="00:02.000">kan</span> <span begin="00:02.000" end="00:02.500">sei</span></text></transliteration></transliterations></iTunesMetadata></metadata></head><body><div><p begin="00:01.000" end="00:02.500" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:02.000">未完</span><span begin="00:02.000" end="00:02.500">成</span></p></div></body></tt>"#;
        let lyrics = parse_ttml(text, 5_000).unwrap();
        assert_eq!(lyrics.lines.len(), 1);
        assert_eq!(lyrics.lines[0].text, "未完成");
        assert_eq!(lyrics.lines[0].romanization, "mikan sei");
    }

    /// Parses a local corpus of real AMLL/Apple-style TTML files when present
    /// (set LYSSNA_TTML_DIR); skipped otherwise.
    #[test]
    fn ttml_corpus_parses() {
        let Ok(directory) = std::env::var("LYSSNA_TTML_DIR") else {
            return;
        };
        let mut count = 0;
        for entry in fs::read_dir(directory).unwrap().flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "ttml")
            {
                let source = fs::read_to_string(&path).unwrap();
                let lyrics = parse_ttml(&source, 0)
                    .unwrap_or_else(|error| panic!("{}: {error:#}", path.display()));
                assert!(
                    lyrics.lines.iter().any(|line| !line.words.is_empty()),
                    "{} has no timed words",
                    path.display()
                );
                for line in &lyrics.lines {
                    assert!(line.start_ms <= line.end_ms, "{}", path.display());
                    assert!(
                        !line.text.contains("  "),
                        "{}: {:?}",
                        path.display(),
                        line.text
                    );
                }
                count += 1;
            }
        }
        assert!(count > 0);
    }

    #[test]
    fn session_loads_last_until_reset_and_temporary_loads_are_not_kept() {
        let directory =
            std::env::temp_dir().join(format!("lyssna-session-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let track = Track {
            uri: "spotify:track:session".into(),
            duration_ms: 10_000,
            ..Track::default()
        };
        let session = |track: &Track| SESSION.lock().unwrap().get(&track_key(track)).cloned();
        import_with_mode(
            "song.lrc",
            "[00:01.00]Temporary",
            &track,
            ImportMode::Temporary,
        )
        .unwrap();
        assert!(session(&track).is_none());
        let lyrics =
            import_with_mode("song.lrc", "[00:01.00]Session", &track, ImportMode::Session).unwrap();
        assert_eq!(lyrics.lines[0].text, "Session");
        assert_eq!(session(&track).unwrap().lines[0].text, "Session");
        forget_local_in(&directory, &track);
        assert!(session(&track).is_none());
        assert!(import_with_mode("song.txt", "x", &track, ImportMode::Session).is_err());
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn a_failing_source_keeps_its_stale_answer() {
        let root = std::env::temp_dir().join(format!("lyssna-stale-cache-{}", std::process::id()));
        let cache = SourceCache {
            root: root.clone(),
            key: "song".into(),
            network: true,
        };
        let failing = || Err(anyhow::anyhow!("denied"));
        assert!(cache.get("provider", &failing).is_err());
        let answer = || {
            Ok(Lyrics {
                source: "apple_music".into(),
                ..Lyrics::default()
            })
        };
        cache.get("provider", &answer).unwrap();
        let file = root.join("cache").join("provider").join("song.json");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(4 * 86_400);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(
            cache.get("provider", &failing).unwrap().source,
            "apple_music"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn api_answers_expire_and_a_failed_refresh_drops_them() {
        let root = std::env::temp_dir().join(format!("lyssna-api-cache-{}", std::process::id()));
        let file = root.join("cache").join("provider").join("song.json");
        let age = |days: u32| {
            fs::File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_modified(std::time::SystemTime::now() - days * DAY)
                .unwrap();
        };
        let answer = || {
            Ok(Lyrics {
                source: "spicy_lyrics".into(),
                ..Lyrics::default()
            })
        };
        let failing = || Err(anyhow::anyhow!("denied"));
        let online = SourceCache {
            root: root.clone(),
            key: "song".into(),
            network: true,
        };
        let offline = SourceCache {
            root: root.clone(),
            key: "song".into(),
            network: false,
        };
        online.get_api("provider", &answer).unwrap();
        age(29);
        assert!(offline.get_api("provider", &failing).is_ok());
        age(31);
        assert!(offline.get_api("provider", &failing).is_err());
        assert!(!file.exists());
        online.get_api("provider", &answer).unwrap();
        age(4);
        assert!(online.get_api("provider", &failing).is_err());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn forgetting_cached_lyrics_clears_every_source_for_that_song_only() {
        let directory =
            std::env::temp_dir().join(format!("lyssna-lyric-cache-{}", std::process::id()));
        let song = Track {
            uri: "spotify:track:song".into(),
            ..Track::default()
        };
        let other = Track {
            uri: "spotify:track:other".into(),
            ..Track::default()
        };
        for namespace in ["provider", "lrclib"] {
            fs::create_dir_all(directory.join(namespace)).unwrap();
            for track in [&song, &other] {
                fs::write(
                    directory
                        .join(namespace)
                        .join(format!("{}.json", track_key(track))),
                    "{}",
                )
                .unwrap();
            }
        }
        forget_cached_in(&directory, &song);
        for namespace in ["provider", "lrclib"] {
            let path = |track: &Track| {
                directory
                    .join(namespace)
                    .join(format!("{}.json", track_key(track)))
            };
            assert!(!path(&song).exists());
            assert!(path(&other).exists());
        }
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn saved_imports_list_newest_first_with_song_details() {
        let directory =
            std::env::temp_dir().join(format!("lyssna-saved-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let (old, new) = ("a".repeat(64), "b".repeat(64));
        fs::write(directory.join(format!("{old}.lrc")), "[00:01.00]Old").unwrap();
        fs::write(directory.join(format!("{new}.ttml")), "<tt/>").unwrap();
        for (key, name, saved_at) in [(&old, "Old song", 1), (&new, "New song", 2)] {
            let meta = SavedLyrics {
                key: key.clone(),
                name: name.into(),
                saved_at,
                ..SavedLyrics::default()
            };
            fs::write(
                directory.join(format!("{key}.meta.json")),
                serde_json::to_vec(&meta).unwrap(),
            )
            .unwrap();
        }
        let saved = saved_in(&directory);
        let names: Vec<_> = saved.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["New song", "Old song"]);
        // An older import without a name is matched and the name kept.
        let unnamed = "c".repeat(64);
        fs::write(directory.join(format!("{unnamed}.ttml")), "<tt/>").unwrap();
        let mut saved = saved_in(&directory);
        complete_unknown(&directory, &mut saved, |key| {
            (key == unnamed).then(|| Track {
                name: "Found song".into(),
                artists: vec![crate::model::Artist {
                    name: "Artist".into(),
                    ..Default::default()
                }],
                album: crate::model::Album {
                    images: vec![
                        crate::model::Artwork {
                            url: "https://i.scdn.co/image/large".into(),
                            width: Some(640),
                        },
                        crate::model::Artwork {
                            url: "https://i.scdn.co/image/small".into(),
                            width: Some(64),
                        },
                    ],
                    ..Default::default()
                },
                ..Track::default()
            })
        });
        let found = saved.iter().find(|item| item.name == "Found song").unwrap();
        assert_eq!(found.artists, "Artist");
        assert_eq!(found.image, "https://i.scdn.co/image/small");
        assert_eq!(download_name(found, "ttml"), "Found song - Artist.ttml");
        let tricky = SavedLyrics {
            name: "What? / Why: \"Now\"".into(),
            ..SavedLyrics::default()
        };
        assert_eq!(download_name(&tricky, "lrc"), "What_ _ Why_ _Now_.lrc");
        assert!(saved.iter().any(|item| item.name == "Found song"));
        assert!(
            saved_in(&directory)
                .iter()
                .any(|item| item.name == "Found song")
        );
        assert_eq!(saved[0].kind, "ttml");
        assert!(delete_saved("not-a-key").is_err());
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn local_lyrics_are_remembered_per_track_and_reparsed() {
        let directory =
            std::env::temp_dir().join(format!("lyssna-local-lyrics-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let track = Track {
            uri: "spotify:track:abc".into(),
            ..Track::default()
        };
        let other = Track {
            uri: "spotify:track:def".into(),
            ..Track::default()
        };
        fs::write(
            directory.join(format!("{}.lrc", track_key(&track))),
            "[00:01.00]Hello",
        )
        .unwrap();
        assert_eq!(
            load_local_in(&directory, &track).unwrap().lines[0].text,
            "Hello"
        );
        assert!(load_local_in(&directory, &other).is_none());
        forget_local_in(&directory, &track);
        assert!(load_local_in(&directory, &track).is_none());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn invalid_timing_and_empty_files_fail() {
        assert!(parse_lrc("[ar:Artist]\nUntimed", 5000).is_err());
        assert!(parse_ttml("<tt><p begin='5s' end='1s'>Bad</p></tt>", 5000).is_err());
        assert_eq!(timestamp("NaNs"), None);
        assert_eq!(timestamp("-1s"), None);
        assert_eq!(timestamp("00:01:30.125"), Some(90_125));
    }
}
