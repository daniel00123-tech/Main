import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { CALENDAR_POLICY_SUMMARY } from "./config";
import { createMicrosoftContext, jsonTool } from "./context";
import { toolErrorPayload } from "./errors";
import {
  getUser,
  listGroups,
  listUsers,
} from "./directory";
import {
  forwardMail,
  getConversation,
  getMessage,
  listAttachments,
  listFolders,
  moveMessage,
  replyMail,
  searchMailbox,
  sendMail,
  setReadState,
} from "./mail";
import {
  getFile,
  listFolder,
  searchFiles,
} from "./files";
import {
  cancelEvent,
  createEvent,
  getEvent,
  searchEvents,
  updateEvent,
} from "./calendar";
import { upsertCatalogueItem } from "./knowledge";

function mailboxDesc(): string {
  return "Approved shared mailbox only: finance@elvexpropertyservices.com or info@elvexpropertyservices.com. Personal staff mailboxes are rejected.";
}

export function registerMicrosoftTools(server: McpServer, env: Env): void {
  server.registerTool(
    "search_elvex_users",
    {
      description:
        "Search the Elvex Microsoft 365 directory (users and optionally groups). Returns IDs needed for OneDrive ownership checks. Does not expose mailbox contents.",
      inputSchema: {
        query: z.string().optional().describe("Name or email fragment."),
        include_groups: z.boolean().optional(),
      },
    },
    async ({ query, include_groups }) => {
      try {
        const ctx = await createMicrosoftContext(env);
        const users = await listUsers(ctx.graph, query);
        const groups = include_groups ? await listGroups(ctx.graph, query) : [];
        return jsonTool({
          company: "Elvex Property Services Ltd",
          users: users.map((user) => ({
            ...user,
            protected: ctx.policy.isProtectedUser(user),
          })),
          groups,
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "search_elvex_email",
    {
      description: `Search or list recent messages in approved Elvex shared mailboxes only. ${mailboxDesc()} Personal mailboxes are never searched.`,
      inputSchema: {
        mailbox: z.string().describe(mailboxDesc()),
        query: z.string().optional(),
        sender: z.string().optional(),
        recipient: z.string().optional(),
        subject: z.string().optional(),
        keywords: z.string().optional(),
        from_date: z.string().optional(),
        to_date: z.string().optional(),
        folder: z.string().optional(),
        top: z.number().int().min(1).max(40).optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        const messages = await searchMailbox(ctx.graph, ctx.policy, {
          mailbox: input.mailbox,
          query: input.query,
          sender: input.sender,
          recipient: input.recipient,
          subject: input.subject,
          keywords: input.keywords,
          fromDate: input.from_date,
          toDate: input.to_date,
          folder: input.folder,
          top: input.top,
        });
        return jsonTool({ mailbox: ctx.policy.assertApprovedMailbox(input.mailbox), messages });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "get_elvex_email",
    {
      description: `Read a shared-mailbox message, conversation, folders, or attachment metadata. ${mailboxDesc()}`,
      inputSchema: {
        mailbox: z.string(),
        message_id: z.string().optional(),
        conversation_id: z.string().optional(),
        include_body: z.boolean().optional(),
        include_attachments: z.boolean().optional(),
        include_attachment_content: z.boolean().optional(),
        list_folders: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        if (input.list_folders) {
          return jsonTool({ folders: await listFolders(ctx.graph, ctx.policy, input.mailbox) });
        }
        if (input.conversation_id) {
          return jsonTool({
            messages: await getConversation(ctx.graph, ctx.policy, input.mailbox, input.conversation_id),
          });
        }
        if (!input.message_id) {
          return jsonTool({ error: "message_id or conversation_id is required", code: "EL_MS_INPUT" }, true);
        }
        const message = await getMessage(
          ctx.graph,
          ctx.policy,
          input.mailbox,
          input.message_id,
          input.include_body !== false
        );
        const attachments = input.include_attachments
          ? await listAttachments(
              ctx.graph,
              ctx.policy,
              input.mailbox,
              input.message_id,
              Boolean(input.include_attachment_content)
            )
          : undefined;
        return jsonTool({ message, attachments });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "send_elvex_email",
    {
      description: `Send, reply, or forward from an approved Elvex shared mailbox only. ${mailboxDesc()} Cannot send as a personal mailbox.`,
      inputSchema: {
        mailbox: z.string(),
        action: z.enum(["send", "reply", "forward"]).optional(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        message_id: z.string().optional(),
        comment: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        const action = input.action ?? "send";
        if (action === "reply") {
          if (!input.message_id || !input.comment) {
            return jsonTool({ error: "reply requires message_id and comment", code: "EL_MS_INPUT" }, true);
          }
          return jsonTool(await replyMail(ctx.graph, ctx.policy, input.mailbox, input.message_id, input.comment));
        }
        if (action === "forward") {
          if (!input.message_id || !input.to?.length) {
            return jsonTool({ error: "forward requires message_id and to", code: "EL_MS_INPUT" }, true);
          }
          return jsonTool(
            await forwardMail(ctx.graph, ctx.policy, input.mailbox, input.message_id, input.to, input.comment)
          );
        }
        if (!input.to?.length || !input.subject || !input.body) {
          return jsonTool({ error: "send requires to, subject and body", code: "EL_MS_INPUT" }, true);
        }
        return jsonTool(
          await sendMail(ctx.graph, ctx.policy, {
            mailbox: input.mailbox,
            to: input.to,
            cc: input.cc,
            subject: input.subject,
            body: input.body,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "manage_elvex_email",
    {
      description: `Mark read/unread or move a message between folders on an approved shared mailbox. ${mailboxDesc()}`,
      inputSchema: {
        mailbox: z.string(),
        message_id: z.string(),
        action: z.enum(["mark_read", "mark_unread", "move"]),
        destination_folder_id: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        if (input.action === "move") {
          if (!input.destination_folder_id) {
            return jsonTool({ error: "destination_folder_id required", code: "EL_MS_INPUT" }, true);
          }
          return jsonTool(
            await moveMessage(ctx.graph, ctx.policy, input.mailbox, input.message_id, input.destination_folder_id)
          );
        }
        return jsonTool(
          await setReadState(
            ctx.graph,
            ctx.policy,
            input.mailbox,
            input.message_id,
            input.action === "mark_read"
          )
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "search_elvex_files",
    {
      description:
        "Search Elvex SharePoint (elvexpropertyservicesltd.sharepoint.com) and eligible employee OneDrives. Protected users (William, Ella, and any configured deny-list identities) are excluded before results are returned. Personal mailbox data is not included.",
      inputSchema: {
        query: z.string().describe("Filename or keyword search."),
        filename: z.string().optional(),
        source: z.enum(["sharepoint", "onedrive", "all"]).optional(),
        top: z.number().int().min(1).max(40).optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        const result = await searchFiles(ctx.graph, ctx.config, ctx.policy, input);
        if (env.EL_BUSINESS_DATA) {
          for (const hit of result.results.slice(0, 10)) {
            await upsertCatalogueItem(env.EL_BUSINESS_DATA, ctx.policy, hit).catch(() => undefined);
          }
        }
        return jsonTool({
          sharePoint: result.sharePointSite,
          excludedProtectedCount: result.excludedProtectedCount,
          results: result.results,
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "get_elvex_file",
    {
      description:
        "Get Elvex SharePoint/OneDrive file metadata (and small file content). Protected-user drives are denied even if a drive ID is supplied.",
      inputSchema: {
        drive_id: z.string(),
        item_id: z.string().optional(),
        include_content: z.boolean().optional(),
        list_children: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        if (input.list_children || !input.item_id) {
          return jsonTool({
            items: await listFolder(ctx.graph, ctx.policy, {
              driveId: input.drive_id,
              itemId: input.item_id,
            }),
          });
        }
        return jsonTool(
          await getFile(ctx.graph, ctx.policy, {
            driveId: input.drive_id,
            itemId: input.item_id,
            includeContent: input.include_content,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "search_elvex_calendar",
    {
      description: `Search or list events on approved Elvex shared-mailbox calendars only. ${CALENDAR_POLICY_SUMMARY}`,
      inputSchema: {
        mailbox: z.string(),
        query: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        event_id: z.string().optional(),
        top: z.number().int().min(1).max(40).optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        if (input.event_id) {
          return jsonTool({
            event: await getEvent(ctx.graph, ctx.policy, input.mailbox, input.event_id),
            policy: CALENDAR_POLICY_SUMMARY,
          });
        }
        return jsonTool(await searchEvents(ctx.graph, ctx.policy, input));
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "manage_elvex_calendar",
    {
      description: `Create, update, or cancel events on approved shared-mailbox calendars only. Attendees can be resolved from the Elvex directory. ${CALENDAR_POLICY_SUMMARY}`,
      inputSchema: {
        mailbox: z.string(),
        action: z.enum(["create", "update", "cancel"]),
        event_id: z.string().optional(),
        subject: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        location: z.string().optional(),
        body: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const ctx = await createMicrosoftContext(env);
        if (input.action === "cancel") {
          if (!input.event_id) return jsonTool({ error: "event_id required", code: "EL_MS_INPUT" }, true);
          return jsonTool(await cancelEvent(ctx.graph, ctx.policy, input.mailbox, input.event_id));
        }
        if (input.action === "update") {
          if (!input.event_id) return jsonTool({ error: "event_id required", code: "EL_MS_INPUT" }, true);
          return jsonTool(
            await updateEvent(ctx.graph, ctx.policy, {
              mailbox: input.mailbox,
              eventId: input.event_id,
              subject: input.subject,
              start: input.start,
              end: input.end,
              location: input.location,
              attendees: input.attendees,
            })
          );
        }
        if (!input.subject || !input.start || !input.end) {
          return jsonTool({ error: "create requires subject, start and end", code: "EL_MS_INPUT" }, true);
        }
        return jsonTool(
          await createEvent(ctx.graph, ctx.policy, {
            mailbox: input.mailbox,
            subject: input.subject,
            start: input.start,
            end: input.end,
            attendees: input.attendees,
            location: input.location,
            body: input.body,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "resolve_elvex_directory_user",
    {
      description: "Resolve an Elvex Microsoft user by name or email to id, UPN and mailbox address.",
      inputSchema: {
        query: z.string(),
      },
    },
    async ({ query }) => {
      try {
        const ctx = await createMicrosoftContext(env);
        const exact = await getUser(ctx.graph, query);
        const users = exact ? [exact] : await listUsers(ctx.graph, query, 10);
        return jsonTool({
          users: users.map((user) => ({
            ...user,
            protected: ctx.policy.isProtectedUser(user),
          })),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );
}

export async function searchCompanyKnowledgeViaMicrosoft(
  env: Env,
  query: string,
  topK = 8
): Promise<unknown> {
  const ctx = await createMicrosoftContext(env);
  const result = await searchFiles(ctx.graph, ctx.config, ctx.policy, {
    query,
    source: "all",
    top: topK,
  });
  return {
    status: "live_microsoft_graph",
    note: "Company knowledge index (R2/Vectorize) is not provisioned. Results are a live Microsoft Graph search with protected-user filtering applied before return.",
    confidence: result.results.length ? "plausible" : "weak",
    excludedProtectedCount: result.excludedProtectedCount,
    results: result.results,
  };
}
