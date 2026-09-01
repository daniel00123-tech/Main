import type { Env } from "../env";
import {
  emptyEntityMemory,
  parseEntityMemory,
  serializeEntityMemory,
  type WhatsAppEntityMemory,
} from "./whatsapp-entities";

const MAX_TURNS = 6;
const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;

export type WhatsAppTurn = {
  role: "user" | "assistant";
  text: string;
};

export type WhatsAppConversationState = {
  userId: string;
  companyId: string | null;
  pendingCompanySelection: boolean;
  turns: WhatsAppTurn[];
  entities: WhatsAppEntityMemory;
  updatedAt: string;
};

function parseTurns(raw: string | null): WhatsAppTurn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is WhatsAppTurn => {
        return Boolean(
          item &&
            typeof item === "object" &&
            (item.role === "user" || item.role === "assistant") &&
            typeof item.text === "string"
        );
      })
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

export async function ensureWhatsAppConversationsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_conversations (
       user_id TEXT PRIMARY KEY,
       company_id TEXT,
       pending_company_selection INTEGER NOT NULL DEFAULT 0,
       turns_json TEXT NOT NULL DEFAULT '[]',
       entities_json TEXT NOT NULL DEFAULT '{}',
       updated_at TEXT NOT NULL
     )`,
  ).run();
  await env.DB.prepare(`ALTER TABLE whatsapp_conversations ADD COLUMN entities_json TEXT`).run().catch(() => undefined);
}

export async function loadWhatsAppConversation(
  env: Env,
  userId: string
): Promise<WhatsAppConversationState | null> {
  await ensureWhatsAppConversationsTable(env);
  let row: {
    user_id: string;
    company_id: string | null;
    pending_company_selection: number;
    turns_json: string | null;
    entities_json?: string | null;
    updated_at: string;
  } | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT user_id, company_id, pending_company_selection, turns_json, entities_json, updated_at
       FROM whatsapp_conversations
       WHERE user_id = ?`
    )
      .bind(userId)
      .first();
  } catch {
    try {
      row = await env.DB.prepare(
        `SELECT user_id, company_id, pending_company_selection, turns_json, updated_at
         FROM whatsapp_conversations
         WHERE user_id = ?`
      )
        .bind(userId)
        .first();
    } catch {
      return null;
    }
  }
  if (!row) return null;
  if (Date.parse(row.updated_at) + CONTEXT_TTL_MS < Date.now()) {
    return {
      userId: row.user_id,
      companyId: row.company_id,
      pendingCompanySelection: false,
      turns: [],
      entities: emptyEntityMemory(),
      updatedAt: row.updated_at,
    };
  }
  return {
    userId: row.user_id,
    companyId: row.company_id,
    pendingCompanySelection: row.pending_company_selection === 1,
    turns: parseTurns(row.turns_json),
    entities: parseEntityMemory(row.entities_json),
    updatedAt: row.updated_at,
  };
}

export async function saveWhatsAppConversation(
  env: Env,
  input: {
    userId: string;
    companyId: string | null;
    pendingCompanySelection?: boolean;
    turns: WhatsAppTurn[];
    entities?: WhatsAppEntityMemory;
  }
): Promise<void> {
  await ensureWhatsAppConversationsTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO whatsapp_conversations (
       user_id, company_id, pending_company_selection, turns_json, entities_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       company_id = excluded.company_id,
       pending_company_selection = excluded.pending_company_selection,
       turns_json = excluded.turns_json,
       entities_json = excluded.entities_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.userId,
      input.companyId,
      input.pendingCompanySelection ? 1 : 0,
      JSON.stringify(input.turns.slice(-MAX_TURNS)),
      serializeEntityMemory(input.entities ?? emptyEntityMemory()),
      now
    )
    .run();
}

export function compactConversationPrompt(turns: WhatsAppTurn[], currentMessage: string): string {
  const recent = turns
    .slice(-4)
    .map((turn) => `${turn.role === "user" ? "User" : "Infra"}: ${turn.text.slice(0, 280)}`)
    .join("\n");
  if (!recent) return currentMessage;
  return `Recent WhatsApp conversation (same company only):\n${recent}\n\nCurrent question:\n${currentMessage}`;
}

const CHEAP_TURN = /^(hi+|hello+|hey+|thanks|thank you|how are you|what can you do|who are you)\b/i;

/** Search query for MCP: current message, plus last business turn only when this is a follow-up. */
export function searchQueryFromContext(
  turns: WhatsAppTurn[],
  currentMessage: string,
  followUp: boolean,
): string {
  const current = currentMessage.trim();
  if (!followUp) return current;
  const lastBusiness = [...turns].reverse().find((turn) => {
    if (turn.role !== "user") return false;
    const text = turn.text.trim();
    return text.length > 8 && !CHEAP_TURN.test(text);
  });
  if (!lastBusiness) return current;
  return `${current}\n\nPrevious request: ${lastBusiness.text.slice(0, 160)}`;
}
