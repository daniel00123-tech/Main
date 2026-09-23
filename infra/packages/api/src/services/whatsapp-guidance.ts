export const COMPANY_GUIDANCE_CLASS = "company_guidance";

export function isGuidanceHit(hit: { title?: string; snippet?: string; metadata?: Record<string, unknown> }): boolean {
  const meta = hit.metadata ?? {};
  const classValue = String(meta.document_class ?? meta.documentClass ?? meta.class ?? "").toLowerCase();
  if (classValue === COMPANY_GUIDANCE_CLASS || classValue === "guidance") return true;
  const hay = `${hit.title ?? ""} ${hit.snippet ?? ""} ${String(meta.path ?? meta.folder ?? meta.sourcePath ?? "")}`.toLowerCase();
  return /\binfra guidance\b|\bcompany guidance\b|\bquoting rules\b|\bpricing polic/.test(hay);
}

export function guidanceSearchQuery(topic: string): string {
  const clean = topic.replace(/\b(policy|guidance|procedure)\b/gi, " ").replace(/\s+/g, " ").trim();
  return `${clean} Infra Guidance policy`.replace(/\s+/g, " ").trim();
}

export function guidanceInfluenceNote(hitTitle: string | null): string | null {
  if (!hitTitle) return null;
  return `I used your company guidance (${hitTitle}) to shape this answer.`;
}
