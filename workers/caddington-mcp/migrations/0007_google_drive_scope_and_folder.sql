-- Google Drive: full drive OAuth scope prep + Caddington Knowledge folder restriction

UPDATE connector_registry
SET
  notes = 'Documents-only sync restricted to Caddington Knowledge folder. OAuth uses drive scope (read/write token for future folder updates; sync remains read-only). Personal photos/images/videos/audio excluded. Google Photos not connected.',
  updated_at = datetime('now')
WHERE code = 'google_drive';

UPDATE connector_config
SET
  config_json = json_set(
    json_set(
      json_set(config_json, '$.knowledgeFolderName', 'Caddington Knowledge'),
      '$.knowledgeFolderId', NULL
    ),
    '$.writeOperationsEnabled', json('false')
  ),
  updated_at = datetime('now')
WHERE connector_code = 'google_drive';
