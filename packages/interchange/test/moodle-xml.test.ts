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
  <question type="ordering">
    <name><text>Порядок</text></name><questiontext format="html"><text>Расставьте этапы</text></questiontext>
    <layouttype>VERTICAL</layouttype><selecttype>RANDOM</selecttype><selectcount>2</selectcount>
    <gradingtype>ABSOLUTE_POSITION</gradingtype><showgrading>SHOW</showgrading><numberingstyle>123</numberingstyle>
    <correctfeedback format="html"><text>Отлично</text></correctfeedback>
    <answer fraction="1" format="html"><text>Написать</text></answer>
    <answer fraction="2" format="html"><text>Выполнить</text></answer>
    <answer fraction="3" format="html"><text>Проверить</text></answer>
  </question>
  <question type="gapselect">
    <name><text>Пропуски</text></name><questiontext format="html"><text>[[1]] изменяемый, [[2]] нет</text></questiontext>
    <shuffleanswers>1</shuffleanswers>
    <selectoption><text>list</text><group>1</group></selectoption>
    <selectoption><text>tuple</text><group>1</group></selectoption>
  </question>
  <question type="ddwtos">
    <name><text>Перетаскивание</text></name><questiontext format="html"><text>[[1]] и снова [[1]]</text></questiontext>
    <shuffleanswers>0</shuffleanswers>
    <dragbox><text>list</text><group>1</group><infinite/></dragbox>
    <dragbox><text>dict</text><group>1</group></dragbox>
  </question>
  <question type="ddwtos">
    <name><text>Битый</text></name><questiontext format="html"><text>[[3]]</text></questiontext>
    <dragbox><text>list</text><group>1</group></dragbox>
    <dragbox><text>dict</text><group>1</group></dragbox>
  </question>
  <question type="cloze">
    <name><text>Вложенные</text></name>
    <questiontext format="html"><text><![CDATA[<p>Столица Франции — {1:SA:=Париж#Верно~%50%Paris}, а 2 + 2 = {2:NM:=4:0}; список это {1:MC:=list~tuple}.</p>]]></text></questiontext>
  </question>
  <question type="calculated">
    <name><text>Площадь</text></name>
    <questiontext format="html"><text>Прямоугольник {w} на {h}: площадь?</text></questiontext>
    <synchronize>1</synchronize>
    <answer fraction="100"><text>{w} * {h}</text><tolerance>0.05</tolerance><tolerancetype>2</tolerancetype>
      <correctanswerformat>2</correctanswerformat><correctanswerlength>3</correctanswerlength>
      <feedback format="html"><text>Верно</text></feedback></answer>
    <units><unit><multiplier>1</multiplier><unit_name>см²</unit_name></unit></units>
    <dataset_definitions>
      <dataset_definition><status><text>private</text></status><name><text>w</text></name><type>calculated</type>
        <distribution><text>uniform</text></distribution><minimum><text>1</text></minimum><maximum><text>9</text></maximum><decimals><text>1</text></decimals>
        <itemcount>2</itemcount><dataset_items><dataset_item><number>2</number><value>3.5</value></dataset_item><dataset_item><number>1</number><value>2.5</value></dataset_item></dataset_items><number_of_items>2</number_of_items></dataset_definition>
      <dataset_definition><status><text>shared</text></status><name><text>h</text></name><type>calculated</type>
        <distribution><text>loguniform</text></distribution><minimum><text>1</text></minimum><maximum><text>100</text></maximum><decimals><text>0</text></decimals>
        <itemcount>2</itemcount><dataset_items><dataset_item><number>1</number><value>4</value></dataset_item><dataset_item><number>2</number><value>40</value></dataset_item></dataset_items><number_of_items>2</number_of_items></dataset_definition>
    </dataset_definitions>
  </question>
  <question type="calculated"><name><text>Формула</text></name><questiontext><text>{x}</text></questiontext>
    <answer fraction="100"><text>{x} * 2</text></answer>
  </question>
</quiz>`;

const TYPES = [
  'MULTICHOICE',
  'TRUEFALSE',
  'SHORTANSWER',
  'NUMERICAL',
  'MATCH',
  'ESSAY',
  'DESCRIPTION',
  'ORDERING',
  'GAPSELECT',
  'DDWTOS',
  'MULTIANSWER',
  'CALCULATED',
];

const HINTS = [
  { text: 'Подумайте о точке', clearWrong: false, showNumCorrect: true },
  { text: 'Это не целое число', clearWrong: true, showNumCorrect: false },
];

describe('Moodle XML', () => {
  it('parses the supported types', () => {
    const r = parseMoodleXml(SAMPLE);
    expect(r.questions.map((q) => q.type)).toEqual(TYPES);
    // messages, read in English as text
    const said = (notes: typeof r.errors) =>
      notes.map((n) => ({ ...n, message: String(n.message) }));
    expect(said(r.errors)).toEqual([
      { name: 'Битый', message: 'No choice for [[3]]' },
      { name: 'Формула', message: 'No dataset for {x}' },
    ]);
    // units are left out, and said so
    expect(said(r.warnings)).toEqual([
      { name: 'Площадь', message: expect.stringContaining('units') },
    ]);
    expect(r.questions[11]!).toMatchObject({
      sharedDatasets: [{ name: 'h', distribution: 'loguniform', items: [4, 40] }],
      data: {
        answers: [
          {
            formula: '{w} * {h}',
            tolerance: 0.05,
            toleranceType: 'nominal',
            format: 'significant',
            length: 3,
            feedback: 'Верно',
          },
        ],
        datasets: [{ name: 'w', min: 1, max: 9, decimals: 1, items: [2.5, 3.5] }],
        shared: ['h'],
        synchronize: true,
      },
    });
    const [, , , , , , , ord, gap, drag] = r.questions;
    expect(ord!.data).toMatchObject({
      items: [{ text: 'Написать' }, { text: 'Выполнить' }, { text: 'Проверить' }],
      grading: 'absolutePosition',
      select: 'random',
      selectCount: 2,
      numbering: '123',
      feedbackCorrect: 'Отлично',
    });
    expect(gap!.data).toMatchObject({ choices: [{ text: 'list' }, { text: 'tuple' }] });
    expect(r.questions[10]!.data).toMatchObject({
      parts: [
        {
          kind: 'shortanswer',
          weight: 1,
          answers: [
            { text: 'Париж', fraction: 1, feedback: 'Верно' },
            { text: 'Paris', fraction: 0.5 },
          ],
        },
        { kind: 'numerical', weight: 2, answers: [{ value: 4 }] },
        {
          kind: 'multichoice',
          display: 'dropdown',
          answers: [{ text: 'list' }, { text: 'tuple' }],
        },
      ],
    });
    expect(drag!.data).toMatchObject({
      shuffle: false,
      choices: [
        { text: 'list', infinite: true },
        { text: 'dict', infinite: false },
      ],
    });
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
      const r = await importMoodleXml.run(teacher, { courseId: f.courseId, xml: SAMPLE });
      expect(r.created).toBe(12);
      // the shared dataset now belongs to the category of the question
      expect(await t.db.questionDataset.findMany({ select: { name: true, items: true } })).toEqual([
        { name: 'h', items: [4, 40] },
      ]);
      const cats = await t.db.questionCategory.findMany({ where: { contextId: f.courseId } });
      expect(cats.map((c) => c.name).sort()).toEqual(['Python', 'Основы']);
      const xml = await exportMoodleXml(teacher, f.courseId);
      expect(xml).toContain('<question type="category">');
      expect(xml).toContain('$course$/top/Python/Основы');
      const again = parseMoodleXml(xml);
      expect(again.errors).toEqual([]);
      expect(again.questions.map((q) => q.type)).toEqual(TYPES);
      // the new types come back as they went out
      const first = parseMoodleXml(SAMPLE).questions;
      for (const k of [7, 8, 9, 10, 11]) expect(again.questions[k]!.data).toEqual(first[k]!.data);
      expect(again.questions[11]!.sharedDatasets).toEqual(first[11]!.sharedDatasets);
      expect(again.questions[3]!.data).toMatchObject({ answers: [{ value: 3, fraction: 1 }] });
      expect(again.questions[0]!.hints).toEqual(HINTS);
      expect(again.questions[1]!.hints).toEqual([]);
      const s1 = await ctxFor(t.db, f.users.student1!);
      await expect(
        importMoodleXml.run(s1, { courseId: f.courseId, xml: SAMPLE }),
      ).rejects.toThrow();
    });
  });
});
