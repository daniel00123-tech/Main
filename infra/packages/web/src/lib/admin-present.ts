import { humanOperation } from "./format";

export function adminDashboardOperationSummary(
  action?: string | null,
  toolName?: string | null,
): string {
  const blob = `${action ?? ""} ${toolName ?? ""}`.toLowerCase();
  if (blob.includes("xero")) {
    if (blob.includes("invoice")) return "Xero invoices";
    if (blob.includes("contact")) return "Xero contacts";
    if (blob.includes("report") || blob.includes("pnl") || blob.includes("aged")) return "Xero reporting";
    if (blob.includes("supplier") || blob.includes("vat")) return "Xero accounting";
    return "Xero accounting";
  }
  if (blob.includes("microsoft") || blob.includes("m365") || blob.includes("outlook")) {
    return "Microsoft 365";
  }
  if (blob.includes("google") || blob.includes("drive")) return "Google Drive";
  if (blob.includes("health")) return "Connection check";
  if (blob.includes("knowledge") || blob.includes("search")) return "Knowledge search";
  if (blob.includes("action_plan") || blob.includes("execute")) return "Approved action";
  const label = humanOperation(action, toolName);
  const words = label.split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function permissionDenialOperatorSummary(count: number): {
  headline: string;
  detail: string;
  reviewRecommended: boolean;
} {
  if (count <= 0) {
    return {
      headline: "No blocked permission requests",
      detail: "Policy enforcement is quiet.",
      reviewRecommended: false,
    };
  }
  if (count >= 25) {
    return {
      headline: `${count} blocked requests in 24h — review recommended`,
      detail: "Higher than usual. Inspect Usage for unexpected actors or companies.",
      reviewRecommended: true,
    };
  }
  return {
    headline: `${count} policy-enforced block${count === 1 ? "" : "s"} (24h)`,
    detail: "Usually expected security checks or negative tests. See Usage for detail.",
    reviewRecommended: false,
  };
}

export function onboardingStatusPresentation(status: string): {
  label: string;
  badgeStatus: string;
} {
  switch (status) {
    case "complete":
      return { label: "Complete", badgeStatus: "healthy" };
    case "pending":
      return { label: "In progress", badgeStatus: "warning" };
    case "test_mode":
      return { label: "Test mode", badgeStatus: "warning" };
    case "not_provisioned":
    case "not_configured":
      return { label: "Not configured", badgeStatus: "warning" };
    case "no":
      return { label: "Needs attention", badgeStatus: "error" };
    default:
      return { label: "Needs attention", badgeStatus: "warning" };
  }
}

export function applicabilityLabel(applicability?: string): string {
  if (applicability === "optional") return "Optional";
  if (applicability === "not_applicable") return "Not required";
  return "Required";
}

export function attentionReviewHeading(count: number, criticalCount: number): string {
  const noun = count === 1 ? "item needs" : "items need";
  const critical =
    criticalCount > 0 ? ` · ${criticalCount} critical` : "";
  return `${count} ${noun} review${critical}`;
}
