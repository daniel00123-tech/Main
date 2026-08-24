/** Self-contained brand marks — geometric icons + reliable monograms (no external hotlinks). */

function Tile({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div className="connector-logo" style={{ background: bg }} aria-hidden="true">
      <svg viewBox="0 0 40 40" className="connector-logo-svg" role="img">
        {children}
      </svg>
    </div>
  );
}

function GoogleDriveLogo() {
  return (
    <Tile bg="#fff">
      {/* Recognisable Drive mark: blue / yellow / green */}
      <path d="M14.2 24.5 20 8l5.8 16.5H14.2Z" fill="#4285F4" />
      <path d="M25.8 24.5 32 24.5 23.3 32.5 20 24.5h5.8Z" fill="#F4B400" />
      <path d="M14.2 24.5 20 24.5 16.7 32.5 8 24.5h6.2Z" fill="#0F9D58" />
      <path d="M16.7 32.5h6.6L20 24.5 16.7 32.5Z" fill="#0F9D58" opacity="0.85" />
    </Tile>
  );
}

function SharePointLogo() {
  return (
    <Tile bg="#fff">
      <circle cx="24" cy="14" r="7" fill="#038387" />
      <circle cx="16" cy="22" r="9" fill="#1A9BA1" />
      <circle cx="25" cy="27" r="6" fill="#37C6D0" />
      <text
        x="14"
        y="26"
        fill="#fff"
        fontSize="11"
        fontFamily="system-ui,sans-serif"
        fontWeight="700"
      >
        S
      </text>
    </Tile>
  );
}

function OneDriveLogo() {
  return (
    <Tile bg="#fff">
      <path
        d="M14 24c-3.2 0-5.8-2.4-5.8-5.4 0-2.8 2-5.1 4.7-5.5C14 10.2 16.7 8 20 8c3.6 0 6.6 2.6 7.1 6.1 2.6.4 4.6 2.6 4.6 5.3 0 3-2.4 5.4-5.4 5.4H14Z"
        fill="#0078D4"
      />
    </Tile>
  );
}

function OutlookLogo() {
  return (
    <Tile bg="#fff">
      <rect x="8" y="10" width="18" height="20" rx="2" fill="#0A66C2" />
      <path d="M26 14h6v16c0 1.1-.9 2-2 2h-4V14Z" fill="#1490DF" />
      <path d="M11 16h12v2H11Zm0 4h9v2h-9Zm0 4h10v2H11Z" fill="#fff" />
      <circle cx="28" cy="24" r="7" fill="#0078D4" />
      <text
        x="24.5"
        y="27.5"
        fill="#fff"
        fontSize="10"
        fontFamily="system-ui,sans-serif"
        fontWeight="700"
      >
        O
      </text>
    </Tile>
  );
}

function BigChangeLogo() {
  return (
    <Tile bg="linear-gradient(145deg,#0B2C4A,#1B4F72)">
      {/* Field-service mark: van / BC */}
      <rect x="7" y="18" width="18" height="10" rx="1.5" fill="#4FC3F7" />
      <path d="M25 20h5l3 4v4h-8V20Z" fill="#81D4FA" />
      <circle cx="13" cy="28" r="2.2" fill="#0B2C4A" />
      <circle cx="28" cy="28" r="2.2" fill="#0B2C4A" />
      <text
        x="10"
        y="16"
        fill="#E3F7FF"
        fontSize="8"
        fontFamily="system-ui,sans-serif"
        fontWeight="800"
        letterSpacing="0.5"
      >
        BC
      </text>
    </Tile>
  );
}

function CommusoftLogo() {
  return (
    <Tile bg="#0B3D91">
      <circle cx="20" cy="20" r="12" fill="none" stroke="#7EB6FF" strokeWidth="2" />
      <text
        x="12"
        y="24.5"
        fill="#fff"
        fontSize="12"
        fontFamily="system-ui,sans-serif"
        fontWeight="800"
      >
        CS
      </text>
    </Tile>
  );
}

function XeroLogo() {
  return (
    <Tile bg="#13B5EA">
      <path
        d="M12 12 20 20 12 28h4.5L22.2 22 28 28H32.5L24.5 20 32.5 12H28L22.2 18 16.5 12H12Z"
        fill="#fff"
      />
    </Tile>
  );
}

function FreshdeskLogo() {
  return (
    <Tile bg="#25C16F">
      {/* Simple headset / support mark */}
      <path
        d="M12 22v-2c0-4.4 3.6-8 8-8s8 3.6 8 8v2"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <rect x="10" y="21" width="5" height="8" rx="2" fill="#fff" />
      <rect x="25" y="21" width="5" height="8" rx="2" fill="#fff" />
      <path d="M20 28h4v2h-5a1 1 0 0 1-1-1v-1" fill="#fff" />
    </Tile>
  );
}

function ApiLogo() {
  return (
    <Tile bg="#1A2236">
      <path
        d="M13 27 20 11l7 16M15.5 22h9"
        fill="none"
        stroke="#8AB4FF"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Tile>
  );
}

function OpenAiLogo() {
  return (
    <Tile bg="#10A37F">
      {/* Hexagonal / node mark */}
      <path
        d="M20 8l8 4.5v9L20 26l-8-4.5v-9L20 8Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
      />
      <circle cx="20" cy="17" r="3.2" fill="#fff" />
    </Tile>
  );
}

function ClaudeLogo() {
  return (
    <Tile bg="#D97757">
      <path
        d="M14 26 20 10l6 16M16.5 20h7"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Tile>
  );
}

function WhatsAppLogo() {
  return (
    <Tile bg="#25D366">
      <path
        d="M20 9c-6 0-11 4.8-11 10.7 0 1.9.5 3.6 1.4 5.2L9 31l5.4-1.7c1.5.8 3.2 1.2 5 1.2 6 0 11-4.8 11-10.7S26 9 20 9Z"
        fill="#fff"
      />
      <path
        d="M16.2 15.6c-.3-.7-.6-.7-.9-.7h-.7c-.3 0-.7.1-1 .5s-1.1 1.1-1.1 2.6 1.1 3 1.2 3.2c.1.2 2.1 3.3 5.1 4.5 2.5 1 3 .8 3.5.8.5 0 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4 0-.1-.3-.2-.6-.3l-2.2-.9c-.3-.1-.5 0-.7.3l-.9 1.1c-.1.2-.3.2-.6.1-1.1-.4-2.3-1.3-3.1-2.4-.1-.2-.1-.4.1-.5l1-.9c.2-.1.2-.3.2-.5l-.8-2.4c-.1-.3-.3-.4-.5-.4Z"
        fill="#25D366"
      />
    </Tile>
  );
}

const LOGOS: Record<string, () => React.ReactElement> = {
  "google-drive": GoogleDriveLogo,
  sharepoint: SharePointLogo,
  onedrive: OneDriveLogo,
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
