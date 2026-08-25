-- Additive: persist encrypted PKCE verifiers for OAuth token exchange.
-- No plaintext tokens. No destructive changes.

ALTER TABLE oauth_authorization_states ADD COLUMN code_verifier_nonce_b64 TEXT;
ALTER TABLE oauth_authorization_states ADD COLUMN code_verifier_ciphertext_b64 TEXT;
ALTER TABLE oauth_authorization_states ADD COLUMN return_path TEXT;
