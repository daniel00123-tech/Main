-- Point stored company email config at the canonical Infra sender.
-- Product sends always use Infra <noreply@infrastack.app>; this keeps UI/health rows aligned.

UPDATE company_email_config
SET provider = 'cloudflare',
    sender_address = 'noreply@infrastack.app',
    sender_display_name = 'Infra',
    updated_at = datetime('now')
WHERE company_id = 'co_caddington';
