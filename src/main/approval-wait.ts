/**
 * Chats whose ChatGPT page shows ChatGPT's own tool approval card.
 *
 * Found by the VM stress test on 2026-10-06: a Loop ran ten clean turns, then ChatGPT asked
 * "Allow ChatGPT to use Chat On Steroids Core?" before an `echo` and flagged it as suspicious.
 * Only a person can answer that card. No call reached the app, silence recovery found nothing it
 * could repair, and the chat stood still with nobody told.
 *
 * The page reports the card on every activity poll. While it stands, this module says so once
 * in the chat's timeline, sends one desktop notice after a short grace (a person already looking
 * at the card answers it first), and holds recovery: a reload or a Continue cannot answer the
 * card and could lose it. The app answers the card itself only in the one case `answerOwnCard` names
 * (2026-10-29); every other card is the user's to answer.
 *
 * Since 2.1.38 the person can answer it in the app (the maintainer's request, 2026-10-14): the page
 * reports the card's words, an id for that exact card and whether ChatGPT lets Allow once be pressed.
 * A click in the app files one answer for that card id, which the same page's next poll carries
 * back; the page presses the button only if the card it shows is still that card. A replaced card,
 * a second click or an answer nobody took within `APPROVAL_ANSWER_MS` sends nothing.
 *
 * 2026-10-29: ChatGPT asks the card again in every new chat and after every page reload, although
 * Always allow was chosen, and a Pro run waited half an hour for a click. With `ui.autoAllowApproval`
 * (on unless switched off) a card that names one of this app's own connectors is answered Allow once
 * through the same path as a person's click.
 */
import { randomUUID } from 'node:crypto';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_PROGRESS_PREFIX, APPROVAL_WAITING_TEXT, type ApprovalCardView } from '../shared/approval-wait.js';

/** After this many automatic answers in one episode the app stops: a card that keeps coming back needs a person. */
export const AUTO_ANSWERS_PER_EPISODE = 4;
/** After a person's Deny in the app the app does not answer that chat's cards by itself for this long. */
export const AUTO_PAUSE_AFTER_DENY_MS = 10 * 60_000;
/** Hidden idle tabs poll every 30 s; two missed polls end the episode. */
export const APPROVAL_FRESH_MS = 75_000;
/** Time for a person looking at the card to answer it before a desktop notice interrupts them. */
export const APPROVAL_NOTICE_GRACE_MS = 30_000;
/** How long an answer waits for the card's page to take it; a visible card's page polls every 2 s. */
export const APPROVAL_ANSWER_MS = 30_000;
/**
 * ChatGPT sometimes redraws the card: gone for a poll, then back with the same words (VM,
 * 2026-10-20: 1.2 s). Back within this long, it is the same request, not an answer and a new one.
 */
export const APPROVAL_GONE_MS = 4_000;

/** What the page reports about the card it shows. */
export interface ApprovalCardFacts { id: string; lines: string[]; allow: boolean }
export type ApprovalChoice = 'allow' | 'deny';
export type ApprovalOutcome = 'clicked' | 'card_changed' | 'unavailable' | 'expired';
interface ApprovalAnswer { token: string; cardId: string; choice: ApprovalChoice; at: number; outcome: ApprovalOutcome | null }

export interface ApprovalWaitDeps {
  /**
   * This app's own connector names while the owner lets it answer their cards; none (absent or
   * empty) leaves every card to a person. Read at each card, so the setting takes effect at once.
   */
  ownConnectors?(): readonly string[];
  record(sessionId: string, progressId: string, text: string, anchor?: { seq: number; time: number }): Promise<{ seq: number; time: number } | null>;
  notify(sessionId: string): void;
  log(message: string): void;
  /** A chat started or stopped waiting, so the session list's `approval` changed. */
  changed?(): void;
  /**
   * The session's latest approval row if it still says waiting: one an earlier app run wrote and
   * never rewrote. A new wait takes it over instead of adding a row after every restart.
   */
  previous?(sessionId: string): Promise<{ progressId: string; anchor: { seq: number; time: number } } | null>;
}

interface Wait {
  since: number;
  seenAt: number;
  noticed: boolean;
  /** The app filed Allow once for the card now showing; the row and the notice wait until that has failed for a while. */
  auto: boolean;
  /** Allow once answers filed in this episode, counting a redrawn card as the same one. */
  presses: number;
  progressId: string;
  sessionId: string | null;
  row: Promise<{ seq: number; time: number } | null> | null;
  card: ApprovalCardFacts | null;
  answer: ApprovalAnswer | null;
  /** Fires when no poll has refreshed the wait for `APPROVAL_FRESH_MS`: nothing else would say so. */
  stale: NodeJS.Timeout | null;
}

const waits = new Map<string, Wait>();
/** The episode a page last reported answered, kept for `APPROVAL_GONE_MS` in case the card was only redrawn. */
const answered = new Map<string, { wait: Wait; at: number; anchor: { seq: number; time: number } | null }>();
/** When a person last pressed Deny in the app, per chat. A Deny pressed in the browser itself is not seen. */
const denied = new Map<string, number>();

function sameWords(a: ApprovalCardFacts | null, b: ApprovalCardFacts | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index]);
}

/** Question marks that end a card title: Latin, full-width and Arabic. */
const QUESTION_END = /[?\uFF1F\u061F]$/u;

/**
 * What may follow the name before the question mark: lowercase letters, other scripts' letters and marks
 * (German "zu verwenden", Turkish, Japanese and Korean particles), spaces and parentheses. A capital, digit,
 * symbol, emoji or punctuation there means a longer or different name ("Core 2", "Core Laptop", "Core @lap").
 * Known gaps: a lowercase Latin word or a CJK suffix after the name still reads as part of the sentence.
 */
const PLAIN_AFTER = /^[\s\p{Ll}\p{Lo}\p{M}()\uFF08\uFF09]{0,60}$/u;
/** A bracket right after the name that opens Latin text is a suffix ("Core (Laptop)"); Korean "을(를)" is not. */
const SUFFIX_OPENING = /^\s*[([{<\uFF08\uFF3B\uFF5B\u3008-\u3010]\s*[\p{Script=Latin}\p{N}]/u;
/** A quote that closes right after the name belongs to the sentence ("「Chat On Steroids Core」の..."). */
const CLOSING_QUOTE = /^["\u00BB\u2019\u201D\u300D\u300F]/u;

function titleNames(title: string, name: string): boolean {
  for (let at = title.indexOf(name); at >= 0; at = title.indexOf(name, at + 1)) {
    // The name runs on from a longer word or name before it ("My-Chat On Steroids Core").
    if (/[\p{Script=Latin}\p{N}_-]$/u.test(title.slice(0, at))) continue;
    const after = title.slice(at + name.length, -1).replace(CLOSING_QUOTE, '');
    if (/^[\p{Script=Latin}\p{N}_]/u.test(after) || SUFFIX_OPENING.test(after) || !PLAIN_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Which of `names` the card asks about, or null. Only the card's title counts: the first line when it
 * ends in a question mark, or the second when the first is exactly one of the names (the app's header).
 * Any other first line (a warning, another app's name) leaves the card to a person, as does a title
 * that does not end in a question mark. The name must stand alone in the title (see `PLAIN_AFTER`), so
 * "Chat On Steroids Core (Laptop)", "... — LAP-PACO2" and "... 2" never match. A word in front of the
 * name ("My Chat On Steroids Core") is not told apart.
 */
export function cardNamedConnector(lines: readonly string[], names: readonly string[]): string | null {
  const [first = '', second = ''] = lines;
  const title = QUESTION_END.test(first) ? first : names.includes(first) ? second : '';
  if (!title || !QUESTION_END.test(title) || title.length > 140) return null;
  return names.find(name => !!name && titleNames(title, name)) ?? null;
}

/** Whether this chat's page said, recently enough to still be true, that the card is waiting. */
export function approvalCardWaiting(conversationId: string, now = Date.now()): boolean {
  const wait = waits.get(conversationId);
  return !!wait && now - wait.seenAt < APPROVAL_FRESH_MS;
}

/** Every chat `approvalCardWaiting` holds true for; the session list carries it as `approval`. */
export function approvalWaitingChats(now = Date.now()): string[] {
  return [...waits.keys()].filter(conversationId => approvalCardWaiting(conversationId, now));
}

/**
 * One activity poll's word on the card. `sessionId` is the recorded session of this chat, if any:
 * the row and the notice need one, the recovery hold does not.
 */
export async function noteApprovalCard(
  conversationId: string,
  waiting: boolean,
  sessionId: string | null,
  deps: ApprovalWaitDeps,
  now = Date.now(),
  card?: ApprovalCardFacts | null
): Promise<void> {
  let wait = waits.get(conversationId);
  if (wait && (!waiting || now - wait.seenAt >= APPROVAL_FRESH_MS)) {
    waits.delete(conversationId);
    if (wait.stale) clearTimeout(wait.stale);
    deps.log(`bridge: ${conversationId} no longer shows ChatGPT's tool approval card`);
    try { deps.changed?.(); } catch { /* The list is reread on the next push. */ }
    // Only an answer seen on the page itself rewrites the row; a page that stopped reporting
    // says nothing about the card.
    const anchor = waiting ? null : await wait.row;
    if (anchor && wait.sessionId) await deps.record(wait.sessionId, wait.progressId, APPROVAL_ANSWERED_TEXT, anchor).catch(() => null);
    if (!waiting) {
      for (const [id, entry] of answered) if (now - entry.at >= APPROVAL_GONE_MS) answered.delete(id);
      answered.set(conversationId, { wait, at: now, anchor });
    }
    wait = undefined;
  }
  if (!waiting) return;
  const before = answered.get(conversationId);
  answered.delete(conversationId);
  if (!wait && before && now - before.at < APPROVAL_GONE_MS && sameWords(before.wait.card, card) && !waits.has(conversationId)) {
    // Only redrawn: the same episode goes on, its row says waiting again and no second notice comes.
    wait = before.wait;
    wait.seenAt = now;
    waits.set(conversationId, wait);
    deps.log(`bridge: ${conversationId} shows the same tool approval card again; it was redrawn, not answered`);
    try { deps.changed?.(); } catch { /* The list is reread on the next push. */ }
    if (before.anchor && wait.sessionId) await deps.record(wait.sessionId, wait.progressId, APPROVAL_WAITING_TEXT, before.anchor).catch(() => null);
  }
  if (!wait) {
    wait = { since: now, seenAt: now, noticed: false, auto: false, presses: 0, progressId: `${APPROVAL_PROGRESS_PREFIX}${conversationId}:${now}`, sessionId: null, row: null, card: null, answer: null, stale: null };
    waits.set(conversationId, wait);
    deps.log(`bridge: ${conversationId} waits for the user to answer ChatGPT's tool approval card`);
    try { deps.changed?.(); } catch { /* The list is reread on the next push. */ }
  }
  wait.seenAt = now;
  if (deps.changed) {
    // A page that stops reporting ends the wait with no poll left to say so.
    const current = wait;
    if (current.stale) clearTimeout(current.stale);
    const arm = (delay: number): void => {
      current.stale = setTimeout(() => {
        current.stale = null;
        if (waits.get(conversationId) !== current) return;
        // A timer may fire a moment early. Pushed then, the list would still say waiting, and
        // nothing would push again: wait out what is left of the freshness window first.
        const left = current.seenAt + APPROVAL_FRESH_MS - Date.now();
        if (left > 0) { arm(left); return; }
        try { deps.changed?.(); } catch { /* as above */ }
      }, delay);
      current.stale.unref?.();
    };
    arm(APPROVAL_FRESH_MS);
  }
  if (card) {
    // Another card replaces this one: an answer filed for the old card must never reach it.
    // Another card, or other words in the same element, is a new request: an answer filed for the old one never reaches it.
    const fresh = wait.card?.id !== card.id || !sameWords(wait.card, card);
    if (wait.card && fresh) { wait.answer = null; wait.auto = false; }
    wait.card = card;
    if (fresh) answerOwnCard(conversationId, wait, card, deps, now);
  }
  // A card the app answered itself gets no row and no notice unless it is still standing after the grace: the answer is on its way.
  if (sessionId && !wait.sessionId && !(wait.auto && now - wait.since < APPROVAL_NOTICE_GRACE_MS)) {
    wait.sessionId = sessionId;
    const current = wait;
    const own = `${APPROVAL_PROGRESS_PREFIX}${conversationId}:`;
    current.row = (async () => {
      // Only this chat's row: after Compact & Resume the session's earlier rows belong to the chat it left.
      const earlier = deps.previous ? await deps.previous(sessionId).catch(() => null) : null;
      if (earlier?.progressId.startsWith(own)) {
        current.progressId = earlier.progressId;
        return earlier.anchor;
      }
      return deps.record(sessionId, current.progressId, APPROVAL_WAITING_TEXT).catch(() => null);
    })();
    await current.row;
  }
  if (wait.sessionId && !wait.noticed && now - wait.since >= APPROVAL_NOTICE_GRACE_MS) {
    wait.noticed = true;
    try { deps.notify(wait.sessionId); } catch { /* The row still says it. */ }
  }
}

/**
 * A card that names one of this app's own connectors is answered Allow once through the same path
 * as a person's click: one answer for exactly this card, carried by the same page, refused if ChatGPT
 * disabled Allow. One attempt per card: if the press fails the card stays for a person, with the row
 * and the notice after the grace. Always allow is never pressed. The answer does not look at what the
 * card is about, so a card ChatGPT's safety check raised (a "Suspicious instruction") with a plain
 * title is answered too; each answer is logged with the card's first two lines to show what it was.
 */
function answerOwnCard(conversationId: string, wait: Wait, card: ApprovalCardFacts, deps: ApprovalWaitDeps, now: number): void {
  try {
    const names = deps.ownConnectors?.() ?? [];
    if (!names.length || !card.allow) return;
    const name = cardNamedConnector(card.lines, names);
    if (!name) return;
    const deniedAt = denied.get(conversationId);
    if (deniedAt !== undefined && now - deniedAt < AUTO_PAUSE_AFTER_DENY_MS) {
      deps.log(`bridge: ${conversationId} tool approval card for ${name} left to a person: they pressed Deny in the app a moment ago`);
      return;
    }
    if (wait.presses >= AUTO_ANSWERS_PER_EPISODE) {
      deps.log(`bridge: ${conversationId} tool approval card for ${name} left to a person: it came back ${wait.presses} times in a row`);
      return;
    }
    const asked = requestApprovalAnswer(conversationId, card.id, 'allow', now);
    wait.auto = asked.ok;
    if (asked.ok) wait.presses++;
    const seen = card.lines.slice(0, 2).map(line => line.slice(0, 120)).join(' | ');
    deps.log(asked.ok
      ? `bridge: ${conversationId} tool approval card for ${name} auto-allowed (Allow once): ${seen}`
      : `bridge: ${conversationId} tool approval card for ${name} not auto-allowed: ${asked.error}`);
  } catch (error) {
    // A fault here must not stop the wait from being noted: that is the stall this exists to end.
    try { deps.log(`bridge: ${conversationId} tool approval card could not be answered automatically: ${error instanceof Error ? error.message : String(error)}`); } catch { /* nothing left to tell */ }
  }
}

/** The card a person can answer in the app, with the last answer filed for it. */
export function approvalCardView(conversationId: string, now = Date.now()): ApprovalCardView | null {
  const wait = waits.get(conversationId);
  if (!wait?.card || now - wait.seenAt >= APPROVAL_FRESH_MS) return null;
  expire(wait, now);
  return { ...wait.card, lines: [...wait.card.lines], answer: wait.answer ? { choice: wait.answer.choice, outcome: wait.answer.outcome } : null };
}

/** A person's click in the app: one answer for exactly the card they were shown. */
export function requestApprovalAnswer(conversationId: string, cardId: string, choice: ApprovalChoice, now = Date.now()):
  { ok: true; token: string } | { ok: false; error: 'no_card' | 'card_changed' | 'allow_unavailable' | 'answer_pending' | 'bad_choice' } {
  if (choice !== 'allow' && choice !== 'deny') return { ok: false, error: 'bad_choice' };
  const wait = waits.get(conversationId);
  if (!wait?.card || now - wait.seenAt >= APPROVAL_FRESH_MS) return { ok: false, error: 'no_card' };
  if (wait.card.id !== cardId) return { ok: false, error: 'card_changed' };
  if (choice === 'allow' && !wait.card.allow) return { ok: false, error: 'allow_unavailable' };
  expire(wait, now);
  if (wait.answer && wait.answer.outcome === null) return { ok: false, error: 'answer_pending' };
  wait.answer = { token: randomUUID(), cardId, choice, at: now, outcome: null };
  if (choice === 'deny') denied.set(conversationId, now);
  return { ok: true, token: wait.answer.token };
}

/** The answer this chat's page should carry out on its next poll, if one is waiting. */
export function approvalAnswerFor(conversationId: string, now = Date.now()): { token: string; cardId: string; choice: ApprovalChoice } | null {
  const wait = waits.get(conversationId);
  if (!wait?.answer) return null;
  expire(wait, now);
  const answer = wait.answer;
  return answer && answer.outcome === null ? { token: answer.token, cardId: answer.cardId, choice: answer.choice } : null;
}

/** The page's report on an answer it was given: pressed, or why not. Unknown tokens are ignored. */
export function settleApprovalAnswer(conversationId: string, token: string, outcome: Exclude<ApprovalOutcome, 'expired'>): boolean {
  const answer = waits.get(conversationId)?.answer;
  if (!answer || answer.token !== token || answer.outcome !== null) return false;
  answer.outcome = outcome;
  return true;
}

/** The page's card report from its activity poll; anything malformed is no card at all. */
export function parseApprovalCard(raw: string | null): ApprovalCardFacts | null {
  if (!raw || raw.length > 8_000) return null;
  try {
    const value = JSON.parse(raw) as Partial<ApprovalCardFacts>;
    if (typeof value?.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value.id) || typeof value.allow !== 'boolean' || !Array.isArray(value.lines)) return null;
    const lines = value.lines.filter((line): line is string => typeof line === 'string')
      .map(line => line.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 8);
    return { id: value.id, lines, allow: value.allow };
  } catch { return null; }
}

/** The page's report on an answer it was given, from its activity poll. */
export function parseApprovalResult(raw: string | null): { token: string; outcome: Exclude<ApprovalOutcome, 'expired'> } | null {
  if (!raw || raw.length > 500) return null;
  try {
    const value = JSON.parse(raw) as { token?: unknown; outcome?: unknown };
    if (typeof value?.token !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value.token)) return null;
    return value.outcome === 'clicked' || value.outcome === 'card_changed' || value.outcome === 'unavailable'
      ? { token: value.token, outcome: value.outcome } : null;
  } catch { return null; }
}

function expire(wait: Wait, now: number): void {
  if (wait.answer && wait.answer.outcome === null && now - wait.answer.at >= APPROVAL_ANSWER_MS) wait.answer.outcome = 'expired';
}

export function resetApprovalWaits(): void {
  for (const wait of waits.values()) if (wait.stale) clearTimeout(wait.stale);
  waits.clear();
  answered.clear();
  denied.clear();
}
