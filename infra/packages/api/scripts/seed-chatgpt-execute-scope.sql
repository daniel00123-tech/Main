UPDATE service_identities
SET scopes_json = json_insert(
  scopes_json,
  '$[#]',
  'xero.action.execute'
),
updated_at = datetime('now')
WHERE token_prefix = 'infra_1HS3Nn'
  AND company_id = 'co_caddington'
  AND status = 'active'
  AND scopes_json NOT LIKE '%xero.action.execute%';
