import type { LiveMcpPrincipal } from "./types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hiddenFields(params: URLSearchParams): string {
  return [...params.entries()]
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`,
    )
    .join("\n");
}

const SHELL = (body: string, title: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f4f1ea; color: #1c1917; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(440px, 100%); background: #fff; border-radius: 16px; padding: 28px; box-shadow: 0 12px 40px rgba(28,25,23,.08); }
    .brand { letter-spacing: .12em; font-size: 12px; font-weight: 700; color: #78716c; }
    h1 { font-size: 22px; margin: 12px 0 8px; }
    p { line-height: 1.5; color: #44403c; }
    label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
    input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d6d3d1; border-radius: 10px; font: inherit; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { flex: 1; border: 0; border-radius: 10px; padding: 11px 14px; font: inherit; font-weight: 600; cursor: pointer; }
    .primary { background: #1c1917; color: #fff; }
    .secondary { background: #e7e5e4; color: #1c1917; }
    .error { background: #fef2f2; color: #991b1b; padding: 10px 12px; border-radius: 10px; }
    .meta { font-size: 13px; background: #fafaf9; border-radius: 10px; padding: 12px; }
  </style>
</head>
<body><div class="wrap"><div class="card">${body}</div></div></body>
</html>`;

export function mcpOAuthLoginPage(params: URLSearchParams, error?: string | null): string {
  return SHELL(
    `
    <div class="brand">INFRA</div>
    <h1>Sign in to connect ChatGPT</h1>
    <p>Use your existing INFRA company account. Microsoft sign-in is not required.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post">
      ${hiddenFields(params)}
      <input type="hidden" name="intent" value="login" />
      <label>Email<input type="email" name="email" autocomplete="username" required /></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
      <div class="actions"><button class="primary" type="submit">Continue</button></div>
    </form>
    `,
    "INFRA sign in",
  );
}

export function mcpOAuthConsentPage(
  params: URLSearchParams,
  principal: LiveMcpPrincipal,
  clientLabel: string,
): string {
  return SHELL(
    `
    <div class="brand">INFRA</div>
    <h1>Allow ${escapeHtml(clientLabel)} to use ${escapeHtml(principal.companyName)}?</h1>
    <p>Signed in as <strong>${escapeHtml(principal.displayName)}</strong> (${escapeHtml(principal.email)}).</p>
    <div class="meta">
      Company: ${escapeHtml(principal.companyName)}<br/>
      Your current role is resolved from INFRA on every request. Changing it later does not require reconnecting.
    </div>
    <form method="post">
      ${hiddenFields(params)}
      <div class="actions">
        <button class="secondary" type="submit" name="intent" value="deny">Cancel</button>
        <button class="primary" type="submit" name="intent" value="allow">Allow</button>
      </div>
    </form>
    `,
    "Authorise INFRA MCP",
  );
}

export function mcpOAuthErrorPage(message: string): string {
  return SHELL(
    `<div class="brand">INFRA</div><h1>Unable to connect</h1><p>${escapeHtml(message)}</p>`,
    "INFRA MCP error",
  );
}
