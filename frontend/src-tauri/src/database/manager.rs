use sqlx::{migrate::MigrateDatabase, Result, Sqlite, SqlitePool, Transaction};
use std::fs;
use std::path::Path;
use tauri::Manager;

#[derive(Clone)]
pub struct DatabaseManager {
    pool: SqlitePool,
}

impl DatabaseManager {
    pub async fn new(tauri_db_path: &str, backend_db_path: &str) -> Result<Self> {
        if let Some(parent_dir) = Path::new(tauri_db_path).parent() {
            if !parent_dir.exists() {
                fs::create_dir_all(parent_dir).map_err(sqlx::Error::Io)?;
            }
        }

        if !Path::new(tauri_db_path).exists() {
            if Path::new(backend_db_path).exists() {
                log::info!(
                    "Copying database from {} to {}",
                    backend_db_path,
                    tauri_db_path
                );
                fs::copy(backend_db_path, tauri_db_path).map_err(sqlx::Error::Io)?;
            } else {
                log::info!("Creating database at {}", tauri_db_path);
                Sqlite::create_database(tauri_db_path).await?;
            }
        }

        let pool = SqlitePool::connect(tauri_db_path).await?;

        // A database that came from a legacy `.db` has never seen sqlx and may already carry
        // columns the chain is about to add. Reconcile before migrating, not after (#68).
        reconcile_foreign_schema(&pool).await?;

        if let Err(error) = sqlx::migrate!("./migrations").run(&pool).await {
            // Leaving the half-built file behind is what made #68 permanent: `meeting_minutes.sqlite`
            // then exists, so `is_first_launch` is false forever, onboarding never offers the import
            // again, and the application cannot start until someone deletes a file by hand in a
            // directory they have no reason to know about. Remove it, so a failed import costs the
            // import and nothing else — including for collisions nobody has found yet.
            log::error!("Migrations failed on {tauri_db_path}: {error}. Removing the partial database.");
            // `close()` and not `drop()`: it waits for every connection to be returned and shut
            // down. `drop` only marks the pool closed, and on Windows a file with an open handle
            // cannot be removed — so the cleanup below failed silently there and the partial
            // database stayed, which is the whole defect. Caught by #46's Windows job on its
            // first run against this fix; Linux and macOS both passed.
            pool.close().await;
            if let Err(cleanup) = fs::remove_file(tauri_db_path) {
                log::error!("Could not remove {tauri_db_path}: {cleanup}");
            }
            // And move the legacy copy aside, or the recovery loops: this function copies
            // `meeting_minutes.db` into `.sqlite` whenever `.sqlite` is absent, so deleting the
            // partial database alone means the next launch copies the same unmigratable file and
            // fails again — and `initialize_fresh_database`, the user's only other option, goes
            // through this same function and fails with it. Renamed rather than deleted: it is a
            // copy the application made, the user's own file is untouched, and destroying data
            // to recover from a failure is not this function's call to make.
            if Path::new(backend_db_path).exists() {
                let aside = format!("{backend_db_path}.unmigratable");
                match fs::rename(backend_db_path, &aside) {
                    Ok(()) => log::error!("Moved the unmigratable legacy copy to {aside}"),
                    Err(e) => log::error!("Could not move {backend_db_path} aside: {e}"),
                }
            }
            return Err(error.into());
        }

        Ok(DatabaseManager { pool })
    }

    // NOTE: So for the first time users they needs to start the application
    // after they can just delete the existing .sqlite file and then copy the existing .db file to
    // the current app dir, So the system detects legacy db and copy it and starts with that data
    // (Newly created .sqlite with the copied content from .db)
    pub async fn new_from_app_handle(app_handle: &tauri::AppHandle) -> Result<Self> {
        // Resolve the app's data directory
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .expect("failed to get app data dir");
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(sqlx::Error::Io)?;
        }

        // Define database paths
        let tauri_db_path = app_data_dir
            .join("meeting_minutes.sqlite")
            .to_string_lossy()
            .to_string();
        // Legacy backend DB path (for auto-migration if exists)
        let backend_db_path = app_data_dir
            .join("meeting_minutes.db")
            .to_string_lossy()
            .to_string();

        // WAL file paths for defensive cleanup
        let wal_path = app_data_dir.join("meeting_minutes.sqlite-wal");
        let shm_path = app_data_dir.join("meeting_minutes.sqlite-shm");

        log::info!("Tauri DB path: {}", tauri_db_path);
        log::info!("Legacy backend DB path: {}", backend_db_path);

        // Try to open database with defensive WAL handling
        match Self::new(&tauri_db_path, &backend_db_path).await {
            Ok(db_manager) => {
                log::info!("Database opened successfully");
                Ok(db_manager)
            }
            Err(e) => {
                // Check if error is due to corrupted WAL file
                let error_msg = e.to_string();
                if error_msg.contains("malformed") || error_msg.contains("corrupt") {
                    log::warn!("Database appears corrupted, likely due to orphaned WAL file. Attempting recovery...");
                    log::warn!("Error details: {}", error_msg);

                    // Delete potentially corrupted WAL/SHM files
                    if wal_path.exists() {
                        match fs::remove_file(&wal_path) {
                            Ok(_) => log::info!("Removed orphaned WAL file: {:?}", wal_path),
                            Err(e) => log::warn!("Failed to remove WAL file: {}", e),
                        }
                    }
                    if shm_path.exists() {
                        match fs::remove_file(&shm_path) {
                            Ok(_) => log::info!("Removed orphaned SHM file: {:?}", shm_path),
                            Err(e) => log::warn!("Failed to remove SHM file: {}", e),
                        }
                    }

                    // Retry connection without WAL files
                    log::info!("Retrying database connection after WAL cleanup...");
                    match Self::new(&tauri_db_path, &backend_db_path).await {
                        Ok(db_manager) => {
                            log::info!("Database opened successfully after WAL recovery");
                            Ok(db_manager)
                        }
                        Err(retry_err) => {
                            log::error!("Database connection failed even after WAL cleanup: {}", retry_err);
                            Err(retry_err)
                        }
                    }
                } else {
                    // Not a WAL-related error, propagate original error
                    log::error!("Database connection failed: {}", error_msg);
                    Err(e)
                }
            }
        }
    }

    /// Check if this is the first launch (sqlite database doesn't exist yet)
    pub async fn is_first_launch(app_handle: &tauri::AppHandle) -> Result<bool> {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .expect("failed to get app data dir");

        let tauri_db_path = app_data_dir.join("meeting_minutes.sqlite");

        Ok(!tauri_db_path.exists())
    }

    /// Import a legacy database from the specified path and initialize
    pub async fn import_legacy_database(
        app_handle: &tauri::AppHandle,
        legacy_db_path: &str,
    ) -> Result<Self> {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .expect("failed to get app data dir");

        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(sqlx::Error::Io)?;
        }

        // Copy legacy database to app data directory as meeting_minutes.db
        let target_legacy_path = app_data_dir.join("meeting_minutes.db");
        log::info!(
            "Copying legacy database from {} to {}",
            legacy_db_path,
            target_legacy_path.display()
        );

        fs::copy(legacy_db_path, &target_legacy_path).map_err(sqlx::Error::Io)?;

        // Now use the standard initialization which will detect and migrate the legacy db
        Self::new_from_app_handle(app_handle).await
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn with_transaction<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Transaction<'_, Sqlite>) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut tx = self.pool.begin().await?;
        let result = f(&mut tx).await;

        match result {
            Ok(val) => {
                tx.commit().await?;
                Ok(val)
            }
            Err(err) => {
                tx.rollback().await?;
                Err(err)
            }
        }
    }

    /// Cleanup database connection and checkpoint WAL
    /// This should be called on application shutdown to ensure:
    /// - All WAL changes are written to the main database file
    /// - The .wal and .shm files are deleted
    /// - Connection pool is gracefully closed
    pub async fn cleanup(&self) -> Result<()> {
        log::info!("Starting database cleanup...");

        // Force checkpoint of WAL to main database file and remove WAL file
        // TRUNCATE mode: checkpoints all pages AND deletes the WAL file
        match sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
        {
            Ok(_) => log::info!("WAL checkpoint completed successfully"),
            Err(e) => log::warn!("WAL checkpoint failed (non-fatal): {}", e),
        }

        // Close the connection pool gracefully
        self.pool.close().await;
        log::info!("Database connection pool closed");

        Ok(())
    }
}

/// Make a database that predates sqlx applicable to the migration chain.
///
/// #68: a legacy Conversationaly `.db` already has `meetings.folder_path` — the archived Python
/// backend created it and then re-added it inside a `try/except OperationalError: pass`. The chain's
/// `20250916100000_initial_schema` is entirely `CREATE TABLE IF NOT EXISTS`, so it **silently
/// accepts** the foreign shape, and `20251006000000_add_audio_sync_fields` then collides two files
/// later with `duplicate column name: folder_path` — naming a migration that is not at fault.
///
/// **Why here and not in the migration.** Editing `20251006000000` changes its checksum, and sqlx
/// refuses any database whose `_sqlx_migrations` records the old one — so a one-line fix there
/// would break every installation that is working today. The reconciliation belongs to the entry
/// path, which is the only place that meets a foreign schema.
///
/// **What it does, and its bound.** It adds the columns of that one migration where they are
/// missing, then records the migration as applied with the migrator's own checksum — which is
/// exactly what running it would have achieved, without the collision. It touches nothing else, and
/// it does nothing at all on a database that already carries `_sqlx_migrations`: an ordinary upgrade
/// never reaches this code.
async fn reconcile_foreign_schema(pool: &SqlitePool) -> Result<()> {
    use sqlx::Row;

    // Only a database that has never been migrated can be foreign.
    let bookkeeping: i64 =
        sqlx::query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'")
            .fetch_one(pool)
            .await?
            .get(0);
    if bookkeeping > 0 {
        return Ok(());
    }

    let has_meetings: i64 =
        sqlx::query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meetings'")
            .fetch_one(pool)
            .await?
            .get(0);
    if has_meetings == 0 {
        return Ok(()); // a fresh database; the chain builds everything
    }

    // Static SQL throughout: sqlx 0.9 refuses dynamically built query strings outright, and every
    // table and column below is a constant here anyway.
    async fn columns_of(pool: &SqlitePool, pragma: &'static str) -> Result<Vec<String>> {
        let rows = sqlx::query(pragma).fetch_all(pool).await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
    }

    let meetings = columns_of(pool, "PRAGMA table_info(meetings)").await?;
    if !meetings.iter().any(|c| c == "folder_path") {
        return Ok(()); // the older Meetily shape: the chain applies to it as written
    }

    log::info!("Foreign legacy schema detected (meetings.folder_path predates the chain); reconciling");

    // The four columns 20251006000000 adds, added only where absent.
    let transcripts = columns_of(pool, "PRAGMA table_info(transcripts)").await?;
    for (column, statement) in [
        ("audio_start_time", "ALTER TABLE transcripts ADD COLUMN audio_start_time REAL"),
        ("audio_end_time", "ALTER TABLE transcripts ADD COLUMN audio_end_time REAL"),
        ("duration", "ALTER TABLE transcripts ADD COLUMN duration REAL"),
    ] {
        if !transcripts.iter().any(|c| c == column) {
            sqlx::query(statement).execute(pool).await?;
        }
    }

    // Record it as applied, with the migrator's own checksum so a later run does not report a
    // mismatch. `_sqlx_migrations` does not exist yet, so create it the way sqlx does.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator.iter() {
        if migration.version != AUDIO_SYNC_FIELDS {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (?, ?, TRUE, ?, 0)",
        )
        .bind(migration.version)
        .bind(migration.description.to_string())
        .bind(migration.checksum.to_vec())
        .execute(pool)
        .await?;
        log::info!("Recorded {} as already satisfied by the legacy schema", migration.version);
    }

    Ok(())
}

/// The one migration a legacy `.db` collides with, named rather than repeated as a literal.
const AUDIO_SYNC_FIELDS: i64 = 20251006000000;
