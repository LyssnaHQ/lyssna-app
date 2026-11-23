use super::*;

fn japanese(as_written: bool) -> Readers {
    Readers {
        japanese: true,
        as_written,
        ..Default::default()
    }
}

fn joined(pieces: &[&str], readers: Readers) -> String {
    romanize_pieces(pieces, readers).concat()
}

fn line(text: &str, romanization: &str) -> Line {
    Line {
        text: text.into(),
        romanization: romanization.into(),
        words: vec![Word {
            text: text.into(),
            start_ms: 1000.0,
            end_ms: 3000.0,
        }],
    }
}

fn word(text: &str, start_ms: f64, end_ms: f64) -> Word {
    Word {
        text: text.into(),
        start_ms,
        end_ms,
    }
}

fn romanized(line: Line) -> Option<RomanizedLine> {
    romanize_lines(&[line], Options::default()).remove(0)
}

#[test]
fn a_word_split_across_syllables_keeps_its_reading() {
    assert_eq!(
        romanize_pieces(&["一", "緒", "に"], japanese(true)),
        ["Issho", "", " ni"]
    );
    assert_eq!(
        joined(&["怒り", "抱", "い", "て", "も"], japanese(true)),
        "Ikari daite mo"
    );
    assert_eq!(joined(&["一 ", "緒 ", "に"], japanese(true)), "Issho ni");
    assert_eq!(joined(&["ちょっ", "と"], japanese(true)), "Chotto");
}

#[test]
fn romaji_is_spelled_as_written_or_with_long_vowels() {
    assert_eq!(
        joined(&["今日は東京へ"], japanese(true)),
        "Kyou wa toukyou e"
    );
    assert_eq!(joined(&["コーヒーを"], japanese(true)), "Koohii wo");
    assert_eq!(joined(&["今日は東京へ"], japanese(false)), "Kyō wa tōkyō e");
}

#[test]
fn korean_reads_by_how_it_sounds() {
    for (hangul, latin) in [
        ("사랑해", "saranghae"),
        ("같이", "gachi"),
        ("합니다", "hamnida"),
        ("한국", "hanguk"),
        ("좋아", "joa"),
        ("신라", "silla"),
        ("안녕하세요", "annyeonghaseyo"),
    ] {
        assert_eq!(korean_syllables(hangul).concat(), latin);
    }
    assert_eq!(korean_syllables("같이"), ["ga", "chi"]);
    assert_eq!(romanize_korean("안녕하세요"), "annyeonghaseyo");
}

#[test]
fn chinese_reads_by_word() {
    let chinese = Readers {
        chinese: true,
        ..Default::default()
    };
    assert_eq!(joined(&["长", "大"], chinese), "Zhǎng dà");
    assert_eq!(romanized(line("你好", "")).unwrap().text, "Nǐ hǎo");
}

#[test]
fn cyrillic_uses_russian_or_ukrainian_spelling() {
    let ukrainian = Readers {
        ukrainian: true,
        ..Default::default()
    };
    assert_eq!(
        joined(&["Я тебя люблю"], Readers::default()),
        "Ya tebya lyublyu"
    );
    assert_eq!(joined(&["Київ"], ukrainian), "Kyiv");
    assert_eq!(romanize_cyrillic_word("ЩАСТЯ", true), "SHCHASTIA");
    assert_eq!(joined(&["Ки", "їв"], ukrainian), "Kyiv");
    assert_eq!(romanized(line("Привет", "")).unwrap().text, "Privet");
}

#[test]
fn greek_follows_elot() {
    assert_eq!(romanize_greek("Γεια σου"), "Geia sou");
}

#[test]
fn latin_words_and_spaces_stay() {
    assert_eq!(
        romanize_pieces(&["Hello ", "world"], Readers::default()),
        ["Hello ", "world"]
    );
    assert_eq!(romanized(line("Café, déjà vu! 🎵", "")), None);
}

#[test]
fn kanji_read_as_japanese_only_beside_kana() {
    assert_eq!(song_scripts(["東京", "へ行く"]), [SongScript::Japanese]);
    assert_eq!(song_scripts(["東京"]), [SongScript::Chinese]);
    assert_eq!(song_scripts(["Д", "안녕"]), [SongScript::Korean]);
    assert_eq!(song_scripts(["Привет"]), [SongScript::Cyrillic]);
}

#[test]
fn every_script_reads_as_latin_letters() {
    for text in [
        "안녕하세요",
        "你好",
        "Привет",
        "Γεια",
        "مرحبا",
        "שלום",
        "नमस्ते",
        "বাংলা",
        "สวัสดี",
        "ქართული",
        "Հայերեն",
    ] {
        let out = romanized(line(text, "")).unwrap_or_else(|| panic!("{text} unchanged"));
        assert!(
            out.text.chars().any(|c| c.is_ascii_alphabetic()),
            "{text}: {}",
            out.text
        );
        assert!(
            out.text.chars().all(|c| matches!(
                c.script(),
                Script::Latin | Script::Common | Script::Inherited
            )),
            "{text}: {}",
            out.text
        );
        assert_eq!(
            (out.words[0].start_ms, out.words[0].end_ms),
            (1000.0, 3000.0)
        );
    }
}

#[test]
fn an_unreadable_run_stays_visible() {
    assert_eq!(romanized(line("𒀀", "")), None);
}

#[test]
fn supplied_readings_replace_the_line() {
    let out = romanized(line("東京", "Tokyo")).unwrap();
    assert_eq!(out.text, "Tokyo");
    assert_eq!(out.words.len(), 1);
    assert_eq!(out.words[0].text, "Tokyo");
}

#[test]
fn matching_supplied_words_keep_their_group_timing() {
    let mut source = line("東京 です", "Tokyo desu");
    source.words = vec![word("東京", 1000.0, 1600.0), word(" です", 1800.0, 3000.0)];
    let words = romanized(source).unwrap().words;
    let summary: Vec<_> = words
        .iter()
        .map(|word| {
            (
                word.text.as_str(),
                word.start_ms,
                word.end_ms,
                word.estimated,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("Tokyo", 1000.0, 1600.0, false),
            (" desu", 1800.0, 3000.0, false)
        ]
    );
}

#[test]
fn per_syllable_readings_keep_each_syllables_timing() {
    let mut source = line("誰も読めない", "dare mo  karute");
    source.words = vec![
        word("誰", 1000.0, 1200.0),
        word("も", 1200.0, 1500.0),
        word("読", 1500.0, 1700.0),
        word("カルテ", 2000.0, 3000.0),
    ];
    let out = romanized(source).unwrap();
    let words = &out.words;
    assert!(words.iter().all(|word| !word.estimated));
    assert_eq!(words[0].text, "dare");
    assert_eq!(words[1].text, " mo");
    assert_eq!(words[3].text, " karute");
    assert!(!words[2].text.trim().is_empty());
    assert_eq!((words[3].start_ms, words[3].end_ms), (2000.0, 3000.0));
    assert_eq!(
        out.text,
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<String>()
    );
}

#[test]
fn unmatched_supplied_words_are_estimated_across_the_line() {
    let words = romanized(line("안녕하세요", "hello friend")).unwrap().words;
    assert!(words.iter().all(|word| word.estimated));
    assert_eq!(words[0].start_ms, 1000.0);
    assert_eq!(words.last().unwrap().end_ms, 3000.0);
    assert_eq!(words[0].end_ms, words[1].start_ms);
}

#[test]
fn whole_lines_read_as_the_web_view_read_them() {
    for (text, as_written, expected) in [
        ("안녕하세요", true, "Annyeonghaseyo"),
        ("مرحبا", true, "mrHb"),
        ("東京へ行く", true, "Toukyou e iku"),
        ("東京へ行く", false, "Tōkyō e iku"),
        (
            "사랑해요 보고싶어요 안녕하세요",
            true,
            "Saranghaeyo bogosipeoyo annyeonghaseyo",
        ),
    ] {
        let out = romanize_lines(
            &[Line {
                text: text.into(),
                ..Default::default()
            }],
            Options {
                romaji_as_written: as_written,
            },
        );
        assert_eq!(
            out[0].as_ref().map(|line| line.text.as_str()),
            Some(expected)
        );
    }
    let mut split = line("안녕하세요", "");
    split.words = vec![word("안녕", 1000.0, 1600.0), word("하세요", 1600.0, 2900.0)];
    let words = romanized(split).unwrap().words;
    assert_eq!(
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>(),
        ["Annyeong", "haseyo"]
    );
}

#[test]
fn japanese_lines_read_as_romanized_lyrics_write_them() {
    let read = |text: &str| {
        joined(
            &text.split_inclusive(' ').collect::<Vec<_>>(),
            japanese(true),
        )
    };
    assert_eq!(read("こぼれてく記憶の砂"), "Koboreteku kioku no suna");
    assert_eq!(read("虚しい輪を描いてる"), "Munashii wa wo egaiteru");
    assert_eq!(
        read("二度となにも失くさぬように"),
        "Nido to nani mo nakusanu you ni"
    );
    assert_eq!(read("ねえ こんなに呆気なく"), "Nee konna ni akkenaku");
    assert_eq!(read("追憶という名の罠"), "Tsuioku to iu na no wana");
    assert_eq!(read("消えてしまうの"), "Kiete shimau no");
}

#[test]
fn spaces_and_quotes_keep_words_in_place() {
    let read = |text: &str| {
        joined(
            &text.split_inclusive(' ').collect::<Vec<_>>(),
            japanese(true),
        )
    };
    assert_eq!(read("\"きっと\" 今も"), "\"Kitto\" ima mo");
    assert_eq!(read("「きっと」今も"), "\"Kitto\" ima mo");
}
