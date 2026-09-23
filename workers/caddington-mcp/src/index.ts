import { createMcpHandler } from "agents/mcp/server";
import { handleAdminRequest } from "./admin";
import type { Env } from "./db";
import {
  recordScheduledGoogleDriveScanDate,
  shouldRunScheduledGoogleDriveScan,
} from "./google-drive-schedule";
import {
  processGoogleDriveFileMessage,
  runScheduledGoogleDriveScan,
  type GoogleDriveFileQueueMessage,
} from "./google-drive-sync";
import { log } from "./logger";
import { createCaddingtonMcpServer } from "./mcp-server";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function checkMcpAuth(request: Request, env: Env): boolean {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === expected;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "caddington-mcp" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname.startsWith("/admin")) {
      return handleAdminRequest(request, env, url);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!checkMcpAuth(request, env)) {
        log("warn", "mcp_auth_failed", { path: url.pathname });
        return unauthorized();
      }

      const handler = createMcpHandler(
        () => createCaddingtonMcpServer(env),
        { route: "/mcp", legacy: "stateless" }
      );
      return handler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const gate = await shouldRunScheduledGoogleDriveScan(
      env,
      controller.scheduledTime
    );

    if (!gate.run) {
      log("info", "google_drive_scheduled_scan_skipped", {
        reason: gate.reason,
        cron: controller.cron,
        local: gate.local,
      });
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          const summary = await runScheduledGoogleDriveScan(env);
          await recordScheduledGoogleDriveScanDate(env, gate.local.calendarDate);
          log("info", "google_drive_scheduled_scan_completed", {
            cron: controller.cron,
            local: gate.local,
            summary,
          });
        } catch (error) {
          log("error", "google_drive_scheduled_scan_failed", {
            cron: controller.cron,
            local: gate.local,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })()
    );
  },

  async queue(
    batch: MessageBatch<GoogleDriveFileQueueMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processGoogleDriveFileMessage(env, message.body);
        message.ack();
      } catch (error) {
        log("error", "google_drive_queue_message_failed", {
          driveFileId: message.body.driveFileId,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
