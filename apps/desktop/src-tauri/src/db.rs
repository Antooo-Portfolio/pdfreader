//! Base locale SQLite (%APPDATA%\app.pdfreader.desktop\pdfreader.db) : fichiers récents (S01).
//! Schéma : migrations/0001_init.sql (copie de replica/schema-local.sql).

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub struct Db(pub Mutex<Connection>);

/// Signature ou initiales mémorisées (S12). Image PNG en data URL ; ne quitte jamais l'appareil.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub kind: String,
    pub method: String,
    pub data: String,
    pub font: Option<String>,
    pub updated_at: i64,
}

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

    pub fn set_starred(&self, id: &str, starred: bool) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute("update recent_files set starred = ?2, updated_at = ?3 where id = ?1", params![id, starred as i64, now_ms()])?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute("delete from recent_files where id = ?1", [id])?;
        Ok(())
    }

    /// Après un enregistrement, le fichier a une nouvelle empreinte : on la reporte sur le récent
    /// et sur son état de vue, pour ne perdre ni l'un ni l'autre.
    pub fn rekey(&self, old: &str, new: &str, size: u64, thumb: Option<&[u8]>) -> rusqlite::Result<()> {
        if old == new {
            return Ok(());
        }
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute_batch("pragma defer_foreign_keys = on")?;
        tx.execute("delete from view_states where fingerprint = ?1", [new])?;
        tx.execute("delete from recent_files where fingerprint = ?1", [new])?;
        tx.execute(
            "update recent_files set fingerprint = ?2, size_bytes = ?3, thumbnail = coalesce(?4, thumbnail), updated_at = ?5 where fingerprint = ?1",
            params![old, new, size as i64, thumb, now_ms()],
        )?;
        tx.execute("update view_states set fingerprint = ?2 where fingerprint = ?1", [old, new])?;
        tx.commit()
    }

    /// Dernier état de vue d'un document (« restaurer la dernière vue »), au format attendu par
    /// l'interface.
    pub fn view_state(&self, fingerprint: &str) -> Option<serde_json::Value> {
        let c = self.0.lock().unwrap();
        c.query_row(
            "select last_page, zoom_mode, zoom_value, layout, cover_page, rotation, right_panel from view_states where fingerprint = ?1",
            [fingerprint],
            |r| {
                Ok(serde_json::json!({
                    "page": r.get::<_, i64>(0)?,
                    "zoomMode": r.get::<_, String>(1)?,
                    "zoom": r.get::<_, Option<f64>>(2)?,
                    "layout": r.get::<_, String>(3)?,
                    "cover": r.get::<_, i64>(4)? == 1,
                    "rotation": r.get::<_, i64>(5)?,
                    "panel": r.get::<_, Option<String>>(6)?,
                }))
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_view_state(
        &self,
        fingerprint: &str,
        page: i64,
        zoom_mode: &str,
        zoom: Option<f64>,
        layout: &str,
        cover: bool,
        rotation: i64,
        panel: Option<&str>,
    ) -> rusqlite::Result<()> {
        let c = self.0.lock().unwrap();
        // Sans fichier récent correspondant (clé étrangère), rien à mémoriser.
        c.execute(
            "insert into view_states (fingerprint, last_page, zoom_mode, zoom_value, layout, cover_page, rotation, right_panel, updated_at)
             select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 where exists (select 1 from recent_files where fingerprint = ?1)
             on conflict(fingerprint) do update set last_page = excluded.last_page, zoom_mode = excluded.zoom_mode,
               zoom_value = excluded.zoom_value, layout = excluded.layout, cover_page = excluded.cover_page,
               rotation = excluded.rotation, right_panel = excluded.right_panel, updated_at = excluded.updated_at",
            params![fingerprint, page.max(1), zoom_mode, zoom, layout, cover as i64, rotation, panel, now_ms()],
        )?;
        Ok(())
    }

    /// Préférences (clé → valeur JSON).
    pub fn preferences(&self) -> rusqlite::Result<serde_json::Map<String, serde_json::Value>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare("select key, value from preferences")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (k, v) = row?;
            if let Ok(v) = serde_json::from_str(&v) {
                out.insert(k, v);
            }
        }
        Ok(out)
    }

    pub fn set_preference(&self, key: &str, value: &serde_json::Value) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute(
            "insert into preferences (key, value, updated_at) values (?1, ?2, ?3)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
            params![key, value.to_string(), now_ms()],
        )?;
        Ok(())
    }

    pub fn signature(&self, kind: &str) -> rusqlite::Result<Option<Signature>> {
        self.0
            .lock()
            .unwrap()
            .query_row("select kind, method, data, font, updated_at from saved_signatures where kind = ?1", [kind], |r| {
                Ok(Signature { kind: r.get(0)?, method: r.get(1)?, data: r.get(2)?, font: r.get(3)?, updated_at: r.get(4)? })
            })
            .optional()
    }

    pub fn set_signature(&self, kind: &str, method: &str, data: &str, font: Option<&str>) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute(
            "insert into saved_signatures (kind, method, mime, data, font, updated_at) values (?1, ?2, 'image/png', ?3, ?4, ?5)
             on conflict(kind) do update set method = excluded.method, mime = excluded.mime, data = excluded.data,
               font = excluded.font, updated_at = excluded.updated_at",
            params![kind, method, data, font, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_signature(&self, kind: &str) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute("delete from saved_signatures where kind = ?1", [kind])?;
        Ok(())
    }

    pub fn reset_preferences(&self) -> rusqlite::Result<()> {
        self.0.lock().unwrap().execute("delete from preferences", [])?;
        Ok(())
    }

    /// Enregistre une copie de récupération ; renvoie les fichiers des copies précédentes du même
    /// document, à supprimer.
    pub fn add_snapshot(&self, fingerprint: &str, original: &str, snapshot: &str) -> rusqlite::Result<Vec<String>> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let old = {
            let mut st = tx.prepare("select snapshot_path from recovery_snapshots where original_path = ?1")?;
            let rows = st.query_map([original], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute("delete from recovery_snapshots where original_path = ?1", [original])?;
        tx.execute(
            "insert into recovery_snapshots (id, fingerprint, original_path, snapshot_path, created_at) values (?1, ?2, ?3, ?4, ?5)",
            params![uuid::Uuid::new_v4().to_string(), fingerprint, original, snapshot, now_ms()],
        )?;
        tx.commit()?;
        Ok(old)
    }

    /// (id, chemin d'origine, fichier de la copie, date)
    pub fn snapshots(&self) -> rusqlite::Result<Vec<(String, String, String, i64)>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare("select id, coalesce(original_path, ''), snapshot_path, created_at from recovery_snapshots order by created_at desc")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect()
    }

    /// Oublie les copies d'un document (par identifiant ou par chemin d'origine) ; renvoie leurs
    /// fichiers, à supprimer.
    pub fn remove_snapshots(&self, id: Option<&str>, original: Option<&str>) -> rusqlite::Result<Vec<String>> {
        let c = self.0.lock().unwrap();
        let files = {
            let mut st = c.prepare("select snapshot_path from recovery_snapshots where id = ?1 or original_path = ?2")?;
            let rows = st.query_map(params![id, original], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        c.execute("delete from recovery_snapshots where id = ?1 or original_path = ?2", params![id, original])?;
        Ok(files)
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
