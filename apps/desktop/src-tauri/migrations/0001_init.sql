-- =============================================================================
-- PDFReader (nom de code) : base LOCALE (SQLite), dans %APPDATA%\PDFReader\
-- Phase 1. Application de bureau uniquement : c'est la seule base de l'application.
--
-- L'application n'a ni compte ni serveur : tout ce qu'elle mémorise vit ici, sur
-- l'appareil (récents, état de vue par document, préférences, signature).
-- Heures : entier, millisecondes Unix UTC.
-- Les clés uuid sont générées par l'app (crate uuid, v4).
-- =============================================================================

pragma journal_mode = wal;
pragma foreign_keys = on;

-- Fichiers récents et favoris (S01).
-- fingerprint = /ID du PDF (1er élément) + taille ; à défaut SHA-256 des 64 premiers
-- et 64 derniers Ko + taille. Permet de retrouver un fichier déplacé ou renommé.
create table recent_files (
  id              text primary key,
  fingerprint     text not null unique,
  path            text not null,       -- chemin absolu
  name            text not null,
  size_bytes      integer not null check (size_bytes >= 0),
  page_count      integer check (page_count is null or page_count >= 0),
  starred         integer not null default 0 check (starred in (0, 1)),
  thumbnail       blob,                -- PNG ~ 160 px de large
  last_opened_at  integer not null,
  created_at      integer not null,
  updated_at      integer not null
);
create index recent_files_last_opened_idx on recent_files (last_opened_at desc);
create index recent_files_starred_idx on recent_files (starred, last_opened_at desc);

-- État de vue restauré à la réouverture (« restaurer la dernière vue »).
create table view_states (
  fingerprint   text primary key references recent_files(fingerprint) on delete cascade,
  last_page     integer not null default 1 check (last_page >= 1),
  zoom_mode     text not null default 'fit-width'
                check (zoom_mode in ('fit-page', 'fit-width', 'fit-height', 'actual', 'custom')),
  zoom_value    real check (zoom_value is null or (zoom_value >= 0.08 and zoom_value <= 64)),
  layout        text not null default 'continuous'
                check (layout in ('single', 'double', 'continuous', 'continuous-double')),
  cover_page    integer not null default 0 check (cover_page in (0, 1)),
  rotation      integer not null default 0 check (rotation in (0, 90, 180, 270)),
  right_panel   text check (right_panel is null or right_panel in
                  ('thumbnails', 'bookmarks', 'comments', 'attachments', 'layers')),
  updated_at    integer not null
);

-- Préférences (S14), clé / valeur JSON. Exportables et importables dans un fichier JSON.
create table preferences (
  key         text primary key,
  value       text not null,          -- JSON
  updated_at  integer not null
);

-- Signature et initiales (S12). Ne quittent jamais l'appareil.
create table saved_signatures (
  kind        text primary key check (kind in ('signature', 'initials')),
  method      text not null check (method in ('typed', 'drawn', 'image')),
  mime        text not null check (mime in ('image/svg+xml', 'image/png')),
  data        text not null,
  font        text,
  updated_at  integer not null
);

-- Copies de récupération des modifications non enregistrées (plantage, coupure).
create table recovery_snapshots (
  id            text primary key,
  fingerprint   text not null,
  original_path text,
  snapshot_path text not null,        -- fichier dans le dossier de données de l'app
  created_at    integer not null
);
create index recovery_snapshots_fingerprint_idx on recovery_snapshots (fingerprint, created_at desc);
