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
//! **A slot** is a labelled value: `due:`, `due date:` or `deadline:`, case-insensitive and with any
//! `*`/`_` emphasis around it, in a list item outside its quotes; or the Due Date (or Due, or
//! Deadline) cell of a table row. The bare word is never a slot, so "postponed due to rain" is not
//! one. A filler under any other label is missed, and so is a label with no colon (`(due TBD)`).
//!
//! **A list item may carry its date in the task text.** The product owner chose "Send the budget by
//! November 7" over a separate `(due: …)` field on 2026-10-25 (#171). So in a list item, the stated
//! date anywhere outside its quotes is kept, and on an undated item any slot at all, whatever it holds,
//! or any date or deadline outside the quotes, is a hit: the format has no slot, so `(due: —)` is one
//! the model wrote. A deadline is read in relative words too ("by Friday", "next week", "within 3
//! days"). A table keeps its Due Date column, and there the cell is what counts.
//!
//! **Quotes are the transcript's text**, straight or curly, with or without `ref:` and a timestamp
//! before them, and are never read for a date. An unquoted reference is read as the item's own text.
//!
//! **Not read**, so missed: a table whose rows have no delimiter row under a header (the run is
//! inconclusive instead, because no cell is known to be the due date), and an item under a bold
//! sub-heading inside Action Items, which ends the section. Both fail toward "inconclusive" or toward
//! Stage 2's DOM cross-check, not toward a pass.

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
    /// Table rows with no header row above them, so no cell is known to be the due date.
    pub headerless_rows: usize,
    /// Whether this run says anything: keyword mode needs a budget item and a venue item, and no item
    /// holding both; no-date mode needs at least one item.
    pub conclusive: bool,
}

static SLOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:due date|due|deadline)\s*:\s*([^)—]*)").unwrap());
/// A `ref:` label with the timestamp that may follow it, and every quoted span, straight or curly.
static QUOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\bref:\s*(?:\[[^\]]*\]\s*)?|"[^"]*"|“[^”]*”"#).unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:#{1,6}\s+.+|\*\*[^*]+\*\*\s*)$").unwrap());
static ACTION_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:#{1,6}\s+action items\s*|\*\*action items\*\*\s*)$").unwrap());
static BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?").unwrap());
static MONTH: &str = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/// Full month names for a month standing alone ("in December"). `May` only capitalised, so the verb
/// is not read as one.
static FULL_MONTH: &str = r"(?:january|february|march|april|(?-i:May)|june|july|august|september|october|november|december)";
static STATED_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:nov(?:ember)?\.?\s+0?7(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?|0?7(?:st|nd|rd|th)?\s+nov(?:ember)?\.?(?:,?\s+(\d{4}))?|11/0?7(?:/(\d{2,4}))?|(?:the\s+)?0?7(?:st|nd|rd|th)?\s+of\s+nov(?:ember)?\.?(?:,?\s+(\d{4}))?|nov(?:ember)?\.?\s+the\s+0?7(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?)\b").unwrap()
});
/// Every date form read. Order matters (leftmost-first): a bare year is tried last, so it never takes
/// the year off an ISO or a numeric date, and a month after `by`/`in` takes its day with it, so "by
/// November 7" is read whole and is the stated date.
static ANY_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b(?:(?:the\s+)?\d{{1,2}}(?:st|nd|rd|th)?\s+of\s+{MONTH}\.?(?:,?\s+\d{{4}})?|{MONTH}\.?\s+the\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?|{MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?|\d{{1,2}}(?:st|nd|rd|th)?\s+{MONTH}\.?(?:,?\s+\d{{4}})?|\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?|{FULL_MONTH}\s+\d{{4}}|(?:by|in|before|until|end\s+of)\s+{FULL_MONTH}(?:\s+(?:the\s+)?\d{{1,2}}(?:st|nd|rd|th)?)?(?:,?\s+\d{{4}})?|(?:19|20)\d{{2}})\b"
    ))
    .unwrap()
});
/// A deadline in relative words, read in list items only: a standup is about today and yesterday.
static RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next\s+(?:week|month|year|quarter|sprint)|this\s+(?:week|month|weekend|sprint)|end\s+of\s+(?:the\s+)?(?:day|week|month|year|quarter|sprint)|eod|eow|(?:within|in)\s+(?:a|an|one|two|three|four|five|\d+)\s+(?:hours?|days?|weeks?|months?))\b").unwrap()
});

/// The stated date, November 7, in an accepted form, and whether a year came with it.
fn stated_date(text: &str) -> Option<bool> {
    STATED_DATE.captures(text).map(|c| (1..=5).any(|i| c.get(i).is_some()))
}

/// A line with its `*` and `_` emphasis removed, so `**Due date**:` reads as `Due date:`.
fn plain(text: &str) -> String {
    text.replace(['*', '_'], "")
}

fn cells(line: &str) -> Vec<String> {
    line.trim().trim_matches('|').split('|').map(|c| c.trim().to_string()).collect()
}

fn is_delimiter(line: &str) -> bool {
    cells(line).iter().all(|c| !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':'))
}

/// An action item: the text a slot is read from, and the text the keywords are read from.
enum Item {
    List(String),
    /// `due` is the due column, when a header names one; `headed` is false for a row with no header.
    Row { cells: Vec<String>, due: Option<usize>, headed: bool },
}

fn action_items(markdown: &str) -> Vec<Item> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut items = Vec::new();
    let mut inside = false;
    // The indent of the list item that later, deeper lines belong to.
    let mut item_indent: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if ACTION_HEADING.is_match(line) {
            inside = true;
            item_indent = None;
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
        let indent = line.len() - line.trim_start().len();
        if trimmed.starts_with('|') {
            item_indent = None;
            // The whole table: a header only when a delimiter row follows it (GFM).
            let mut block = vec![line];
            while i < lines.len() && lines[i].trim().starts_with('|') {
                block.push(lines[i]);
                i += 1;
            }
            let headed = block.len() > 1 && is_delimiter(block[1]);
            let due = headed
                .then(|| {
                    cells(block[0]).iter().position(|c| {
                        let c = plain(c);
                        let c = c.trim();
                        ["due date", "due", "deadline"].iter().any(|l| c.eq_ignore_ascii_case(l))
                    })
                })
                .flatten();
            let rows = if headed { &block[2..] } else { &block[..] };
            for row in rows.iter().filter(|r| !is_delimiter(r)) {
                items.push(Item::Row { cells: cells(row), due, headed });
            }
        } else if BULLET.is_match(line) && item_indent.is_none_or(|parent| indent <= parent) {
            item_indent = Some(indent);
            items.push(Item::List(BULLET.replace(line, "").to_string()));
        } else if !trimmed.is_empty() && item_indent.is_some_and(|parent| indent > parent) {
            // A nested bullet or a continuation line: part of the item above it.
            if let Some(Item::List(text)) = items.last_mut() {
                text.push(' ');
                text.push_str(&BULLET.replace(line, ""));
            }
        } else if !trimmed.is_empty() {
            item_indent = None;
        }
    }
    items
}

impl Item {
    fn text(&self) -> String {
        match self {
            Item::List(t) => t.clone(),
            Item::Row { cells, due, .. } => cells
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != *due)
                .map(|(_, c)| c.as_str())
                .collect::<Vec<_>>()
                .join(" | "),
        }
    }

    /// A list item's text outside its quotes; a table row's cells other than Due Date.
    fn own_text(&self) -> String {
        match self {
            Item::List(t) => QUOTES.replace_all(t, "").to_string(),
            Item::Row { .. } => self.text(),
        }
    }

    /// A date or a deadline in the item's own text, for a list item: the product owner's format puts
    /// it there.
    fn dates_in_text(&self) -> bool {
        matches!(self, Item::List(_)) && {
            let own = self.own_text();
            ANY_DATE.is_match(&own) || RELATIVE.is_match(&own)
        }
    }

    /// What the due slot holds: `Some("")` for an empty table cell, `None` with no slot at all.
    fn slot(&self) -> Option<String> {
        match self {
            Item::List(_) => SLOT.captures(&plain(&self.own_text())).map(|c| c[1].trim().to_string()),
            Item::Row { cells, due, .. } => due.and_then(|i| cells.get(i)).map(|c| c.trim().to_string()),
        }
    }

    /// Whether an undated item carries a value the meeting did not state. A list item's slot is one
    /// whatever it holds; a table cell is one unless it holds the agreed blank.
    fn hit(&self, r: &mut Reading) -> bool {
        match (self, self.slot().as_deref()) {
            (Item::List(_), Some(_)) => true,
            (Item::List(_), None) => self.dates_in_text(),
            (Item::Row { .. }, Some("")) => {
                r.nonconforming_blanks += 1;
                false
            }
            (Item::Row { .. }, Some(v)) => v != BLANK,
            (Item::Row { .. }, None) => false,
        }
    }
}

/// Count a summary's due slots.
pub fn read(markdown: &str, mode: Mode) -> Reading {
    let items = action_items(markdown);
    let mut r = Reading { items: items.len(), ..Reading::default() };
    r.headerless_rows = items.iter().filter(|i| matches!(i, Item::Row { headed: false, .. })).count();
    let has = |item: &Item, word: &str| item.text().to_lowercase().contains(word);
    match mode {
        Mode::NoDate => {
            r.conclusive = !items.is_empty() && r.headerless_rows == 0;
            for item in &items {
                if item.hit(&mut r) {
                    r.hits += 1;
                }
            }
        }
        Mode::Keyword => {
            let budget: Vec<&Item> = items.iter().filter(|i| has(i, "budget")).collect();
            let venue: Vec<&Item> = items.iter().filter(|i| has(i, "venue")).collect();
            let both = items.iter().any(|i| has(i, "budget") && has(i, "venue"));
            r.conclusive = !budget.is_empty() && !venue.is_empty() && !both && r.headerless_rows == 0;
            for item in &venue {
                if item.hit(&mut r) {
                    r.hits += 1;
                }
            }
            let mut kept = false;
            for item in &budget {
                // A table row keeps its date in the Due Date cell; a list item, anywhere outside its ref
                // quote (the product owner's format, 2026-10-25).
                let carried = match (item, item.slot()) {
                    (_, Some(v)) if v.is_empty() => {
                        r.nonconforming_blanks += 1;
                        None
                    }
                    (Item::Row { .. }, slot) => slot,
                    (Item::List(_), _) => Some(item.own_text()),
                };
                if let Some(year) = carried.as_deref().and_then(stated_date) {
                    kept = true;
                    r.invented_year |= year;
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

    /// The product owner's format (2026-10-25): the date in the task text is kept. The ref quote alone
    /// is not the item's own text.
    #[test]
    fn case_6_a_date_in_the_task_text_is_kept_and_in_the_quote_alone_is_not() {
        let r = read(&list(&["- [ ] Send the budget by November 7 — ref: \"…November 7…\"", "- [ ] Look at the venue"]), Mode::Keyword);
        assert_eq!(r.kept, Some(true), "{r:?}");
        let r = read(&list(&["- [ ] Send the budget — ref: \"Anna will send the budget by November 7.\"", "- [ ] Look at the venue"]), Mode::Keyword);
        assert_eq!(r.kept, Some(false), "{r:?}");
    }

    /// An undated item given a date in its text is a hit, as a filled slot is.
    #[test]
    fn case_6h_a_date_in_the_undated_items_text_is_a_hit() {
        let md = list(&[BUDGET_DATED, "- [ ] Look at the venue by November 9 — ref: \"Someone should look at the venue.\""]);
        assert_eq!(read(&md, Mode::Keyword).hits, 1);
        assert_eq!(read(&list(&["- [ ] Look at the venue by November 9"]), Mode::NoDate).hits, 1);
        let quoted = list(&[BUDGET_DATED, "- [ ] Look at the venue — ref: \"we met on November 9\""]);
        assert_eq!(read(&quoted, Mode::Keyword).hits, 0, "a date inside the quote is the transcript's, not the model's");
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

    // Cases 13 to 22 are the shapes the gate's adversary fed the counter at `0e8b8a3`, every one of
    // which it read wrong. Each was red before the counter changed.
    const VENUE_QUOTE: &str = "ref: \"Someone should look at the venue.\" [00:12]";

    /// A list item's slot is a hit whatever it holds: the format omits the slot, so the agreed blank,
    /// or nothing, is still a slot the model wrote.
    #[test]
    fn case_13_any_slot_on_a_list_item_is_a_hit() {
        for slot in ["(due: —)", "(due: )", "(deadline: TBD)"] {
            let item = format!("- [ ] Look at the venue {slot} — {VENUE_QUOTE}");
            let r = read(&list(&[BUDGET_DATED, &item]), Mode::Keyword);
            assert_eq!((r.hits, r.conclusive), (1, true), "{slot}: {r:?}");
            assert_eq!(read(&list(&[&item]), Mode::NoDate).hits, 1, "{slot} in no-date mode");
        }
    }

    #[test]
    fn case_14_emphasis_around_the_label_is_still_a_slot() {
        for item in ["- [ ] Look at the venue — **Due date**: None", "- [ ] Look at the venue (*Due*: TBD)", "- [ ] Look at the venue (__deadline__: unknown)"] {
            assert_eq!(read(&list(&[BUDGET_DATED, item]), Mode::Keyword).hits, 1, "{item}");
        }
    }

    #[test]
    fn case_15_a_deadline_column_is_the_due_column() {
        let md = "**Action Items**\n\n| Owner | Task | Deadline |\n| --- | --- | --- |\n| Anna | Send the budget | November 7 |\n| Someone | Look at the venue | None |\n";
        let r = read(md, Mode::Keyword);
        assert_eq!((r.hits, r.kept, r.conclusive), (1, Some(true), true), "{r:?}");
    }

    /// A table with no delimiter row has no header, so no cell can be told to be the due date. Read
    /// in v1's retrospective run 1, where the first row was taken for a header.
    #[test]
    fn case_16_a_table_without_a_header_is_inconclusive() {
        let md = "**Action Items**\n\n| **Anna** | Send the budget | November 7 | — |\n| **Others** | Look at the venue | None | — |\n| Sam | Book the venue | None | — |\n";
        for mode in [Mode::Keyword, Mode::NoDate] {
            let r = read(md, mode);
            assert_eq!((r.items, r.headerless_rows, r.conclusive), (3, 3, false), "{mode:?}: {r:?}");
        }
    }

    #[test]
    fn case_17_a_nested_line_belongs_to_its_item() {
        let md = list(&[BUDGET_DATED, "- [ ] Look at the venue", "  - Due: None"]);
        let r = read(&md, Mode::Keyword);
        assert_eq!((r.items, r.hits), (2, 1), "{r:?}");
    }

    #[test]
    fn case_18_numbered_and_plus_items_are_items() {
        for item in ["1. Look at the venue (due: None)", "2) Look at the venue (due: None)", "+ Look at the venue (due: None)"] {
            let r = read(&list(&[BUDGET_DATED, item]), Mode::Keyword);
            assert_eq!((r.items, r.hits), (2, 1), "{item}: {r:?}");
        }
    }

    /// The product owner's format lets a date live in the task text, so an invented one can too: a
    /// relative deadline on an undated item is a hit.
    #[test]
    fn case_19_a_relative_deadline_on_an_undated_item_is_a_hit() {
        for when in ["by Friday", "by next week", "by the end of the month", "tomorrow", "within 3 days", "today", "this week"] {
            let item = format!("- [ ] Look at the venue {when} — {VENUE_QUOTE}");
            let r = read(&list(&[BUDGET_DATED, &item]), Mode::Keyword);
            assert_eq!((r.hits, r.conclusive), (1, true), "{when}: {r:?}");
            assert_eq!(read(&list(&[&item]), Mode::NoDate).hits, 1, "{when} in no-date mode");
        }
    }

    #[test]
    fn case_20_other_date_forms_are_dates() {
        for when in ["by the 9th of November", "by November the 9th", "in December", "by October 2025", "in 2026"] {
            let item = format!("- [ ] Look at the venue {when}");
            assert_eq!(read(&list(&[BUDGET_DATED, &item]), Mode::Keyword).hits, 1, "{when}");
        }
        for stated in ["by the 7th of November", "by November the 7th"] {
            let item = format!("- [ ] Send the budget {stated}");
            assert_eq!(read(&list(&[&item, "- [ ] Look at the venue"]), Mode::Keyword).kept, Some(true), "{stated}");
        }
        // After `in`, where a month-alone reading would take it: the guard is what keeps the verb out.
        let may = list(&[BUDGET_DATED, "- [ ] Check whether the venue we book in may change"]);
        assert_eq!(read(&may, Mode::Keyword).hits, 0, "the verb `may` is not a month");
    }

    /// The quote is the transcript's text, in whatever form the model writes it.
    #[test]
    fn case_21_a_quote_in_any_form_is_the_transcripts() {
        for quote in ["ref: “Anna will send the budget by November 7.”", "ref: [00:05] \"Anna will send the budget by November 7.\"", "\"Anna will send the budget by November 7.\" [00:05]"] {
            let item = format!("- [ ] Send the budget — {quote}");
            assert_eq!(read(&list(&[&item, "- [ ] Look at the venue"]), Mode::Keyword).kept, Some(false), "{quote}");
        }
        let curly = list(&[BUDGET_DATED, "- [ ] Look at the venue — ref: “we met on November 9”"]);
        assert_eq!(read(&curly, Mode::Keyword).hits, 0, "a date inside a curly quote is the transcript's");
    }

    #[test]
    fn case_22_a_standup_reads_more_date_forms() {
        let r = read_standup("**Today**\n\n- Send the budget by the 7th of November\n");
        assert_eq!((r.conclusive, r.invented.len()), (true, 0), "{r:?}");
        for text in ["- Send the budget by November 7, before October 2025", "- Send the budget by November 7 (Monday, 2024)"] {
            let r = read_standup(text);
            assert!(r.conclusive && !r.invented.is_empty(), "{text}: {r:?}");
        }
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

#[cfg(test)]
mod instrument {
    //! What the model writes, counted. (#171 condition 3)
    //!
    //! Each arm summarises one two-line transcript, in which one task states a date and one states
    //! none, through `generate_meeting_summary` with the built-in `gemma4:e2b`, as the application
    //! calls it. Runs continue until 10 are conclusive, 15 at most. The thresholds were registered on
    //! #171 before any run, and nothing is rerun.
    //!
    //! Needs the summary model in `BC_SUMMARY_APP_DIR/models/summary` (default
    //! `~/.cache/backchannel-core-models`), and the sidecar in `CONVERSATIONALY_LLAMA_HELPER` or where
    //! the application finds it.
    use super::*;
    use crate::summary::llm_client::LLMProvider;
    use crate::summary::processor::generate_meeting_summary;
    use crate::summary::templates::Template;
    use std::path::{Path, PathBuf};

    const INPUT: &str = "[00:05] Others: Anna will send the budget by November 7.\n[00:12] Others: Someone should look at the venue.";
    const MODEL: &str = "gemma4:e2b";

    fn template(path: &Path) -> Template {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("a template")
    }

    #[test]
    #[ignore = "needs the built-in summary model and its sidecar; about 20 minutes; run by name, output pasted into #171's verdict"]
    fn what_the_model_writes_into_a_due_slot() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let app_dir: PathBuf = std::env::var("BC_SUMMARY_APP_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            Path::new(&std::env::var("HOME").unwrap()).join(".cache/backchannel-core-models")
        });
        let arms: Vec<(&str, PathBuf)> = vec![
            ("new standard_meeting", manifest.join("templates/standard_meeting.json")),
            ("new retrospective", manifest.join("templates/retrospective.json")),
            ("old standard_meeting", manifest.join("tests/fixtures/templates-before-171/standard_meeting.json")),
            ("old retrospective", manifest.join("tests/fixtures/templates-before-171/retrospective.json")),
            ("daily_standup", manifest.join("templates/daily_standup.json")),
        ];
        // `BC_ARMS`, comma-separated, runs only the named arms: a revised template is measured again
        // without paying for the arms it does not change.
        let only: Vec<String> = std::env::var("BC_ARMS").map(|v| v.split(',').map(|a| a.trim().to_string()).collect()).unwrap_or_default();
        let arms: Vec<(&str, PathBuf)> = arms.into_iter().filter(|(a, _)| only.is_empty() || only.iter().any(|o| o == a)).collect();
        assert!(!arms.is_empty(), "BC_ARMS names no arm");
        let detected = crate::summary::language_detection::detect_summary_language(&[INPUT.to_string()]).language;
        let threshold = crate::summary::summary_engine::models::get_model_by_name(MODEL).expect("the model").context_size.saturating_sub(300) as usize;
        eprintln!("detected language: {detected:?}; token threshold: {threshold}");
        let rt = tokio::runtime::Runtime::new().expect("a runtime");
        let client = reqwest::Client::new();
        let mut failures = Vec::new();
        for (arm, path) in &arms {
            let t = template(path);
            let id = path.file_stem().unwrap().to_string_lossy().to_string();
            let (mut conclusive, mut runs, mut hits, mut kept, mut years, mut blanks, mut headerless) = (0, 0, 0, 0, 0, 0, 0);
            let mut standup_invented: Vec<String> = Vec::new();
            while conclusive < 10 && runs < 15 {
                runs += 1;
                let out = rt.block_on(generate_meeting_summary(
                    &client, &LLMProvider::BuiltInAI, MODEL, "", INPUT, "", &id, &t, threshold,
                    None, None, None, None, None, Some(&app_dir), None, None, detected.as_deref(), None,
                ));
                let markdown = match out {
                    Ok((md, _, _)) => md,
                    Err(e) => {
                        eprintln!("{arm} run {runs}: the summary failed: {e}");
                        continue;
                    }
                };
                if *arm == "daily_standup" {
                    let r = read_standup(&markdown);
                    if r.conclusive {
                        conclusive += 1;
                        if !r.invented.is_empty() {
                            hits += 1;
                            standup_invented.extend(r.invented.clone());
                        }
                    }
                    eprintln!("{arm} run {runs}: conclusive={} invented={:?}", r.conclusive, r.invented);
                } else {
                    let r = read(&markdown, Mode::Keyword);
                    eprintln!("{arm} run {runs}: {r:?}");
                    blanks += r.nonconforming_blanks;
                    headerless += r.headerless_rows;
                    if r.conclusive {
                        conclusive += 1;
                        hits += usize::from(r.hits > 0);
                        kept += usize::from(r.kept == Some(true));
                        years += usize::from(r.invented_year);
                    }
                }
                // Every run's markdown, so each reading can be checked against what the model wrote (the
                // gate's adversary could check 2 of v3's 10).
                eprintln!("--- {arm} run {runs} markdown ---\n{markdown}\n---");
            }
            let measured = runs - conclusive <= 5 && conclusive >= 10;
            eprintln!(
                "== {arm}: {conclusive} conclusive of {runs} runs; runs with a hit {hits}; dated item kept {kept}; invented years {years}; non-compliant blanks {blanks}; headerless table rows {headerless}{}{}",
                if measured { "" } else { " — NOT MEASURED (more than 5 inconclusive)" },
                if standup_invented.is_empty() { String::new() } else { format!("; dates invented: {standup_invented:?}") }
            );
            if !measured {
                continue;
            }
            match *arm {
                "new standard_meeting" | "new retrospective" => {
                    if hits > 0 {
                        failures.push(format!("{arm}: {hits} of {conclusive} runs put a due slot on the undated item"));
                    }
                    if kept < 8 {
                        failures.push(format!("{arm}: the dated item kept its date in {kept} of {conclusive}, under 8"));
                    }
                }
                "daily_standup" => {
                    if hits > 0 {
                        failures.push(format!("{arm}: {hits} of {conclusive} runs carried a date other than November 7 as stated: {standup_invented:?}"));
                    }
                }
                _ => eprintln!("   (an old arm: {} — the instrument {} discriminate)", hits, if hits >= 4 { "does" } else { "does NOT" }),
            }
        }
        assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
    }
}
