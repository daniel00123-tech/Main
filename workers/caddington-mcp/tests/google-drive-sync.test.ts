import { describe, expect, it } from "vitest";
import { loadGoogleDriveConnectorConfig } from "../src/google-drive-sync";

describe("Google Drive connector config", () => {
  it("prefers GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID env over connector_config", async () => {
    const env = {
      CADDINGTON_BUSINESS_DATA: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              config_json: JSON.stringify({
                knowledgeFolderName: "Caddington Knowledge",
                knowledgeFolderId: "from-d1",
              }),
            }),
          }),
        }),
      },
      GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID: "from-env",
    } as never;

    const config = await loadGoogleDriveConnectorConfig(env);
    expect(config.knowledgeFolderId).toBe("from-env");
    expect(config.knowledgeFolderName).toBe("Caddington Knowledge");
    expect(config.writeOperationsEnabled).toBe(false);
    expect(config.syncMode).toBe("documents_only");
  });
});
