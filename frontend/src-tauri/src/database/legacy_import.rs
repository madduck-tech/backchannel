//! Legacy database import: the schemas a real upgrade actually starts from.
//!
//! #68. `DatabaseManager::new` copies a legacy `.db` into `meeting_minutes.sqlite` and migrates it.
//! Two legacy shapes exist and only one worked: the one carrying `meetings.folder_path` collided
//! with `20251006000000_add_audio_sync_fields` — `duplicate column name: folder_path` — and left a
//! half-built `.sqlite` behind, which made the application unstartable forever because
//! `is_first_launch` reads that file's existence.
#![cfg(test)]

use crate::database::manager::DatabaseManager;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Row, SqlitePool};

/// The shape the archived Python backend created, copied from `backend/app/db.py` at `fbcabfe^`.
///
/// **All four** of `20251006000000`'s `ADD COLUMN`s collide with it, not just the first:
/// `meetings.folder_path` and all three of `transcripts.audio_start_time`, `audio_end_time`,
/// `duration` are already declared here. Guarding only `folder_path` moves the failure to
/// `duplicate column name: audio_start_time` in the same migration, which is why the fixture is
/// the real schema rather than the minimum that reproduces the first error.
const LEGACY_WITH_FOLDER_PATH: &str = "
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT);
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL,
        transcript TEXT NOT NULL, timestamp TEXT NOT NULL, summary TEXT,
        action_items TEXT, key_points TEXT,
        audio_start_time REAL, audio_end_time REAL, duration REAL);
    INSERT INTO meetings (id, title, created_at, updated_at, folder_path)
        VALUES ('m1','Legacy meeting','2026-01-01','2026-01-01','/tmp/x');
    INSERT INTO transcripts (id, meeting_id, transcript, timestamp)
        VALUES ('t1','m1','words from before the fork','2026-01-01');
";

/// The older Meetily shape, without `folder_path`. This one always worked, and a fix that breaks
/// it would trade one broken population for another.
const LEGACY_WITHOUT_FOLDER_PATH: &str = "
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL,
        transcript TEXT NOT NULL, timestamp TEXT NOT NULL, summary TEXT,
        action_items TEXT, key_points TEXT);
    INSERT INTO meetings (id, title, created_at, updated_at)
        VALUES ('m1','Older meeting','2026-01-01','2026-01-01');
    INSERT INTO transcripts (id, meeting_id, transcript, timestamp)
        VALUES ('t1','m1','words from the older shape','2026-01-01');
";

async fn write_legacy(path: &std::path::Path, schema: &'static str) {
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("create the legacy file");
    let mut conn = pool.acquire().await.unwrap();
    sqlx::raw_sql(schema).execute(&mut *conn).await.expect("seed the legacy schema");
    drop(conn);
    pool.close().await;
}

async fn one_string(pool: &SqlitePool, sql: &'static str) -> String {
    let mut conn = pool.acquire().await.expect("a connection");
    sqlx::query(sql).fetch_one(&mut *conn).await.unwrap().get::<String, _>(0)
}

/// The fixture is pinned to the real legacy schema, because a fixture that reproduces only the
/// *first* collision would let a fix that guards only `folder_path` pass while the import stays
/// broken — the failure simply moves to `duplicate column name: audio_start_time` in the same
/// migration. All four of `20251006000000`'s `ADD COLUMN`s collide with this shape, and this test
/// is what keeps that true if someone trims the fixture.
#[tokio::test]
async fn the_fixture_collides_on_all_four_columns_the_migration_adds() {
    let dir = tempfile::tempdir().expect("temp dir");
    let legacy = dir.path().join("legacy.db");
    write_legacy(&legacy, LEGACY_WITH_FOLDER_PATH).await;

    let url = format!("sqlite://{}", legacy.display());
    let pool = SqlitePoolOptions::new().max_connections(1).connect(&url).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();

    for (table, column) in [
        ("meetings", "folder_path"),
        ("transcripts", "audio_start_time"),
        ("transcripts", "audio_end_time"),
        ("transcripts", "duration"),
    ] {
        let pragma = if table == "meetings" {
            "PRAGMA table_info(meetings)"
        } else {
            "PRAGMA table_info(transcripts)"
        };
        let columns: Vec<String> = sqlx::query(pragma)
            .fetch_all(&mut *conn)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        assert!(
            columns.contains(&column.to_string()),
            "the legacy fixture no longer declares {table}.{column}, so it reproduces fewer than \
             the four collisions the real schema has and a partial fix would pass against it"
        );
    }
}

/// Red-first: before the fix this fails with `duplicate column name: folder_path`.
#[tokio::test]
async fn a_legacy_database_carrying_folder_path_imports_and_keeps_its_rows() {
    let dir = tempfile::tempdir().expect("temp dir");
    let legacy = dir.path().join("meeting_minutes.db");
    let target = dir.path().join("meeting_minutes.sqlite");
    write_legacy(&legacy, LEGACY_WITH_FOLDER_PATH).await;

    let manager = DatabaseManager::new(target.to_str().unwrap(), legacy.to_str().unwrap())
        .await
        .expect("a legacy database with folder_path must import");

    assert_eq!(
        one_string(manager.pool(), "SELECT transcript FROM transcripts WHERE id = 't1'").await,
        "words from before the fork",
        "the transcript did not survive the import"
    );
    assert_eq!(
        one_string(manager.pool(), "SELECT folder_path FROM meetings WHERE id = 'm1'").await,
        "/tmp/x",
        "the column that caused the collision lost its value"
    );
    // The three columns 20251006000000 also adds must exist, or a later insert fails at runtime.
    let mut conn = manager.pool().acquire().await.unwrap();
    let columns: Vec<String> = sqlx::query("PRAGMA table_info(transcripts)")
        .fetch_all(&mut *conn)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<String, _>("name"))
        .collect();
    for column in ["audio_start_time", "audio_end_time", "duration", "speaker", "channel"] {
        assert!(columns.contains(&column.to_string()), "transcripts is missing {column}");
    }
}

/// The shape that already worked. A fix for the one above must not cost this one.
#[tokio::test]
async fn the_older_legacy_shape_still_imports() {
    let dir = tempfile::tempdir().expect("temp dir");
    let legacy = dir.path().join("meeting_minutes.db");
    let target = dir.path().join("meeting_minutes.sqlite");
    write_legacy(&legacy, LEGACY_WITHOUT_FOLDER_PATH).await;

    let manager = DatabaseManager::new(target.to_str().unwrap(), legacy.to_str().unwrap())
        .await
        .expect("the older legacy shape must keep importing");

    assert_eq!(
        one_string(manager.pool(), "SELECT transcript FROM transcripts WHERE id = 't1'").await,
        "words from the older shape"
    );
}

/// The durable half, and the one that protects against collisions nobody has found yet.
///
/// Leaving a half-built `.sqlite` behind is what made #68 permanent: the file exists, so
/// `is_first_launch` is false, onboarding never offers the import again, and the application cannot
/// start until someone deletes it by hand.
#[tokio::test]
async fn a_failed_import_leaves_no_database_behind() {
    let dir = tempfile::tempdir().expect("temp dir");
    let legacy = dir.path().join("meeting_minutes.db");
    let target = dir.path().join("meeting_minutes.sqlite");

    // A schema the chain cannot migrate: `meetings` exists with a column of a type the later
    // migrations contradict, and no reconciliation covers it. This stands for every unknown
    // collision, which is the point — the guarantee is about the file, not about this shape.
    write_legacy(
        &legacy,
        "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL,
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT);
         CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL,
             transcript TEXT NOT NULL, timestamp TEXT NOT NULL, speaker TEXT);
         INSERT INTO meetings (id, title, created_at, updated_at, folder_path)
             VALUES ('m1','M','t','t','/x');",
    )
    .await;

    let result = DatabaseManager::new(target.to_str().unwrap(), legacy.to_str().unwrap()).await;

    assert!(result.is_err(), "this schema must not migrate — the fixture is wrong, not the code");
    assert!(
        !target.exists(),
        "a failed import left meeting_minutes.sqlite behind — that is what makes the failure \
         permanent, because is_first_launch reads this file's existence"
    );
    assert!(
        !legacy.exists(),
        "the unmigratable legacy copy is still in place, so the next launch copies it again and \
         fails again — and `initialize_fresh_database` goes through the same code and fails with it"
    );
    assert!(
        legacy.with_extension("db.unmigratable").exists(),
        "it must be moved aside, not deleted: destroying a copy of the user's data to recover from \
         a failure is not this function's call to make"
    );

    // The recovery actually recovers: with the unmigratable copy out of the way, the same call
    // builds a fresh database instead of failing again.
    DatabaseManager::new(target.to_str().unwrap(), legacy.to_str().unwrap())
        .await
        .expect("after the failure, a fresh database can be created");
    assert!(target.exists());
}
