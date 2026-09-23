-- Google Drive connector: documents-only sync state and allow-list config

CREATE TABLE IF NOT EXISTS connector_config (
  connector_code TEXT PRIMARY KEY REFERENCES connector_registry (code),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS google_drive_files (
  drive_file_id TEXT PRIMARY KEY,
  knowledge_document_id INTEGER REFERENCES knowledge_documents (id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  modified_time TEXT,
  md5_checksum TEXT,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('discovered', 'skipped', 'imported', 'failed')),
  skip_reason TEXT,
  last_synced_at TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_google_drive_files_status ON google_drive_files (sync_status);
CREATE INDEX IF NOT EXISTS idx_google_drive_files_document ON google_drive_files (knowledge_document_id);

UPDATE connector_registry
SET
  notes = 'Documents-only sync. Personal photos/images/videos/audio excluded via MIME allow-list before download. Google Photos not connected. Image ingestion is manual-upload only.',
  updated_at = datetime('now')
WHERE code = 'google_drive';

INSERT OR IGNORE INTO connector_config (connector_code, config_json)
VALUES (
  'google_drive',
  json_object(
    'syncMode', 'documents_only',
    'googlePhotosConnected', 0,
    'allowList', json_object(
      'allowedMimeTypes', json_array(
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
        'text/markdown'
      ),
      'allowedGoogleAppsTypes', json_array(
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.presentation'
      ),
      'additionalAllowedMimeTypes', json_array(),
      'excludedMimeTypePrefixes', json_array('image/', 'video/', 'audio/'),
      'excludedMimeTypes', json_array(
        'application/vnd.google-apps.photo',
        'application/vnd.google-apps.folder',
        'application/vnd.google-apps.shortcut'
      )
    )
  )
);
