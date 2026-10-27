# The cap on each target/, in decimal GB, read by scripts/disk-sweep.sh. BC_TARGET_CAP_GB, or
# BC_TARGET_CAP_BYTES in tests, overrides it.
#
# Measured on 2026-10-27 (#257): a target/ of its own, in a fresh worktree, after all of Stage 1,
# Stage 2's builds and the due_slots example, was 21 351 874 560 bytes. A quarter more is 26.7 GB.
TARGET_CAP_DEFAULT_GB=27
