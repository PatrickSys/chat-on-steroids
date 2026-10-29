import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_ANSWER_MS, APPROVAL_FRESH_MS, AUTO_ANSWERS_PER_EPISODE, AUTO_PAUSE_AFTER_DENY_MS, APPROVAL_GONE_MS, APPROVAL_NOTICE_GRACE_MS, approvalAnswerFor, approvalCardView, approvalCardWaiting, approvalWaitingChats, cardNamedConnector, noteApprovalCard, parseApprovalCard,
  requestApprovalAnswer, resetApprovalWaits, settleApprovalAnswer, type ApprovalCardFacts, type ApprovalWaitDeps
} from '../src/main/approval-wait.js';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT } from '../src/shared/approval-wait.js';

// VM stress test, 2026-10-06: ChatGPT's own approval card stalled a Loop and nobody was told.

describe('approval card episodes', () => {
  let deps: ApprovalWaitDeps & { rows: Array<[string, string, string, unknown]>; notices: string[] };
  beforeEach(() => {
    resetApprovalWaits();
    const rows: Array<[string, string, string, unknown]> = [], notices: string[] = [];
    deps = {
      rows, notices,
      record: async (sessionId, progressId, text, anchor) => { rows.push([sessionId, progressId, text, anchor]); return anchor ?? { seq: 7, time: 1 }; },
      notify: sessionId => { notices.push(sessionId); },
      log: () => undefined
    };
  });

  it('writes the row at once, notices once after the grace, and rewrites the row when answered', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000)).toBe(true);
    expect(deps.rows).toEqual([['session', expect.stringMatching(/^approval-wait:chat:/), APPROVAL_WAITING_TEXT, undefined]]);
    expect(deps.notices).toEqual([]);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 10_000);
    expect(deps.notices).toEqual(['session']);
    expect(deps.rows).toHaveLength(1);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 20_000);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_NOTICE_GRACE_MS + 20_000)).toBe(false);
    expect(deps.rows[1]).toEqual(['session', deps.rows[0]![1], APPROVAL_ANSWERED_TEXT, { seq: 7, time: 1 }]);
  });

  it('answered before the grace: no notice at all', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS - 1);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 1);
    expect(deps.notices).toEqual([]);
  });

  it('a page that stopped reporting ends the hold without claiming an answer', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS - 1)).toBe(true);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS)).toBe(false);
    // The card is seen again later: a new episode with its own row, never "answered".
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_FRESH_MS + 5_000);
    expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT, APPROVAL_WAITING_TEXT]);
    expect(deps.rows[0]![1]).not.toBe(deps.rows[1]![1]);
  });

  it('takes back "answered" when the same card returns at once, so a redrawn card stays one request', async () => {
    // VM, 2026-10-20: ChatGPT redrew the card; it was gone for 1.2 s. The chat said the approval
    // was answered (nobody had answered) and showed the same request again below.
    const card = { id: 'node-1', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Start a worker.'], allow: true };
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS, card);
    expect(deps.notices).toEqual(['session']);
    await noteApprovalCard('chat', false, 'session', deps, 40_000);
    await noteApprovalCard('chat', true, 'session', deps, 40_000 + APPROVAL_GONE_MS - 1, { ...card, id: 'node-2' });
    const id = deps.rows[0]![1];
    expect(deps.rows.every(row => row[1] === id)).toBe(true);
    expect(deps.rows.at(-1)![2]).toBe(APPROVAL_WAITING_TEXT);
    expect(deps.notices).toEqual(['session']);
    expect(approvalCardWaiting('chat', 40_000 + APPROVAL_GONE_MS)).toBe(true);
    expect(approvalCardView('chat', 40_000 + APPROVAL_GONE_MS)?.id).toBe('node-2');

    // A real answer later still reads as answered.
    await noteApprovalCard('chat', false, 'session', deps, 60_000);
    expect(deps.rows.at(-1)![2]).toBe(APPROVAL_ANSWERED_TEXT);
    expect(approvalCardWaiting('chat', 60_000)).toBe(false);
  });

  it('keeps an answer when a different card follows it, or the same one only after a while', async () => {
    const first = { id: 'a', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Run one command.'], allow: true };
    const second = { id: 'b', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Write one file.'], allow: true };
    await noteApprovalCard('chat', true, 'session', deps, 1_000, first);
    await noteApprovalCard('chat', false, 'session', deps, 2_000);
    await noteApprovalCard('chat', true, 'session', deps, 3_000, second);
    await noteApprovalCard('chat', false, 'session', deps, 4_000);
    await noteApprovalCard('chat', true, 'session', deps, 4_000 + APPROVAL_GONE_MS, { ...second, id: 'c' });
    const episodes = new Set(deps.rows.map(row => row[1]));
    expect(episodes.size).toBe(3);
    expect(deps.rows.filter(row => row[2] === APPROVAL_ANSWERED_TEXT)).toHaveLength(2);
  });

  it('takes over the row an earlier app run left waiting instead of adding another', async () => {
    // VM, 2026-10-20: every restart while one card waited added a "waiting" row, five in the end.
    const lookups: string[] = [];
    deps.previous = async sessionId => {
      lookups.push(sessionId);
      return { progressId: 'approval-wait:chat:earlier-run', anchor: { seq: 3, time: 5 } };
    };
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(lookups).toEqual(['session']);
    expect(deps.rows).toEqual([]);
    await noteApprovalCard('chat', false, 'session', deps, 2_000);
    expect(deps.rows).toEqual([['session', 'approval-wait:chat:earlier-run', APPROVAL_ANSWERED_TEXT, { seq: 3, time: 5 }]]);
  });

  it('starts its own row when the last one was answered, belongs to another chat, or is missing', async () => {
    for (const previous of [null, { progressId: 'approval-wait:other-chat:1', anchor: { seq: 3, time: 5 } }]) {
      resetApprovalWaits();
      deps.rows.length = 0;
      deps.previous = async () => previous;
      await noteApprovalCard('chat', true, 'session', deps, 1_000);
      expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT]);
      expect(deps.rows[0]![1]).toMatch(/^approval-wait:chat:/);
    }
  });

  it('holds recovery for a chat the app has not recorded, without a row or notice', async () => {
    await noteApprovalCard('chat', true, null, deps, 1_000);
    await noteApprovalCard('chat', true, null, deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_NOTICE_GRACE_MS)).toBe(true);
    expect(deps.rows).toEqual([]);
    expect(deps.notices).toEqual([]);
  });
});

// The sidebar's Inbox ranks every chat, not only the open one, so the list carries the waits.
describe('the session list view', () => {
  beforeEach(() => resetApprovalWaits());
  afterEach(() => { vi.useRealTimers(); resetApprovalWaits(); });

  it('lists the chats whose card waits and drops one once answered or no longer reported, saying so each time', async () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const deps: ApprovalWaitDeps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined,
      changed: () => { changes.push('changed'); } };
    await noteApprovalCard('answered', true, 'session-a', deps, 1_000);
    await noteApprovalCard('unrecorded', true, null, deps, 1_000);
    expect(approvalWaitingChats(1_000).sort()).toEqual(['answered', 'unrecorded']);
    expect(changes).toHaveLength(2);
    // Another poll of the same card changes nothing.
    await noteApprovalCard('answered', true, 'session-a', deps, 3_000);
    expect(changes).toHaveLength(2);
    await noteApprovalCard('answered', false, 'session-a', deps, 5_000);
    expect(approvalWaitingChats(5_000)).toEqual(['unrecorded']);
    expect(changes).toHaveLength(3);
    // A page that stopped reporting: the same freshness rule as the recovery hold, and one push
    // when it runs out, because no poll is left to cause one.
    expect(approvalWaitingChats(1_000 + APPROVAL_FRESH_MS - 1)).toEqual(['unrecorded']);
    expect(approvalWaitingChats(1_000 + APPROVAL_FRESH_MS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    expect(changes).toHaveLength(4);
  });

  it('pushes the list once the wait has gone stale, even when its timer fires a moment early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pushed: string[][] = [];
    const deps: ApprovalWaitDeps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined,
      changed: () => { pushed.push(approvalWaitingChats()); } };
    // The poll's clock reads 20 ms past the timer's start: the timer comes due 20 ms before the wait goes stale.
    await noteApprovalCard('chat', true, null, deps, 20);
    expect(pushed).toEqual([['chat']]);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    // Due, but the wait is still fresh: a push now would say waiting, with nothing left to push again.
    expect(approvalWaitingChats()).toEqual(['chat']);
    await vi.advanceTimersByTimeAsync(20);
    expect(approvalWaitingChats()).toEqual([]);
    expect(pushed.at(-1)).toEqual([]);
    expect(pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    expect(pushed).toHaveLength(2);
  });
});

// The maintainer asked to answer the card from the app (2026-10-14). The app relays a person's click,
// for the exact card it showed them; its own connectors' cards are answered by the block at the end.
describe('answering the card from the app', () => {
  let deps: ApprovalWaitDeps;
  const card = (id: string, allow = true) => ({ id, lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.'], allow });
  beforeEach(() => {
    resetApprovalWaits();
    deps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined };
  });

  it('shows the card the page reported and relays one answer for exactly that card', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1'));
    expect(approvalCardView('chat', 1_000)).toMatchObject({ id: 'c1', lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.'], allow: true, answer: null });
    expect(approvalAnswerFor('chat', 1_000)).toBeNull();
    const asked = requestApprovalAnswer('chat', 'c1', 'deny', 1_100);
    expect(asked).toMatchObject({ ok: true });
    const token = asked.ok ? asked.token : '';
    expect(approvalAnswerFor('chat', 1_200)).toEqual({ token, cardId: 'c1', choice: 'deny', words: { lines: expect.any(Array), data: null, cut: false, extra: [] } });
    // A second click while the first is on its way changes nothing.
    expect(requestApprovalAnswer('chat', 'c1', 'allow', 1_300)).toEqual({ ok: false, error: 'answer_pending' });
    expect(settleApprovalAnswer('chat', 'not-the-token', 'clicked')).toBe(false);
    expect(settleApprovalAnswer('chat', token, 'clicked')).toBe(true);
    expect(approvalAnswerFor('chat', 1_500)).toBeNull();
    expect(approvalCardView('chat', 1_500)?.answer).toMatchObject({ choice: 'deny', outcome: 'clicked' });
  });

  it('refuses a stale card, a missing card and Allow where ChatGPT itself disabled it', async () => {
    expect(requestApprovalAnswer('chat', 'c1', 'deny', 1_000)).toEqual({ ok: false, error: 'no_card' });
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1', false));
    expect(requestApprovalAnswer('chat', 'c1', 'allow', 1_100)).toEqual({ ok: false, error: 'allow_unavailable' });
    expect(requestApprovalAnswer('chat', 'old-card', 'deny', 1_100)).toEqual({ ok: false, error: 'card_changed' });
    expect(requestApprovalAnswer('chat', 'c1', 'always' as never, 1_100)).toEqual({ ok: false, error: 'bad_choice' });
  });

  it('drops an answer for a card that was replaced or one the page never took', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1'));
    const first = requestApprovalAnswer('chat', 'c1', 'allow', 1_100);
    expect(first.ok).toBe(true);
    // ChatGPT shows a different card: the answer for the old one must never reach it.
    await noteApprovalCard('chat', true, 'session', deps, 1_200, card('c2'));
    expect(approvalAnswerFor('chat', 1_200)).toBeNull();
    expect(approvalCardView('chat', 1_200)).toMatchObject({ id: 'c2', answer: null });
    const second = requestApprovalAnswer('chat', 'c2', 'deny', 1_300);
    expect(second.ok).toBe(true);
    expect(approvalAnswerFor('chat', 1_300 + APPROVAL_ANSWER_MS)).toBeNull();
    expect(approvalCardView('chat', 1_300 + APPROVAL_ANSWER_MS)?.answer).toMatchObject({ choice: 'deny', outcome: 'expired' });
  });
});

describe('the page detector', () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  let dom: JSDOM;
  let api: { approvalWaiting(): boolean; approvalCard(): null | { node: Element; lines: string[]; allow: boolean; cut: boolean; data: number; extra: string[] }; answerApprovalCard(node: Element, choice: string, expected?: unknown): string };
  type Found = NonNullable<ReturnType<typeof api.approvalCard>>;
  const wordsOf = (found: Found & { extra?: string[] }) => ({ lines: [...found.lines], data: found.data, cut: found.cut, extra: [...(found.extra ?? [])] });
  beforeEach(() => {
    dom = new JSDOM('<main></main>', { url: 'https://chatgpt.com/c/chat', runScripts: 'outside-only', pretendToBeVisual: true });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value(this: HTMLElement) { return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }]; }
    });
    dom.window.eval(source);
    api = (dom.window as unknown as { CLF_DOM: typeof api }).CLF_DOM;
  });
  afterEach(() => { dom.window.close(); vi.restoreAllMocks(); });

  // The live card's shape on 2026-10-06 (German UI), reduced to its structure.
  const card = (buttons = '<button>Ablehnen</button><button>Einmal zulassen</button>') =>
    `<div data-codex-approval-surface="true"><div role="alert"><p>ChatGPT erlauben, Chat On Steroids Core zu verwenden?</p></div>${buttons}</div>`;

  it('sees a waiting card in any language and nothing without one', () => {
    expect(api.approvalWaiting()).toBe(false);
    dom.window.document.querySelector('main')!.innerHTML = card();
    expect(api.approvalWaiting()).toBe(true);
  });

  // The live card's buttons on 2026-10-14 (German UI, Gmail): Deny carries an Esc key hint, Allow
  // once a Return hint, with a menu of further options beside it. No label is read.
  const liveCard = (allowDisabled = false) => `<div data-codex-approval-surface="true"><div role="alert" aria-atomic="true">
    <div><div><svg></svg><span>Gmail</span></div><div><div>ChatGPT erlauben, Gmail zu verwenden?</div>
    <div>Erstellt einen Entwurf. <button aria-haspopup="dialog">Details anzeigen</button></div></div></div></div>
    <div><div><button>Ablehnen<span><kbd>Esc</kbd></span></button>
    <div><button ${allowDisabled ? 'disabled' : ''}><span>Einmal zulassen</span><span><kbd>⏎</kbd></span></button><button aria-haspopup="menu" aria-label="Genehmigungsoptionen"></button></div></div></div></div>`;

  it('reads the card\'s words without its buttons, and whether Allow once can be pressed', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    expect(api.approvalCard()).toMatchObject({ lines: ['Gmail', 'ChatGPT erlauben, Gmail zu verwenden?', 'Erstellt einen Entwurf.'], allow: true });
    main.innerHTML = liveCard(true);
    expect(api.approvalCard()?.allow).toBe(false);
    main.innerHTML = '';
    expect(api.approvalCard()).toBeNull();
  });

  // Rows the live card may also produce: a term or value wrapped in its own div, two terms in a row,
  // a term and a value in different rows, and a value too long to share a line with its label.
  it('pairs a label only with the value of its own row, keeps wrapped parts together and never cuts a value', () => {
    const long = 'v'.repeat(290);
    dom.window.document.querySelector('main')!.innerHTML = `<div data-codex-approval-surface="true"><div role="alert"><dl>
      <div class="grid"><dt><div>Ordner</div></dt><dd><div>C:/demo</div></dd></div>
      <div class="grid"><dt>Schlüssel</dt><dd><div>Access</div><div>key</div></dd></div>
      <div class="grid"><dt>Erster</dt><dt>Zweiter</dt><dd>Wert</dd></div>
      <div class="grid"><dt>Allein</dt></div><div class="grid"><dd>Fremd</dd></div>
      <div class="grid"><dt>Beschreibung lang</dt><dd>${long}</dd></div></dl></div>
      <button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    expect(api.approvalCard()?.lines).toEqual(['Ordner: C:/demo', 'Schlüssel: Access key', 'Erster', 'Zweiter: Wert', 'Allein', 'Fremd', 'Beschreibung lang', long]);
  });

  // The live card on 2026-10-25 (German UI, a key-shaped value in the request) lists the shared data
  // as a <dl>: a label and its value in one grid row. Read as one block they ran together into
  // "Zugangsschlüsselsk-proj-…" in the app's copy of the card.
  it('keeps a shared-data label and its value apart', () => {
    dom.window.document.querySelector('main')!.innerHTML = `<div data-codex-approval-surface="true"><div role="alert">
      <div>ChatGPT erlauben, Chat On Steroids Core zu verwenden?</div><div>Zu den geteilten Daten gehören:</div>
      <dl class="@container"><div class="grid"><dt>Zugangsschlüssel</dt><dd><span class="min-w-0"><span>sk-proj-FAKE0123</span></span></dd></div>
      <div class="grid"><dt>Befehl</dt><dd><span>echo test</span></dd></div>
      <div class="grid"><dd>ohne Label</dd></div><div class="grid"><dt>Nur Label</dt></div></dl></div>
      <button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    expect(api.approvalCard()?.lines).toEqual(['ChatGPT erlauben, Chat On Steroids Core zu verwenden?', 'Zu den geteilten Daten gehören:',
      'Zugangsschlüssel: sk-proj-FAKE0123', 'Befehl: echo test', 'ohne Label', 'Nur Label']);
  });

  it('presses Deny or Allow once by their key hints, never the options menu, and only on that card', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    const clicks: string[] = [];
    for (const button of main.querySelectorAll('button')) button.addEventListener('click', () => clicks.push(button.textContent!.replace(/\s+/g, ' ').trim() || button.getAttribute('aria-label')!));
    const found = api.approvalCard()!;
    expect(api.answerApprovalCard(found.node, 'deny')).toBe('clicked');
    expect(api.answerApprovalCard(found.node, 'allow')).toBe('clicked');
    expect(clicks).toEqual(['AblehnenEsc', 'Einmal zulassen⏎']);
    expect(api.answerApprovalCard(found.node, 'always')).toBe('unavailable');
    main.innerHTML = liveCard(true);
    expect(api.answerApprovalCard(api.approvalCard()!.node, 'allow')).toBe('unavailable');
    // A card that is gone, or another one, is never answered by the old reference.
    const old = api.approvalCard()!.node;
    main.innerHTML = liveCard();
    expect(api.answerApprovalCard(old, 'deny')).toBe('card_changed');
  });

  // 2026-10-29: the app's decision was made on the words of one poll; ChatGPT may reuse the same element for another
  // request before the press. The words are read again right where the button is pressed.
  it('presses only while the card still says what the answer was given for, read again just before the press', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    const clicks: string[] = [];
    for (const button of main.querySelectorAll('button')) button.addEventListener('click', () => clicks.push(button.textContent!.replace(/\s+/g, ' ').trim()));
    const found = api.approvalCard()!;
    const said = wordsOf(found);
    const title = [...main.querySelectorAll('div')].find(div => div.textContent === 'ChatGPT erlauben, Gmail zu verwenden?')!;
    // The element is reused for a safety card between the decision and the press: nothing is pressed.
    title.textContent = 'Verdächtige Anweisung';
    expect(api.answerApprovalCard(found.node, 'allow', said)).toBe('card_changed');
    expect(api.answerApprovalCard(found.node, 'deny', said)).toBe('card_changed');
    expect(clicks).toEqual([]);
    // One later line reworded, one line added: the same.
    title.textContent = 'ChatGPT erlauben, Gmail zu verwenden?';
    const detail = [...main.querySelectorAll('div')].find(div => div.firstChild?.textContent === 'Erstellt einen Entwurf. ')!;
    detail.firstChild!.textContent = 'Löscht alle Entwürfe. ';
    expect(api.answerApprovalCard(found.node, 'allow', said)).toBe('card_changed');
    detail.firstChild!.textContent = 'Erstellt einen Entwurf. ';
    const extra = dom.window.document.createElement('p');
    extra.textContent = 'Zusätzliche Zeile';
    main.querySelector('[role="alert"]')!.append(extra);
    expect(api.answerApprovalCard(found.node, 'allow', said)).toBe('card_changed');
    extra.remove();
    expect(clicks).toEqual([]);
    // Words that cannot be compared are not a match: missing lines, a string, null, other lines.
    for (const expected of [[], 'ChatGPT erlauben, Gmail zu verwenden?', null, { ...said, lines: ['Gmail'] }, { ...said, lines: [...said.lines, 'x'] }, { ...said, lines: [1, 2, 3] }, { ...said, lines: undefined },
      { ...said, data: said.data - 1 }, { ...said, data: undefined }, { ...said, cut: true }, { ...said, extra: [...said.extra, 'Warning'] }, { ...said, extra: undefined }, 42]) {
      expect(api.answerApprovalCard(found.node, 'allow', expected), JSON.stringify(expected)).toBe('card_changed');
    }
    expect(clicks).toEqual([]);
    // The same words: pressed. An answer without words (an app from before) is judged by the element alone, as it was.
    expect(api.answerApprovalCard(found.node, 'allow', said)).toBe('clicked');
    expect(api.answerApprovalCard(found.node, 'deny')).toBe('clicked');
    expect(clicks).toEqual(['Einmal zulassen⏎', 'AblehnenEsc']);
  });

  it('does not press when the words cannot be read at the moment of the press', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    const found = api.approvalCard()!;
    // The card goes away and an identical one is drawn in a new element: the old reference is not pressed either.
    main.innerHTML = liveCard();
    expect(api.answerApprovalCard(found.node, 'allow', wordsOf(found))).toBe('card_changed');
    expect(api.answerApprovalCard(null as unknown as Element, 'allow', wordsOf(found))).toBe('card_changed');
  });

  it('says where the shared data starts and whether the card\'s own words were cut, so the app can judge the words only ChatGPT wrote', () => {
    const main = dom.window.document.querySelector('main')!;
    const wrap = (inner: string) => `<div data-codex-approval-surface="true"><div role="alert">${inner}</div><button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    main.innerHTML = wrap('<div>ChatGPT erlauben, Chat On Steroids Core zu verwenden?</div><div>Zu den geteilten Daten gehören:</div><dl><div><dt>Befehl</dt><dd>rg "Suspicious"</dd></div><div><dt>Ordner</dt><dd>C:/demo</dd></div></dl>');
    expect(api.approvalCard()).toMatchObject({
      lines: ['ChatGPT erlauben, Chat On Steroids Core zu verwenden?', 'Zu den geteilten Daten gehören:', 'Befehl: rg "Suspicious"', 'Ordner: C:/demo'], data: 2, cut: false, extra: []
    });
    // A data value equal to a heading is not that heading: a repeat is dropped only between lines of one kind.
    main.innerHTML = wrap('<div>Title?</div><dl><div><dd>Suspicious Instruction</dd></div></dl><h3>Suspicious Instruction</h3>');
    expect(api.approvalCard()).toMatchObject({ lines: ['Title?', 'Suspicious Instruction', 'Suspicious Instruction'], data: 3, cut: false });
    // No shared data: every line is the card's own.
    main.innerHTML = wrap('<div>Allow ChatGPT to use Chat On Steroids Core?</div><div>Runs a command.</div>');
    expect(api.approvalCard()).toMatchObject({ lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Runs a command.'], data: 2, cut: false });
    // A line of the card's own after the data leaves no clean split: all of it counts as the card's own.
    main.innerHTML = wrap('<div>Title?</div><dl><div><dt>Befehl</dt><dd>ls</dd></div></dl><div>Suspicious Instruction</div>');
    expect(api.approvalCard()).toMatchObject({ lines: ['Title?', 'Befehl: ls', 'Suspicious Instruction'], data: 3, cut: false });
    // More than eight lines of the card's own: words were left out. Shared data past the eighth line is not "words left out".
    main.innerHTML = wrap(Array.from({ length: 10 }, (_, index) => `<div>Line ${index + 1}</div>`).join(''));
    expect(api.approvalCard()).toMatchObject({ data: 8, cut: true });
    expect(api.approvalCard()!.lines).toHaveLength(8);
    main.innerHTML = wrap('<div>Title?</div><dl>' + Array.from({ length: 12 }, (_, index) => `<div><dt>K${index}</dt><dd>v${index}</dd></div>`).join('') + '</dl>');
    expect(api.approvalCard()).toMatchObject({ data: 1, cut: false });
    expect(api.approvalCard()!.lines).toHaveLength(8);
  });

  // A warning drawn as a fold-out button, an icon caption, a hidden part or a label is dropped from the card's lines
  // (the buttons and icons are not its words), so the page reports the dropped texts for the app to read too.
  it('reads the texts it drops, so a warning drawn as a button, an icon caption, a hidden part or a label is still seen', () => {
    const main = dom.window.document.querySelector('main')!;
    const wrap = (inner: string, outside = '') => `<div data-codex-approval-surface="true"><div role="alert">${inner}</div>${outside}<button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    const title = '<div>Allow ChatGPT to use Chat On Steroids Core?</div>';
    main.innerHTML = wrap(title);
    // Deny, Allow once and the options menu are on every request and are not reported.
    expect(api.approvalCard()).toMatchObject({ lines: ['Allow ChatGPT to use Chat On Steroids Core?'], extra: [], cut: false });
    main.innerHTML = wrap(title, '<button aria-haspopup="menu" aria-label="Approval options"></button>');
    expect(api.approvalCard()).toMatchObject({ extra: [], cut: false });
    const seen = (inner: string, outside = '') => { main.innerHTML = wrap(inner, outside); return api.approvalCard()!; };
    // The title stays the only line; the warning is in `extra`.
    for (const [name, found, text] of [
      ['a fold-out button', seen(title, '<button>Suspicious Instruction</button>'), 'Suspicious Instruction'],
      ['an aria-hidden caption', seen(title + '<span aria-hidden="true">Instrucción sospechosa</span>'), 'Instrucción sospechosa'],
      ['an icon title', seen(title + '<svg><title>Verdächtige Anweisung</title></svg>'), 'Verdächtige Anweisung'],
      ['an aria-label', seen(title + '<div aria-label="Warning"><span>x</span></div>'), 'Warning'],
      ['a title attribute', seen(title + '<span title="Unsafe instruction">x</span>'), 'Unsafe instruction'],
      ['an image description', seen(title + '<img alt="Suspicious Instruction">'), 'Suspicious Instruction'],
      ['a fold-out dialog button', seen(title, '<button aria-haspopup="dialog">Show details</button>'), 'Show details']
    ] as const) {
      expect(found.extra, name).toContain(text);
      expect(found.lines.some(line => line.includes(text)), name).toBe(false);
    }
    // Labels and tooltips inside the shared data are the model's: not reported, and not "words left out".
    const longTip = 'T'.repeat(200);
    expect(seen(title + '<dl><div><dt title="' + longTip + '">K</dt><dd title="' + longTip + '" aria-label="' + longTip + '">v</dd></div></dl>')).toMatchObject({ extra: [], cut: false });
    // More dropped texts than fit, or one that is too long to carry whole: words were left out.
    const many = Array.from({ length: 9 }, (_, index) => `<button>Option ${index}</button>`).join('');
    expect(seen(title, many).cut).toBe(true);
    expect(seen(title, `<button>${'w'.repeat(101)}</button>`).cut).toBe(true);
    expect(seen(title, `<button>${'w'.repeat(100)}</button>`).cut).toBe(false);
    // A line of the card's own over 300 characters is cut; a data value that long is not "words left out".
    expect(seen(`<div>${'x'.repeat(301)}</div>`).cut).toBe(true);
    expect(seen(title + `<dl><div><dt>K</dt><dd>${'v'.repeat(400)}</dd></div></dl>`).cut).toBe(false);
  });

  // The app reads the lines back from the page's report, trims and cuts them again, and gives them to the page with
  // the answer: a line the two sides read differently could never be pressed (a person's Deny included).
  it('reads the same words back after the app has normalised them, at the 300-character cut and at a split emoji', () => {
    const main = dom.window.document.querySelector('main')!;
    const wrap = (inner: string) => `<div data-codex-approval-surface="true"><div role="alert">${inner}</div><button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    const cases = [
      '<div>Title?</div><dl><div><dt>K</dt><dd>' + 'x'.repeat(299) + ' tail</dd></div></dl>',
      '<div>Title?</div><dl><div><dt>K</dt><dd>' + 'x'.repeat(299) + String.fromCodePoint(0x1F600) + ' tail</dd></div></dl>',
      '<div>Title?</div><dl><div><dt>' + 'k'.repeat(299) + ' </dt><dd>v</dd></div></dl>',
      '<div>' + 'y'.repeat(299) + ' tail</div>',
      '<div>Title?</div><div>' + 'z'.repeat(298) + String.fromCharCode(0xA0, 0xA0) + 'x</div>'
    ];
    for (const html of cases) {
      main.innerHTML = wrap(html);
      const found = api.approvalCard()!;
      expect(found.lines.every(line => line.length <= 300 && line === line.trim()), html.slice(0, 40)).toBe(true);
      // What the app holds after reading the report, and what it hands back with the answer.
      const facts = parseApprovalCard(JSON.stringify({ id: 'card-12345678', lines: found.lines, allow: true, data: found.data, cut: found.cut, extra: found.extra, recheck: true }))!;
      expect(facts.lines, html.slice(0, 40)).toEqual(found.lines);
      const words = { lines: facts.lines, data: facts.data ?? null, cut: facts.cut === true, extra: facts.extra ?? [] };
      expect(api.answerApprovalCard(found.node, 'allow', words), html.slice(0, 40)).toBe('clicked');
    }
  });

  it('ignores an answered card, a hidden one and one on a kept page', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = card('<button disabled>Ablehnen</button><button disabled>Einmal zulassen</button>');
    expect(api.approvalWaiting()).toBe(false);
    main.innerHTML = `<div hidden>${card()}</div>`;
    expect(api.approvalWaiting()).toBe(false);
    main.innerHTML = `<div data-app-shell-page-surface style="display:none">${card()}</div>`;
    expect(api.approvalWaiting()).toBe(false);
  });
});

// 2026-10-29: ChatGPT asked "Allow ChatGPT to use Chat On Steroids Core?" again in every new chat and after
// each page reload, although Always allow was chosen, and a Pro run waited half an hour for a click. The app
// now presses Allow once on cards that name its own connectors, and on nothing else.
describe('answering its own connector cards automatically', () => {
  const CORE = 'Chat On Steroids Core';
  let log: string[];
  let deps: ApprovalWaitDeps & { rows: Array<[string, string, string, unknown]>; notices: string[] };
  const card = (id: string, lines: string[], allow = true): ApprovalCardFacts => ({ id, lines, allow, recheck: true });
  // The shape of a plain request: the title, the line introducing the shared data, the data rows the page marks.
  const ours = (id = 'c1', allow = true): ApprovalCardFacts => ({ ...card(id, ['¿Permitir que ChatGPT use Chat On Steroids Core?', 'Los datos compartidos incluyen:', 'Comando: ls'], allow), data: 2 });
  const answered = (chat: string, now: number) => approvalAnswerFor(chat, now);
  const autoAnswers = () => log.filter(line => line.includes('auto-allowed'));
  beforeEach(() => {
    resetApprovalWaits();
    log = [];
    const rows: Array<[string, string, string, unknown]> = [], notices: string[] = [];
    deps = {
      rows, notices,
      record: async (sessionId, progressId, text, anchor) => { rows.push([sessionId, progressId, text, anchor]); return anchor ?? { seq: 1, time: 1 }; },
      notify: sessionId => { notices.push(sessionId); },
      log: message => { log.push(message); },
      ownConnectors: () => [CORE, 'Chat On Steroids Desktop']
    };
  });

  it('files Allow once for the card, once, and logs what the card said', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours());
    const answer = answered('chat', 1_100);
    expect(answer).toMatchObject({ cardId: 'c1', choice: 'allow' });
    expect(autoAnswers()).toEqual(['bridge: chat tool approval card for Chat On Steroids Core auto-allowed (Allow once): ¿Permitir que ChatGPT use Chat On Steroids Core? | Los datos compartidos incluyen:']);
    // The page reports the press; the card standing for more polls is not answered again.
    expect(settleApprovalAnswer('chat', answer!.token, 'clicked')).toBe(true);
    await noteApprovalCard('chat', true, 'session', deps, 3_000, ours());
    await noteApprovalCard('chat', true, 'session', deps, 5_000, ours());
    expect(answered('chat', 5_000)).toBeNull();
    expect(autoAnswers()).toHaveLength(1);
    // The next card of the same chat is a new request and is answered too.
    await noteApprovalCard('chat', false, 'session', deps, 6_000);
    await noteApprovalCard('chat', true, 'session', deps, 6_000 + APPROVAL_GONE_MS, ours('c2'));
    expect(answered('chat', 6_000 + APPROVAL_GONE_MS)).toMatchObject({ cardId: 'c2', choice: 'allow' });
  });

  it('answers a card with the app header first, and each of this install\'s connectors, in any language', async () => {
    const titles: Array<[string[], string]> = [
      [['Chat On Steroids Core', 'ChatGPT erlauben, Chat On Steroids Core zu verwenden?'], 'Chat On Steroids Core'],
      [['ChatGPTに Chat On Steroids Desktopの使用を許可しますか？'], 'Chat On Steroids Desktop'],
      [['Autoriser ChatGPT à utiliser Chat On Steroids Core ?'], 'Chat On Steroids Core'],
      [['ChatGPT가 Chat On Steroids Core을(를) 사용하도록 허용하시겠습니까?'], 'Chat On Steroids Core'],
      [['是否允许 ChatGPT 使用 Chat On Steroids Core？'], 'Chat On Steroids Core'],
      [['ChatGPT\'nin Chat On Steroids Core kullanmasına izin verilsin mi?'], 'Chat On Steroids Core'],
      [['ChatGPT\'nin Chat On Steroids Core uygulamasını kullanmasına izin vermek istiyor musunuz?'], 'Chat On Steroids Core'],
      // CJK titles are written without spaces around Latin words, and may quote the name.
      [['是否允许ChatGPT使用Chat On Steroids Core？'], 'Chat On Steroids Core'],
      [['ChatGPTにChat On Steroids Coreの使用を許可しますか？'], 'Chat On Steroids Core'],
      [['ChatGPTに「Chat On Steroids Core」の使用を許可しますか？'], 'Chat On Steroids Core'],
      [['ChatGPT가 Chat On Steroids Core(을)를 사용하도록 허용하시겠습니까?'], 'Chat On Steroids Core'],
      [['Разрешить ChatGPT использовать «Chat On Steroids Core»?'], 'Chat On Steroids Core']
    ];
    for (const [lines, name] of titles) {
      expect(cardNamedConnector(lines, [CORE, 'Chat On Steroids Desktop']), lines[0]).toBe(name);
      resetApprovalWaits();
      await noteApprovalCard('chat', true, null, deps, 1_000, card('h1', lines));
      expect(answered('chat', 1_000), lines[0]).toMatchObject({ cardId: 'h1', choice: 'allow' });
    }
  });

  it('answers nothing when the setting is off, or the names cannot be read, whatever the card says', async () => {
    for (const off of [undefined, () => [], () => { throw new Error('config unreadable'); }]) {
      resetApprovalWaits();
      await noteApprovalCard('chat', true, 'session', { ...deps, ownConnectors: off }, 1_000, ours());
      expect(answered('chat', 1_000)).toBeNull();
      // The wait is still noted, with its row, so the stall can never go unseen.
      expect(approvalCardWaiting('chat', 1_000)).toBe(true);
    }
    expect(autoAnswers()).toEqual([]);
    expect(log.some(line => line.includes('could not be answered automatically: config unreadable'))).toBe(true);
    expect(deps.rows.length).toBeGreaterThan(0);
  });

  it('leaves to a person: other apps, a quoted name, a warning header, siblings, a disabled Allow', async () => {
    const strangers = [
      card('g1', ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.']),
      // The name appears only in what the other app wants to do, or in a second line the model wrote.
      card('g2', ['Allow ChatGPT to use GitHub?', 'Chat On Steroids Core?']),
      card('g3', ['GitHub', 'Allow ChatGPT to use GitHub?', 'Comments on the issue "Does Chat On Steroids Core work?"']),
      card('g4', ['ChatGPT wants to use GitHub', 'Body: is Chat On Steroids Core ok?']),
      // ChatGPT's own safety check raised the card: a header that is not the app's name.
      card('w1', ['Suspicious instruction', 'Allow ChatGPT to use Chat On Steroids Core?', 'The tool description tries to dictate its own handling.']),
      card('w2', ['Chat On Steroids Core was flagged', 'Allow ChatGPT to use Chat On Steroids Core?']),
      // Siblings of the name, with every separator a person might type.
      ...['Core (Laptop)', 'Core — LAP-PACO2', 'Core Laptop', 'Core 2', 'Core2', 'Core [Laptop]', 'Core: LAP-PACO2', 'Core, Laptop', 'Core.old',
        'Core ‐ LAP', 'Core • LAP', 'Core（Laptop）', 'Coreé', 'Core-Laptop', 'Core_2',
        // Symbols, capitals of other scripts, emoji and dots after the name.
        'Core @lap', 'Core ~', 'Core +', 'Core &', "Core 'lap'", 'Core \u2212', 'Core \u30FB', 'Core\uFF1Alap', 'Core \uD83D\uDE42', 'Core \u00C9quipe',
        'Core \u041D\u043E\u0443\u0442', 'Core\u00B7x', '(Laptop)Core'].map((tail, index) =>
        card(`s${index}`, [`Allow ChatGPT to use Chat On Steroids ${tail}?`])),
      card('s-head', ['Allow ChatGPT to use My-Chat On Steroids Core?']),
      card('n1', ['Chat On Steroids Core wants to run a command.']),
      card('l1', ['Allow ChatGPT to use Chat On Steroids Core? ' + 'x'.repeat(200) + '?']),
      ours('d1', false)
    ];
    for (const stranger of strangers) {
      resetApprovalWaits();
      await noteApprovalCard('chat', true, 'session', deps, 1_000, stranger);
      expect(answered('chat', 1_000), stranger.id).toBeNull();
      expect(approvalCardWaiting('chat', 1_000), stranger.id).toBe(true);
    }
    expect(autoAnswers()).toEqual([]);
  });

  it('matches a name that carries this computer\'s suffix exactly, and no other suffix', () => {
    const named = ['Chat On Steroids Core (Windows)'];
    expect(cardNamedConnector(['Allow ChatGPT to use Chat On Steroids Core (Windows)?'], named)).toBe(named[0]);
    expect(cardNamedConnector(['Allow ChatGPT to use Chat On Steroids Core?'], named)).toBeNull();
    expect(cardNamedConnector(['Allow ChatGPT to use Chat On Steroids Core (Mac)?'], named)).toBeNull();
    expect(cardNamedConnector(['Allow ChatGPT to use Chat On Steroids Core (Windows) (2)?'], named)).toBeNull();
    expect(cardNamedConnector([], named)).toBeNull();
  });

  it('treats other words under the same card element as a new request, and drops the old answer', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours('same'));
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'same' });
    // ChatGPT reuses the element for a request about something else: the old answer must not ride along.
    await noteApprovalCard('chat', true, 'session', deps, 1_500, card('same', ['Allow ChatGPT to use Gmail?', 'Sends an email.']));
    expect(answered('chat', 1_500)).toBeNull();
    expect(autoAnswers()).toHaveLength(1);
  });

  it('keeps a run of answered cards apart: no merged episode, no row, no "needs you" notice', async () => {
    // Each card is answered and the model's next call, with the same words, comes after the redraw window.
    let at = 1_000;
    for (let index = 0; index < 12; index++) {
      await noteApprovalCard('chat', true, 'session', deps, at, ours(`run-${index}`));
      const answer = answered('chat', at)!;
      expect(answer.cardId).toBe(`run-${index}`);
      settleApprovalAnswer('chat', answer.token, 'clicked');
      at += 1_500;
      await noteApprovalCard('chat', false, 'session', deps, at);
      at += APPROVAL_GONE_MS + 1_000;
    }
    expect(autoAnswers()).toHaveLength(12);
    expect(deps.notices).toEqual([]);
    expect(deps.rows).toEqual([]);
    expect(log.some(line => line.includes('redrawn, not answered'))).toBe(false);
  });

  it('stops after a few answers when a card keeps coming back, and the person is told after the usual grace', async () => {
    // The page reports the press, ChatGPT draws the same card again at once, and again: a loop, not a run of calls.
    let at = 1_000;
    for (let index = 0; index < 40; index++) {
      await noteApprovalCard('chat', true, 'session', deps, at, ours(`loop-${index}`));
      const answer = answered('chat', at);
      if (answer) settleApprovalAnswer('chat', answer.token, 'clicked');
      at += 500;
      await noteApprovalCard('chat', false, 'session', deps, at);
      at += 500;
    }
    expect(autoAnswers()).toHaveLength(AUTO_ANSWERS_PER_EPISODE);
    expect(log.some(line => line.includes('came back'))).toBe(true);
    // 30 s after the first card the row and the notice came, as for any card nobody answers.
    expect(deps.notices).toEqual(['session']);
    expect(deps.rows.some(row => row[2] === APPROVAL_WAITING_TEXT)).toBe(true);
  });

  it('does not override a person\'s Deny in the app: no automatic answer in that chat for a while', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours('first'));
    const auto = answered('chat', 1_000)!;
    // The automatic press did not take; the person reads the card and presses Deny in the app.
    expect(settleApprovalAnswer('chat', auto.token, 'unavailable')).toBe(true);
    const denial = requestApprovalAnswer('chat', 'first', 'deny', 2_000);
    expect(denial.ok).toBe(true);
    if (denial.ok) settleApprovalAnswer('chat', denial.token, 'clicked');
    await noteApprovalCard('chat', false, 'session', deps, 3_000);
    // The model sends the same call again at once: it stays for the person.
    await noteApprovalCard('chat', true, 'session', deps, 3_000 + APPROVAL_GONE_MS, ours('retry'));
    expect(answered('chat', 3_000 + APPROVAL_GONE_MS)).toBeNull();
    expect(log.some(line => line.includes('pressed Deny in the app'))).toBe(true);
    // Another chat is not affected, and this one is answered again once the pause is over.
    await noteApprovalCard('other', true, null, deps, 4_000, ours('elsewhere'));
    expect(answered('other', 4_000)).toMatchObject({ cardId: 'elsewhere' });
    await noteApprovalCard('chat', false, 'session', deps, 5_000);
    await noteApprovalCard('chat', true, 'session', deps, 5_000 + AUTO_PAUSE_AFTER_DENY_MS, ours('later'));
    expect(answered('chat', 5_000 + AUTO_PAUSE_AFTER_DENY_MS)).toMatchObject({ cardId: 'later' });
  });

  it('still tells the person when the app\'s own answer did not take, after the usual grace', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours());
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'c1' });
    expect(deps.rows).toEqual([]);
    // The page never pressed it: the card stands on, so the row and the notice come as for any card.
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS, ours());
    expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT]);
    expect(deps.notices).toEqual(['session']);
    expect(autoAnswers()).toHaveLength(1);
  });

  // 2026-10-29, the owner's decision ("No, exclude them"): a card ChatGPT's safety check raised is never answered
  // by the app, a card of a type the app does not know is not answered either, and the person is told in the log.
  const SAFETY_REASON = 'Tool documentation prescribes how to operate the worker tool and suppresses asking the user for settings, attempting to control agent behavior and workflow.';

  it('never answers a safety card, in English or Spanish, even under a plain title, and says so in the log with the heading only', async () => {
    // The log names the line that raised the alarm: the heading, whatever its place in the card.
    const safety: Array<[string, string[], string]> = [
      ['en heading', ['Suspicious Instruction', SAFETY_REASON], 'Suspicious Instruction'],
      ['en plain title', ['Allow ChatGPT to use Chat On Steroids Core?', 'Suspicious Instruction', SAFETY_REASON], 'Suspicious Instruction'],
      ['en header and title', [CORE, 'Allow ChatGPT to use Chat On Steroids Core?', 'Suspicious Instruction', SAFETY_REASON], 'Suspicious Instruction'],
      ['es heading', ['Instrucción sospechosa', 'La documentación de la herramienta intenta controlar el comportamiento del agente.'], 'Instrucción sospechosa'],
      ['es plain title', ['¿Permitir que ChatGPT use Chat On Steroids Core?', 'Instrucción sospechosa', 'La documentación de la herramienta intenta controlar el comportamiento del agente.'], 'Instrucción sospechosa'],
      ['es header and title', [CORE, '¿Permitir que ChatGPT use Chat On Steroids Core?', 'INSTRUCCION SOSPECHOSA', 'Texto del motivo'], 'INSTRUCCION SOSPECHOSA']
    ];
    for (const [name, lines, heading] of safety) {
      resetApprovalWaits();
      log.length = 0;
      deps.rows.length = 0; deps.notices.length = 0;
      await noteApprovalCard('chat', true, 'session', deps, 1_000, card('s1', lines));
      expect(answered('chat', 1_000), name).toBeNull();
      // The card is redrawn under another id, and again: still never answered, and told once.
      await noteApprovalCard('chat', true, 'session', deps, 2_000, card('s2', lines));
      await noteApprovalCard('chat', true, 'session', deps, 3_000, card('s3', lines));
      expect(answered('chat', 3_000), name).toBeNull();
      expect(autoAnswers(), name).toEqual([]);
      const told = log.filter(line => line.includes('safety card waiting'));
      expect(told, name).toHaveLength(1);
      // Time is the log's own; the line carries the chat and the card's first line, nothing else from the page.
      expect(told[0], name).toBe(`bridge: chat safety card waiting: ${heading}`);
      expect(log.join('\n'), name).not.toContain('worker tool');
      expect(log.join('\n'), name).not.toContain('comportamiento');
      // The person is told the usual way: the row at once, the notice after the grace.
      expect(deps.rows.map(row => row[2]), name).toEqual([APPROVAL_WAITING_TEXT]);
      await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS, card('s3', lines));
      expect(deps.notices, name).toEqual(['session']);
    }
  });

  it('does not answer a safety card while the setting is off either, and still reports it', async () => {
    await noteApprovalCard('chat', true, 'session', { ...deps, ownConnectors: () => [] }, 1_000, card('s1', ['Allow ChatGPT to use Chat On Steroids Core?', 'Suspicious Instruction']));
    expect(answered('chat', 1_000)).toBeNull();
    expect(log.filter(line => line.includes('safety card waiting'))).toHaveLength(1);
  });

  it('a safety card does not take the permission card after it with it: the next plain card is answered, the flagged one never', async () => {
    const flagged = card('f1', ['Allow ChatGPT to use Chat On Steroids Core?', 'Suspicious Instruction']);
    await noteApprovalCard('chat', true, 'session', deps, 1_000, flagged);
    expect(answered('chat', 1_000)).toBeNull();
    await noteApprovalCard('chat', false, 'session', deps, 2_000);
    await noteApprovalCard('chat', true, 'session', deps, 2_000 + APPROVAL_GONE_MS, ours('plain'));
    expect(answered('chat', 2_000 + APPROVAL_GONE_MS)).toMatchObject({ cardId: 'plain', choice: 'allow' });
  });

  it('a card reworded into a safety card in the same element is not answered, and the earlier answer is dropped', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours('same'));
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'same' });
    await noteApprovalCard('chat', true, 'session', deps, 1_500, card('same', ['Allow ChatGPT to use Chat On Steroids Core?', 'Suspicious Instruction']));
    expect(answered('chat', 1_500)).toBeNull();
    expect(log.some(line => line.includes('safety card waiting'))).toBe(true);
  });

  it('presses a permission request once, and the answer carries the words it was judged on', async () => {
    const lines = ['¿Permitir que ChatGPT use Chat On Steroids Core?', 'Los datos compartidos incluyen:', 'Comando: ls'];
    await noteApprovalCard('chat', true, 'session', deps, 1_000, { ...card('p1', lines), data: 2 });
    const answer = answered('chat', 1_000);
    expect(answer).toMatchObject({ cardId: 'p1', choice: 'allow', words: { lines, data: 2, cut: false, extra: [] } });
    expect(autoAnswers()).toHaveLength(1);
    expect(log.some(line => line.includes('safety card waiting'))).toBe(false);
    settleApprovalAnswer('chat', answer!.token, 'clicked');
    await noteApprovalCard('chat', true, 'session', deps, 3_000, { ...card('p1', lines), data: 2 });
    expect(answered('chat', 3_000)).toBeNull();
    expect(autoAnswers()).toHaveLength(1);
  });

  it('does not press a card of an unknown type, and reports one that mentions this app', async () => {
    const unknown: Array<[string, ApprovalCardFacts]> = [
      ['no ChatGPT in front of the name', card('u1', ['Allow Chat On Steroids Core?'])],
      ['a heading that is not the app', card('u2', ['Review needed', 'Allow ChatGPT to use Chat On Steroids Core?'])],
      ['a title that is not a question', card('u3', ['ChatGPT wants to use Chat On Steroids Core'])],
      ['words the page left out', { ...ours('u4'), cut: true }],
      ['another sentence in front of the name', card('u5', ['Heads up. ChatGPT wants to use Chat On Steroids Core?'])]
    ];
    for (const [name, unknownCard] of unknown) {
      resetApprovalWaits();
      log.length = 0;
      await noteApprovalCard('chat', true, 'session', deps, 1_000, unknownCard);
      expect(answered('chat', 1_000), name).toBeNull();
      expect(autoAnswers(), name).toEqual([]);
      expect(log.filter(line => line.includes('safety card waiting (not recognised')), name).toHaveLength(1);
      expect(approvalCardWaiting('chat', 1_000), name).toBe(true);
    }
  });

  it('does not press a card from a page that cannot re-check the card, and says what to do', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, { ...ours('old'), recheck: false });
    await noteApprovalCard('chat', true, 'session', deps, 1_500, { ...ours('old2'), recheck: undefined });
    expect(answered('chat', 1_500)).toBeNull();
    expect(autoAnswers()).toEqual([]);
    expect(log.filter(line => line.includes('does not re-check the card before pressing'))).toHaveLength(2);
  });

  it('a word that only the shared data carries does not hold back a permission request, as the page counts the data', async () => {
    const lines = ['Allow ChatGPT to use Chat On Steroids Core?', 'The shared data includes:', 'Command: rg "Suspicious Instruction" docs'];
    await noteApprovalCard('chat', true, 'session', deps, 1_000, { ...card('d1', lines), data: 2 });
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'd1', choice: 'allow' });
    // Without the page's data marker the same words are the card's own, and it is left to a person.
    resetApprovalWaits();
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('d2', lines));
    expect(answered('chat', 1_000)).toBeNull();
  });

  it('reads the page\'s report: the re-check flag, the cut flag and where the data starts, and nothing else', () => {
    const base = { id: 'card-12345678', lines: ['a', 'b', 'c'], allow: true };
    expect(parseApprovalCard(JSON.stringify(base))).toEqual({ ...base, cut: false, recheck: false, extra: [] });
    expect(parseApprovalCard(JSON.stringify({ ...base, recheck: true, cut: true, data: 2, extra: ['Deny', 4, ' Allow once '] }))).toEqual({ ...base, recheck: true, cut: true, data: 2, extra: ['Deny', 'Allow once'] });
    // Only a real `true` counts, and a data index must be a whole number inside the lines.
    expect(parseApprovalCard(JSON.stringify({ ...base, recheck: 'yes', cut: 1 }))).toEqual({ ...base, cut: false, recheck: false, extra: [] });
    for (const data of [-1, 1.5, 4, 'x', null]) expect(parseApprovalCard(JSON.stringify({ ...base, data }))).toEqual({ ...base, cut: false, recheck: false, extra: [] });
  });

  it('logs only the card\'s own first lines when it answers: a key or a path in the shared data stays out of the log', async () => {
    const lines = ['Allow ChatGPT to use Chat On Steroids Core?', 'The shared data includes:', 'Access key: sk-proj-FAKE0123', 'Folder: C:/Users/someone/secret'];
    await noteApprovalCard('chat', true, 'session', deps, 1_000, { ...card('k1', lines), data: 2 });
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'k1' });
    expect(autoAnswers()).toEqual(['bridge: chat tool approval card for Chat On Steroids Core auto-allowed (Allow once): Allow ChatGPT to use Chat On Steroids Core? | The shared data includes:']);
    expect(log.join('\n')).not.toContain('sk-proj');
    expect(log.join('\n')).not.toContain('someone');
    // A card with no line between the title and the data rows: the first data row is not the card's second line.
    log.length = 0;
    await noteApprovalCard('other', true, 'session', deps, 1_000, { ...card('k2', [lines[0]!, lines[2]!, lines[3]!]), data: 1 });
    expect(autoAnswers()).toEqual(['bridge: other tool approval card for Chat On Steroids Core auto-allowed (Allow once): Allow ChatGPT to use Chat On Steroids Core?']);
    expect(log.join('\n')).not.toContain('sk-proj');
  });

  it('a card whose shape is not known says so in the log in numbers, without its words', async () => {
    const lines = ['Allow ChatGPT to use Chat On Steroids Core?', 'Instrucció sospitosa', 'Una frase que descriu el motiu.'];
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1', lines));
    expect(answered('chat', 1_000)).toBeNull();
    expect(log.filter(line => line.includes('safety card waiting'))).toEqual([
      'bridge: chat safety card waiting (not recognised as a plain permission request: 3 own lines, 0 data lines): Allow ChatGPT to use Chat On Steroids Core?'
    ]);
    expect(log.join('\n')).not.toContain('sospitosa');
    expect(log.join('\n')).not.toContain('motiu');
  });

  it('a person\'s Deny holds for the whole episode, not only ten minutes: a card redrawn later in it is never answered by the app', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, ours('first'));
    const auto = answered('chat', 1_000)!;
    expect(settleApprovalAnswer('chat', auto.token, 'unavailable')).toBe(true);
    const denial = requestApprovalAnswer('chat', 'first', 'deny', 2_000);
    expect(denial.ok).toBe(true);
    if (denial.ok) settleApprovalAnswer('chat', denial.token, 'card_changed');
    // The Deny did not take, the card stands, and ChatGPT draws it again under another id long after the pause: still the person's.
    const later = 2_000 + AUTO_PAUSE_AFTER_DENY_MS + 60_000;
    for (let at = 3_000; at < later; at += 60_000) await noteApprovalCard('chat', true, 'session', deps, at, ours('first'));
    await noteApprovalCard('chat', true, 'session', deps, later, ours('redrawn'));
    expect(answered('chat', later)).toBeNull();
    expect(log.some(line => line.includes('pressed Deny in the app'))).toBe(true);
  });

  it('a card that changes only in what the page cut or where it puts the data is a new request, answered afresh or not at all', async () => {
    const lines = ['Allow ChatGPT to use Chat On Steroids Core?', 'The shared data includes:', 'Command: ls'];
    await noteApprovalCard('chat', true, 'session', deps, 1_000, { ...card('same', lines), data: 2 });
    expect(answered('chat', 1_000)).toMatchObject({ cardId: 'same' });
    // Same element, same lines; the page now says words were cut: the earlier answer is dropped and the card is judged again.
    await noteApprovalCard('chat', true, 'session', deps, 1_500, { ...card('same', lines), data: 2, cut: true });
    expect(answered('chat', 1_500)).toBeNull();
    expect(log.some(line => line.includes('safety card waiting (not recognised'))).toBe(true);
    // The same for a changed data index, and for a changed dropped text (a warning drawn as a button).
    await noteApprovalCard('chat', true, 'session', deps, 2_000, { ...card('same', lines), data: 1 });
    expect(answered('chat', 2_000)).toMatchObject({ cardId: 'same', words: { data: 1, cut: false } });
    await noteApprovalCard('chat', true, 'session', deps, 2_500, { ...card('same', lines), data: 2, extra: ['Suspicious Instruction'] });
    expect(answered('chat', 2_500)).toBeNull();
    expect(log.filter(line => line.includes('safety card waiting: Suspicious Instruction'))).toHaveLength(1);
  });
});
