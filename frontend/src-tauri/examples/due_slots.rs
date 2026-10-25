//! Reads a summary's markdown on stdin and prints its due slots as one JSON line. (#171)
//!
//! `stage2-core-check.sh` runs this over the stored summary, so the gate counts with the same function
//! Stage 1 tests, not with a second matcher written in bash.
//!
//! Usage: `cargo run -q --example due_slots -- <keyword|no-date> < summary.md`

use app_lib::summary::due_slots::{read, Mode};
use std::io::Read;

fn main() {
    let mode = match std::env::args().nth(1).as_deref() {
        Some("keyword") => Mode::Keyword,
        Some("no-date") => Mode::NoDate,
        other => {
            eprintln!("usage: due_slots <keyword|no-date> < summary.md (got {other:?})");
            std::process::exit(2);
        }
    };
    let mut markdown = String::new();
    std::io::stdin().read_to_string(&mut markdown).expect("markdown on stdin");
    let r = read(&markdown, mode);
    println!(
        "{{\"items\":{},\"hits\":{},\"conclusive\":{},\"nonconforming_blanks\":{}}}",
        r.items, r.hits, r.conclusive, r.nonconforming_blanks
    );
}
