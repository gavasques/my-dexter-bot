import { THREAD_LIST_MAX, THREAD_SUMMARY_PREVIEW_MAX, THREAD_SUMMARY_TITLE_MAX, type ThreadSummary } from "@dexter/contracts";
import type { SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;
type Read = (sql: string, ...params: SQLInputValue[]) => Row[];

/** Serialized summaries stay well below the 256 KiB app-client response cap together with 500 thread items. */
export const THREAD_SUMMARIES_BYTE_BUDGET = 131_072;
/** Only a few candidate rows are inspected for a title/preview; a thread of image-only or markup-only messages stays untitled. */
const CANDIDATES = 5;
// Common credential shapes are masked in list previews; the transcript itself is unchanged and still read through GET messages.
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g;
// ZWJ/ZWNJ stay: they belong to emoji and script graphemes.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Plain single-line display text: no fences, leading Markdown markers, control/bidi characters or obvious tokens. */
export function threadDisplayText(raw: string, max: number): string | null {
  const text = raw.replace(/```[^\n]*/g, " ")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gm, "")
    .replace(INVISIBLE, " ")
    .replace(TOKEN, (_match, bearer?: string) => bearer ? `${bearer} ••••` : "••••")
    .replace(/\s+/g, " ").trim();
  if (!text || !/[\p{L}\p{N}\p{S}]/u.test(text)) return null;
  if (text.length <= max) return text;
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Read-only projection for already owner/audience-checked thread ids. Reads only `messages` and the attachment link
 * table (never image bytes, turns, actions or engine state), so it cannot emit events, admit work or replay effects.
 */
export function readThreadSummary(all: Read, threadId: string, createdAt: number): ThreadSummary {
  const stats = all("SELECT COUNT(*) AS n, MAX(cursor) AS last FROM messages WHERE thread_id=?", threadId)[0]!;
  const messageCount = Number(stats["n"]);
  const lastRow = stats["last"] === null ? undefined
    : all("SELECT id, created_at FROM messages WHERE cursor=? AND thread_id=?", stats["last"] as SQLInputValue, threadId)[0];
  const lastMessageAt = lastRow ? Number(lastRow["created_at"]) : null;
  const first = (sql: string, max: number): Row | undefined => {
    for (const row of all(sql, threadId, CANDIDATES)) {
      const text = threadDisplayText(String(row["content"]), max);
      if (text) return { ...row, text };
    }
    return undefined;
  };
  const title = first("SELECT content FROM messages WHERE thread_id=? AND role='user' AND trim(content)<>'' ORDER BY cursor LIMIT ?", THREAD_SUMMARY_TITLE_MAX);
  const preview = first("SELECT content, role FROM messages WHERE thread_id=? AND trim(content)<>'' ORDER BY cursor DESC LIMIT ?", THREAD_SUMMARY_PREVIEW_MAX);
  const lastMessageHasImage = lastRow !== undefined
    && all("SELECT 1 AS present FROM message_attachments WHERE message_id=? LIMIT 1", lastRow["id"] as SQLInputValue).length > 0;
  return {
    threadId, title: title ? String(title["text"]) : null,
    preview: preview ? String(preview["text"]) : null, previewRole: preview ? String(preview["role"]) as "user" | "assistant" : null,
    lastMessageHasImage, messageCount, lastMessageAt, updatedAt: Math.max(createdAt, lastMessageAt ?? 0),
  };
}

/** Most recently active first, truncated to the byte budget and 500 entries. Missing summaries mean "unknown", never "empty". */
export function boundedThreadSummaries(summaries: ThreadSummary[], budget = THREAD_SUMMARIES_BYTE_BUDGET): ThreadSummary[] {
  const ordered = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
  const out: ThreadSummary[] = [];
  let bytes = 2;
  for (const summary of ordered) {
    bytes += Buffer.byteLength(JSON.stringify(summary)) + 1;
    if (bytes > budget || out.length >= THREAD_LIST_MAX) break;
    out.push(summary);
  }
  return out;
}
