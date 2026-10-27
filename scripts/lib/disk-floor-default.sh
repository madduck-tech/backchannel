# The disk floor's default, in decimal GB, in one place: scripts/disk-floor.sh and seed_copy
# (scripts/lib/kept-profile.sh) both source it, so the two cannot disagree. BC_DISK_FLOOR_GB
# overrides it.
#
# Measured on 2026-10-27 (#248): a cold gate -- a fresh target/, all of Stage 1, Stage 2's builds
# and the due_slots example -- took free space down by 21.85 GB, and Stage 2's passes by another
# 6.77 GB. With a 1 GB reserve for recording (about 15 hours at 64 MB an hour), that is 29.62 GB,
# rounded up.
DISK_FLOOR_DEFAULT_GB=30
