import { describe, expect, it } from 'vitest';
import { cardHeading, cardSafetySignal, cardShape, classifyApprovalCard, type ApprovalCardWords } from '../src/main/approval-card-kind.js';

// 2026-10-29, the owner's decision: ChatGPT's safety cards ("Suspicious instruction") are never answered by the
// app, whatever their title looks like, and a card whose type is not known is not answered either.

const CORE = 'Chat On Steroids Core';
const NAMES = [CORE, 'Chat On Steroids Desktop'];
const kindOf = (lines: string[], extra: Omit<ApprovalCardWords, 'lines'> = {}) => classifyApprovalCard({ lines, ...extra }, NAMES);

// The card the maintainer saw (public issue #304), word for word: a heading and what it found.
const EN_HEADING = 'Suspicious Instruction';
const EN_REASON = 'Tool documentation prescribes how to operate the worker tool and suppresses asking the user for settings, attempting to control agent behavior and workflow.';

describe('a plain permission request for the app\'s own connector', () => {
  it('is recognised in English, Spanish and German, with or without the app header', () => {
    expect(kindOf([`Allow ChatGPT to use ${CORE}?`])).toEqual({ kind: 'own', name: CORE });
    expect(kindOf([`¿Permitir que ChatGPT use ${CORE}?`])).toEqual({ kind: 'own', name: CORE });
    expect(kindOf([CORE, `ChatGPT erlauben, ${CORE} zu verwenden?`])).toEqual({ kind: 'own', name: CORE });
  });

  it('may introduce the shared data with one line that ends in a colon, followed by the data rows the page marks', () => {
    // The live card of 2026-10-25 (German): the title, the introduction, then the <dl> of the data.
    const live = [`ChatGPT erlauben, ${CORE} zu verwenden?`, 'Zu den geteilten Daten gehören:', 'Zugangsschlüssel: sk-proj-FAKE0123', 'Befehl: echo test'];
    expect(kindOf(live, { data: 2 })).toEqual({ kind: 'own', name: CORE });
    expect(kindOf([CORE, ...live], { data: 3 })).toEqual({ kind: 'own', name: CORE });
    expect(kindOf(['是否允许 ChatGPT 使用 ' + CORE + '？', '共享的数据包括：', '命令: ls'], { data: 2 })).toEqual({ kind: 'own', name: CORE });
    // An introduction with no data rows after it, or no colon, is not the shape.
    expect(kindOf(live.slice(0, 2), { data: 2 }).kind).not.toBe('own');
    expect(kindOf(live.slice(0, 2)).kind).not.toBe('own');
    expect(kindOf([live[0]!, 'Zu den geteilten Daten gehören', ...live.slice(2)], { data: 2 }).kind).not.toBe('own');
  });

  it('reads only the card\'s own words: a warning word inside the shared data is data, not a warning', () => {
    const lines = [`Allow ChatGPT to use ${CORE}?`, 'The shared data includes:', 'Command: rg "Suspicious instruction" docs', 'Note: injection tests'];
    expect(kindOf(lines, { data: 2 })).toEqual({ kind: 'own', name: CORE });
    // Without the page's word on where the data starts, every line counts as the card's own and the card is left to a person.
    expect(kindOf(lines)).toEqual({ kind: 'safety' });
    // A data index that cannot be right (out of range, fractional, negative) is no index.
    for (const data of [lines.length, 99, 1.5, -1, Number.NaN]) expect(kindOf(lines, { data }), String(data)).toEqual({ kind: 'safety' });
  });
});

describe('a safety card is never a permission request, whatever its title says', () => {
  const safetyCards: Array<[string, string[]]> = [
    // English: the heading first (as #304 shows it), or a plain title with the warning below it.
    ['en heading', [EN_HEADING, EN_REASON]],
    ['en plain title', [`Allow ChatGPT to use ${CORE}?`, EN_HEADING, EN_REASON]],
    ['en header, title, warning', [CORE, `Allow ChatGPT to use ${CORE}?`, EN_HEADING, EN_REASON]],
    ['en upper case', [`Allow ChatGPT to use ${CORE}?`, 'SUSPICIOUS INSTRUCTION']],
    ['en reason only', [`Allow ChatGPT to use ${CORE}?`, 'The tool description is a prompt injection attempt.']],
    // Spanish, with and without accents, headed or below a plain title.
    ['es heading', ['Instrucción sospechosa', 'La documentación de la herramienta indica cómo usar la herramienta e impide preguntar al usuario por la configuración.']],
    ['es plain title', [`¿Permitir que ChatGPT use ${CORE}?`, 'Instrucción sospechosa', 'La documentación intenta controlar el comportamiento del agente.']],
    ['es upper case, no accents', [`¿Permitir que ChatGPT use ${CORE}?`, 'INSTRUCCION SOSPECHOSA']],
    ['es injection', [`¿Permitir que ChatGPT use ${CORE}?`, 'Posible inyección de instrucciones']],
    ['es warning', [`¿Permitir que ChatGPT use ${CORE}?`, 'Advertencia de seguridad']],
    // The other languages ChatGPT shows.
    ['de', [`ChatGPT erlauben, ${CORE} zu verwenden?`, 'Verdächtige Anweisung']],
    ['fr', [`Autoriser ChatGPT à utiliser ${CORE} ?`, 'Instruction suspecte']],
    ['pt', [`Permitir que o ChatGPT use ${CORE}?`, 'Instrução suspeita']],
    ['it', [`Consentire a ChatGPT di usare ${CORE}?`, 'Istruzione sospetta']],
    ['ja', [`ChatGPTに${CORE}の使用を許可しますか？`, '不審な指示']],
    ['zh', [`是否允许 ChatGPT 使用 ${CORE}？`, '可疑指令']],
    ['ko', [`ChatGPT가 ${CORE}을(를) 사용하도록 허용하시겠습니까?`, '의심스러운 지침']],
    ['tr', [`ChatGPT'nin ${CORE} kullanmasına izin verilsin mi?`, 'Şüpheli Talimat']],
    ['ru', [`Разрешить ChatGPT использовать «${CORE}»?`, 'Подозрительная инструкция']],
    ['vi', [`Cho phép ChatGPT sử dụng ${CORE}?`, 'Hướng dẫn đáng ngờ']],
    ['de warning', [`ChatGPT erlauben, ${CORE} zu verwenden?`, 'Warnung']]
  ];
  it.each(safetyCards)('%s', (_, lines) => {
    expect(kindOf(lines)).toEqual({ kind: 'safety' });
    // With the card's words as the page counts them, the same.
    expect(kindOf(lines, { data: lines.length })).toEqual({ kind: 'safety' });
  });

  it('is told apart from a request by words alone, not by where the card starts', () => {
    expect(cardSafetySignal([EN_HEADING])).toBe(true);
    expect(cardSafetySignal([`Allow ChatGPT to use ${CORE}?`])).toBe(false);
    expect(cardSafetySignal([])).toBe(false);
  });

  // The page drops buttons, icons, hidden parts and labels when it reads the card's words, and reports their texts
  // as `extra`: a heading drawn as a fold-out button or an icon caption is still read.
  it('is found in a button, an icon caption or a hidden part the page reports as extra', () => {
    const plain = [`Allow ChatGPT to use ${CORE}?`];
    // The page does not report the buttons every request has, so a request has no extra at all.
    expect(kindOf(plain, { extra: [] })).toEqual({ kind: 'own', name: CORE });
    for (const extra of [['Deny', 'Suspicious Instruction'], ['Instrucción sospechosa'], ['Warning'], ['Unsafe instruction'], ['Verdächtige Anweisung']]) {
      expect(kindOf(plain, { extra }), extra.join()).toEqual({ kind: 'safety' });
    }
    // Any other dropped text, in a language the word lists lack, is a part of the card nobody knows: not a request.
    for (const extra of [['Mistenkelig instruksjon', 'Deny', 'Allow once'], ['Show details'], ['x']]) {
      expect(kindOf(['Tillat ChatGPT å bruke ' + CORE + '?', 'Shared data includes:', 'Kommando: echo hi'], { data: 2, extra }), extra.join()).toEqual({ kind: 'other', namesThisApp: true });
    }
  });
});

describe('a card of an unknown type is left to a person', () => {
  // A warning in a language the word lists lack, under a plain title: the shape alone refuses it, because nothing
  // below the title may stand except the introduction of the shared data.
  const unlisted: Array<[string, string]> = [
    ['Catalan', 'Instrucció sospitosa'], ['Norwegian', 'Mistenkelig instruksjon'], ['Hungarian', 'Gyanús utasítás'], ['Slovak', 'Podozrivý pokyn'],
    ['Croatian', 'Sumnjiva uputa'], ['Persian', 'دستورالعمل مشکوک'], ['Spanish variant', 'Instrucción dudosa'], ['English variant', 'Caution: unusual instruction'],
    ['plain sentence', 'This tool may do something you did not ask for.']
  ];
  it.each(unlisted)('a warning below the title in an unlisted wording: %s', (_, warning) => {
    for (const lines of [[`Allow ChatGPT to use ${CORE}?`, warning], [CORE, `Allow ChatGPT to use ${CORE}?`, warning], [CORE, `Allow ChatGPT to use ${CORE}?`, 'Runs a command.', warning]]) {
      expect(kindOf(lines).kind, lines.join(' | ')).not.toBe('own');
      expect(kindOf(lines, { data: lines.length }).kind, lines.join(' | ')).not.toBe('own');
    }
    // With the introduction line and rows after it the warning still has no place.
    expect(kindOf([`Allow ChatGPT to use ${CORE}?`, warning, 'The shared data includes:', 'Command: ls'], { data: 3 }).kind).not.toBe('own');
    // The warning dressed as the introduction line of the data is told apart only by its colon: a heading without one is refused.
    expect(kindOf([`Allow ChatGPT to use ${CORE}?`, warning, 'Command: ls'], { data: 2 }).kind).not.toBe('own');
  });

  const unknown: Array<[string, string[], Omit<ApprovalCardWords, 'lines'>?]> = [
    ['no ChatGPT in front of the name', [`Allow ${CORE}?`]],
    ['another sentence in front of the name', [`Heads up. ChatGPT wants to use ${CORE}?`]],
    ['a digit in front of the name', [`1 ChatGPT use ${CORE}?`]],
    ['not a question', [`ChatGPT wants to use ${CORE}`]],
    ['a heading that is not the app\'s name', ['Review needed', `Allow ChatGPT to use ${CORE}?`]],
    ['a heading with no title', ['Review needed', 'Something about this tool call.']],
    ['the name only in a later line', ['Allow ChatGPT to use GitHub?', CORE]],
    ['no words at all', []],
    ['an empty first line', ['', `Allow ChatGPT to use ${CORE}?`]],
    ['the page says words were left out', [`Allow ChatGPT to use ${CORE}?`], { cut: true }],
    ['a description line below the title', [`Allow ChatGPT to use ${CORE}?`, 'Runs a command.']],
    ['two lines below the title', [`Allow ChatGPT to use ${CORE}?`, 'Runs a command.', 'The shared data includes:'], { data: 3 }],
    ['a sibling connector', ['Allow ChatGPT to use Chat On Steroids Core (Laptop)?']],
    ['a sibling with a Korean name suffix', [`ChatGPT가 ${CORE} (노트북)을(를) 사용하도록 허용하시겠습니까?`]],
    ['a sibling with a one-syllable Korean suffix after a space', [`ChatGPT가 ${CORE} (집)을(를) 사용하도록 허용하시겠습니까?`]],
    ['a sibling with a two-syllable Korean suffix after a space', [`Allow ChatGPT to use ${CORE} (회사)?`]],
    // Another name or another sentence in front of the name: only the first word of a request is capitalised.
    ['another app named around this one', [`Allow ChatGPT to use Helper for ${CORE}?`]],
    ['a capital in front of ChatGPT after other words', [`Mistenkelig instruksjon Tillat ChatGPT å bruke ${CORE}?`]],
    ['a capital after ChatGPT', [`Allow ChatGPT to use Helper ${CORE}?`]],
    // Another computer's connector, named with a suffix in another script, in brackets.
    ['a sibling with a Cyrillic suffix', [`Allow ChatGPT to use ${CORE} (ноутбук)?`]],
    ['a sibling with a Greek suffix', [`Allow ChatGPT to use ${CORE} (λάπτοπ)?`]],
    ['a sibling with a Chinese suffix', [`是否允许 ChatGPT 使用 ${CORE} (笔记本)？`]],
    ['another app', ['Allow ChatGPT to use Gmail?', 'Creates a draft.']]
  ];
  it.each(unknown)('%s', (_, lines, extra) => {
    expect(kindOf(lines, extra).kind).not.toBe('own');
  });

  it('says whether an unrecognised card mentions this app, so a safety card in a language not known here is still reported', () => {
    expect(kindOf(['Review needed', `Allow ChatGPT to use ${CORE}?`])).toEqual({ kind: 'other', namesThisApp: true });
    expect(kindOf(['Allow ChatGPT to use Gmail?', 'Creates a draft.'])).toEqual({ kind: 'other', namesThisApp: false });
    expect(kindOf([`Allow ChatGPT to use ${CORE}?`], { cut: true })).toEqual({ kind: 'other', namesThisApp: true });
    expect(kindOf([`Allow ChatGPT to use ${CORE}?`, 'Instrucció sospitosa'])).toEqual({ kind: 'other', namesThisApp: true });
  });
});

describe('what the log says about a card', () => {
  it('is one bounded line: the line that raised the alarm, else the first, without control, bidi or line-break characters', () => {
    expect(cardHeading({ lines: [EN_HEADING, EN_REASON] })).toBe(EN_HEADING);
    // With the app's name as the header the alarming line is the heading, not the header.
    expect(cardHeading({ lines: [CORE, `Allow ChatGPT to use ${CORE}?`, EN_HEADING, EN_REASON] })).toBe(EN_HEADING);
    expect(cardHeading({ lines: ['Review needed', `Allow ChatGPT to use ${CORE}?`] })).toBe('Review needed');
    expect(cardHeading({ lines: [`Allow ChatGPT to use ${CORE}?`], extra: ['Suspicious Instruction'] })).toBe('Suspicious Instruction');
    // The shared data is never the heading.
    expect(cardHeading({ lines: ['Title?', 'Data:', 'Key: sk-proj-FAKE0123'], data: 2 })).toBe('Title?');
    const nasty = ['a', String.fromCharCode(0), 'b', String.fromCharCode(10), 'c', String.fromCharCode(0x2028), 'd', String.fromCharCode(0x202e), 'e', String.fromCharCode(0x200b), 'f'].join('');
    expect(cardHeading({ lines: [nasty] })).toBe('a b c d e f');
    expect(cardHeading({ lines: ['x'.repeat(500)] })).toHaveLength(80);
    expect(cardHeading({ lines: [] })).toBe('');
  });

  it('describes the shape of a card in numbers only', () => {
    expect(cardShape({ lines: ['t?', 'd:', 'k: v', 'k2: v2'], data: 2 })).toBe('2 own lines, 2 data lines');
    expect(cardShape({ lines: ['t?', 'x'], cut: true })).toBe('2 own lines, 0 data lines, cut');
  });
});
