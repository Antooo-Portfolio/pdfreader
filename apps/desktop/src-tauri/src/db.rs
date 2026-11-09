//! Base locale SQLite (%APPDATA%\app.pdfreader.desktop\pdfreader.db) : fichiers récents (S01).
//! Schéma : migrations/0001_init.sql (copie de replica/schema-local.sql).

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub struct Db(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub id: String,
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size_bytes: i64,
    pub page_count: Option<i64>,
    pub starred: bool,
    pub last_opened_at: i64,
    pub exists: bool,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Db {
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).ok();
        let conn = Connection::open(dir.join("pdfreader.db"))?;
        let version: i64 = conn.query_row("pragma user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(include_str!("../migrations/0001_init.sql"))?;
            conn.execute_batch("pragma user_version = 1")?;
        }
        conn.execute_batch("pragma foreign_keys = on")?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Ajoute ou met à jour un fichier récent (retrouvé par son empreinte s'il a été déplacé).
    pub fn touch(&self, fingerprint: &str, path: &str, name: &str, size: u64, pages: i32, thumb: &[u8]) -> rusqlite::Result<()> {
        let c = self.0.lock().unwrap();
        let now = now_ms();
        // Un autre fichier enregistré au même chemin (ancienne version) est remplacé.
        c.execute("delete from recent_files where path = ?1 and fingerprint <> ?2", params![path, fingerprint])?;
        c.execute(
            "insert into recent_files (id, fingerprint, path, name, size_bytes, page_count, thumbnail, last_opened_at, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
             on conflict(fingerprint) do update set path = excluded.path, name = excluded.name,
               size_bytes = excluded.size_bytes, page_count = excluded.page_count,
               thumbnail = excluded.thumbnail, last_opened_at = excluded.last_opened_at, updated_at = excluded.updated_at",
            params![uuid::Uuid::new_v4().to_string(), fingerprint, path, name, size as i64, pages, thumb, now],
        )?;
        Ok(())
    }

    pub fn list(&self, limit: i64) -> rusqlite::Result<Vec<RecentFile>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "select id, path, name, size_bytes, page_count, starred, last_opened_at from recent_files
             order by last_opened_at desc limit ?1",
        )?;
        let rows = st.query_map([limit], |r| {
            let path: String = r.get(1)?;
            let p = Path::new(&path);
            Ok(RecentFile {
                id: r.get(0)?,
                folder: p.parent().map(|d| d.display().to_string()).unwrap_or_default(),
                exists: p.exists(),
                path,
                name: r.get(2)?,
                size_bytes: r.get(3)?,
                page_count: r.get(4)?,
                starred: r.get::<_, i64>(5)? == 1,
                last_opened_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute("delete from recent_files where id = ?1", [id])?;
        Ok(())
    }

    pub fn thumbnail(&self, id: &str) -> Option<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .query_row("select thumbnail from recent_files where id = ?1", [id], |r| r.get::<_, Option<Vec<u8>>>(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }
}
