-- Allow Xero month-to-date sales report emails for companies that already
-- have transactional email configured. Does not grant Mail.Send or new senders.

UPDATE company_email_config
SET allowed_types_json = json_insert(allowed_types_json, '$[#]', 'XERO_SALES_REPORT'),
    updated_at = datetime('now')
WHERE instr(allowed_types_json, 'XERO_SALES_REPORT') = 0;
