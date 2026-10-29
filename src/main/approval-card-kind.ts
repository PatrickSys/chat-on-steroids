/**
 * Which kind of card ChatGPT's tool approval card is, from the words the page reports (2026-10-29).
 *
 * The app answers a card by itself only when it positively recognises a plain permission request for
 * one of this install's own connectors. Everything else is left to a person and fails closed: a card
 * that is not recognised is not pressed, however ordinary its title looks.
 *
 *  - `own`: a permission request ("Allow ChatGPT to use <this app's connector>?") of one exact shape: the
 *    app's name as a header (optional), the title, and at most one line introducing the shared data, with
 *    no safety or warning word anywhere in the card's own words or in its buttons and labels.
 *  - `safety`: ChatGPT's safety check raised the card ("Suspicious Instruction" and its translations), or
 *    the card carries warning words. Never answered by the app; the person is told (`approval-wait.ts`).
 *  - `other`: anything else: another app's request, a card of a shape this file does not know (a line
 *    below the title that is not an introduction of the shared data may be a warning in a language the
 *    word lists lack), a card whose words were cut off. `namesThisApp` says the card mentions one of
 *    this install's connectors without being recognised, which may be a safety card.
 *
 * The page marks where the shared-data rows start (the `<dl>` of argument names and values, written by the
 * model and by whatever it read): a word there says nothing about the card, so `rg "suspicious"` in a
 * command does not make a normal card look like a warning. The page also reports the texts it drops when
 * it reads the words (buttons, labels, hidden parts), `extra`, so a warning drawn there is still read.
 */

/** Question marks that end a card title: Latin, full-width and Arabic. */
const QUESTION_END = /[?？؟]$/u;
/** A colon that ends the line introducing the shared data: Latin and full-width. */
const INTRO_END = /[:：]$/u;
/** The introduction of the shared data is one short line. */
const INTRO_MAX = 120;

/**
 * What may follow the name before the question mark: lowercase letters, other scripts' letters and marks
 * (German "zu verwenden", Turkish, Japanese and Korean particles), spaces and parentheses. A capital, digit,
 * symbol, emoji or punctuation there means a longer or different name ("Core 2", "Core Laptop", "Core @lap").
 * Known gaps: a lowercase word or a CJK suffix after the name still reads as part of the sentence.
 */
const PLAIN_AFTER = /^[\s\p{Ll}\p{Lo}\p{M}()（）]{0,60}$/u;
/**
 * A bracket right after the name that opens a letter or digit is a suffix ("Core (Laptop)", "Core (ноутбук)",
 * "Core (笔记本)", "Core (회사)"): this app writes a space before the bracket, and a bracket after a space is always a
 * suffix. Korean particles in brackets are not ("Core(을)를", "Core(으)로"): they attach with no space, one or two
 * Hangul syllables.
 */
const SUFFIX_OPENING = /^\s+[([{<（［｛〈-【]|^[([{<（［｛〈-【]\s*(?:(?![\p{Script=Hangul}])[\p{L}\p{N}]|[\p{Script=Hangul}]{3})/u;
/** A quote that closes right after the name belongs to the sentence ("「Chat On Steroids Core」の..."). */
const CLOSING_QUOTE = /^["»’”」』]/u;
/**
 * What may stand in front of the name: ChatGPT's own words of the request ("Allow ChatGPT to use ", "ChatGPT
 * erlauben, ", "¿Permitir que ChatGPT use ", "ChatGPTに"), which always say ChatGPT. Letters, marks, spaces,
 * apostrophes, opening quotes and commas only: a digit, a full stop, a colon or a slash in front means
 * another sentence ("Warning. ChatGPT ... Chat On Steroids Core?"), which a person reads.
 */
const PLAIN_BEFORE = /^[\s\p{L}\p{M}'’¿¡«“„"「『〈《,，、]{0,60}$/u;

/**
 * ChatGPT's requests are sentences: only the first word is capitalised, besides ChatGPT itself. A capital later in
 * front of the name is another name or another sentence ("Allow ChatGPT to use Helper for Chat On Steroids Core?",
 * "Mistenkelig instruksjon Tillat ChatGPT å bruke ...?").
 */
function sentenceBefore(before: string): boolean {
  const words = before.split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  return words.every((word, index) => index === 0 || word === 'ChatGPT' || !/^\p{Lu}/u.test(word));
}

function titleNames(title: string, name: string): boolean {
  for (let at = title.indexOf(name); at >= 0; at = title.indexOf(name, at + 1)) {
    const before = title.slice(0, at);
    // The name runs on from a longer word or name before it ("My-Chat On Steroids Core").
    if (/[\p{Script=Latin}\p{N}_-]$/u.test(before)) continue;
    // A request to use the connector says ChatGPT in front of it, in every language, and nothing like a second sentence.
    if (!before.includes('ChatGPT') || !PLAIN_BEFORE.test(before) || !sentenceBefore(before)) continue;
    const after = title.slice(at + name.length, -1).replace(CLOSING_QUOTE, '');
    if (/^[\p{Script=Latin}\p{N}_]/u.test(after) || SUFFIX_OPENING.test(after) || !PLAIN_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

/** Where the title stands: the first line when it ends in a question mark, or the second after the app's own header. */
function titleIndex(lines: readonly string[], names: readonly string[]): 0 | 1 | null {
  const [first = ''] = lines;
  if (QUESTION_END.test(first)) return 0;
  return names.includes(first) ? 1 : null;
}

/**
 * Which of `names` the card asks about, or null. Only the card's title counts: the first line when it
 * ends in a question mark, or the second when the first is exactly one of the names (the app's header).
 * Any other first line (a warning, another app's name) leaves the card to a person, as does a title
 * that does not end in a question mark or does not say ChatGPT in front of the name. The name must stand
 * alone in the title (see `PLAIN_AFTER`), so "Chat On Steroids Core (Laptop)", "... — LAP-PACO2" and
 * "... 2" never match. A word between ChatGPT and the name ("Allow ChatGPT to use My Chat On Steroids
 * Core?") is not told apart.
 */
export function cardNamedConnector(lines: readonly string[], names: readonly string[]): string | null {
  const at = titleIndex(lines, names);
  const title = at === null ? '' : lines[at] ?? '';
  if (!title || !QUESTION_END.test(title) || title.length > 140) return null;
  return names.find(name => !!name && titleNames(title, name)) ?? null;
}

/** Lower case without accents, so "Instrucción SOSPECHOSA" and "instruccion sospechosa" are one word. */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Words of ChatGPT's safety check and its translations: "Suspicious Instruction" (the card the maintainer
 * saw, #304), malicious or injected instructions. Stems, written with their accents; read after `fold`.
 * A card whose own words hold one of these is never answered. Not a list of every language ChatGPT speaks:
 * a card in a language missing here is still not pressed, because `plainShape` allows no line below the
 * title except an introduction of the shared data, and its mention of this app is logged (`namesThisApp`).
 */
const SAFETY_STEMS = [
  // suspicious / suspect: English, Portuguese, Spanish, Italian, German, Dutch, Polish, Czech, Swedish, Danish, Finnish, Greek, Russian, Ukrainian, Turkish, Vietnamese, Indonesian, Arabic, Hebrew, Hindi, Thai, Japanese, Chinese, Korean
  'suspicious', 'suspect', 'suspeit', 'sospech', 'sospett', 'verdacht', 'verdächt', 'podejrz', 'podezř', 'misstänk', 'mistænk', 'epäilyttä',
  'ύποπτ', 'подозр', 'підозр', 'şüphe', 'nghi ngờ', 'đáng ngờ', 'mencurigakan', 'مشبوه', 'חשוד', 'संदिग्ध', 'น่าสงสัย',
  '不審', '怪しい', '疑わしい', '可疑', '의심',
  // malicious
  'malicious', 'malicios', 'malveillan', 'bösartig', 'kwaadaardig', 'злонамерен', 'вредонос', '恶意', '惡意', '悪意', '악성', '악의',
  // injection and taking over
  'injection', 'inyección', 'injeção', 'iniezione', 'injektion', 'инъекц', 'enjeksiyon', '注入', 'インジェクション', '인젝션', 'hijack', 'exfiltrat', 'jailbreak'
].map(fold);

/** Warning words that may head a card: only the first lines and the buttons and labels are read, where a heading stands. */
const WARNING_STEMS = [
  'warn', 'unsafe', 'dangerous', 'advertencia', 'advierte', 'peligro', 'warnung', 'achtung', 'gefahr', 'avertissement', 'attention', 'dangereu',
  'avvertenza', 'avvertimento', 'perigo', 'pericol', 'aviso de seguran', 'uyarı', 'uyari', 'dikkat', 'tehlike', 'предупрежд', 'внимани', 'опасн',
  '警告', '警示', '危険', '危险', '危險', '경고', '위험'
].map(fold);
const WARNING_LINES = 3;

/** The first of the card's own words (or of its buttons and labels) that carries a safety or warning signal, or null. */
export function cardSafetyLine(chrome: readonly string[], extra: readonly string[] = []): string | null {
  const flagged = (line: string, heading: boolean): boolean => {
    const folded = fold(line);
    return SAFETY_STEMS.some(stem => folded.includes(stem)) || (heading && WARNING_STEMS.some(stem => folded.includes(stem)));
  };
  return chrome.find((line, index) => flagged(line, index < WARNING_LINES)) ?? extra.find(line => flagged(line, true)) ?? null;
}

/** Whether the card's own words, buttons or labels carry a safety or warning signal. */
export function cardSafetySignal(chrome: readonly string[], extra: readonly string[] = []): boolean {
  return cardSafetyLine(chrome, extra) !== null;
}

/** What the page reports about the card's words. */
export interface ApprovalCardWords {
  lines: readonly string[];
  /** Index of the first shared-data line; absent or out of range reads as "no data lines": every line counts as the card's own. */
  data?: number;
  /** The page left words of the card's own out of `lines`. */
  cut?: boolean;
  /** Texts the page drops when it reads the words, other than the buttons every request has: further buttons, icons, labels, hidden parts, image descriptions. */
  extra?: readonly string[];
}

export type ApprovalCardKind =
  | { kind: 'own'; name: string }
  | { kind: 'safety' }
  | { kind: 'other'; namesThisApp: boolean };

/** The card's own words, without the shared data, and whether the page marked any shared data at all. */
export function splitCard(card: ApprovalCardWords): { chrome: readonly string[]; hasData: boolean } {
  const data = card.data;
  const hasData = typeof data === 'number' && Number.isInteger(data) && data >= 0 && data < card.lines.length;
  return { chrome: hasData ? card.lines.slice(0, data) : card.lines, hasData };
}

/**
 * The one shape of a plain permission request: the title (after the app's name as a header, if any), then
 * nothing, or one short line that ends in a colon and introduces the shared data rows that follow. A card
 * with any other line of its own below the title is not recognised: that line may be ChatGPT's warning in
 * a language the word lists lack. The same for text the page dropped from its reading (`extra`): the page
 * leaves out of it the Deny button, the Allow once button and the options menu, which every request has, so
 * anything it does report is a part of the card this file does not know.
 */
function plainShape(chrome: readonly string[], hasData: boolean, names: readonly string[], extra: readonly string[] = []): boolean {
  if (extra.length > 0) return false;
  const at = titleIndex(chrome, names);
  if (at === null) return false;
  const rest = chrome.slice(at + 1);
  return rest.length === 0 || (rest.length === 1 && hasData && rest[0]!.length <= INTRO_MAX && INTRO_END.test(rest[0]!));
}

/** Sorts one card. `names` are this install's connector names; none means no card is ever `own`. */
export function classifyApprovalCard(card: ApprovalCardWords, names: readonly string[]): ApprovalCardKind {
  const { chrome, hasData } = splitCard(card);
  if (cardSafetySignal(chrome, card.extra)) return { kind: 'safety' };
  const name = card.cut === true ? null : cardNamedConnector(chrome, names);
  if (name && plainShape(chrome, hasData, names, card.extra)) return { kind: 'own', name };
  return { kind: 'other', namesThisApp: chrome.some(line => names.some(own => !!own && line.includes(own))) };
}

/** A line for the log: bounded, with control, format and line-break characters gone. */
function logLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * The card's heading for the log: the line that raised the alarm when there is one, else the first line.
 * One bounded line of ChatGPT's own words, never the rest of the card or the shared data.
 */
export function cardHeading(card: ApprovalCardWords): string {
  const { chrome } = splitCard(card);
  return logLine(cardSafetyLine(chrome, card.extra) ?? chrome[0] ?? '');
}

/** The shape of a card for the log, as numbers only: how many lines are its own, how many are shared data. */
export function cardShape(card: ApprovalCardWords): string {
  const { chrome } = splitCard(card);
  return `${chrome.length} own lines, ${card.lines.length - chrome.length} data lines${card.cut === true ? ', cut' : ''}`;
}
