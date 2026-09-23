-- Google Drive: daily scheduled sync metadata (Europe/London noon)

UPDATE connector_config
SET
  config_json = json_set(
    config_json,
    '$.scheduledSync',
    json_object(
      'enabled', 1,
      'timezone', 'Europe/London',
      'localHour', 12,
      'localMinute', 0,
      'lastScheduledScanDate', NULL
    )
  ),
  updated_at = datetime('now')
WHERE connector_code = 'google_drive';

UPDATE connector_registry
SET
  notes = 'Documents-only sync restricted to Caddington Knowledge folder. Daily metadata scan at 12:00 Europe/London (hourly UTC cron + London gate). Queue fan-out for per-file import/index. Personal photos/images/videos/audio excluded. Google Photos not connected.',
  updated_at = datetime('now')
WHERE code = 'google_drive';
