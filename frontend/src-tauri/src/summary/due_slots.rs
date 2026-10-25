//! Reads a summary's due slots, to count dates the model invented. (#171)
//!
//! A summary's action item read `(due: None)` because the template ordered a due date on every item,
//! whether or not the meeting stated one. This counts what a summary actually carries, from its
//! markdown alone, so the instrument and the Stage 2 pass share one definition of a hit.
//!
//! **What is read.** Only action items: the bullets, and the table rows, between an Action Items
//! heading (`**Action Items**` or `## Action Items`) and the next heading. The Summary and Discussion
//! sections mention the same tasks in prose and are never read.
//!
//! **A slot** is a labelled value: `due:`, `due date:` or `deadline:`, case-insensitive, in a list item
//! outside its `ref: "…"` quote; or the Due Date cell of a table row. The bare word is never a slot,
//! so "postponed due to rain" is not one. A filler under any other label is missed.

use regex::Regex;
use std::sync::LazyLock;

/// The agreed blank for a table cell whose value the meeting did not state (the product owner's
/// decision on #171).
pub const BLANK: &str = "—";

/// How action items are identified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The instrument's two-task input: the item containing `budget` carries a stated date
    /// (November 7), and the items containing `venue` carry none.
    Keyword,
    /// A recording that states no date: every action item is undated, and any due slot is a hit.
    NoDate,
}

/// What one summary carries.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reading {
    /// Action items found.
    pub items: usize,
    /// Undated items carrying a due slot.
    pub hits: usize,
    /// Keyword mode: whether the dated item's slot carries the stated date. `None` in no-date mode.
    pub kept: Option<bool>,
    /// The kept date came with a year, which the input does not state.
    pub invented_year: bool,
    /// Table cells left empty instead of carrying the agreed blank.
    pub nonconforming_blanks: usize,
    /// Whether this run says anything: keyword mode needs a budget item and a venue item, and no item
    /// holding both; no-date mode needs at least one item.
    pub conclusive: bool,
}

static SLOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:due date|due|deadline)\s*:\s*([^)—]*)").unwrap());
static REF_QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bref:\s*"[^"]*""#).unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*\s*)$").unwrap());
static ACTION_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:#{1,6}\s+action items\s*|\*\*action items\*\*\s*)$").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-*]\s+(?:\[[ xX]\]\s+)?").unwrap());
static MONTH: &str = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
static STATED_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:nov(?:ember)?\.?\s+0?7(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?|0?7(?:st|nd|rd|th)?\s+nov(?:ember)?\.?(?:,?\s+(\d{4}))?|11/0?7(?:/(\d{2,4}))?)\b").unwrap()
});
static ANY_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b(?:{MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?|\d{{1,2}}(?:st|nd|rd|th)?\s+{MONTH}\.?(?:,?\s+\d{{4}})?|\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?)\b"
    ))
    .unwrap()
});

/// The stated date, November 7, in an accepted form, and whether a year came with it.
fn stated_date(text: &str) -> Option<bool> {
    STATED_DATE.captures(text).map(|c| c.get(1).or(c.get(2)).or(c.get(3)).is_some())
}

/// An action item: the text a slot is read from, and the text the keywords are read from.
enum Item {
    List(String),
    Row { cells: Vec<String>, due: Option<usize> },
}

fn action_items(markdown: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let mut inside = false;
    let mut due_column: Option<Option<usize>> = None;
    for line in markdown.lines() {
        if ACTION_HEADING.is_match(line) {
            inside = true;
            due_column = None;
            continue;
        }
        if inside && HEADING.is_match(line) {
            inside = false;
            continue;
        }
        if !inside {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with('|') {
            let cells: Vec<String> = trimmed.trim_matches('|').split('|').map(|c| c.trim().to_string()).collect();
            if cells.iter().all(|c| !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':')) {
                continue; // the separator row
            }
            match due_column {
                None => {
                    // The header row names the columns.
                    due_column = Some(cells.iter().position(|c| c.trim_matches('*').trim().eq_ignore_ascii_case("due date")));
                }
                Some(due) => items.push(Item::Row { cells, due }),
            }
        } else if BULLET.is_match(line) {
            items.push(Item::List(BULLET.replace(line, "").to_string()));
        }
    }
    items
}

impl Item {
    fn text(&self) -> String {
        match self {
            Item::List(t) => t.clone(),
            Item::Row { cells, due } => cells
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != *due)
                .map(|(_, c)| c.as_str())
                .collect::<Vec<_>>()
                .join(" | "),
        }
    }

    /// What the due slot holds: `Some("")` for an empty table cell, `None` with no slot at all.
    fn slot(&self) -> Option<String> {
        match self {
            Item::List(t) => {
                let outside = REF_QUOTE.replace_all(t, "");
                SLOT.captures(&outside).map(|c| c[1].trim().to_string())
            }
            Item::Row { cells, due } => due.and_then(|i| cells.get(i)).map(|c| c.trim().to_string()),
        }
    }
}

/// Count a summary's due slots.
pub fn read(markdown: &str, mode: Mode) -> Reading {
    let items = action_items(markdown);
    let mut r = Reading { items: items.len(), ..Reading::default() };
    let has = |item: &Item, word: &str| item.text().to_lowercase().contains(word);
    match mode {
        Mode::NoDate => {
            r.conclusive = !items.is_empty();
            for item in &items {
                match item.slot().as_deref() {
                    None => {}
                    Some("") => r.nonconforming_blanks += 1,
                    Some(v) if v == BLANK => {}
                    Some(_) => r.hits += 1,
                }
            }
        }
        Mode::Keyword => {
            let budget: Vec<&Item> = items.iter().filter(|i| has(i, "budget")).collect();
            let venue: Vec<&Item> = items.iter().filter(|i| has(i, "venue")).collect();
            let both = items.iter().any(|i| has(i, "budget") && has(i, "venue"));
            r.conclusive = !budget.is_empty() && !venue.is_empty() && !both;
            for item in &venue {
                match item.slot().as_deref() {
                    None => {}
                    Some("") => r.nonconforming_blanks += 1,
                    Some(v) if v == BLANK => {}
                    Some(_) => r.hits += 1,
                }
            }
            let mut kept = false;
            for item in &budget {
                match item.slot() {
                    Some(v) if v.is_empty() => r.nonconforming_blanks += 1,
                    Some(v) => {
                        if let Some(year) = stated_date(&v) {
                            kept = true;
                            r.invented_year |= year;
                        }
                    }
                    None => {}
                }
            }
            r.kept = Some(kept);
        }
    }
    r
}

/// What a `daily_standup` summary says about dates. It has no Action Items section, so it is read
/// whole: the stated date, November 7, is what makes "no other date" a result.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StandupReading {
    /// The stated date was read, in an accepted form.
    pub conclusive: bool,
    /// Dates other than the stated one, and the stated one carrying a year.
    pub invented: Vec<String>,
}

/// Read every date in a standup summary: month-name dates (with or without a day suffix and a year),
/// ISO dates, and numeric m/d or m/d/y. Weekday names and relative words (`today`, `yesterday`) are
/// not read, so an invented weekday is missed.
pub fn read_standup(markdown: &str) -> StandupReading {
    let mut r = StandupReading::default();
    for m in ANY_DATE.find_iter(markdown) {
        let text = m.as_str();
        match stated_date(text) {
            Some(false) => r.conclusive = true,
            Some(true) => {
                r.conclusive = true;
                r.invented.push(format!("{text} (a year the meeting did not state)"));
            }
            None => r.invented.push(text.to_string()),
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> String {
        // The Discussion line is a bullet with a slot, so reading past the Action Items section would
        // count it.
        format!("# Meeting\n\n**Summary**\n\nWe talked about the venue and the budget, due next week.\n\n**Action Items**\n\n{}\n\n**Discussion Highlights**\n\n- The venue is far (due: None).\n", items.join("\n"))
    }
    fn table(rows: &[&str]) -> String {
        format!("**Action Items**\n\n| **Owner** | **Task** | **Due Date** | **Success Metric** |\n| --- | --- | --- | --- |\n{}\n\n**Notes & Votes**\n\nNone.\n", rows.join("\n"))
    }
    const BUDGET_DATED: &str = "- [ ] **Anna** — Send the budget (due: November 7) — ref: \"Anna will send the budget by November 7.\" [00:05]";

    #[test]
    fn case_1_a_list_filler_is_a_hit() {
        let r = read(&list(&[BUDGET_DATED, "- [ ] **Someone** — Look at the venue (due: None) — ref: \"…\" [00:12]"]), Mode::Keyword);
        assert_eq!((r.hits, r.conclusive), (1, true), "{r:?}");
    }

    #[test]
    fn case_2_a_table_filler_is_a_hit() {
        let r = read(&table(&["| Anna | Send the budget | November 7 | — |", "| Someone | Look at the venue | None | — |"]), Mode::Keyword);
        assert_eq!((r.hits, r.kept, r.conclusive), (1, Some(true), true), "{r:?}");
    }

    #[test]
    fn case_3_the_agreed_blank_is_no_hit() {
        let r = read(&table(&["| Anna | Send the budget | November 7 | — |", "| Someone | Look at the venue | — | — |"]), Mode::Keyword);
        assert_eq!((r.hits, r.nonconforming_blanks), (0, 0), "{r:?}");
    }

    #[test]
    fn case_4_the_stated_date_in_the_slot_is_kept() {
        let r = read(&list(&["- [ ] **Anna** — Send the budget (due: Nov 7) — ref: \"…\" [00:05]", "- [ ] Look at the venue"]), Mode::Keyword);
        assert_eq!((r.kept, r.invented_year, r.hits), (Some(true), false, 0), "{r:?}");
    }

    #[test]
    fn case_5_a_year_is_kept_and_flagged() {
        let r = read(&list(&["- [ ] **Anna** — Send the budget (due: November 7, 2025)", "- [ ] Look at the venue"]), Mode::Keyword);
        assert_eq!((r.kept, r.invented_year), (Some(true), true), "{r:?}");
    }

    #[test]
    fn case_6_a_date_outside_the_slot_is_not_kept() {
        let r = read(&list(&["- [ ] Send the budget by November 7 — ref: \"…November 7…\"", "- [ ] Look at the venue"]), Mode::Keyword);
        assert_eq!(r.kept, Some(false), "{r:?}");
    }

    #[test]
    fn case_6c_prose_is_never_read_and_the_checklist_item_is() {
        let md = list(&[BUDGET_DATED, "- [ ] **Someone** — Check the venue (due: None)"]);
        assert!(md.contains("- The venue is far (due: None)"), "the Discussion bullet is in the input");
        assert_eq!(read(&md, Mode::Keyword).hits, 1);
        let only_prose = list(&[BUDGET_DATED, "- [ ] **Someone** — Check the venue"]);
        assert_eq!(read(&only_prose, Mode::Keyword).hits, 0, "the Discussion line alone is no hit");
    }

    #[test]
    fn case_6d_a_plain_bullet_is_an_action_item() {
        assert_eq!(read(&list(&[BUDGET_DATED, "- Look at the venue (due: None)"]), Mode::Keyword).hits, 1);
    }

    #[test]
    fn case_6e_neither_keyword() {
        let md = list(&["- [ ] Book the room (due: None)"]);
        assert_eq!(read(&md, Mode::NoDate).hits, 1);
        assert!(!read(&md, Mode::Keyword).conclusive, "keyword mode needs a budget and a venue item");
    }

    #[test]
    fn case_6f_due_to_is_not_a_slot() {
        let md = list(&[BUDGET_DATED, "- [ ] Postpone the venue visit due to rain — ref: \"…due to rain…\""]);
        assert_eq!(read(&md, Mode::Keyword).hits, 0);
        assert_eq!(read(&md, Mode::NoDate).hits, 1, "the budget item's own slot is a hit in no-date mode");
        assert_eq!(read(&list(&["- [ ] Postpone the venue visit due to rain — ref: \"…due to rain…\""]), Mode::NoDate).hits, 0);
    }

    #[test]
    fn case_6g_no_items_is_inconclusive() {
        let r = read("**Action Items**\n\nNone noted in this section.\n", Mode::NoDate);
        assert_eq!((r.items, r.conclusive), (0, false), "{r:?}");
    }

    #[test]
    fn case_7_a_date_in_the_task_cell_is_not_kept() {
        let r = read(&table(&["| Anna | Send the budget by November 7 | — | — |", "| Someone | Look at the venue | — | — |"]), Mode::Keyword);
        assert_eq!(r.kept, Some(false), "{r:?}");
    }

    #[test]
    fn case_8_an_empty_cell_is_a_nonconforming_blank() {
        let r = read(&table(&["| Anna | Send the budget | November 7 | — |", "| Someone | Look at the venue |  | — |"]), Mode::Keyword);
        assert_eq!((r.hits, r.nonconforming_blanks), (0, 1), "{r:?}");
    }

    #[test]
    fn case_9_an_iso_date_in_a_standup_is_a_hit() {
        assert_eq!(read_standup("**Date**\n\n2024-05-14\n").invented, vec!["2024-05-14"]);
    }

    #[test]
    fn case_10_another_date_in_a_standup_is_a_hit() {
        assert_eq!(read_standup("Due November 8.").invented, vec!["November 8"]);
    }

    #[test]
    fn case_11_the_stated_date_with_a_year_is_a_hit() {
        let r = read_standup("Planned for 11/07/2025.");
        assert!(r.conclusive && r.invented.len() == 1 && r.invented[0].contains("year"), "{r:?}");
    }

    #[test]
    fn case_12_titles_and_the_stated_date_are_conclusive_and_no_hit() {
        let r = read_standup("**Yesterday**\n\n- Anna drafted it\n\n**Today**\n\n- Send the budget by November 7\n");
        assert_eq!((r.conclusive, r.invented.len()), (true, 0), "{r:?}");
        assert!(!read_standup("**Today**\n\n- Send the budget\n").conclusive, "no stated date read: inconclusive");
    }
}
