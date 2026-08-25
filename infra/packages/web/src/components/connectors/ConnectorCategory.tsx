import type { ConnectorCategory } from "@infra/shared";
import { CATEGORY_LABELS } from "./catalogue-utils";

const CATEGORY_CLASS: Record<ConnectorCategory, string> = {
  cloud_storage: "connector-category-storage",
  email: "connector-category-email",
  field_service: "connector-category-field",
  accounting: "connector-category-accounting",
  helpdesk: "connector-category-helpdesk",
  ai_assistant: "connector-category-ai",
  messaging: "connector-category-messaging",
  api: "connector-category-api",
};

export function ConnectorCategoryBadge({
  category,
}: {
  category: ConnectorCategory;
}) {
  return (
    <span className={`connector-category ${CATEGORY_CLASS[category]}`}>
      {CATEGORY_LABELS[category]}
    </span>
  );
}
