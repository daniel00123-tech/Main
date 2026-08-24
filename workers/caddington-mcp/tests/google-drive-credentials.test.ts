import { describe, expect, it } from "vitest";
import { parseGoogleDriveCredentials } from "../src/google-drive-client";

describe("parseGoogleDriveCredentials", () => {
  it("parses flat snake_case credentials", () => {
    expect(
      parseGoogleDriveCredentials(
        JSON.stringify({
          client_id: "id",
          client_secret: "secret",
          refresh_token: "refresh",
        })
      )
    ).toEqual({
      client_id: "id",
      client_secret: "secret",
      refresh_token: "refresh",
    });
  });

  it("parses nested web client credentials with root refresh token", () => {
    expect(
      parseGoogleDriveCredentials(
        JSON.stringify({
          web: {
            client_id: "id",
            client_secret: "secret",
          },
          refresh_token: "refresh",
        })
      )
    ).toEqual({
      client_id: "id",
      client_secret: "secret",
      refresh_token: "refresh",
    });
  });

  it("parses camelCase credentials", () => {
    expect(
      parseGoogleDriveCredentials(
        JSON.stringify({
          clientId: "id",
          clientSecret: "secret",
          refreshToken: "refresh",
        })
      )
    ).toEqual({
      client_id: "id",
      client_secret: "secret",
      refresh_token: "refresh",
    });
  });
});
