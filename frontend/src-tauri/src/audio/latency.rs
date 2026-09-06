//! Percentiles over latency samples, and nothing else.
//!
//! #65. ADR 0008 sets latency targets in p95 and **nothing in this repository has ever measured
//! one**. `BenchSink` already computes a lag per commit (`bench_sink.rs:131`) and throws it into a
//! log line; there was no collector and no report, and `docs/milestones/` did not exist.
//!
//! This module is the arithmetic, separated from everything that needs a microphone so it can be
//! wrong in a way a test catches. Feeding it fabricated instants needs no audio, no models and no
//! display — which matters, because the *measurement* it serves cannot run in CI at all.
//!
//! **The percentile definition is stated rather than assumed.** There are at least seven in common
//! use and they disagree on small samples; a report that says "p95" without saying which one is a
//! number nobody can reproduce. This uses **nearest-rank**: the p-th percentile is the value at
//! index `ceil(p/100 * n) - 1` of the sorted samples, which is always an observed value and never
//! an interpolation between two.

/// A summary of latency samples, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Percentiles {
    pub count: usize,
    pub min_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Nearest-rank percentiles over `samples`, which is sorted in place.
///
/// Returns `None` for an empty slice rather than a zero: a report that prints `p95 = 0 ms` when
/// nothing was measured is worse than one that prints nothing, because zero looks like a result.
pub fn percentiles(samples: &mut [f64]) -> Option<Percentiles> {
    if samples.is_empty() {
        return None;
    }
    // `total_cmp` and not `partial_cmp().unwrap()`: a NaN from a bad subtraction would panic in
    // the middle of a recording rather than showing up in the report as an absurd number.
    samples.sort_by(|a, b| a.total_cmp(b));

    Some(Percentiles {
        count: samples.len(),
        min_ms: samples[0],
        p50_ms: samples[nearest_rank(samples.len(), 50.0)],
        p95_ms: samples[nearest_rank(samples.len(), 95.0)],
        max_ms: samples[samples.len() - 1],
    })
}

/// The index of the p-th percentile under nearest-rank, clamped to the slice.
fn nearest_rank(n: usize, p: f64) -> usize {
    let rank = (p / 100.0 * n as f64).ceil() as usize;
    rank.saturating_sub(1).min(n - 1)
}

impl std::fmt::Display for Percentiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "n={} min={:.0}ms p50={:.0}ms p95={:.0}ms max={:.0}ms",
            self.count, self.min_ms, self.p50_ms, self.p95_ms, self.max_ms
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one number ADR 0008 states its criteria in. Ten samples 1..10: nearest-rank p95 is
    /// `ceil(0.95 * 10) = 10` -> index 9 -> **10**. An interpolating definition gives 9.55, and a
    /// `n * 0.95` truncation gives index 9 by accident but index 4 for p50 where this gives 5.
    /// Stating the definition is what makes the report reproducible.
    #[test]
    fn nearest_rank_p95_is_an_observed_value_not_an_interpolation() {
        let mut samples: Vec<f64> = (1..=10).map(|v| v as f64).collect();
        let p = percentiles(&mut samples).expect("ten samples");
        assert_eq!(p.count, 10);
        assert_eq!(p.min_ms, 1.0);
        assert_eq!(p.p50_ms, 5.0, "nearest-rank p50 of 1..10 is the 5th value");
        assert_eq!(p.p95_ms, 10.0, "nearest-rank p95 of 1..10 is the 10th value");
        assert_eq!(p.max_ms, 10.0);
    }

    /// The percentiles must come from a *sorted* view. Given in a hostile order, the answer is
    /// the same — a summary that depended on arrival order would report whatever the recording
    /// happened to do first.
    #[test]
    fn the_order_samples_arrive_in_does_not_change_the_answer() {
        let mut ascending: Vec<f64> = (1..=100).map(|v| v as f64).collect();
        let mut descending: Vec<f64> = (1..=100).rev().map(|v| v as f64).collect();
        let mut shuffled = vec![
            50.0, 1.0, 99.0, 100.0, 2.0, 75.0, 25.0, 3.0, 98.0, 4.0,
        ];
        shuffled.extend((5..=24).map(|v| v as f64));
        shuffled.extend((26..=49).map(|v| v as f64));
        shuffled.extend((51..=74).map(|v| v as f64));
        shuffled.extend((76..=97).map(|v| v as f64));

        let a = percentiles(&mut ascending).unwrap();
        let d = percentiles(&mut descending).unwrap();
        let s = percentiles(&mut shuffled).unwrap();
        assert_eq!(a, d, "descending input gave a different summary");
        assert_eq!(a.count, s.count, "the shuffled fixture is not the same 100 values");
        assert_eq!(a, s, "shuffled input gave a different summary");
        assert_eq!(a.p50_ms, 50.0);
        assert_eq!(a.p95_ms, 95.0);
    }

    /// A single sample is its own p50 and p95. The rank arithmetic must not index past the end,
    /// which `saturating_sub(1)` and the `min` are for — a panic here would take a recording down.
    #[test]
    fn small_samples_do_not_index_past_the_end() {
        for n in 1..=5usize {
            let mut samples: Vec<f64> = (1..=n).map(|v| v as f64).collect();
            let p = percentiles(&mut samples).unwrap_or_else(|| panic!("{n} samples"));
            assert_eq!(p.count, n);
            assert_eq!(p.p95_ms, n as f64, "p95 of 1..{n} under nearest-rank is the last value");
            assert!(p.p50_ms <= p.p95_ms);
        }
    }

    /// Nothing measured is not zero milliseconds. A report printing `p95 = 0 ms` when no commit
    /// ever arrived would read as an excellent result.
    #[test]
    fn no_samples_is_none_and_not_a_zero() {
        assert!(percentiles(&mut []).is_none());
    }

    /// A NaN must not panic mid-recording. `total_cmp` orders it to the end rather than throwing.
    #[test]
    fn a_nan_sample_does_not_panic_the_summary() {
        let mut samples = vec![10.0, f64::NAN, 20.0];
        let p = percentiles(&mut samples).expect("three samples");
        assert_eq!(p.count, 3);
        assert_eq!(p.min_ms, 10.0, "a NaN must not become the minimum");
    }
}
