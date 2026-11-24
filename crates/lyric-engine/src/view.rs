//! Lyrics view decisions: which line leads, where the view scrolls, and when
//! following resumes. The web view measures the DOM and applies the results.

use crate::motion::{GLIDE_MS, Line, glide_scroll, step_scroll};

/// A move in song time this large is a seek or restart, not playback.
pub const JUMP_MS: f64 = 1500.0;
/// Following resumes this long after the last scroll.
pub const BROWSE_COOLDOWN_MS: f64 = 750.0;
/// Waiting dots only re-render within this reach of their pause.
pub const COUNTDOWN_REACH_MS: f64 = 3000.0;
/// A line clicked while paused stays current within this of its start.
const CUE_SLACK_MS: f64 = 25.0;
const LONGEST_FRAME: f64 = 0.064;

pub fn active_lines(lines: &[Line], time: f64) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.start <= time && time < line.vocal_end())
        .map(|(index, _)| index)
        .collect()
}

/// The line the view centres: a cued line, else a backing vocal sung ahead
/// of its own lead line, else the first lead line being sung, else the last
/// lead line already reached. A backing vocal follows its lead in the list,
/// so the view drops to it early and comes back up when the lead starts.
pub fn primary_line(lines: &[Line], time: f64, cued: Option<usize>) -> usize {
    let active = active_lines(lines, time);
    let ahead = active.iter().rev().copied().find(|&index| {
        lines[index].background
            && lines[..index]
                .iter()
                .rposition(|line| !line.background)
                .is_some_and(|lead| lines[lead].start > time)
    });
    cued.or(ahead)
        .or_else(|| active.into_iter().find(|&index| !lines[index].background))
        .unwrap_or_else(|| {
            lines
                .iter()
                .rposition(|line| line.start <= time && !line.background)
                .unwrap_or(0)
        })
}

pub fn jumped(last: f64, now: f64) -> bool {
    (now - last).abs() > JUMP_MS
}

/// A line clicked while paused stays current, unsung, until play resumes or
/// the song moves elsewhere.
pub fn cue_holds(playing: bool, position: f64, clicked_at: f64, line_start: f64) -> bool {
    !playing && (position == clicked_at || (position - line_start).abs() <= CUE_SLACK_MS)
}

pub fn countdown_time(gap_start: f64, gap_end: f64, position: f64) -> f64 {
    position
        .max(gap_start - COUNTDOWN_REACH_MS)
        .min(gap_end + COUNTDOWN_REACH_MS)
}

/// The highlighter pen keeps following a line until its last word ends;
/// lines not being sung hold fully inked or blank.
pub fn highlighter_time(highlighter: bool, playing: bool, time: f64, line: &Line) -> f64 {
    if !highlighter {
        0.0
    } else if playing || (time >= line.start && time < line.vocal_end()) {
        time
    } else if time >= line.start {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    }
}

pub fn all_sung(lines: &[Line], time: f64) -> bool {
    !lines.is_empty()
        && time
            >= lines
                .iter()
                .map(Line::vocal_end)
                .fold(f64::NEG_INFINITY, f64::max)
}

/// The last lead line sits on the right, so credits can follow the last
/// singer. Duet lines sit right unless the sides are mirrored.
pub fn ends_on_right(lines: &[Line], mirrored: bool) -> bool {
    lines
        .iter()
        .rfind(|line| !line.background)
        .is_some_and(|line| (line.opposite == 1.0) != mirrored)
}

/// Where the current line rests: the Now playing card keeps one faded line
/// above it, everywhere else centres it.
pub fn focus(card: bool, client_height: f64) -> f64 {
    if card {
        (client_height * 0.14).min(40.0)
    } else {
        client_height / 2.0
    }
}

/// Space above the first line. Wide lyrics begin above centre; stacked
/// lyrics begin with the first line on the focus.
pub fn lead_top(
    card: bool,
    compact: bool,
    stacked: bool,
    client_height: f64,
    opening: f64,
    focus: f64,
    first_line_height: f64,
) -> f64 {
    if card {
        8.0
    } else if compact || !stacked {
        client_height * opening
    } else {
        (focus - first_line_height / 2.0).max(0.0)
    }
}

pub fn scroll_target(
    line_top: f64,
    line_height: f64,
    centred: bool,
    focus: f64,
    client_height: f64,
    scroll_height: f64,
) -> f64 {
    let centre = if centred { line_height / 2.0 } else { 0.0 };
    (line_top + centre - focus)
        .min(scroll_height - client_height)
        .max(0.0)
}

/// Credits in view stay whole: near the end the lyrics move up rather than
/// pushing the credits off the bottom, while the current line stays in view.
pub fn held_target(target: f64, line_top: f64, card: bool, focus: f64, end: f64) -> f64 {
    target.max(end.min(line_top - if card { focus } else { 0.0 }))
}

/// Browsing ends once scrolling stops with the current line still on screen.
pub fn resume_following(
    now: f64,
    browsed_at: f64,
    line_top: f64,
    line_bottom: f64,
    view_top: f64,
    view_bottom: f64,
) -> bool {
    now - browsed_at >= BROWSE_COOLDOWN_MS
        && line_bottom.min(view_bottom) - line_top.max(view_top) >= 5.0
}

/// The lyrics scroll: a critically damped spring between lines, and an
/// eased glide after a seek so it does not crawl through the whole song.
#[derive(Clone, Copy, Debug, Default)]
pub struct Scroller {
    pub position: f64,
    pub velocity: f64,
    pub target: f64,
    glide: Option<(f64, f64)>,
    last: f64,
    running: bool,
}

impl Scroller {
    pub fn gliding(&self) -> bool {
        self.glide.is_some()
    }

    pub fn running(&self) -> bool {
        self.running
    }

    pub fn start_glide(&mut self, from: f64, now: f64) {
        self.glide = Some((from, now));
    }

    pub fn shift_glide(&mut self, by: f64) {
        if let Some((from, _)) = &mut self.glide {
            *from += by;
        }
    }

    pub fn stop_glide(&mut self) {
        self.glide = None;
    }

    pub fn start(&mut self, now: f64) {
        self.last = now;
        self.running = true;
    }

    /// Snaps to the target, as on first placement or reduced motion.
    pub fn place(&mut self) {
        self.glide = None;
        self.position = self.target;
        self.velocity = 0.0;
        self.running = false;
    }

    /// Scroll position for the frame at `now`. Once it settles, `running`
    /// turns false and the view rests on the target.
    pub fn tick(&mut self, now: f64) -> f64 {
        if let Some((from, start)) = self.glide {
            let elapsed = now - start;
            self.position = glide_scroll(from, self.target, elapsed);
            self.velocity = 0.0;
            self.last = now;
            if elapsed >= GLIDE_MS {
                self.glide = None;
                self.running = false;
            }
            return self.position;
        }
        let seconds = ((now - self.last) / 1000.0).clamp(0.0, LONGEST_FRAME);
        (self.position, self.velocity) =
            step_scroll(self.position, self.velocity, self.target, seconds);
        self.last = now;
        if (self.position - self.target).abs() <= 0.2 && self.velocity.abs() <= 0.5 {
            self.position = self.target;
            self.running = false;
        }
        self.position
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f64, end: f64, background: bool) -> Line {
        Line {
            start,
            end,
            background,
            ..Default::default()
        }
    }

    #[test]
    fn lead_line_skips_background_vocals() {
        let lines = [
            line(0.0, 2000.0, false),
            line(1000.0, 4000.0, true),
            line(3000.0, 5000.0, false),
        ];
        assert_eq!(active_lines(&lines, 1500.0), vec![0, 1]);
        assert_eq!(primary_line(&lines, 2500.0, None), 0);
        assert_eq!(primary_line(&lines, 3500.0, None), 2);
        assert_eq!(primary_line(&lines, 3500.0, Some(1)), 1);
        assert_eq!(primary_line(&lines, -10.0, None), 0);
    }

    #[test]
    fn backing_vocal_sung_before_its_lead_takes_the_view_until_the_lead() {
        let lines = [
            line(0.0, 1000.0, false),
            line(3000.0, 5000.0, false),
            line(2000.0, 4000.0, true),
        ];
        assert_eq!(primary_line(&lines, 2500.0, None), 2);
        assert_eq!(primary_line(&lines, 3500.0, None), 1);
    }

    #[test]
    fn a_paused_cue_holds_until_the_song_moves() {
        assert!(cue_holds(false, 5000.0, 5000.0, 2000.0));
        assert!(cue_holds(false, 2010.0, 5000.0, 2000.0));
        assert!(!cue_holds(true, 2000.0, 5000.0, 2000.0));
        assert!(!cue_holds(false, 8000.0, 5000.0, 2000.0));
    }

    #[test]
    fn scroll_targets_stay_inside_the_content() {
        assert_eq!(
            scroll_target(1000.0, 40.0, true, 300.0, 600.0, 3000.0),
            720.0
        );
        assert_eq!(scroll_target(10.0, 40.0, true, 300.0, 600.0, 3000.0), 0.0);
        assert_eq!(
            scroll_target(2900.0, 40.0, true, 300.0, 600.0, 3000.0),
            2400.0
        );
        assert_eq!(focus(true, 600.0), 40.0);
        assert_eq!(
            lead_top(false, false, true, 600.0, 0.28, 300.0, 80.0),
            260.0
        );
    }

    #[test]
    fn scroller_springs_then_rests_and_glides_after_seeks() {
        let mut scroller = Scroller {
            target: 500.0,
            ..Default::default()
        };
        scroller.start(0.0);
        let mut now = 0.0;
        while scroller.running() {
            now += 16.0;
            scroller.tick(now);
            assert!(now < 5000.0);
        }
        assert_eq!(scroller.position, 500.0);
        scroller.target = 0.0;
        scroller.start_glide(500.0, now);
        scroller.start(now);
        assert!((scroller.tick(now + GLIDE_MS / 2.0) - 250.0).abs() < 1.0);
        assert_eq!(scroller.tick(now + GLIDE_MS), 0.0);
        assert!(!scroller.running() && !scroller.gliding());
    }

    #[test]
    fn following_resumes_only_after_the_cooldown_with_the_line_in_view() {
        assert!(!resume_following(500.0, 0.0, 100.0, 140.0, 0.0, 600.0));
        assert!(resume_following(800.0, 0.0, 100.0, 140.0, 0.0, 600.0));
        assert!(!resume_following(800.0, 0.0, 700.0, 740.0, 0.0, 600.0));
    }

    #[test]
    fn credits_follow_the_last_lead_singer() {
        let mut last = line(0.0, 1.0, false);
        last.opposite = 1.0;
        let lines = [last, line(0.0, 1.0, true)];
        assert!(ends_on_right(&lines, false));
        assert!(!ends_on_right(&lines, true));
    }
}
