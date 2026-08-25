-- Optional Worker service binding for same-account MCP Workers
-- Cloudflare Workers cannot public-fetch other *.workers.dev Workers (error 1042).
-- Store a binding name reference only — never credentials.

ALTER TABLE mcp_environments ADD COLUMN service_binding_ref TEXT;
