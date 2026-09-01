import type { CSSProperties } from "react";
import infraIcon from "../assets/brand/infra-icon.svg";

type InfraBrandProps = {
  compact?: boolean;
  showStack?: boolean;
  context?: string;
  size?: number;
  className?: string;
};

export function InfraIcon({
  size = 32,
  className = "",
  alt = "",
}: {
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={infraIcon}
      alt={alt}
      width={size}
      height={size}
      className={`infra-icon ${className}`.trim()}
      decoding="async"
    />
  );
}

export function InfraBrand({
  compact = false,
  showStack = false,
  context,
  size = 32,
  className = "",
}: InfraBrandProps) {
  return (
    <div
      className={["infra-brand", compact ? "infra-brand--compact" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ "--infra-brand-size": `${size}px` } as CSSProperties}
    >
      <InfraIcon size={size} className="infra-brand-icon" />
      {compact ? (
        <span className="sr-only">Infra</span>
      ) : (
        <div className="infra-brand-text">
          <span className="infra-brand-name">
            Infra
            {showStack ? <span className="infra-brand-stack">stack</span> : null}
          </span>
          {context ? <span className="infra-brand-context">{context}</span> : null}
        </div>
      )}
    </div>
  );
}
