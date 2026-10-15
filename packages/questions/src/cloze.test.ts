import { describe, expect, it } from 'vitest';
import { replay } from './behaviours.ts';
import {
  answerText,
  checkQuestionText,
  correctResponse,
  gradeResponse,
  presentQuestion,
  publicText,
  questionDataFrom,
} from './grade.ts';
import { scanCloze, toClozeSource } from './qtypes/cloze.ts';
import { MultianswerData, type QuestionSnapshot } from './types.ts';

// The example of Moodle's documentation for embedded answers (Cloze), and the escapes.
const MOODLE_EXAMPLE = `<p>This question consists of some text with an answer embedded right here {1:MULTICHOICE:Wrong answer#Feedback for this wrong answer~Another wrong answer#Feedback for the other wrong answer~=Correct answer#Feedback for correct answer~%50%Answer that gives half the credit#Feedback for half credit answer} and right after that you will have to deal with this short answer {1:SHORTANSWER:Wrong answer#Feedback for this wrong answer~=Correct answer#Feedback for correct answer~%50%Answer that gives half the credit#Feedback for half credit answer} and finally we have a floating point number {2:NUMERICAL:=23.8:0.1#Feedback for correct answer 23.8~%50%23.8:2#Feedback for half credit answer in the nearby region of the correct answer}.</p>
<p>Note that addresses like www.moodle.org and smileys :-) all work as normal:</p>
<p>a) How good is this? {:MULTICHOICE:=Yes#Correct~No#We have a different opinion}</p>
<p>b) What grade would you give it? {3:NUMERICAL:=3:2}</p>`;

const cloze = (text: string, extra: Partial<QuestionSnapshot> = {}): QuestionSnapshot => ({
  id: 'q-cloze',
  type: 'MULTIANSWER',
  name: 'Cloze',
  text,
  generalFeedback: '',
  defaultMark: 1,
  data: MultianswerData.parse(questionDataFrom('MULTIANSWER', text, null)),
  ...extra,
});

describe('Cloze (embedded answers)', () => {
  it('reads Moodle’s example', () => {
    const q = cloze(MOODLE_EXAMPLE);
    const parts = (q.data as { parts: { kind: string; weight: number }[] }).parts;
    expect(parts.map((p) => [p.kind, p.weight])).toEqual([
      ['multichoice', 1],
      ['shortanswer', 1],
      ['numerical', 2],
      ['multichoice', 1],
      ['numerical', 3],
    ]);
    expect(gradeResponse(q, correctResponse(q)).fraction).toBe(1);
    // half credit for the first two and the number nearby, the rest right: (0.5+0.5+1+1+3)/8
    const r = {
      parts: { 1: 'a4', 2: 'Answer that gives half the credit', 3: '22', 4: 'a1', 5: '4' },
    };
    const g = gradeResponse(q, r);
    expect(g.fraction).toBeCloseTo(6 / 8);
    expect(g.feedback).toContain(
      'Feedback for half credit answer in the nearby region of the correct answer',
    );
    expect(gradeResponse(q, { parts: { 5: '3' } }).fraction).toBeCloseTo(3 / 8);
    // a menu gap takes one answer: sending every option earns nothing
    expect(gradeResponse(q, { parts: { 1: ['a1', 'a2', 'a3', 'a4'] } }).fraction).toBe(0);
    expect(checkQuestionText('MULTIANSWER', MOODLE_EXAMPLE, q.data)).toBeNull();
  });

  it('shows the gaps numbered, never the answers', () => {
    const q = presentQuestion(cloze(MOODLE_EXAMPLE), 3, true);
    const text = publicText(q);
    expect(text).toContain('embedded right here [[1]] and right after');
    expect(text).toContain('give it? [[5]]</p>');
    expect(text).not.toMatch(/Correct answer|23\.8|Yes/);
    expect(answerText(q, { parts: { 2: 'Correct answer', 5: '3' } })).toContain(
      'short answer [Correct answer] and',
    );
  });

  it('reads escapes, entities, weights and multiple responses', () => {
    const [b] = scanCloze('{2:SAC:=a\\}b#it\\#1~%50%R&amp;D~it&#39;s}');
    expect(b!.part).toEqual({
      kind: 'shortanswer',
      weight: 2,
      caseSensitive: true,
      answers: [
        { text: 'a}b', fraction: 1, feedback: 'it#1' },
        { text: 'R&D', fraction: 0.5, feedback: '' },
        { text: "it's", fraction: 0, feedback: '' },
      ],
    });
    const [mr] = scanCloze('{1:MRHS:=a~=b~c}');
    expect(mr!.part).toMatchObject({
      kind: 'multiresponse',
      display: 'horizontal',
      shuffle: true,
      answers: [{ fraction: 0.5 }, { fraction: 0.5 }, { fraction: -0.5 }],
    });
    expect(scanCloze('{1:SA:wrong only}')[0]!.code).toBe('noRight');
    expect(checkQuestionText('MULTIANSWER', 'x {1:SA:wrong only}', { parts: [] })).toEqual({
      key: 'errors.questions.gap.noRight',
      values: { n: 1 },
    });
    expect(checkQuestionText('MULTIANSWER', 'no gaps', { parts: [] })?.key).toBe(
      'errors.questions.needsGap',
    );
  });

  it('writes gaps back as Cloze', () => {
    for (const b of scanCloze(MOODLE_EXAMPLE)) {
      const again = scanCloze(toClozeSource(b.part!))[0]!.part;
      expect(again).toEqual(b.part);
    }
    expect(toClozeSource(scanCloze('{1:SA:=a\\}b#x}')[0]!.part!)).toBe('{1:SA:=a\\}b#x}');
  });

  it('interactive: each gap counts back from the try it was last changed in', () => {
    const q = cloze('{1:SA:=right} and {2:NM:=3}', {
      penalty: 0.25,
      hints: [{ text: 'Ещё', clearWrong: true, showNumCorrect: true }],
    });
    const first = { parts: { 1: 'wrong', 2: '3' } };
    const o = replay(q, [{ kind: 'CHECK', response: first }], 'interactive');
    expect(o.numCorrect).toEqual({ right: 1, total: 2 });
    const cleared = replay(
      q,
      [
        { kind: 'CHECK', response: first },
        { kind: 'TRYAGAIN', response: { parts: { 2: '3' } } },
      ],
      'interactive',
    );
    expect(cleared.response).toEqual({ parts: { 2: '3' } });
    // gap 1 right from the second try: 1 − 0.25; gap 2 unchanged since the first: 1 → (0.75 + 2) / 3
    const done = replay(
      q,
      [
        { kind: 'CHECK', response: first },
        { kind: 'TRYAGAIN', response: { parts: { 2: '3' } } },
        { kind: 'CHECK', response: { parts: { 1: 'right', 2: '3' } } },
      ],
      'interactive',
    );
    expect(done.fraction).toBeCloseTo(2.75 / 3);
  });
});
