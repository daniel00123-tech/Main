/** Brand-styled SVG logos for the connector marketplace (simplified, self-contained). */

const LOGO_CLASS = "connector-logo-svg";

function LogoFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="connector-logo" aria-hidden="true">
      <svg viewBox="0 0 48 48" className={LOGO_CLASS} role="img">
        {children}
      </svg>
    </div>
  );
}

function GoogleDriveLogo() {
  return (
    <LogoFrame>
      <path fill="#4285F4" d="M24 8 38 32H10L24 8Z" />
      <path fill="#0F9D58" d="M10 32 17 44H31L38 32H10Z" />
      <path fill="#FFBA00" d="M24 8 31 20H17L10 32 24 8Z" opacity="0" />
      <path fill="#DB4437" d="M24 8 38 32H31L24 20 17 32H10L24 8Z" opacity="0.85" />
    </LogoFrame>
  );
}

function MicrosoftLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="14" height="14" fill="#F25022" rx="1" />
      <rect x="26" y="8" width="14" height="14" fill="#7FBA00" rx="1" />
      <rect x="8" y="26" width="14" height="14" fill="#00A4EF" rx="1" />
      <rect x="26" y="26" width="14" height="14" fill="#FFB900" rx="1" />
    </LogoFrame>
  );
}

function OutlookLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="12" width="22" height="24" rx="3" fill="#0078D4" />
      <ellipse cx="30" cy="24" rx="10" ry="12" fill="#1490DF" />
      <rect x="12" y="18" width="14" height="2" fill="#fff" opacity="0.9" />
      <rect x="12" y="23" width="10" height="2" fill="#fff" opacity="0.7" />
      <rect x="12" y="28" width="12" height="2" fill="#fff" opacity="0.7" />
    </LogoFrame>
  );
}

function BigChangeLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#1B3A57" />
      <path
        d="M16 30V18h6c3.3 0 5 1.7 5 4.2 0 2.2-1.4 3.8-3.6 4.1L28 30h-4l-3.2-3.4H20V30h-4Zm4-7.2h2c1.2 0 1.8-.6 1.8-1.5s-.6-1.5-1.8-1.5h-2v3Z"
        fill="#4FC3F7"
      />
    </LogoFrame>
  );
}

function CommusoftLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#0D47A1" />
      <path
        d="M16 32V16h8c5.5 0 9 3.2 9 8s-3.5 8-9 8h-8Zm4-4h4c3 0 4.8-1.6 4.8-4s-1.8-4-4.8-4h-4v8Z"
        fill="#fff"
      />
    </LogoFrame>
  );
}

function XeroLogo() {
  return (
    <LogoFrame>
      <circle cx="24" cy="24" r="16" fill="#13B5EA" />
      <path
        d="M18 28V20h3.2l2.4 5.2L26 20h3.2v8h-2.6v-4.8L24.4 28h-1.8l-2.2-4.8V28H18Z"
        fill="#fff"
      />
    </LogoFrame>
  );
}

function FreshdeskLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#25C16F" />
      <path
        d="M18 30c0-4.4 2.7-7 6-7h4v-2.2c0-1.8-1.2-2.8-3-2.8-1.4 0-2.4.5-3.2 1.6l-2.6-2.2c1.2-1.6 3.2-2.6 5.8-2.6 3.8 0 6.2 2.2 6.2 6v8.2H26v-2h-.4c-.8 1.4-2.2 2.2-4.2 2.2-2.6 0-4.4-1.6-4.4-4Z"
        fill="#fff"
      />
    </LogoFrame>
  );
}

function ApiLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#2A3348" stroke="#8AB4FF" strokeWidth="1.5" />
      <path
        d="M17 30 24 14l7 16M20 24h8"
        stroke="#8AB4FF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </LogoFrame>
  );
}

function OpenAiLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#0D0D0D" stroke="#10A37F" strokeWidth="1.5" />
      <path
        d="M24 14c-4.2 0-7.2 2.6-7.2 6.2 0 2.4 1.2 4 3.2 5l-1.2 3.6 3.8-1.8c.8.2 1.6.3 2.4.3 4.2 0 7.2-2.6 7.2-6.2S28.2 14 24 14Z"
        fill="#10A37F"
      />
    </LogoFrame>
  );
}

function ClaudeLogo() {
  return (
    <LogoFrame>
      <rect x="8" y="8" width="32" height="32" rx="8" fill="#1F1A14" />
      <path
        d="M24 12c6.6 0 12 5.4 12 12s-5.4 12-12 12S12 30.6 12 24 17.4 12 24 12Zm-4.8 8.4 3.6 6.2 3.6-6.2h2.4L24 29.2 17.4 20.4h1.8Z"
        fill="#D97757"
      />
    </LogoFrame>
  );
}

function WhatsAppLogo() {
  return (
    <LogoFrame>
      <circle cx="24" cy="24" r="16" fill="#25D366" />
      <path
        d="M18.5 29.5 17 33l3.7-1.4c1.1.6 2.3.9 3.6.9 4.2 0 7.6-3.4 7.6-7.6S28.5 17.3 24.3 17.3 16.7 20.7 16.7 24.9c0 1.3.3 2.5.9 3.6Z"
        fill="#fff"
      />
      <path
        d="M21.8 22.8c-.2-.5-.8-.8-1.3-.8-.3 0-.7 0-1 .1-.4.1-.9.4-1.2 1-.5.8-.2 2 .8 3.1 1 1.1 2.8 2.2 4.5 2.5 1.1.2 2-.1 2.7-.7.4-.4.7-1 .8-1.6l.3-1.5c0-.2-.1-.3-.3-.3l-2-.5c-.2 0-.3.1-.4.3l-.5 1.1c0 .1-.2.2-.3.2-.8-.2-2-.9-2.7-1.7-.1-.1-.1-.3 0-.4l.8-.9c.1-.1.1-.3 0-.4l-1.5-1.3Z"
        fill="#25D366"
      />
    </LogoFrame>
  );
}

const LOGOS: Record<string, () => React.ReactElement> = {
  "google-drive": GoogleDriveLogo,
  sharepoint: MicrosoftLogo,
  onedrive: MicrosoftLogo,
  "outlook-shared-mailbox": OutlookLogo,
  bigchange: BigChangeLogo,
  commusoft: CommusoftLogo,
  xero: XeroLogo,
  freshdesk: FreshdeskLogo,
  "custom-api": ApiLogo,
  chatgpt: OpenAiLogo,
  claude: ClaudeLogo,
  whatsapp: WhatsAppLogo,
};

export function ConnectorLogo({ slug, name }: { slug: string; name: string }) {
  const Logo = LOGOS[slug] ?? ApiLogo;
  return (
    <div className="connector-logo-wrap" title={name}>
      <Logo />
    </div>
  );
}
