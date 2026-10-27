# The disk floor's default, in decimal GB, in one place: scripts/disk-floor.sh and seed_copy
# (scripts/lib/kept-profile.sh) both source it, so the two cannot disagree. BC_DISK_FLOOR_GB
# overrides it. Where the number comes from is recorded in #248.
DISK_FLOOR_DEFAULT_GB=20
