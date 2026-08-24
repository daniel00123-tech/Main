/**
 * Connector brand logos — prefer vendored assets in /connectors/.
 * Fall back to geometric marks when no asset is available.
 */

type LogoAsset = {
  src: string;
  /** Tile background behind the image */
  tile?: string;
  /** How the image should fit inside the tile */
  fit?: "contain" | "cover";
  /** Extra class for wide wordmarks etc. */
  imageClass?: string;
};

const LOGO_ASSETS: Record<string, LogoAsset> = {
  "google-drive": {
    src: "/connectors/google-drive.svg",
    tile: "#ffffff",
    fit: "contain",
  },
  sharepoint: {
    src: "/connectors/microsoft.svg",
    tile: "#ffffff",
    fit: "contain",
  },
  onedrive: {
    src: "/connectors/microsoft.svg",
    tile: "#ffffff",
    fit: "contain",
  },
  "outlook-shared-mailbox": {
    src: "/connectors/microsoft.svg",
    tile: "#ffffff",
    fit: "contain",
  },
  bigchange: {
    src: "/connectors/bigchange-icon.svg",
    tile: "#0B2C4A",
    fit: "contain",
  },
  commusoft: {
    src: "/connectors/commusoft.png",
    tile: "#ffffff",
    fit: "contain",
    imageClass: "connector-logo-img-wide",
  },
  xero: {
    src: "/connectors/xero.png",
    tile: "#ffffff",
    fit: "contain",
  },
  chatgpt: {
    src: "/connectors/chatgpt.png",
    tile: "#10A37F",
    fit: "contain",
  },
  claude: {
    src: "/connectors/claude.png",
    tile: "#1F1A14",
    fit: "contain",
  },
  whatsapp: {
    src: "/connectors/whatsapp.svg",
    tile: "#ffffff",
    fit: "contain",
  },
};

function Tile({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div className="connector-logo" style={{ background: bg }} aria-hidden="true">
      {children}
    </div>
  );
}

function FreshdeskMark() {
  return (
    <Tile bg="#25C16F">
      <svg viewBox="0 0 40 40" className="connector-logo-svg" role="img">
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
      </svg>
    </Tile>
  );
}

function ApiMark() {
  return (
    <Tile bg="#1A2236">
      <svg viewBox="0 0 40 40" className="connector-logo-svg" role="img">
        <path
          d="M13 27 20 11l7 16M15.5 22h9"
          fill="none"
          stroke="#8AB4FF"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Tile>
  );
}

function AssetLogo({ name, asset }: { name: string; asset: LogoAsset }) {
  return (
    <Tile bg={asset.tile ?? "#ffffff"}>
      <img
        src={asset.src}
        alt=""
        className={`connector-logo-img ${asset.imageClass ?? ""}`}
        style={{ objectFit: asset.fit ?? "contain" }}
        loading="lazy"
        decoding="async"
        title={name}
      />
    </Tile>
  );
}

export function ConnectorLogo({ slug, name }: { slug: string; name: string }) {
  const asset = LOGO_ASSETS[slug];

  if (asset) {
    return (
      <div className="connector-logo-wrap" title={name}>
        <AssetLogo name={name} asset={asset} />
      </div>
    );
  }

  if (slug === "freshdesk") {
    return (
      <div className="connector-logo-wrap" title={name}>
        <FreshdeskMark />
      </div>
    );
  }

  return (
    <div className="connector-logo-wrap" title={name}>
      <ApiMark />
    </div>
  );
}
