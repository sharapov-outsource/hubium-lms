import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { describe, expect, it } from 'vitest';
import { exportMoodleXml, importMoodleXml, parseMoodleXml } from '../src/moodle-xml.ts';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<quiz>
  <question type="category"><category><text>$course$/top/Python/Основы</text></category></question>
  <question type="multichoice">
    <name><text>Тип данных</text></name>
    <questiontext format="html"><text><![CDATA[<p>Какой тип у 3.14? <img src="@@PLUGINFILE@@/pi.png"></p>]]></text>
      <file name="pi.png" path="/" encoding="base64">iVBORw0KGgo=</file></questiontext>
    <generalfeedback format="html"><text>Это float.</text></generalfeedback>
    <defaultgrade>2</defaultgrade><penalty>0.3333333</penalty>
    <single>true</single><shuffleanswers>1</shuffleanswers>
    <answer fraction="100" format="html"><text>float</text><feedback format="html"><text>Да</text></feedback></answer>
    <answer fraction="0" format="html"><text>int</text><feedback format="html"><text></text></feedback></answer>
    <tags><tag><text>основы</text></tag></tags>
    <hint format="html"><text>Подумайте о точке</text><shownumcorrect/></hint>
    <hint format="html"><text>Это не целое число</text><clearwrong/></hint>
  </question>
  <question type="truefalse">
    <name><text>Комментарий</text></name>
    <questiontext format="html"><text>Комментарий начинается с #</text></questiontext>
    <answer fraction="100" format="moodle_auto_format"><text>true</text><feedback><text>Верно</text></feedback></answer>
    <answer fraction="0" format="moodle_auto_format"><text>false</text><feedback><text>Нет</text></feedback></answer>
  </question>
  <question type="shortanswer">
    <name><text>Функция</text></name><questiontext><text>Функция вывода?</text></questiontext>
    <usecase>0</usecase>
    <answer fraction="100"><text>print</text></answer>
    <answer fraction="50"><text>print()</text></answer>
  </question>
  <question type="numerical">
    <name><text>Деление</text></name><questiontext><text>7 // 2 = ?</text></questiontext>
    <answer fraction="100"><text>3</text><tolerance>0</tolerance></answer>
    <answer fraction="0"><text>*</text></answer>
  </question>
  <question type="matching">
    <name><text>Типы</text></name><questiontext><text>Сопоставьте</text></questiontext>
    <subquestion format="html"><text>42</text><answer><text>int</text></answer></subquestion>
    <subquestion format="html"><text>"42"</text><answer><text>str</text></answer></subquestion>
    <subquestion format="html"><text></text><answer><text>float</text></answer></subquestion>
  </question>
  <question type="essay">
    <name><text>Эссе</text></name><questiontext><text>Расскажите о Python</text></questiontext>
    <minwordlimit>50</minwordlimit><maxwordlimit>300</maxwordlimit>
    <graderinfo format="html"><text>Оценивать полноту</text></graderinfo>
  </question>
  <question type="description">
    <name><text>Справка</text></name><questiontext><text>Далее — вопросы по спискам</text></questiontext>
  </question>
  <question type="calculated"><name><text>Формула</text></name><questiontext><text>x</text></questiontext></question>
</quiz>`;

const HINTS = [
  { text: 'Подумайте о точке', clearWrong: false, showNumCorrect: true },
  { text: 'Это не целое число', clearWrong: true, showNumCorrect: false },
];

describe('Moodle XML', () => {
  it('parses the seven supported types', () => {
    const r = parseMoodleXml(SAMPLE);
    expect(r.questions.map((q) => q.type)).toEqual([
      'MULTICHOICE',
      'TRUEFALSE',
      'SHORTANSWER',
      'NUMERICAL',
      'MATCH',
      'ESSAY',
      'DESCRIPTION',
    ]);
    expect(r.errors).toEqual([
      { name: 'Формула', message: 'Unsupported question type: calculated' },
    ]);
    const [mc, tf, sa, nu, ma, es] = r.questions;
    expect(mc).toMatchObject({
      categoryPath: ['Python', 'Основы'],
      defaultMark: 2,
      tags: ['основы'],
    });
    expect(mc!.text).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(mc!.hints).toEqual(HINTS);
    expect(mc!.data).toMatchObject({
      single: true,
      answers: [{ text: 'float', fraction: 1, feedback: 'Да' }, { fraction: 0 }],
    });
    expect(tf!.data).toEqual({ correct: true, feedbackTrue: 'Верно', feedbackFalse: 'Нет' });
    expect(sa!.data).toMatchObject({
      caseSensitive: false,
      answers: [
        { text: 'print', fraction: 1 },
        { text: 'print()', fraction: 0.5 },
      ],
    });
    expect(nu!.data).toMatchObject({ answers: [{ value: 3, tolerance: 0, fraction: 1 }] });
    expect(ma!.data).toMatchObject({
      pairs: [
        { question: '42', answer: 'int' },
        { question: '"42"', answer: 'str' },
      ],
      distractors: ['float'],
    });
    expect(es!.data).toMatchObject({ minWords: 50, maxWords: 300 });
  });

  it('rejects files that are not Moodle XML', () => {
    expect(() => parseMoodleXml('<root/>')).toThrow();
  });

  describe('bank import and export', () => {
    const t = useTestDb();

    it('round-trips through a course bank', async () => {
      const f = await courseFixture(t.db, 'MXML1');
      const teacher = await ctxFor(t.db, f.users.teacher!);
      const r = await importMoodleXml(teacher, f.courseId, SAMPLE);
      expect(r.created).toBe(7);
      const cats = await t.db.questionCategory.findMany({ where: { contextId: f.courseId } });
      expect(cats.map((c) => c.name).sort()).toEqual(['Python', 'Основы']);
      const xml = await exportMoodleXml(teacher, f.courseId);
      expect(xml).toContain('<question type="category">');
      expect(xml).toContain('$course$/top/Python/Основы');
      const again = parseMoodleXml(xml);
      expect(again.errors).toEqual([]);
      expect(again.questions.map((q) => q.type)).toEqual([
        'MULTICHOICE',
        'TRUEFALSE',
        'SHORTANSWER',
        'NUMERICAL',
        'MATCH',
        'ESSAY',
        'DESCRIPTION',
      ]);
      expect(again.questions[3]!.data).toMatchObject({ answers: [{ value: 3, fraction: 1 }] });
      expect(again.questions[0]!.hints).toEqual(HINTS);
      expect(again.questions[1]!.hints).toEqual([]);
      const s1 = await ctxFor(t.db, f.users.student1!);
      await expect(importMoodleXml(s1, f.courseId, SAMPLE)).rejects.toThrow();
    });
  });
});
