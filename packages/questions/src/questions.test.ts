import { describe, expect, it } from 'vitest';
import { parseGift, toGift } from './gift.ts';
import {
  correctResponse,
  gradeResponse,
  isAnswered,
  parseNumber,
  presentQuestion,
} from './grade.ts';
import { gradedTypes, questionTypeDefs } from './qtypes/index.ts';
import { shuffle } from './random.ts';
import { PublicFields } from './registry.ts';
import {
  MultichoiceData,
  type QuestionData,
  type QuestionSnapshot,
  type QuestionType,
  questionDataSchemas,
  questionTypes,
} from './types.ts';

/** One question of every type, as an attempt stores it. */
const fixtures: { [K in QuestionType]: QuestionSnapshot & { type: K } } = (() => {
  const q = <K extends QuestionType>(type: K, data: unknown) => ({
    id: `q-${type}`,
    type,
    name: type,
    text: `<p>${type}</p>`,
    generalFeedback: '',
    defaultMark: 1,
    data: questionDataSchemas[type].parse(data) as QuestionData,
  });
  return {
    MULTICHOICE: q('MULTICHOICE', {
      answers: [
        { id: 'a', text: 'yes', fraction: 1, feedback: 'right' },
        { id: 'b', text: 'no', fraction: 0, feedback: 'wrong' },
      ],
    }),
    TRUEFALSE: q('TRUEFALSE', { correct: false, feedbackTrue: 'x', feedbackFalse: 'y' }),
    SHORTANSWER: q('SHORTANSWER', { answers: [{ text: 'Paris', fraction: 1 }] }),
    NUMERICAL: q('NUMERICAL', { answers: [{ value: 3.14, tolerance: 0.01, fraction: 1 }] }),
    MATCH: q('MATCH', {
      pairs: [
        { id: 'p1', question: '2+2', answer: '4' },
        { id: 'p2', question: '3+3', answer: '6' },
      ],
      distractors: ['5'],
    }),
    ESSAY: q('ESSAY', { minWords: 10, graderInfo: 'look for the thesis' }),
    DESCRIPTION: q('DESCRIPTION', {}),
    ORDERING: q('ORDERING', {
      items: [
        { id: 'i1', text: 'first' },
        { id: 'i2', text: 'second' },
        { id: 'i3', text: 'third' },
      ],
      feedbackCorrect: 'well done',
    }),
    GAPSELECT: {
      ...q('GAPSELECT', {
        choices: [
          { id: 'c1', text: 'cat', group: 1 },
          { id: 'c2', text: 'dog', group: 1 },
        ],
        feedbackCorrect: 'well done',
      }),
      text: '<p>The [[2]] barks</p>',
    },
    DDWTOS: {
      ...q('DDWTOS', {
        choices: [
          { id: 'c1', text: 'cat', group: 1 },
          { id: 'c2', text: 'dog', group: 1 },
        ],
      }),
      text: '<p>The [[2]] barks</p>',
    },
  };
})();

const mcSingle = {
  type: 'MULTICHOICE' as const,
  data: MultichoiceData.parse({
    single: true,
    answers: [
      { id: 'a', text: 'Москва', fraction: 1, feedback: 'Верно' },
      { id: 'b', text: 'Казань', fraction: 0 },
    ],
  }),
};

describe('grading', () => {
  it('multichoice single', () => {
    expect(gradeResponse(mcSingle, { selected: ['a'] })).toMatchObject({
      fraction: 1,
      feedback: ['Верно'],
    });
    expect(gradeResponse(mcSingle, { selected: ['b'] }).fraction).toBe(0);
    expect(gradeResponse(mcSingle, {}).fraction).toBe(0);
  });
  it('multichoice multiple with penalties clamps to 0..1', () => {
    const q = {
      type: 'MULTICHOICE' as const,
      data: MultichoiceData.parse({
        single: false,
        answers: [
          { id: 'a', text: '2', fraction: 0.5 },
          { id: 'b', text: '3', fraction: 0.5 },
          { id: 'c', text: '4', fraction: -1 },
        ],
      }),
    };
    expect(gradeResponse(q, { selected: ['a', 'b'] }).fraction).toBe(1);
    expect(gradeResponse(q, { selected: ['a'] }).fraction).toBe(0.5);
    expect(gradeResponse(q, { selected: ['a', 'c'] }).fraction).toBe(0);
  });
  it('true/false', () => {
    const q = {
      type: 'TRUEFALSE' as const,
      data: { correct: false, feedbackTrue: '', feedbackFalse: '' },
    };
    expect(gradeResponse(q, { value: false }).fraction).toBe(1);
    expect(gradeResponse(q, { value: true }).fraction).toBe(0);
    expect(gradeResponse(q, { value: null }).fraction).toBe(0);
  });
  it('short answer: case, spaces, wildcards, best partial', () => {
    const q = {
      type: 'SHORTANSWER' as const,
      data: questionDataSchemas.SHORTANSWER.parse({
        answers: [
          { text: 'Пушкин', fraction: 1 },
          { text: 'А*Пушкин', fraction: 1 },
          { text: 'Лермонтов', fraction: 0.2 },
        ],
      }),
    };
    expect(gradeResponse(q, { text: '  пушкин ' }).fraction).toBe(1);
    expect(gradeResponse(q, { text: 'А. С. Пушкин' }).fraction).toBe(1);
    expect(gradeResponse(q, { text: 'Лермонтов' }).fraction).toBe(0.2);
    expect(gradeResponse(q, { text: 'Гоголь' }).fraction).toBe(0);
  });
  it('numerical with tolerance and comma decimals', () => {
    const q = {
      type: 'NUMERICAL' as const,
      data: questionDataSchemas.NUMERICAL.parse({
        answers: [{ value: 3.14, tolerance: 0.01, fraction: 1 }],
      }),
    };
    expect(gradeResponse(q, { text: '3,145' }).fraction).toBe(1);
    expect(gradeResponse(q, { text: '3.2' }).fraction).toBe(0);
    expect(gradeResponse(q, { text: 'pi' }).fraction).toBe(0);
    expect(parseNumber('1e3')).toBe(1000);
    expect(parseNumber('1 000')).toBe(1000);
  });
  it('match gives partial credit', () => {
    const q = {
      type: 'MATCH' as const,
      data: questionDataSchemas.MATCH.parse({
        pairs: [
          { id: 'p1', question: 'Франция', answer: 'Париж' },
          { id: 'p2', question: 'Италия', answer: 'Рим' },
        ],
      }),
    };
    expect(gradeResponse(q, { choices: { p1: 'Париж', p2: 'Париж' } }).fraction).toBe(0.5);
    expect(gradeResponse(q, correctResponse(q)).fraction).toBe(1);
  });
  it('essay needs manual grading only when answered', () => {
    const q = { type: 'ESSAY' as const, data: questionDataSchemas.ESSAY.parse({}) };
    expect(gradeResponse(q, { text: 'Мой ответ' })).toMatchObject({
      fraction: null,
      needsGrading: true,
    });
    expect(gradeResponse(q, { text: '' })).toMatchObject({ fraction: null, needsGrading: false });
  });
  it('correctResponse earns full marks for auto-graded types', () => {
    expect(gradeResponse(mcSingle, correctResponse(mcSingle)).fraction).toBe(1);
  });
  it('isAnswered', () => {
    expect(isAnswered('MULTICHOICE', { selected: [] })).toBe(false);
    expect(isAnswered('TRUEFALSE', { value: false })).toBe(true);
    expect(isAnswered('ESSAY', { text: ' ' })).toBe(false);
  });
});

describe('presentation', () => {
  it('shuffles deterministically by seed', () => {
    expect(shuffle([1, 2, 3, 4, 5], 42)).toEqual(shuffle([1, 2, 3, 4, 5], 42));
    expect(shuffle([1, 2, 3, 4, 5, 6, 7, 8], 1)).not.toEqual(shuffle([1, 2, 3, 4, 5, 6, 7, 8], 2));
  });
  it('keeps every answer when shuffling', () => {
    const p = presentQuestion(
      { id: 'q1', name: 'n', text: 't', generalFeedback: '', defaultMark: 1, ...mcSingle },
      7,
      true,
    );
    expect([...(p.order ?? [])].sort()).toEqual(['a', 'b']);
  });
});

describe('GIFT', () => {
  const src = `
// comment
$CATEGORY: $course$/Литература

::Столица::Столица России? {=Москва#Верно ~Казань#Нет ~Самара}

::Земля::Земля плоская. {F}

::Автор::Кто написал «Евгения Онегина»? {=Пушкин =А. С. Пушкин}

::Пи::Число π с точностью 0.01 {#3.14:0.01}

::Страны::Сопоставьте {
  =Франция -> Париж
  =Италия -> Рим
  = -> Берлин
}

::Эссе::Опишите лето. {}

::Простые::Выберите простые числа {~%50%2 ~%50%3 ~%-100%4}

Просто текст без вопроса.
`;
  it('parses all common types', () => {
    const r = parseGift(src);
    expect(r.errors).toEqual([]);
    expect(r.questions.map((q) => q.type)).toEqual([
      'MULTICHOICE',
      'TRUEFALSE',
      'SHORTANSWER',
      'NUMERICAL',
      'MATCH',
      'ESSAY',
      'MULTICHOICE',
      'DESCRIPTION',
    ]);
    expect(r.questions[0]!.category).toBe('Литература');
    const mc = r.questions[0]!;
    expect(gradeResponse(mc, { selected: ['a1'] }).fraction).toBe(1);
    expect((mc.data as { answers: { feedback: string }[] }).answers[0]!.feedback).toBe('Верно');
    const multi = r.questions[6]!;
    expect((multi.data as { single: boolean }).single).toBe(false);
    expect(gradeResponse(multi, { selected: ['a1', 'a2'] }).fraction).toBe(1);
    const match = r.questions[4]!;
    expect((match.data as { distractors: string[] }).distractors).toEqual(['Берлин']);
    expect(gradeResponse(r.questions[3]!, { text: '3.141' }).fraction).toBe(1);
  });
  it('handles escapes and reports errors per block', () => {
    const r = parseGift('::A:: 2 \\= 2? {T}\n\n::B:: broken {=x');
    expect(r.questions[0]!.text).toBe('2 = 2?');
    expect(r.errors).toHaveLength(1);
  });
  it('round-trips through toGift', () => {
    const r = parseGift(src);
    for (const q of r.questions) {
      const again = parseGift(toGift(q)!).questions[0]!;
      expect(again.type).toBe(q.type);
      expect(again.data).toEqual(q.data);
    }
  });
  it('validates parsed data with the type schemas', () => {
    for (const q of parseGift(src).questions) {
      expect(questionDataSchemas[q.type].safeParse(q.data).success).toBe(true);
    }
  });
});

describe('question type registry', () => {
  it('defines every type, and its public view gives nothing away', () => {
    expect(Object.keys(questionTypeDefs).sort()).toEqual([...questionTypes].sort());
    for (const type of questionTypes) {
      const def = questionTypeDefs[type];
      expect(def.type).toBe(type);
      const sample = fixtures[type];
      const view = def.publicView(presentQuestion(sample, 42, true) as never);
      expect(PublicFields.safeParse(view).success, type).toBe(true);
      const json = JSON.stringify(view);
      for (const secret of ['fraction', 'feedback', 'correct', 'tolerance', 'graderInfo'])
        expect(json, `${type} leaks ${secret}`).not.toContain(secret);
      const right = correctResponse(sample);
      if (def.grading === 'auto') expect(gradeResponse(sample, right).fraction, type).toBe(1);
      else expect(right, type).toBeNull();
    }
    expect(gradedTypes).not.toContain('DESCRIPTION');
  });
});
